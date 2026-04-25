import { Hono } from "hono";
import { cors } from "hono/cors";
import { extractPayerWallet } from "../../shared/x402-wallet";
import { spendCapMiddleware } from "../../shared/spend-cap";
import { paymentMiddleware, paidRouteWithDiscovery, resourceServer } from "../../shared/x402";
import { apiLogger } from "../../shared/logger";
import { rateLimit } from "../../shared/rate-limit";
import { validateExternalUrl, safeFetch } from "../../shared/ssrf";
import {
  analyzeApiStandardCompliance,
} from "./compliance";
import type { ApiComplianceResult, ApiInfo } from "./types";

const app = new Hono();
const API_NAME = "api-standard-compliance";
const PORT = Number(process.env.PORT) || 3001;
const PRICE_STRING = "$0.005"; // Standard analysis
const PRICE_NUM = 0.005;

// CORS open to all origins
app.use("*", cors({
  origin: "*",
  allowMethods: ["GET"],
  allowHeaders: ["Content-Type", "X-PAYMENT", "payment-signature"],
}));

// /health endpoint before rate limiting
app.get("/health", (c) => c.json({ status: "ok" }));

// Rate limits
app.use("/check", rateLimit("api-standard-compliance-check", 30, 60_000));
app.use("*", rateLimit("api-standard-compliance", 90, 60_000));

// Extract payer wallet
app.use("*", extractPayerWallet());

// API logger with fixed price numeric
app.use("*", apiLogger(API_NAME, PRICE_NUM));

// Info endpoint
app.get("/", (c) => {
  const docs: ApiInfo["docs"] = {
    endpoints: [
      {
        method: "GET",
        path: "/check",
        description: "Perform a comprehensive API standard compliance analysis on the target API response URL.",
        parameters: [
          {
            name: "url",
            type: "string",
            description: "HTTP or HTTPS URL of the API endpoint to analyze",
            required: true,
          },
        ],
        exampleResponse: {
          status: "ok",
          data: {
            url: "https://api.example.com/data",
            overallScore: 85,
            overallGrade: "A",
            checks: [
              {
                name: "Status Code",
                passed: true,
                score: 100,
                grade: "A+",
                severity: 90,
                explanation: "HTTP status code is 200, standard success.",
                details: { status: 200 },
                recommendations: [],
              },
              {
                name: "Content-Type",
                passed: true,
                score: 100,
                grade: "A+",
                severity: 80,
                explanation: "Content-Type header is application/json.",
                details: { contentType: "application/json" },
                recommendations: [],
              },
              {
                name: "JSON Format",
                passed: true,
                score: 100,
                grade: "A+",
                severity: 100,
                explanation: "Response contains valid JSON format.",
                details: {},
                recommendations: [],
              },
              {
                name: "Cache-Control",
                passed: false,
                score: 50,
                grade: "C",
                severity: 50,
                explanation: "Cache-Control header missing, may cause caching issues.",
                details: {},
                recommendations: [
                  { issue: "Missing Cache-Control header", severity: 50, suggestion: "Add Cache-Control header like 'no-store' for dynamic APIs." }
                ],
              },
              {
                name: "JSON Envelope",
                passed: true,
                score: 100,
                grade: "A+",
                severity: 100,
                explanation: "Response follows standard envelope with 'status' and 'data' keys.",
                details: { exampleKeys: ["status", "data"] },
                recommendations: [],
              },
            ],
            recommendations: [],
            checkedAt: "2024-06-15T12:34:56Z"
          },
          meta: {
            timestamp: "2024-06-15T12:34:56Z",
            duration_ms: 253,
            api_version: "1.0.0"
          }
        },
      },
      {
        method: "GET",
        path: "/preview",
        description: "Free preview of API compliance by checking the status code and content-type header only.",
        parameters: [
          {
            name: "url",
            type: "string",
            description: "HTTP or HTTPS URL of the API endpoint to preview",
            required: true,
          },
        ],
        exampleResponse: {
          status: "ok",
          data: {
            url: "https://api.example.com/data",
            simpleChecksPassed: true,
            statusCode: 200,
            contentType: "application/json",
            checkedAt: "2024-06-15T12:00:00Z",
            note: "This preview runs lightweight checks; pay for full compliance audit with scoring and recommendations."
          },
          meta: {
            timestamp: "2024-06-15T12:00:00Z",
            duration_ms: 121,
            api_version: "1.0.0"
          }
        },
      },
    ],
    parameters: [
      {
        name: "url",
        type: "string",
        description: "API endpoint URL to analyze, must be http or https",
        required: true,
      },
    ],
    examples: [
      {
        summary: "Full compliance check for example API",
        request: { method: "GET", path: "/check", query: { url: "https://api.example.com/data" } },
        response: {
          status: "ok",
          data: {
            url: "https://api.example.com/data",
            overallScore: 85,
            overallGrade: "A",
            checks: [],
            recommendations: [],
            checkedAt: "..."
          },
          meta: { timestamp: "...", duration_ms: 200, api_version: "1.0.0" }
        }
      },
      {
        summary: "Preview checks only status code and content type without payment",
        request: { method: "GET", path: "/preview", query: { url: "https://api.example.com/data" } },
        response: {
          status: "ok",
          data: {
            url: "https://api.example.com/data",
            simpleChecksPassed: true,
            statusCode: 200,
            contentType: "application/json",
            checkedAt: "...",
            note: "Preview checks status and content-type only."
          },
          meta: { timestamp: "...", duration_ms: 100, api_version: "1.0.0" }
        }
      }
    ],
  };

  const info: ApiInfo = {
    api: API_NAME,
    status: "healthy",
    version: "1.0.0",
    docs,
    pricing: {
      pricePerCall: PRICE_STRING,
      priceNumber: PRICE_NUM,
      description: "Comprehensive API compliance analysis with scoring and detailed recommendations.",
    },
  };
  return c.json(info);
});

// Free preview endpoint (light check) before payment middleware
app.get("/preview", rateLimit("api-standard-compliance-preview", 20, 60_000), async (c) => {
  const rawUrl = c.req.query("url");
  if (!rawUrl || typeof rawUrl !== "string") {
    return c.json({ error: "Missing or invalid ?url= parameter" }, 400);
  }
  if (rawUrl.length > 2048) {
    return c.json({ error: "URL exceeds maximum length" }, 400);
  }

  const validUrl = validateExternalUrl(rawUrl.trim());
  if ("error" in validUrl) {
    return c.json({ error: validUrl.error }, 400);
  }

  const start = performance.now();

  try {
    const res = await safeFetch(validUrl.url.toString(), {
      method: "HEAD",
      timeoutMs: 20000,
      headers: { "User-Agent": "api-standard-compliance-preview/1.0 apimesh.xyz" },
    });

    const statusCheck = res.status >= 200 && res.status < 300;
    const contentType = res.headers.get("content-type") || "";
    const contentTypeOk = contentType.toLowerCase().includes("application/json");
    const simpleChecksPassed = statusCheck && contentTypeOk;

    const data = {
      url: validUrl.url.toString(),
      simpleChecksPassed,
      statusCode: res.status,
      contentType,
      checkedAt: new Date().toISOString(),
      note: "This preview runs lightweight checks (status and content-type) without payment. Full compliance audit at /check with payment.",
    };

    const duration_ms = Math.round(performance.now() - start);

    return c.json({ status: "ok", data, meta: { timestamp: new Date().toISOString(), duration_ms, api_version: "1.0.0" } });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    const status = /timeout|timed out|abort/i.test(msg) ? 504 : 502;
    return c.json({ error: "Analysis temporarily unavailable", detail: msg }, status);
  }
});

// Middleware order continues
app.use("*", spendCapMiddleware());
app.use(
  paymentMiddleware(
    {
      "GET /check": paidRouteWithDiscovery(
        PRICE_STRING,
        "Perform a comprehensive API response standard compliance audit including status, headers, JSON format, scoring and actionable recommendations.",
        {
          input: { url: "https://api.example.com/endpoint" },
          inputSchema: {
            properties: {
              url: { type: "string", description: "API endpoint URL to analyze" },
            },
            required: ["url"],
          },
        },
      ),
    },
    resourceServer,
  ),
);

// Paid endpoint
app.get("/check", async (c) => {
  const rawUrl = c.req.query("url");
  if (!rawUrl || typeof rawUrl !== "string") {
    return c.json({ error: "Missing or invalid ?url= parameter" }, 400);
  }
  if (rawUrl.length > 2048) {
    return c.json({ error: "URL exceeds maximum length" }, 400);
  }

  try {
    const start = performance.now();
    const result = await analyzeApiStandardCompliance(rawUrl.trim());
    if ("error" in result) {
      return c.json({ error: result.error }, 400);
    }
    const duration_ms = Math.round(performance.now() - start);
    return c.json({ status: "ok", data: result, meta: { timestamp: new Date().toISOString(), duration_ms, api_version: "1.0.0" } });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    const status = /timeout|timed out|abort/i.test(msg) ? 504 : 502;
    return c.json({ error: "Analysis temporarily unavailable", detail: msg }, status);
  }
});

// OnError handler must pass through HTTPExceptions for 402s
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
