/**
 * Social Publisher — posts announcement tweets via X API v2.
 *
 * Only posts factual announcements (new API launches, milestones).
 * Narrative/opinion tweets stay as drafts for human review.
 * Max 1 tweet per run to avoid looking robotic.
 */

import db from "../../shared/db";
import { join } from "path";

const DRAFTS_DIR = join(import.meta.dir, "..", "..", "data", "drafts");
const MAX_PER_RUN = 1;

function logPromotion(apiName: string, channel: string, status: string, url?: string) {
  db.run(
    `INSERT INTO promotions (api_name, channel, status, url)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(api_name, channel) DO UPDATE SET
       status = excluded.status,
       url = COALESCE(excluded.url, promotions.url),
       created_at = datetime('now')`,
    [apiName, channel, status, url ?? null]
  );
}

/** Get APIs with tweet drafts that haven't been posted yet. */
function getUnpostedTweets(): string[] {
  const rows = db.query(`
    SELECT DISTINCT api_name FROM promotions
    WHERE channel = 'social-drafts' AND status = 'drafted'
      AND NOT EXISTS (
        SELECT 1 FROM promotions p2
        WHERE p2.api_name = promotions.api_name AND p2.channel = 'twitter'
      )
  `).all() as { api_name: string }[];
  return rows.map(r => r.api_name);
}

/**
 * Post a tweet using X API v2 OAuth 1.0a.
 * Requires: X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET
 */
async function postTweet(text: string): Promise<{ id: string; url: string } | null> {
  const apiKey = process.env.X_API_KEY;
  const apiSecret = process.env.X_API_SECRET;
  const accessToken = process.env.X_ACCESS_TOKEN;
  const accessSecret = process.env.X_ACCESS_SECRET;

  if (!apiKey || !apiSecret || !accessToken || !accessSecret) {
    console.log("[social-publish] X API credentials not set — skipping");
    return null;
  }

  // OAuth 1.0a signature generation
  const method = "POST";
  const url = "https://api.x.com/2/tweets";
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomUUID().replace(/-/g, "");

  const oauthParams: Record<string, string> = {
    oauth_consumer_key: apiKey,
    oauth_nonce: nonce,
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: timestamp,
    oauth_token: accessToken,
    oauth_version: "1.0",
  };

  // Build signature base string
  const paramString = Object.keys(oauthParams)
    .sort()
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(oauthParams[k])}`)
    .join("&");

  const baseString = `${method}&${encodeURIComponent(url)}&${encodeURIComponent(paramString)}`;
  const signingKey = `${encodeURIComponent(apiSecret)}&${encodeURIComponent(accessSecret)}`;

  // HMAC-SHA1
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(signingKey),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(baseString));
  const signature = btoa(String.fromCharCode(...new Uint8Array(sig)));

  oauthParams.oauth_signature = signature;

  const authHeader = "OAuth " + Object.keys(oauthParams)
    .sort()
    .map(k => `${encodeURIComponent(k)}="${encodeURIComponent(oauthParams[k])}"`)
    .join(", ");

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(15_000),
    });

    if (res.ok) {
      const data = await res.json() as { data: { id: string } };
      const tweetId = data.data.id;
      // Derive URL from the tweet ID (username needed — use @Maxwizkid)
      return { id: tweetId, url: `https://x.com/Maxwizkid/status/${tweetId}` };
    } else {
      const err = await res.text();
      console.warn(`[social-publish] X API error: ${res.status} — ${err.slice(0, 200)}`);
      return null;
    }
  } catch (err) {
    console.warn(`[social-publish] X API request failed:`, err);
    return null;
  }
}

export async function socialPublish(): Promise<void> {
  const hasCredentials = process.env.X_API_KEY && process.env.X_API_SECRET &&
    process.env.X_ACCESS_TOKEN && process.env.X_ACCESS_SECRET;

  if (!hasCredentials) {
    console.log("[social-publish] X API credentials not configured — skipping");
    console.log("[social-publish] Need: X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET");
    return;
  }

  const unposted = getUnpostedTweets();
  if (unposted.length === 0) {
    console.log("[social-publish] No tweets to post — all drafts already published");
    return;
  }

  console.log(`[social-publish] ${unposted.length} tweet(s) ready, posting up to ${MAX_PER_RUN}`);

  let posted = 0;
  for (const apiName of unposted.slice(0, MAX_PER_RUN)) {
    const tweetPath = join(DRAFTS_DIR, apiName, "tweet.txt");
    const file = Bun.file(tweetPath);
    if (!(await file.exists())) {
      console.warn(`[social-publish] No tweet.txt for ${apiName} — skipping`);
      continue;
    }

    const text = (await file.text()).trim();
    if (!text || text.length > 280) {
      console.warn(`[social-publish] Tweet for ${apiName} is ${text.length} chars (invalid) — skipping`);
      logPromotion(apiName, "twitter", "failed");
      continue;
    }

    const result = await postTweet(text);
    if (result) {
      console.log(`[social-publish] Posted tweet for ${apiName} → ${result.url}`);
      logPromotion(apiName, "twitter", "published", result.url);
      posted++;
    } else {
      logPromotion(apiName, "twitter", "failed");
    }
  }

  console.log(`[social-publish] Posted ${posted} tweet(s), ${unposted.length - posted} remaining`);
}

if (import.meta.main) {
  await socialPublish();
}
