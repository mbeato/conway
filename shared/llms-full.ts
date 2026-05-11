import { buildPlatformManifest } from "./mpp-manifest";

// Build the inline-everything `/llms-full.txt` companion to `/llms.txt`.
// Convention popularized by Stripe / Cloudflare / Vercel / Anthropic: an LLM-
// consumable single file that concatenates per-API docs so agents can answer
// "how do I do X with APIMesh" without crawling the index.
//
// Format: plain markdown, served as text/plain. H1 + blockquote summary, one
// H2 per API, then a "How to pay" section (api-key first — near-term revenue).
export function buildLlmsFull(host: string = "apimesh.xyz"): string {
  const manifest = buildPlatformManifest(host);
  const root = host.endsWith("apimesh.xyz") ? "https://apimesh.xyz" : `https://${host}`;
  const apis = manifest.apis;

  const lines: string[] = [];

  lines.push(`# apimesh.xyz`);
  lines.push("");
  lines.push(`> APIMesh — ${apis.length} pay-per-call web-analysis APIs for AI agents and developers. Supports API key (Stripe), x402 (USDC on Base), and MPP (Stripe Machine Payments Protocol).`);
  lines.push("");
  lines.push(`This file inlines per-API documentation for LLM consumption. The lighter index lives at ${root}/llms.txt.`);
  lines.push("");

  for (const api of apis) {
    lines.push(`## ${api.name}`);
    lines.push("");
    lines.push(api.description);
    lines.push("");
    lines.push(`**Endpoint:** \`${api.method} ${api.endpoint}\``);
    lines.push(`**Price:** $${api.price_usd} per call`);
    lines.push(`**Category:** ${api.category}`);
    lines.push("");
    lines.push(`### Example`);
    lines.push("");
    lines.push("```bash");
    if (api.method === "GET") {
      lines.push(`curl '${api.endpoint}'`);
    } else {
      lines.push(`curl -X ${api.method} '${api.endpoint}' \\`);
      lines.push(`  -H 'Content-Type: application/json' \\`);
      lines.push(`  -d '{}'`);
    }
    lines.push("```");
    lines.push("");
    lines.push(`Per-API manifest: ${api.endpoint.replace(/\/[^/]*$/, "")}/.well-known/mpp`);
    lines.push("");
  }

  lines.push(`## How to pay`);
  lines.push("");
  lines.push(`1. **API key (Stripe)** — sign up at ${root}/signup, buy credits, send \`Authorization: Bearer <key>\`. The recommended path for human developers.`);
  lines.push(`2. **x402** — pay per call with USDC on Base. No signup. On 402, read the \`WWW-Authenticate: Payment\` header, send the payment, retry. See ${root}/.well-known/x402.json.`);
  lines.push(`3. **MPP** — Stripe Machine Payments Protocol (cards + stablecoins). Discovery via OpenAPI \`x-mpp\` annotations and per-API \`/.well-known/mpp\`.`);
  lines.push("");
  lines.push(`## Discovery`);
  lines.push("");
  lines.push(`- MCP server (npm): \`npx @mbeato/apimesh-mcp-server\``);
  lines.push(`- Platform manifest: ${root}/.well-known/mpp`);
  lines.push(`- OpenAPI: ${root}/openapi.json`);
  lines.push(`- llms.txt index: ${root}/llms.txt`);
  lines.push(`- GitHub: https://github.com/mbeato/conway`);
  lines.push("");
  lines.push(`Generated: ${manifest.generated_at}`);
  lines.push("");

  return lines.join("\n");
}
