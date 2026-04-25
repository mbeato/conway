import { safeFetch, validateExternalUrl } from "../../shared/ssrf";
import { Grade, CorsHeaderAnalysis, EndpointCorsAnalysis, AggregatedCorsReport, Recommendation } from "./types";
import { gradeFromScore, severityFromScore, combineHeaderGrades, mergeRecommendations } from "./utils";

const COR_HEADERS = [
  "Access-Control-Allow-Origin",
  "Access-Control-Allow-Methods",
  "Access-Control-Allow-Headers",
  "Access-Control-Allow-Credentials",
  "Access-Control-Max-Age",
  "Cross-Origin-Resource-Policy"
];

// Helpers to score particular CORS headers

function analyzeACAO(value: string | null): CorsHeaderAnalysis {
  // "Access-Control-Allow-Origin"
  const issues: string[] = [];
  let severityScore = 100;
  if (!value) {
    issues.push("Header missing.");
    severityScore = 0;
  } else {
    const v = value.trim();
    if (v === "*") {
      issues.push("Allows any origin (wildcard '*'). This may be overly permissive.");
      severityScore = 30;
    } else {
      try {
        // Non-wildcard origin check
        new URL(v); // Valid URL string origin
      } catch {
        issues.push(`Value '${value}' is not a valid origin or '*'.`);
        severityScore = 20;
      }
    }
  }
  const grade = gradeFromScore(severityScore);
  return {
    header: "Access-Control-Allow-Origin",
    present: !!value,
    value,
    issues,
    severityScore,
    grade,
  };
}

function analyzeACAMethods(value: string | null): CorsHeaderAnalysis {
  const issues: string[] = [];
  let severityScore = 100;
  if (!value) {
    issues.push("Header missing.");
    severityScore = 0;
  } else {
    const methods = value.toUpperCase().split(",").map(m => m.trim()).filter(Boolean);
    if (methods.length === 0) {
      issues.push("No HTTP methods specified.");
      severityScore = 20;
    } else {
      const allowedMethods = ["GET", "POST", "PUT", "DELETE", "OPTIONS", "HEAD", "PATCH"];
      for (const m of methods) {
        if (!allowedMethods.includes(m)) {
          issues.push(`Unknown or non-standard HTTP method: '${m}'.`);
          severityScore = severityScore > 10 ? 10 : severityScore;
        }
      }
      if (methods.includes("*") || methods.includes("ALL")) {
        issues.push("Wildcard or 'ALL' methods allowed, very permissive.");
        severityScore = severityScore > 20 ? 20 : severityScore;
      }
    }
  }
  const grade = gradeFromScore(severityScore);
  return {
    header: "Access-Control-Allow-Methods",
    present: !!value,
    value,
    issues,
    severityScore,
    grade,
  };
}

function analyzeACAH(value: string | null): CorsHeaderAnalysis {
  // Access-Control-Allow-Headers
  const issues: string[] = [];
  let severityScore = 100;
  if (!value) {
    issues.push("Header missing.");
    severityScore = 0;
  } else {
    // '*' allowed (legacy support in some browsers?)
    if (value.trim() === "*") {
      issues.push("Wildcard '*' allowed in Access-Control-Allow-Headers, very permissive.");
      severityScore = 30;
    } else {
      // Validate header tokens
      const headers = value.split(",").map(h => h.trim().toLowerCase()).filter(Boolean);
      if (headers.length === 0) {
        issues.push("Empty Access-Control-Allow-Headers header.");
        severityScore = 20;
      } else {
        for (const h of headers) {
          // check token validity roughly
          if (!/^[a-z0-9\-]+$/.test(h)) {
            issues.push(`Header name '${h}' looks invalid.`);
            severityScore = severityScore > 10 ? 10 : severityScore;
          }
        }
      }
    }
  }
  const grade = gradeFromScore(severityScore);
  return {
    header: "Access-Control-Allow-Headers",
    present: !!value,
    value,
    issues,
    severityScore,
    grade,
  };
}

function analyzeACACreds(value: string | null): CorsHeaderAnalysis {
  const issues: string[] = [];
  let severityScore = 100;
  if (!value) {
    issues.push("Header missing.");
    severityScore = 20;
  } else {
    const v = value.trim().toLowerCase();
    if (v === "true") {
      // This allows credential cookies
      severityScore = 60; // seriousness depends on other headers
    } else if (v === "false") {
      severityScore = 100;
    } else {
      issues.push(`Unexpected value '${value}'. Expected 'true' or 'false'.`);
      severityScore = 20;
    }
  }
  const grade = gradeFromScore(severityScore);
  return {
    header: "Access-Control-Allow-Credentials",
    present: !!value,
    value,
    issues,
    severityScore,
    grade,
  };
}

function analyzeACAMaxAge(value: string | null): CorsHeaderAnalysis {
  const issues: string[] = [];
  let severityScore = 100;
  if (!value) {
    // not mandatory
    return {
      header: "Access-Control-Max-Age",
      present: false,
      value: null,
      issues: [],
      severityScore: 100,
      grade: "A+",
    };
  }
  const v = value.trim();
  const n = Number(v);
  if (Number.isNaN(n) || !Number.isInteger(n) || n < 0) {
    issues.push(`Invalid number '${value}'.`);
    severityScore = 20;
  } else if (n > 86400) {
    issues.push("max-age greater than 86400 seconds (24h) could allow stale data.");
    severityScore = 60;
  } else if (n === 0) {
    issues.push("max-age of 0 disables caching, may increase request load.");
    severityScore = 80;
  } else {
    severityScore = 100;
  }
  const grade = gradeFromScore(severityScore);
  return {
    header: "Access-Control-Max-Age",
    present: true,
    value,
    issues,
    severityScore,
    grade,
  };
}

function analyzeCORP(value: string | null): CorsHeaderAnalysis {
  const issues: string[] = [];
  let severityScore = 100;
  if (!value) {
    issues.push("Header missing.");
    severityScore = 0;
  } else {
    const v = value.trim().toLowerCase();
    if (v === "same-origin" || v === "same-site") {
      severityScore = 100;
    } else if (v === "cross-origin") {
      issues.push("Set to 'cross-origin', which allows any origin to embed resource.");
      severityScore = 30;
    } else {
      issues.push(`Unrecognized value '${value}'.`);
      severityScore = 20;
    }
  }
  const grade = gradeFromScore(severityScore);
  return {
    header: "Cross-Origin-Resource-Policy",
    present: !!value,
    value,
    issues,
    severityScore,
    grade,
  };
}

export async function analyzeCorsHeaders(url: string): Promise<EndpointCorsAnalysis | { error: string }> {
  const check = validateExternalUrl(url);
  if ("error" in check) return { error: check.error };

  try {
    const response = await safeFetch(check.url.toString(), {
      method: "GET",
      timeoutMs: 10000,
    });

    const headers = response.headers;

    // Extract relevant headers
    const analysis: Record<string, CorsHeaderAnalysis> = {};
    analysis["Access-Control-Allow-Origin"] = analyzeACAO(headers.get("access-control-allow-origin"));
    analysis["Access-Control-Allow-Methods"] = analyzeACAMethods(headers.get("access-control-allow-methods"));
    analysis["Access-Control-Allow-Headers"] = analyzeACAH(headers.get("access-control-allow-headers"));
    analysis["Access-Control-Allow-Credentials"] = analyzeACACreds(headers.get("access-control-allow-credentials"));
    analysis["Access-Control-Max-Age"] = analyzeACAMaxAge(headers.get("access-control-max-age"));
    analysis["Cross-Origin-Resource-Policy"] = analyzeCORP(headers.get("cross-origin-resource-policy"));

    const grades = Object.values(analysis).map(a => a.severityScore);
    const averageScore = grades.length > 0 ? Math.round(grades.reduce((a,b) => a+b, 0)/grades.length) : 0;
    const overallGrade = gradeFromScore(averageScore);

    // Explanation text
    const explanation = `Analyzed CORS headers for ${check.url.toString()}: Overall grade ${overallGrade}, average severity/score ${averageScore}.`;

    // Recommendations
    const recommendations: Recommendation[] = [];
    for (const key in analysis) {
      const a = analysis[key];
      if (a.issues.length > 0) {
        for (const issue of a.issues) {
          recommendations.push({
            issue: `${a.header} header: ${issue}`,
            severity: severityFromScore(a.severityScore),
            suggestion: generateFixSuggestion(a.header, issue),
          });
        }
      }
    }

    return {
      url: check.url.toString(),
      corsHeaders: analysis,
      overallScore: averageScore,
      grade: overallGrade,
      explanation,
      recommendations,
      fetchedAt: new Date().toISOString(),
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { error: `Failed to fetch or analyze: ${msg}` };
  }
}

function generateFixSuggestion(header: string, issue: string): string {
  switch (header) {
    case "Access-Control-Allow-Origin":
      if (issue.includes("wildcard '*'")) {
        return "Restrict Access-Control-Allow-Origin to specific allowed origins instead of '*'.";
      } else if (issue.includes("missing")) {
        return "Add Access-Control-Allow-Origin header with explicit allowed origin or restrict to trusted domains.";
      } else return "Review and restrict the Access-Control-Allow-Origin header value.";
    case "Access-Control-Allow-Methods":
      return "Restrict allowed HTTP methods to only those needed by your API (avoid wildcard or 'ALL').";
    case "Access-Control-Allow-Headers":
      return "Restrict allowed headers to only those necessary and avoid wildcard '*'.";
    case "Access-Control-Allow-Credentials":
      if (issue.includes("Unexpected value")) {
        return "Set Access-Control-Allow-Credentials to 'true' or 'false' explicitly.";
      } else if (issue.includes("missing")) {
        return "Set Access-Control-Allow-Credentials explicitly based on whether credentials are needed.";
      } else return "Review Access-Control-Allow-Credentials header to match your security needs.";
    case "Access-Control-Max-Age":
      return "Set Access-Control-Max-Age to a reasonable value balancing caching and security (e.g. below 86400).";
    case "Cross-Origin-Resource-Policy":
      if (issue.includes("allows any origin")) {
        return "Set Cross-Origin-Resource-Policy to 'same-origin' or 'same-site' to restrict resource sharing.";
      } else if (issue.includes("missing")) {
        return "Add Cross-Origin-Resource-Policy header to restrict resource embedding.";
      } else return "Review Cross-Origin-Resource-Policy header for appropriate restrictions.";
    default:
      return "Review and fix the CORS header configuration.";
  }
}

export async function comprehensiveCorsAudit(baseUrl: string, endpoints?: string[]): Promise<AggregatedCorsReport | { error: string }> {
  const check = validateExternalUrl(baseUrl);
  if ("error" in check) return { error: check.error };
  let endpointUrls: string[] = [];

  if (endpoints && Array.isArray(endpoints) && endpoints.length > 0) {
    // Resolve endpoints to full URLs
    try {
      endpointUrls = endpoints.map(ep => {
        try {
          // If absolute URL
          const u = new URL(ep);
          if (!["http:", "https:"].includes(u.protocol)) throw new Error("Bad protocol");
          return u.toString();
        } catch {
          // Relative endpoint
          const base = new URL(baseUrl);
          return new URL(ep, base).toString();
        }
      });
    } catch (e) {
      return { error: `Invalid endpoint in list: ${String(e)}` };
    }
  } else {
    // If no endpoints provided, test baseUrl only
    endpointUrls = [baseUrl];
  }

  // Limit endpoint count to max 10 to avoid abuse
  if (endpointUrls.length > 10) {
    endpointUrls = endpointUrls.slice(0, 10);
  }

  // Fetch all in parallel
  const analysesResults = await Promise.all(endpointUrls.map(async (url) => {
    try {
      return await analyzeCorsHeaders(url);
    } catch (e) {
      return { error: `Failed to analyze ${url}: ${e instanceof Error ? e.message : String(e)}` };
    }
  }));

  // Filter successful
  const endpointsAnalysis: EndpointCorsAnalysis[] = analysesResults.filter((r): r is EndpointCorsAnalysis => !("error" in r));
  const errors = analysesResults.filter(r => "error" in r).map(r => (r as any).error);

  // Aggregate
  const scores = endpointsAnalysis.map(e => e.overallScore);
  const averageScore = scores.length > 0 ? Math.round(scores.reduce((a,b) => a+b, 0)/scores.length) : 0;
  const overallGrade = gradeFromScore(averageScore);

  // Identify overly permissive and misconfigured headers across endpoints
  let overlyPermissiveCount = 0;
  let misconfigurationCount = 0;
  const headerSet = new Set<string>();
  const allRecommendations: Recommendation[][] = [];

  for (const ea of endpointsAnalysis) {
    for (const [k, h] of Object.entries(ea.corsHeaders)) {
      headerSet.add(k);
      for (const issue of h.issues) {
        if (issue.includes("wildcard") || issue.includes("Allow any origin")) {
          overlyPermissiveCount++;
        } else {
          misconfigurationCount++;
        }
      }
    }
    if (ea.recommendations.length > 0) allRecommendations.push(ea.recommendations);
  }

  // Detect inconsistent headers (different or missing values across endpoints)
  const inconsistentHeaders: string[] = [];
  for (const hdr of headerSet) {
    const values = new Set<string>();
    for (const ea of endpointsAnalysis) {
      const ha = ea.corsHeaders[hdr];
      if (ha && ha.present && ha.value) values.add(ha.value.toLowerCase());
    }
    if (values.size > 1) inconsistentHeaders.push(hdr);
  }

  const recommendations = mergeRecommendations(allRecommendations);

  return {
    baseUrl: check.url.toString(),
    endpointCount: endpointsAnalysis.length,
    averageScore,
    overallGrade,
    summary: {
      overlyPermissiveCount,
      misconfigurationCount,
      inconsistentHeaders,
    },
    endpoints: endpointsAnalysis,
    recommendations,
    generatedAt: new Date().toISOString(),
  };
}
