/**
 * Reference selector for the API builder.
 *
 * Picks 2 same-category reference APIs + 1 cross-category reference
 * to provide the LLM with high-quality patterns to follow.
 */

import { join } from "path";
import { readdirSync } from "node:fs";

export const CATEGORY_REFS: Record<string, string[]> = {
  security: ["security-headers", "website-vulnerability-scan"],
  seo: ["seo-audit", "core-web-vitals"],
  devtools: ["regex-builder", "swagger-docs-creator"],
  email: ["email-verify", "email-security"],
  web: ["tech-stack", "redirect-chain"],
  infrastructure: ["microservice-health-check"],
  "ssl-analysis": ["security-headers"],
  "seo-crawling": ["seo-audit", "indexability"],
  "tech-detection": ["tech-stack", "web-resource-validator"],
};

const SHARED_SIGNATURES = `
=== SHARED MODULE SIGNATURES ===
shared/x402.ts exports:
  paymentMiddleware(routes, resourceServer) — Hono middleware, dual-rail x402+MPP payment gate
  paidRouteWithDiscovery(price, description, discovery) — route config with bazaar discovery
  resourceServer — pre-configured x402ResourceServer instance
  WALLET_ADDRESS, NETWORK

shared/x402-wallet.ts exports:
  extractPayerWallet() — Hono middleware, sets c.set("payerWallet", address)

shared/spend-cap.ts exports:
  spendCapMiddleware() — Hono middleware, enforces per-wallet daily/monthly spend caps

shared/logger.ts exports:
  apiLogger(apiName, priceUsd) — Hono middleware, logs requests and revenue

shared/rate-limit.ts exports:
  rateLimit(zone, maxRequests, windowMs) — Hono middleware

shared/ssrf.ts exports:
  safeFetch(url, opts?) — SSRF-safe fetch with redirect validation (for APIs that fetch external URLs)
  validateExternalUrl(raw) — returns { url: URL } | { error: string }
  readBodyCapped(res, maxBytes) — read response body with size limit

shared/db.ts exports:
  default db, logRequest(), logRevenue(), registerApi(name, port, subdomain), etc.
`;

async function readApiFile(
  apisDir: string,
  apiName: string,
  filename: string
): Promise<string | null> {
  try {
    const filePath = join(apisDir, apiName, filename);
    return await Bun.file(filePath).text();
  } catch {
    return null;
  }
}

function getFirstNonIndexTs(apisDir: string, apiName: string): string | null {
  try {
    const dir = join(apisDir, apiName);
    const files = readdirSync(dir);
    const tsFile = files.find(
      (f) => f.endsWith(".ts") && f !== "index.ts" && !f.endsWith(".test.ts")
    );
    return tsFile || null;
  } catch {
    return null;
  }
}

export async function getReferencesForCategory(
  category: string,
  apisDir: string
): Promise<string> {
  // Look up category refs, fall back to security
  const sameCategory = CATEGORY_REFS[category] ?? CATEGORY_REFS["security"];
  const sameCategoryRefs = sameCategory.slice(0, 2);

  // Pick 1 cross-category reference
  const otherRefs: string[] = [];
  for (const [cat, refs] of Object.entries(CATEGORY_REFS)) {
    if (cat !== category) {
      for (const ref of refs) {
        if (!sameCategoryRefs.includes(ref) && !otherRefs.includes(ref)) {
          otherRefs.push(ref);
        }
      }
    }
  }

  const crossIndex = new Date().getDay() % (otherRefs.length || 1);
  const crossRef = otherRefs[crossIndex] || "security-headers";

  const allRefs = [...sameCategoryRefs, crossRef];
  const parts: string[] = [];

  for (const apiName of allRefs) {
    // Read index.ts
    const indexContent = await readApiFile(apisDir, apiName, "index.ts");
    if (indexContent) {
      parts.push(`=== REFERENCE: apis/${apiName}/index.ts ===\n${indexContent}`);
    }

    // Try to read first non-index .ts file
    const helperFile = getFirstNonIndexTs(apisDir, apiName);
    if (helperFile) {
      const helperContent = await readApiFile(apisDir, apiName, helperFile);
      if (helperContent) {
        parts.push(
          `=== REFERENCE: apis/${apiName}/${helperFile} ===\n${helperContent}`
        );
      }
    }
  }

  parts.push(SHARED_SIGNATURES);

  return parts.join("\n\n");
}
