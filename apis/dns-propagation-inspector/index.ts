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
import { validateExternalUrl } from "../../shared/ssrf";
import {
  detailedDnsPropagationCheck,
  previewDnsPropagationCheck,
  DnsPropagationResult,
  DnsPropagationPreviewResult,
} from "./analyzer";

const app = new Hono();
const API_NAME = "dns-propagation-inspector";
const PORT = Number(process.env.PORT) || 3001;
const PRICE = "$0.01"; // Comprehensive audit tier
const PRICE_NUM = 0.01;
const API_VERSION = "1.0.0";

// Middleware chain order strictly followed

// 1. CORS — open to all origins with standard headers
app.use("*",
  cors({
    origin: "*",
    allowMethods: ["GET"],
    allowHeaders: ["Content-Type", "X-PAYMENT", "payment-signature"],
  })
);

// 2. /health before rate limiting
app.get("/health", (c) => c.json({ status: "ok" }));

// 3. Rate limiting
// Rate limit preview requests: 20 per minute
app.use("/preview", rateLimit("dns-propagation-inspector-preview", 20, 60_000));
// Rate limit main endpoint: 60 per minute
app.use("/check", rateLimit("dns-propagation-inspector-check", 60, 60_000));
// Global rate limit: 120 per minute
app.use("*", rateLimit("dns-propagation-inspector-global", 120, 60_000));

// 4. Extract payer wallet for payment attribution
app.use("*", extractPayerWallet());

// 5. API logger middleware with exact price number
app.use("*", apiLogger(API_NAME, PRICE_NUM));

// 6. Info endpoint before spend cap and payment middleware
app.get("/", (c) => {
  const docs = {
    endpoints: [
      {
        path: "/",
        method: "GET",
        description: "API info and documentation",
        parameters: [],
        exampleResponse: {
          api: API_NAME,
          status: "healthy",
          version: API_VERSION,
          docs,
          pricing: PRICE,
        },
      },
      {
        path: "/preview",
        method: "GET",
        description: "Free preview endpoint - quick DNS propagation summary across global resolvers",
        parameters: [
          {
            name: "domain",
            type: "string",
            description: "Domain name to check DNS propagation for",
            required: true,
          },
          {
            name: "recordType",
            type: "string",
            description: "DNS record type to query, e.g., A, AAAA, CNAME, TXT",
            required: true,
          },
        ],
        exampleResponse: {
          status: "ok",
          data: {
            domain: "example.com",
            recordType: "A",
            checkedAt: "2024-04-27T12:34:56Z",
            propagationSummary: {
              "8.8.8.8": ["93.184.216.34"],
              "1.1.1.1": ["93.184.216.34"],
              "9.9.9.9": ["93.184.216.34"],
            },
            averagePropagationDelaySec: 42,
            errors: [],
          },
          meta: {
            timestamp: "2024-04-27T12:35:00Z",
            duration_ms: 5800,
            api_version: "1.0.0"
          }
        },
      },
      {
        path: "/check",
        method: "GET",
        description: "Paid comprehensive DNS propagation audit across multiple resolvers with scoring and actionable recommendations",
        parameters: [
          {
            name: "domain",
            type: "string",
            description: "Domain name to audit",
            required: true
          },
          {
            name: "recordType",
            type: "string",
            description: "DNS record type to query",
            required: true
          },
        ],
        exampleResponse: {
          status: "ok",
          data: {
            domain: "example.com",
            recordType: "A",
            checkedAt: "2024-04-27T12:34:56Z",
            propagationDetails: [
              {
                resolver: "8.8.8.8",
                records: ["93.184.216.34"],
                responseTimeMs: 320,
                error: null
              },
              {
                resolver: "1.1.1.1",
                records: ["93.184.216.34"],
                responseTimeMs: 350,
                error: null
              }
            ],
            overallScore: 95,
            grade: "A",
            recommendations: [
              {
                issue: "Propagation delay on 4.2.2.2 resolver",
                severity: 40,
                suggestion: "Verify TTL settings or DNS server response on 4.2.2.2 to reduce latency."
              }
            ],
            explanation: "Most global resolvers reflect the latest DNS record with low propagation delays."
          },
          meta: {
            timestamp: "2024-04-27T12:35:30Z",
            duration_ms: 15800,
            api_version: "1.0.0"
          }
        },
      },
    ],
    parameters: [
      {
        name: "domain",
        type: "string",
        description: "Domain name to query DNS records for",
      },
      {
        name: "recordType",
        type: "string",
        description: "DNS record type such as A, AAAA, CNAME, TXT, MX",
      },
    ],
    examples: [
      {
        usage: "Preview DNS propagation for A records",
        request: "GET /preview?domain=example.com&recordType=A",
        response: "..."
      },
      {
        usage: "Paid full DNS propagation audit",
        request: "GET /check?domain=example.com&recordType=TXT",
        response: "..."
      }
    ]
  };

  return c.json({
    api: API_NAME,
    status: "healthy",
    version: API_VERSION,
    docs,
    pricing: {
      preview: "Free",
      paidEndpoint: PRICE,
      description: "Comprehensive DNS propagation audit combining multiple resolver checks, scoring, and actionable remediation suggestions",
    },
  });
});

// 7. Spend cap middleware
app.use("*", spendCapMiddleware());

// 8. Payment middleware with x402 and MPP support, apply to /check
app.use(
  paymentMiddleware(
    {
      "GET /check": paidRouteWithDiscovery(
        PRICE,
        "Comprehensive DNS propagation audit combining multiple global resolvers, detailed scoring, and recommendations",
        {
          input: {
            domain: "example.com",
            recordType: "A",
          },
          inputSchema: {
            type: "object",
            properties: {
              domain: {
                type: "string",
                description: "Domain name to query DNS propagation for",
                pattern: "^(?=.{1,253}$)(?!-)[A-Za-z0-9-]{1,63}(?<!-)" +
                         "(\.[A-Za-z0-9-]{1,63})*$",
              },
              recordType: {
                type: "string",
                description: "DNS record type to query (A, AAAA, CNAME, TXT, MX, NS, etc.)",
                enum: [
                  "A", "AAAA", "CNAME", "TXT", "MX", "NS", "SOA", "PTR", "SRV", "CAA"
                ],
              },
            },
            required: ["domain", "recordType"],
          },
        }
      ),
    },
    resourceServer
  )
);

// 9. Paid endpoint implementation
app.get("/check", async (c) => {
  const domain = c.req.query("domain");
  const recordType = c.req.query("recordType")?.toUpperCase();

  if (!domain || typeof domain !== "string" || domain.length > 253) {
    return c.json({ error: "Missing or invalid ?domain= parameter (max length 253)" }, 400);
  }
  if (!recordType || typeof recordType !== "string") {
    return c.json({ error: "Missing or invalid ?recordType= parameter" }, 400);
  }

  // Validate domain with basic regex
  // Simple authoritative domain name pattern validator
  const domainRegex = /^(?=.{1,253}$)(?!-)[A-Za-z0-9-]{1,63}(?<!-)(\.[A-Za-z0-9-]{1,63})*\.?$/;
  if (!domainRegex.test(domain)) {
    return c.json({ error: "Invalid domain format" }, 400);
  }

  // Validate recordType is in allowed set
  const allowedTypes = new Set<string>(["A", "AAAA", "CNAME", "TXT", "MX", "NS", "SOA", "PTR", "SRV", "CAA"]);
  if (!allowedTypes.has(recordType)) {
    return c.json({ error: "Unsupported recordType. Allowed: A, AAAA, CNAME, TXT, MX, NS, SOA, PTR, SRV, CAA" }, 400);
  }

  try {
    const start = performance.now();
    const result: DnsPropagationResult = await detailedDnsPropagationCheck(domain.trim(), recordType.trim());
    const duration_ms = Math.round(performance.now() - start);

    return c.json({
      status: "ok",
      data: result,
      meta: {
        timestamp: new Date().toISOString(),
        duration_ms,
        api_version: API_VERSION,
      },
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    const status = /timeout|timed out|abort/i.test(msg) ? 504 : 502;
    return c.json({ error: "Analysis temporarily unavailable", detail: msg, meta: { timestamp: new Date().toISOString(), duration_ms: 0, api_version: API_VERSION } }, status);
  }
});

// Free preview endpoint
app.get("/preview", async (c) => {
  const domain = c.req.query("domain");
  const recordType = c.req.query("recordType")?.toUpperCase();

  if (!domain || typeof domain !== "string" || domain.length > 253) {
    return c.json({ error: "Missing or invalid ?domain= parameter (max length 253)" }, 400);
  }
  if (!recordType || typeof recordType !== "string") {
    return c.json({ error: "Missing or invalid ?recordType= parameter" }, 400);
  }

  // Validate domain with basic regex
  const domainRegex = /^(?=.{1,253}$)(?!-)[A-Za-z0-9-]{1,63}(?<!-)(\.[A-Za-z0-9-]{1,63})*\.?$/;
  if (!domainRegex.test(domain)) {
    return c.json({ error: "Invalid domain format" }, 400);
  }

  const allowedTypes = new Set<string>(["A", "AAAA", "CNAME", "TXT", "MX", "NS", "SOA", "PTR", "SRV", "CAA"]);
  if (!allowedTypes.has(recordType)) {
    return c.json({ error: "Unsupported recordType. Allowed: A, AAAA, CNAME, TXT, MX, NS, SOA, PTR, SRV, CAA" }, 400);
  }

  try {
    const start = performance.now();
    const result: DnsPropagationPreviewResult = await previewDnsPropagationCheck(domain.trim(), recordType.trim());
    const duration_ms = Math.round(performance.now() - start);
    return c.json({
      status: "ok",
      data: result,
      meta: {
        timestamp: new Date().toISOString(),
        duration_ms,
        api_version: API_VERSION,
      },
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    const status = /timeout|timed out|abort/i.test(msg) ? 504 : 502;
    return c.json({ error: "Analysis temporarily unavailable", detail: msg, meta: { timestamp: new Date().toISOString(), duration_ms: 0, api_version: API_VERSION } }, status);
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

// Not found handler
app.notFound((c) => c.json({ error: "Not found" }, 404));

export { app };

if (import.meta.main) console.log(`${API_NAME} listening on port ${PORT}`);

export default {
  port: PORT,
  hostname: "127.0.0.1",
  fetch: app.fetch,
};
