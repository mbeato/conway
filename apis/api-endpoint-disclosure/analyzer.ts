import { safeFetch, validateExternalUrl } from "../../shared/ssrf";

// -------------- Types --------------

export interface EndpointInfo {
  filename: string;
  statusCode: number | null;
  contentType?: string | null;
  size?: number | null;
}

export interface Recommendation {
  issue: string;
  severity: number; // 0-100 severity numeric
  suggestion: string;
}

export interface EndpointDisclosureResult {
  url: string;
  foundEndpoints: EndpointInfo[];
  score: number; // 0-100
  grade: string; // A-F
  details: string;
  recommendations: Recommendation[];
  scannedAt: string; // ISO8601 timestamp
}

export interface PreviewResult {
  url: string;
  foundEndpoints: Array<{ filename: string; statusCode: number | null }>;
  score: number; // 0-100
  grade: string; // letter
  details: string;
  recommendations: Recommendation[];
  scannedAt: string;
}

// -------------- Constants and heuristics --------------

const COMMON_SENSITIVE_FILES = [
  ".env",
  "package.json",
  "serverless.yml",
  "config.js",
  "config.json",
  ".git/config",
  "composer.json",
  "docker-compose.yml",
  "aws-credentials",
  "credentials.json",
  "phpinfo.php",
  "WEB-INF/web.xml",
  "wp-config.php",
  "config.php",
  "appsettings.json",
  "settings.py",
];

// Grading helper
function numericScoreToGrade(score: number): string {
  if (score >= 90) return "A";
  if (score >= 80) return "B";
  if (score >= 65) return "C";
  if (score >= 50) return "D";
  if (score >= 30) return "E";
  return "F";
}

// Helper: response is considered safe if status is 404, 401, 403 (authentication/authorization denied), or 301 redirect
function isSafeStatus(status: number | null): boolean {
  if (status === null) return false;
  return status === 404 || status === 401 || status === 403 || (status >= 300 && status < 400);
}

// Analyze a single endpoint discovery fetch
async function checkEndpoint(url: string, filename: string): Promise<EndpointInfo> {
  const testUrl = url.replace(/\/+$/, "") + "/" + filename;
  try {
    // HEAD request first to check existence, timeout 8000ms
    const headResp = await safeFetch(testUrl, {
      method: "HEAD",
      timeoutMs: 8000,
      headers: { "User-Agent": `api-endpoint-disclosure/1.0 apimesh.xyz` },
      redirect: "manual",
    });

    const status = headResp.status;
    if (status === 405 || status === 501) {
      // Method Not Allowed -> fallback to GET
      const getResp = await safeFetch(testUrl, {
        method: "GET",
        timeoutMs: 10000,
        headers: { "User-Agent": `api-endpoint-disclosure/1.0 apimesh.xyz` },
        redirect: "manual",
      });
      const contentType = getResp.headers.get("content-type");
      const body = await getResp.text();
      return {
        filename,
        statusCode: getResp.status,
        contentType,
        size: body.length,
      };
    } else {
      // HEAD response
      return {
        filename,
        statusCode: status,
        contentType: headResp.headers.get("content-type"),
        size: null,
      };
    }
  } catch (e: unknown) {
    // Could be timeout or network error
    return {
      filename,
      statusCode: null,
    };
  }
}

// Heuristic scoring of results
function scoreResults(endpoints: EndpointInfo[]): { score: number; grade: string; details: string; recommendations: Recommendation[] } {
  let score = 100;
  const recs: Recommendation[] = [];

  // Check critical files exposure
  for (const ep of endpoints) {
    if (ep.statusCode === null) {
      // Could not fetch, no penalty
      continue;
    }
    const disallowedCodes = [401, 403];
    // If a sensitive file is returned 200, highly insecure
    if (ep.statusCode >= 200 && ep.statusCode < 300) {
      score -= 40;
      recs.push({
        issue: `${ep.filename} file exposed with HTTP 200 OK`,
        severity: 90,
        suggestion: `Restrict public access or remove ${ep.filename} from web root to prevent sensitive information leak.`,
      });
      continue;
    }
    // 401 or 403 reduces severity
    if (disallowedCodes.includes(ep.statusCode)) {
      // Partial credit, but still can be misconfiguration
      score -= 10;
      recs.push({
        issue: `${ep.filename} access restricted with HTTP ${ep.statusCode}`,
        severity: 40,
        suggestion: `Verify proper server configuration ensures sensitive files remain inaccessible.`,
      });
      continue;
    }
    // 404 and similar safe

    // Other codes like 500 or 302
    if (ep.statusCode >= 300 && ep.statusCode < 400) {
      // Redirect, safe
      continue;
    }
    if (ep.statusCode >= 500) {
      // Possible misconfig, no direct info leak
      score -= 5;
      recs.push({
        issue: `${ep.filename} returns HTTP ${ep.statusCode}, check server configuration for hidden issues.`,
        severity: 20,
        suggestion: `Investigate server errors for ${ep.filename} to avoid information leakage.`,
      });
    }
  }

  if (score < 0) score = 0;
  const grade = numericScoreToGrade(score);

  const details = grade === "A"
    ? "No sensitive endpoints exposed."
    : `Security audit detected possible exposure of ${endpoints.filter((e) => e.statusCode === 200).length} sensitive files or misconfigurations.`;

  return { score, grade, details, recommendations: recs };
}

// -------------- Public API --------------

export async function analyzeEndpointDisclosure(rawUrl: string): Promise<EndpointDisclosureResult> {
  const val = validateExternalUrl(rawUrl);
  if ("error" in val) {
    return Promise.reject(new Error(val.error));
  }
  const baseUrl = val.url.toString().replace(/\/+$/, "");

  const startTime = performance.now();

  // Parallel check all endpoints
  const checks = COMMON_SENSITIVE_FILES.map((filename) => checkEndpoint(baseUrl, filename));

  let endpoints: EndpointInfo[] = [];
  try {
    endpoints = await Promise.all(checks);
  } catch (err) {
    // Should not throw but fallback
    endpoints = [];
  }

  const { score, grade, details, recommendations } = scoreResults(endpoints);

  const duration_ms = Math.round(performance.now() - startTime);

  return {
    status: "ok",
    data: {
      url: baseUrl,
      foundEndpoints: endpoints,
      score,
      grade,
      details,
      recommendations,
      scannedAt: new Date().toISOString(),
    },
    meta: {
      timestamp: new Date().toISOString(),
      duration_ms,
      api_version: "1.0.0",
    },
  };
}

export async function previewEndpointDisclosure(rawUrl: string): Promise<PreviewResult> {
  const val = validateExternalUrl(rawUrl);
  if ("error" in val) {
    return Promise.reject(new Error(val.error));
  }
  const baseUrl = val.url.toString().replace(/\/+$/, "");

  const startTime = performance.now();

  // Preview checks only first 3 endpoints
  const previewFiles = COMMON_SENSITIVE_FILES.slice(0, 3);
  const checks = previewFiles.map((filename) => checkEndpoint(baseUrl, filename));

  let endpoints: EndpointInfo[] = [];
  try {
    endpoints = await Promise.all(checks);
  } catch (err) {
    endpoints = [];
  }

  // Compute simple score: if any 200 => low score, 401/403 neutral, 404 best
  let score = 100;
  const recs: Recommendation[] = [];

  for (const ep of endpoints) {
    if (ep.statusCode === 200) {
      score -= 40;
      recs.push({
        issue: `${ep.filename} is publicly accessible`,
        severity: 90,
        suggestion: `Restrict or remove access to ${ep.filename} for security.`,
      });
    } else if (ep.statusCode === 401 || ep.statusCode === 403) {
      score -= 10;
    }
  }

  if (score < 0) score = 0;
  const grade = numericScoreToGrade(score);

  const details =
    grade === "A"
      ? "Preview found no exposed sensitive endpoints."
      : "Preview found possible exposed sensitive endpoints. Use full audit for detailed report.";

  if (recs.length === 0) {
    recs.push({
      issue: "Consider running full audit",
      severity: 20,
      suggestion: "Run the full /check endpoint for comprehensive scanning and recommendations.",
    });
  }

  const duration_ms = Math.round(performance.now() - startTime);

  return {
    status: "ok",
    data: {
      url: baseUrl,
      foundEndpoints: endpoints.map(({ filename, statusCode }) => ({ filename, statusCode })),
      score,
      grade,
      details,
      recommendations: recs,
      scannedAt: new Date().toISOString(),
    },
    meta: {
      timestamp: new Date().toISOString(),
      duration_ms,
      api_version: "1.0.0",
    },
  };
}
