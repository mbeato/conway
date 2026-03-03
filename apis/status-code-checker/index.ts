import { Hono } from "hono";
import { cors } from "hono/cors";
import { paymentMiddleware, paidRouteWithDiscovery, resourceServer } from "../../shared/x402";
import { apiLogger } from "../../shared/logger";
import { extractPayerWallet } from "../../shared/x402-wallet";
import { spendCapMiddleware } from "../../shared/spend-cap";
import { rateLimit } from "../../shared/rate-limit";
import { checkStatusCode } from "./status-checker";
import { validateExternalUrl } from "../../shared/ssrf";

const app = new Hono();
const API_NAME = "status-code-checker";
const PORT = Number(process.env.PORT) || 3001;
const PRICING = "$0.001";

app.use("*", cors({
  origin: "*",
  allowMethods: ["GET"],
  allowHeaders: ["Content-Type", "X-PAYMENT", "payment-signature"],
}));

// Health endpoint (before rate limiter)
app.get("/health", c => c.json({ status: "ok" }));

// Specific rate limit for /check (bot/burst containment)
app.use("/check", rateLimit("status-code-checker-check", 30, 60_000)); // 30/min on /check
app.use("*", rateLimit("status-code-checker-global", 180, 60_000)); // 180/min all others
app.use("*", extractPayerWallet());
app.use("*", apiLogger(API_NAME, 0.001));

// Info endpoint (after rate limiter)
app.get("/", (c) => {
  return c.json({
    api: API_NAME,
    status: "healthy",
    docs: "GET /check?url=https://site.com",
    pricing: `${PRICING} per check via x402`,
    subdomain: "status-code-checker.apimesh.xyz",
    description: "Checks the status code of any valid URL, returning accessibility and HTTP response info.",
    params: { url: "The URL to check. Required. Must include https:// or http://." },
    example: "/check?url=https://apimesh.xyz"
  });
});

app.use("*", spendCapMiddleware());
app.use(
  paymentMiddleware(
    {
      "GET /check": paidRouteWithDiscovery(
        PRICING,
        "Checks the HTTP status code of a given URL, returning accessibility and metadata.",
        {
          input: { url: "https://example.com" },
          inputSchema: {
            properties: {
              url: { type: "string", description: "URL to check" },
            },
            required: ["url"],
          },
        }
      ),
    },
    resourceServer
  )
);

app.get("/check", async (c) => {
  const url = c.req.query("url");
  if (!url || typeof url !== "string" || url.length > 512) {
    return c.json({ error: "Provide ?url= parameter (2-512 chars)" }, 400);
  }

  const check = validateExternalUrl(url);
  if ("error" in check) {
    return c.json({ error: check.error }, 400);
  }
  const parsedUrl = check.url;

  const result = await checkStatusCode(parsedUrl.toString());
  return c.json(result);
});

app.onError((err, c) => {
  // Allow Hono HTTPExceptions (402, 429, etc) to pass
  if ("getResponse" in err) return (err as any).getResponse();
  console.error(`[${new Date().toISOString()}] ${API_NAME} error:`, err);
  return c.json({ error: "Internal server error" }, 500);
});

app.notFound((c) => c.json({ error: "Not found" }, 404));

export { app };

if (import.meta.main) {
  console.log(`${API_NAME} listening on port ${PORT}`);
}

export default {
  port: PORT,
  hostname: "127.0.0.1",
  fetch: app.fetch,
};
