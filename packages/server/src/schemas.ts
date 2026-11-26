import { z } from "@hono/zod-openapi";
import { ApiHttpError } from "./errors.js";

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

/**
 * Optional narrowing of the tools a task's runs may use; absent = everything its agent has. It
 * only narrows: a connector or tool the agent does not have is rejected (400 INVALID_TOOL_SCOPE).
 */
export const TaskToolScopeSchema = z.object({
  connectors: z.union([z.literal("none"), z.array(z.string().min(1))]).optional()
    .openapi({ description: "Connector ids the run may use (each account of an app is its own connector, e.g. gmail-2), or \"none\". Absent: every connector the agent has." }),
  connectorTools: z.record(z.string(), z.union([z.literal("*"), z.array(z.string().min(1))])).optional()
    .openapi({ description: "Per connector id: \"*\" or the server's raw tool names. Narrows the agent's own connectorTools." }),
  allowedTools: z.array(z.string().min(1)).optional()
    .openapi({ description: "Built-in tools or patterns (read, bash, browser_*), not connector tools. Narrows the agent's allowedTools (or its default tools)." }),
}).strict().openapi("TaskToolScope");

export const CreateTaskSchema = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
  /** The agent's name; "name@1.2.0" pins the task to that published version. */
  assignTo: z.string().min(1),
  /** A published version of the agent to run (e.g. "1.2.0"); absent: the one deployed to production. */
  agentVersion: z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, "a version: major.minor.patch").optional(),
  /** Create task as draft (won't be picked up by orchestrator until moved to pending). Default: false. */
  draft: z.boolean().optional(),
  expectations: z.array(z.any()).optional(),
  expectedOutcomes: z.array(ExpectedOutcomeSchema).optional(),
  dependsOn: z.array(z.string()).optional(),
  group: z.string().optional(),
  maxDuration: z.number().positive().optional(),
  /** Retries after a failure. Default: the project's settings.maxRetries. */
  maxRetries: z.number().int().min(0).optional(),
  retryPolicy: z
    .object({
      escalateAfter: z.number().int().min(0).optional(),
      fallbackAgent: z.string().optional(),
      escalateModel: z.string().optional(),
    })
    .optional(),
  notifications: ScopedNotificationRulesSchema.optional(),
  /** Whether this task produces irreversible side effects. Blocks automatic retry/fix. */
  sideEffects: z.boolean().optional(),
  /** Narrowing of the run's tools (connectors, their tools, built-in tools); absent: the agent's. */
  toolScope: TaskToolScopeSchema.optional(),
});

export const UpdateTaskSchema = z.object({
  description: z.string().min(1).optional(),
  assignTo: z.string().min(1).optional(),
  status: z.enum(["draft", "pending", "awaiting_approval", "assigned", "in_progress", "review", "done", "failed"]).optional(),
  expectations: z.array(z.any()).optional(),
  retries: z.number().int().min(0).optional(),
  maxRetries: z.number().int().min(0).optional(),
  /** Whether this task produces irreversible side effects. Blocks automatic retry/fix. */
  sideEffects: z.boolean().optional(),
  /** Narrowing of the run's tools; null clears it (back to everything the agent has). */
  toolScope: TaskToolScopeSchema.nullable().optional(),
});

// ── Mission schemas ──────────────────────────────────────────────────

export const CreateMissionSchema = z.object({
  data: z.string().min(1),
  prompt: z.string().optional(),
  name: z.string().optional(),
  status: z
    .enum(["draft", "scheduled", "recurring", "active", "paused", "completed", "failed", "cancelled"])
    .optional(),
  /** End date for recurring schedules (ISO timestamp). */
  endDate: z.string().datetime().optional(),
  notifications: ScopedNotificationRulesSchema.optional(),
  /** Spending limit in USD for the whole mission: at it, no new task starts and the mission pauses. */
  budgetUsd: z.number().positive().finite().optional().openapi({ description: "Spending limit in USD for the whole mission (all its tasks' runs). When reached, no new task starts (running ones finish) and the mission pauses until the budget is raised or cleared." }),
});

export const UpdateMissionSchema = z.object({
  data: z.string().min(1).optional(),
  status: z
    .enum(["draft", "scheduled", "recurring", "active", "paused", "completed", "failed", "cancelled"])
    .optional(),
  name: z.string().optional(),
  /** End date for recurring schedules (ISO timestamp). */
  endDate: z.string().datetime().nullable().optional(),
  /** Spending limit in USD for the whole mission; null clears it. */
  budgetUsd: z.number().positive().finite().nullable().optional().openapi({ description: "Spending limit in USD for the whole mission; null clears it. Raising or clearing it lets a mission paused by its budget go on." }),
});

// ── Atomic mission data schemas ──────────────────────────────────

export const AddMissionTaskSchema = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
  assignTo: z.string().min(1).optional(),
  dependsOn: z.array(z.string().min(1)).optional(),
  expectations: z.array(z.any()).optional(),
  expectedOutcomes: z.array(z.any()).optional(),
  maxDuration: z.number().positive().optional(),
  retryPolicy: z.object({
    escalateAfter: z.number().int().min(0).optional(),
    fallbackAgent: z.string().optional(),
  }).optional(),
  notifications: z.any().optional(),
  sideEffects: z.boolean().optional(),
  toolScope: TaskToolScopeSchema.optional(),
});

export const UpdateMissionTaskSchema = z.object({
  title: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  assignTo: z.string().min(1).optional(),
  dependsOn: z.array(z.string().min(1)).optional(),
  expectations: z.array(z.any()).optional(),
  expectedOutcomes: z.array(z.any()).optional(),
  maxDuration: z.number().positive().optional(),
  retryPolicy: z.object({
    escalateAfter: z.number().int().min(0).optional(),
    fallbackAgent: z.string().optional(),
  }).optional(),
  notifications: z.any().optional(),
  sideEffects: z.boolean().optional(),
  /** null clears it. */
  toolScope: TaskToolScopeSchema.nullable().optional(),
});

export const ReorderMissionTasksSchema = z.object({
  titles: z.array(z.string().min(1)).min(1),
});

export const AddMissionCheckpointSchema = z.object({
  name: z.string().min(1),
  afterTasks: z.array(z.string().min(1)).min(1),
  blocksTasks: z.array(z.string().min(1)).min(1),
  message: z.string().optional(),
  notifyChannels: z.array(z.string().min(1)).optional(),
});

export const UpdateMissionCheckpointSchema = z.object({
  name: z.string().min(1).optional(),
  afterTasks: z.array(z.string().min(1)).min(1).optional(),
  blocksTasks: z.array(z.string().min(1)).min(1).optional(),
  message: z.string().optional(),
  notifyChannels: z.array(z.string().min(1)).optional(),
});

export const AddMissionDelaySchema = z.object({
  name: z.string().min(1),
  afterTasks: z.array(z.string().min(1)).min(1),
  blocksTasks: z.array(z.string().min(1)).min(1),
  duration: z.string().min(1),
  message: z.string().optional(),
  notifyChannels: z.array(z.string().min(1)).optional(),
});

export const UpdateMissionDelaySchema = z.object({
  name: z.string().min(1).optional(),
  afterTasks: z.array(z.string().min(1)).min(1).optional(),
  blocksTasks: z.array(z.string().min(1)).min(1).optional(),
  duration: z.string().min(1).optional(),
  message: z.string().optional(),
  notifyChannels: z.array(z.string().min(1)).optional(),
});

export const AddMissionQualityGateSchema = z.object({
  name: z.string().min(1),
  afterTasks: z.array(z.string().min(1)).min(1),
  blocksTasks: z.array(z.string().min(1)).min(1),
  minScore: z.number().min(1).max(5).optional(),
  requireAllPassed: z.boolean().optional(),
  condition: z.string().optional(),
  notifyChannels: z.array(z.string().min(1)).optional(),
});

export const UpdateMissionQualityGateSchema = z.object({
  name: z.string().min(1).optional(),
  afterTasks: z.array(z.string().min(1)).min(1).optional(),
  blocksTasks: z.array(z.string().min(1)).min(1).optional(),
  minScore: z.number().min(1).max(5).optional(),
  requireAllPassed: z.boolean().optional(),
  condition: z.string().optional(),
  notifyChannels: z.array(z.string().min(1)).optional(),
});

export const AddMissionTeamMemberSchema = z.object({
  name: z.string().min(1),
  role: z.string().optional(),
  model: z.string().optional(),
  systemPrompt: z.string().optional(),
  allowedTools: z.array(z.string()).optional(),
});

export const UpdateMissionTeamMemberSchema = z.object({
  name: z.string().min(1).optional(),
  role: z.string().optional(),
  model: z.string().optional(),
  systemPrompt: z.string().optional(),
  allowedTools: z.array(z.string()).optional(),
});

export const UpdateMissionNotificationsSchema = z.object({
  notifications: ScopedNotificationRulesSchema.nullable(),
});

// ── Settings schema ───────────────────────────────────────────────────

const ModelConfigSchema = z.object({
  primary: z.string().optional(),
  fallbacks: z.array(z.string()).optional(),
});

export const UpdateSettingsSchema = z.object({
  /** Where agents' tools run: default sandbox and what lower levels may choose (null removes it). */
  sandbox: z.any().optional(),
  /** Context compaction settings (null removes them). */
  compaction: z.any().optional(),
  /** Progressive tool discovery for agents and Polpo (null removes it: defaults). */
  tools: z.object({
    progressiveThreshold: z.number().int().min(0).optional(),
    progressive: z.enum(["auto", "always", "never"]).optional(),
  }).strict().nullable().optional(),
  /** How much of their dependencies' results tasks receive in their prompt (null removes it: defaults 2000 / 20000). */
  dependencyResults: z.object({
    perTaskChars: z.number().int().min(240).max(200_000).optional(),
    totalChars: z.number().int().min(480).max(1_000_000).optional(),
  }).strict().nullable().optional(),
  /** Agent configuration management: versioning (null removes it: defaults). */
  agents: z.object({
    versioning: z.object({
      /** API/MCP updates without publish/deploy flags also publish and deploy to production (default true). */
      autoDeployApiUpdates: z.boolean().optional(),
    }).strict().optional(),
  }).strict().nullable().optional(),
  orchestratorModel: z.union([z.string(), ModelConfigSchema]).optional(),
  /** The orchestrator's display name (default "Polpo"); null or "" restores the default. */
  orchestratorName: z.string().trim().max(40, "at most 40 characters")
    .regex(/^[^\r\n]*$/, "a single line").nullable().optional(),
  imageModel: z.string().nullable().optional(),
  /**
   * The decision model for decide(): "vercel-ai-gateway:typesafe-ai/jev", or { gateway, model, fallback?: model | { model,
   * confidenceBelow }, credentialRef?: { owner, service } (the gateway's key in the vault; else its env var), credentialField?,
   * zeroDataRetention? }; null removes it.
   */
  decisionModel: z.union([
    z.string().min(1),
    z.object({
      gateway: z.string().optional(), model: z.string().min(1),
      fallback: z.union([z.string(), z.object({ model: z.string().min(1), confidenceBelow: z.number().min(0).max(1).optional() })]).optional(),
      credentialRef: z.object({ owner: z.string(), service: z.string() }).optional(), credentialField: z.string().optional(),
      zeroDataRetention: z.boolean().optional(),
    }).strict(),
  ]).nullable().optional(),
  /** Decisions: without a decision model "error" (default) or "orchestrator" (Polpo's model, uncalibrated); the log's retention; null removes it. */
  decisions: z.object({
    unconfigured: z.enum(["error", "orchestrator"]).optional(),
    retention: z.number().int().min(1).max(20_000).optional(),
    retentionDays: z.number().int().min(0).max(3650).optional(),
    storeInputs: z.enum(["capped", "hash"]).optional(),
  }).strict().nullable().optional(),
  reasoning: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]).optional(),
  branding: z.object({
    productName: z.string().trim().max(80).optional(),
    tagline: z.string().trim().max(120).optional(),
    logoUrl: z.union([z.url(), z.literal("/api/v1/config/branding/logo"), z.literal("")]).optional(),
    /** The logo for dark mode (the light one when absent). */
    logoDarkUrl: z.union([z.url(), z.literal("/api/v1/config/branding/logo-dark"), z.literal("")]).optional(),
    /** How the logo is shown: "box" (default) in a tile, "none" bare; "" restores the default. */
    logoFrame: z.enum(["box", "none", ""]).optional(),
  }).optional(),
  /**
   * The dashboard's default look for everyone: { theme, palette, custom: { enabled, light, dark }, fonts, sidebarStyle }
   * (validated by parseAppearanceSettings); replaces it, null removes it.
   */
  appearance: z.record(z.string(), z.unknown()).nullable().optional(),
  /** Named egress proxies for agents' browsers ({ home: "socks5://…" }); replaces them all, null removes them. */
  egressProxies: z.record(z.string(), z.string()).nullable().optional(),
  /**
   * Tailscale inside remote computers (their browser reaches a tailnet-only egress proxy):
   * { authKey: { owner, service } (a vault entry holding the key), tags?, hostnamePrefix? }; null removes it.
   */
  tailscale: z.object({
    authKey: z.object({ owner: z.string(), service: z.string() }),
    tags: z.array(z.string()).optional(),
    hostnamePrefix: z.string().optional(),
  }).nullable().optional(),
  /**
   * Official agent harnesses agents may run on (agent.engine): { enabled: ["claude-code" | "codex" | "opencode"],
   * allowHost?, "claude-code"?: { auth: "api-key" | "bedrock" | "vertex" | "ai-gateway" | "gateway", credentialRef: { owner, service },
   * bedrock?: { region }, vertex?: { region, projectId }, gateway?: {...}, model? }, codex?: { auth: "api-key" | "ai-gateway" | "gateway",
   * credentialRef | gateway, model? }, opencode?: { auth: "api-key" | "bedrock" | "ai-gateway" | "gateway", provider? (api-key:
   * anthropic, openai, google, xai, mistral, groq, deepseek, openrouter, moonshotai, zai), credentialRef | gateway, bedrock?: { region },
   * model } }. gateway: ai-gateway → { baseUrl?, credentialRef }; gateway → { format: "anthropic" | "openai-responses" | "openai-chat"
   * (OpenCode), baseUrl, credentialRef?, authScheme: "x-api-key" | "bearer" | "none", headers?: [{ name, credentialRef?,
   * field?, prefix?, value? }], models?: { main, haiku?, sonnet?, opus? }, nonClaude? }.
   * Credentials are vault references only (a Claude subscription and OpenCode logins are refused). cli?: { accounts: [{ id, cli: "claude" | "codex",
   * computer?, configDir?, owner, label? }], allowInstanceCodex? } (the CLI engine: config directories, never tokens). Replaces it; null removes it.
   */
  harnesses: z.record(z.string(), z.unknown()).nullable().optional(),

  // General settings (Configuration → General). null goes back to the default where there is one.
  maxRetries: z.number().int().min(0).max(20).optional(),
  logLevel: z.enum(["quiet", "normal", "verbose"]).optional(),
  maxConcurrency: z.number().int().min(1).max(1000).nullable().optional(),
  /** Default timeout per task (ms); null: the default (30 min). */
  taskTimeout: z.number().int().min(1000).nullable().optional(),
  /** Idle time (ms) before an agent is considered stale; null: the default (5 min). */
  staleThreshold: z.number().int().min(1000).nullable().optional(),
  maxFixAttempts: z.number().int().min(0).max(20).nullable().optional(),
  maxQuestionRounds: z.number().int().min(0).max(20).nullable().optional(),
  maxResolutionAttempts: z.number().int().min(0).max(20).nullable().optional(),
  maxAssessmentRetries: z.number().int().min(0).max(20).nullable().optional(),
  defaultQualityThreshold: z.number().min(1).max(5).nullable().optional(),
  autoCorrectExpectations: z.boolean().nullable().optional(),
  enableScheduler: z.boolean().nullable().optional(),
  enableVolatileTeams: z.boolean().nullable().optional(),
  volatileCleanup: z.enum(["on_complete", "manual"]).nullable().optional(),
  /** Days of event logs kept (0: forever). */
  logRetentionDays: z.number().int().min(0).max(3650).nullable().optional(),
  emailAllowedDomains: z.array(z.string().trim().min(1).max(253).regex(/^[A-Za-z0-9.*-]+$/, "a domain like example.com")).nullable().optional(),
  /** Polpo's own voice replies in chats. */
  voiceReplies: z.enum(["off", "voice", "always"]).nullable().optional(),
  defaultRetryPolicy: z.object({
    escalateAfter: z.number().int().min(0).max(20).optional(),
    fallbackAgent: z.string().min(1).optional(),
    escalateModel: z.string().min(3).optional(),
  }).strict().nullable().optional(),
  /** Remote connectors on private addresses, and their default tool timeout. */
  connectors: z.object({
    allowPrivateNetwork: z.boolean().optional(),
    toolTimeoutMs: z.number().int().min(1000).max(3_600_000).optional(),
  }).strict().nullable().optional(),
  /** Polpo's own MCP server: toolsets offered and named keys (vault references); the keys given change, null removes it. */
  mcp: z.object({
    toolsets: z.array(z.string().trim().min(1)).optional(),
    keys: z.array(z.object({
      name: z.string().trim().min(1).max(80),
      keyRef: z.object({ owner: z.string().min(1), service: z.string().min(1) }),
      scopes: z.array(z.string().min(1)).optional(),
    }).strict()).optional(),
  }).strict().nullable().optional(),

  // Policies (Configuration → Policies)
  escalationPolicy: z.object({
    name: z.string().trim().min(1).max(120),
    levels: z.array(z.object({
      level: z.number().int().min(0),
      handler: z.enum(["agent", "orchestrator", "human"]),
      target: z.string().min(1).optional(),
      timeoutMs: z.number().int().min(0).optional(),
      notifyChannels: z.array(z.string().min(1)).optional(),
    }).strict()).min(1),
  }).strict().nullable().optional(),
  sla: z.object({
    warningThreshold: z.number().min(0).max(1).optional(),
    checkIntervalMs: z.number().int().min(1000).optional(),
    warningChannels: z.array(z.string().min(1)).optional(),
    violationChannels: z.array(z.string().min(1)).optional(),
    violationAction: z.enum(["notify", "fail"]).optional(),
  }).strict().nullable().optional(),
});

/** Settings PATCH keys that are set as given, or removed with null (validated by UpdateSettingsSchema). */
export const PLAIN_SETTINGS_KEYS = [
  "maxRetries", "logLevel", "maxConcurrency", "taskTimeout", "staleThreshold", "maxFixAttempts", "maxQuestionRounds",
  "maxResolutionAttempts", "maxAssessmentRetries", "defaultQualityThreshold", "autoCorrectExpectations", "enableScheduler",
  "enableVolatileTeams", "volatileCleanup", "logRetentionDays", "emailAllowedDomains", "voiceReplies", "defaultRetryPolicy",
  "connectors", "escalationPolicy", "sla",
] as const;

// ── Notification rule (full top-level, with action passthrough) ───────

export const UpsertNotificationRuleSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).optional(),
  events: z.array(z.string().min(1)).min(1),
  channels: z.array(z.string().min(1)).min(1),
  severity: z.enum(["info", "warning", "error", "critical"]).optional(),
  template: z.string().optional(),
  condition: z.any().optional(),
  cooldownMs: z.number().int().min(0).optional(),
  includeOutcomes: z.boolean().optional(),
  outcomeFilter: z
    .object({
      types: z.array(z.string()).optional(),
      tags: z.array(z.string()).optional(),
    })
    .optional(),
  maxAttachmentSize: z.number().int().min(0).optional(),
  actions: z.array(z.any()).optional(),
});

// ── Approval gate ─────────────────────────────────────────────────────

const LifecycleHookSchema = z.enum([
  "task:create",
  "task:spawn",
  "task:transition",
  "task:complete",
  "task:fail",
  "task:retry",
  "mission:execute",
  "mission:complete",
  "assessment:run",
  "assessment:complete",
  "quality:gate",
  "quality:sla",
  "schedule:trigger",
  "orchestrator:tick",
  "orchestrator:shutdown",
]);

export const UpsertApprovalGateSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  handler: z.enum(["auto", "human"]),
  hook: LifecycleHookSchema,
  condition: z.object({ expression: z.string().min(1) }).optional(),
  notifyChannels: z.array(z.string().min(1)).optional(),
  timeoutMs: z.number().int().min(0).optional(),
  timeoutAction: z.enum(["approve", "reject"]).optional(),
  priority: z.number().int().optional(),
  maxRevisions: z.number().int().min(0).optional(),
  includeOutcomes: z.boolean().optional(),
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
  avatar: z.string().optional(),
  color: z.string().regex(/^agent(?:[1-9]|10)$/, "an agent colour token: agent1 … agent10").optional(),
  responsibilities: z.array(z.union([z.string(), AgentResponsibilitySchema])).optional(),
  tone: z.string().optional(),
  personality: z.string().optional(),
  socials: z.record(z.string(), z.string()).optional(),
});

const AgentSuggestionObjectSchema = z.object({
  title: z.string().min(1),
  prompt: z.string().optional(),
  description: z.string().optional(),
});
const AgentSuggestionSchema = z.union([z.string().min(1), AgentSuggestionObjectSchema]);

const LoopConditionSchema = z.object({
  expression: z.string().min(1),
});

const LoopOutputSchema = z.object({
  schema: z.unknown().optional(),
});

const LoopConfigSchema = z.object({
  name: z.string().min(1).optional(),
  systemPrompt: z.string().optional(),
  tools: z.array(z.string().min(1)).optional(),
  model: z.string().min(1).optional(),
  reasoning: z.string().min(1).optional(),
  maxTurns: z.number().int().positive().optional(),
  stopWhen: LoopConditionSchema.optional(),
  output: LoopOutputSchema.optional(),
});

// Recursive: it must be a named OpenAPI component (emitted as a $ref), or generating the
// spec recurses forever and GET /api/v1/openapi.json fails with a stack overflow.
const PipelineStepSchema: z.ZodType<any> = z.lazy(() => z.union([
  z.object({
    loop: z.string().min(1),
    when: z.string().min(1).optional(),
  }),
  z.object({
    parallel: z.array(PipelineStepSchema).min(1),
    join: z.union([z.literal("all"), z.literal("any"), z.number().int().positive()]).optional(),
    when: z.string().min(1).optional(),
  }),
  z.object({
    switch: z.object({
      cases: z.array(z.object({
        when: z.string().min(1),
        steps: z.array(PipelineStepSchema).min(1),
      })).min(1),
      default: z.object({
        steps: z.array(PipelineStepSchema).min(1),
      }).optional(),
    }),
    when: z.string().min(1).optional(),
  }),
  z.object({
    human: z.string().min(1),
    output: LoopOutputSchema.optional(),
    notify: z.array(z.string().min(1)).optional(),
    when: z.string().min(1).optional(),
  }),
])).openapi("PipelineStep");

const PipelineSchema = z.object({
  mode: z.enum(["sequential", "parallel"]).optional(),
  context: z.literal("shared").optional(),
  steps: z.array(PipelineStepSchema).min(1),
});

const AgentLoopsSchema = z.record(z.string().min(1), LoopConfigSchema);

const AgentDriveSchema = z.object({
  enabled: z.boolean().optional(),
  purpose: z.string().max(2000).optional(),
  goals: z.array(z.string().max(500)).max(30).optional(),
  autonomy: z.enum(["propose", "balanced", "act"]).optional(),
  reflectEveryMinutes: z.number().int().min(15).optional(),
  dayStartsAt: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
}).strict();

/** An agent's engine: "polpo" or an official agent harness (see @polpo-ai/core harnesses.ts). */
export const AgentEngineSchema = z.union([
  z.literal("polpo"),
  z.object({
    harness: z.enum(["claude-code", "codex", "opencode"]),
    model: z.string().max(200).optional(),
    permissionMode: z.enum(["allow-all", "allow-edits", "allow-reads"]).optional(),
    effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
    maxBudgetUsd: z.number().positive().max(10000).optional(),
    /** This agent's own credential (cost separation): a vault reference that replaces the harness's API key or gateway key. */
    credentialRef: z.object({ owner: z.string().min(1), service: z.string().min(1) }).optional(),
  }),
  /** The CLI engine: the official Claude Code / Codex program signed in with a person's own plan (settings.harnesses.cli.accounts). */
  z.object({
    type: z.literal("cli"),
    cli: z.enum(["claude", "codex"]),
    account: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/).optional(),
    model: z.string().max(200).optional(),
    permissionMode: z.enum(["allow-all", "allow-edits", "allow-reads"]).optional(),
    args: z.array(z.string().min(1).max(300)).max(20).optional(),
  }),
]);

/** Per-connector tool selection: { <connector id>: "*" (all tools, the default) | [raw MCP tool names] }. */
export const AgentConnectorToolsSchema = z.record(
  z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, "a connector id"),
  z.union([z.literal("*"), z.array(z.string().trim().min(1).max(200)).max(1000)]),
);

export const AddAgentSchema = z.object({
  name: z.string().min(1).refine((n) => !n.trim().startsWith("$"), { message: 'Agent names starting with "$" are reserved' }),
  role: z.string().optional(),
  model: z.string().optional(),
  allowedTools: z.array(z.string()).optional(),
  systemPrompt: z.string().optional(),
  skills: z.array(z.string()).optional(),
  suggestions: z.array(AgentSuggestionSchema).optional(),
  maxTurns: z.number().int().positive().optional(),
  runtime: z.string().min(1).optional(),
  loops: AgentLoopsSchema.optional(),
  pipeline: PipelineSchema.optional(),
  // Identity & hierarchy (vault credentials managed via encrypted store)
  identity: AgentIdentitySchema.optional(),
  reportsTo: z.string().optional(),
  // Extended tool categories (browser, email, vault, image, video, audio, excel, pdf, docx, search — HTTP is always-on core)
  browserProfile: z.string().optional(),
  browserEgress: z.string().optional(),
  /** Computers (settings.computers ids) the agent may use; "host" is always allowed. */
  computers: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/)).optional(),
  /** Its default machine for chats and tasks: a computer id or "host"; "" (update) clears it. */
  defaultComputer: z.string().regex(/^([a-z0-9][a-z0-9-]{0,39})?$/).optional(),
  /** Engine: "polpo" (default) or an official harness running in its computer ({ harness: "claude-code" | "codex" | "opencode", model?, permissionMode?, effort?, maxBudgetUsd? }); null clears it. */
  engine: AgentEngineSchema.nullable().optional(),
  sandbox: z.any().optional(),
  compaction: z.any().optional(),
  /** Progressive tool discovery: auto (default: above settings.tools.progressiveThreshold), always, never. */
  progressiveTools: z.enum(["auto", "always", "never"]).optional(),
  /** Which tools of each granted connector it gets: "*" or a missing key = all, a list = only those. */
  connectorTools: AgentConnectorToolsSchema.optional(),
  voiceReplies: z.enum(["off", "voice", "always"]).optional(),
  learning: z.object({
    enabled: z.boolean().optional(),
    everyMessages: z.number().int().min(5).optional(),
    idleMinutes: z.number().int().min(0).optional(),
    skills: z.boolean().optional(),
  }).strict().optional(),
  /** A purpose it pursues on its own initiative (reflection, intentions, self-portrait); off by default. */
  drive: AgentDriveSchema.optional(),
});

export const UpdateAgentSchema = z.object({
  role: z.string().optional(),
  model: z.string().optional(),
  allowedTools: z.array(z.string()).optional(),
  allowedPaths: z.array(z.string()).optional(),
  systemPrompt: z.string().optional(),
  skills: z.array(z.string()).optional(),
  suggestions: z.array(AgentSuggestionSchema).optional(),
  maxTurns: z.number().int().positive().optional(),
  maxConcurrency: z.number().int().positive().optional(),
  identity: AgentIdentitySchema.optional(),
  reportsTo: z.string().optional(),
  reasoning: z.string().optional(),
  /** Where this agent's tools run (normalized server-side; see packages/core/src/sandbox.ts). */
  sandbox: z.any().optional(),
  /** Context compaction overrides for this agent. */
  compaction: z.any().optional(),
  /** Progressive tool discovery: auto (default: above settings.tools.progressiveThreshold), always, never; null clears it. */
  progressiveTools: z.enum(["auto", "always", "never"]).nullable().optional(),
  /** Which tools of each granted connector it gets ("*" or a missing key = all, a list = only those); null clears it (all tools). */
  connectorTools: AgentConnectorToolsSchema.nullable().optional(),
  /** Voice replies on Telegram: off (default), voice, always. */
  voiceReplies: z.enum(["off", "voice", "always"]).optional(),
  /** Learning from its conversations (memory, own skills); off by default. */
  learning: z.object({
    enabled: z.boolean().optional(),
    everyMessages: z.number().int().min(5).optional(),
    idleMinutes: z.number().int().min(0).optional(),
    skills: z.boolean().optional(),
  }).strict().optional(),
  /** A purpose it pursues on its own initiative (reflection, intentions, self-portrait); off by default. */
  drive: AgentDriveSchema.optional(),
  runtime: z.string().min(1).optional(),
  loops: AgentLoopsSchema.optional(),
  pipeline: PipelineSchema.optional(),
  browserProfile: z.string().optional(),
  browserEgress: z.string().optional(),
  /** Computers (settings.computers ids) the agent may use; "host" is always allowed. */
  /** null or [] clears it: only "host" (and the default computer). */
  computers: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/)).nullable().optional(),
  /** Its default machine for chats and tasks: a computer id or "host"; "" (update) clears it. */
  defaultComputer: z.string().regex(/^([a-z0-9][a-z0-9-]{0,39})?$/).optional(),
  /** Engine: "polpo" (default) or an official harness running in its computer ({ harness: "claude-code" | "codex" | "opencode", model?, permissionMode?, effort?, maxBudgetUsd? }); null clears it. */
  engine: AgentEngineSchema.nullable().optional(),
  emailAllowedDomains: z.array(z.string()).optional(),
  team: z.string().optional(),
  // ── Versioning (see docs/agent-versions.mdx) ──
  /** false: only the draft changes. true: the draft is also published as a new version. Absent: settings.agents.versioning.autoDeployApiUpdates decides (default: publish and deploy). */
  publish: z.boolean().optional(),
  /** true: publish and deploy the new version to production in the same call. */
  deploy: z.boolean().optional(),
  /** The semver bump of the published version (default: the suggested one). */
  bump: z.enum(["major", "minor", "patch"]).optional(),
  /** An explicit version number for the published version (above the latest), e.g. "2.0.0". */
  version: z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, "a version: major.minor.patch").optional(),
  /** Release note of the published version (and the deploy). */
  note: z.string().max(2000).optional(),
  /** A deploy through the agent's required suites (deploy gate): wait for them (default: the response says the deploy is pending). */
  wait: z.boolean().optional(),
});

export const RenameTeamSchema = z.object({
  oldName: z.string().min(1),
  name: z.string().min(1),
});

export const AddTeamSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
});

// ── Notification channel config schema ─────────────────────────────────

const ChannelGatewaySchema = z.object({
  dmPolicy: z.enum(["pairing", "allowlist", "open", "disabled"]).optional(),
  allowFrom: z.array(z.string()).optional(),
  enableInbound: z.boolean().optional(),
  sessionIdleMinutes: z.number().int().min(0).optional(),
  sessionMode: z.enum(["per-peer", "shared"]).optional(),
  agentSessions: z.record(z.string(), z.object({
    sessionMode: z.enum(["per-peer", "shared"]).optional(),
    sessionIdleMinutes: z.number().int().min(0).optional(),
  }).strict()).optional(),
  agent: z.string().min(1).optional(),
  replyTo: z.object({
    channel: z.string().min(1),
    chatId: z.string().optional(),
    echoInbound: z.boolean().optional(),
  }).strict().optional(),
  groupReplies: z.enum(["mentions", "intent"]).optional(),
  intentThreshold: z.number().min(0).max(1).optional(),
  commands: z.enum(["all", "operators", "none"]).optional(),
}).strict();

const VaultRefSchema = z.object({ owner: z.string().min(1), service: z.string().min(1) }).strict();

/** WhatsApp Business settings (see @polpo-ai/core/whatsapp-business: defaults and rules). */
const WaBusinessSettingsSchema = z.object({
  audience: z.enum(["customers", "operators"]).optional(),
  operators: z.array(z.string().min(1)).optional(),
  markRead: z.boolean().optional(),
  typing: z.boolean().optional(),
  outsideWindow: z.enum(["template", "fail"]).optional(),
  notificationTemplate: z.object({
    name: z.string().min(1), language: z.string().min(1), bodyParams: z.array(z.string()).optional(),
  }).strict().optional(),
  allowedCategories: z.array(z.enum(["UTILITY", "MARKETING", "AUTHENTICATION"])).optional(),
  approveTemplates: z.boolean().optional(),
  limits: z.object({
    businessInitiatedPerDay: z.number().int().min(0).optional(),
    perAgentPerDay: z.record(z.string(), z.number().int().min(0)).optional(),
  }).strict().optional(),
  retentionDays: z.number().int().min(1).max(3650).optional(),
}).strict();

/** A value masked by GET /config ("••••1234"); the server restores the stored secret on save. */
const MaskedSecret = z.string().refine((v) => v.includes("••••"), { message: "not a masked value" });
const orMasked = <T extends z.ZodTypeAny>(schema: T, allowMasked: boolean) =>
  allowMasked ? z.union([schema, MaskedSecret]) : schema;

const channelConfigSchema = (allowMasked: boolean) => z.object({
  type: z.enum(["slack", "email", "telegram", "whatsapp", "whatsapp-business", "webhook", "push", "expo-push"]),
  // Slack
  webhookUrl: orMasked(z.string().url(), allowMasked).optional(),
  // Email
  to: z.array(z.string().email()).optional(),
  provider: z.string().optional(),
  from: z.string().optional(),
  host: z.string().optional(),
  port: z.number().int().min(1).max(65535).optional(),
  // Shared
  apiKey: z.string().optional(),
  // Telegram
  botToken: z.string().optional(),
  chatId: z.string().optional(),
  // WhatsApp
  profileDir: z.string().optional(),
  // Webhook
  url: orMasked(z.string().url(), allowMasked).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  inboundSecret: orMasked(z.string().min(16), allowMasked).optional(),
  // Push
  vapidPublicKey: z.string().optional(),
  vapidPrivateKey: z.string().optional(),
  vapidSubject: z.string().optional(),
  ttl: z.number().int().min(0).optional(),
  urgency: z.enum(["very-low", "low", "normal", "high"]).optional(),
  // WhatsApp Business (Meta Cloud API): ids, and the secrets only as vault references ($channels)
  phoneNumberId: z.string().regex(/^\d{5,30}$/).optional(),
  wabaId: z.string().regex(/^\d{5,30}$/).optional(),
  graphApiVersion: z.string().regex(/^v\d{1,3}\.\d{1,2}$/).optional(),
  accessTokenRef: VaultRefSchema.optional(),
  appSecretRef: VaultRefSchema.optional(),
  verifyTokenRef: VaultRefSchema.optional(),
  business: WaBusinessSettingsSchema.optional(),
  // Slack inbound (Socket Mode): the tokens are in the vault ($channels), never here
  slack: z.object({ channelMessages: z.enum(["mentions", "all"]).optional() }).strict().optional(),
  // Gateway
  gateway: ChannelGatewaySchema.optional(),
});

/**
 * Request body for PUT /config/channels/:name. Secret fields may carry the
 * masked value returned by GET /config — the route restores the stored
 * secret, then validates the result with StoredNotificationChannelConfigSchema.
 */
export const NotificationChannelConfigSchema = channelConfigSchema(true);
/** A channel config as persisted (no masked placeholders allowed). */
export const StoredNotificationChannelConfigSchema = channelConfigSchema(false);

// ── Direct notification schema ─────────────────────────────────────────

export const SendNotificationSchema = z.object({
  channel: z.string().min(1),
  title: z.string().min(1),
  body: z.string().min(1),
  severity: z.enum(["info", "warning", "critical"]).optional(),
  delayMs: z.number().int().min(0).optional(),
  /** Channels that can target a chat: the chat (a Slack channel id, C…/D…/G…). Default: the channel's own. */
  to: z.string().min(1).max(200).optional(),
  /** Slack: post in this thread (the parent message's ts, e.g. "1712345678.123456"). */
  threadTs: z.string().regex(/^\d{1,10}\.\d{6}$/, "a Slack message ts like 1712345678.123456").optional(),
  /** Answer 400 when the channel refuses the message (immediate sends), instead of recording the failure only. */
  throwOnError: z.boolean().optional(),
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
