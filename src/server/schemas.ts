import { z } from "@hono/zod-openapi";
import { ApiHttpError } from "./middleware/error.js";

// ── Outcome schemas ───────────────────────────────────────────────────

const ExpectedOutcomeSchema = z.object({
  type: z.enum(["file", "text", "url", "json", "media"]),
  label: z.string().min(1),
  description: z.string().optional(),
  path: z.string().optional(),
  mimeType: z.string().optional(),
  required: z.boolean().optional(),
  tags: z.array(z.string()).optional(),
});

// ── Notification rule schema (shared for scoped rules) ────────────────

const NotificationRuleSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  events: z.array(z.string().min(1)).min(1),
  condition: z.any().optional(),
  channels: z.array(z.string().min(1)).min(1),
  severity: z.enum(["info", "warning", "critical"]).optional(),
  template: z.string().optional(),
  cooldownMs: z.number().int().min(0).optional(),
  includeOutcomes: z.boolean().optional(),
  outcomeFilter: z.array(z.enum(["file", "text", "url", "json", "media"])).optional(),
  maxAttachmentSize: z.number().int().min(0).optional(),
});

const ScopedNotificationRulesSchema = z.object({
  rules: z.array(NotificationRuleSchema),
  inherit: z.boolean().optional(),
});

// ── Task schemas ──────────────────────────────────────────────────────

export const CreateTaskSchema = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
  assignTo: z.string().min(1),
  /** Create task as draft (won't be picked up by orchestrator until moved to pending). Default: false. */
  draft: z.boolean().optional(),
  expectations: z.array(z.any()).optional(),
  expectedOutcomes: z.array(ExpectedOutcomeSchema).optional(),
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
  notifications: ScopedNotificationRulesSchema.optional(),
});

export const UpdateTaskSchema = z.object({
  description: z.string().min(1).optional(),
  assignTo: z.string().min(1).optional(),
  expectations: z.array(z.any()).optional(),
  retries: z.number().int().min(0).optional(),
  maxRetries: z.number().int().min(0).optional(),
});

// ── Plan schemas ──────────────────────────────────────────────────────

export const CreatePlanSchema = z.object({
  data: z.string().min(1),
  prompt: z.string().optional(),
  name: z.string().optional(),
  status: z
    .enum(["draft", "active", "completed", "failed", "cancelled"])
    .optional(),
  notifications: ScopedNotificationRulesSchema.optional(),
});

export const UpdatePlanSchema = z.object({
  data: z.string().min(1).optional(),
  status: z
    .enum(["draft", "active", "completed", "failed", "cancelled"])
    .optional(),
  name: z.string().optional(),
});

// ── Agent schemas ─────────────────────────────────────────────────────

const AgentResponsibilitySchema = z.object({
  area: z.string(),
  description: z.string(),
  priority: z.enum(["critical", "high", "medium", "low"]).optional(),
});

const AgentIdentitySchema = z.object({
  displayName: z.string().optional(),
  title: z.string().optional(),
  company: z.string().optional(),
  email: z.string().optional(),
  bio: z.string().optional(),
  timezone: z.string().optional(),
  responsibilities: z.array(z.union([z.string(), AgentResponsibilitySchema])).optional(),
  tone: z.string().optional(),
  personality: z.string().optional(),
});

const VaultEntrySchema = z.object({
  type: z.enum(["smtp", "imap", "oauth", "api_key", "login", "custom"]),
  label: z.string().optional(),
  credentials: z.record(z.string(), z.string()),
});

export const AddAgentSchema = z.object({
  name: z.string().min(1),
  role: z.string().optional(),
  model: z.string().optional(),
  allowedTools: z.array(z.string()).optional(),
  systemPrompt: z.string().optional(),
  skills: z.array(z.string()).optional(),
  maxTurns: z.number().int().positive().optional(),
  // Identity, vault, hierarchy
  identity: AgentIdentitySchema.optional(),
  vault: z.record(z.string(), VaultEntrySchema).optional(),
  reportsTo: z.string().optional(),
  // Extended tool categories
  enableBrowser: z.boolean().optional(),
  browserEngine: z.enum(["agent-browser", "playwright"]).optional(),
  browserProfile: z.string().optional(),
  enableHttp: z.boolean().optional(),
  enableGit: z.boolean().optional(),
  enableMultifile: z.boolean().optional(),
  enableDeps: z.boolean().optional(),
  enableExcel: z.boolean().optional(),
  enablePdf: z.boolean().optional(),
  enableDocx: z.boolean().optional(),
  enableEmail: z.boolean().optional(),
  enableAudio: z.boolean().optional(),
  enableImage: z.boolean().optional(),
});

export const RenameTeamSchema = z.object({
  oldName: z.string().min(1),
  name: z.string().min(1),
});

export const AddTeamSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
});

// ── Direct notification schema ─────────────────────────────────────────

export const SendNotificationSchema = z.object({
  channel: z.string().min(1),
  title: z.string().min(1),
  body: z.string().min(1),
  severity: z.enum(["info", "warning", "critical"]).optional(),
  delayMs: z.number().int().min(0).optional(),
});

// ── Approval schemas ──────────────────────────────────────────────────

export const ApproveRequestSchema = z.object({
  resolvedBy: z.string().optional(),
  note: z.string().optional(),
});

export const RejectRequestSchema = z.object({
  feedback: z.string().min(1),
  resolvedBy: z.string().optional(),
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
