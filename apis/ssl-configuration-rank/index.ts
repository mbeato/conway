import { Hono } from "hono";
import { cors } from "hono/cors";
import { validateExternalUrl, safeFetch } from "../../shared/ssrf";
import { paymentMiddleware, paidRouteWithDiscovery, resourceServer } from "../../shared/x402";
import { apiLogger } from "../../shared/logger";
import { extractPayerWallet } from "../../shared/x402-wallet";
import { spendCapMiddleware } from "../../shared/spend-cap";
import { rateLimit } from "../../shared/rate-limit";
import { analyzeSslConfigFull, analyzeSslConfigPreview, SslAnalysisResult, SslPreviewResult } from "./analyzer";

const app = new Hono();
const API_NAME = "ssl-configuration-rank";
const PORT = Number(process.env.PORT) || 3001;
const PRICE = "$0.01";
const PRICE_NUM = 0.01;

// 1. CORS open to all origins with appropriate headers
app.use("*", cors({
  origin: "*",
  allowMethods: ["GET"],
  allowHeaders: ["Content-Type", "X-PAYMENT", "payment-signature"],
}));

// 2. Health endpoint before rate limiter
app.get("/health", (c) => c.json({ status: "ok" }));

// 3. Rate limits
app.use("/check", rateLimit("ssl-config-rank-check", 30, 60_000));
app.use("*", rateLimit("ssl-config-rank", 90, 60_000));

// 4. Extract payer wallet
app.use("*", extractPayerWallet());

// 5. API Logger with price
app.use("*", apiLogger(API_NAME, PRICE_NUM));

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
          description: "Aggregate SSL/TLS configuration and certificate transparency logs to produce a comprehensive security report",
          parameters: [
            { name: "hostname", required: true, description: "Host domain name to analyze (e.g. example.com)" },
            { name: "protocols", required: false, description: "Optional protocols filter (comma separated)" }
          ],
          exampleResponse: {
            status: "ok",
            data: {
              hostname: "example.com",
              sslScore: 87,
              grade: "B+",
              supportedProtocols: ["TLS 1.2", "TLS 1.3"],
              weakCiphers: ["RC4-SHA"],
              vulnerabilities: [
                { name: "Heartbleed", severity: "high", details: "Not vulnerable" },
                { name: "POODLE", severity: "medium", details: "Not vulnerable" }
              ],
              certInfo: {
                issuer: "Let's Encrypt Authority X3",
                validFrom: "2023-04-01T00:00:00Z",
                validTo: "2023-07-01T00:00:00Z",
                signatureAlgorithm: "SHA256 with RSA Encryption",
                isExpired: false
              },
              recommendations: [
                { issue: "Use stronger cipher suites", severity: "medium", suggestion: "Disable RC4 ciphers in server" },
                { issue: "Enable TLS 1.3", severity: "low", suggestion: "Upgrade server to support TLS 1.3 for improved security" }
              ],
              details: "The server supports TLS 1.2 and TLS 1.3 with some weak cipher suites present. Certificate is valid and trusted."
            },
            meta: {
              timestamp: "2024-01-01T12:00:00Z",
              duration_ms: 2300,
              api_version: "1.0.0"
            }
          }
        },
        {
          method: "GET",
          path: "/preview",
          description: "Quick preview of SSL/TLS protocols and certificate expiration for a hostname",
          parameters: [
            { name: "hostname", required: true, description: "Host domain name to preview (e.g. example.com)" }
          ],
          exampleResponse: {
            status: "ok",
            data: {
              hostname: "example.com",
              supportedProtocols: ["TLS 1.2", "TLS 1.3"],
              certValid: true,
              certExpiresInDays: 45,
              recommendations: ["Consider enabling TLS 1.3 for better security and performance"],
              details: "Certificate is valid, expiring in 45 days. Protocols TLS 1.2 and TLS 1.3 supported."
            },
            meta: {
              timestamp: "2024-01-01T12:00:00Z",
              duration_ms: 1500,
              api_version: "1.0.0"
            }
          }
        }
      ],
      parameters: [
        { name: "hostname", type: "string", description: "Domain name to analyze, must be valid and public" },
        { name: "protocols", type: "string", description: "Optional comma-separated protocols to filter (e.g. TLS1.2,TLS1.3)" }
      ],
      examples: [
        "/check?hostname=example.com",
        "/check?hostname=example.com&protocols=TLS1.2",
        "/preview?hostname=example.com"
      ]
    },
    pricing: {
      pricePerCall: PRICE,
      description: "Comprehensive SSL/TLS configuration audit including public scan aggregation, certificate transparency analysis, grading, and recommendations.",
      paymentProtocols: ["x402", "MPP"]
    }
  });
});

// 7. Free preview endpoint BEFORE paymentMiddleware
app.get("/preview", rateLimit("ssl-config-rank-preview", 20, 60_000), async (c) => {
  const hostnameRaw = c.req.query("hostname");
  if (!hostnameRaw || typeof hostnameRaw !== "string") {
    return c.json({ error: "Missing or invalid ?hostname= parameter" }, 400);
  }
  if (hostnameRaw.length > 255) {
    return c.json({ error: "Hostname exceeds maximum length" }, 400);
  }

  try {
    // Run preview-level analysis with 20s timeout
    const result = await analyzeSslConfigPreview(hostnameRaw.trim());
    return c.json({
      status: "ok",
      data: result,
      meta: {
        timestamp: new Date().toISOString(),
        duration_ms: result._duration_ms,
        api_version: "1.0.0"
      }
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    const status = /timeout|timed out|abort/i.test(msg) ? 504 : 502;
    return c.json({ error: "Analysis temporarily unavailable", detail: msg, meta: { timestamp: new Date().toISOString(), duration_ms: 0, api_version: "1.0.0" } }, status);
  }
});

// 8. Spend cap middleware
app.use("*", spendCapMiddleware());

// 9. Payment middleware with paidRouteWithDiscovery
app.use(
  "*",
  paymentMiddleware(
    {
      "GET /check": paidRouteWithDiscovery(
        PRICE,
        "Comprehensive SSL/TLS configuration audit aggregating scan data, DNS, and certificate transparency logs with scoring and recommendations",
        {
          input: { hostname: "example.com", protocols: "TLS1.2,TLS1.3" },
          inputSchema: {
            type: "object",
            properties: {
              hostname: { type: "string", description: "Domain name to analyze" },
              protocols: { type: "string", description: "Optional comma-separated list of protocols to filter" }
            },
            required: ["hostname"]
          }
        }
      ),
    },
    resourceServer
  )
);

// 10. Paid /check endpoint
app.get("/check", async (c) => {
  const hostnameRaw = c.req.query("hostname");
  if (!hostnameRaw || typeof hostnameRaw !== "string") {
    return c.json({ error: "Missing or invalid ?hostname= parameter" }, 400);
  }
  if (hostnameRaw.length > 255) {
    return c.json({ error: "Hostname exceeds maximum length" }, 400);
  }

  const protocolsRaw = c.req.query("protocols");
  let protocols: string[] | undefined;
  if (protocolsRaw && typeof protocolsRaw === "string") {
    protocols = protocolsRaw.split(",").map((p) => p.trim()).filter(Boolean);
  }

  try {
    const start = performance.now();
    const result = await analyzeSslConfigFull(hostnameRaw.trim(), protocols);
    const duration_ms = Math.round(performance.now() - start);

    // Attach meta info
    return c.json({ status: "ok", data: result, meta: { timestamp: new Date().toISOString(), duration_ms, api_version: "1.0.0" } });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    const status = /timeout|timed out|abort/i.test(msg) ? 504 : 502;
    return c.json({ error: "Analysis temporarily unavailable", detail: msg, meta: { timestamp: new Date().toISOString(), duration_ms: 0, api_version: "1.0.0" } }, status);
  }
});

// 11. Error handling - pass through HTTPExceptions from payment middleware (like 402)
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
