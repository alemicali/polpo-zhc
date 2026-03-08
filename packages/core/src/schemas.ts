/**
 * Zod schemas for runtime validation of Polpo types.
 * Central source of truth — used by config parser, orchestrator, and API routes.
 */

import { z } from "zod";
import type { TaskExpectation, MissionCheckpoint, MissionQualityGate } from "./types.js";

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

// ── Mission Checkpoint Schema ───────────────────────────────────────

export const missionCheckpointSchema = z.object({
  name: z.string().min(1, "checkpoint requires a name"),
  afterTasks: z.array(z.string().min(1)).min(1, "checkpoint requires at least one task in afterTasks"),
  blocksTasks: z.array(z.string().min(1)).min(1, "checkpoint requires at least one task in blocksTasks"),
  message: z.string().optional(),
  notifyChannels: z.array(z.string().min(1)).optional(),
});

// ── Mission Delay Schema ────────────────────────────────────────────

export const missionDelaySchema = z.object({
  name: z.string().min(1, "delay requires a name"),
  afterTasks: z.array(z.string().min(1)).min(1, "delay requires at least one task in afterTasks"),
  blocksTasks: z.array(z.string().min(1)).min(1, "delay requires at least one task in blocksTasks"),
  duration: z.string().min(1, "delay requires a duration (ISO 8601, e.g. PT2H, PT30M, P1D)"),
  message: z.string().optional(),
  notifyChannels: z.array(z.string().min(1)).optional(),
});

// ── Mission Quality Gate Schema ─────────────────────────────────────

export const missionQualityGateSchema = z.object({
  name: z.string().min(1, "quality gate requires a name"),
  afterTasks: z.array(z.string().min(1)).min(1, "quality gate requires at least one task in afterTasks"),
  blocksTasks: z.array(z.string().min(1)).min(1, "quality gate requires at least one task in blocksTasks"),
  minScore: z.number().min(1).max(5).optional(),
  requireAllPassed: z.boolean().optional(),
  condition: z.string().optional(),
  notifyChannels: z.array(z.string().min(1)).optional(),
});

// ── Mission Task Schema ─────────────────────────────────────────────

const missionTaskSchema = z.object({
  title: z.string().min(1, "task requires a title"),
  description: z.string().min(1, "task requires a description"),
  assignTo: z.string().min(1).optional(),
  dependsOn: z.array(z.string().min(1)).optional(),
  expectations: z.array(z.any()).optional(),
  expectedOutcomes: z.array(z.any()).optional(),
  metrics: z.array(z.any()).optional(),
  maxRetries: z.number().int().min(0).optional(),
  maxDuration: z.number().positive().optional(),
  retryPolicy: z.object({
    escalateAfter: z.number().int().min(0).optional(),
    fallbackAgent: z.string().optional(),
  }).optional(),
  notifications: z.any().optional(),
  sideEffects: z.boolean().optional(),
});

// ── Mission Document Schema ─────────────────────────────────────────

export const missionDocumentSchema = z.object({
  tasks: z.array(missionTaskSchema).min(1, "mission requires at least one task"),
  team: z.array(z.any()).optional(),
  qualityGates: z.array(missionQualityGateSchema).optional(),
  checkpoints: z.array(missionCheckpointSchema).optional(),
  delays: z.array(missionDelaySchema).optional(),
  notifications: z.any().optional(),
}).superRefine((doc, ctx) => {
  // Enforce unique task titles within a mission document
  const seen = new Set<string>();
  for (let i = 0; i < doc.tasks.length; i++) {
    const title = doc.tasks[i].title;
    if (seen.has(title)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Duplicate task title "${title}" — each task must have a unique title`,
        path: ["tasks", i, "title"],
      });
    }
    seen.add(title);
  }

  // Build task lookup: title → dependsOn set
  const taskDeps = new Map<string, Set<string>>();
  for (const t of doc.tasks) {
    taskDeps.set(t.title, new Set(t.dependsOn ?? []));
  }

  // Validate flow-control elements: blocksTasks must have dependsOn including afterTasks
  const validateFlowControl = (
    kind: "checkpoints" | "delays" | "qualityGates",
    items: Array<{ name: string; afterTasks: string[]; blocksTasks: string[] }>,
  ) => {
    for (let i = 0; i < items.length; i++) {
      const fc = items[i];
      // Check afterTasks reference valid task titles
      for (const t of fc.afterTasks) {
        if (!taskDeps.has(t)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `${kind}[${i}] "${fc.name}": afterTasks references unknown task "${t}"`,
            path: [kind, i, "afterTasks"],
          });
        }
      }
      // Check blocksTasks reference valid titles AND have dependsOn on afterTasks
      for (const bt of fc.blocksTasks) {
        if (!taskDeps.has(bt)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `${kind}[${i}] "${fc.name}": blocksTasks references unknown task "${bt}"`,
            path: [kind, i, "blocksTasks"],
          });
          continue;
        }
        const deps = taskDeps.get(bt)!;
        const missingDeps = fc.afterTasks.filter(at => !deps.has(at));
        if (missingDeps.length > 0) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `${kind}[${i}] "${fc.name}": task "${bt}" is in blocksTasks but missing dependsOn: [${missingDeps.map(d => `"${d}"`).join(", ")}]. Without dependsOn, the task will start in parallel ignoring the ${kind.slice(0, -1)}`,
            path: ["tasks", doc.tasks.findIndex(t => t.title === bt), "dependsOn"],
          });
        }
      }
    }
  };

  if (doc.checkpoints) validateFlowControl("checkpoints", doc.checkpoints);
  if (doc.delays) validateFlowControl("delays", doc.delays);
  if (doc.qualityGates) validateFlowControl("qualityGates", doc.qualityGates);
});

export type MissionDocumentParsed = z.infer<typeof missionDocumentSchema>;

/**
 * Parse and validate a mission JSON document strictly.
 * Returns the validated document or throws with a clear error message.
 */
export function parseMissionDocument(raw: unknown): MissionDocumentParsed {
  const result = missionDocumentSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid mission document: ${issues}`);
  }
  return result.data;
}
