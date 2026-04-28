import { safeFetch, validateExternalUrl } from "../../shared/ssrf";

// --- Types ---
export interface TimingMetrics {
  navigationStart?: number;
  responseEnd?: number;
  domContentLoadedEventEnd?: number;
  loadEventEnd?: number;
  firstContentfulPaint?: number;
  largestContentfulPaint?: number;
  totalLoadTime?: number;
}

export interface ResourceSummary {
  totalResources: number;
  totalSizeBytes: number;
  resourceTypes: Record<string, number>; // e.g. { script: count, img: count }
  sizeByType: Record<string, number>; // e.g. { script: bytes, img: bytes }
}

export interface CriticalRequest {
  url: string;
  type: string;
  sizeBytes: number;
  initiatorType: string;
  durationMs: number;
}

export type Severity = "low" | "medium" | "high" | "critical";

export interface Recommendation {
  issue: string;
  severity: Severity;
  suggestion: string;
}

export interface PagePerformanceResult {
  url: string;
  timing: TimingMetrics;
  resourceSummary: ResourceSummary;
  criticalRequests: CriticalRequest[];
  score: number; // 0-100
  grade: string; // A-F
  recommendations: Recommendation[];
  details: string;
}

const USER_AGENT = "page-performance-metrics/1.0 apimesh.xyz";

// Utility letter grade converter
function letterGradeFromScore(score: number): string {
  if (score >= 90) return "A";
  if (score >= 80) return "B";
  if (score >= 70) return "C";
  if (score >= 60) return "D";
  return "F";
}

// Helper to safely parse Performance Timing JSON data
function extractPerformanceTimings(raw: any): TimingMetrics {
  const metrics: TimingMetrics = {};
  if (typeof raw !== "object" || raw === null) return metrics;

  // Support userTiming or legacy navigation timing
  if (raw.navigationStart) metrics.navigationStart = raw.navigationStart;
  if (raw.responseEnd) metrics.responseEnd = raw.responseEnd;
  if (raw.domContentLoadedEventEnd)
    metrics.domContentLoadedEventEnd = raw.domContentLoadedEventEnd;
  if (raw.loadEventEnd) metrics.loadEventEnd = raw.loadEventEnd;
  if (raw.firstContentfulPaint)
    metrics.firstContentfulPaint = raw.firstContentfulPaint;
  if (raw.largestContentfulPaint)
    metrics.largestContentfulPaint = raw.largestContentfulPaint;

  if (metrics.navigationStart && metrics.loadEventEnd) {
    metrics.totalLoadTime = metrics.loadEventEnd - metrics.navigationStart;
  }

  return metrics;
}

// Minimal helper: parse resource timing entries from Chrome DevTools Protocol-like JSON
// We simulate by fetching /performance-timing endpoint or mimic (no real headless here)
// So for real, we use the Timing-Allow-Origin enabled resource info, fetching /performance entries disabled on cross domain
// We'll use Network-Info from HAR-like or headers for Content-Length
// For demonstration, fetch the URL and try to parse a synthetic /performance-metrics endpoint if exists

interface RawResourceEntry {
  name: string;
  initiatorType: string;
  duration: number; // ms
  encodedBodySize: number; // bytes
  decodedBodySize: number; // bytes
  responseEnd: number; // timestamp ms
}

// To simulate analysis, we do multiple fetch requests for analytics
// TODO: We perform multiple fetches of main HTML and some resource list

// Safe fetch wrapper with 10s timeout
async function fetchWithTimeout(url: string): Promise<Response> {
  return await safeFetch(url, {
    timeoutMs: 10000,
    headers: { "User-Agent": USER_AGENT },
  });
}

// For demonstration: analyzePerformance does the following:
// - fetch main URL (HTML) with GET, capture Load duration roughly
// - fetch /_performance-metrics JSON endpoint (simulated) for resource info (if available)
// - aggregate resource size and counts
// - identify critical requests (largest/longest)
// - assign score based on total load time, resource sizes, and counts
// - build recommendations

export async function analyzePerformance(checkedUrl: string): Promise<PagePerformanceResult> {
  // Validate URL - redundant here
  const check = validateExternalUrl(checkedUrl);
  if ("error" in check) {
    throw new Error(check.error);
  }

  // Fetch main page GET
  const mainFetch = fetchWithTimeout(check.url.toString());

  // Attempt to fetch resource timings metadata endpoint
  // This endpoint is fictitious but used here for demonstration, if 404 fallback
  const metricsUrl = new URL(check.url.toString());
  metricsUrl.pathname = "/_performance-metrics";

  const metricsFetch = fetchWithTimeout(metricsUrl.toString()).catch(() => null);

  const [mainResp, rawMetricsResp] = await Promise.all([mainFetch, metricsFetch]);

  if (!mainResp.ok) {
    throw new Error(`Main page fetch failed with status ${mainResp.status}`);
  }

  // Read main body size
  const mainBodyText = await mainResp.text();
  const mainBodySize = new TextEncoder().encode(mainBodyText).length;

  // Extract timing from headers
  let timing: TimingMetrics = {};

  // Try to get timing headers if available
  const perfTimingHeader = mainResp.headers.get("x-performance-timing");
  if (perfTimingHeader) {
    try {
      const parsed = JSON.parse(perfTimingHeader);
      timing = extractPerformanceTimings(parsed);
    } catch {
      // ignore
    }
  }

  // If no timing in headers, approximate using Date headers
  if (!timing.totalLoadTime) {
    // Try Date header to estimate timing?
    // No reliable timing data
  }

  // Parse resource metrics if available
  let resourceSummary: ResourceSummary = {
    totalResources: 0,
    totalSizeBytes: 0,
    resourceTypes: {},
    sizeByType: {},
  };

  let criticalRequests: CriticalRequest[] = [];

  if (rawMetricsResp && rawMetricsResp.ok) {
    try {
      const rawJson = await rawMetricsResp.json();
      if (Array.isArray(rawJson.resources)) {
        for (const r of rawJson.resources) {
          const type = r.initiatorType || "other";
          const size = typeof r.encodedBodySize === "number" ? r.encodedBodySize : 0;
          resourceSummary.totalResources += 1;
          resourceSummary.totalSizeBytes += size;

          if (!resourceSummary.resourceTypes[type]) resourceSummary.resourceTypes[type] = 0;
          resourceSummary.resourceTypes[type] += 1;

          if (!resourceSummary.sizeByType[type]) resourceSummary.sizeByType[type] = 0;
          resourceSummary.sizeByType[type] += size;

          // Collect large or slow resources as critical
          if (size > 100_000 || r.duration > 2000) {
            criticalRequests.push({
              url: r.name,
              type,
              sizeBytes: size,
              initiatorType: r.initiatorType || "unknown",
              durationMs: r.duration || 0,
            });
          }
        }
      }
    } catch {
      // Ignore parse error
    }
  }

  // Sort critical requests by size then duration, descending
  criticalRequests.sort((a, b) => {
    if (b.sizeBytes !== a.sizeBytes) return b.sizeBytes - a.sizeBytes;
    return b.durationMs - a.durationMs;
  });

  if (criticalRequests.length > 10) {
    criticalRequests = criticalRequests.slice(0, 10);
  }

  // Compute score based on total load time, main resource size, resource count etc
  let score = 100;
  let explanation = [] as string[];

  if (timing.totalLoadTime === undefined) {
    // Penalize unknown timing moderately
    score -= 15;
    explanation.push("Total load time unavailable, score penalized.");
  } else {
    if (timing.totalLoadTime > 5000) {
      score -= 40;
      explanation.push(`High total load time: ${timing.totalLoadTime}ms.`);
    } else if (timing.totalLoadTime > 3000) {
      score -= 20;
      explanation.push(`Moderate total load time: ${timing.totalLoadTime}ms.`);
    } else {
      explanation.push(`Good total load time: ${timing.totalLoadTime}ms.`);
    }
  }

  if (mainBodySize > 512_000) {
    score -= 20;
    explanation.push(`Main page HTML size is large (${mainBodySize} bytes).`);
  } else if (mainBodySize > 256_000) {
    score -= 10;
    explanation.push(`Moderate main page HTML size (${mainBodySize} bytes).`);
  } else {
    explanation.push(`Main page HTML size is reasonable (${mainBodySize} bytes).`);
  }

  const totalRes = resourceSummary.totalResources;
  if (totalRes > 100) {
    score -= 20;
    explanation.push(`High resource count (${totalRes}).`);
  } else if (totalRes > 50) {
    score -= 10;
    explanation.push(`Moderate resource count (${totalRes}).`);
  } else {
    explanation.push(`Resource count is moderate (${totalRes}).`);
  }

  const totalSize = resourceSummary.totalSizeBytes;
  if (totalSize > 5_000_000) {
    score -= 25;
    explanation.push(`Very large total resource size (${(totalSize / 1e6).toFixed(2)} MB).`);
  } else if (totalSize > 2_000_000) {
    score -= 12;
    explanation.push(`Moderate total resource size (${(totalSize / 1e6).toFixed(2)} MB).`);
  } else {
    explanation.push(`Total resource size reasonable (${(totalSize / 1e6).toFixed(2)} MB).`);
  }

  // Clamp score 0-100
  if (score < 0) score = 0;
  if (score > 100) score = 100;
  
  const grade = letterGradeFromScore(score);

  // Recommendations based on score and findings
  const recommendations: Recommendation[] = [];

  if (timing.totalLoadTime && timing.totalLoadTime > 4000) {
    recommendations.push({
      issue: "Slow total page load time",
      severity: "high",
      suggestion: "Improve server response time, optimize rendering path, and reduce blocking resources.",
    });
  }

  if (mainBodySize > 256_000) {
    recommendations.push({
      issue: "Large HTML document size",
      severity: "medium",
      suggestion: "Minimize HTML size and inline critical CSS to reduce main document size.",
    });
  }

  if (resourceSummary.totalSizeBytes > 2_000_000) {
    recommendations.push({
      issue: "Large resource size total",
      severity: "high",
      suggestion: "Compress images and scripts, enable caching, and consider lazy loading.",
    });
  }

  if (criticalRequests.length > 0) {
    for (const c of criticalRequests) {
      if (c.sizeBytes > 300_000) {
        recommendations.push({
          issue: `Large critical resource: ${c.url}`,
          severity: "critical",
          suggestion: `Optimize or defer loading of this large resource of size ${c.sizeBytes} bytes.`,
        });
      } else if (c.durationMs > 3000) {
        recommendations.push({
          issue: `Slow critical resource: ${c.url}`,
          severity: "high",
          suggestion: `Investigate and optimize slow-loading resource.`,
        });
      }
    }
  }

  if (recommendations.length === 0) {
    recommendations.push({
      issue: "Performance appears good",
      severity: "low",
      suggestion: "Maintain current optimizations and monitor regularly.",
    });
  }

  return {
    url: check.url.toString(),
    timing,
    resourceSummary,
    criticalRequests,
    score: Math.round(score),
    grade,
    recommendations,
    details: explanation.join(" "),
  };
}
