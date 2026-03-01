// Centralized SSRF protection for all URL-fetching APIs

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

const IPV4_PRIVATE = [
  /^127\./,                                           // Loopback
  /^10\./,                                            // RFC1918
  /^192\.168\./,                                      // RFC1918
  /^172\.(1[6-9]|2\d|3[01])\./,                      // RFC1918
  /^169\.254\./,                                      // Link-local / AWS metadata
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,        // CGNAT
  /^0\./,                                             // "This" network
];

const IPV6_PRIVATE = [
  /^::1$/,                                            // Loopback
  /^fc[0-9a-f]{2}:/i,                                 // ULA
  /^fd[0-9a-f]{2}:/i,                                 // ULA
  /^fe80:/i,                                          // Link-local
];

function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost") return true;
  if (h === "0.0.0.0") return true;
  return [...IPV4_PRIVATE, ...IPV6_PRIVATE].some((r) => r.test(h));
}

/**
 * Validate a user-provided URL is safe to fetch (no SSRF).
 * Returns the parsed URL on success, or an error string on failure.
 */
export function validateExternalUrl(raw: string): { url: URL } | { error: string } {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { error: "Invalid URL" };
  }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    return { error: "Only http:// and https:// URLs are supported" };
  }

  if (isPrivateHost(parsed.hostname)) {
    return { error: "Private and internal addresses are not allowed" };
  }

  return { url: parsed };
}

/**
 * Fetch a URL with SSRF-safe redirect handling.
 * Uses redirect: "manual" and validates each hop.
 * Max 3 redirects.
 */
export async function safeFetch(
  url: string,
  opts: {
    timeoutMs?: number;
    method?: string;
    headers?: Record<string, string>;
    maxRedirects?: number;
  } = {}
): Promise<Response> {
  const { timeoutMs = 8000, method = "GET", headers = {}, maxRedirects = 3 } = opts;

  let currentUrl = url;
  let redirects = 0;

  while (true) {
    const check = validateExternalUrl(currentUrl);
    if ("error" in check) {
      throw new Error(check.error);
    }

    const res = await fetch(currentUrl, {
      method: redirects === 0 ? method : "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { ...headers },
    });

    if (res.status >= 300 && res.status < 400) {
      if (redirects >= maxRedirects) {
        throw new Error(`Too many redirects (max ${maxRedirects})`);
      }
      const location = res.headers.get("location");
      if (!location) {
        throw new Error("Redirect response missing Location header");
      }
      // Resolve relative redirects
      currentUrl = new URL(location, currentUrl).toString();
      redirects++;
      continue;
    }

    return res;
  }
}
