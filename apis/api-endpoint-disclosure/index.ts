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
  EndpointDisclosureResult,
  EndpointInfo,
  analyzeEndpointDisclosure,
  previewEndpointDisclosure,
} from "./analyzer";

const app = new Hono();
const API_NAME = "api-endpoint-disclosure";
const PORT = Number(process.env.PORT) || 3001;
const PRICE = "$0.01"; // Comprehensive audit based price
const PRICE_NUM = 0.01;

// 1. CORS middleware open to all origins
app.use("*", cors({
  origin: "*",
  allowMethods: ["GET"],
  allowHeaders: ["Content-Type", "X-PAYMENT", "payment-signature"],
}));

// 2. /health endpoint before rate limit
app.get("/health", (c) => c.json({ status: "ok" }));

// 3. Rate limits
app.use("/check", rateLimit("api-endpoint-disclosure-check", 20, 60_000));
app.use("*", rateLimit("api-endpoint-disclosure", 60, 60_000));

// 4. Extract payer wallet middleware
app.use("*", extractPayerWallet());

// 5. API logging middleware
app.use("*", apiLogger(API_NAME, PRICE_NUM));

// 6. Info endpoint
app.get("/", (c) =>
  c.json({
    api: API_NAME,
    status: "healthy",
    version: "1.0.0",
    docs: {
      endpoints: [
        {
          method: "GET",
          path: "/check",
          description:
            "Detect common exposed backend and API endpoint filenames to identify potential security leaks",
          parameters: [
            {
              name: "url",
              in: "query",
              required: true,
              description: "Target base URL of the website to scan (http(s)://...)",
              schema: { type: "string" },
            },
          ],
          exampleResponse: {
            status: "ok",
            data: {
              url: "https://example.com",
              foundEndpoints: [
                { filename: ".env", statusCode: 403, contentType: "text/html", size: 1250 },
                { filename: "package.json", statusCode: 200, contentType: "application/json", size: 782 },
                { filename: "serverless.yml", statusCode: 404, contentType: "text/html", size: 540 },
                { filename: "config.js", statusCode: 401, contentType: "text/html", size: 300 },
              ],
              score: 40,
              grade: "D",
              details: "Several sensitive configuration files are accessible without proper restrictions.",
              recommendations: [
                {
                  issue: ".env file exposed",
                  severity: 90,
                  suggestion:
                    "Restrict access to .env files via server configuration or move secrets out of web root.",
                },
                {
                  issue: "package.json accessible",
                  severity: 60,
                  suggestion: "Disable public access to package.json to prevent info disclosure.",
                },
                {
                  issue: "Authentication missing on config.js",
                  severity: 70,
                  suggestion:
                    "Add authentication or deny access to config.js to secure sensitive configs.",
                },
              ],
              scannedAt: "2024-06-04T12:34:56.789Z",
            },
            meta: {
              timestamp: "2024-06-04T12:34:56.789Z",
              duration_ms: 1234,
              api_version: "1.0.0",
            },
          },
        },
        {
          method: "GET",
          path: "/preview",
          description:
            "Quick preview that checks a minimal set of common endpoints for potential leaks",
          parameters: [
            {
              name: "url",
              in: "query",
              required: true,
              description: "Target base URL to preview scan (http(s)://...)",
              schema: { type: "string" },
            },
          ],
          exampleResponse: {
            status: "ok",
            data: {
              url: "https://example.com",
              foundEndpoints: [
                { filename: ".env", statusCode: 403 },
                { filename: "package.json", statusCode: 404 },
              ],
              score: 50,
              grade: "C",
              details: "Preview scan found no critical leaks but limited checks performed.",
              recommendations: [
                {
                  issue: "Consider running full audit for detailed report",
                  severity: 20,
                  suggestion:
                    "Run the full /check endpoint with payment for a comprehensive analysis.",
                },
              ],
              scannedAt: "2024-06-04T12:34:56.789Z",
            },
            meta: {
              timestamp: "2024-06-04T12:34:56.789Z",
              duration_ms: 345,
              api_version: "1.0.0",
            },
          },
        },
      ],
      parameters: [
        {
          name: "url",
          description: "The target website URL to check, must be a valid http or https URL",
          required: true,
          type: "string",
        },
      ],
      examples: [
        {
          description: "Basic usage of endpoint disclosure check",
          request: "/check?url=https://example.com",
          response: "Refer to exampleResponse in /check endpoint",
        },
      ],
    },
    pricing: {
      description: "Comprehensive audit with 5+ endpoint checks, scoring, and recommendations",
      costPerCall: PRICE,
    },
  }),
);

// 7. Free preview endpoint BEFORE payment
app.get(
  "/preview",
  rateLimit("api-endpoint-disclosure-preview", 30, 60_000),
  async (c) => {
    const rawUrl = c.req.query("url");
    if (!rawUrl || typeof rawUrl !== "string") {
      return c.json({ error: "Provide ?url=http(s)://... parameter" }, 400);
    }
    if (rawUrl.length > 2048) {
      return c.json({ error: "URL exceeds maximum length" }, 400);
    }

    const validated = validateExternalUrl(rawUrl.trim());
    if ("error" in validated) {
      return c.json({ error: validated.error }, 400);
    }

    try {
      const result = await previewEndpointDisclosure(validated.url.toString());
      return c.json(result);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      const status = /timeout|timed out|abort/i.test(msg) ? 504 : 502;
      return c.json({ error: "Analysis temporarily unavailable", detail: msg }, status);
    }
  },
);

// 8. Payment and spend caps
app.use("*", spendCapMiddleware());
app.use(
  paymentMiddleware(
    {
      "GET /check": paidRouteWithDiscovery(
        PRICE,
        "Perform comprehensive detection of common backend or API endpoint leaks with scoring and recommendations",
        {
          input: { url: "https://example.com" },
          inputSchema: {
            properties: {
              url: {
                type: "string",
                description: "Target URL to detect exposed backend/API endpoints",
              },
            },
            required: ["url"],
          },
        },
      ),
    },
    resourceServer,
  ),
);

// 9. Paid route /check
app.get("/check", async (c) => {
  const rawUrl = c.req.query("url");
  if (!rawUrl || typeof rawUrl !== "string") {
    return c.json({ error: "Provide ?url= parameter (http(s)://...)" }, 400);
  }
  if (rawUrl.length > 2048) {
    return c.json({ error: "URL exceeds maximum length" }, 400);
  }

  const validated = validateExternalUrl(rawUrl.trim());
  if ("error" in validated) {
    return c.json({ error: validated.error }, 400);
  }

  try {
    const result = await analyzeEndpointDisclosure(validated.url.toString());
    return c.json(result);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    const status = /timeout|timed out|abort/i.test(msg) ? 504 : 502;
    return c.json({ error: "Analysis temporarily unavailable", detail: msg }, status);
  }
});

// 10. On error handler
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
