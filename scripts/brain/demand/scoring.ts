// scripts/brain/demand/scoring.ts
// Weighted scoring formula that prefers measured demand data over LLM estimates.

export interface ScoreInputs {
  demand_score: number;        // LLM-estimated demand (1-10)
  measured_demand: number | null; // Real search volume normalized to 1-10
  effort_score: number;        // 1-10
  competition_score: number;   // 1-10
  saturation_score: number;    // 1-10
}

/**
 * Compute an overall opportunity score using a weighted formula.
 *
 * When measured demand data is available, it receives the highest weight (0.25)
 * while the LLM-estimated demand drops to 0.10. When no measured data exists,
 * the LLM demand weight rises to 0.20 to compensate.
 *
 * Weights always sum to 1.0:
 *   With measured:    demand=0.10, measured=0.25, effort=0.15, competition=0.25, saturation=0.25
 *   Without measured: demand=0.20, measured=0,    effort=0.15, competition=0.25, saturation=0.25
 */
export function computeOverallScore(scores: ScoreInputs): number {
  const hasMeasured = scores.measured_demand !== null;
  const demandWeight = hasMeasured ? 0.10 : 0.20;
  const measuredWeight = hasMeasured ? 0.25 : 0;
  const effortWeight = 0.15;
  const competitionWeight = 0.25;
  const saturationWeight = 0.25;

  const raw = (
    scores.demand_score * demandWeight +
    (scores.measured_demand ?? 0) * measuredWeight +
    scores.effort_score * effortWeight +
    scores.competition_score * competitionWeight +
    scores.saturation_score * saturationWeight
  );
  return Math.round(raw * 100) / 100; // 2 decimal places
}

/**
 * Normalize raw search volume to a 1-10 scale using log normalization.
 *
 * Approximate mapping:
 *   0 -> 1, 100 -> ~3, 1000 -> 5.5, 10000 -> ~7, 100000 -> ~8.5, 1000000+ -> 10
 */
export function normalizeDemandSignal(searchVolume: number): number {
  if (searchVolume <= 0) return 1;
  const normalized = Math.log10(searchVolume) / Math.log10(1_000_000) * 9 + 1;
  return Math.min(10, Math.max(1, Math.round(normalized * 10) / 10));
}
