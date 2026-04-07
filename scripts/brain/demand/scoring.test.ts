import { test, expect, describe } from "bun:test";
import { computeOverallScore, normalizeDemandSignal } from "./scoring";

describe("computeOverallScore", () => {
  test("with measured_demand=8, uses 0.25 measured weight and 0.10 LLM demand weight", () => {
    const result = computeOverallScore({
      demand_score: 6,
      measured_demand: 8,
      effort_score: 5,
      competition_score: 7,
      saturation_score: 8,
    });
    // 6*0.10 + 8*0.25 + 5*0.15 + 7*0.25 + 8*0.25
    // = 0.60 + 2.00 + 0.75 + 1.75 + 2.00 = 7.10
    expect(result).toBe(7.1);
  });

  test("with measured_demand=null, uses 0.20 LLM demand weight (fallback)", () => {
    const result = computeOverallScore({
      demand_score: 6,
      measured_demand: null,
      effort_score: 5,
      competition_score: 7,
      saturation_score: 8,
    });
    // 6*0.20 + 0*0 + 5*0.15 + 7*0.25 + 8*0.25
    // = 1.20 + 0 + 0.75 + 1.75 + 2.00 = 5.70
    expect(result).toBe(5.7);
  });

  test("always weights effort=0.15, competition=0.25, saturation=0.25", () => {
    // All scores at 10 with measured demand
    const result = computeOverallScore({
      demand_score: 10,
      measured_demand: 10,
      effort_score: 10,
      competition_score: 10,
      saturation_score: 10,
    });
    // 10*(0.10+0.25+0.15+0.25+0.25) = 10*1.0 = 10
    expect(result).toBe(10);
  });

  test("all zeros returns 0", () => {
    const result = computeOverallScore({
      demand_score: 0,
      measured_demand: 0,
      effort_score: 0,
      competition_score: 0,
      saturation_score: 0,
    });
    expect(result).toBe(0);
  });
});

describe("normalizeDemandSignal", () => {
  test("0 returns 1", () => {
    expect(normalizeDemandSignal(0)).toBe(1);
  });

  test("negative returns 1", () => {
    expect(normalizeDemandSignal(-100)).toBe(1);
  });

  test("5000 returns value between 1 and 10", () => {
    const result = normalizeDemandSignal(5000);
    expect(result).toBeGreaterThan(1);
    expect(result).toBeLessThanOrEqual(10);
  });

  test("1000 returns approximately 5.5 (log-scale)", () => {
    const result = normalizeDemandSignal(1000);
    // log10(1000)/log10(1000000)*9+1 = 3/6*9+1 = 5.5
    expect(result).toBe(5.5);
  });

  test("1000000 returns 10", () => {
    const result = normalizeDemandSignal(1_000_000);
    expect(result).toBe(10);
  });

  test("10000000 (above max) is capped at 10", () => {
    const result = normalizeDemandSignal(10_000_000);
    expect(result).toBe(10);
  });
});
