import type { MiddlewareHandler } from "hono";

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * Extract payer wallet from x402 payment headers.
 * Runs AFTER paymentMiddleware — reads the incoming payment header
 * and the settlement response to find the payer's EVM address.
 *
 * Sets c.set("payerWallet", address) for downstream use.
 */
export function extractPayerWallet(): MiddlewareHandler {
  return async (c, next) => {
    // Try to extract wallet from the incoming payment header (pre-settlement)
    const paymentHeader = c.req.header("X-PAYMENT") || c.req.header("payment-signature");
    if (paymentHeader) {
      const wallet = parseWalletFromPaymentHeader(paymentHeader);
      if (wallet) {
        c.set("payerWallet", wallet);
      }
    }

    await next();

    // If we didn't get it from the request, try the settlement response header
    if (!c.get("payerWallet")) {
      const paymentResponse = c.res.headers.get("PAYMENT-RESPONSE") || c.res.headers.get("X-PAYMENT-RESPONSE");
      if (paymentResponse) {
        const wallet = parseWalletFromSettlement(paymentResponse);
        if (wallet) {
          c.set("payerWallet", wallet);
        }
      }
    }
  };
}

function parseWalletFromPaymentHeader(header: string): string | null {
  try {
    const decoded = Buffer.from(header, "base64").toString("utf-8");
    const parsed = JSON.parse(decoded);
    // x402 payment payload: payload.authorization.from
    const from =
      parsed?.payload?.authorization?.from ??
      parsed?.authorization?.from ??
      parsed?.from;
    if (typeof from === "string" && EVM_ADDRESS_RE.test(from)) {
      return from.toLowerCase();
    }
  } catch {
    // Not base64 JSON — ignore
  }
  return null;
}

function parseWalletFromSettlement(header: string): string | null {
  try {
    const decoded = Buffer.from(header, "base64").toString("utf-8");
    const parsed = JSON.parse(decoded);
    const from = parsed?.from ?? parsed?.payer;
    if (typeof from === "string" && EVM_ADDRESS_RE.test(from)) {
      return from.toLowerCase();
    }
  } catch {
    // Not base64 JSON — ignore
  }
  return null;
}

/**
 * Pre-parse the payer wallet from the payment header without waiting for settlement.
 * Used by spend-cap middleware which runs BEFORE paymentMiddleware.
 */
export function parsePayerWalletFromRequest(headerValue: string | undefined): string | null {
  if (!headerValue) return null;
  return parseWalletFromPaymentHeader(headerValue);
}
