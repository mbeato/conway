/**
 * Opportunity Digest — surfaces relevant discussions, threads, and listings
 * for human follow-up. Writes a daily digest file.
 *
 * Sources:
 * - GitHub Discussions mentioning MCP, x402, agent payments
 * - Reddit threads in relevant subreddits (search only, no posting)
 * - New repos that could benefit from APIMesh integration
 */

import { join } from "path";

const DIGEST_DIR = join(import.meta.dir, "..", "..", "data", "digests");

interface DigestItem {
  source: string;
  title: string;
  url: string;
  relevance: string;
}

/** Search GitHub for recent discussions about MCP/x402/agent payments. */
async function searchGitHubDiscussions(): Promise<DigestItem[]> {
  const queries = [
    '"mcp server" payment',
    '"x402" api',
    '"agent payment" api',
    '"machine payments protocol"',
    '"pay per call" api',
  ];

  const items: DigestItem[] = [];
  const seen = new Set<string>();

  for (const q of queries) {
    try {
      // Search issues and discussions
      const res = await fetch(
        `https://api.github.com/search/issues?q=${encodeURIComponent(q)}&sort=created&order=desc&per_page=5`,
        {
          signal: AbortSignal.timeout(10_000),
          headers: {
            Accept: "application/vnd.github+json",
            "User-Agent": "apimesh-digest/1.0",
          },
        }
      );
      if (!res.ok) continue;
      const data = await res.json();
      for (const item of data.items ?? []) {
        if (seen.has(item.html_url)) continue;
        seen.add(item.html_url);
        // Only last 7 days
        const created = new Date(item.created_at);
        const weekAgo = new Date(Date.now() - 7 * 86400_000);
        if (created < weekAgo) continue;

        items.push({
          source: "GitHub",
          title: item.title,
          url: item.html_url,
          relevance: q,
        });
      }
    } catch {}
    await Bun.sleep(1_500);
  }

  return items;
}

/** Search Reddit for relevant threads (read-only, no posting). */
async function searchReddit(): Promise<DigestItem[]> {
  const subreddits = ["LocalLLaMA", "ChatGPT", "webdev", "devops", "selfhosted"];
  const searchTerms = ["mcp server", "x402", "api payment", "agent tools"];
  const items: DigestItem[] = [];
  const seen = new Set<string>();

  for (const sub of subreddits) {
    for (const term of searchTerms) {
      try {
        const res = await fetch(
          `https://www.reddit.com/r/${sub}/search.json?q=${encodeURIComponent(term)}&sort=new&t=week&limit=3`,
          {
            signal: AbortSignal.timeout(10_000),
            headers: { "User-Agent": "apimesh-digest/1.0" },
          }
        );
        if (!res.ok) continue;
        const data = await res.json();
        for (const post of data?.data?.children ?? []) {
          const d = post.data;
          if (!d?.permalink || seen.has(d.permalink)) continue;
          seen.add(d.permalink);
          items.push({
            source: `r/${sub}`,
            title: d.title,
            url: `https://reddit.com${d.permalink}`,
            relevance: term,
          });
        }
      } catch {}
      await Bun.sleep(1_000);
    }
  }

  return items;
}

/** Search for new GitHub repos that might want to integrate with APIMesh. */
async function searchIntegrationOpportunities(): Promise<DigestItem[]> {
  const queries = [
    "mcp client created:>2026-03-01 stars:>10",
    "ai agent tools created:>2026-03-01 stars:>50",
  ];

  const items: DigestItem[] = [];
  const seen = new Set<string>();

  for (const q of queries) {
    try {
      const res = await fetch(
        `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&per_page=10`,
        {
          signal: AbortSignal.timeout(10_000),
          headers: {
            Accept: "application/vnd.github+json",
            "User-Agent": "apimesh-digest/1.0",
          },
        }
      );
      if (!res.ok) continue;
      const data = await res.json();
      for (const repo of data.items ?? []) {
        if (seen.has(repo.html_url)) continue;
        seen.add(repo.html_url);
        items.push({
          source: "GitHub Repo",
          title: `${repo.full_name} — ${(repo.description || "").slice(0, 100)}`,
          url: repo.html_url,
          relevance: `${repo.stargazers_count} stars`,
        });
      }
    } catch {}
    await Bun.sleep(1_500);
  }

  return items;
}

function formatDigest(sections: { title: string; items: DigestItem[] }[]): string {
  const date = new Date().toISOString().slice(0, 10);
  let md = `# APIMesh Opportunity Digest — ${date}\n\n`;

  let totalItems = 0;
  for (const section of sections) {
    if (section.items.length === 0) continue;
    md += `## ${section.title} (${section.items.length})\n\n`;
    for (const item of section.items) {
      md += `- **[${item.source}]** [${item.title}](${item.url})\n`;
      md += `  Matched: ${item.relevance}\n\n`;
      totalItems++;
    }
  }

  if (totalItems === 0) {
    md += "No new opportunities found this run.\n";
  }

  return md;
}

export async function digest(): Promise<void> {
  console.log("[digest] Scanning for opportunities...");

  const [ghItems, redditItems, integrationItems] = await Promise.all([
    searchGitHubDiscussions(),
    searchReddit(),
    searchIntegrationOpportunities(),
  ]);

  const sections = [
    { title: "GitHub Discussions & Issues", items: ghItems },
    { title: "Reddit Threads", items: redditItems },
    { title: "Integration Opportunities", items: integrationItems },
  ];

  const total = ghItems.length + redditItems.length + integrationItems.length;
  console.log(`[digest] Found ${total} items (${ghItems.length} GitHub, ${redditItems.length} Reddit, ${integrationItems.length} repos)`);

  const md = formatDigest(sections);
  const date = new Date().toISOString().slice(0, 10);

  await Bun.spawn(["mkdir", "-p", DIGEST_DIR]).exited;
  const outPath = join(DIGEST_DIR, `${date}.md`);
  await Bun.write(outPath, md);
  console.log(`[digest] Written to ${outPath}`);

  // Also write latest.md for easy access
  await Bun.write(join(DIGEST_DIR, "latest.md"), md);
}

if (import.meta.main) {
  await digest();
}
