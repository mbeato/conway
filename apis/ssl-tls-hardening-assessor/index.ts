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
  safeFetch,
  validateExternalUrl,
} from "../../shared/ssrf";
import {
  analyzeSslTls,
  analyzeDnsRecords,
  combineAnalysisResults,
  SslTlsAssessmentResult,
  DnsRecordsResult,
  FullAssessmentResult,
} from "./analyzer";

const app = new Hono();
const API_NAME = "ssl-tls-hardening-assessor";
const PORT = Number(process.env.PORT) || 3001;

/**
 * Comprehensive audit price tier: 5+ checks, scoring, detailed report
 * $0.01 per call
 */
const PRICE_STR = "$0.01";
const PRICE_NUM = 0.01;

// CORS first
app.use("*",
  cors({
    origin: "*",
    allowMethods: ["GET"],
    allowHeaders: ["Content-Type", "X-PAYMENT", "payment-signature"],
  })
);

// Health endpoint before rate limiting
app.get("/health", (c) => c.json({ status: "ok" }));

// Rate limits
// We allow 20 calls per minute per IP for paid and 10 for preview
app.use("/check", rateLimit("ssl-tls-hardening-assessor-check", 20, 60_000));
app.use("/preview", rateLimit("ssl-tls-hardening-assessor-preview", 10, 60_000));
app.use("*", rateLimit("ssl-tls-hardening-assessor", 60, 60_000));

// Extract payer wallet and log API calls
app.use("*", extractPayerWallet());
app.use("*", apiLogger(API_NAME, PRICE_NUM));

// Info endpoint
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
          description: "Get a comprehensive SSL/TLS and DNS record security assessment for a hostname",
          parameters: [
            {
              name: "host",
              description: "Hostname to analyze, e.g. example.com",
              type: "string",
              required: true,
            },
          ],
          exampleResponse: {
            status: "ok",
            data: {
              hostname: "example.com",
              sslTls: {},
              dns: {},
              combinedScore: 91.3,
              grade: "A",
              recommendations: [
                {
                  issue: "Weak TLS protocol enabled",
                  severity: 70,
                  suggestion: "Disable TLS 1.0 and 1.1",
                },
              ],
              explanation: "The site has overall strong SSL/TLS configuration with minor issues."
            },
            meta: {
              timestamp: "2024-01-01T07:30:00.000Z",
              duration_ms: 1850,
              api_version: "1.0.0"
            }
          }
        },
        {
          method: "GET",
          path: "/preview",
          description: "Free preview of SSL and TLS protocol support with minimal analysis",
          parameters: [
            {
              name: "host",
              description: "Hostname to analyze",
              type: "string",
              required: true
            }
          ],
          exampleResponse: {
            status: "ok",
            data: {
              hostname: "example.com",
              sslSummary: {
                valid: true,
                expiryDays: 60,
                validProtocols: ["TLS 1.2", "TLS 1.3"],
                recommendation: "Renew SSL cert within 30 days if not renewed yet."
              },
              timestamp: "2024-01-01T07:25:00.000Z"
            },
            meta: {
              timestamp: "2024-01-01T07:25:00.000Z",
              duration_ms: 1200,
              api_version: "1.0.0"
            }
          },
        },
      ],
      parameters: [
        {
          name: "host",
          description: "Hostname to analyze (required)",
          type: "string",
          example: "example.com"
        }
      ],
      examples: [
        {
          description: "Full Assessment",
          request: "GET /check?host=example.com",
          responseStatus: 200
        },
        {
          description: "Preview (Free)",
          request: "GET /preview?host=example.com",
          responseStatus: 200
        }
      ]
    },
    pricing: {
      "GET /check": PRICE_STR
    }
  })
);

// Free preview endpoint with longer timeout (20 seconds)
app.get("/preview", async (c) => {
  const rawHost = c.req.query("host");
  if (!rawHost || typeof rawHost !== "string") {
    return c.json({ error: "Missing ?host= parameter (hostname)" }, 400);
  }
  if (rawHost.length > 253) {
    return c.json({ error: "Hostname exceeds maximum length" }, 400);
  }

  const host = rawHost.trim().toLowerCase();

  try {
    const result = await analyzeSslTls(host, { timeoutMs: 20_000, lightweight: true });
    return c.json({
      status: "ok",
      data: {
        hostname: host,
        sslSummary: result.sslSummary,
        timestamp: new Date().toISOString(),
      },
      meta: {
        timestamp: new Date().toISOString(),
        duration_ms: result.duration_ms,
        api_version: "1.0.0",
      },
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    const status = /timeout|timed out|abort/i.test(msg) ? 504 : 502;
    return c.json({ error: "Analysis temporarily unavailable", detail: msg }, status);
  }
});

// Paid endpoints middleware
app.use("*", spendCapMiddleware());
app.use(
  paymentMiddleware(
    {
      "GET /check": paidRouteWithDiscovery(
        PRICE_STR,
        "Aggregates SSL certificate details, cipher support, TLS protocols, DNS records from multiple free sources and fully assesses configuration against security best practices with scoring and remediation",
        {
          input: { host: "example.com" },
          inputSchema: {
            type: "object",
            properties: {
              host: {
                type: "string",
                description: "Hostname to assess",
              },
            },
            required: ["host"],
          },
        },
      ),
    },
    resourceServer
  )
);

// Paid comprehensive check
app.get("/check", async (c) => {
  const rawHost = c.req.query("host");
  if (!rawHost || typeof rawHost !== "string") {
    return c.json({ error: "Provide ?host= parameter with hostname to analyze" }, 400);
  }
  if (rawHost.length > 253) {
    return c.json({ error: "Hostname exceeds maximum length" }, 400);
  }

  const host = rawHost.trim().toLowerCase();

  try {
    // Validate host as domain format
    const validateRes = validateExternalUrl(`https://${host}`); // Just reuse helper to parse host
    if ("error" in validateRes) {
      return c.json({ error: "Invalid hostname format" }, 400);
    }

    // Perform multiple parallel fetches and analyses for comprehensive audit
    const abortSignal = AbortSignal.timeout(10_000);

    // Run SSL and TLS checks
    const sslTlsP = analyzeSslTls(host, { signal: abortSignal, lightweight: false });
    // Run DNS record aggregation
    const dnsRecordsP = analyzeDnsRecords(host, abortSignal);

    // Await all in parallel
    const [sslTlsResult, dnsResult] = await Promise.all([sslTlsP, dnsRecordsP]);

    const combinedResult = combineAnalysisResults(host, sslTlsResult, dnsResult);

    return c.json({
      status: "ok",
      data: combinedResult,
      meta: {
        timestamp: new Date().toISOString(),
        duration_ms: combinedResult.duration_ms,
        api_version: "1.0.0",
      },
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    const status = /timeout|timed out|abort/i.test(msg) ? 504 : 502;
    return c.json({ error: "Analysis temporarily unavailable", detail: msg }, status);
  }
});

// Error handler must pass through HTTPException for 402
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
