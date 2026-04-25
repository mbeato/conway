import { safeFetch } from "../../shared/ssrf";

export interface EndpointInfo {
  path: string;
  methods: string[];
  description: string;
  score: number; // 0-100
  grade: string; // letter grade A-F
  details: string; // Human-readable analysis
  recommendations: Recommendation[];
}

export interface Recommendation {
  issue: string;
  severity: number; // 0-100
  suggestion: string;
}

export interface EndpointDiscoveryResult {
  scannedDomain: string;
  endpoints: EndpointInfo[];
  totalEndpoints: number;
  scanTimestamp: string;
  duration_ms: number;
}

export interface EndpointDiscoveryPreview {
  scannedDomain: string;
  endpointsPreview: Pick<EndpointInfo, "path" | "methods" | "details">[];
  scannedAt: string;
  duration_ms: number;
}

// Input schema for x402 discovery metadata
export const fullDiscoverySchema = {
  properties: {
    domain: { type: "string", description: "Domain to scan, e.g. example.com" },
  },
  required: ["domain"],
};

export const previewDiscoverySchema = fullDiscoverySchema;

const COMMON_API_BASES = [
  "/api/",
  "/api/v1/",
  "/v1/",
  "/v2/",
  "/rest/",
  "/graphql",
  "/oauth/",
  "/admin/api/",
  "/service/",
];

const COMMON_HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"];

const COMMON_PATH_SUFFIXES = ["", "/", ".json", ".xml"];


// Helper: Assess score and grade from endpoints discovered
function scoreForCount(count: number): { score: number; grade: string } {
  if (count >= 20) return { score: 95, grade: "A" };
  if (count >= 15) return { score: 85, grade: "B" };
  if (count >= 10) return { score: 70, grade: "C" };
  if (count >= 5) return { score: 50, grade: "D" };
  return { score: 25, grade: "F" };
}

// Helper to generate recommendations based on analysis
function generateRecommendationsForEndpoint(path: string, methods: string[]): Recommendation[] {
  const recs: Recommendation[] = [];

  if (methods.includes("POST") || methods.includes("PUT") || methods.includes("PATCH") || methods.includes("DELETE")) {
    recs.push({
      issue: "Potentially mutating endpoint detected",
      severity: 70,
      suggestion: "Ensure authentication and CSRF protection are implemented for mutating methods.",
    });
  }

  if (path.includes("admin")) {
    recs.push({
      issue: "Endpoint path contains 'admin' or sensitive segment",
      severity: 80,
      suggestion: "Restrict access to admin endpoints using proper authentication and IP whitelisting where possible.",
    });
  }

  if (path.includes("auth")) {
    recs.push({
      issue: "Authentication-related endpoint detected",
      severity: 60,
      suggestion: "Verify that secure protocols (HTTPS) and rate limiting are active for authentication endpoints.",
    });
  }

  return recs;
}

// Sanitize domain string for URL building
function sanitizeDomain(domain: string): string {
  return domain.replace(/[^a-zA-Z0-9.-]/g, "").toLowerCase();
}

// Fetch endpoint with timeout of 10 seconds
async function fetchEndpoint(url: string): Promise<Response> {
  return await safeFetch(url, {timeoutMs: 10_000});
}

// Analyze response to infer methods allowed and probable endpoint description
async function analyzeEndpoint(url: string): Promise<Partial<EndpointInfo>> {
  try {
    // Try OPTIONS request to check allowed methods
    const optionsResponse = await safeFetch(url, { method: "OPTIONS", timeoutMs: 8000 });
    let methods: string[] = [];
    if (optionsResponse.ok) {
      const allow = optionsResponse.headers.get("allow");
      if (allow) {
        methods = allow.split(",").map(m => m.trim().toUpperCase()).filter(m => COMMON_HTTP_METHODS.includes(m));
      }
    }

    if (!methods.length) {
      // fallback - try GET
      const getResponse = await safeFetch(url, { method: "GET", timeoutMs: 10_000 });
      if (getResponse.ok) {
        methods = ["GET"];
      }
    }

    // Generate description based on heuristics
    const desc = methods.includes("GET") ? "Accessible read API endpoint" : "Detected API endpoint";

    return { methods, description: desc };
  } catch {
    return { methods: [], description: "No response or restricted endpoint" };
  }
}

// Main deep discovery function
export async function fullDiscovery(domainRaw: string): Promise<EndpointDiscoveryResult | { error: string }> {
  const domain = sanitizeDomain(domainRaw);
  if (!domain || domain.length < 3) {
    return { error: "Invalid domain name." };
  }

  const baseUrl = `https://${domain}`;
  const scannedAt = new Date().toISOString();
  const start = performance.now();

  const discoveredEndpoints: EndpointInfo[] = [];
  const triedPaths = new Set<string>();

  // Multi-layered approach:
  // 1. Crawl predefined common API base paths
  // 2. Attempt OPTIONS, GET requests to identify methods
  // 3. Score and grade based on count and heuristics

  for (const basePath of COMMON_API_BASES) {
    for (const suffix of COMMON_PATH_SUFFIXES) {
      const candidate = basePath.endsWith("/") ? basePath.slice(0, -1) + suffix : basePath + suffix;
      if (triedPaths.has(candidate)) continue;
      triedPaths.add(candidate);
      const url = baseUrl + candidate;

      try {
        const endpointData = await analyzeEndpoint(url);
        if (endpointData.methods && endpointData.methods.length > 0) {
          const recs = generateRecommendationsForEndpoint(candidate, endpointData.methods);
          const scoreObject = scoreForCount(discoveredEndpoints.length + 1);

          discoveredEndpoints.push({
            path: candidate,
            methods: endpointData.methods,
            description: endpointData.description || "API endpoint",
            score: scoreObject.score,
            grade: scoreObject.grade,
            details: `Detected HTTP methods: ${endpointData.methods.join(", ")}`,
            recommendations: recs,
          });
        }
      } catch (e) {
        // Ignore errors per endpoint
      }
    }
  }

  // Additional heuristic: try root endpoints for JSON API like /api, /v1, /v2
  for (const prefix of ["/api", "/v1", "/v2"]) {
    const url = baseUrl + prefix;
    if (triedPaths.has(prefix)) continue;
    triedPaths.add(prefix);

    try {
      const endpointData = await analyzeEndpoint(url);
      if (endpointData.methods && endpointData.methods.length > 0) {
        const recs = generateRecommendationsForEndpoint(prefix, endpointData.methods);
        const scoreObject = scoreForCount(discoveredEndpoints.length + 1);
        discoveredEndpoints.push({
          path: prefix,
          methods: endpointData.methods,
          description: endpointData.description || "API endpoint",
          score: scoreObject.score,
          grade: scoreObject.grade,
          details: `Detected HTTP methods: ${endpointData.methods.join(", ")}`,
          recommendations: recs,
        });
      }
    } catch {}
  }

  const duration_ms = Math.round(performance.now() - start);

  const totalEndpoints = discoveredEndpoints.length;

  return {
    scannedDomain: domain,
    endpoints: discoveredEndpoints,
    totalEndpoints,
    scanTimestamp: scannedAt,
    duration_ms,
  };
}

// Preview lightweight discovery
export async function previewDiscovery(domainRaw: string): Promise<EndpointDiscoveryPreview | { error: string }> {
  const domain = sanitizeDomain(domainRaw);
  if (!domain || domain.length < 3) {
    return { error: "Invalid domain name." };
  }

  const baseUrl = `https://${domain}`;
  const scannedAt = new Date().toISOString();
  const start = performance.now();

  const previewEndpoints: EndpointDiscoveryPreview["endpointsPreview"] = [];

  // Quick heuristic: probe the top 5 most common API roots with GET
  const quickCheckPaths = ["/api", "/api/v1", "/v1", "/graphql", "/oauth"];

  await Promise.all(quickCheckPaths.map(async (path) => {
    const url = baseUrl + path;
    try {
      const res = await safeFetch(url, { method: "HEAD", timeoutMs: 15_000 });
      if (res.ok) {
        previewEndpoints.push({ path, methods: ["HEAD"], details: "Detected has endpoint responding to HEAD" });
      } else {
        // fallback to GET check
        const getRes = await safeFetch(url, { method: "GET", timeoutMs: 15_000 });
        if (getRes.ok) {
          previewEndpoints.push({ path, methods: ["GET"], details: "Detected has endpoint responding to GET" });
        }
      }
    } catch {}
  }));

  const duration_ms = Math.round(performance.now() - start);
  return {
    scannedDomain: domain,
    endpointsPreview: previewEndpoints,
    scannedAt,
    duration_ms,
  };
}
