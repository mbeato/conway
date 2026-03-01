import { Hono } from "hono";
import { registry } from "./registry";

const router = new Hono();
const PORT = 3001;

// Router health check (no subdomain needed)
router.get("/health", (c) => {
  const host = c.req.header("host") ?? "";
  const subdomain = extractSubdomain(host);
  // If a subdomain matches a registered API, delegate to it
  if (subdomain && registry[subdomain]) {
    return registry[subdomain].fetch(c.req.raw);
  }
  return c.json({ status: "ok", router: true, apis: Object.keys(registry) });
});

// Catch-all: route by subdomain
router.all("*", async (c) => {
  const host = c.req.header("host") ?? "";
  const subdomain = extractSubdomain(host);

  if (!subdomain) {
    return c.json({ error: "No subdomain specified" }, 404);
  }

  const subApp = registry[subdomain];
  if (!subApp) {
    return c.json({ error: `Unknown API: ${subdomain}` }, 404);
  }

  return subApp.fetch(c.req.raw);
});

function extractSubdomain(host: string): string | null {
  // Remove port if present
  const hostname = host.split(":")[0];
  // Match *.apimesh.xyz
  const match = hostname.match(/^([^.]+)\.apimesh\.xyz$/);
  if (match) return match[1];
  // Local testing only: allow <name>.localhost
  if (hostname.endsWith(".localhost")) return hostname.split(".")[0];
  return null;
}

console.log(`api-router listening on port ${PORT} — serving: ${Object.keys(registry).join(", ")}`);

export default {
  port: PORT,
  hostname: "127.0.0.1",
  fetch: router.fetch,
};
