import type { MiddlewareHandler } from "hono";
import { getWalletSpend, getSpendCap } from "./db";
import { parsePayerWalletFromRequest } from "./x402-wallet";

// Per-wallet in-process lock to prevent TOCTOU race between cap check and settlement.
// Serializes concurrent requests for the same capped wallet so the spend total
// reflects all in-flight settlements before the next check runs.
const walletLocks = new Map<string, Promise<void>>();

function withWalletLock<T>(wallet: string, fn: () => Promise<T>): Promise<T> {
  const prev = walletLocks.get(wallet) ?? Promise.resolve();
  let resolve!: () => void;
  const next = new Promise<void>(r => { resolve = r; });
  walletLocks.set(wallet, next);
  return prev.then(fn).finally(() => {
    resolve();
    if (walletLocks.get(wallet) === next) walletLocks.delete(wallet);
  });
}

/**
 * Spend cap enforcement middleware.
 * Runs BEFORE paymentMiddleware — checks daily/monthly limits pre-settlement.
 * If the wallet exceeds its cap, returns 429 before any payment is attempted.
 * Wallets without a cap are allowed through (uncapped by default).
 */
export function spendCapMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    const paymentHeader = c.req.header("X-PAYMENT") || c.req.header("payment-signature");
    if (!paymentHeader) {
      return next();
    }

    const wallet = parsePayerWalletFromRequest(paymentHeader);
    if (!wallet) {
      return next();
    }

    const cap = getSpendCap(wallet);
    if (!cap) {
      return next();
    }

    // Serialize capped wallet requests to prevent race condition
    return withWalletLock(wallet, async () => {
      const dailySpent = getWalletSpend(wallet, 1);
      const monthlySpent = getWalletSpend(wallet, 30);

      if (cap.daily_limit_usd !== null && dailySpent >= cap.daily_limit_usd) {
        return c.json({
          error: "Spend cap exceeded",
          detail: "Daily spend limit reached",
          daily_spent: dailySpent,
          daily_limit: cap.daily_limit_usd,
          monthly_spent: monthlySpent,
          monthly_limit: cap.monthly_limit_usd,
        }, 429);
      }

      if (cap.monthly_limit_usd !== null && monthlySpent >= cap.monthly_limit_usd) {
        return c.json({
          error: "Spend cap exceeded",
          detail: "Monthly spend limit reached",
          daily_spent: dailySpent,
          daily_limit: cap.daily_limit_usd,
          monthly_spent: monthlySpent,
          monthly_limit: cap.monthly_limit_usd,
        }, 429);
      }

      return next();
    });
  };
}
