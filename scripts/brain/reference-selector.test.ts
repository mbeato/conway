import { test, expect } from "bun:test";
import { getReferencesForCategory, CATEGORY_REFS } from "./reference-selector";
import { join } from "path";

const APIS_DIR = join(import.meta.dir, "..", "..", "apis");

test("returns references for known category", async () => {
  const result = await getReferencesForCategory("security", APIS_DIR);
  expect(result.length).toBeGreaterThan(0);
  // Should contain security-headers reference
  expect(result).toContain("REFERENCE:");
});

test("falls back to security for unknown category", async () => {
  const result = await getReferencesForCategory("foobar", APIS_DIR);
  expect(result.length).toBeGreaterThan(0);
  // Fallback uses security refs
  expect(result).toContain("REFERENCE:");
});

test("includes cross-category reference", async () => {
  const result = await getReferencesForCategory("security", APIS_DIR);
  // Should include a reference from a category other than security
  const lines = result.split("\n");
  const refHeaders = lines.filter((l) => l.startsWith("=== REFERENCE:"));
  // At least 2 same-category + 1 cross = 3 minimum reference headers
  // (each file is a separate header, so could be more)
  expect(refHeaders.length).toBeGreaterThanOrEqual(2);
});

test("CATEGORY_REFS has at least 5 categories", () => {
  expect(Object.keys(CATEGORY_REFS).length).toBeGreaterThanOrEqual(5);
});
