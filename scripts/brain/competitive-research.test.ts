import { test, expect } from "bun:test";
import { competitiveResearch } from "./competitive-research";

test("returns competitive context for matching category", () => {
  const result = competitiveResearch("ssl-check", "SSL analysis", "ssl-analysis");
  expect(result.length).toBeGreaterThan(0);
  expect(result).toContain("Qualys");
});

test("returns empty for unmatched category", () => {
  const result = competitiveResearch("foo", "bar", "nonexistent");
  expect(result).toBe("");
});

test("truncates to 800 chars max", () => {
  const result = competitiveResearch("ssl-check", "SSL analysis", "ssl-analysis");
  expect(result.length).toBeLessThanOrEqual(800);
});

test("includes differentiation requirements", () => {
  const result = competitiveResearch("ssl-check", "SSL analysis", "ssl-analysis");
  expect(result).toContain("DIFFERENTIATE");
});
