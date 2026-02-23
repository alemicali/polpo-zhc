import type { McpServerConfig } from "../mcp/types.js";
export type { McpServerConfig } from "../mcp/types.js";

// === Task ===

export type TaskStatus =
  | "pending"
  | "awaiting_approval"
  | "assigned"
  | "in_progress"
  | "review"
  | "done"
  | "failed";

export interface EvalDimension {
  name: string;              // e.g. "correctness", "completeness"
  description: string;       // what this dimension measures
  weight: number;            // 0-1, weights should sum to ~1
  rubric?: Record<number, string>; // 1-5 score descriptions per level
}

export interface DimensionScore {
  dimension: string;         // dimension name
  score: number;             // 1-5
  reasoning: string;         // chain-of-thought for this score
  weight: number;            // weight used for global score
  evidence?: { file: string; line: number; note: string }[];
}

export interface TaskExpectation {
  type: "test" | "file_exists" | "script" | "llm_review";
  command?: string;
  paths?: string[];
  criteria?: string;
  /** For llm_review: evaluation dimensions with weights and rubrics */
  dimensions?: EvalDimension[];
  /** For llm_review: minimum weighted score (1-5) to pass. Default 3.0 */
  threshold?: number;
  /** Whether this expectation is a firm requirement or an estimate that can be auto-corrected.
   *  Default: "estimated" for file_exists, "firm" for test/script/llm_review. */
  confidence?: "firm" | "estimated";
}

export interface TaskMetric {
  name: string;
  command: string;
  threshold: number;
}

export interface RetryPolicy {
  /** After this many failures, escalate to fallbackAgent */
  escalateAfter?: number;
  /** Agent to use for escalation retries */
  fallbackAgent?: string;
  /** Model override for escalation (e.g. switch from haiku to sonnet) */
  escalateModel?: string;
}

export type TaskPhase = "execution" | "review" | "fix" | "clarification";

// === Outcomes ===

/** What type of artifact a task can produce. */
export type OutcomeType = "file" | "text" | "url" | "json" | "media";

/**
 * A concrete artifact produced by a task at runtime.
 * Populated automatically by tool interception and/or explicitly by agent output.
 */
export interface TaskOutcome {
  /** Unique outcome ID (nanoid). */
  id: string;
  /** Outcome category. */
  type: OutcomeType;
  /** Human-readable label (e.g. "Sales Report", "Transcription", "Generated Audio"). */
  label: string;

  // --- Type-specific payload ---

  /** file/media: relative or absolute path to the produced file. */
  path?: string;
  /** file/media: MIME type (auto-detected from extension or explicit). */
  mimeType?: string;
  /** file/media: file size in bytes. */
  size?: number;
  /** text: the content itself (transcription, summary, analysis, etc.). */
  text?: string;
  /** url: link to external resource (deploy URL, PR, page, etc.). */
  url?: string;
  /** json: structured data payload (query results, metrics, report, etc.). */
  data?: unknown;

  // --- Metadata ---

  /** Tool name that generated this outcome (auto-collected). */
  producedBy?: string;
  /** ISO timestamp when the outcome was created. */
  producedAt: string;
  /** User-defined tags for filtering and categorization. */
  tags?: string[];
}

/**
 * Declared in task/plan definitions — tells the agent what it should produce.
 * Used for validation: the orchestrator checks that expected outcomes are fulfilled.
 */
export interface ExpectedOutcome {
  /** Expected outcome type. */
  type: OutcomeType;
  /** Human-readable label — also used to match against produced TaskOutcome.label. */
  label: string;
  /** Hints for the agent about what to produce. */
  description?: string;
  /** Expected file path (optional — agent can choose). */
  path?: string;
  /** Expected MIME type (e.g. "audio/mpeg", "application/pdf"). */
  mimeType?: string;
  /** Whether this outcome is required for the task to pass. Default: true. */
  required?: boolean;
  /** Tags to auto-apply to the produced outcome. */
  tags?: string[];
}

export interface Task {
  id: string;
  title: string;
  description: string;
  assignTo: string;
  group?: string;
  dependsOn: string[];
  status: TaskStatus;
  expectations: TaskExpectation[];
  metrics: TaskMetric[];
  retries: number;
  maxRetries: number;
  maxDuration?: number;       // ms, 0 = no timeout
  retryPolicy?: RetryPolicy;
  result?: TaskResult;
  phase?: TaskPhase;             // current phase (execution/review/fix/clarification)
  fixAttempts?: number;          // fix attempts in current review cycle
  questionRounds?: number;       // Q&A rounds with orchestrator (max default: 2)
  resolutionAttempts?: number;   // deadlock resolution attempts (max default: 2)
  originalDescription?: string;  // preserved before first retry/fix
  sessionId?: string;            // SDK session ID from the last agent run (for transcript access)
  /** Absolute deadline (ISO timestamp). Task is SLA-violated if not done by this time. */
  deadline?: string;
  /** Priority weight for quality scoring (higher = more important). Default: 1.0 */
  priority?: number;
  /** Declared expected outcomes — what this task should produce. */
  expectedOutcomes?: ExpectedOutcome[];
  /** Actual outcomes produced at runtime (auto-collected + explicit). */
  outcomes?: TaskOutcome[];
  /** Number of approval revision rounds this task has gone through. */
  revisionCount?: number;
  /** Scoped notification rules — override or extend global/plan rules for this task. */
  notifications?: ScopedNotificationRules;
  createdAt: string;
  updatedAt: string;
}

export interface TaskResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  duration: number;
  assessment?: AssessmentResult;
  /** All previous assessments (oldest first). Current assessment is always in `assessment`. */
  assessmentHistory?: AssessmentResult[];
}

// === Agent Identity & Vault ===

/** Agent identity — who this agent is and how it behaves */
/** A structured responsibility area */
export interface AgentResponsibility {
  /** Responsibility area (e.g. "Customer Relations", "Content Creation") */
  area: string;
  /** What the agent does in this area */
  description: string;
  /** Priority level — affects how the agent prioritizes competing tasks */
  priority?: "critical" | "high" | "medium" | "low";
}

export interface AgentIdentity {
  displayName?: string;      // "Alice Chen"
  title?: string;            // "Social Media Manager"
  company?: string;          // "Acme Corp"
  email?: string;            // Primary email address (also default SMTP from)
  bio?: string;              // Brief persona description
  timezone?: string;         // "Europe/Rome"

  /** Responsibilities — simple strings or structured objects with area/description/priority.
   *  Structured format is preferred for clarity. */
  responsibilities?: (string | AgentResponsibility)[];

  /** Communication tone — HOW the agent communicates.
   *  Examples: "Professional but warm", "Concise and data-driven", "Casual and friendly" */
  tone?: string;

  /** Personality traits — WHO the agent IS as a persona.
   *  Examples: "Detail-oriented and empathetic", "Creative problem-solver" */
  personality?: string;
}

/** Vault credential entry */
export interface VaultEntry {
  /** Service type for semantic meaning */
  type: "smtp" | "imap" | "oauth" | "api_key" | "login" | "custom";
  /** Human-readable label */
  label?: string;
  /** Credential fields — values can be literals or ${ENV_VAR} references */
  credentials: Record<string, string>;
}

// === Agent ===

export interface AgentConfig {
  name: string;
  role?: string;
  /** Model to use. Format: "provider:model" (e.g. "anthropic:claude-sonnet-4-5-20250929") or bare model ID (auto-inferred). */
  model?: string;
  /** Allowed tools for the agent (e.g. ["read", "write", "edit", "bash", "glob", "grep", "browser_navigate", "git_status"]) */
  allowedTools?: string[];
  /** Filesystem sandbox — directories the agent is allowed to access.
   *  Paths can be absolute or relative to workDir. When set, all file tool operations
   *  and bash cwd are validated against these paths. When omitted, defaults to [workDir]. */
  allowedPaths?: string[];
  /** MCP servers to connect to. Keys are server names, values are server configs (stdio or HTTP). */
  mcpServers?: Record<string, McpServerConfig>;
  /** Agent's identity — persona, responsibilities, communication style */
  identity?: AgentIdentity;
  /** Per-agent credential vault — keyed by service name */
  vault?: Record<string, VaultEntry>;
  /** Agent this one reports to — org chart hierarchy for escalation.
   *  When a task fails or needs a decision, escalates up the chain. */
  reportsTo?: string;
  /** System prompt appended to the agent's base prompt */
  systemPrompt?: string;
  /** Installed skill names (e.g. "find-skills", "frontend-design") */
  skills?: string[];
  /** Max conversation turns before stopping. Default 150 */
  maxTurns?: number;
  /** Max concurrent tasks for this agent. Default: unlimited (undefined). */
  maxConcurrency?: number;
  /** Volatile agent — created for a specific plan, auto-removed when plan completes */
  volatile?: boolean;
  /** Plan group this volatile agent belongs to */
  planGroup?: string;

  // ── Extended tool categories (opt-in) ──

  /** Enable browser automation tools.
   *  Tools: browser_navigate, browser_snapshot, browser_click, browser_fill, browser_type,
   *  browser_press, browser_screenshot, browser_get, browser_select, browser_hover,
   *  browser_scroll, browser_wait, browser_eval, browser_close, browser_back, browser_forward,
   *  browser_reload, browser_tabs */
  enableBrowser?: boolean;
  /** Browser engine: "agent-browser" (default, uses agent-browser CLI) or "playwright" (persistent profiles via Playwright).
   *  Requires playwright-core when set to "playwright". */
  browserEngine?: "agent-browser" | "playwright";
  /** Browser profile name for persistent context (cookies, auth, localStorage).
   *  Defaults to agent name. Only used with browserEngine: "playwright".
   *  Profiles stored in .polpo/browser-profiles/<name>/. */
  browserProfile?: string;
  /** Enable HTTP/fetch tools for API calls and web requests.
   *  Tools: http_fetch, http_download */
  enableHttp?: boolean;
  /** Enable structured git tools.
   *  Tools: git_status, git_diff, git_log, git_commit, git_branch, git_stash, git_show */
  enableGit?: boolean;
  /** Enable multi-file editing tools for batch operations.
   *  Tools: multi_edit, regex_replace, bulk_rename */
  enableMultifile?: boolean;
  /** Enable dependency management tools (npm/pnpm/yarn/bun).
   *  Tools: dep_install, dep_add, dep_remove, dep_outdated, dep_audit, dep_info */
  enableDeps?: boolean;
  /** Enable Excel/CSV tools for spreadsheet operations.
   *  Tools: excel_read, excel_write, excel_query, excel_info */
  enableExcel?: boolean;
  /** Enable PDF tools for document operations.
   *  Tools: pdf_read, pdf_create, pdf_merge, pdf_info */
  enablePdf?: boolean;
  /** Enable Word/DOCX tools for document operations.
   *  Tools: docx_read, docx_create */
  enableDocx?: boolean;
  /** Enable email tools for sending messages via SMTP.
   *  Tools: email_send, email_verify. Requires SMTP_HOST/SMTP_USER/SMTP_PASS env vars. */
  enableEmail?: boolean;
  /** Enable audio tools for speech-to-text and text-to-speech.
   *  Tools: audio_transcribe, audio_speak. Requires OPENAI_API_KEY/DEEPGRAM_API_KEY/ELEVENLABS_API_KEY env vars. */
  enableAudio?: boolean;
  /** Enable image tools for generation and vision analysis.
   *  Tools: image_generate, image_analyze. Requires OPENAI_API_KEY/REPLICATE_API_TOKEN/ANTHROPIC_API_KEY env vars. */
  enableImage?: boolean;
  /** Allowed recipient email domains for email_send (e.g. ["acme.com", "partner.io"]).
   *  When set, emails can only be sent to addresses in these domains.
   *  When omitted, all domains are allowed (backwards compatible). */
  emailAllowedDomains?: string[];
}

export interface AgentActivity {
  lastTool?: string;        // last tool the agent used (e.g. "Write", "Edit", "Bash")
  lastFile?: string;        // last file touched
  filesCreated: string[];   // files created during this task
  filesEdited: string[];    // files edited during this task
  toolCalls: number;        // total tool calls made
  totalTokens: number;      // cumulative token usage across all turns
  lastUpdate: string;       // ISO timestamp of last activity
  summary?: string;         // agent's last text output / message
  sessionId?: string;       // SDK session ID for transcript access
}

export interface AgentProcess {
  agentName: string;
  pid: number;
  taskId: string;
  startedAt: string;
  alive: boolean;
  activity: AgentActivity;
}

// === Team ===

export interface Team {
  name: string;
  description?: string;
  agents: AgentConfig[];
}

// === Assessment ===

export interface CheckResult {
  type: TaskExpectation["type"];
  passed: boolean;
  message: string;
  details?: string;
  /** Per-dimension scores from llm_review */
  scores?: DimensionScore[];
  /** Weighted average score (1-5) from llm_review */
  globalScore?: number;
}

export interface MetricResult {
  name: string;
  value: number;
  threshold: number;
  passed: boolean;
}

export type AssessmentTrigger = "initial" | "reassess" | "fix" | "retry" | "auto-correct" | "judge";

export interface AssessmentResult {
  passed: boolean;
  checks: CheckResult[];
  metrics: MetricResult[];
  llmReview?: string;            // LLM reviewer's detailed feedback
  scores?: DimensionScore[];     // aggregated dimension scores
  globalScore?: number;          // aggregated weighted score (1-5)
  timestamp: string;
  /** What triggered this assessment. Defaults to "initial" for backwards compatibility. */
  trigger?: AssessmentTrigger;
}

/**
 * Replace the current assessment on a TaskResult, archiving the old one in assessmentHistory.
 * Also tags the new assessment with the given trigger.
 */
export function setAssessment(result: TaskResult, assessment: AssessmentResult, trigger: AssessmentTrigger): void {
  if (result.assessment) {
    if (!result.assessmentHistory) result.assessmentHistory = [];
    result.assessmentHistory.push(result.assessment);
  }
  assessment.trigger = trigger;
  result.assessment = assessment;
}

// === Review Context (passed to LLM reviewers for richer assessment) ===

export interface ReviewContext {
  taskTitle: string;
  taskDescription: string;
  agentOutput?: string;       // stdout truncated to last 2000 chars
  filesCreated?: string[];
  filesEdited?: string[];
}

// === Plan ===

export type PlanStatus = "draft" | "active" | "paused" | "completed" | "failed" | "cancelled";

export interface Plan {
  id: string;
  name: string;         // "plan-1", "plan-2", or custom name
  data: string;         // JSON plan content (tasks, team, etc.)
  prompt?: string;      // original user prompt that generated this plan
  status: PlanStatus;
  /** Absolute deadline for the entire plan (ISO timestamp). */
  deadline?: string;
  /** Cron expression or ISO timestamp for scheduled execution. */
  schedule?: string;
  /** If true, re-execute on every schedule trigger (recurring). Default: false (one-shot). */
  recurring?: boolean;
  /** Minimum average score for the plan to be considered successful. */
  qualityThreshold?: number;
  /** Scoped notification rules — override or extend global rules for tasks in this plan. */
  notifications?: ScopedNotificationRules;
  createdAt: string;
  updatedAt: string;
}

/** Completion report for a plan — aggregated results across all tasks. */
export interface PlanReport {
  planId: string;
  group: string;
  allPassed: boolean;
  totalDuration: number;           // ms, sum of all task durations
  tasks: {
    title: string;
    status: "done" | "failed";
    duration: number;              // ms
    score?: number;                // global assessment score (1-5)
    filesCreated: string[];
    filesEdited: string[];
    outcomes?: TaskOutcome[];      // outcomes produced by this task
  }[];
  filesCreated: string[];          // aggregated across all tasks
  filesEdited: string[];           // aggregated across all tasks
  outcomes?: TaskOutcome[];        // aggregated outcomes across all tasks
  avgScore?: number;               // average assessment score
}

// === Runner Config ===

export interface RunnerConfig {
  runId: string;
  taskId: string;
  agent: AgentConfig;
  task: Task;
  polpoDir: string;
  cwd: string;
  storage?: "file" | "sqlite";
  /** UDS path for push-notifying the orchestrator on completion. */
  notifySocket?: string;
  /** Email domain allowlist (from settings or agent config). */
  emailAllowedDomains?: string[];
  /** MCP tool allowlist — keys are server names, values are allowed tool names. */
  mcpToolAllowlist?: Record<string, string[]>;
}

// === Polpo File Config (.polpo/polpo.json — persistent project configuration) ===

export interface PolpoFileConfig {
  project: string;
  team: Team;
  settings: PolpoSettings;
  providers?: Record<string, ProviderConfig>;
}

// === Provider Config ===

export interface ProviderConfig {
  /** API key (direct value or "${ENV_VAR}" reference). */
  apiKey?: string;
  /** Override base URL for the provider (e.g. custom proxy, Ollama, vLLM). */
  baseUrl?: string;
  /** API compatibility mode for custom endpoints. */
  api?: "openai-completions" | "openai-responses" | "anthropic-messages";
  /** Custom model definitions for this provider (used with custom endpoints). */
  models?: CustomModelDef[];
}

/** Custom model definition for non-catalog providers (Ollama, vLLM, LM Studio, etc.) */
export interface CustomModelDef {
  /** Model ID used in API calls. */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Whether the model supports extended thinking / reasoning. */
  reasoning?: boolean;
  /** Supported input types. Default: ["text"] */
  input?: ("text" | "image")[];
  /** Cost per million tokens. Default: all zeros (free/local). */
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  /** Context window size in tokens. Default: 200000 */
  contextWindow?: number;
  /** Max output tokens. Default: 8192 */
  maxTokens?: number;
}

// === Model Config (primary + fallbacks) ===

export interface ModelConfig {
  /** Primary model spec (e.g. "anthropic:claude-opus-4-6"). */
  primary?: string;
  /** Ordered fallback models — tried when primary fails. */
  fallbacks?: string[];
}

/** Model allowlist entry with optional alias. */
export interface ModelAllowlistEntry {
  /** Display alias for this model (e.g. "Sonnet", "GPT"). */
  alias?: string;
  /** Per-model parameter overrides. */
  params?: Record<string, unknown>;
}

// === Config (.polpo/polpo.json) ===

export interface PolpoConfig {
  version: string;
  project: string;
  team: Team;
  tasks: Omit<Task, "status" | "retries" | "result" | "createdAt" | "updatedAt">[];
  settings: PolpoSettings;
  /** Per-provider API key and base URL overrides. */
  providers?: Record<string, ProviderConfig>;
}

export interface PolpoSettings {
  maxRetries: number;
  workDir: string;
  logLevel: "quiet" | "normal" | "verbose";
  taskTimeout?: number;            // default timeout per task (ms). Default: 30min
  staleThreshold?: number;         // ms idle before agent considered stale. Default: 5min
  defaultRetryPolicy?: RetryPolicy;
  /** Whether plans can define volatile agents in their team: section. Default: true */
  enableVolatileTeams?: boolean;
  /** When to clean up volatile agents: "on_complete" (default) removes them when the plan
   *  finishes, "manual" keeps them until the user explicitly removes them or the plan is deleted */
  volatileCleanup?: "on_complete" | "manual";
  /** Max fix attempts per review cycle before falling back to full retry. Default: 2 */
  maxFixAttempts?: number;
  /** Max auto-answer rounds per task when agent asks questions. Default: 2 */
  maxQuestionRounds?: number;
  /** Max deadlock resolution attempts per task. Default: 2 */
  maxResolutionAttempts?: number;
  /** Auto-correct correctable expectations (e.g. file_exists paths) on assessment failure. Default: true */
  autoCorrectExpectations?: boolean;
  /** Model for orchestrator LLM calls (question detection, deadlock, plans).
   *  Can be a simple string ("anthropic:claude-opus-4-6") or a ModelConfig with fallbacks. */
  orchestratorModel?: string | ModelConfig;
  /** Image-capable model for tasks that need vision (falls back to orchestratorModel). */
  imageModel?: string;
  /** Model allowlist — when set, only these models can be used.
   *  Keys are model specs (e.g. "anthropic:claude-opus-4-6"), values are aliases/params. */
  modelAllowlist?: Record<string, ModelAllowlistEntry>;
  /** Storage backend for tasks, plans, and runs. Default: "file" (filesystem JSON). */
  storage?: "file" | "sqlite";
  /** Max assessment retries when all reviewers fail before falling back to fix/retry. Default: 1 */
  maxAssessmentRetries?: number;
  /** Max concurrent agent processes. Default: unlimited (undefined). */
  maxConcurrency?: number;
  /** Approval gates — checkpoints that block task/plan execution until approved. */
  approvalGates?: ApprovalGate[];
  /** Notification system — routes events to external channels (Slack, email, Telegram). */
  notifications?: NotificationsConfig;
  /** Default escalation policy — defines escalation chain when tasks fail repeatedly. */
  escalationPolicy?: EscalationPolicy;
  /** SLA monitoring configuration. */
  sla?: SLAConfig;
  /** Enable the scheduling engine. Default: true if any plan has a schedule. */
  enableScheduler?: boolean;
  /** Default quality threshold for plans (1-5). Plans below this score are marked failed. */
  defaultQualityThreshold?: number;
  /** Allowed recipient email domains — applies to all agents (can be overridden per-agent). */
  emailAllowedDomains?: string[];
  /** MCP tool allowlist — keys are server names, values are arrays of allowed tool names.
   *  When set for a server, only listed tools are exposed to agents. Unlisted servers are unrestricted. */
  mcpToolAllowlist?: Record<string, string[]>;
}

// === Polpo State (persisted in .polpo/state.json) ===

export interface PolpoState {
  project: string;
  team: Team;
  tasks: Task[];
  processes: AgentProcess[];
  startedAt?: string;
  completedAt?: string;
}

// === Project Config (legacy JSON format) ===

/** Legacy project config stored in config.json */
export interface ProjectConfig {
  project: string;
  judge?: string;
  agent?: string;
  model?: string;
}

// === Approval Gates ===

export type ApprovalGateHandler = "auto" | "human";

export interface ApprovalGateCondition {
  /** JS-like expression evaluated against the hook payload.
   *  For "auto" gates — if condition passes, task proceeds. If it fails, task is blocked.
   *  For "human" gates — condition determines WHEN to trigger the gate. */
  expression: string;
}

export interface ApprovalGate {
  /** Unique gate ID. */
  id: string;
  /** Human-readable name. */
  name: string;
  /** "auto" = system evaluates condition. "human" = blocks for human approval. */
  handler: ApprovalGateHandler;
  /** Which lifecycle hook triggers this gate. */
  hook: string;
  /** Optional condition — when to activate the gate. */
  condition?: ApprovalGateCondition;
  /** Notification channels to alert on gate activation (for "human" gates). */
  notifyChannels?: string[];
  /** Timeout in ms (for "human" gates). 0 = no timeout. */
  timeoutMs?: number;
  /** Action when timeout expires. Default: "reject". */
  timeoutAction?: "approve" | "reject";
  /** Priority within the same hook point. Lower = first. Default: 100. */
  priority?: number;
  /** Max revision rounds before only approve/reject is allowed. Default: 3. */
  maxRevisions?: number;
  /** Include task outcomes as attachments in the approval notification. */
  includeOutcomes?: boolean;
}

export type ApprovalStatus = "pending" | "approved" | "rejected" | "timeout";

export interface ApprovalRequest {
  /** Unique request ID. */
  id: string;
  /** Gate that triggered this request. */
  gateId: string;
  /** Gate name (denormalized for display). */
  gateName: string;
  /** Related task ID, if applicable. */
  taskId?: string;
  /** Related plan ID, if applicable. */
  planId?: string;
  /** Current status. */
  status: ApprovalStatus;
  /** Hook payload snapshot at time of request. */
  payload: unknown;
  /** When the request was created. */
  requestedAt: string;
  /** When the request was resolved (approved/rejected/timeout). */
  resolvedAt?: string;
  /** Who resolved it (user ID, "system", "timeout"). */
  resolvedBy?: string;
  /** Optional resolution note. */
  note?: string;
}

// === Channel Gateway & Peer Identity ===

/** Supported messaging channel types for inbound message routing. */
export type ChannelType = "telegram" | "whatsapp" | "slack" | "discord" | "webchat";

/**
 * Peer identity — represents a person talking to the bot from a messaging channel.
 * Inspired by OpenClaw's session key model but adapted for orchestrator use-cases.
 *
 * A peer is identified by their channel-specific ID (e.g., Telegram chatId, WhatsApp phone).
 * Identity links allow the same person on multiple channels to share a session.
 */
export interface PeerIdentity {
  /** Canonical peer ID (format: "channel:externalId", e.g. "telegram:123456789"). */
  id: string;
  /** Channel type. */
  channel: ChannelType;
  /** Channel-specific external ID (chatId, phone number, user ID, etc.). */
  externalId: string;
  /** Display name (from channel profile, if available). */
  displayName?: string;
  /** When this peer was first seen. */
  firstSeenAt: string;
  /** When this peer last sent a message. */
  lastSeenAt: string;
  /** Linked canonical identity — allows cross-channel session sharing.
   *  If set, this peer shares sessions with the peer identified by this ID. */
  linkedTo?: string;
}

/**
 * DM access policy — controls who can message the bot.
 * Modeled after OpenClaw's 4-tier DM security model.
 */
export type DmPolicy = "pairing" | "allowlist" | "open" | "disabled";

/** Pairing request — pending approval for a new peer to talk to the bot. */
export interface PairingRequest {
  /** Unique request ID. */
  id: string;
  /** Peer requesting access. */
  peerId: string;
  /** Channel type. */
  channel: ChannelType;
  /** Channel-specific external ID. */
  externalId: string;
  /** Display name of the requester. */
  displayName?: string;
  /** Short pairing code sent to the user. */
  code: string;
  /** When the request was created. */
  createdAt: string;
  /** When the request expires (1 hour from creation). */
  expiresAt: string;
  /** Whether the request has been resolved. */
  resolved: boolean;
}

/**
 * Channel gateway configuration — extends notification channel config
 * with inbound message handling settings.
 */
export interface ChannelGatewayConfig {
  /** DM access policy. Default: "allowlist". */
  dmPolicy?: DmPolicy;
  /** Allowlist of external IDs that can message the bot.
   *  Use "*" to allow all (only with dmPolicy="open"). */
  allowFrom?: string[];
  /** Enable inbound message routing (chat with orchestrator). Default: false. */
  enableInbound?: boolean;
  /** Session idle timeout in minutes before creating a new session. Default: 60. */
  sessionIdleMinutes?: number;
}

/**
 * Presence entry — lightweight, ephemeral tracking of connected peers.
 * Inspired by OpenClaw's in-memory presence with TTL.
 */
export interface PresenceEntry {
  /** Peer ID (format: "channel:externalId"). */
  peerId: string;
  /** Display name. */
  displayName?: string;
  /** Channel type. */
  channel: ChannelType;
  /** Last activity timestamp (ISO). */
  lastActivityAt: string;
  /** What the peer is doing ("idle" | "chatting" | "approving"). */
  activity: "idle" | "chatting" | "approving";
}

// === Notification System ===

export type NotificationChannelType = "slack" | "email" | "telegram" | "webhook";

export interface NotificationChannelConfig {
  type: NotificationChannelType;
  /** Slack: webhook URL. */
  webhookUrl?: string;
  /** Email: recipient addresses. */
  to?: string[];
  /** Email: provider ("smtp" | "resend" | "sendgrid"). */
  provider?: string;
  /** API key (direct value or "${ENV_VAR}" reference). */
  apiKey?: string;
  /** Telegram: bot token. */
  botToken?: string;
  /** Telegram: chat ID. */
  chatId?: string;
  /** Webhook: target URL. */
  url?: string;
  /** Webhook: custom headers. */
  headers?: Record<string, string>;
  /** SMTP host. */
  host?: string;
  /** SMTP port. */
  port?: number;
  /** SMTP from address. */
  from?: string;
  /** Channel gateway config — enables inbound message routing for this channel. */
  gateway?: ChannelGatewayConfig;
}

export type NotificationSeverity = "info" | "warning" | "critical";

/**
 * JSON-based condition for notification rule filtering.
 *
 * Supports:
 *   - Single comparison: { "field": "status", "op": "==", "value": "failed" }
 *   - Logical AND:       { "and": [ ...conditions ] }
 *   - Logical OR:        { "or": [ ...conditions ] }
 *   - Logical NOT:       { "not": condition }
 *   - Inclusion:         { "field": "tags", "op": "includes", "value": "urgent" }
 *   - Existence:         { "field": "error", "op": "exists" }
 *
 * Fields are dot-paths resolved on the event data (e.g. "task.status", "score").
 */
export type ConditionOp = "==" | "!=" | ">" | ">=" | "<" | "<=" | "includes" | "not_includes" | "exists" | "not_exists";

export interface ConditionExpr {
  field: string;
  op: ConditionOp;
  value?: string | number | boolean | null;
}

export interface ConditionAnd {
  and: NotificationCondition[];
}

export interface ConditionOr {
  or: NotificationCondition[];
}

export interface ConditionNot {
  not: NotificationCondition;
}

export type NotificationCondition = ConditionExpr | ConditionAnd | ConditionOr | ConditionNot;

export interface NotificationRule {
  /** Unique rule ID. */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Event patterns to match (glob-style: "task:*", "plan:completed"). */
  events: string[];
  /** Optional JSON condition on the event payload. No eval — pure data. */
  condition?: NotificationCondition;
  /** Channels to notify (references to channel IDs in config). */
  channels: string[];
  /** Severity level. Default: "info". */
  severity?: NotificationSeverity;
  /** Mustache-style template for the notification body. */
  template?: string;
  /** Minimum interval between notifications for the same rule (ms). */
  cooldownMs?: number;
  /** Attach task outcomes to the notification (files sent as attachments). Default: false. */
  includeOutcomes?: boolean;
  /** Only include outcomes of these types. When omitted, all types are included. */
  outcomeFilter?: OutcomeType[];
  /** Max file size per attachment in bytes. Files larger than this are skipped. Default: 10MB. */
  maxAttachmentSize?: number;
  /** Action triggers — executed when the rule fires, in addition to sending notifications. */
  actions?: NotificationAction[];
}

// === Notification Action Triggers ===

/** Action types that can be triggered by notification rules. */
export type NotificationActionType = "create_task" | "execute_plan" | "run_script" | "send_notification";

/** Base action interface. */
interface NotificationActionBase {
  type: NotificationActionType;
}

/** Create a task when the rule fires. */
export interface CreateTaskAction extends NotificationActionBase {
  type: "create_task";
  title: string;
  description: string;
  assignTo: string;
  expectations?: TaskExpectation[];
}

/** Execute an existing plan when the rule fires. */
export interface ExecutePlanAction extends NotificationActionBase {
  type: "execute_plan";
  planId: string;
}

/** Run a shell script when the rule fires. */
export interface RunScriptAction extends NotificationActionBase {
  type: "run_script";
  command: string;
  /** Max execution time in ms. Default: 30000. */
  timeoutMs?: number;
}

/** Send an additional notification to different channels. */
export interface SendNotificationAction extends NotificationActionBase {
  type: "send_notification";
  channel: string;
  title: string;
  body: string;
  severity?: NotificationSeverity;
}

export type NotificationAction = CreateTaskAction | ExecutePlanAction | RunScriptAction | SendNotificationAction;

export interface NotificationsConfig {
  channels: Record<string, NotificationChannelConfig>;
  rules: NotificationRule[];
}

/**
 * Scoped notification rules — can be attached to a Task or Plan to override
 * or extend the global notification rules.
 *
 * Precedence: task > plan > global.
 * - Default: more-specific scope **replaces** global rules for matching events.
 * - With `inherit: true`: scoped rules are **added** on top of the parent scope.
 */
export interface ScopedNotificationRules {
  /** Notification rules for this scope. */
  rules: NotificationRule[];
  /** If true, these rules are added on top of the parent scope (plan or global).
   *  If false (default), they replace parent rules for matching events. */
  inherit?: boolean;
}

// === Escalation ===

export type EscalationHandlerType = "agent" | "orchestrator" | "human";

export interface EscalationLevel {
  /** Level number (0 = first). */
  level: number;
  /** Who handles at this level. */
  handler: EscalationHandlerType;
  /** Target agent name (for "agent"), notification channel (for "human"). */
  target?: string;
  /** Timeout before escalating to next level (ms). */
  timeoutMs?: number;
  /** Notification channels to alert at this level. */
  notifyChannels?: string[];
}

export interface EscalationPolicy {
  /** Policy name. */
  name: string;
  /** Ordered escalation levels. */
  levels: EscalationLevel[];
}

// === Quality Layer ===

/** Quality gate defined within a plan — checkpoint between task phases. */
export interface PlanQualityGate {
  /** Gate name. */
  name: string;
  /** Tasks that must be completed before this gate is evaluated. */
  afterTasks: string[];
  /** Tasks that are blocked until this gate passes. */
  blocksTasks: string[];
  /** Minimum average score of `afterTasks` to pass. */
  minScore?: number;
  /** All `afterTasks` must have status "done" (not just completed — they must pass). */
  requireAllPassed?: boolean;
  /** Custom condition expression evaluated against gate context. */
  condition?: string;
  /** Notification channels to alert on gate pass/fail. */
  notifyChannels?: string[];
}

/** Checkpoint defined within a plan — planned stopping point for human review.
 *
 * Unlike approval gates (which ask yes/no and auto-resume on approval),
 * checkpoints unconditionally pause the plan until explicitly resumed.
 * Use checkpoints for human-in-the-loop review at defined milestones. */
export interface PlanCheckpoint {
  /** Checkpoint name (used in events and notifications). */
  name: string;
  /** Tasks that must be completed before this checkpoint triggers. */
  afterTasks: string[];
  /** Tasks that are blocked until the checkpoint is resumed. */
  blocksTasks: string[];
  /** Notification channels to alert when the checkpoint is reached. */
  notifyChannels?: string[];
  /** Optional message included in the notification when the checkpoint triggers. */
  message?: string;
}

/** SLA configuration for deadline monitoring. */
export interface SLAConfig {
  /** Percentage of deadline elapsed before emitting a warning (0-1). Default: 0.8 */
  warningThreshold?: number;
  /** Check interval in ms. Default: 30000 (30s). */
  checkIntervalMs?: number;
  /** Notification channels for SLA warnings. */
  warningChannels?: string[];
  /** Notification channels for SLA violations. */
  violationChannels?: string[];
  /** Action on SLA violation: "notify" (default) or "fail" (force-fail the task). */
  violationAction?: "notify" | "fail";
}

/** Quality metrics snapshot for a single entity (task, agent, plan). */
export interface QualityMetrics {
  /** Entity identifier. */
  entityId: string;
  /** Entity type. */
  entityType: "task" | "agent" | "plan";
  /** Total assessments run. */
  totalAssessments: number;
  /** Assessments that passed. */
  passedAssessments: number;
  /** Average global score (1-5). */
  avgScore?: number;
  /** Minimum score observed. */
  minScore?: number;
  /** Maximum score observed. */
  maxScore?: number;
  /** Per-dimension average scores. */
  dimensionScores: Record<string, number>;
  /** Total retries consumed. */
  totalRetries: number;
  /** Total fix attempts consumed. */
  totalFixes: number;
  /** Deadlines met vs missed. */
  deadlinesMet: number;
  deadlinesMissed: number;
  /** Last updated. */
  updatedAt: string;
}

/** Scheduled plan entry. */
export interface ScheduleEntry {
  /** Unique schedule ID. */
  id: string;
  /** Plan ID to execute. */
  planId: string;
  /** Cron expression (e.g. "0 2 * * *") or ISO timestamp for one-shot. */
  expression: string;
  /** Whether this schedule recurs. */
  recurring: boolean;
  /** Whether this schedule is active. */
  enabled: boolean;
  /** Last execution time (ISO). */
  lastRunAt?: string;
  /** Next scheduled execution time (ISO). */
  nextRunAt?: string;
  /** Deadline offset — auto-set task/plan deadline to N ms after execution start. */
  deadlineOffsetMs?: number;
  /** Created at. */
  createdAt: string;
}

// === Task Watchers ===

/** A watcher that fires an action when a task reaches a target status. */
export interface TaskWatcher {
  /** Unique watcher ID. */
  id: string;
  /** Task ID to watch. */
  taskId: string;
  /** Target status to trigger on. */
  targetStatus: TaskStatus;
  /** Action to execute when triggered. */
  action: NotificationAction;
  /** Whether the watcher has already fired. */
  fired: boolean;
  /** Created at (ISO). */
  createdAt: string;
  /** Fired at (ISO). */
  firedAt?: string;
}

// === Extended Settings ===

export interface PolpoSettingsExtended {
  /** Approval gates configuration. */
  approvalGates?: ApprovalGate[];
  /** Notification system configuration. */
  notifications?: NotificationsConfig;
  /** Default escalation policy for tasks. */
  escalationPolicy?: EscalationPolicy;
}

// === Quality & Scheduling Settings (on PolpoSettings) ===
// These are added to PolpoSettings directly — see the interface above.
