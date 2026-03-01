import { Hono } from "hono";
import { cors } from "hono/cors";
import { bearerAuth } from "hono/bearer-auth";
import { resolve, join } from "path";
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
if (DASHBOARD_TOKEN.length < 32) {
  console.error("FATAL: DASHBOARD_TOKEN must be at least 32 characters (use: openssl rand -hex 24)");
  process.exit(1);
}

// Rate limit for public routes (higher limit, still bounded)
const publicLimit = rateLimit("dashboard-public", 120, 60_000);

// Health check — no rate limit, must work from localhost monitoring
app.get("/health", (c) => c.json({ status: "ok" }));

// Serve discovery files at root (Caddy proxies apimesh.xyz to dashboard)
app.get("/llms.txt", publicLimit, async (c) => {
  const file = Bun.file("public/llms.txt");
  if (await file.exists()) return c.text(await file.text());
  return c.text("# apimesh.xyz\nNo llms.txt generated yet.\n", 404);
});

app.get("/.well-known/*", publicLimit, async (c) => {
  // Path traversal protection: resolve and validate containment
  const baseDir = resolve("public/.well-known");
  const decoded = decodeURIComponent(c.req.path);
  const filePath = resolve(join("public", decoded));

  if (!filePath.startsWith(baseDir + "/") && filePath !== baseDir) {
    return c.json({ error: "Not found" }, 404);
  }

  const file = Bun.file(filePath);
  if (await file.exists()) {
    const ext = filePath.split(".").pop();
    const ct = ext === "json" ? "application/json" : "text/plain";
    return c.text(await file.text(), 200, { "Content-Type": ct });
  }
  return c.json({ error: "Not found" }, 404);
});

// CORS before rate limiter so 429 responses include CORS headers
app.use("*", cors({
  origin: process.env.CORS_ORIGIN || "https://apimesh.xyz",
  allowMethods: ["GET"],
  allowHeaders: ["Authorization", "Content-Type"],
}));

// Rate limit all other requests — 30/min per IP (brute force protection)
app.use("*", rateLimit("dashboard", 30, 60_000));
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
