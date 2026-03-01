import { createMcpClient } from "../../shared/mcp";
import db, { insertBacklogItem, backlogItemExists } from "../../shared/db";

interface ScoredOpportunity {
  name: string;
  description: string;
  demand_score: number;
  effort_score: number;
  competition_score: number;
  overall_score: number;
}

async function gatherSignals(): Promise<string[]> {
  const signals: string[] = [];

  // 1. Fetch Smithery trending
  try {
    const res = await fetch("https://smithery.ai/api/discover", {
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      const data = await res.json();
      signals.push(`Smithery trending tools: ${JSON.stringify(data).slice(0, 2000)}`);
    }
  } catch {
    signals.push("Smithery trending: unavailable");
  }

  // 2. npm registry — search for trending API-related packages
  try {
    const res = await fetch("https://registry.npmjs.org/-/v1/search?text=api+tool+microservice&size=20", {
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      const data = await res.json();
      const pkgs = data.objects?.map((o: any) => `${o.package.name}: ${o.package.description}`).join("\n") ?? "";
      signals.push(`Trending npm packages:\n${pkgs.slice(0, 2000)}`);
    }
  } catch {
    signals.push("npm registry: unavailable");
  }

  // 3. Check our own 404 logs for demand signals
  try {
    const notFounds = db.query(`
      SELECT endpoint, COUNT(*) as hits
      FROM requests
      WHERE status_code = 404 AND created_at > datetime('now', '-7 days')
      GROUP BY endpoint
      ORDER BY hits DESC
      LIMIT 20
    `).all() as { endpoint: string; hits: number }[];
    if (notFounds.length > 0) {
      signals.push(`Our 404 endpoints (demand signals):\n${notFounds.map(r => `${r.endpoint}: ${r.hits} hits`).join("\n")}`);
    }
  } catch {
    signals.push("404 logs: unavailable");
  }

  return signals;
}

export async function scout(): Promise<ScoredOpportunity[]> {
  console.log("[scout] Gathering demand signals...");
  const signals = await gatherSignals();
  console.log(`[scout] Collected ${signals.length} signal sources`);

  const client = await createMcpClient(60_000);

  try {
    const prompt = `You are Conway, an autonomous API agent. You build and sell x402-payable micro-APIs.

Your existing API: web-checker (checks brand name availability across domains, GitHub, npm, PyPI, Reddit).

Based on the following market signals, identify 3-5 new API opportunities that:
1. Solve a real developer/AI-agent need
2. Can be built as a single-file Hono API
3. Have clear monetization via x402 micropayments ($0.001-$0.01 per call)
4. Don't require external API keys or large datasets
5. Are complementary (not competing) with web-checker

Market signals:
${signals.join("\n\n")}

Respond ONLY with a JSON array. Each item must have:
- name: short kebab-case API name (e.g. "dns-lookup", "whois-check")
- description: 1-2 sentence description of what the API does
- demand_score: 0-1 (how much demand exists)
- effort_score: 0-1 (how easy to build, 1 = easiest)
- competition_score: 0-1 (how little competition, 1 = no competition)
- overall_score: 0-1 (weighted combination favoring demand)

JSON array only, no markdown fences:`;

    const response = await client.chat([{ role: "user", content: prompt }]);

    // Parse the JSON response
    let opportunities: ScoredOpportunity[];
    try {
      // Strip markdown fences if present
      const cleaned = response.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
      opportunities = JSON.parse(cleaned);
    } catch (e) {
      console.error("[scout] Failed to parse GPT response:", response.slice(0, 500));
      return [];
    }

    if (!Array.isArray(opportunities)) {
      console.error("[scout] Response is not an array");
      return [];
    }

    // Write to backlog, skip duplicates
    let added = 0;
    for (const opp of opportunities) {
      if (!opp.name || !opp.description) continue;
      if (backlogItemExists(opp.name)) {
        console.log(`[scout] Skipping duplicate: ${opp.name}`);
        continue;
      }
      insertBacklogItem(
        opp.name,
        opp.description,
        opp.demand_score ?? 0,
        opp.effort_score ?? 0,
        opp.competition_score ?? 0,
        opp.overall_score ?? 0
      );
      added++;
      console.log(`[scout] Added: ${opp.name} (score: ${opp.overall_score})`);
    }

    console.log(`[scout] Done — ${added} new items added to backlog`);
    return opportunities;
  } finally {
    client.close();
  }
}

// Run directly
if (import.meta.main) {
  const results = await scout();
  console.log(JSON.stringify(results, null, 2));
}
