import { Hono } from "hono";
import { cors } from "hono/cors";
import { extractPayerWallet } from "../../shared/x402-wallet";
import { spendCapMiddleware } from "../../shared/spend-cap";
import { paymentMiddleware, paidRouteWithDiscovery, resourceServer } from "../../shared/x402";
import { apiLogger } from "../../shared/logger";
import { rateLimit } from "../../shared/rate-limit";
import { validateExternalUrl, safeFetch } from "../../shared/ssrf";
import { performFullValidation, performPreviewValidation, ValidationResponse } from "./analyzer";

const app = new Hono();
const API_NAME = "api-structure-validator";
const PORT = Number(process.env.PORT) || 3001;
const PRICE = "$0.01"; // Comprehensive audit requiring 5+ checks, scoring, recommendations

app.use("*", cors({
  origin: "*",
  allowMethods: ["GET"],
  allowHeaders: ["Content-Type", "X-PAYMENT", "payment-signature"],
}));

// 2. Health endpoint BEFORE rate limiting
app.get("/health", (c) => c.json({ status: "ok" }));

// 3. Rate limits
app.use("/check", rateLimit("api-structure-validator-check", 30, 60_000));
app.use("*", rateLimit("api-structure-validator", 90, 60_000));

// 4. Extract wallet
app.use("*", extractPayerWallet());

// 5. API Logging
app.use("*", apiLogger(API_NAME, 0.01));

// 6. Info endpoint
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
          description: "Validates the structural correctness and completeness of OpenAPI/Swagger definitions with multi-layer analysis and detailed report.",
          parameters: [
            { name: "url", type: "string", description: "URL of the OpenAPI/Swagger spec to validate (http(s)://...)" },
          ],
          example_response: {
            status: "ok",
            data: {
              score: 85,
              grade: "B",
              schemaVersion: "3.0.2",
              errorsCount: 3,
              warningsCount: 5,
              recommendationsCount: 4,
              details: "Analysis combines JSON Schema validation, presence checks, cross ref checks, and naming guidelines.",
              recommendations: [
                { issue: "Missing description in /users path", severity: "High", suggestion: "Add descriptive documentation for all API paths." },
                { issue: "Unused schema component 'Pet'", severity: "Medium", suggestion: "Remove or reference the unused 'Pet' schema component." },
              ]
            },
            meta: { timestamp: "2024-01-01T00:00:00.000Z", duration_ms: 2000, api_version: "1.0.0" },
          },
        },
        {
          method: "GET",
          path: "/preview",
          description: "Performs a quick preview validation check of the API definition, focusing on basic schema format and URL reachability.",
          parameters: [
            { name: "url", type: "string", description: "URL of the OpenAPI/Swagger spec to preview validate (http(s)://...)" },
          ],
          example_response: {
            status: "ok",
            data: {
              preview: true,
              validFormat: true,
              rootVersion: "3.0.2",
              warningsCount: 1,
              errorsCount: 0,
              details: "Basic format checks passed. No syntax errors detected.",
              recommendations: [
                { issue: "Operation at path /pets missing operationId", severity: "Low", suggestion: "Add unique operationId for every operation." }
              ]
            },
            meta: { timestamp: "2024-01-01T00:00:00.000Z", duration_ms: 700, api_version: "1.0.0" },
          },
        }
      ],
      parameters: [
        { name: "url", type: "string", description: "URL referencing an OpenAPI or Swagger JSON or YAML API definition document" }
      ],
      examples: [
        {
          description: "Quick preview call",
          request: "/preview?url=https://example.com/openapi.yaml",
          response: {
            status: "ok",
            data: { preview: true, validFormat: true, rootVersion: "3.0.2", warningsCount: 1, errorsCount: 0, recommendations: [] },
            meta: { timestamp: "...", duration_ms: 700, api_version: "1.0.0" }
          }
        },
        {
          description: "Full validation audit",
          request: "/check?url=https://example.com/openapi.yaml",
          response: {
            status: "ok",
            data: { score: 90, grade: "A", errorsCount: 1, warningsCount: 2, recommendationsCount: 3, details: "Comprehensive report...", recommendations: [] },
            meta: { timestamp: "...", duration_ms: 2000, api_version: "1.0.0" }
          }
        }
      ]
    },
    pricing: {
      description: "Comprehensive validation with multi-layer analysis, scoring, and actionable recommendations.",
      cost: PRICE
    }
  });
});

// 7. Spending cap
app.use("*", spendCapMiddleware());

// 8. Payment middleware
app.use(
  paymentMiddleware(
    {
      "GET /check": paidRouteWithDiscovery(
        PRICE,
        "Comprehensive OpenAPI/Swagger structure validation with scoring, grading, discovery metadata, and actionable recommendations.",
        {
          input: { url: "https://example.com/openapi.json" },
          inputSchema: {
            properties: {
              url: { type: "string", description: "URL to the OpenAPI/Swagger JSON or YAML document" },
            },
            required: ["url"],
          },
        }
      ),
    },
    resourceServer
  )
);

// 9. Paid route for full validation
app.get("/check", async (c) => {
  const rawUrl = c.req.query("url");
  if (!rawUrl || typeof rawUrl !== "string") {
    return c.json({ error: "Missing or invalid ?url= parameter (http(s)://...)" }, 400);
  }
  if (rawUrl.length > 4096) {
    return c.json({ error: "URL parameter too long" }, 400);
  }

  const validated = validateExternalUrl(rawUrl.trim());
  if ("error" in validated) {
    return c.json({ error: validated.error }, 400);
  }

  try {
    const start = performance.now();
    const result: ValidationResponse = await performFullValidation(validated.url.toString());
    const duration_ms = Math.round(performance.now() - start);
    if ("error" in result && !("score" in result)) {
      // Fatal error parsing JSON or network
      return c.json({ error: result.error }, 400);
    }
    return c.json({ status: "ok", data: result, meta: { timestamp: new Date().toISOString(), duration_ms, api_version: "1.0.0" } });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    const status = /timeout|timed out|abort/i.test(msg) ? 504 : 502;
    return c.json({ error: "Analysis temporarily unavailable", detail: msg }, status);
  }
});

// 9b. Free preview route
app.get("/preview", rateLimit("api-structure-validator-preview", 15, 60_000), async (c) => {
  const rawUrl = c.req.query("url");
  if (!rawUrl || typeof rawUrl !== "string") {
    return c.json({ error: "Missing or invalid ?url= parameter (http(s)://...)" }, 400);
  }
  if (rawUrl.length > 4096) {
    return c.json({ error: "URL parameter too long" }, 400);
  }

  const validated = validateExternalUrl(rawUrl.trim());
  if ("error" in validated) {
    return c.json({ error: validated.error }, 400);
  }

  try {
    const start = performance.now();
    const result = await performPreviewValidation(validated.url.toString());
    const duration_ms = Math.round(performance.now() - start);
    if ("error" in result && !result.validFormat) {
      return c.json({ error: result.error }, 400);
    }
    return c.json({ status: "ok", data: result, meta: { timestamp: new Date().toISOString(), duration_ms, api_version: "1.0.0" } });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    const status = /timeout|timed out|abort/i.test(msg) ? 504 : 502;
    return c.json({ error: "Analysis temporarily unavailable", detail: msg }, status);
  }
});

// 10. Error handler - propagate x402 HTTPExceptions for 402
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
