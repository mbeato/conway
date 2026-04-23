import { Hono } from "hono";
import { cors } from "hono/cors";
import { paymentMiddleware, paidRouteWithDiscovery, resourceServer } from "../../shared/x402";
import { apiLogger } from "../../shared/logger";
import { extractPayerWallet } from "../../shared/x402-wallet";
import { spendCapMiddleware } from "../../shared/spend-cap";
import { rateLimit } from "../../shared/rate-limit";
import { safeFetch, validateExternalUrl } from "../../shared/ssrf";
import {
  aggregateSslTlsData,
  SSLTlsInceptionScoreResponse,
  PreviewResponse,
} from "./analyzer";

const app = new Hono();
const API_NAME = "ssl-tls-inception-score";
const PORT = Number(process.env.PORT) || 3001;
const PRICE = "$0.01"; // Comprehensive audit
const PRICE_NUMBER = 0.01;

// Middleware order per spec
// 1. CORS open to all origins
app.use("*", cors({
  origin: "*",
  allowMethods: ["GET"],
  allowHeaders: ["Content-Type", "X-PAYMENT", "payment-signature"],
}));

// 2. /health endpoint before rate limiting
app.get("/health", (c) => c.json({ status: "ok" }));

// 3. Rate limiting
app.use("/check", rateLimit("ssl-tls-inception-score-check", 15, 60_000));
app.use("*", rateLimit("ssl-tls-inception-score", 90, 60_000));

// 4. Extract payer wallet
app.use("*", extractPayerWallet());

// 5. API Logger with price as number
app.use("*", apiLogger(API_NAME, PRICE_NUMBER));

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
          description: "Comprehensive SSL/TLS certificate and protocol audit for the specified hostname or URL",
          parameters: [
            {
              name: "hostname",
              in: "query",
              required: true,
              description: "Hostname or URL (http(s):// or plain hostname) to analyze SSL/TLS for",
            },
          ],
          exampleResponse: {
            status: "ok",
            data: {
              hostname: "example.com",
              certificate: {
                valid: true,
                subject: "CN=example.com",
                issuer: "Let's Encrypt Authority X3",
                validFrom: "2023-01-01T00:00:00.000Z",
                validTo: "2023-04-01T00:00:00.000Z",
                expiryDays: 90,
                signatureAlgorithm: "sha256WithRSAEncryption",
                strengthScore: 90
              },
              protocolsSupported: ["TLSv1.2", "TLSv1.3"],
              ciphersSupported: ["ECDHE-RSA-AES128-GCM-SHA256", "AES256-GCM-SHA384"],
              vulnerabilities: {
                heartbleed: false,
                poodle: false,
                fallbackSCSV: true,
                sweet32: false
              },
              overallScore: 93,
              grade: "A",
              recommendations: [
                {
                  issue: "Certificate expiry in <60 days",
                  severity: 70,
                  suggestion: "Renew your SSL certificate before expiry to avoid service disruption."
                }
              ],
              explanation: "The certificate is valid and uses strong algorithms. TLS 1.2 and 1.3 are supported with strong cipher suites. No critical vulnerabilities detected."
            },
            meta: {
              timestamp: "2024-01-01T00:00:00.000Z",
              duration_ms: 2000,
              api_version: "1.0.0"
            }
          }
        },
        {
          method: "GET",
          path: "/preview",
          description: "Quick preview of SSL/TLS certificate validity and protocol support",
          parameters: [
            {
              name: "hostname",
              in: "query",
              required: true,
              description: "Hostname or URL to preview SSL/TLS info for",
            },
          ],
          exampleResponse: {
            status: "ok",
            data: {
              hostname: "example.com",
              certificateValid: true,
              protocolsSupported: ["TLSv1.2"],
              score: 85,
              grade: "B",
              explanation: "Basic SSL/TLS info fetched successfully, no deep analysis provided in preview."
            },
            meta: {
              timestamp: "2024-01-01T00:00:00.000Z",
              duration_ms: 1000,
              api_version: "1.0.0"
            }
          }
        }
      ],
      parameters: [
        {
          name: "hostname",
          description: "The hostname or full URL (http(s)://...) to analyze",
          type: "string",
          required: true
        }
      ],
      examples: [
        "GET /check?hostname=https://example.com",
        "GET /preview?hostname=example.com"
      ]
    },
    pricing: {
      check: PRICE
    }
  });
});

// 7. Spend cap middleware
app.use("*", spendCapMiddleware());

// 8. Payment middleware with paid route config
app.use(
  "*",
  paymentMiddleware(
    {
      "GET /check": paidRouteWithDiscovery(
        PRICE,
        "Comprehensive SSL/TLS analysis with certificate detail, cipher support, vulnerabilities and scoring",
        {
          input: { hostname: "example.com" },
          inputSchema: {
            type: "object",
            properties: {
              hostname: {
                type: "string",
                description: "Hostname or full URL to analyze SSL/TLS for",
              },
            },
            required: ["hostname"],
          },
        }
      ),
    },
    resourceServer
  )
);

// 9a. Free preview endpoint for basic quick info (larger timeout 20s)
app.get("/preview", rateLimit("ssl-tls-inception-score-preview", 20, 60_000), async (c) => {
  const rawHostname = c.req.query("hostname");
  if (!rawHostname || typeof rawHostname !== "string") {
    return c.json({ error: "Missing ?hostname= parameter (hostname or URL)" }, 400);
  }
  if (rawHostname.length > 255) {
    return c.json({ error: "Hostname parameter too long" }, 400);
  }

  try {
    const result = await aggregateSslTlsData(rawHostname.trim(), true); // preview mode
    if ("error" in result) {
      return c.json({ error: result.error }, 400);
    }
    return c.json(result);
  } catch (e: unknown) {
    console.error(`[${new Date().toISOString()}] ${API_NAME} preview error:`, e);
    const msg = e instanceof Error ? e.message : String(e);
    const status = /timeout|timed out|abort/i.test(msg) ? 504 : 502;
    return c.json({ error: "Analysis temporarily unavailable", detail: msg }, status);
  }
});

// 9b. Paid full check endpoint (10s timeout)
app.get("/check", async (c) => {
  const rawHostname = c.req.query("hostname");
  if (!rawHostname || typeof rawHostname !== "string") {
    return c.json({ error: "Missing ?hostname= parameter (hostname or URL)" }, 400);
  }
  if (rawHostname.length > 255) {
    return c.json({ error: "Hostname parameter too long" }, 400);
  }

  try {
    const result = await aggregateSslTlsData(rawHostname.trim(), false); // full mode
    if ("error" in result) {
      return c.json({ error: result.error }, 400);
    }
    return c.json(result);
  } catch (e: unknown) {
    console.error(`[${new Date().toISOString()}] ${API_NAME} check error:`, e);
    const msg = e instanceof Error ? e.message : String(e);
    const status = /timeout|timed out|abort/i.test(msg) ? 504 : 502;
    return c.json({ error: "Analysis temporarily unavailable", detail: msg }, status);
  }
});

// 10. Custom onError handler
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
