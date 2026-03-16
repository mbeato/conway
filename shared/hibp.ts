/**
 * HIBP (Have I Been Pwned) k-anonymity password breach check.
 *
 * Uses the range API: sends only the first 5 chars of the SHA-1 hash,
 * receives all suffixes matching that prefix, checks locally.
 * Fails open (returns false) on any error to avoid blocking signups.
 */

const HIBP_API_URL = "https://api.pwnedpasswords.com/range/";
const TIMEOUT_MS = 5000;

/**
 * Check if a password has appeared in a known data breach.
 * Uses k-anonymity: only the first 5 characters of the SHA-1 hash are sent to HIBP.
 * Returns false (fail open) on any network/API error.
 */
export async function isPasswordBreached(password: string): Promise<boolean> {
  try {
    // Compute SHA-1 hash
    const data = new TextEncoder().encode(password);
    const hashBuffer = await crypto.subtle.digest("SHA-1", data);
    const hashHex = Array.from(new Uint8Array(hashBuffer))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
      .toUpperCase();

    // Split at position 5
    const prefix = hashHex.slice(0, 5);
    const suffix = hashHex.slice(5);

    // Query HIBP range API
    const response = await fetch(`${HIBP_API_URL}${prefix}`, {
      headers: { "Add-Padding": "true" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!response.ok) {
      console.warn(`[hibp] HIBP API returned ${response.status} for prefix ${prefix}`);
      return false;
    }

    const text = await response.text();

    // Each line is SUFFIX:count — check if our suffix appears
    const lines = text.split("\n");
    for (const line of lines) {
      const colonIdx = line.indexOf(":");
      if (colonIdx === -1) continue;
      const lineSuffix = line.slice(0, colonIdx).trim();
      if (lineSuffix === suffix) {
        return true;
      }
    }

    return false;
  } catch (err) {
    console.warn(`[hibp] HIBP check failed (failing open):`, err instanceof Error ? err.message : String(err));
    return false;
  }
}
