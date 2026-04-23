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
  SchemaDeltaResult,
  InfoResponse,
  fetchMultipleSchemas,
  compareSchemas,
  gradeScoreToLetter,
  generateRecommendations,
  parseJsonSchema,
  parseGraphQLSchema,
} from "./logic";

const app = new Hono();
const API_NAME = "api-schema-delta";
const PORT = Number(process.env.PORT) || 3001;
const PRICE = "$0.01";
const PRICE_NUM = 0.01;
const API_VERSION = "1.0.0";

app.use("*", cors({
  origin: "*",
  allowMethods: ["GET"],
  allowHeaders: ["Content-Type", "X-PAYMENT", "payment-signature"],
}));

// Health check before rate limiter
app.get("/health", (c) => c.json({ status: "ok" }));

// Rate limits
app.use("/compare", rateLimit("api-schema-delta-compare", 15, 60_000));
app.use("*", rateLimit("api-schema-delta", 45, 60_000));

app.use("*", extractPayerWallet());

// Logging
app.use("*", apiLogger(API_NAME, PRICE_NUM));

// Info endpoint
app.get("/", (c) => {
  const info: InfoResponse = {
    api: API_NAME,
    status: "healthy",
    version: API_VERSION,
    docs: {
      endpoints: [
        {
          method: "GET",
          path: "/compare",
          description: "Compare multiple API schemas from given URLs and return detailed diff and evolution analysis",
          parameters: [
            {
              name: "urls",
              type: "string[]",
              description: "Array of schema URLs to fetch and compare",
              required: true,
              in: "query",
              maxItems: 5
            },
            {
              name: "type",
              type: "string",
              enum: ["rest", "graphql"],
              description: "Type of schema, either REST JSON Schema or GraphQL SDL",
              required: true,
              in: "query"
            },
          ],
          exampleResponse: {
            status: "ok",
            data: {
              urls: ["https://example.com/v1/schema.json", "https://example.com/v2/schema.json"],
              comparisons: [],
              overallScore: 85,
              grade: "B",
              recommendations: []
            },
            meta: {
              timestamp: "2024-01-01T12:00:00.000Z",
              duration_ms: 450,
              api_version: API_VERSION
            }
          }
        }
      ],
      parameters: [
        {
          name: "urls",
          type: "string[]",
          description: "Array of URLs pointing to API schemas",
          required: true
        },
        {
          name: "type",
          type: "string",
          enum: ["rest", "graphql"],
          description: "Schema format type"
        }
      ],
      examples: [
        "GET /compare?urls=https://api.example.com/v1/schema.json&urls=https://api.example.com/v2/schema.json&type=rest",
        "GET /compare?urls=https://api.example.com/graphql/schema1.graphql&urls=https://api.example.com/graphql/schema2.graphql&type=graphql"
      ]
    },
    pricing: {
      description: "Comprehensive audit and comparison of multiple API schemas with scoring and detailed recommendations",
      price: PRICE
    }
  };
  return c.json(info);
});

// Free preview — describe a single schema (no diff, no payment required)
app.get("/preview", rateLimit("api-schema-delta-preview", 30, 60_000), async (c) => {
  const schemaUrl = c.req.query("url") || c.req.query("schema");
  if (!schemaUrl) {
    return c.json({ error: "Provide ?url= parameter with a single schema URL" }, 400);
  }

  const check = validateExternalUrl(schemaUrl.trim());
  if ("error" in check) {
    return c.json({ error: `Invalid URL: ${check.error}` }, 400);
  }

  try {
    const res = await safeFetch(check.url.toString(), {
      timeoutMs: 5000,
      headers: { "User-Agent": "api-schema-delta/1.0 apimesh.xyz" },
    });
    if (!res.ok) {
      return c.json({ error: `Failed to fetch schema: HTTP ${res.status}` }, 200);
    }
    const text = await res.text();
    const sizeBytes = text.length;
    if (sizeBytes > 500_000) {
      return c.json({
        url: schemaUrl,
        preview: true,
        data: { format: "too_large", sizeBytes },
        note: "Preview describes a single schema. Pay for diff, compatibility scoring, and evolution analysis.",
      });
    }

    let format: string = "unknown";
    let version: string | undefined;
    let endpointCount: number | undefined;

    if (/\btype\s+Query\b/.test(text)) {
      format = "graphql";
      const typeMatches = text.match(/\btype\s+\w+/g);
      if (typeMatches) endpointCount = typeMatches.length;
    } else {
      let parsed: any;
      try {
        parsed = JSON.parse(text);
      } catch {
        return c.json({
          url: schemaUrl,
          preview: true,
          data: { format: "unknown", sizeBytes, note: "YAML or non-JSON formats require paid /compare" },
          note: "Preview describes a single schema. Pay for diff, compatibility scoring, and evolution analysis.",
        });
      }
      if (parsed && typeof parsed === "object") {
        if (typeof parsed.openapi === "string") {
          format = "openapi_3";
          version = parsed.openapi;
          endpointCount = parsed.paths && typeof parsed.paths === "object" ? Object.keys(parsed.paths).length : 0;
        } else if (typeof parsed.swagger === "string") {
          format = "openapi_2";
          version = parsed.swagger;
          endpointCount = parsed.paths && typeof parsed.paths === "object" ? Object.keys(parsed.paths).length : 0;
        } else if (typeof parsed.$schema === "string") {
          format = "json_schema";
          version = parsed.$schema;
        }
      }
    }

    return c.json({
      url: schemaUrl,
      preview: true,
      data: { format, version, endpointCount, sizeBytes },
      note: "Preview describes a single schema. Pay for diff, compatibility scoring, and evolution analysis.",
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return c.json({ error: "Preview fetch failed", detail: msg }, 200);
  }
});

app.use("*", spendCapMiddleware());

// Payment middleware with paid route
app.use(
  paymentMiddleware(
    {
      "GET /compare": paidRouteWithDiscovery(
        PRICE,
        "Comprehensive analysis comparing multiple REST or GraphQL schemas with evolution trends, scoring, and recommendations",
        {
          input: {
            urls: ["https://example.com/v1/schema.json", "https://example.com/v2/schema.json"],
            type: "rest"
          },
          inputSchema: {
            properties: {
              urls: {
                type: "array",
                minItems: 2,
                maxItems: 5,
                items: { type: "string", format: "uri" },
                description: "Array of schema URLs to fetch and compare (2 to 5 URLs)"
              },
              type: {
                type: "string",
                enum: ["rest", "graphql"],
                description: "Schema type; REST (JSON Schema) or GraphQL (SDL)"
              }
            },
            required: ["urls", "type"],
            additionalProperties: false
          }
        }
      )
    },
    resourceServer
  )
);

interface CompareQuery {
  urls?: string[] | string;
  type?: string;
}

// Main paid endpoint
app.get("/compare", async (c) => {
  const query = c.req.query() as unknown as CompareQuery;
  let urlsRaw = query.urls;
  if (!urlsRaw) {
    return c.json({ error: "Missing ?urls= parameter (2-5 schema URLs)" }, 400);
  }
  // Support either single string or array
  let urls: string[] = [];
  if (typeof urlsRaw === "string") {
    urls = [urlsRaw];
  } else if (Array.isArray(urlsRaw)) {
    urls = urlsRaw;
  } else {
    return c.json({ error: "Invalid ?urls= parameter format" }, 400);
  }

  if (urls.length < 2 || urls.length > 5) {
    return c.json({ error: "Provide between 2 and 5 URLs to compare" }, 400);
  }

  const typeRaw = query.type;
  if (!typeRaw || (typeRaw !== "rest" && typeRaw !== "graphql")) {
    return c.json({ error: "Missing or invalid ?type= parameter, must be 'rest' or 'graphql'" }, 400);
  }
  const schemaType = typeRaw;

  // Validate each url
  const validatedUrls: string[] = [];
  for (const rawUrl of urls) {
    if (typeof rawUrl !== "string") {
      return c.json({ error: `Invalid URL input: ${rawUrl}` }, 400);
    }
    if (rawUrl.length > 2048) {
      return c.json({ error: "One of the URLs exceeds maximum length of 2048 chars" }, 400);
    }
    const check = validateExternalUrl(rawUrl.trim());
    if ("error" in check) {
      return c.json({ error: `Invalid URL: ${check.error}`, detail: rawUrl }, 400);
    }
    validatedUrls.push(check.url.toString());
  }

  try {
    const start = performance.now();

    // Fetch all schemas in parallel
    const schemas = await fetchMultipleSchemas(validatedUrls, schemaType);

    // Compare schemas
    const comparison = compareSchemas(schemas, schemaType);

    const duration_ms = Math.round(performance.now() - start);

    // Compute overall score & grade
    let overallScore = comparison.overallScore;
    if (overallScore < 0) overallScore = 0;
    if (overallScore > 100) overallScore = 100;
    const grade = gradeScoreToLetter(overallScore);

    // Generate recommendations based on comparison
    const recommendations = generateRecommendations(comparison);

    const response: SchemaDeltaResult = {
      urls: validatedUrls,
      comparisons: comparison.diffs,
      overallScore,
      grade,
      recommendations,
    };

    return c.json({
      status: "ok",
      data: response,
      meta: {
        timestamp: new Date().toISOString(),
        duration_ms,
        api_version: API_VERSION,
      },
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    const isTimeout = /timeout|timed out|abort/i.test(msg);
    const status = isTimeout ? 504 : 502;
    return c.json({
      status: "error",
      error: "Analysis temporarily unavailable",
      detail: msg,
      meta: {
        timestamp: new Date().toISOString(),
        duration_ms: 0,
        api_version: API_VERSION,
      },
    }, status);
  }
});

// Error handler: pass through HTTPException for 402s
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
