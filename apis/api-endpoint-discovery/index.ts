import { Hono } from "hono";
import { cors } from "hono/cors";
import { paymentMiddleware, paidRouteWithDiscovery, resourceServer } from "../../shared/x402";
import { apiLogger } from "../../shared/logger";
import { extractPayerWallet } from "../../shared/x402-wallet";
import { spendCapMiddleware } from "../../shared/spend-cap";
import { rateLimit } from "../../shared/rate-limit";
import { validateExternalUrl } from "../../shared/ssrf";
import { previewDiscovery, previewDiscoverySchema, fullDiscovery, fullDiscoverySchema, EndpointDiscoveryResult, EndpointDiscoveryPreview } from "./analyzer";

const app = new Hono();
const API_NAME = "api-endpoint-discovery";
const PORT = Number(process.env.PORT) || 3001;
const PRICE = "$0.01";
const PRICE_NUM = 0.01;

// CORS first
app.use("*", cors({
  origin: "*",
  allowMethods: ["GET"],
  allowHeaders: ["Content-Type", "X-PAYMENT", "payment-signature"],
}));

// Health endpoint before rate limiter
app.get("/health", (c) => c.json({ status: "ok" }));

// Rate limits
app.use("/discover", rateLimit("api-endpoint-discovery-discover", 10, 60_000));
app.use("*", rateLimit("api-endpoint-discovery", 30, 60_000));

// Extract payer wallet
app.use("*", extractPayerWallet());

// Logger with price as number (for real usage)
app.use("*", apiLogger(API_NAME, PRICE_NUM));

// Info endpoint
app.get("/", (c) => c.json({
  api: API_NAME,
  status: "healthy",
  version: "1.0.0",
  docs: {
    endpoints: [
      {
        method: "GET",
        path: "/discover",
        description: "Comprehensively crawl and analyze API endpoints on the specified domain.",
        parameters: [
          { name: "domain", type: "string", description: "Target domain to scan, e.g., example.com" },
        ],
        exampleResponse: {
          status: "ok",
          data: {
            scannedDomain: "example.com",
            endpoints: [
              {
                path: "/api/v1/users",
                methods: ["GET", "POST"],
                description: "User management endpoint",
                score: 85,
                grade: "B",
                details: "Typical RESTful user endpoint detected.",
                recommendations: [
                  { issue: "No POST secured endpoint detected", severity: 60, suggestion: "Ensure authentication and CSRF protection are enabled on POST." }
                ]
              }
            ],
            totalEndpoints: 14,
            scanTimestamp: "2024-05-01T12:00:00Z",
            duration_ms: 3450
          },
          meta: { timestamp: "2024-05-01T12:00:00Z", duration_ms: 3450, api_version: "1.0.0" }
        }
      },
      {
        method: "GET",
        path: "/preview",
        description: "Preview API endpoint detection using light checks (no payment required).",
        parameters: [
          { name: "domain", type: "string", description: "Target domain to preview, e.g., example.com" }
        ],
        exampleResponse: {
          status: "ok",
          data: {
            scannedDomain: "example.com",
            endpointsPreview: [
              { path: "/api/users", methods: ["GET"], details: "Detected based on discovery heuristics" }
            ],
            scannedAt: "2024-05-01T12:00:00Z",
            duration_ms: 1200
          },
          meta: { timestamp: "2024-05-01T12:00:00Z", duration_ms: 1200, api_version: "1.0.0" }
        }
      }
    ],
    parameters: [
      { name: "domain", type: "string", description: "Domain name without protocol, e.g. example.com" }
    ],
    examples: [
      {
        request: "GET /discover?domain=example.com",
        description: "Runs a deep discovery scan and returns full analysis with grading and recommendations."
      },
      {
        request: "GET /preview?domain=example.com",
        description: "Runs a quick preview check on common API endpoint paths with minimal depth."
      }
    ]
  },
  pricing: {
    pricePerCall: PRICE,
    description: "Comprehensive domain API endpoint discovery with multi-layer analysis, scoring, and actionable recommendations.",
    priceCategory: "Deep scan",
    priceUsd: PRICE_NUM
  }
}));

// Free Preview - lighter checks
app.get("/preview", rateLimit("api-endpoint-discovery-preview", 20, 60_000), async (c) => {
  const domainRaw = c.req.query("domain");
  if (!domainRaw || typeof domainRaw !== "string") {
    return c.json({ error: "Missing ?domain= parameter (e.g. example.com)" }, 400);
  }
  if (domainRaw.length > 255) {
    return c.json({ error: "Domain name too long" }, 400);
  }

  try {
    const start = performance.now();
    const result = await previewDiscovery(domainRaw.trim());
    const duration_ms = Math.round(performance.now() - start);

    return c.json({
      status: "ok",
      data: {
        ...result,
        duration_ms,
      },
      meta: {
        timestamp: new Date().toISOString(),
        duration_ms,
        api_version: "1.0.0",
      },
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    const status = /timeout|timed out|abort/i.test(msg) ? 504 : 502;
    return c.json({ error: "Analysis temporarily unavailable", detail: msg }, status);
  }
});

// Spend cap middleware
app.use("*", spendCapMiddleware());

// Payment middleware for paid discovery endpoint
app.use(
  "*",
  paymentMiddleware(
    {
      "GET /discover": paidRouteWithDiscovery(
        PRICE,
        "Comprehensive domain API endpoint discovery with multi-layered crawling, scoring, and detailed recommendations",
        {
          input: { domain: "example.com" },
          inputSchema: fullDiscoverySchema,
        },
      ),
    },
    resourceServer
  )
);

// Paid route
app.get("/discover", async (c) => {
  const domainRaw = c.req.query("domain");
  if (!domainRaw || typeof domainRaw !== "string") {
    return c.json({ error: "Missing ?domain= parameter (e.g. example.com)" }, 400);
  }
  if (domainRaw.length > 255) {
    return c.json({ error: "Domain name too long" }, 400);
  }

  try {
    const start = performance.now();
    const result = await fullDiscovery(domainRaw.trim());
    const duration_ms = Math.round(performance.now() - start);
    if ((result as any).error) {
      return c.json({ error: (result as any).error }, 400);
    }

    return c.json({ status: "ok", data: { ...result, duration_ms }, meta: { timestamp: new Date().toISOString(), duration_ms, api_version: "1.0.0" } });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    const status = /timeout|timed out|abort/i.test(msg) ? 504 : 502;
    return c.json({ error: "Analysis temporarily unavailable", detail: msg }, status);
  }
});

// Error handler must pass through HTTPException for 402s
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
