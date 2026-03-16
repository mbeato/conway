import { test, expect, mock, afterEach } from "bun:test";
import { isPasswordBreached } from "../shared/hibp";

// Helper: compute SHA-1 hex like the module does, for verification
async function sha1Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-1", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

test("SHA-1 prefix/suffix split is at position 5", async () => {
  const hash = await sha1Hex("password");
  // SHA-1 of "password" is well-known: 5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8
  expect(hash).toBe("5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8");
  expect(hash.slice(0, 5)).toBe("5BAA6");
  expect(hash.slice(5)).toBe("1E4C9B93F3F0682250B6CF8331B7EE68FD8");
});

test("isPasswordBreached returns true for known breached password", async () => {
  // "password" is in every breach database
  const result = await isPasswordBreached("password");
  expect(result).toBe(true);
}, 10_000);

test("isPasswordBreached returns false for random 64-char string", async () => {
  const random = Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const result = await isPasswordBreached(random);
  expect(result).toBe(false);
}, 10_000);

test("isPasswordBreached returns false (fail open) when fetch throws", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error("Network error");
  };
  try {
    const result = await isPasswordBreached("password");
    expect(result).toBe(false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("isPasswordBreached returns false when HIBP returns non-200 status", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("Service unavailable", { status: 503 });
  try {
    const result = await isPasswordBreached("password");
    expect(result).toBe(false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
