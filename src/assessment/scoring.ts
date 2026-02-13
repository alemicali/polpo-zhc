import type { EvalDimension, DimensionScore } from "../core/types.js";

interface ReviewPayload {
  scores: { dimension: string; score: number; reasoning: string; evidence?: { file: string; line: number; note: string }[] }[];
  summary: string;
}

/** Default evaluation dimensions for G-Eval LLM-as-Judge. */
export const DEFAULT_DIMENSIONS: EvalDimension[] = [
  {
    name: "correctness",
    description: "Does the code work correctly? Are there logic errors, runtime exceptions, or incorrect outputs?",
    weight: 0.35,
    rubric: {
      1: "Fundamentally broken — does not run or produces entirely wrong results",
      2: "Major bugs — runs but has significant logic errors affecting core functionality",
      3: "Mostly correct — works for common cases but has edge-case bugs",
      4: "Correct — handles all specified cases properly with minor issues only",
      5: "Flawless — correct in all cases, handles edge cases and boundary conditions perfectly",
    },
  },
  {
    name: "completeness",
    description: "Are all requirements and acceptance criteria fully addressed? Nothing missing?",
    weight: 0.30,
    rubric: {
      1: "Most requirements unmet — major deliverables missing",
      2: "Partially complete — some requirements met but significant gaps remain",
      3: "Core requirements met — main functionality present but extras missing",
      4: "Nearly complete — all requirements met with minor omissions",
      5: "Fully complete — every requirement and criterion addressed comprehensively",
    },
  },
  {
    name: "code_quality",
    description: "Is the code well-structured, readable, and maintainable? Proper naming, organization, and patterns?",
    weight: 0.20,
    rubric: {
      1: "Unreadable — no structure, inconsistent style, impossible to maintain",
      2: "Poor quality — hard to follow, unclear naming, minimal organization",
      3: "Acceptable — readable but could be better structured or more idiomatic",
      4: "Good quality — clean code, clear naming, well-organized",
      5: "Excellent — exemplary structure, idiomatic patterns, easy to extend",
    },
  },
  {
    name: "edge_cases",
    description: "Are edge cases, error conditions, and boundary values handled gracefully?",
    weight: 0.15,
    rubric: {
      1: "No error handling — crashes on any unexpected input",
      2: "Minimal handling — only handles the happy path",
      3: "Some handling — common edge cases covered but gaps exist",
      4: "Good handling — most edge cases and errors handled properly",
      5: "Comprehensive — all edge cases, nulls, empty inputs, and errors handled gracefully",
    },
  },
];

/** Build the rubric section string for the LLM review prompt. */
export function buildRubricSection(dimensions: EvalDimension[]): string {
  return dimensions.map(dim => {
    const rubricLines = dim.rubric
      ? Object.entries(dim.rubric)
          .sort(([a], [b]) => Number(a) - Number(b))
          .map(([score, desc]) => `    ${score}: ${desc}`)
          .join("\n")
      : "    1: Very poor\n    2: Below average\n    3: Average\n    4: Good\n    5: Excellent";

    return `  ${dim.name} (weight: ${dim.weight}):
    Description: ${dim.description}
    Scoring rubric:
${rubricLines}`;
  }).join("\n\n");
}

/**
 * Compute the weighted global score from an array of dimension scores.
 * Scores are clamped to 1-5. Returns 0 if total weight is 0.
 */
export function computeWeightedScore(scores: DimensionScore[]): number {
  const totalWeight = scores.reduce((sum, s) => sum + s.weight, 0);
  if (totalWeight === 0) return 0;
  return scores.reduce((sum, s) => sum + Math.max(1, Math.min(5, s.score)) * s.weight, 0) / totalWeight;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function computeMedianScores(reviews: ReviewPayload[], dimensions: EvalDimension[]): ReviewPayload {
  const dimMap = new Map<string, { scores: number[]; entries: ReviewPayload["scores"][0][] }>();
  for (const dim of dimensions) {
    dimMap.set(dim.name, { scores: [], entries: [] });
  }

  for (const review of reviews) {
    for (const s of review.scores) {
      const bucket = dimMap.get(s.dimension);
      if (bucket) {
        bucket.scores.push(s.score);
        bucket.entries.push(s);
      }
    }
  }

  const combinedScores: ReviewPayload["scores"] = [];
  for (const dim of dimensions) {
    const bucket = dimMap.get(dim.name);
    if (!bucket || bucket.scores.length === 0) continue;

    const med = median(bucket.scores);

    // Exclude outliers deviating >1.5 from median
    const filtered = bucket.entries.filter(e => Math.abs(e.score - med) <= 1.5);
    const pool = filtered.length > 0 ? filtered : bucket.entries;

    const finalMed = median(pool.map(e => e.score));

    // Pick reasoning from entry closest to median
    let best = pool[0];
    let bestDist = Math.abs(best.score - finalMed);
    for (const e of pool) {
      const dist = Math.abs(e.score - finalMed);
      if (dist < bestDist) { best = e; bestDist = dist; }
    }

    combinedScores.push({
      dimension: dim.name,
      score: Math.round(finalMed),
      reasoning: best.reasoning,
      evidence: best.evidence,
    });
  }

  const summaries = reviews.map(r => r.summary).filter(Boolean);
  const summary = summaries.length > 0
    ? `Consensus from ${reviews.length} reviewers: ${summaries[0]}`
    : `Consensus from ${reviews.length} reviewers`;

  return { scores: combinedScores, summary };
}
