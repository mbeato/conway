/**
 * Competitive research for API generation prompts.
 *
 * Produces a prompt-injectable string with competitive landscape
 * and differentiation requirements based on the static competitor registry.
 * Output is capped at 800 chars (~200 tokens) to avoid prompt bloat.
 */

import { analyzeCompetitorGaps } from "./demand/competitors";

export function competitiveResearch(
  name: string,
  description: string,
  category: string
): string {
  const gaps = analyzeCompetitorGaps().filter(
    (g) => g.category === category
  );

  if (gaps.length === 0) return "";

  const competitorLines = gaps
    .map(
      (g) =>
        `- ${g.competitor_name} charges ${g.their_pricing} for: ${g.gap_description}`
    )
    .join("\n");

  const result = `COMPETITIVE LANDSCAPE:
${competitorLines}

Your API must DIFFERENTIATE by:
- Combining multiple analyses that competitors sell separately
- Providing actionable fix suggestions, not just raw data
- Including severity scoring (0-100) with letter grades`;

  // Truncate to 800 characters max to stay within ~200 token budget
  if (result.length > 800) {
    return result.slice(0, 797) + "...";
  }

  return result;
}
