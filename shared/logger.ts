import type { MiddlewareHandler } from "hono";
import { logRequest } from "./db";

export function apiLogger(apiName: string): MiddlewareHandler {
  return async (c, next) => {
    const start = performance.now();
    await next();
    const ms = performance.now() - start;

    const paid = c.res.headers.get("x-payment-verified") === "true";
    const amount = parseFloat(c.res.headers.get("x-payment-amount") || "0");
    const clientIp =
      c.req.header("x-forwarded-for") ||
      c.req.header("cf-connecting-ip") ||
      "unknown";

    logRequest(apiName, c.req.path, c.req.method, c.res.status, ms, paid, amount, clientIp);
  };
}
