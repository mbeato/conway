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
import { validateExternalUrl, safeFetch } from "../../shared/ssrf";
import {
  analyzePerformance,
  PagePerformanceResult,
} from "./analyzer";

const app = new Hono();
const API_NAME = "page-performance-metrics";
const PORT = Number(process.env.PORT) || 3001;

// Pricing tier chosen: Comprehensive audit (5+ checks, scoring, detailed report) $0.01
const PRICE_STR = "$0.01";
const PRICE_NUM = 0.01;
const SUBDOMAIN = "page-performance-metrics.apimesh.xyz";

app.use("*",
  cors({
    origin: "*",
    allowMethods: ["GET"],
    allowHeaders: ["Content-Type", "X-PAYMENT", "payment-signature"],
  })
);

// Health check before rate limiter
app.get("/health", (c) => c.json({ status: "ok" }));

// Rate limiting
app.use("/check", rateLimit("page-performance-metrics-check", 30, 60_000));
app.use("*", rateLimit("page-performance-metrics", 90, 60_000));

// Extract wallet
app.use("*", extractPayerWallet());

// API Logger
app.use("*", apiLogger(API_NAME, PRICE_NUM));

// Info endpoint: describe API and pricing
app.get("/", (c) => {
  return c.json({
    api: API_NAME,
    status: "healthy",
    version: "1.0.0",
    description: "Fetch and analyze page load timing, resource sizes, and critical requests to provide a lightweight performance score for web pages.",
    subdomain: SUBDOMAIN,
    docs: {
      endpoints: [
        {
          method: "GET",
          path: "/check",
          description: "Perform a comprehensive performance audit of a given URL, with scoring and recommendations.",
          parameters: [
            { name: "url", type: "string", required: true, description: "The webpage URL to analyze, must be http or https." }
          ],
          exampleResponse: {
            status: "ok",
            data: {
              url: "https://example.com",
              timing: {},
              resourceSummary: {},
              criticalRequests: [],
              score: 85,
              grade: "B",
              recommendations: [{ issue: "Load time high", severity: "medium", suggestion: "Optimize images." }],
              details: "Detailed report and explanation..."
            },
            meta: { timestamp: "...", duration_ms: 2000, api_version: "1.0.0" }
          }
        }
      ],
      parameters: [
        { name: "url", type: "string", description: "The URL of the page to analyze" }
      ],
      examples: [
        {
          description: "Analyze example.com page performance",
          request: "/check?url=https://example.com",
          response: "See exampleResponse above"
        }
      ]
    },
    pricing: {
      tier: "Comprehensive audit",
      price: PRICE_STR,
      description: "Multiple fetches, timing analysis, resource size summaries, critical resource identification, and actionable recommendations."
    }
  });
});

// Free preview endpoint with limited checks (basic page load timing estimates, no payments)
app.get("/preview", rateLimit("page-performance-metrics-preview", 15, 60_000), async (c) => {
  const rawUrl = c.req.query("url");
  if (!rawUrl || typeof rawUrl !== "string") {
    return c.json({ error: "Missing ?url= parameter (http(s)://...)" }, 400);
  }
  if (rawUrl.length > 2048) {
    return c.json({ error: "URL exceeds maximum length" }, 400);
  }

  const check = validateExternalUrl(rawUrl);
  if ("error" in check) {
    return c.json({ error: check.error }, 400);
  }
  const url = check.url.toString();

  const start = performance.now();

  try {
    // Basic GET with generous timeout to measure Timing-Allow headers for preview
    // Limited analysis: page load timing from Navigation Timing API approximation
    // Use one fetch to HEAD and GET
    const controller = new AbortController();
    const previewTimeout = AbortSignal.timeout(20_000);
    const signal = new AbortController();
    const combinedSignal = previewTimeout;

    // First send a HEAD request to get headers and content-length
    const headPromise = safeFetch(url, {
      method: "HEAD",
      signal: combinedSignal,
      timeoutMs: 8000,
      headers: { "User-Agent": "page-performance-metrics-preview/1.0 apimesh.xyz" },
    });

    // Also we ask for main page GET with timeout
    const getPromise = safeFetch(url, {
      method: "GET",
      signal: combinedSignal,
      timeoutMs: 15000,
      headers: { "User-Agent": "page-performance-metrics-preview/1.0 apimesh.xyz" },
    });

    const [headRes, getRes] = await Promise.all([headPromise, getPromise]);

    // Extract relevant headers for preview
    const contentLengthHeader = headRes.headers.get("content-length");
    const previewSize = contentLengthHeader ? parseInt(contentLengthHeader, 10) : null;

    // Read minimum body bytes from GET for some heuristic
    const maxBodyBytes = 1024 * 512; // 512KB max preview
    const buffer = new Uint8Array(maxBodyBytes);
    const reader = getRes.body?.getReader();
    let received = 0;
    if (reader) {
      while (received < maxBodyBytes) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          buffer.set(value, received);
          received += value.length;
        }
      }
    }

    // Broadcast some minimal summary for preview
    const duration_ms = Math.round(performance.now() - start);

    return c.json({
      status: "ok",
      data: {
        url,
        preview: true,
        size_bytes: previewSize,
        body_sample_size: received,
        note: "Preview provides limited fetch timing and size info. Pay for full comprehensive audit",
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

// Payment middlewares
app.use("*", spendCapMiddleware());
app.use(
  paymentMiddleware(
    {
      "GET /check": paidRouteWithDiscovery(
        PRICE_STR,
        "Comprehensive audit. Combines multiple fetches, timing and resource size analyses, critical requests identification, scoring (0-100), letter grade (A-F), and actionable recommendations.",
        {
          input: { url: "https://example.com" },
          inputSchema: {
            properties: {
              url: { type: "string", description: "Webpage URL to analyze, must start with http:// or https://" },
            },
            required: ["url"],
          },
        }
      ),
    },
    resourceServer
  )
);

// Paid endpoint for detailed check
app.get("/check", async (c) => {
  const rawUrl = c.req.query("url");

  if (!rawUrl || typeof rawUrl !== "string") {
    return c.json({ error: "Missing ?url= parameter (http(s)://...)" }, 400);
  }
  if (rawUrl.length > 2048) {
    return c.json({ error: "URL exceeds maximum length" }, 400);
  }

  const check = validateExternalUrl(rawUrl);
  if ("error" in check) {
    return c.json({ error: check.error }, 400);
  }
  const url = check.url.toString();

  const start = performance.now();

  try {
    // Analyze with comprehensive method
    const result: PagePerformanceResult = await analyzePerformance(url);
    const duration_ms = Math.round(performance.now() - start);

    return c.json({
      status: "ok",
      data: result,
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

// Error handler - handle HTTPException pass-through
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
