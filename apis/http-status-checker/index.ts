import { Hono } from "hono";
import { cors } from "hono/cors";
import { paymentMiddleware, paidRouteWithDiscovery, resourceServer } from "../../shared/x402";
import { apiLogger } from "../../shared/logger";
import { extractPayerWallet } from "../../shared/x402-wallet";
import { spendCapMiddleware } from "../../shared/spend-cap";
import { rateLimit } from "../../shared/rate-limit";
import { checkHttpStatus } from "./http-check";
import { validateExternalUrl } from "../../shared/ssrf";

const app = new Hono();
const API_NAME = "http-status-checker";
const PORT = Number(process.env.PORT) || 3001;
const PRICE = "$0.002"; // $0.002 per check, fair for URL status

app.use("*", cors({
  origin: "*",
  allowMethods: ["GET"],
  allowHeaders: ["Content-Type", "X-PAYMENT", "payment-signature"],
}));

// Health check
app.get("/health", (c) => c.json({ status: "ok" }));

// Rate limiting: 30/min per user for /check, 90/min overall
app.use("/check", rateLimit("http-status-checker-check", 30, 60_000));
app.use("*", rateLimit("http-status-checker", 90, 60_000));
app.use("*", extractPayerWallet());
app.use("*", apiLogger(API_NAME, 0.002));

// Info endpoint
app.get("/", (c) => {
  return c.json({
    api: API_NAME,
    status: "healthy",
    description: "Checks the HTTP status of a given URL to ensure it is accessible and returns the expected response code.",
    docs: "GET /check?url=https://example.com&expected=200",
    pricing: "$0.002 per check via x402",
    example: "/check?url=https://google.com&expected=200"
  });
});

app.use("*", spendCapMiddleware());
app.use(
  paymentMiddleware(
    {
      "GET /check": paidRouteWithDiscovery(
        PRICE,
        "Checks the HTTP status code of a given URL and compares to expected code",
        {
          input: { url: "https://example.com", expected: 200 },
          inputSchema: {
            properties: {
              url: { type: "string" },
              expected: { type: "integer", description: "Expected HTTP status code" },
            },
            required: ["url"],
          },
        }
      ),
    },
    resourceServer
  )
);

// GET /check?url=...&expected=...
app.get("/check", async (c) => {
  const url = c.req.query("url");
  const expected = c.req.query("expected");

  if (!url) {
    return c.json({ error: "Missing required ?url parameter" }, 400);
  }

  const check = validateExternalUrl(url);
  if ("error" in check) {
    return c.json({ error: check.error }, 400);
  }
  const parsedUrl = check.url;

  // Parse expected code, or default to 200
  let expectedCode = 200;
  if (expected !== undefined) {
    const num = Number(expected);
    if (!Number.isInteger(num) || num < 100 || num > 599) {
      return c.json({ error: "Expected must be an integer HTTP status code (100-599)" }, 400);
    }
    expectedCode = num;
  }

  const result = await checkHttpStatus(parsedUrl.toString(), expectedCode);
  return c.json(result, result.ok ? 200 : 400);
});

app.onError((err, c) => {
  if ("getResponse" in err) return (err as any).getResponse();
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
