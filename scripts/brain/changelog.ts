/**
 * Changelog Generator — creates apimesh.xyz/changelog from build history.
 *
 * Each API in the registry becomes a changelog entry.
 * Generates a static HTML page at apis/landing/changelog.html.
 */

import db, { getActiveApis } from "../../shared/db";
import { join } from "path";

const LANDING_DIR = join(import.meta.dir, "..", "..", "apis", "landing");

interface ChangelogEntry {
  name: string;
  description: string;
  date: string;
  subdomain: string;
}

function getChangelogEntries(): ChangelogEntry[] {
  // Get all APIs ordered by creation date (newest first)
  const rows = db.query(`
    SELECT ar.name, ar.subdomain, ar.created_at,
           COALESCE(b.description, ar.name || ' API') as description
    FROM api_registry ar
    LEFT JOIN backlog b ON b.name = ar.name
    WHERE ar.status = 'active'
    ORDER BY ar.created_at DESC
  `).all() as { name: string; subdomain: string; created_at: string; description: string }[];

  return rows.map(r => ({
    name: r.name,
    description: r.description,
    date: r.created_at?.slice(0, 10) ?? "2026-03-01",
    subdomain: r.subdomain,
  }));
}

function generateChangelogHtml(entries: ChangelogEntry[]): string {
  const items = entries.map(e => {
    const title = e.name.split("-").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
    const url = `https://${e.subdomain}.apimesh.xyz`;
    return `      <div class="entry">
        <div class="entry-date">${e.date}</div>
        <div class="entry-content">
          <h3><a href="/tools/${e.name}">${title}</a></h3>
          <p>${e.description}</p>
          <code class="entry-url">${url}</code>
        </div>
      </div>`;
  }).join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Changelog — APIMesh</title>
  <meta name="description" content="New APIs and updates to APIMesh. ${entries.length} APIs and counting.">
  <meta name="robots" content="index, follow">
  <link rel="icon" type="image/svg+xml" href="/logo-nav.svg">
  <link rel="canonical" href="https://apimesh.xyz/changelog">
  <meta property="og:title" content="Changelog — APIMesh">
  <meta property="og:description" content="New APIs and updates. ${entries.length} APIs and counting.">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600&family=Inter:wght@400;500;600;700&family=Instrument+Serif&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Inter', sans-serif; background: #0a0a0a; color: #e0e0e0; line-height: 1.6; }
    .container { max-width: 720px; margin: 0 auto; padding: 48px 24px; }
    a { color: #60a5fa; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .breadcrumb { font-size: 14px; color: #888; margin-bottom: 32px; }
    h1 { font-family: 'Instrument Serif', serif; font-size: 42px; font-weight: 400; color: #fff; margin-bottom: 8px; }
    .subtitle { font-size: 18px; color: #aaa; margin-bottom: 48px; }
    .timeline { border-left: 2px solid #1a1a1a; padding-left: 24px; }
    .entry { position: relative; margin-bottom: 32px; }
    .entry::before { content: ''; position: absolute; left: -29px; top: 8px; width: 8px; height: 8px; background: #60a5fa; border-radius: 50%; }
    .entry-date { font-size: 13px; color: #666; font-family: 'JetBrains Mono', monospace; margin-bottom: 4px; }
    .entry-content h3 { font-size: 18px; font-weight: 600; color: #fff; margin-bottom: 4px; }
    .entry-content p { font-size: 15px; color: #aaa; margin-bottom: 8px; }
    .entry-url { font-size: 13px; color: #555; font-family: 'JetBrains Mono', monospace; }
    .footer { margin-top: 64px; padding-top: 24px; border-top: 1px solid #1a1a1a; font-size: 14px; color: #666; text-align: center; }
  </style>
</head>
<body>
  <div class="container">
    <div class="breadcrumb"><a href="/"><img src="/logo-nav.svg" alt="" width="16" height="16" style="border-radius:3px;vertical-align:middle;margin-right:4px">APIMesh</a> / Changelog</div>
    <h1>Changelog</h1>
    <p class="subtitle">${entries.length} APIs built and counting</p>
    <div class="timeline">
${items}
    </div>
    <div class="footer">
      <a href="/"><img src="/logo-nav.svg" alt="" width="14" height="14" style="border-radius:3px;vertical-align:middle;margin-right:4px">APIMesh</a> · <a href="/tools">All APIs</a> · <a href="https://github.com/mbeato/conway">GitHub</a>
    </div>
  </div>
</body>
</html>`;
}

export async function changelog(): Promise<void> {
  const entries = getChangelogEntries();
  if (entries.length === 0) {
    console.log("[changelog] No APIs in registry — skipping");
    return;
  }

  const html = generateChangelogHtml(entries);
  await Bun.write(join(LANDING_DIR, "changelog.html"), html);
  console.log(`[changelog] Generated changelog with ${entries.length} entries → apis/landing/changelog.html`);
}

if (import.meta.main) {
  await changelog();
}
