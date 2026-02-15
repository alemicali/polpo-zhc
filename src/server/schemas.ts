import { z } from "zod";
import { ApiHttpError } from "./middleware/error.js";

// ── Task schemas ──────────────────────────────────────────────────────

export const CreateTaskSchema = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
  assignTo: z.string().min(1),
  expectations: z.array(z.any()).optional(),
  dependsOn: z.array(z.string()).optional(),
  group: z.string().optional(),
  maxDuration: z.number().positive().optional(),
  retryPolicy: z
    .object({
      escalateAfter: z.number().int().min(0).optional(),
      fallbackAgent: z.string().optional(),
      escalateModel: z.string().optional(),
    })
    .optional(),
});

export const UpdateTaskSchema = z.object({
  description: z.string().min(1).optional(),
  assignTo: z.string().min(1).optional(),
  expectations: z.array(z.any()).optional(),
});

// ── Plan schemas ──────────────────────────────────────────────────────

export const CreatePlanSchema = z.object({
  data: z.string().min(1),
  prompt: z.string().optional(),
  name: z.string().optional(),
  status: z
    .enum(["draft", "active", "completed", "failed", "cancelled"])
    .optional(),
});

export const UpdatePlanSchema = z.object({
  data: z.string().min(1).optional(),
  status: z
    .enum(["draft", "active", "completed", "failed", "cancelled"])
    .optional(),
  name: z.string().optional(),
});

// ── Agent schemas ─────────────────────────────────────────────────────

export const AddAgentSchema = z.object({
  name: z.string().min(1),
  adapter: z.string().min(1).optional(),
  role: z.string().optional(),
  model: z.string().optional(),
  allowedTools: z.array(z.string()).optional(),
  systemPrompt: z.string().optional(),
  skills: z.array(z.string()).optional(),
  maxTurns: z.number().int().positive().optional(),
});

export const RenameTeamSchema = z.object({
  name: z.string().min(1),
});

// ── Chat schemas ──────────────────────────────────────────────────────

export const ChatMessageSchema = z.object({
  message: z.string().min(1),
  sessionId: z.string().optional(),
});

export const GeneratePlanSchema = z.object({
  prompt: z.string().min(1),
});

export const PrepareTaskSchema = z.object({
  description: z.string().min(1),
  assignTo: z.string().min(1),
  group: z.string().optional(),
});

export const GenerateTeamSchema = z.object({
  description: z.string().min(1),
});

export const RefineTeamSchema = z.object({
  currentData: z.string().min(1),
  description: z.string().optional().default(""),
  feedback: z.string().min(1),
});

export const RefinePlanSchema = z.object({
  currentData: z.string().min(1),
  prompt: z.string().optional().default(""),
  feedback: z.string().min(1),
});

// ── Memory schema ─────────────────────────────────────────────────────

export const UpdateMemorySchema = z.object({
  content: z.string(),
});

// ── Helper ────────────────────────────────────────────────────────────

/** Parse and validate request body against a Zod schema. Throws ApiHttpError on failure. */
export function parseBody<T>(schema: z.ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new ApiHttpError(issues, "VALIDATION_ERROR", 400);
  }
  return result.data;
}
