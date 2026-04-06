/**
 * Dev.to Auto-Publisher — posts articles from data/drafts/ via Dev.to API.
 *
 * Publishes up to 2 articles per run. Tracks published articles in promotions DB
 * to avoid double-posting. Articles are published as drafts (published: false)
 * unless DEVTO_AUTO_PUBLISH=true is set.
 */

import db from "../../shared/db";
import { join } from "path";

const DRAFTS_DIR = join(import.meta.dir, "..", "..", "data", "drafts");
const MAX_PER_RUN = 2;

interface DevtoArticle {
  title: string;
  body_markdown: string;
  tags: string[];
  published: boolean;
  canonical_url?: string;
}

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

/** Get APIs that have drafts but haven't been published to Dev.to yet. */
function getUnpublishedDrafts(): string[] {
  const rows = db.query(`
    SELECT DISTINCT api_name FROM promotions
    WHERE channel = 'social-drafts' AND status = 'drafted'
      AND NOT EXISTS (
        SELECT 1 FROM promotions p2
        WHERE p2.api_name = promotions.api_name AND p2.channel = 'devto'
      )
  `).all() as { api_name: string }[];
  return rows.map(r => r.api_name);
}

/** Parse Dev.to frontmatter from markdown file. */
function parseDevtoMarkdown(content: string): { title: string; tags: string[]; body: string } {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!fmMatch) return { title: "", tags: [], body: content };

  const fm = fmMatch[1];
  const body = fmMatch[2].trim();

  const titleMatch = fm.match(/title:\s*"([^"]+)"/);
  const tagsMatch = fm.match(/tags:\s*(.+)/);

  return {
    title: titleMatch?.[1] ?? "",
    tags: tagsMatch?.[1].split(",").map(t => t.trim()).filter(Boolean) ?? [],
    body,
  };
}

export async function devtoPublish(): Promise<void> {
  const apiKey = process.env.DEVTO_API_KEY;
  if (!apiKey) {
    console.log("[devto-publish] DEVTO_API_KEY not set — skipping");
    return;
  }

  const autoPublish = process.env.DEVTO_AUTO_PUBLISH === "true";
  const unpublished = getUnpublishedDrafts();

  if (unpublished.length === 0) {
    console.log("[devto-publish] No unpublished articles — all drafts already posted");
    return;
  }

  console.log(`[devto-publish] ${unpublished.length} article(s) ready, publishing up to ${MAX_PER_RUN}`);

  let published = 0;
  for (const apiName of unpublished.slice(0, MAX_PER_RUN)) {
    const mdPath = join(DRAFTS_DIR, apiName, "devto.md");
    const file = Bun.file(mdPath);
    if (!(await file.exists())) {
      console.warn(`[devto-publish] No devto.md for ${apiName} — skipping`);
      continue;
    }

    const content = await file.text();
    const { title, tags, body } = parseDevtoMarkdown(content);

    if (!title || !body) {
      console.warn(`[devto-publish] Empty title/body for ${apiName} — skipping`);
      logPromotion(apiName, "devto", "failed");
      continue;
    }

    const article: DevtoArticle = {
      title,
      body_markdown: body,
      tags: tags.slice(0, 4), // Dev.to max 4 tags
      published: autoPublish,
      canonical_url: `https://apimesh.xyz/tools/${apiName}`,
    };

    try {
      const res = await fetch("https://dev.to/api/articles", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "api-key": apiKey,
        },
        body: JSON.stringify({ article }),
        signal: AbortSignal.timeout(15_000),
      });

      if (res.ok) {
        const data = await res.json() as { url: string; id: number };
        console.log(`[devto-publish] Posted "${title}" → ${data.url} (${autoPublish ? "live" : "draft"})`);
        logPromotion(apiName, "devto", autoPublish ? "published" : "draft-posted", data.url);
        published++;
      } else {
        const err = await res.text();
        console.warn(`[devto-publish] Failed for ${apiName}: ${res.status} — ${err.slice(0, 200)}`);
        logPromotion(apiName, "devto", "failed");
      }
    } catch (err) {
      console.warn(`[devto-publish] Error posting ${apiName}:`, err);
      logPromotion(apiName, "devto", "failed");
    }

    // Rate limit
    await Bun.sleep(2_000);
  }

  console.log(`[devto-publish] Published ${published} article(s), ${unpublished.length - published} remaining`);
}

if (import.meta.main) {
  await devtoPublish();
}
