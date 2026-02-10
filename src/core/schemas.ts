/**
 * Zod schemas for runtime validation of Orchestra types.
 * Central source of truth — used by config parser, orchestrator, and API routes.
 */

import { z } from "zod";
import type { TaskExpectation } from "./types.js";

// ── Expectation Schemas (discriminated union on `type`) ──────────────

const testExpectation = z.object({
  type: z.literal("test"),
  command: z.string().min(1, "test expectation requires a non-empty command"),
});

const scriptExpectation = z.object({
  type: z.literal("script"),
  command: z.string().min(1, "script expectation requires a non-empty command"),
});

const fileExistsExpectation = z.object({
  type: z.literal("file_exists"),
  paths: z.array(z.string().min(1)).min(1, "file_exists expectation requires at least one path"),
});

const evalDimension = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  weight: z.number().min(0).max(1),
  rubric: z.record(z.string(), z.string()).optional(),
});

const llmReviewExpectation = z.object({
  type: z.literal("llm_review"),
  criteria: z.string().min(1).optional(),
  dimensions: z.array(evalDimension).min(1).optional(),
  threshold: z.number().min(1).max(5).optional(),
}).refine(
  (e) => (e.criteria && e.criteria.trim().length > 0) || (e.dimensions && e.dimensions.length > 0),
  { message: "llm_review expectation requires criteria or dimensions" },
);

export const taskExpectationSchema = z.discriminatedUnion("type", [
  testExpectation,
  scriptExpectation,
  fileExistsExpectation,
  // llmReviewExpectation uses refine so can't be in discriminatedUnion — handled separately
]);

/**
 * Parse & validate a single expectation. Returns the validated value or null if invalid.
 */
export function parseExpectation(raw: unknown): TaskExpectation | null {
  // Try discriminated union first (test, script, file_exists)
  const result = taskExpectationSchema.safeParse(raw);
  if (result.success) return result.data as TaskExpectation;

  // Try llm_review separately (uses refine)
  const llmResult = llmReviewExpectation.safeParse(raw);
  if (llmResult.success) return llmResult.data as TaskExpectation;

  return null;
}

/**
 * Sanitize an array of expectations: keep only valid ones, silently drop malformed entries.
 * Returns the filtered array + list of warnings for dropped entries.
 */
export function sanitizeExpectations(raw: unknown[]): { valid: TaskExpectation[]; warnings: string[] } {
  const valid: TaskExpectation[] = [];
  const warnings: string[] = [];

  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    const parsed = parseExpectation(item);
    if (parsed) {
      valid.push(parsed);
    } else {
      const type = (item as Record<string, unknown>)?.type ?? "unknown";
      warnings.push(`expectation[${i}] (type: ${type}) dropped — missing required fields`);
    }
  }

  return { valid, warnings };
}
