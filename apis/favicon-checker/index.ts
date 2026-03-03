import { Hono } from "hono";
import { cors } from "hono/cors";
import { paymentMiddleware, paidRouteWithDiscovery, resourceServer } from "../../shared/x402";
import { apiLogger } from "../../shared/logger";
import { extractPayerWallet } from "../../shared/x402-wallet";
import { spendCapMiddleware } from "../../shared/spend-cap";
import { rateLimit } from "../../shared/rate-limit";
import { checkFavicon } from "./checker";
import { validateExternalUrl } from "../../shared/ssrf";

const app = new Hono();
const API_NAME = "favicon-checker";
const PORT = Number(process.env.PORT) || 3001;

app.use("*", cors({
  origin: "*",
  allowMethods: ["GET"],
  allowHeaders: ["Content-Type", "X-PAYMENT", "payment-signature"],
}));

// Health check — should be before rate limiter
app.get("/health", (c) => c.json({ status: "ok" }));

// /check: 10 req/min/IP (favicon pulls), with 60/min global after
app.use("/check", rateLimit("favicon-checker-check", 10, 60_000));
app.use("*", rateLimit("favicon-checker", 60, 60_000));
app.use("*", extractPayerWallet());
app.use("*", apiLogger(API_NAME, 0.002));

// Info endpoint — open price and docs
app.get("/", (c) => {
  return c.json({
    api: API_NAME,
    status: "healthy",
    docs: "GET /check?url=https://example.com",
    pricing: "$0.002 per /check via x402",
    example: "/check?url=https://bun.sh",
  });
});

// Paid endpoint
app.use("*", spendCapMiddleware());
app.use(
  paymentMiddleware(
    {
      "GET /check": paidRouteWithDiscovery(
        "$0.002",
        "Check if a given website URL has a favicon, returns favicon's existence, URL, and HTTP status.",
        {
          input: { url: "https://example.com" },
          inputSchema: {
            properties: {
              url: { type: "string", description: "URL to check for favicon" },
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
  const rawUrl = c.req.query("url");
  if (!rawUrl) {
    return c.json({ error: "Missing ?url= (http(s)://...)" }, 400);
  }

  const check = validateExternalUrl(rawUrl.trim());
  if ("error" in check) {
    return c.json({ error: check.error }, 400);
  }
  const parsed = check.url;
  parsed.hash = "";
  parsed.search = "";

  try {
    const result = await checkFavicon(parsed.origin);
    return c.json(result);
  } catch (e: any) {
    if (typeof e === "object" && e && "getResponse" in e) {
      // Hono HTTPException (for e.g. PaymentRequired)
      //@ts-ignore
      return e.getResponse();
    }
    console.error(`[${new Date().toISOString()}] favicon-checker error:`, e);
    return c.json({ error: "Internal server error" }, 500);
  }
});

app.onError((err, c) => {
  if ("getResponse" in err) return (err as any).getResponse();
  console.error(`[${new Date().toISOString()}] favicon-checker error:`, err);
  return c.json({ error: "Internal server error" }, 500);
});

app.notFound((c) => c.json({ error: "Not found" }, 404));

export { app };

if (import.meta.main) console.log(`favicon-checker listening on port ${PORT}`);

export default {
  port: PORT,
  hostname: "127.0.0.1",
  fetch: app.fetch,
};
