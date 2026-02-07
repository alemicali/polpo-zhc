import { describe, it, expect } from "vitest";
import {
  DEFAULT_DIMENSIONS,
  buildRubricSection,
  computeWeightedScore,
} from "../assessment/scoring.js";
import type { DimensionScore, EvalDimension } from "../core/types.js";

describe("scoring", () => {
  describe("DEFAULT_DIMENSIONS", () => {
    it("has 4 dimensions", () => {
      expect(DEFAULT_DIMENSIONS).toHaveLength(4);
    });

    it("weights sum to approximately 1.0", () => {
      const total = DEFAULT_DIMENSIONS.reduce((sum, d) => sum + d.weight, 0);
      expect(total).toBeCloseTo(1.0, 5);
    });

    it("each dimension has a rubric with scores 1-5", () => {
      for (const dim of DEFAULT_DIMENSIONS) {
        expect(dim.rubric).toBeDefined();
        const keys = Object.keys(dim.rubric!).map(Number).sort();
        expect(keys).toEqual([1, 2, 3, 4, 5]);
      }
    });

    it("includes correctness, completeness, code_quality, edge_cases", () => {
      const names = DEFAULT_DIMENSIONS.map(d => d.name);
      expect(names).toContain("correctness");
      expect(names).toContain("completeness");
      expect(names).toContain("code_quality");
      expect(names).toContain("edge_cases");
    });
  });

  describe("computeWeightedScore", () => {
    it("computes correctly with equal weights", () => {
      const scores: DimensionScore[] = [
        { dimension: "a", score: 4, reasoning: "", weight: 0.5 },
        { dimension: "b", score: 2, reasoning: "", weight: 0.5 },
      ];
      expect(computeWeightedScore(scores)).toBe(3);
    });

    it("computes correctly with custom weights", () => {
      const scores: DimensionScore[] = [
        { dimension: "a", score: 5, reasoning: "", weight: 0.8 },
        { dimension: "b", score: 1, reasoning: "", weight: 0.2 },
      ];
      // (5*0.8 + 1*0.2) / (0.8+0.2) = (4.0 + 0.2) / 1.0 = 4.2
      expect(computeWeightedScore(scores)).toBeCloseTo(4.2, 5);
    });

    it("clamps scores to 1-5", () => {
      const scores: DimensionScore[] = [
        { dimension: "a", score: 10, reasoning: "", weight: 0.5 },
        { dimension: "b", score: -3, reasoning: "", weight: 0.5 },
      ];
      // clamped: (5*0.5 + 1*0.5) / 1.0 = 3.0
      expect(computeWeightedScore(scores)).toBe(3);
    });

    it("returns 0 when total weight is 0", () => {
      const scores: DimensionScore[] = [
        { dimension: "a", score: 5, reasoning: "", weight: 0 },
      ];
      expect(computeWeightedScore(scores)).toBe(0);
    });

    it("handles empty scores array", () => {
      expect(computeWeightedScore([])).toBe(0);
    });

    it("handles single score", () => {
      const scores: DimensionScore[] = [
        { dimension: "a", score: 3, reasoning: "", weight: 1 },
      ];
      expect(computeWeightedScore(scores)).toBe(3);
    });
  });

  describe("buildRubricSection", () => {
    it("generates rubric with dimension names and weights", () => {
      const dims: EvalDimension[] = [{
        name: "quality",
        description: "Code quality",
        weight: 0.5,
        rubric: { 1: "bad", 5: "great" },
      }];
      const result = buildRubricSection(dims);
      expect(result).toContain("quality (weight: 0.5)");
      expect(result).toContain("Code quality");
      expect(result).toContain("1: bad");
      expect(result).toContain("5: great");
    });

    it("uses default rubric when none provided", () => {
      const dims: EvalDimension[] = [{
        name: "test",
        description: "Test dim",
        weight: 0.3,
      }];
      const result = buildRubricSection(dims);
      expect(result).toContain("1: Very poor");
      expect(result).toContain("5: Excellent");
    });

    it("sorts rubric scores numerically", () => {
      const dims: EvalDimension[] = [{
        name: "test",
        description: "Test",
        weight: 1,
        rubric: { 3: "three", 1: "one", 5: "five", 2: "two", 4: "four" },
      }];
      const result = buildRubricSection(dims);
      const lines = result.split("\n").filter(l => l.match(/^\s+\d:/));
      expect(lines[0]).toContain("1: one");
      expect(lines[4]).toContain("5: five");
    });
  });
});
