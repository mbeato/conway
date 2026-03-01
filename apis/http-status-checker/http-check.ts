export interface HttpCheckResult {
  url: string;
  expected: number;
  actual?: number | null;
  ok: boolean;
  error?: string;
  checkedAt: string;
  statusText?: string;
}

function sanitizeNetworkError(e: unknown): string {
  const err = e instanceof Error ? e : new Error(String(e));
  if (err.name === "TimeoutError") return "timeout";
  if (typeof (err as any).code === "string") {
    const code = (err as any).code;
    const codes: Record<string, string> = {
      ECONNREFUSED: "connection_refused",
      ENOTFOUND: "dns_not_found",
      ECONNRESET: "connection_reset",
      ETIMEDOUT: "timeout",
    };
    return codes[code] ?? "network_error";
  }
  return "network_error";
}

export async function checkHttpStatus(url: string, expected: number): Promise<HttpCheckResult> {
  let res: Response | undefined;
  let status: number | null = null;
  let statusText = undefined;
  try {
    // Use HEAD - fallback to GET if not supported (some hosts don't support HEAD)
    for (const method of ["HEAD", "GET"]) {
      try {
        res = await fetch(url, {
          method,
          redirect: "manual",
          signal: AbortSignal.timeout(7000),
          headers: { "User-Agent": "apimesh-http-status-checker/1.0" },
        });
        status = res.status;
        statusText = res.statusText;
        break;
      } catch (e: unknown) {
        if (
          e instanceof TypeError &&
          /Failed to fetch|NetworkError|fetch failed/i.test(e.message)
        ) {
          continue; // try with GET if HEAD fails
        }
        throw e;
      }
    }

    if (typeof status !== 'number') {
      return {
        url,
        expected,
        actual: null,
        ok: false,
        error: "Could not connect to server",
        checkedAt: new Date().toISOString(),
      };
    }
    const ok = status === expected;
    return {
      url,
      expected,
      actual: status,
      ok,
      statusText,
      checkedAt: new Date().toISOString(),
      ...(ok ? {} : { error: `Expected ${expected} but got ${status}` }),
    };
  } catch (e: unknown) {
    return {
      url,
      expected,
      actual: status,
      ok: false,
      error: sanitizeNetworkError(e),
      checkedAt: new Date().toISOString(),
      statusText,
    };
  }
}
