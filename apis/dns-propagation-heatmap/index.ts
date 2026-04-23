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

import { previewHeatmap, fullHeatmapCheck, HeatmapQuery } from "./analyzer";

const app = new Hono();
const API_NAME = "dns-propagation-heatmap";
const PORT = Number(process.env.PORT) || 3001;
const PRICE = "$0.01";
const PRICE_NUM = 0.01;

app.use("*", cors({
  origin: "*",
  allowMethods: ["GET"],
  allowHeaders: ["Content-Type", "X-PAYMENT", "payment-signature"],
}));

app.get("/health", (c) => c.json({ status: "ok" }));

app.use("/check", rateLimit("dns-propagation-heatmap-check", 20, 60_000));
app.use("*", rateLimit("dns-propagation-heatmap", 60, 60_000));

app.use("*", extractPayerWallet());
app.use("*", apiLogger(API_NAME, PRICE_NUM));

app.get("/", (c) => {
  return c.json({
    api: API_NAME,
    status: "healthy",
    version: "1.0.0",
    docs: {
      endpoints: [
        {
          method: "GET",
          path: "/preview",
          description: "Free preview that performs a quick propagation check across select global public DNS resolvers.",
          parameters: [
            { name: "record", in: "query", description: "DNS record domain name (e.g. example.com)", required: true },
            { name: "type", in: "query", description: "DNS record type (A, AAAA, CNAME, TXT, etc.)", required: true },
          ],
          exampleResponse: {
            status: "ok",
            data: {
              domain: "example.com",
              type: "A",
              queriedAt: "2024-01-01T12:00:00Z",
              resolversChecked: 5,
              results: [
                { resolver: "8.8.8.8", result: ["93.184.216.34"], timestamp: "2024-01-01T11:59:58Z" },
                { resolver: "1.1.1.1", result: ["93.184.216.34"], timestamp: "2024-01-01T11:59:56Z" },
              ],
              explanation: "Quick propagation check across major resolvers to detect basic availability and timing.",
            },
            meta: {
              timestamp: "2024-01-01T12:00:00Z",
              duration_ms: 1100,
              api_version: "1.0.0"
            }
          }
        },
        {
          method: "GET",
          path: "/check",
          description: "Paid comprehensive DNS propagation audit across multiple resolver types, including scoring and actionable recommendations.",
          parameters: [
            { name: "record", in: "query", description: "DNS record full domain name", required: true },
            { name: "type", in: "query", description: "DNS record type to query", required: true }
          ],
          exampleResponse: {
            status: "ok",
            data: {
              domain: "example.com",
              type: "A",
              timestamp: "2024-01-01T12:00:00Z",
              propagationScore: 85,
              grade: "B",
              results: [
                { resolver: "8.8.8.8", result: ["93.184.216.34"], lastUpdateSecondsAgo: 40 },
                { resolver: "1.1.1.1", result: ["93.184.216.34"], lastUpdateSecondsAgo: 30 },
                { resolver: "9.9.9.9", result: ["93.184.216.34"], lastUpdateSecondsAgo: 50 },
              ],
              details: "Most resolvers return consistent A record values within 1 min delay.",
              recommendations: [
                {
                  issue: "Propagation delay greater than 60 sec on some resolvers",
                  severity: 70,
                  suggestion: "Review TTL settings and registrar DNS propagation times."
                }
              ]
            },
            meta: {
              timestamp: "2024-01-01T12:00:00Z",
              duration_ms: 3200,
              api_version: "1.0.0"
            }
          }
        }
      ],
      parameters: [
        { name: "record", description: "Fully qualified DNS record (domain) name - e.g. sub.example.com.", required: true },
        { name: "type", description: "DNS record type such as A, AAAA, CNAME, TXT, MX, NS, etc.", required: true }
      ],
      examples: [
        {
          request: "/check?record=example.com&type=A",
          description: "Perform a paid full DNS propagation heatmap check for A records"
        },
        {
          request: "/preview?record=example.com&type=A",
          description: "Perform a free quick preview for A record propagation"
        }
      ],
    },
    pricing: {
      "/check": "$0.01",
      "/preview": "free"
    }
  });
});

// Free preview route
app.get(
  "/preview",
  rateLimit("dns-propagation-heatmap-preview", 15, 60_000),
  async (c) => {
    const record = c.req.query("record");
    const type = c.req.query("type")?.toUpperCase() || "A";

    if (typeof record !== "string" || record.length === 0) {
      return c.json({ error: "Missing or invalid ?record= parameter" }, 400);
    }
    if (typeof type !== "string" || type.length === 0) {
      return c.json({ error: "Missing or invalid ?type= parameter" }, 400);
    }

    try {
      const start = performance.now();
      const result = await previewHeatmap(record.trim(), type.trim());
      const duration_ms = Math.round(performance.now() - start);

      if ("error" in result) {
        return c.json(
          { status: "error", error: result.error, detail: result.errorMessage || "", meta: { timestamp: new Date().toISOString(), duration_ms, api_version: "1.0.0" } },
          400
        );
      }

      return c.json({ status: "ok", data: result, meta: { timestamp: new Date().toISOString(), duration_ms, api_version: "1.0.0" } });
    } catch (e: any) {
      console.error(`[${new Date().toISOString()}] ${API_NAME} preview error:`, e);
      const msg = e instanceof Error ? e.message : String(e);
      const status = /timeout|timed out|abort/i.test(msg) ? 504 : 502;
      return c.json({ status: "error", error: "Analysis temporarily unavailable", detail: msg, meta: { timestamp: new Date().toISOString(), duration_ms: 0, api_version: "1.0.0" } }, status);
    }
  }
);

// Payment middleware enforcement
app.use("*", spendCapMiddleware());
app.use(
  paymentMiddleware(
    {
      "GET /check": paidRouteWithDiscovery(
        PRICE,
        "Comprehensive DNS propagation audit across global resolvers with scoring, grading and actionable recommendations",
        {
          input: {
            record: "example.com",
            type: "A"
          },
          inputSchema: {
            properties: {
              record: { type: "string", description: "Fully qualified domain name of DNS record" },
              type: { type: "string", description: "DNS record type (A, AAAA, CNAME, TXT, etc.)" },
            },
            required: ["record", "type"]
          }
        }
      ),
    },
    resourceServer
  )
);

app.get("/check", async (c) => {
  const record = c.req.query("record");
  const type = c.req.query("type")?.toUpperCase() || "A";

  if (typeof record !== "string" || record.length === 0) {
    return c.json({ status: "error", error: "Missing or invalid ?record= parameter", detail: "Parameter 'record' is required", meta: { timestamp: new Date().toISOString(), duration_ms: 0, api_version: "1.0.0" } }, 400);
  }
  if (typeof type !== "string" || type.length === 0) {
    return c.json({ status: "error", error: "Missing or invalid ?type= parameter", detail: "Parameter 'type' is required", meta: { timestamp: new Date().toISOString(), duration_ms: 0, api_version: "1.0.0" } }, 400);
  }

  try {
    const start = performance.now();
    const result = await fullHeatmapCheck({ record: record.trim(), type: type.trim() });
    const duration_ms = Math.round(performance.now() - start);

    if ("error" in result) {
      return c.json({ status: "error", error: result.error, detail: result.detail || "", meta: { timestamp: new Date().toISOString(), duration_ms, api_version: "1.0.0" } }, 400);
    }

    return c.json({ status: "ok", data: result, meta: { timestamp: new Date().toISOString(), duration_ms, api_version: "1.0.0" } });
  } catch (e: any) {
    console.error(`[${new Date().toISOString()}] ${API_NAME} check error:`, e);
    const msg = e instanceof Error ? e.message : String(e);
    const status = /timeout|timed out|abort/i.test(msg) ? 504 : 502;
    return c.json({ status: "error", error: "Analysis temporarily unavailable", detail: msg, meta: { timestamp: new Date().toISOString(), duration_ms: 0, api_version: "1.0.0" } }, status);
  }
});

app.onError((err, c) => {
  if (typeof err === "object" && err !== null && "getResponse" in err) {
    return (err as any).getResponse();
  }
  console.error(`[${new Date().toISOString()}] ${API_NAME} error:`, err);
  return c.json({ status: "error", error: "Internal server error", detail: "", meta: { timestamp: new Date().toISOString(), duration_ms: 0, api_version: "1.0.0" } }, 500);
});

app.notFound((c) => c.json({ status: "error", error: "Not found", detail: "Endpoint does not exist", meta: { timestamp: new Date().toISOString(), duration_ms: 0, api_version: "1.0.0" } }, 404));

export { app };

if (import.meta.main) console.log(`${API_NAME} listening on port ${PORT}`);

export default {
  port: PORT,
  hostname: "127.0.0.1",
  fetch: app.fetch,
};
