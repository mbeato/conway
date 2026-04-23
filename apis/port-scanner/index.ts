import { Hono } from "hono";
import { cors } from "hono/cors";
import { paymentMiddleware, paidRouteWithDiscovery, resourceServer } from "../../shared/x402";
import { apiLogger } from "../../shared/logger";
import { extractPayerWallet } from "../../shared/x402-wallet";
import { spendCapMiddleware } from "../../shared/spend-cap";
import { rateLimit } from "../../shared/rate-limit";
import { deepPortScan, previewPortScan, PortScanQuery } from "./scanner";

const app = new Hono();
const API_NAME = "port-scanner";
const PORT = Number(process.env.PORT) || 3001;
const PRICE_STR = "$0.02";
const PRICE_NUM = 0.02;

// Open CORS to all origins including required headers
app.use("*", cors({
  origin: "*",
  allowMethods: ["GET"],
  allowHeaders: ["Content-Type", "X-PAYMENT", "payment-signature"],
}));

// Health check endpoint before rate limiting
app.get("/health", (c) => c.json({ status: "ok" }));

// Rate limits:
// · /scan preview free: 15 requests per 60k ms
// · /scan paid route: 30 requests per 60k ms
// · global 90 requests per 60k ms
app.use("/preview", rateLimit("port-scanner-preview", 15, 60_000));
app.use("/scan", rateLimit("port-scanner-scan", 30, 60_000));
app.use("*", rateLimit("port-scanner", 90, 60_000));

// Middleware chain
app.use("*", extractPayerWallet());
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
          path: "/scan",
          description: "Perform a deep port scan on a target IP or hostname",
          parameters: [
            { name: "target", type: "string", description: "Target IP or hostname to scan" }
          ],
          exampleResponse: {
            status: "ok",
            data: {
              scannedAt: "ISO8601 string",
              target: "string",
              openPorts: [
                { port: 80, protocol: "tcp", service: "http", severity: 40, description: "HTTP port open", detectedVersion: "Apache 2.4" }
              ],
              score: 70,
              grade: "B",
              explanation: "Most common ports scanned; http and ssh detected. Moderate risk due to open SSH port with weak protocols.",
              recommendations: [
                {
                  issue: "Open SSH Port",
                  severity: 60,
                  suggestion: "Disable root login and use key authentication for SSH"
                }
              ]
            },
            meta: {
              timestamp: "ISO8601",
              duration_ms: 1234,
              api_version: "1.0.0"
            }
          }
        },
        {
          method: "GET",
          path: "/preview",
          description: "Free lightweight preview scan on a target (fast, fewer ports)",
          parameters: [
            { name: "target", type: "string", description: "Target IP or hostname for preview scan" }
          ],
          exampleResponse: {
            status: "ok",
            data: { preview: true, scannedAt: "ISO8601 string", openPorts: [ { port: 80, protocol: "tcp" } ] },
            meta: {
              timestamp: "ISO8601",
              duration_ms: 850,
              api_version: "1.0.0"
            }
          }
        }
      ],
      parameters: [
        {
          name: "target",
          type: "string",
          description: "Target IP address or domain name to scan",
          required: true
        }
      ],
      examples: [
        {
          request: "GET /scan?target=scanme.nmap.org",
          description: "Perform full deep scan on scanme.nmap.org."
        },
        {
          request: "GET /preview?target=93.184.216.34",
          description: "Perform lightweight preview scan on IP 93.184.216.34"
        }
      ]
    },
    pricing: {
      price_per_call: PRICE_STR,
      payment_protocols: ["x402", "MPP"],
      description: "Deep scan combining multiple public APIs and DNS data to identify open ports, services, and attack vectors with grading and actionable recommendations."
    }
  });
});

// Spend cap middleware
app.use("*", spendCapMiddleware());

// Payment middleware for paid /scan endpoint
app.use(
  paymentMiddleware(
    {
      "GET /scan": paidRouteWithDiscovery(
        PRICE_STR,
        "Deep port scan combining DNS resolution, Shodan-like API, public service banners, with risk scoring and recommendations",
        {
          input: { target: "1.2.3.4 or example.com" },
          inputSchema: {
            type: "object",
            properties: {
              target: { type: "string", description: "Target IP address or hostname to scan" },
            },
            required: ["target"]
          },
        }
      ),
    },
    resourceServer
  )
);

// FREE preview route
app.get("/preview", async (c) => {
  const target = c.req.query("target");
  if (!target || typeof target !== "string" || target.length > 255) {
    return c.json({ error: "Missing or invalid ?target= parameter (max 255 chars)" }, 400);
  }

  const start = performance.now();
  try {
    const result = await previewPortScan(target.trim());
    if ("error" in result) {
      return c.json({ error: result.error }, 400);
    }

    const duration_ms = Math.round(performance.now() - start);
    return c.json({ status: "ok", data: result, meta: { timestamp: new Date().toISOString(), duration_ms, api_version: "1.0.0" } });
  } catch (e: any) {
    const msg = e instanceof Error ? e.message : String(e);
    const status = /timeout|timed out|abort/i.test(msg) ? 504 : 502;
    return c.json({ error: "Analysis temporarily unavailable", detail: msg }, status);
  }
});

// Paid deep scan endpoint
app.get("/scan", async (c) => {
  const target = c.req.query("target");
  if (!target || typeof target !== "string" || target.length > 255) {
    return c.json({ error: "Missing or invalid ?target= parameter (max 255 chars)" }, 400);
  }

  const start = performance.now();
  try {
    const result = await deepPortScan(target.trim());
    if ("error" in result) {
      return c.json({ error: result.error }, 400);
    }

    const duration_ms = Math.round(performance.now() - start);
    return c.json({ status: "ok", data: result, meta: { timestamp: new Date().toISOString(), duration_ms, api_version: "1.0.0" } });
  } catch (e: any) {
    const msg = e instanceof Error ? e.message : String(e);
    const status = /timeout|timed out|abort/i.test(msg) ? 504 : 502;
    return c.json({ error: "Analysis temporarily unavailable", detail: msg }, status);
  }
});

// Error handler - passthrough 402 exceptions
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
