import { Hono } from "hono";
import { cors } from "hono/cors";
import {
  paymentMiddleware,
  paidRouteWithDiscovery,
  resourceServer,
} from "../../shared/x402";
import { apiLogger } from "../../shared/logger";
import { extractPayerWallet } from "../../shared/x402-wallet";
import { spendCapMiddleware } from "../../shared/spend-cap";
import { rateLimit } from "../../shared/rate-limit";
import {
  validateExternalUrl,
  safeFetch,
} from "../../shared/ssrf";
import {
  analyzeCorsHeaders,
  comprehensiveCorsAudit,
} from "./analyzer";
import type {
  AggregatedCorsReport,
  EndpointCorsAnalysis,
} from "./types";

const app = new Hono();
const API_NAME = "cross-origin-resource-policymapper";
const PORT = Number(process.env.PORT) || 3001;
const PRICE_STR = "$0.01"; // Comprehensive audit price
const PRICE_NUM = 0.01;

// CORS open to all origins and required headers
app.use("*",
  cors({
    origin: "*",
    allowMethods: ["GET"],
    allowHeaders: ["Content-Type", "X-PAYMENT", "payment-signature"],
  })
);

// Health endpoint BEFORE rate limiting
app.get("/health", (c) => c.json({ status: "ok" }));

// Rate limits
app.use("/check", rateLimit("cors-policy-mapper-check", 10, 60_000));
app.use("*", rateLimit("cors-policy-mapper", 50, 60_000));

// Extract wallet
app.use("*", extractPayerWallet());

// API logger with price
app.use("*", apiLogger(API_NAME, PRICE_NUM));

// Info endpoint
app.get("/", (c) => {
  return c.json({
    api: API_NAME,
    status: "healthy",
    version: "1.0.0",
    docs: {
      endpoints: [
        {
          method: "GET",
          path: "/check",
          description: "Paid endpoint: Perform comprehensive CORS headers audit across multiple endpoints. Input baseUrl and optional endpoints list.",
          parameters: [
            { name: "baseUrl", required: true, description: "Base URL or domain to analyze (e.g. https://example.com)" },
            { name: "endpoints", required: false, description: "Optional comma-separated list of endpoint paths to analyze (e.g. /api,/auth)" },
          ],
          exampleResponse: {
            status: "ok",
            data: {
              baseUrl: "https://example.com",
              endpointCount: 3,
              averageScore: 75,
              overallGrade: "B",
              summary: {
                overlyPermissiveCount: 2,
                misconfigurationCount: 1,
                inconsistentHeaders: ["Access-Control-Allow-Origin"]
              },
              endpoints: [/* detailed per endpoint analysis */],
              recommendations: [
                { issue: "Access-Control-Allow-Origin header: Allows any origin (wildcard '*').", severity: 60, suggestion: "Restrict Access-Control-Allow-Origin to specific allowed origins instead of '*'." }
              ],
              generatedAt: "2024-06-18T12:34:56Z"
            },
            meta: {
              timestamp: "2024-06-18T12:34:56Z",
              duration_ms: 350,
              api_version: "1.0.0"
            }
          }
        },
        {
          method: "GET",
          path: "/preview",
          description: "Free preview: Analyze one URL for main CORS headers, simple pass/fail and basic info.",
          parameters: [
            { name: "url", required: true, description: "Full URL to fetch and analyze." }
          ],
          exampleResponse: {
            status: "ok",
            data: {
              url: "https://example.com/api",
              corsHeaders: {/* per-header analysis */},
              overallScore: 85,
              grade: "A",
              explanation: "Access-Control-Allow-Origin set correctly. Moderate permissions on methods.",
              recommendations: [],
              fetchedAt: "2024-06-18T12:00:00Z"
            },
            meta: {
              timestamp: "2024-06-18T12:00:00Z",
              duration_ms: 120,
              api_version: "1.0.0"
            }
          }
        }
      ],
      parameters: [
        { name: "baseUrl", description: "Base URL for audit, must be a valid http(s) URL" },
        { name: "endpoints", description: "Optional list of endpoints (comma separated paths or full URLs)" },
        { name: "url", description: "Full URL for preview check" },
      ],
      examples: [
        { usage: "GET /preview?url=https://example.com/api" },
        { usage: "GET /check?baseUrl=https://example.com&endpoints=/api,/auth,/static" },
      ],
    },
    pricing: {
      paidEndpoint: "/check",
      price: PRICE_STR,
      description: "Comprehensive audit with 5+ checks, scoring, grading, and detailed remediation recommendations",
    },
  });
});

// Free preview endpoint (single URL, no payment)
app.get("/preview", rateLimit("cors-policy-mapper-preview", 20, 60_000), async (c) => {
  const rawUrl = c.req.query("url");
  if (!rawUrl || typeof rawUrl !== "string") {
    return c.json({ error: "Missing ?url= parameter (full http(s):// URL required)" }, 400);
  }

  if (rawUrl.length > 2048) {
    return c.json({ error: "URL exceeds maximum length" }, 400);
  }

  const check = validateExternalUrl(rawUrl.trim());
  if ("error" in check) {
    return c.json({ error: check.error }, 400);
  }

  try {
    const start = performance.now();
    const result = await analyzeCorsHeaders(check.url.toString());
    const duration_ms = Math.round(performance.now() - start);

    if ("error" in result) {
      return c.json({ status: "error", error: result.error, detail: "", meta: { timestamp: new Date().toISOString(), duration_ms, api_version: "1.0.0" } }, 400);
    }

    return c.json({ status: "ok", data: result, meta: { timestamp: new Date().toISOString(), duration_ms, api_version: "1.0.0" } });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    const status = /timeout|timed out|abort/i.test(msg) ? 504 : 502;
    return c.json({ status: "error", error: "Analysis temporarily unavailable", detail: msg, meta: { timestamp: new Date().toISOString(), duration_ms: 0, api_version: "1.0.0" } }, status);
  }
});

// Payment middleware and spend cap
app.use("*", spendCapMiddleware());
app.use(
  paymentMiddleware(
    {
      "GET /check": paidRouteWithDiscovery(
        PRICE_STR,
        "Comprehensive CORS headers and Cross-Origin Resource Policy audit across multiple endpoints with scoring, grading, and actionable recommendations",
        {
          input: { baseUrl: "https://example.com", endpoints: ["/api", "/auth"] },
          inputSchema: {
            properties: {
              baseUrl: {
                type: "string",
                description: "Base URL to analyze (http or https URL)"
              },
              endpoints: {
                type: "array",
                items: { type: "string" },
                description: "Optional list of endpoint paths or full URLs to audit",
              },
            },
            required: ["baseUrl"]
          },
        },
      ),
    },
    resourceServer
  )
);

// Paid route
app.get("/check", async (c) => {
  const baseUrl = c.req.query("baseUrl");
  if (!baseUrl || typeof baseUrl !== "string") {
    return c.json({ status: "error", error: "Missing ?baseUrl= parameter", detail: "", meta: { timestamp: new Date().toISOString(), duration_ms: 0, api_version: "1.0.0" } }, 400);
  }

  const endpointsRaw = c.req.query("endpoints");
  let endpoints: string[] | undefined = undefined;
  if (typeof endpointsRaw === "string") {
    endpoints = endpointsRaw.split(",").map(s => s.trim()).filter(Boolean);
  } else if (Array.isArray(endpointsRaw)) {
    endpoints = endpointsRaw.map(String).map(s => s.trim()).filter(Boolean);
  }

  if (baseUrl.length > 2048) {
    return c.json({ status: "error", error: "baseUrl exceeds maximum length", detail: "", meta: { timestamp: new Date().toISOString(), duration_ms: 0, api_version: "1.0.0" } }, 400);
  }
  if (endpoints) {
    for (const ep of endpoints) {
      if (ep.length > 2048) {
        return c.json({ status: "error", error: "An endpoint in list exceeds maximum length", detail: ep, meta: { timestamp: new Date().toISOString(), duration_ms: 0, api_version: "1.0.0" } }, 400);
      }
    }
  }

  try {
    const start = performance.now();
    const report = await comprehensiveCorsAudit(baseUrl.trim(), endpoints);
    const duration_ms = Math.round(performance.now() - start);

    if ("error" in report) {
      return c.json({ status: "error", error: report.error, detail: "", meta: { timestamp: new Date().toISOString(), duration_ms, api_version: "1.0.0" } }, 400);
    }

    return c.json({ status: "ok", data: report, meta: { timestamp: new Date().toISOString(), duration_ms, api_version: "1.0.0" } });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    const status = /timeout|timed out|abort/i.test(msg) ? 504 : 502;
    return c.json({ status: "error", error: "Analysis temporarily unavailable", detail: msg, meta: { timestamp: new Date().toISOString(), duration_ms: 0, api_version: "1.0.0" } }, status);
  }
});

// Error handler (passes through HTTPExceptions for 402s)
app.onError((err, c) => {
  if (typeof err === "object" && err !== null && "getResponse" in err) {
    return (err as any).getResponse();
  }
  console.error(`[${new Date().toISOString()}] ${API_NAME} error:`, err);
  return c.json({ error: "Internal server error" }, 500);
});

app.notFound((c) => c.json({ error: "Not found" }, 404));

export { app };

if (import.meta.main) console.log(`${API_NAME} listening on port ${PORT}`);

export default {
  port: PORT,
  hostname: "127.0.0.1",
  fetch: app.fetch,
};
