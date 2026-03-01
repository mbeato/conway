import { Hono } from "hono";
import { cors } from "hono/cors";
import { paymentMiddleware, paidRouteWithDiscovery, resourceServer } from "../../shared/x402";
import { apiLogger } from "../../shared/logger";
import { rateLimit } from "../../shared/rate-limit";
import { checkHttpStatus } from "./http-check";

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
  // Validate the URL
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
    // Only allow http(s)
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      return c.json({ error: "Only http(s) protocols are supported" }, 400);
    }
    // Could also check for IPs here (block 127.0.0.1, private ranges, etc.)
    if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(parsedUrl.hostname)) {
      return c.json({ error: "Local and private addresses are not allowed" }, 400);
    }
  } catch (e) {
    return c.json({ error: "Invalid URL" }, 400);
  }

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
