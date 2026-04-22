import { Database } from "bun:sqlite";
import type { Context, MiddlewareHandler } from "hono";

/**
 * Auth-specific rate limiter — SQLite-backed (survives process restarts).
 * Independent from shared/rate-limit.ts which is in-memory and IP-only.
 */

export interface AuthRateZoneConfig {
  maxRequests: number;
  windowMs: number;
  keyBy: "ip" | "email" | "user";
}

export const AUTH_RATE_ZONES: Record<string, AuthRateZoneConfig> = {
  signup: { maxRequests: 3, windowMs: 3600_000, keyBy: "ip" },
  login: { maxRequests: 10, windowMs: 60_000, keyBy: "ip" },
  "password-reset-ip": { maxRequests: 5, windowMs: 3600_000, keyBy: "ip" },
  "password-reset-email": { maxRequests: 3, windowMs: 3600_000, keyBy: "email" },
  "resend-code-email": { maxRequests: 1, windowMs: 60_000, keyBy: "email" },
  "resend-code-ip": { maxRequests: 5, windowMs: 3600_000, keyBy: "ip" },
  "key-ops": { maxRequests: 10, windowMs: 3600_000, keyBy: "user" },
  "verify-code": { maxRequests: 3, windowMs: 600_000, keyBy: "email" },
};

/**
 * Ensures the auth_rate_limits table exists. Used by tests with :memory: DBs.
 * In production, migration 002 creates this table.
 */
export function ensureAuthRateLimitTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS auth_rate_limits (
      zone TEXT NOT NULL,
      key TEXT NOT NULL,
      count INTEGER DEFAULT 1,
      window_start INTEGER NOT NULL,
      PRIMARY KEY (zone, key)
    );
  `);
}

/**
 * Inline email normalization to avoid circular dependency with validation.ts.
 * The canonical normalizeEmail() lives in shared/validation.ts (Plan 01-02).
 * This is an intentional duplicate for rate limiter keying only.
 */
function normalizeEmailKey(email: string): string {
  return email.trim().toLowerCase();
}

export interface RateLimitResult {
  allowed: boolean;
  retryAfter?: number;
}

/**
 * Check and enforce an auth rate limit.
 * Pure function — no Hono dependency. Caller must pass the appropriate key.
 * For email-keyed zones, caller should pass normalizeEmail(email) or use
 * the normalizeEmailKey helper.
 */
export function checkAuthRateLimit(
  db: Database,
  zone: string,
  key: string
): RateLimitResult {
  const config = AUTH_RATE_ZONES[zone];
  if (!config) {
    throw new Error(`Unknown auth rate limit zone: ${zone}`);
  }

  // Normalize email keys inline
  const effectiveKey = config.keyBy === "email" ? normalizeEmailKey(key) : key;

  const now = Date.now();

  // Check existing entry
  const existing = db
    .query("SELECT count, window_start FROM auth_rate_limits WHERE zone = ? AND key = ?")
    .get(zone, effectiveKey) as { count: number; window_start: number } | null;

  if (!existing) {
    // First request — insert
    db.run(
      "INSERT INTO auth_rate_limits (zone, key, count, window_start) VALUES (?, ?, 1, ?)",
      [zone, effectiveKey, now]
    );
    return { allowed: true };
  }

  const windowEnd = existing.window_start + config.windowMs;

  if (now >= windowEnd) {
    // Window expired — reset
    db.run(
      "UPDATE auth_rate_limits SET count = 1, window_start = ? WHERE zone = ? AND key = ?",
      [now, zone, effectiveKey]
    );
    return { allowed: true };
  }

  if (existing.count >= config.maxRequests) {
    // Over limit
    const retryAfter = Math.ceil((windowEnd - now) / 1000);
    return { allowed: false, retryAfter };
  }

  // Increment
  db.run(
    "UPDATE auth_rate_limits SET count = count + 1 WHERE zone = ? AND key = ?",
    [zone, effectiveKey]
  );
  return { allowed: true };
}

/**
 * Hono middleware wrapper for auth rate limiting.
 * keyExtractor pulls the rate limit key (IP, email, user ID) from the request context.
 */
export function authRateLimitMiddleware(
  zone: string,
  keyExtractor: (c: Context) => string
): MiddlewareHandler {
  return async (c, next) => {
    const db = c.get("db") as Database;
    const key = keyExtractor(c);
    const result = checkAuthRateLimit(db, zone, key);

    if (!result.allowed) {
      c.header("Retry-After", String(result.retryAfter));
      return c.json({ error: "Rate limit exceeded" }, 429);
    }

    return next();
  };
}

/**
 * Clean up expired rate limit entries.
 * Called probabilistically (1 in 20 requests) or via periodic cleanup.
 */
export function cleanupExpiredEntries(db: Database): void {
  const now = Date.now();
  for (const [zone, config] of Object.entries(AUTH_RATE_ZONES)) {
    db.run(
      "DELETE FROM auth_rate_limits WHERE zone = ? AND (window_start + ?) < ?",
      [zone, config.windowMs, now]
    );
  }
}
