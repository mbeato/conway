import type { MiddlewareHandler } from "hono";

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Map<string, RateLimitEntry>>();

// Periodic cleanup of expired entries to prevent memory leaks
setInterval(() => {
  const now = Date.now();
  for (const [zone, entries] of buckets) {
    for (const [ip, entry] of entries) {
      if (now > entry.resetAt) entries.delete(ip);
    }
    if (entries.size === 0) buckets.delete(zone);
  }
}, 60_000);

const IP_PATTERN = /^(\d{1,3}\.){3}\d{1,3}$|^[0-9a-fA-F:]{2,39}$/;
const MAX_TRACKED_IPS = 10_000;

export function rateLimit(
  zone: string,
  maxRequests: number,
  windowMs: number
): MiddlewareHandler {
  if (!buckets.has(zone)) buckets.set(zone, new Map());
  const entries = buckets.get(zone)!;

  return async (c, next) => {
    const ip = c.req.header("x-real-ip");
    if (!ip || !IP_PATTERN.test(ip)) {
      // No trusted proxy header or invalid format — didn't come through Caddy
      return c.json({ error: "Direct access not allowed" }, 403);
    }
    const now = Date.now();
    const entry = entries.get(ip);

    if (!entry || now > entry.resetAt) {
      // Cap tracked IPs per zone to prevent memory exhaustion
      if (!entry && entries.size >= MAX_TRACKED_IPS) {
        return c.json({ error: "Rate limit exceeded" }, 429);
      }
      entries.set(ip, { count: 1, resetAt: now + windowMs });
      c.header("X-RateLimit-Limit", String(maxRequests));
      c.header("X-RateLimit-Remaining", String(maxRequests - 1));
      return next();
    }

    if (entry.count >= maxRequests) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      c.header("Retry-After", String(retryAfter));
      c.header("X-RateLimit-Limit", String(maxRequests));
      c.header("X-RateLimit-Remaining", "0");
      return c.json({ error: "Rate limit exceeded" }, 429);
    }

    entry.count++;
    c.header("X-RateLimit-Limit", String(maxRequests));
    c.header("X-RateLimit-Remaining", String(maxRequests - entry.count));
    return next();
  };
}
