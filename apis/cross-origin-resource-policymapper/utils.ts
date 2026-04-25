import { Grade, CorsHeaderAnalysis, Recommendation } from "./types";

export function gradeFromScore(score: number): Grade {
  if (score >= 90) return "A+";
  if (score >= 80) return "A";
  if (score >= 65) return "B";
  if (score >= 50) return "C";
  if (score >= 30) return "D";
  return "F";
}

export function severityFromScore(score: number): number {
  if (score >= 90) return 10;
  if (score >= 80) return 20;
  if (score >= 65) return 40;
  if (score >= 50) return 60;
  if (score >= 30) return 80;
  return 100;
}

export function combineHeaderGrades(analyses: CorsHeaderAnalysis[]): { score: number; grade: Grade } {
  if (analyses.length === 0) return { score: 0, grade: "F" };

  // Weighted scoring: headers with problems drag score down
  // Start from 100 and reduce per issue severity and presence
  let baseScore = 100;

  for (const h of analyses) {
    baseScore -= 10 * (100 - h.severityScore) / 100; // weight
  }

  if (baseScore < 0) baseScore = 0;

  return { score: Math.round(baseScore), grade: gradeFromScore(baseScore) };
}

export function mergeRecommendations(recs: Recommendation[][]): Recommendation[] {
  const map = new Map<string, Recommendation>();
  for (const recList of recs) {
    for (const rec of recList) {
      const key = rec.issue + rec.suggestion;
      const exists = map.get(key);
      if (!exists || rec.severity > exists.severity) {
        map.set(key, rec);
      }
    }
  }
  return Array.from(map.values()).sort((a, b) => b.severity - a.severity);
}
