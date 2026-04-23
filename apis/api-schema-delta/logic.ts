import { safeFetch } from "../../shared/ssrf";

export interface SchemaFetchResult {
  url: string;
  raw: string;
  parsed: any;
  type: "rest" | "graphql";
  error?: string;
}

export interface SchemaDiff {
  urlBase: string;
  urlCompare: string;
  added: string[];
  removed: string[];
  changed: string[];
  details: string;
  score: number; // 0-100 similarity score
}

export interface SchemaDeltaResult {
  urls: string[];
  comparisons: SchemaDiff[];
  overallScore: number; // 0-100
  grade: string; // A-F
  recommendations: Recommendation[];
}

export interface Recommendation {
  issue: string;
  severity: number; // 0-100
  suggestion: string;
}

export interface InfoResponse {
  api: string;
  status: string;
  version: string;
  docs: {
    endpoints: EndpointDoc[];
    parameters: ParameterDoc[];
    examples: string[];
  };
  pricing: {
    description: string;
    price: string;
  };
}

export interface EndpointDoc {
  method: string;
  path: string;
  description: string;
  parameters: ParameterDoc[];
  exampleResponse: any;
}

export interface ParameterDoc {
  name: string;
  type: string;
  description: string;
  required?: boolean;
  enum?: string[];
  minItems?: number;
  maxItems?: number;
  in?: string;
}

// Helper: parse REST JSON schema text
export function parseJsonSchema(raw: string): any {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// Helper: parse GraphQL SDL text into AST (simple parse)
// Limit complexity: return string array of type and field signatures
export function parseGraphQLSchema(raw: string): Record<string, string[]> {
  const types: Record<string, string[]> = {};

  // Basic parsing of type definitions
  // Match type X { ... } and interface X {...} and enum X { ... }
  const lines = raw.split(/\r?\n/);
  let currentType = "";
  let collecting = false;
  let fields: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!collecting) {
      const m = trimmed.match(/^(type|interface|enum)\s+(\w+)/);
      if (m) {
        currentType = m[2];
        fields = [];
        collecting = true;
      }
    } else {
      if (trimmed.startsWith("}")) {
        // end collecting
        if (currentType) {
          types[currentType] = fields;
        }
        currentType = "";
        collecting = false;
      } else if (trimmed.length > 0 && !trimmed.startsWith("#")) {
        fields.push(trimmed);
      }
    }
  }
  return types;
}

// Fetch multiple schemas in parallel safely
// Includes timeout and error handling
export async function fetchMultipleSchemas(
  urls: string[],
  type: "rest" | "graphql"
): Promise<SchemaFetchResult[]> {
  const fetches = urls.map(async (url) => {
    try {
      const res = await safeFetch(url, {
        timeoutMs: 10000,
        headers: {
          "User-Agent": "api-schema-delta/1.0 apimesh.xyz",
          Accept: type === "rest" ? "application/json" : "text/plain",
        },
      });
      if (!res.ok) {
        return {
          url,
          raw: "",
          parsed: null,
          type,
          error: `HTTP ${res.status} status when fetching`,
        };
      }

      const raw = await res.text();
      let parsed: any = null;
      if (type === "rest") {
        parsed = parseJsonSchema(raw);
        if (!parsed) {
          return {
            url,
            raw,
            parsed: null,
            type,
            error: "Failed to parse JSON schema",
          };
        }
      } else {
        parsed = parseGraphQLSchema(raw);
        if (Object.keys(parsed).length === 0) {
          return {
            url,
            raw,
            parsed: null,
            type,
            error: "Failed to parse GraphQL SDL schema",
          };
        }
      }

      return { url, raw, parsed, type };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        url,
        raw: "",
        parsed: null,
        type,
        error: msg,
      };
    }
  });

  return Promise.all(fetches);
}

// Utility: deep compare two REST JSON schemas
// Return simple diff report and similarity score
function compareRestSchemas(
  base: any,
  compare: any,
  path = ""
): { added: string[]; removed: string[]; changed: string[] } {
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];

  if (typeof base !== typeof compare) {
    changed.push(path || "<root>");
    return { added, removed, changed };
  }

  if (typeof base !== "object" || base === null) {
    if (base !== compare) {
      changed.push(path || "<root>");
    }
    return { added, removed, changed };
  }

  // Both are objects or arrays
  if (Array.isArray(base) && Array.isArray(compare)) {
    // Arrays: compare length and elements
    if (base.length !== compare.length) {
      changed.push(path || "<array>");
    } else {
      for (let i = 0; i < base.length; i++) {
        const subDiff = compareRestSchemas(
          base[i],
          compare[i],
          path + `[${i}]`
        );
        added.push(...subDiff.added);
        removed.push(...subDiff.removed);
        changed.push(...subDiff.changed);
      }
    }
    return { added, removed, changed };
  }

  // Plain objects
  if (!Array.isArray(base) && !Array.isArray(compare)) {
    const baseKeys = Object.keys(base);
    const compareKeys = Object.keys(compare);

    for (const key of compareKeys) {
      if (!(key in base)) {
        added.push(path ? `${path}.${key}` : key);
      } else {
        const subDiff = compareRestSchemas(
          base[key],
          compare[key],
          path ? `${path}.${key}` : key
        );
        added.push(...subDiff.added);
        removed.push(...subDiff.removed);
        changed.push(...subDiff.changed);
      }
    }

    for (const key of baseKeys) {
      if (!(key in compare)) {
        removed.push(path ? `${path}.${key}` : key);
      }
    }
    return { added, removed, changed };
  }

  // Fallback
  return { added, removed, changed };
}

// Utility: compare two GraphQL parsed schemas
// parsed is Record<string, string[]> (type to lines)
// Return diffs of fields
function compareGraphQLSchemas(
  base: Record<string, string[]>,
  compare: Record<string, string[]>
): {
  added: string[];
  removed: string[];
  changed: string[];
} {
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];

  // Find added types
  for (const key of Object.keys(compare)) {
    if (!(key in base)) {
      added.push(`type:${key}`);
    } else {
      // Compare fields
      const baseFields = base[key];
      const compareFields = compare[key];
      const baseSet = new Set(baseFields);
      const compareSet = new Set(compareFields);

      for (const f of compareFields) {
        if (!baseSet.has(f)) {
          added.push(`type:${key} field:${f}`);
        }
      }
      for (const f of baseFields) {
        if (!compareSet.has(f)) {
          removed.push(`type:${key} field:${f}`);
        }
      }

      // Check changed fields by basic difference (could be enhanced)
      const commonFields = baseFields.filter((f) => compareSet.has(f));
      if (commonFields.length !== baseFields.length || commonFields.length !== compareFields.length) {
        changed.push(`type:${key}`);
      }
    }
  }

  for (const key of Object.keys(base)) {
    if (!(key in compare)) {
      removed.push(`type:${key}`);
    }
  }

  return { added, removed, changed };
}

// Main compare function
// Return structured comparison including diffs and score
export function compareSchemas(
  schemaResults: SchemaFetchResult[],
  type: "rest" | "graphql"
): {
  diffs: SchemaDiff[];
  overallScore: number;
} {
  const diffs: SchemaDiff[] = [];

  // Pairwise comparisons
  // Compare each later schema against each earlier one
  for (let i = 0; i < schemaResults.length; i++) {
    for (let j = i + 1; j < schemaResults.length; j++) {
      const base = schemaResults[i];
      const compare = schemaResults[j];

      if (base.error || compare.error) {
        // Skip comparison if either failed
        continue;
      }

      let added: string[] = [];
      let removed: string[] = [];
      let changed: string[] = [];
      let details = "";
      let similarity = 100;

      if (type === "rest") {
        ({ added, removed, changed } = compareRestSchemas(base.parsed, compare.parsed));

        // Scoring roughly: similarity based on net changes count and total keys approx
        const totalKeys = Math.max(
          Object.keys(base.parsed ?? {}).length,
          Object.keys(compare.parsed ?? {}).length,
          1
        );
        const totalChanges = added.length + removed.length + changed.length;
        similarity = Math.max(0, Math.round(100 - (totalChanges * 100) / totalKeys));

        details = `Added keys: ${added.length}, Removed keys: ${removed.length}, Changed keys: ${changed.length}`;
      } else {
        ({ added, removed, changed } = compareGraphQLSchemas(base.parsed, compare.parsed));

        const baseTypes = Object.keys(base.parsed).length || 1;
        const totalChanges = added.length + removed.length + changed.length;
        similarity = Math.max(0, Math.round(100 - (totalChanges * 50) / baseTypes));

        details = `Added types/fields: ${added.length}, Removed types/fields: ${removed.length}, Changed types: ${changed.length}`;
      }

      diffs.push({
        urlBase: base.url,
        urlCompare: compare.url,
        added,
        removed,
        changed,
        details,
        score: similarity,
      });
    }
  }

  // Aggregate overall score based on pairwise scores
  const scores = diffs.map((d) => d.score);
  const overallScore = scores.length > 0 ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 100;

  return { diffs, overallScore };
}

// Convert numeric score (0-100) to letter grade
export function gradeScoreToLetter(score: number): string {
  if (score >= 90) return "A";
  if (score >= 80) return "B";
  if (score >= 65) return "C";
  if (score >= 50) return "D";
  return "F";
}

// Generate recommendations from comparison result
export function generateRecommendations(result: {diffs: SchemaDiff[]; overallScore: number;}): Recommendation[] {
  const recs: Recommendation[] = [];

  // If no comparisons, no recs
  if (result.diffs.length === 0) {
    recs.push({
      issue: "Insufficient data",
      severity: 70,
      suggestion: "Provide at least two valid schema URLs for meaningful comparison and analysis.",
    });
    return recs;
  }

  // Check overall score
  if (result.overallScore < 50) {
    recs.push({
      issue: "Low schema compatibility",
      severity: 95,
      suggestion: "Schemas differ significantly; review versioning and backward compatibility policies.",
    });
  } else if (result.overallScore < 80) {
    recs.push({
      issue: "Moderate schema changes",
      severity: 70,
      suggestion:
        "Schemas have some differences; consider communicating breaking changes clearly and updating clients accordingly.",
    });
  } else {
    recs.push({
      issue: "Good schema compatibility",
      severity: 20,
      suggestion: "Schemas are mostly consistent; maintain versioning discipline.",
    });
  }

  // Per comparison recommendations
  for (const diff of result.diffs) {
    if (diff.added.length > 0) {
      recs.push({
        issue: "New API elements added",
        severity: 50,
        suggestion: `Review new additions between ${diff.urlBase} and ${diff.urlCompare} for client impact and deprecations.`,
      });
    }
    if (diff.removed.length > 0) {
      recs.push({
        issue: "API elements removed",
        severity: 90,
        suggestion: `Detected removals between ${diff.urlBase} and ${diff.urlCompare}; ensure clients are updated and migrations are in place.`,
      });
    }
    if (diff.changed.length > 0) {
      recs.push({
        issue: "API elements changed",
        severity: 80,
        suggestion: `Review modifications between ${diff.urlBase} and ${diff.urlCompare} for compatibility and testing.`,
      });
    }
  }

  return recs;
}
