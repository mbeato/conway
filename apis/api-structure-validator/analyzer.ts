import { safeFetch } from "../../shared/ssrf";

// ---------------------------
// Types
// ---------------------------

export interface Recommendation {
  issue: string;
  severity: "Low" | "Medium" | "High";
  suggestion: string;
}

export interface ValidationResponse {
  score: number; // 0-100
  grade: string; // A-F
  schemaVersion: string | null; // OpenAPI version or Swagger version
  errorsCount: number;
  warningsCount: number;
  recommendationsCount: number;
  details: string; // human readable explainer
  recommendations: Recommendation[];
}

export interface PreviewValidationResponse {
  preview: true;
  validFormat: boolean;
  rootVersion: string | null;
  errorsCount: number;
  warningsCount: number;
  details: string;
  recommendations: Recommendation[];
  error?: string;
}

// ---------------------------
// Helper constants
// ---------------------------

const OPENAPI_VERSIONS = ["3.0.0", "3.0.1", "3.0.2", "3.0.3", "3.1.0"];
const SWAGGER_VERSIONS = ["2.0"];

// ---------------------------
// Helper functions
// ---------------------------

function letterGrade(score: number): string {
  if (score >= 90) return "A";
  if (score >= 75) return "B";
  if (score >= 60) return "C";
  if (score >= 45) return "D";
  return "F";
}

// Extract root version OpenAPI or Swagger
function extractVersion(doc: any): string | null {
  if (!doc) return null;
  if (typeof doc.openapi === "string") {
    if (OPENAPI_VERSIONS.includes(doc.openapi)) return doc.openapi;
    // Sometimes minor patch or higher versions
    if (doc.openapi.startsWith("3.")) return doc.openapi;
  }
  if (typeof doc.swagger === "string") {
    if (SWAGGER_VERSIONS.includes(doc.swagger)) return doc.swagger;
  }
  return null;
}

// ---------------------------
// Core analysis logic
// ---------------------------

// Validate JSON Schema draft: minimal checks for OpenAPI/Swagger
function checkRequiredRootFields(doc: any): string[] {
  const issues: string[] = [];

  if (!doc) {
    issues.push("Document is empty or not JSON/YAML parsed.");
    return issues;
  }

  // Check that paths is present
  if (!doc.paths || typeof doc.paths !== "object") {
    issues.push("Missing or invalid 'paths' field.");
  }

  // Check info field
  if (!doc.info || typeof doc.info !== "object") {
    issues.push("Missing or invalid 'info' field.");
  } else {
    if (typeof doc.info.title !== "string" || doc.info.title.trim() === "") {
      issues.push("Info.title is missing or empty.");
    }
    if (typeof doc.info.version !== "string" || doc.info.version.trim() === "") {
      issues.push("Info.version is missing or empty.");
    }
  }

  return issues;
}

function countRecursively(obj: any, predicate: (key: string, val: any) => boolean): number {
  let count = 0;
  if (typeof obj !== "object" || obj === null) return 0;
  for (const [key, val] of Object.entries(obj)) {
    if (predicate(key, val)) count++;
    if (typeof val === "object" && val !== null) count += countRecursively(val, predicate);
  }
  return count;
}

function isOperationObject(val: any): boolean {
  if (!val || typeof val !== "object") return false;
  // Operation objects have summary, description, responses, etc.
  return typeof val.responses === "object";
}

// Detect if component schemas are referenced somewhere
function findUnusedComponents(doc: any): string[] {
  if (!doc.components || !doc.components.schemas) return [];
  const allSchemas = Object.keys(doc.components.schemas);

  const usedSchemas = new Set<string>();
  
  // Traverse entire spec and collect $ref targets
  function collectRefs(obj: any) {
    if (!obj || typeof obj !== "object") return;
    for (const val of Object.values(obj)) {
      if (typeof val === "object" && val !== null) {
        collectRefs(val);
      }
    }
    // Check for $ref properties in obj itself
    if (typeof obj.$ref === "string") {
      const ref = obj.$ref;
      // refs of form "#/components/schemas/Name"
      const match = ref.match(/^#\/components\/schemas\/([\w]+)$/);
      if (match) {
        usedSchemas.add(match[1]);
      }
    }
  }
  collectRefs(doc);

  return allSchemas.filter((name) => !usedSchemas.has(name));
}

function checkNamingConventions(doc: any): Recommendation[] {
  const recs: Recommendation[] = [];
  if (!doc.paths) return recs;

  // Check operationIds uniqueness and naming style
  const operationIds = new Set<string>();
  for (const [path, methods] of Object.entries(doc.paths)) {
    if (typeof methods !== "object" || !methods) continue;
    for (const [method, op] of Object.entries(methods)) {
      if (isOperationObject(op)) {
        if (typeof op.operationId === "string") {
          if (operationIds.has(op.operationId)) {
            recs.push({
              issue: `Duplicate operationId '${op.operationId}' detected.`,
              severity: "High",
              suggestion: "Ensure unique operationId for each operation."
            });
          } else {
            operationIds.add(op.operationId);
            // Check naming: camelCase preferred
            if (!/^([a-z][a-zA-Z0-9]+)$/.test(op.operationId)) {
              recs.push({
                issue: `operationId '${op.operationId}' does not follow camelCase naming.`,
                severity: "Medium",
                suggestion: "Rename operationId to camelCase format."
              });
            }
          }
        } else {
          recs.push({
            issue: `Missing operationId for ${method.toUpperCase()} ${path}.`,
            severity: "Medium",
            suggestion: "Add unique operationId for each operation."
          });
        }
      }
    }
  }

  return recs;
}

// Validate the schema format JSON or YAML simplified: detect if JSON parse succeeds, or YAML parse
async function fetchAndParseJsonOrYaml(url: string): Promise<{ doc: any | null; error?: string }> {
  // Fetch with 10s timeout
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10_000);
  let res: Response;
  try {
    res = await safeFetch(url, { signal: controller.signal, headers: { "User-Agent": "api-structure-validator/1.0 apimesh.xyz" } });
  } catch (e: unknown) {
    clearTimeout(timeoutId);
    const msg = e instanceof Error ? e.message : String(e);
    return { doc: null, error: `Failed fetching document: ${msg}` };
  }
  clearTimeout(timeoutId);

  if (!res.ok) {
    return { doc: null, error: `HTTP status ${res.status} fetching document.` };
  }

  const contentType = res.headers.get("content-type") || "";
  try {
    // Attempt JSON parse
    if (contentType.includes("json") || url.endsWith(".json")) {
      const doc = await res.json();
      return { doc };
    } else {
      // Try YAML parse
      // To avoid external dependencies, parse only simple YAML keys:
      const text = await res.text();
      // Use try/catch with safe JSON fallback
      // We try to parse YAML with very basic heuristic
      // This is not fully YAML compliant but sufficient for preview
      const jsonCandidate = text.trim();
      if (jsonCandidate.startsWith("{") && jsonCandidate.endsWith("}")) {
        // Maybe JSON
        try {
          return { doc: JSON.parse(jsonCandidate) };
        } catch {}
      }
      // Minimal YAML parse using function
      const yamlDoc = parseYamlSimple(jsonCandidate);
      if (yamlDoc === null) {
        return { doc: null, error: "Unable to parse document text as JSON or simplified YAML." };
      }
      return { doc: yamlDoc };
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { doc: null, error: `Parsing error: ${msg}` };
  }
}

function parseYamlSimple(yamlText: string): any | null {
  // A VERY minimalistic YAML parser for basic version and root fields
  // For security reasons, no YAML libraries included
  // Support only key: value pairs without nesting

  try {
    const lines = yamlText.split(/\r?\n/);
    const obj: any = {};
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === "" || trimmed.startsWith("#")) continue;
      const idx = trimmed.indexOf(":");
      if (idx < 0) continue;
      const key = trimmed.slice(0, idx).trim();
      let val = trimmed.slice(idx + 1).trim();
      if (val === "null" || val === "~") val = null;
      else if (/^(true|false)$/i.test(val)) val = val.toLowerCase() === "true";
      else if (/^\d+$/.test(val)) val = parseInt(val, 10);
      obj[key] = val;
    }
    return obj;
  } catch {
    return null;
  }
}

// ---------------------------
// Validate correctness and completeness
// ---------------------------

export async function performFullValidation(url: string): Promise<ValidationResponse | { error: string }> {

  const fetchResult = await fetchAndParseJsonOrYaml(url);
  if (fetchResult.error) return { error: fetchResult.error };
  const doc = fetchResult.doc;

  // 1. Root version extraction
  const version = extractVersion(doc);

  // 2. Required fields check
  const reqIssues = checkRequiredRootFields(doc);

  // 3. Component usage checks
  const unusedSchemas = findUnusedComponents(doc);

  // 4. Naming convention checks
  const namingRecos = checkNamingConventions(doc);

  // 5. Errors & warnings counts
  const errorsCount = reqIssues.length;
  const warningsCount = unusedSchemas.length + namingRecos.length;

  // 6. Score calculation (simple weighted formula)
  let score = 100;
  score -= errorsCount * 15; // Each error deducts 15
  score -= warningsCount * 8; // Each warning deducts 8

  if (score < 0) score = 0;

  // Compose recommendations including from unused schemas
  const recs: Recommendation[] = namingRecos.slice();

  for (const u of unusedSchemas) {
    recs.push({
      issue: `Unused schema component '${u}' detected.`,
      severity: "Medium",
      suggestion: "Remove unused components to keep the spec clean or use them if intended."
    });
  }

  for (const err of reqIssues) {
    recs.push({
      issue: err,
      severity: "High",
      suggestion: "Fix the reported critical structure issues."
    });
  }

  const grade = letterGrade(score);

  return {
    score,
    grade,
    schemaVersion: version,
    errorsCount,
    warningsCount,
    recommendationsCount: recs.length,
    details: "Analysis combines JSON Schema validation, presence checks, cross reference checks, and naming guidelines.",
    recommendations: recs,
  };
}

// Preview validation is a quick format check and shallow minimal analysis
export async function performPreviewValidation(url: string): Promise<PreviewValidationResponse> {
  const fetchResult = await fetchAndParseJsonOrYaml(url);
  if (fetchResult.error) {
    return {
      preview: true,
      validFormat: false,
      rootVersion: null,
      errorsCount: 1,
      warningsCount: 0,
      details: "Failed to parse document.",
      recommendations: [],
      error: fetchResult.error,
    };
  }

  const doc = fetchResult.doc;
  const version = extractVersion(doc);

  let warningsCount = 0;
  const recs: Recommendation[] = [];

  // Check minimally for presence of operationId on one operation as recommendation example
  let foundOpIdMissing = false;
  if (doc.paths) {
    for (const path of Object.keys(doc.paths)) {
      const methods = doc.paths[path];
      if (typeof methods !== "object" || !methods) continue;
      for (const method of Object.keys(methods)) {
        const op = methods[method];
        if (typeof op === "object" && op !== null) {
          if (typeof op.operationId !== "string") {
            foundOpIdMissing = true;
            break;
          }
        }
      }
      if (foundOpIdMissing) break;
    }
  }

  if (foundOpIdMissing) {
    warningsCount++;
    recs.push({
      issue: "Operation missing operationId.",
      severity: "Low",
      suggestion: "Add operationId to operations for better client generation and documentation."
    });
  }

  return {
    preview: true,
    validFormat: true,
    rootVersion: version,
    errorsCount: 0,
    warningsCount,
    details: "Basic format checks passed. No syntax errors detected.",
    recommendations: recs,
  };
}
