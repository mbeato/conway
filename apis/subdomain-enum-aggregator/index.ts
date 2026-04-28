import { Hono } from "hono";
import { cors } from "hono/cors";
import { paymentMiddleware, paidRouteWithDiscovery, resourceServer } from "../../shared/x402";
import { apiLogger } from "../../shared/logger";
import { extractPayerWallet } from "../../shared/x402-wallet";
import { spendCapMiddleware } from "../../shared/spend-cap";
import { rateLimit } from "../../shared/rate-limit";
import { validateExternalUrl } from "../../shared/ssrf";
import {
  exhaustiveEnumeration,
  SubdomainEnumerationResult,
  EnumerationRecommendations,
  ScoredSubdomain,
} from "./enumerator";

const app = new Hono();
const API_NAME = "subdomain-enum-aggregator";
const PORT = Number(process.env.PORT) || 3001;
const PRICE_STR = "$0.01";
const PRICE_NUM = 0.01;

// CORS open to all origins + strict allowMethods + headers
app.use("*", cors({
  origin: "*",
  allowMethods: ["GET"],
  allowHeaders: ["Content-Type", "X-PAYMENT", "payment-signature"],
}));

// Health endpoint before rate limiter
app.get("/health", (c) => c.json({ status: "ok" }));

// Rate limit policies
app.use("/check", rateLimit("subdomain-enum-aggregator-check", 20, 60_000));
app.use("/preview", rateLimit("subdomain-enum-aggregator-preview", 30, 60_000));
app.use("*", rateLimit("subdomain-enum-aggregator-global", 90, 60_000));

// Extract payer wallet from payment data
app.use("*", extractPayerWallet());

// Logger with price
app.use("*", apiLogger(API_NAME, PRICE_NUM));

// Info endpoint, after rate limit + logger but before payment
app.get("/", (c) => {
  const docs = {
    endpoints: [
      {
        method: "GET",
        path: "/check",
        description: "Perform an exhaustive subdomain enumeration scan on a domain.",
        parameters: [
          {
            name: "domain",
            type: "string",
            description: "Main domain name to enumerate subdomains for (example.com).",
            required: true,
          },
        ],
        exampleResponse: {
          status: "ok",
          data: {
            domain: "example.com",
            subdomainsFound: 128,
            results: [
              {
                subdomain: "api.example.com",
                sources: ["crtsh", "dnsdb", "googlect"],
                score: 85,
                grade: "B",
                unused: false,
                details: "Active subdomain verified with DNS A record and recent certificate.",
              },
              {
                subdomain: "old.example.com",
                sources: ["crtsh"],
                score: 40,
                grade: "D",
                unused: true,
                details: "No DNS record and only appeared in old CT logs; possibly orphaned.",
              },
            ],
            overallScore: 78,
            overallGrade: "B",
            recommendations: [
              { issue: "Unused subdomains", severity: 70, suggestion: "Review and decommission unused subdomains like old.example.com." },
              { issue: "Low score subdomains", severity: 50, suggestion: "Investigate low scoring subdomains for potential security issues." }
            ],
          },
          meta: {
            timestamp: "2024-01-01T00:00:00.000Z",
            duration_ms: 1234,
            api_version: "1.0.0"
          }
        },
      },
      {
        method: "GET",
        path: "/preview",
        description: "Free preview with limited sources and faster response, suitable for initial tests.",
        parameters: [{ name: "domain", type: "string", description: "Domain to preview subdomain scan for", required: true }],
        exampleResponse: {
          status: "ok",
          data: {
            domain: "example.com",
            subdomainsFound: 10,
            results: [
              { subdomain: "api.example.com", sources: ["crtsh"] },
              { subdomain: "blog.example.com", sources: ["dnsdb"] },
            ],
            note: "Preview returns limited sources and no scoring. Pay for full audit.",
          },
          meta: {
            timestamp: "2024-01-01T00:00:00.000Z",
            duration_ms: 500,
            api_version: "1.0.0"
          }
        },
      },
    ],
    parameters: [
      { name: "domain", type: "string", description: "The primary domain name to enumerate subdomains" }
    ],
    examples: [
      "GET /check?domain=example.com",
      "GET /preview?domain=example.com",
    ],
  };

  const pricing = {
    pricingModel: "comprehensive audit",
    tier: PRICE_STR,
    description: "Perform exhaustive subdomain enumeration by querying 5+ data sources and aggregating results with scoring and actionable recommendations.",
  };

  return c.json({ api: API_NAME, status: "healthy", version: "1.0.0", docs, pricing, subdomain: "subdomain-enum-aggregator.apimesh.xyz" });
});

// Free preview - limited sources only, more reliable
app.get(
  "/preview",
  async (c) => {
    const rawDomain = c.req.query("domain");
    if (!rawDomain || typeof rawDomain !== "string") {
      return c.json({ error: "Missing or invalid 'domain' query parameter" }, 400);
    }

    if (rawDomain.length > 253) {
      return c.json({ error: "Domain too long" }, 400);
    }

    // Validate domain format with basic regex (letters, digits, dashes, dots)
    const domainRegex = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i;
    if (!domainRegex.test(rawDomain)) {
      return c.json({ error: "Invalid domain format" }, 400);
    }

    const start = performance.now();
    try {
      const data = await exhaustiveEnumeration(rawDomain, true); // preview mode
      const duration_ms = Math.round(performance.now() - start);
      return c.json({
        status: "ok",
        data: {
          domain: rawDomain,
          subdomainsFound: data.results.length,
          results: data.results.map(({ subdomain, sources }) => ({ subdomain, sources })),
          note: "Preview returns limited sources and no scoring. Pay for full audit with deep analysis.",
        },
        meta: { timestamp: new Date().toISOString(), duration_ms, api_version: "1.0.0" },
      });
    } catch (e: any) {
      const msg = e instanceof Error ? e.message : String(e);
      const status = /timeout|timed out|abort/i.test(msg) ? 504 : 502;
      return c.json({ error: "Analysis temporarily unavailable", detail: msg }, status);
    }
  }
);

// Spend cap enforcement and payment middleware
app.use("*", spendCapMiddleware());
app.use(
  paymentMiddleware(
    {
      "GET /check": paidRouteWithDiscovery(
        PRICE_STR,
        "Comprehensive subdomain enumeration using multiple DNS and certificate transparency log sources with scoring, grading, and actionable security recommendations.",
        {
          input: { domain: "example.com" },
          inputSchema: {
            properties: {
              domain: { type: "string", description: "Domain name to enumerate subdomains for" },
            },
            required: ["domain"],
          },
        }
      ),
    },
    resourceServer
  )
);

// Paid endpoint /check
app.get("/check", async (c) => {
  const rawDomain = c.req.query("domain");
  if (!rawDomain || typeof rawDomain !== "string") {
    return c.json({ error: "Missing or invalid 'domain' parameter" }, 400);
  }

  if (rawDomain.length > 253) {
    return c.json({ error: "Domain too long" }, 400);
  }

  const domainRegex = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i;
  if (!domainRegex.test(rawDomain)) {
    return c.json({ error: "Invalid domain format" }, 400);
  }

  const start = performance.now();
  try {
    const result = await exhaustiveEnumeration(rawDomain, false); // full scan
    const duration_ms = Math.round(performance.now() - start);
    return c.json({ status: "ok", data: result, meta: { timestamp: new Date().toISOString(), duration_ms, api_version: "1.0.0" } });
  } catch (e: any) {
    const msg = e instanceof Error ? e.message : String(e);
    const status = /timeout|timed out|abort/i.test(msg) ? 504 : 502;
    return c.json({ error: "Analysis temporarily unavailable", detail: msg }, status);
  }
});

// Not found
app.notFound((c) => c.json({ error: "Not found" }, 404));

// Custom onError for 402 forwarding, generic 500 logging
app.onError((err, c) => {
  if (typeof err === "object" && err !== null && "getResponse" in err) {
    return (err as any).getResponse();
  }
  console.error(`[${new Date().toISOString()}] ${API_NAME} error:`, err);
  return c.json({ error: "Internal server error" }, 500);
});

export { app };

if (import.meta.main) {
  console.log(`${API_NAME} listening on port ${PORT}`);
}

export default {
  port: PORT,
  hostname: "127.0.0.1",
  fetch: app.fetch,
};
