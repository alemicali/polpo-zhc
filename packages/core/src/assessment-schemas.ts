/**
 * Zod schemas for validating LLM review structured output.
 *
 * Single source of truth for the ReviewPayload shape — used by:
 * - extractSubmitReview (tool call extraction)
 * - tryParseReviewJSON (text-based JSON fallback)
 * - OpenAI response_format json_schema (derived via zodToJsonSchema)
 */

import { z } from "zod";

// ── Score Evidence (optional file:line references) ─────────────────────

export const ReviewEvidenceSchema = z.object({
  file: z.string(),
  line: z.number(),
  note: z.string(),
});

// ── Individual Dimension Score ─────────────────────────────────────────

export const ReviewScoreSchema = z.object({
  dimension: z.string().min(1),
  score: z.number().min(1).max(5).transform(v => Math.round(v)),
  reasoning: z.string().min(1),
  evidence: z.array(ReviewEvidenceSchema).optional(),
});

// ── Full Review Payload ────────────────────────────────────────────────

export const ReviewPayloadSchema = z.object({
  scores: z.array(ReviewScoreSchema).min(1),
  summary: z.string().min(1),
});

export type ValidatedReviewPayload = z.infer<typeof ReviewPayloadSchema>;

// ── Validation Helper ──────────────────────────────────────────────────

/**
 * Validate and normalize a raw object into a ReviewPayload.
 * Returns `{ success: true, data }` or `{ success: false, error }`.
 *
 * This applies:
 * - Type coercion (string scores → numbers)
 * - Clamping (scores rounded to 1-5)
 * - Default reasoning if missing but other fields present
 */
export function validateReviewPayload(raw: unknown): { success: true; data: ValidatedReviewPayload } | { success: false; error: string } {
  if (!raw || typeof raw !== "object") {
    return { success: false, error: "Input is not an object" };
  }

  const obj = raw as Record<string, unknown>;

  // Pre-process: coerce common LLM output quirks before Zod validation
  if (obj.scores && Array.isArray(obj.scores)) {
    for (const score of obj.scores) {
      if (score && typeof score === "object") {
        const s = score as Record<string, unknown>;
        // Coerce string scores to numbers
        if (typeof s.score === "string") {
          s.score = parseFloat(s.score);
        }
        // Accept alternative reasoning field names
        if (!s.reasoning && s.reason) {
          s.reasoning = s.reason;
        }
        if (!s.reasoning && s.explanation) {
          s.reasoning = s.explanation;
        }
        // Ensure reasoning exists
        if (!s.reasoning || (typeof s.reasoning === "string" && s.reasoning.trim() === "")) {
          s.reasoning = "(no reasoning provided)";
        }
      }
    }
  }

  // Ensure summary exists
  if (!obj.summary || (typeof obj.summary === "string" && obj.summary.trim() === "")) {
    obj.summary = "(no summary)";
  }

  const result = ReviewPayloadSchema.safeParse(obj);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ") };
}

// ── JSON Schema for OpenAI response_format ─────────────────────────────

/**
 * JSON Schema derived from ReviewPayloadSchema, for use with OpenAI's
 * response_format: { type: "json_schema", json_schema: { ... } }.
 *
 * We maintain this manually to ensure `strict: true` and `additionalProperties: false`
 * which OpenAI requires.
 */
export const REVIEW_JSON_SCHEMA = {
  type: "json_schema" as const,
  json_schema: {
    name: "review_scores",
    strict: true,
    schema: {
      type: "object",
      properties: {
        scores: {
          type: "array",
          items: {
            type: "object",
            properties: {
              dimension: { type: "string", description: "Dimension name from the rubric" },
              score: { type: "number", description: "Score 1-5" },
              reasoning: { type: "string", description: "Brief reasoning with file:line evidence" },
            },
            required: ["dimension", "score", "reasoning"],
            additionalProperties: false,
          },
        },
        summary: { type: "string", description: "Overall review summary" },
      },
      required: ["scores", "summary"],
      additionalProperties: false,
    },
  },
};
