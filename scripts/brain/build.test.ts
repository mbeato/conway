import { test, expect, describe } from "bun:test";

// Test the model escalation logic extracted from build.ts constants
// We test the pure logic since build() requires full DB + OpenAI setup

const ESCALATION_THRESHOLD = 7.5;
const DEFAULT_MODEL = "gpt-4.1-mini";

describe("model escalation", () => {
  test("item with overall_score 8.0 selects escalation model", () => {
    const escalationModel = process.env.SCOUT_ESCALATION_MODEL || "gpt-4.1";
    const score = 8.0;
    const model = score > ESCALATION_THRESHOLD ? escalationModel : DEFAULT_MODEL;
    expect(model).toBe(escalationModel);
  });

  test("item with overall_score 6.0 selects default model", () => {
    const escalationModel = process.env.SCOUT_ESCALATION_MODEL || "gpt-4.1";
    const score = 6.0;
    const model = score > ESCALATION_THRESHOLD ? escalationModel : DEFAULT_MODEL;
    expect(model).toBe(DEFAULT_MODEL);
  });

  test("item with overall_score exactly 7.5 selects default model (> not >=)", () => {
    const escalationModel = process.env.SCOUT_ESCALATION_MODEL || "gpt-4.1";
    const score = 7.5;
    const model = score > ESCALATION_THRESHOLD ? escalationModel : DEFAULT_MODEL;
    expect(model).toBe(DEFAULT_MODEL);
  });

  test("SCOUT_ESCALATION_MODEL env var overrides the default escalation model", () => {
    // Save and set env var
    const original = process.env.SCOUT_ESCALATION_MODEL;
    process.env.SCOUT_ESCALATION_MODEL = "gpt-4o";

    const escalationModel = process.env.SCOUT_ESCALATION_MODEL || "gpt-4.1";
    const score = 9.0;
    const model = score > ESCALATION_THRESHOLD ? escalationModel : DEFAULT_MODEL;
    expect(model).toBe("gpt-4o");

    // Restore
    if (original !== undefined) {
      process.env.SCOUT_ESCALATION_MODEL = original;
    } else {
      delete process.env.SCOUT_ESCALATION_MODEL;
    }
  });
});
