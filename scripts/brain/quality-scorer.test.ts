import { test, expect, describe } from "bun:test";
import { scoreQuality, type QualityScore } from "./quality-scorer";
import { join } from "path";

interface GeneratedFile {
  path: string;
  content: string;
}

// ---------- Fixtures ----------

const HIGH_QUALITY_FILES: GeneratedFile[] = [
  {
    path: "index.ts",
    content: `
import { Hono } from "hono";
import { safeFetch, readBodyCapped } from "../../shared/ssrf";

const app = new Hono();

interface AnalysisResult {
  url: string;
  severity: number;
  score: number;
  grade: string;
  explanation: string;
  recommendations: string[];
  protocol_version: string;
  certificate_valid: boolean;
  headers_present: string[];
  issues_found: string[];
}

/** Performs deep SSL/TLS analysis on the target URL */
app.get("/", (c) => c.json({
  api: "ssl-check",
  status: "healthy",
  docs: {
    endpoints: { "/check": "Analyze SSL configuration" },
    parameters: { url: "Target URL to analyze" },
  },
  pricing: "$0.005 per call via x402",
  examples: {
    request: "GET /check?url=https://example.com",
    response: { severity: 85, grade: "A", explanation: "Strong SSL configuration" },
  },
}));

app.get("/check", async (c) => {
  const url = c.req.query("url");
  if (!url) {
    return c.json({ error: "Missing ?url= parameter" }, 400);
  }

  try {
    const [certRes, headerRes] = await Promise.all([
      safeFetch(url, { signal: AbortSignal.timeout(10000) }),
      safeFetch(url, { signal: AbortSignal.timeout(10000) }),
    ]);
    const certBody = await readBodyCapped(certRes, 50000);
    const headerBody = await readBodyCapped(headerRes, 50000);

    const result: AnalysisResult = {
      url,
      severity: 85,
      score: 92,
      grade: "A",
      explanation: "Strong SSL configuration with modern cipher suites",
      recommendations: ["Enable HSTS preload", "Add CAA records"],
      protocol_version: "TLSv1.3",
      certificate_valid: true,
      headers_present: ["Strict-Transport-Security"],
      issues_found: [],
    };

    return c.json({ status: "ok", data: result, meta: { timestamp: Date.now(), duration_ms: 120, api_version: "1.0" } });
  } catch (e: any) {
    if (e.name === "TimeoutError") {
      return c.json({ error: "Request timed out", detail: e.message }, 504);
    }
    return c.json({ error: "Analysis failed", detail: e.message }, 500);
  }
});

export default app;
`,
  },
];

const LOW_QUALITY_FILES: GeneratedFile[] = [
  {
    path: "index.ts",
    content: `
import { Hono } from "hono";

const app = new Hono();

interface Result {
  url: string;
  ok: boolean;
}

app.get("/", (c) => c.json({ api: "basic-check" }));

app.get("/check", async (c) => {
  try {
    const res = await fetch("https://example.com");
  } catch (e) {}

  return c.json({ url: "test", ok: true });
});

export default app;
`,
  },
];

const ENVELOPE_FILES: GeneratedFile[] = [
  {
    path: "index.ts",
    content: `
import { Hono } from "hono";
const app = new Hono();

interface SimpleResult { url: string; ok: boolean; }

app.get("/check", async (c) => {
  const result: SimpleResult = { url: "test", ok: true };
  return c.json({ status: "ok", data: result, meta: { timestamp: Date.now() } });
});
export default app;
`,
  },
];

const NO_ENVELOPE_FILES: GeneratedFile[] = [
  {
    path: "index.ts",
    content: `
import { Hono } from "hono";
const app = new Hono();

interface SimpleResult { url: string; ok: boolean; }

app.get("/check", async (c) => {
  return c.json({ url: "test", ok: true });
});
export default app;
`,
  },
];

// ---------- Tests ----------

test("high quality files score >= 75 overall", () => {
  const result = scoreQuality(HIGH_QUALITY_FILES);
  expect(result.overall).toBeGreaterThanOrEqual(75);
  expect(result.pass).toBe(true);
});

test("low quality files score < 60 and fail", () => {
  const result = scoreQuality(LOW_QUALITY_FILES);
  expect(result.overall).toBeLessThan(60);
  expect(result.pass).toBe(false);
});

test("low quality feedback is actionable", () => {
  const result = scoreQuality(LOW_QUALITY_FILES);
  expect(result.feedback.length).toBeGreaterThan(0);
  // Should mention specific counts or actionable items, not generic messages
  expect(result.feedback).toMatch(/\d|field|catch|timeout|docs/i);
});

test("empty catch blocks don't count", () => {
  const result = scoreQuality(LOW_QUALITY_FILES);
  // LOW_QUALITY has an empty catch block -- error_handling should be low
  expect(result.error_handling).toBeLessThan(40);
});

test("richness detects envelope pattern", () => {
  const withEnvelope = scoreQuality(ENVELOPE_FILES);
  const withoutEnvelope = scoreQuality(NO_ENVELOPE_FILES);
  expect(withEnvelope.richness).toBeGreaterThan(withoutEnvelope.richness);
});

test("weights sum correctly", () => {
  const result = scoreQuality(HIGH_QUALITY_FILES);
  const expected =
    result.richness * 0.3 +
    result.error_handling * 0.25 +
    result.documentation * 0.2 +
    result.performance * 0.25;
  expect(Math.abs(result.overall - expected)).toBeLessThan(1);
});

// ---------- Calibration against real APIs ----------

describe("calibration against real APIs", () => {
  test("security-headers scores >= 25 overall with >= 30 richness", async () => {
    // Hand-built APIs predate envelope/performance requirements, so overall is low
    // but richness and docs should be reasonable
    const securityHeadersIndex = await Bun.file(
      join(import.meta.dir, "../../apis/security-headers/index.ts")
    ).text();
    const files = [{ path: "index.ts", content: securityHeadersIndex }];
    const result = scoreQuality(files);
    console.log("security-headers calibration:", JSON.stringify(result));
    expect(result.overall).toBeGreaterThanOrEqual(25);
    expect(result.richness).toBeGreaterThanOrEqual(30);
  });

  test("seo-audit scores >= 25 overall with >= 30 richness", async () => {
    // Hand-built APIs predate envelope/performance requirements
    const seoAuditIndex = await Bun.file(
      join(import.meta.dir, "../../apis/seo-audit/index.ts")
    ).text();
    const files = [{ path: "index.ts", content: seoAuditIndex }];
    const result = scoreQuality(files);
    console.log("seo-audit calibration:", JSON.stringify(result));
    expect(result.overall).toBeGreaterThanOrEqual(25);
    expect(result.richness).toBeGreaterThanOrEqual(30);
  });

  test("60 threshold is achievable with envelope", async () => {
    const securityHeadersIndex = await Bun.file(
      join(import.meta.dir, "../../apis/security-headers/index.ts")
    ).text();

    // Append envelope + docs + performance patterns to simulate a well-structured API
    const enhanced = securityHeadersIndex + `
// Enhanced with response envelope
interface EnvelopeResponse {
  status: string;
  data: AnalysisResult;
  meta: { timestamp: string; duration_ms: number; api_version: string };
}

/** Main analysis endpoint with full envelope */
const start = performance.now();
const [res1, res2] = await Promise.all([
  safeFetch(url, { signal: AbortSignal.timeout(10000) }),
  safeFetch(url, { signal: AbortSignal.timeout(10000) }),
]);
const body = await readBodyCapped(res1, 50000);
const duration_ms = Math.round(performance.now() - start);
return c.json({ status: "ok", data: result, meta: { timestamp: new Date().toISOString(), duration_ms, api_version: "1.0.0" } });

// Documentation
app.get("/", (c) => c.json({
  api: "security-headers",
  status: "healthy",
  version: "1.0.0",
  docs: {
    endpoints: [{ method: "GET", path: "/analyze", description: "Analyze security headers" }],
    parameters: [{ name: "url", type: "string", required: true }],
    examples: [{ request: "GET /analyze?url=https://example.com", response: { severity: 85 } }],
  },
  pricing: { price: "$0.005", protocol: "x402" },
}));
`;

    const files = [{ path: "index.ts", content: enhanced }];
    const result = scoreQuality(files);
    console.log("security-headers+envelope calibration:", JSON.stringify(result));
    expect(result.overall).toBeGreaterThanOrEqual(60);
  });
});
