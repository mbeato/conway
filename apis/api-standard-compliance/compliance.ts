import { validateExternalUrl, safeFetch } from "../../shared/ssrf";
import type { ApiComplianceResult, StandardComplianceCheck, Recommendation, Grade } from "./types";

// Utility function for letter grade from numeric score (0-100)
function scoreToGrade(score: number): Grade {
  if (score >= 90) return "A+";
  if (score >= 80) return "A";
  if (score >= 65) return "B";
  if (score >= 50) return "C";
  if (score >= 35) return "D";
  return "F";
}

// Fetch API data with timeout and error handling
async function fetchApiResponse(url: string): Promise<Response | { error: string }> {
  try {
    const res = await safeFetch(url, {
      timeoutMs: 10000,
      headers: { "User-Agent": "api-standard-compliance/1.0 apimesh.xyz" },
    });
    return res;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { error: msg };
  }
}

interface ValidationHeaders {
  [key: string]: (value: string | null) => Promise<StandardComplianceCheck> | StandardComplianceCheck;
}

// Check status code standard (200-299 allowed)
async function checkStatusCode(res: Response | null): Promise<StandardComplianceCheck> {
  if (!res) {
    return {
      name: "Status Code",
      passed: false,
      score: 0,
      grade: "F",
      severity: 90,
      explanation: "No response received.",
      details: {},
      recommendations: [
        {
          issue: "No response",
          severity: 90,
          suggestion: "Ensure the target API endpoint is reachable and responds with a valid status code.",
        },
      ],
    };
  }
  const status = res.status;
  const passed = status >= 200 && status < 300;
  const score = passed ? 100 : 0;
  const grade = scoreToGrade(score);
  return {
    name: "Status Code",
    passed,
    score,
    grade,
    severity: 90,
    explanation: passed ? `HTTP status code is ${status}, which is standard for successful responses.` : `HTTP status code is ${status}, indicating an error or non-standard response.`,
    details: { status },
    recommendations: passed
      ? []
      : [
          {
            issue: `Non-success HTTP status code: ${status}`,
            severity: 90,
            suggestion: "Ensure API returns appropriate HTTP status (2xx) on successful requests.",
          },
        ],
  };
}

// Check Content-Type header for application/json
async function checkContentType(res: Response | null): Promise<StandardComplianceCheck> {
  if (!res) {
    return {
      name: "Content-Type",
      passed: false,
      score: 0,
      grade: "F",
      severity: 80,
      explanation: "No response to check Content-Type.",
      details: {},
      recommendations: [
        {
          issue: "Missing Content-Type header",
          severity: 80,
          suggestion: "Ensure API returns 'Content-Type' header set to 'application/json' or a standard JSON media type.",
        },
      ],
    };
  }
  const ctype = res.headers.get("content-type");
  if (!ctype) {
    return {
      name: "Content-Type",
      passed: false,
      score: 0,
      grade: "F",
      severity: 80,
      explanation: "Content-Type header is missing.",
      details: {},
      recommendations: [
        {
          issue: "Missing Content-Type header",
          severity: 80,
          suggestion: "Include 'Content-Type' header with value 'application/json' or compatible media type.",
        },
      ],
    };
  }

  const mediaType = ctype.split(";")[0].trim().toLowerCase();
  const passed = mediaType === "application/json" || mediaType === "application/json; charset=utf-8" || mediaType.endsWith("+json");
  const score = passed ? 100 : 50;
  const grade = scoreToGrade(score);
  return {
    name: "Content-Type",
    passed,
    score,
    grade,
    severity: 80,
    explanation: passed
      ? `Content-Type header correctly uses '${mediaType}'.`
      : `Content-Type header uses non-standard media type '${mediaType}', prefer 'application/json'.`,
    details: { contentType: ctype },
    recommendations: passed
      ? []
      : [
          {
            issue: `Non-standard Content-Type: ${mediaType}`,
            severity: 60,
            suggestion: "Use 'application/json' or compatible JSON media types for response.",
          },
        ],
  };
}

// Validate JSON response format (must parse json)
async function checkJsonFormat(res: Response | null): Promise<StandardComplianceCheck> {
  if (!res) {
    return {
      name: "JSON Format",
      passed: false,
      score: 0,
      grade: "F",
      severity: 100,
      explanation: "No response to validate JSON format.",
      details: {},
      recommendations: [
        {
          issue: "No response body",
          severity: 100,
          suggestion: "Ensure API response body is valid JSON.",
        },
      ],
    };
  }
  try {
    // Clone response to parse JSON without consuming main Response
    const data = await res.clone().json();
    // Validate data type (must be object or array)
    if (typeof data !== "object" || data === null) {
      return {
        name: "JSON Format",
        passed: false,
        score: 0,
        grade: "F",
        severity: 100,
        explanation: "Response JSON is not an object or array.",
        details: {},
        recommendations: [
          {
            issue: "Response JSON root is not an object or array",
            severity: 100,
            suggestion: "Return well-formed JSON objects or arrays as API response.",
          },
        ],
      };
    }
    return {
      name: "JSON Format",
      passed: true,
      score: 100,
      grade: "A+",
      severity: 0,
      explanation: "Response contains valid JSON format.",
      details: {},
      recommendations: [],
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      name: "JSON Format",
      passed: false,
      score: 0,
      grade: "F",
      severity: 100,
      explanation: `Failed to parse JSON: ${msg}`,
      details: { error: msg },
      recommendations: [
        {
          issue: "Invalid JSON response",
          severity: 100,
          suggestion: "Ensure API returns valid JSON-encoded response bodies.",
        },
      ],
    };
  }
}

// Check for standard cache-control header recommended for APIs
async function checkCacheControl(res: Response | null): Promise<StandardComplianceCheck> {
  if (!res) {
    return {
      name: "Cache-Control",
      passed: false,
      score: 50,
      grade: "C",
      severity: 50,
      explanation: "No response to check Cache-Control header.",
      details: {},
      recommendations: [
        {
          issue: "Missing Cache-Control header",
          severity: 50,
          suggestion: "Include Cache-Control header with appropriate caching directives, e.g., 'no-store' for dynamic APIs.",
        },
      ],
    };
  }
  const cc = res.headers.get("cache-control");
  if (!cc) {
    return {
      name: "Cache-Control",
      passed: false,
      score: 50,
      grade: "C",
      severity: 50,
      explanation: "Cache-Control header is missing; may lead to unintended caching.",
      details: {},
      recommendations: [
        {
          issue: "Missing Cache-Control header",
          severity: 50,
          suggestion: "Add Cache-Control header with directives appropriate to your API (e.g., 'no-store', 'no-cache', 'max-age').",
        },
      ],
    };
  }
  // We consider cache control present as passing but encourage restrictive/no-store for APIs
  const ccLower = cc.toLowerCase();
  const recommendedDirectives = ["no-store", "no-cache"];
  const hasRecommended = recommendedDirectives.some((d) => ccLower.includes(d));
  const score = hasRecommended ? 100 : 60;
  const grade = scoreToGrade(score);
  const explanation = hasRecommended
    ? "Cache-Control header present with recommended directives to prevent stale data."
    : "Cache-Control header present but does not use recommended directives such as 'no-store' or 'no-cache'.";
  const recommendations = hasRecommended
    ? []
    : [
        {
          issue: "Cache-Control header directive",
          severity: 30,
          suggestion: "Consider adding 'no-store' or 'no-cache' to Cache-Control to prevent stale responses in APIs.",
        },
      ];

  return {
    name: "Cache-Control",
    passed: true,
    score,
    grade,
    severity: 30,
    explanation,
    details: { cacheControl: cc },
    recommendations,
  };
}

// Check response JSON envelope shape conventions (e.g., has 'status' and 'data' keys)
async function checkJsonEnvelope(res: Response | null): Promise<StandardComplianceCheck> {
  if (!res) {
    return {
      name: "JSON Envelope",
      passed: false,
      score: 0,
      grade: "F",
      severity: 100,
      explanation: "No response to validate JSON envelope.",
      details: {},
      recommendations: [
        {
          issue: "No response body",
          severity: 100,
          suggestion: "Ensure API response follows common envelope format with 'status' and 'data' keys.",
        },
      ],
    };
  }

  try {
    const body = await res.clone().json();
    const hasStatus = typeof body.status === "string";
    const hasData = body.data !== undefined;
    const passed = hasStatus && hasData;
    const score = passed ? 100 : 0;
    const grade = scoreToGrade(score);

    const explanation = passed
      ? "Response follows standard JSON envelope with 'status' and 'data' keys."
      : "Response lacks expected 'status' or 'data' keys in JSON envelope.";

    const recommendations: Recommendation[] = [];
    if (!hasStatus) {
      recommendations.push({
        issue: "Missing 'status' key in JSON response",
        severity: 90,
        suggestion: "Include a string 'status' key such as 'ok' or 'error' for uniform client parsing.",
      });
    }
    if (!hasData) {
      recommendations.push({
        issue: "Missing 'data' key in JSON response",
        severity: 90,
        suggestion: "Include a 'data' key containing your primary response payload.",
      });
    }

    return {
      name: "JSON Envelope",
      passed,
      score,
      grade,
      severity: 100,
      explanation,
      details: { exampleKeys: Object.keys(body) },
      recommendations,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      name: "JSON Envelope",
      passed: false,
      score: 0,
      grade: "F",
      severity: 100,
      explanation: `Failed to parse JSON for envelope validation: ${msg}`,
      details: { error: msg },
      recommendations: [
        {
          issue: "Invalid JSON response",
          severity: 100,
          suggestion: "Return valid JSON-structured response matching the envelope format.",
        },
      ],
    };
  }
}

// Run all compliance checks in parallel
export async function analyzeApiStandardCompliance(rawUrl: string): Promise<ApiComplianceResult | { error: string }> {
  const checkUrl = validateExternalUrl(rawUrl);
  if ("error" in checkUrl) {
    return { error: checkUrl.error };
  }
  const url = checkUrl.url.toString();

  let fetchResponse: Response | null = null;
  let fetchError: string | null = null;
  try {
    fetchResponse = await safeFetch(url, {
      timeoutMs: 10000,
      headers: { "User-Agent": "api-standard-compliance/1.0 apimesh.xyz" },
    });
  } catch (e: unknown) {
    fetchError = e instanceof Error ? e.message : String(e);
    // return early error
    return { error: fetchError };
  }

  // Run all checks in parallel
  const checksPromises = [
    checkStatusCode(fetchResponse),
    checkContentType(fetchResponse),
    checkJsonFormat(fetchResponse),
    checkCacheControl(fetchResponse),
    checkJsonEnvelope(fetchResponse),
  ];

  const checks = await Promise.all(checksPromises);

  // Calculate overall score (weighted average)
  let totalWeight = 0;
  let weightedScore = 0;
  for (const check of checks) {
    const weight = check.severity;
    totalWeight += weight;
    weightedScore += check.score * weight;
  }
  const overallScore = totalWeight > 0 ? Math.round(weightedScore / totalWeight) : 0;
  const overallGrade = scoreToGrade(overallScore);

  // Aggregate all recommendations, uniqueness by issue
  const seenIssues = new Set<string>();
  const recommendations: Recommendation[] = [];
  for (const check of checks) {
    for (const rec of check.recommendations) {
      if (!seenIssues.has(rec.issue)) {
        recommendations.push(rec);
        seenIssues.add(rec.issue);
      }
    }
  }

  const checkedAt = new Date().toISOString();

  return {
    url,
    overallScore,
    overallGrade,
    checks,
    recommendations,
    checkedAt,
  };
}
