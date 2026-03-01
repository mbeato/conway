import { Hono } from "hono";
import { cors } from "hono/cors";
import { bearerAuth } from "hono/bearer-auth";
import db, { getRevenueByApi, getTotalRevenue } from "../../shared/db";
import { WALLET_ADDRESS } from "../../shared/x402";
import { rateLimit } from "../../shared/rate-limit";

const app = new Hono();
const PORT = 3000;

const DASHBOARD_TOKEN = process.env.DASHBOARD_TOKEN;
if (!DASHBOARD_TOKEN) {
  console.error("FATAL: DASHBOARD_TOKEN env var not set");
  process.exit(1);
}

// Health check is public — before rate limiter for localhost monitoring
app.get("/health", (c) => c.json({ status: "ok" }));

// Rate limit all other requests — 30/min per IP (brute force protection)
app.use("*", rateLimit("dashboard", 30, 60_000));

// Everything else requires bearer token — restrict CORS to specific origins
app.use("*", cors({
  origin: process.env.CORS_ORIGIN || "https://apimesh.xyz",
  allowMethods: ["GET"],
  allowHeaders: ["Authorization", "Content-Type"],
}));
app.use("*", bearerAuth({ token: DASHBOARD_TOKEN }));

app.get("/", (c) => {
  const revenue7d = getTotalRevenue(7);
  const revenue30d = getTotalRevenue(30);
  const apis = db.query(
    "SELECT name, subdomain, status, created_at FROM api_registry WHERE status = 'active'"
  ).all();
  const revenueByApi = getRevenueByApi(7);

  return c.json({
    status: "operational",
    wallet: WALLET_ADDRESS,
    revenue: {
      last_7_days: revenue7d,
      last_30_days: revenue30d,
      by_api: revenueByApi,
    },
    apis,
    timestamp: new Date().toISOString(),
  });
});

app.onError((err, c) => {
  // Let Hono's HTTPException (e.g. 401 from bearerAuth) pass through
  if ("getResponse" in err) return (err as any).getResponse();
  console.error(`[${new Date().toISOString()}] dashboard error:`, err);
  return c.json({ error: "Internal server error" }, 500);
});

app.notFound((c) => c.json({ error: "Not found" }, 404));

console.log(`dashboard listening on port ${PORT}`);

export default {
  port: PORT,
  hostname: "127.0.0.1",
  fetch: app.fetch,
};
