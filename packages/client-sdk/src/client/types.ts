/**
 * OpenPolpo API types — mirrors the server contract.
 * Intentionally decoupled from @polpo-ai/core to avoid pulling
 * server-side dependencies (blessed, sqlite, etc.) into the client bundle.
 */

// === Task ===

export type TaskStatus =
  | "draft"
  | "pending"
  | "awaiting_approval"
  | "assigned"
  | "in_progress"
  | "review"
  | "done"
  | "failed";

export interface EvalDimension {
  name: string;
  description: string;
  weight: number;
  rubric?: Record<number, string>;
}

export interface DimensionScoreEvidence {
  file: string;
  line: number;
  note: string;
}

export interface DimensionScore {
  dimension: string;
  score: number;
  reasoning: string;
  weight: number;
  evidence?: DimensionScoreEvidence[];
}

export interface TaskExpectation {
  type: "test" | "file_exists" | "script" | "llm_review";
  command?: string;
  paths?: string[];
  criteria?: string;
  dimensions?: EvalDimension[];
  threshold?: number;
  confidence?: "firm" | "estimated";
}

export interface TaskMetric {
  name: string;
  command: string;
  threshold: number;
}

export interface RetryPolicy {
  escalateAfter?: number;
  fallbackAgent?: string;
  escalateModel?: string;
}

export type TaskPhase = "execution" | "review" | "fix" | "clarification";

// === Outcomes ===

export type OutcomeType = "file" | "text" | "url" | "json" | "media";

export interface TaskOutcome {
  id: string;
  type: OutcomeType;
  label: string;
  path?: string;
  mimeType?: string;
  size?: number;
  text?: string;
  url?: string;
  data?: unknown;
  producedBy?: string;
  producedAt: string;
  tags?: string[];
}

export interface ExpectedOutcome {
  type: OutcomeType;
  label: string;
  description?: string;
  path?: string;
  mimeType?: string;
  required?: boolean;
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
  maxDuration?: number;
  retryPolicy?: RetryPolicy;
  result?: TaskResult;
  phase?: TaskPhase;
  fixAttempts?: number;
  questionRounds?: number;
  resolutionAttempts?: number;
  originalDescription?: string;
  sessionId?: string;
  /** Absolute deadline (ISO timestamp). */
  deadline?: string;
  /** Priority weight for quality scoring. Default: 1.0 */
  priority?: number;
  expectedOutcomes?: ExpectedOutcome[];
  outcomes?: TaskOutcome[];
  /** Number of approval revision rounds. */
  revisionCount?: number;
  /** Scoped notification rules for this task. */
  notifications?: ScopedNotificationRules;
  /** Whether this task produces irreversible side effects. Blocks automatic retry/fix. */
  sideEffects?: boolean;
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

// === Agent ===

// === MCP Server Config ===

/** Stdio-based MCP server — spawns a child process */
export interface McpStdioServerConfig {
  type?: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/** SSE-based MCP server (legacy, prefer HTTP) */
export interface McpSseServerConfig {
  type: "sse";
  url: string;
  headers?: Record<string, string>;
}

/** HTTP-based MCP server (streamable HTTP, recommended for remote) */
export interface McpHttpServerConfig {
  type: "http";
  url: string;
  headers?: Record<string, string>;
}

/** Union of all supported MCP server configs */
export type McpServerConfig =
  | McpStdioServerConfig
  | McpSseServerConfig
  | McpHttpServerConfig;

// === Agent Identity & Vault ===

/** Agent identity — who this agent is and how it behaves */
/** A structured responsibility area */
export interface AgentResponsibility {
  area: string;
  description: string;
  priority?: "critical" | "high" | "medium" | "low";
}

export interface AgentIdentity {
  displayName?: string;
  title?: string;
  company?: string;
  email?: string;
  bio?: string;
  timezone?: string;
  /** Avatar image path relative to project root, served via /api/v1/files/read?path=<avatar> */
  avatar?: string;
  /** Responsibilities — simple strings or structured objects with area/description/priority */
  responsibilities?: (string | AgentResponsibility)[];
  /** Communication tone — HOW the agent communicates */
  tone?: string;
  /** Personality traits — WHO the agent IS as a persona */
  personality?: string;
  /** Social & web accounts — keys are platform names, values are handles/URLs */
  socials?: Record<string, string>;
}

export interface AgentConfig {
  name: string;
  /** ISO timestamp of when this agent was created / added to the team. */
  createdAt?: string;
  role?: string;
  model?: string;
  allowedTools?: string[];
  /** MCP servers to connect to. */
  mcpServers?: Record<string, McpServerConfig>;
  /** Filesystem sandbox — directories the agent is allowed to access.
   *  When omitted, defaults to the project workDir. */
  allowedPaths?: string[];
  /** Agent's identity — persona, responsibilities, communication style */
  identity?: AgentIdentity;
  // NOTE: Vault credentials are stored in encrypted .polpo/vault.enc — not on AgentConfig.
  /** Agent this one reports to — org chart hierarchy for escalation */
  reportsTo?: string;
  systemPrompt?: string;
  skills?: string[];
  maxTurns?: number;
  /** Max concurrent tasks for this agent. Default: unlimited. */
  maxConcurrency?: number;
  /** Reasoning / deep thinking level for this agent's LLM calls. */
  reasoning?: ReasoningLevel;
  volatile?: boolean;
  missionGroup?: string;

  // Tool categories are activated via allowedTools (e.g. ["browser_*", "email_*", "image_*", "video_*", "audio_*", "excel_*", "pdf_*", "docx_*", "search_*"])
  // Note: HTTP tools (http_fetch, http_download) and vault tools (vault_get, vault_list) are always available as core tools.
  /** Browser profile name for persistent context (cookies, auth). Used with agent-browser --profile. */
  browserProfile?: string;
  /** Allowed recipient email domains for email_send. Overrides global setting. */
  emailAllowedDomains?: string[];
}

export interface AgentActivity {
  lastTool?: string;
  lastFile?: string;
  filesCreated: string[];
  filesEdited: string[];
  toolCalls: number;
  totalTokens: number;
  lastUpdate: string;
  summary?: string;
  sessionId?: string;
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

/** Serializable representation of a single message in the reviewer's conversation */
export interface ReviewerMessage {
  role: "user" | "assistant" | "toolResult";
  /** For user/assistant: text content. For toolResult: the tool output text. */
  content: string;
  /** Tool calls made by the assistant (if role === "assistant") */
  toolCalls?: { id: string; name: string; arguments: Record<string, unknown> }[];
  /** For toolResult messages */
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  timestamp: number;
}

/** Phase 1 exploration trace from a single reviewer */
export interface ReviewerExploration {
  /** Full analysis text produced by the reviewer during exploration */
  analysis: string;
  /** Files read by the reviewer during exploration */
  filesRead: string[];
  /** Complete conversation (user prompts, assistant responses, tool calls & results) */
  messages: ReviewerMessage[];
}

/** Individual reviewer result from llm_review multi-evaluator consensus */
export interface ReviewerResult {
  index: number;
  scores: { dimension: string; score: number; reasoning: string; evidence?: { file: string; line: number; note: string }[] }[];
  summary: string;
  globalScore: number;
  /** Phase 1 exploration trace (analysis, files read, full conversation) */
  exploration?: ReviewerExploration;
  /** Errors from scoring strategy attempts (Phase 2 fallback chain) */
  scoringAttemptErrors?: string[];
}

export interface CheckResult {
  type: TaskExpectation["type"];
  passed: boolean;
  message: string;
  details?: string;
  scores?: DimensionScore[];
  globalScore?: number;
  /** Individual reviewer results (llm_review only) — shows how each reviewer voted */
  reviewers?: ReviewerResult[];
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
  llmReview?: string;
  scores?: DimensionScore[];
  globalScore?: number;
  timestamp: string;
  /** What triggered this assessment. */
  trigger?: AssessmentTrigger;
}

// === Mission ===

export type MissionStatus = "draft" | "scheduled" | "recurring" | "active" | "paused" | "completed" | "failed" | "cancelled";

export interface Mission {
  id: string;
  name: string;
  data: string;
  prompt?: string;
  status: MissionStatus;
  /** Absolute deadline (ISO timestamp). */
  deadline?: string;
  /** Cron expression or ISO timestamp for scheduled execution. */
  schedule?: string;
  /** End date for recurring schedules (ISO timestamp). After this date the schedule stops. */
  endDate?: string;
  /** Minimum average score for the mission to pass. */
  qualityThreshold?: number;
  /** Mission-level scoped notification rules. */
  notifications?: ScopedNotificationRules;
  /** How many times this mission has been executed. */
  executionCount?: number;
  createdAt: string;
  updatedAt: string;
}

// === Mission Document Types (parsed from Mission.data JSON) ===

/** Checkpoint defined within a mission — planned stopping point for human review.
 *  Pauses the mission when afterTasks complete; blocked tasks wait until resumed. */
export interface MissionCheckpoint {
  /** Checkpoint name (unique within the mission, used in events and resume calls). */
  name: string;
  /** Task titles that must all complete before this checkpoint triggers. */
  afterTasks: string[];
  /** Task titles that are blocked until the checkpoint is resumed. */
  blocksTasks: string[];
  /** Optional message shown when the checkpoint activates. */
  message?: string;
  /** Notification channels to alert when the checkpoint is reached. */
  notifyChannels?: string[];
}

/** Delay defined within a mission — timed wait between task groups.
 * Unlike checkpoints (which pause until a human resumes), delays automatically
 * resume after a specified duration elapses. */
export interface MissionDelay {
  /** Delay name (unique within the mission). */
  name: string;
  /** Task titles that must all complete before the delay timer starts. */
  afterTasks: string[];
  /** Task titles that are blocked until the delay timer expires. */
  blocksTasks: string[];
  /** ISO 8601 duration (e.g. "PT2H" = 2 hours, "PT30M" = 30 minutes, "P1D" = 1 day). */
  duration: string;
  /** Optional message shown when the delay starts. */
  message?: string;
  /** Notification channels to alert when the delay starts / expires. */
  notifyChannels?: string[];
}

/** Runtime state of an active delay (timer started, waiting to expire). */
export interface ActiveDelay {
  /** Mission group name. */
  group: string;
  /** Delay name. */
  delayName: string;
  /** Full delay definition. */
  delay: MissionDelay;
  /** ISO timestamp when the delay timer started. */
  startedAt: string;
  /** ISO timestamp when the delay will expire. */
  expiresAt: string;
}

/** Quality gate defined within a mission — automatic score-based blocking between task phases. */
export interface MissionQualityGate {
  /** Gate name (unique within the mission). */
  name: string;
  /** Task titles whose assessment scores are evaluated. */
  afterTasks: string[];
  /** Task titles blocked until the gate passes. */
  blocksTasks: string[];
  /** Minimum average score (1-5) of afterTasks required to pass. */
  minScore?: number;
  /** If true, all afterTasks must be "done" (not "failed") to pass. */
  requireAllPassed?: boolean;
  /** Custom condition expression. */
  condition?: string;
  /** Notification channels for pass/fail events. */
  notifyChannels?: string[];
}

export interface MissionReport {
  missionId: string;
  group: string;
  allPassed: boolean;
  totalDuration: number;
  tasks: {
    title: string;
    status: "done" | "failed";
    duration: number;
    score?: number;
    filesCreated: string[];
    filesEdited: string[];
    outcomes?: TaskOutcome[];
  }[];
  filesCreated: string[];
  filesEdited: string[];
  outcomes?: TaskOutcome[];
  avgScore?: number;
}

// === Notifications ===

export type NotificationSeverity = "info" | "warning" | "critical";
export type NotificationChannelType = "slack" | "email" | "telegram" | "whatsapp" | "webhook";
export type NotificationStatus = "sent" | "failed";

export type DmPolicy = "pairing" | "allowlist" | "open" | "disabled";

export interface ChannelGatewayConfig {
  dmPolicy?: DmPolicy;
  allowFrom?: string[];
  enableInbound?: boolean;
  sessionIdleMinutes?: number;
}

export interface NotificationChannelConfig {
  type: NotificationChannelType;
  webhookUrl?: string;
  to?: string[];
  provider?: string;
  apiKey?: string;
  botToken?: string;
  chatId?: string;
  profileDir?: string;
  url?: string;
  headers?: Record<string, string>;
  host?: string;
  port?: number;
  from?: string;
  gateway?: ChannelGatewayConfig;
}

export interface NotificationRule {
  id: string;
  name: string;
  events: string[];
  condition?: unknown;
  channels: string[];
  severity?: NotificationSeverity;
  template?: string;
  cooldownMs?: number;
  includeOutcomes?: boolean;
  outcomeFilter?: OutcomeType[];
  maxAttachmentSize?: number;
}

export interface ScopedNotificationRules {
  rules: NotificationRule[];
  /** If true, rules are added on top of parent scope. If false (default), they replace. */
  inherit?: boolean;
}

export interface NotificationRecord {
  id: string;
  timestamp: string;
  ruleId: string;
  ruleName: string;
  channel: string;
  channelType: string;
  status: NotificationStatus;
  error?: string;
  title: string;
  body: string;
  severity: NotificationSeverity;
  sourceEvent: string;
  attachmentCount: number;
  attachmentTypes?: OutcomeType[];
}

export interface NotificationStats {
  total: number;
  sent: number;
  failed: number;
}

export interface SendNotificationRequest {
  channel: string;
  title: string;
  body: string;
  severity?: NotificationSeverity;
  delayMs?: number;
}

export interface SendNotificationResult {
  id: string;
  scheduledAt: string;
  firesAt: string;
}

// === Approval Gates ===

export type ApprovalGateHandler = "auto" | "human";
export type ApprovalStatus = "pending" | "approved" | "rejected" | "timeout";

export interface ApprovalRequest {
  id: string;
  gateId: string;
  gateName: string;
  taskId?: string;
  missionId?: string;
  status: ApprovalStatus;
  payload: unknown;
  requestedAt: string;
  resolvedAt?: string;
  resolvedBy?: string;
  note?: string;
}

// === Scheduling ===

export interface ScheduleEntry {
  id: string;
  missionId: string;
  expression: string;
  recurring: boolean;
  enabled: boolean;
  lastRunAt?: string;
  nextRunAt?: string;
  deadlineOffsetMs?: number;
  createdAt: string;
}

// === Quality & SLA ===

export interface QualityMetrics {
  entityId: string;
  entityType: "task" | "agent" | "mission";
  totalAssessments: number;
  passedAssessments: number;
  avgScore?: number;
  minScore?: number;
  maxScore?: number;
  dimensionScores: Record<string, number>;
  totalRetries: number;
  totalFixes: number;
  deadlinesMet: number;
  deadlinesMissed: number;
  updatedAt: string;
}

// === Playbooks ===

export interface PlaybookParameter {
  /** Parameter name — used as {{name}} in the mission playbook. */
  name: string;
  /** Human-readable description. */
  description: string;
  /** Value type. Default: "string". */
  type?: "string" | "number" | "boolean";
  /** Whether the parameter must be provided. Default: false. */
  required?: boolean;
  /** Default value when not provided. */
  default?: string | number | boolean;
  /** Allowed values (enum constraint). */
  enum?: (string | number)[];
}

/** Lightweight playbook metadata (no mission body). */
export interface PlaybookInfo {
  name: string;
  description: string;
  parameters: PlaybookParameter[];
  /** Absolute path to the playbook directory. */
  path: string;
}

/** Full playbook definition including the mission body. */
export interface PlaybookDefinition {
  name: string;
  description: string;
  mission: Record<string, unknown>;
  parameters?: PlaybookParameter[];
}

/** Result of running a playbook. */
export interface PlaybookRunResult {
  mission: Mission;
  tasks: number;
  group: string;
  /** Non-blocking validation warnings (e.g. unknown parameters). */
  warnings?: string[];
}

// Backward-compat aliases
/** @deprecated Use PlaybookParameter instead. */
export type TemplateParameter = PlaybookParameter;
/** @deprecated Use PlaybookInfo instead. */
export type TemplateInfo = PlaybookInfo;
/** @deprecated Use PlaybookDefinition instead. */
export type TemplateDefinition = PlaybookDefinition;
/** @deprecated Use PlaybookRunResult instead. */
export type TemplateRunResult = PlaybookRunResult;

// === Config ===

/** Reasoning level for LLM calls. */
export type ReasoningLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

/** Primary model with ordered fallbacks. */
export interface ModelConfig {
  /** Primary model spec (e.g. "anthropic:claude-opus-4-6"). */
  primary?: string;
  /** Ordered fallback models — tried when primary fails. */
  fallbacks?: string[];
}

/** Model allowlist entry with optional alias and parameter overrides. */
export interface ModelAllowlistEntry {
  /** Display alias for this model (e.g. "Sonnet", "GPT"). */
  alias?: string;
  /** Per-model parameter overrides. */
  params?: Record<string, unknown>;
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

export interface PolpoSettings {
  maxRetries: number;
  workDir: string;
  logLevel: "quiet" | "normal" | "verbose";
  taskTimeout?: number;
  staleThreshold?: number;
  defaultRetryPolicy?: RetryPolicy;
  enableVolatileTeams?: boolean;
  volatileCleanup?: "on_complete" | "manual";
  maxFixAttempts?: number;
  maxQuestionRounds?: number;
  maxResolutionAttempts?: number;
  autoCorrectExpectations?: boolean;
  /** Skills to load into the orchestrator's system prompt. Resolved against the orchestrator skill pool. */
  orchestratorSkills?: string[];
  /** Model for orchestrator LLM calls. Can be a string or a ModelConfig with fallbacks. */
  orchestratorModel?: string | ModelConfig;
  imageModel?: string;
  modelAllowlist?: Record<string, ModelAllowlistEntry>;
  /** Global reasoning / deep thinking level. */
  reasoning?: ReasoningLevel;
  storage?: "file" | "sqlite";
  maxAssessmentRetries?: number;
  maxConcurrency?: number;
  approvalGates?: Array<Record<string, unknown>>;
  notifications?: Record<string, unknown>;
  escalationPolicy?: Record<string, unknown>;
  sla?: Record<string, unknown>;
  enableScheduler?: boolean;
  defaultQualityThreshold?: number;
  emailAllowedDomains?: string[];
  mcpToolAllowlist?: Record<string, string[]>;
}

export interface ProviderConfig {
  baseUrl?: string;
  /** API compatibility mode for custom endpoints. */
  api?: "openai-completions" | "openai-responses" | "anthropic-messages";
  /** Custom model definitions for this provider. */
  models?: CustomModelDef[];
}

export interface PolpoConfig {
  version: string;
  org: string;
  teams: Team[];
  tasks: Omit<Task, "status" | "retries" | "result" | "createdAt" | "updatedAt">[];
  settings: PolpoSettings;
  providers?: Record<string, ProviderConfig>;
}

export interface PolpoState {
  org: string;
  teams: Team[];
  tasks: Task[];
  processes: AgentProcess[];
  startedAt?: string;
  completedAt?: string;
}

export interface AddTeamRequest {
  name: string;
  description?: string;
}

// === API ===

export type ErrorCode =
  | "NOT_FOUND"
  | "INVALID_STATE"
  | "VALIDATION_ERROR"
  | "AUTH_REQUIRED"
  | "FORBIDDEN"
  | "CONFLICT"
  | "INTERNAL_ERROR";

export interface ApiResponse<T> {
  ok: true;
  data: T;
}

export interface ApiError {
  ok: false;
  error: string;
  code: ErrorCode;
  details?: unknown;
}

export type ApiResult<T> = ApiResponse<T> | ApiError;

// === Request DTOs ===

export interface CreateTaskRequest {
  title: string;
  description: string;
  assignTo: string;
  /** Create task as draft (won't be picked up until queued). Default: false. */
  draft?: boolean;
  expectations?: TaskExpectation[];
  expectedOutcomes?: ExpectedOutcome[];
  dependsOn?: string[];
  group?: string;
  maxDuration?: number;
  retryPolicy?: RetryPolicy;
  notifications?: ScopedNotificationRules;
}

export interface UpdateTaskRequest {
  description?: string;
  assignTo?: string;
  status?: TaskStatus;
  expectations?: TaskExpectation[];
}

export interface CreateMissionRequest {
  data: string;
  prompt?: string;
  name?: string;
  status?: MissionStatus;
  notifications?: ScopedNotificationRules;
}

export interface UpdateMissionRequest {
  data?: string;
  status?: MissionStatus;
  name?: string;
}

// === Atomic Mission Data Request DTOs ===

export interface AddMissionTaskRequest {
  title: string;
  description: string;
  assignTo?: string;
  dependsOn?: string[];
  expectations?: TaskExpectation[];
  expectedOutcomes?: ExpectedOutcome[];
  maxDuration?: number;
  retryPolicy?: RetryPolicy;
  notifications?: ScopedNotificationRules;
}

export interface UpdateMissionTaskRequest {
  title?: string;
  description?: string;
  assignTo?: string;
  dependsOn?: string[];
  expectations?: TaskExpectation[];
  expectedOutcomes?: ExpectedOutcome[];
  maxDuration?: number;
  retryPolicy?: RetryPolicy;
  notifications?: ScopedNotificationRules;
}

export interface ReorderMissionTasksRequest {
  titles: string[];
}

export interface AddMissionCheckpointRequest {
  name: string;
  afterTasks: string[];
  blocksTasks: string[];
  message?: string;
  notifyChannels?: string[];
}

export interface UpdateMissionCheckpointRequest {
  name?: string;
  afterTasks?: string[];
  blocksTasks?: string[];
  message?: string;
  notifyChannels?: string[];
}

export interface AddMissionDelayRequest {
  name: string;
  afterTasks: string[];
  blocksTasks: string[];
  duration: string;
  message?: string;
  notifyChannels?: string[];
}

export interface UpdateMissionDelayRequest {
  name?: string;
  afterTasks?: string[];
  blocksTasks?: string[];
  duration?: string;
  message?: string;
  notifyChannels?: string[];
}

export interface AddMissionQualityGateRequest {
  name: string;
  afterTasks: string[];
  blocksTasks: string[];
  minScore?: number;
  requireAllPassed?: boolean;
  condition?: string;
  notifyChannels?: string[];
}

export interface UpdateMissionQualityGateRequest {
  name?: string;
  afterTasks?: string[];
  blocksTasks?: string[];
  minScore?: number;
  requireAllPassed?: boolean;
  condition?: string;
  notifyChannels?: string[];
}

export interface AddMissionTeamMemberRequest {
  name: string;
  role?: string;
  model?: string;
  systemPrompt?: string;
  allowedTools?: string[];
}

export interface UpdateMissionTeamMemberRequest {
  name?: string;
  role?: string;
  model?: string;
  systemPrompt?: string;
  allowedTools?: string[];
}

export interface UpdateMissionNotificationsRequest {
  notifications: ScopedNotificationRules | null;
}

export interface AddAgentRequest {
  name: string;
  role?: string;
  model?: string;
  allowedTools?: string[];
  systemPrompt?: string;
  skills?: string[];
  maxTurns?: number;
  /** Max concurrent tasks for this agent. */
  maxConcurrency?: number;
  /** MCP servers to connect to. */
  mcpServers?: Record<string, McpServerConfig>;
  /** Filesystem sandbox — directories the agent is allowed to access. */
  allowedPaths?: string[];
  /** Agent identity (display name, bio, avatar). */
  identity?: AgentIdentity;
  // NOTE: Vault credentials managed via encrypted store, not in API body.
  /** Org chart: who this agent reports to. */
  reportsTo?: string;
  /** Allowed email recipient domains (overrides global setting). */
  emailAllowedDomains?: string[];
  // Tool categories activated via allowedTools (e.g. ["browser_*", "email_*", "image_*", "video_*", "audio_*", "excel_*", "pdf_*", "docx_*", "search_*"])
}

export interface UpdateAgentRequest {
  role?: string;
  model?: string;
  allowedTools?: string[];
  allowedPaths?: string[];
  systemPrompt?: string;
  skills?: string[];
  maxTurns?: number;
  maxConcurrency?: number;
  identity?: AgentIdentity;
  reportsTo?: string;
  reasoning?: string;
  browserProfile?: string;
  emailAllowedDomains?: string[];
  /** Move agent to a different team. */
  team?: string;
}

export interface UpdateSettingsRequest {
  orchestratorModel?: string | ModelConfig;
  imageModel?: string | null;
  reasoning?: ReasoningLevel;
}

// === SSE ===

export interface SSEEvent {
  id: string;
  event: string;
  data: unknown;
  timestamp: string;
}

// === Health ===

export interface HealthResponse {
  status: string;
  version: string;
  uptime: number;
}

// === Task Filters ===

export interface TaskFilters {
  status?: TaskStatus;
  group?: string;
  assignTo?: string;
}

// === Execution results ===

export interface ExecuteMissionResult {
  tasks: Task[];
  group: string;
}

export interface ResumeMissionResult {
  retried: number;
  pending: number;
}

// === Log types ===

export interface LogSession {
  sessionId: string;
  startedAt: string;
  entries: number;
}

export interface LogEntry {
  ts: string;
  event: string;
  data: unknown;
}

// === Run Activity types ===

/** A single entry from the per-run JSONL activity log. */
export interface RunActivityEntry {
  /** ISO timestamp (present on all entries except the header) */
  ts?: string;
  /** Event type: "spawning", "spawned", "activity", "sigterm", "done", "error" */
  event?: string;
  /** Transcript type: "stdout", "tool_use", "tool_result", "assistant", "error", "result" */
  type?: string;
  /** Agent output text (for stdout/assistant entries) */
  text?: string;
  /** Payload data (activity snapshot, lifecycle info, etc.) */
  data?: unknown;

  // ── tool_use fields ──
  /** Tool name (present on tool_use and tool_result entries) */
  tool?: string;
  /** Tool call ID (present on tool_use and tool_result entries) */
  toolId?: string;
  /** Tool input arguments (present on tool_use entries) */
  input?: Record<string, unknown>;

  // ── tool_result fields ──
  /** Tool output content (present on tool_result entries) */
  content?: string;
  /** Whether the tool call errored (present on tool_result entries) */
  isError?: boolean;

  /** Present on the header line only */
  _run?: boolean;
  runId?: string;
  taskId?: string;
  agentName?: string;
  startedAt?: string;
  pid?: number;
}

// === Skill types ===

/** A discovered skill from the project skill pool. */
export interface SkillInfo {
  name: string;
  description: string;
  allowedTools?: string[];
  /** Where this skill was discovered from. */
  source: "project" | "global" | "polpo" | "claude" | "home";
  /** Absolute path to the skill directory. */
  path: string;
  /** Freeform tags for search and filtering (from skills-index.json). */
  tags?: string[];
  /** Macro-category for grouping (from skills-index.json). */
  category?: string;
}

/** Skill with full content loaded (returned by GET /skills/:name/content). */
export interface LoadedSkill extends SkillInfo {
  /** Full SKILL.md content (markdown body without frontmatter). */
  content: string;
}

/** Skill with agent assignment info (returned by GET /skills). */
export interface SkillWithAssignment extends SkillInfo {
  /** Agent names that have this skill assigned. */
  assignedTo: string[];
}

/** A single entry in the skills index file (.polpo/skills-index.json). */
export interface SkillIndexEntry {
  /** Freeform tags for search and filtering. */
  tags?: string[];
  /** Macro-category for grouping. */
  category?: string;
}

/** The full skills index: maps skill names to their index metadata. */
export type SkillIndex = Record<string, SkillIndexEntry>;

// === Chat Session types ===

export interface ChatSession {
  id: string;
  title?: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  /** Agent name when this session targets a specific agent (agent-direct mode). Absent for orchestrator sessions. */
  agent?: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  ts: string;
  /** Tool calls executed during this assistant message (only for role=assistant) */
  toolCalls?: ToolCallEvent[];
}

// === Chat Completions types (OpenAI-compatible) ===

/** A text content part. */
export interface TextContentPart {
  type: "text";
  text: string;
}

/** An image content part (data URL or HTTPS URL). */
export interface ImageUrlContentPart {
  type: "image_url";
  image_url: {
    url: string;
    detail?: "auto" | "low" | "high";
  };
}

export type ContentPart = TextContentPart | ImageUrlContentPart;

export interface ChatCompletionMessage {
  role: "system" | "user" | "assistant";
  /** Plain string or multimodal content parts (text + images). */
  content: string | ContentPart[];
}

export interface ChatCompletionRequest {
  messages: ChatCompletionMessage[];
  stream?: boolean;
  /** Polpo extension: target a specific project by ID. If omitted, uses the first registered project. */
  project?: string;
  /** Ignored — Polpo uses its configured orchestrator model. */
  model?: string;
  /** Session ID for conversation persistence. If omitted, server auto-selects or creates one. */
  sessionId?: string;
  /** Target a specific agent by name for direct conversation. Uses the agent's own model, system prompt, and coding tools. Omit to talk to the orchestrator (default). */
  agent?: string;
}

export interface ChatCompletionChoice {
  index: number;
  message: { role: "assistant"; content: string };
  finish_reason: "stop" | "length" | "ask_user" | "mission_preview" | "vault_preview" | "open_file" | "navigate_to" | "open_tab";
  /** Present when finish_reason is "ask_user" — structured questions for the user. */
  ask_user?: AskUserPayload;
  /** Present when finish_reason is "mission_preview" — proposed mission for user review. */
  mission_preview?: MissionPreviewPayload;
  /** Present when finish_reason is "vault_preview" — proposed vault entry for user review. */
  vault_preview?: VaultPreviewPayload;
  /** Present when finish_reason is "open_file" — file path to open in preview dialog. */
  open_file?: OpenFilePayload;
  /** Present when finish_reason is "navigate_to" — navigate the UI to a specific page. */
  navigate_to?: NavigateToPayload;
  /** Present when finish_reason is "open_tab" — open a URL in a new browser tab. */
  open_tab?: OpenTabPayload;
}

export interface ChatCompletionResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface ChatCompletionChunkDelta {
  role?: string;
  content?: string;
}

// === Tool Call streaming ===

export type ToolCallState = "preparing" | "calling" | "completed" | "error" | "interrupted";

export interface ToolCallEvent {
  /** Tool call ID from the LLM */
  id: string;
  /** Tool name (e.g. "create_task", "get_status") */
  name: string;
  /** Tool input arguments (present when state is "calling") */
  arguments?: Record<string, unknown>;
  /** Tool execution result (present when state is "completed" or "error") */
  result?: string;
  /** Current state of the tool call */
  state: ToolCallState;
}

export interface ChatCompletionChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: ChatCompletionChunkDelta;
    finish_reason: string | null;
    /** Present when finish_reason is "ask_user" — structured questions for the user. */
    ask_user?: AskUserPayload;
    /** Present when finish_reason is "mission_preview" — proposed mission for user review. */
    mission_preview?: MissionPreviewPayload;
    /** Present when finish_reason is "vault_preview" — proposed vault entry for user review. */
    vault_preview?: VaultPreviewPayload;
    /** Present when finish_reason is "open_file" — file path to open in preview dialog. */
    open_file?: OpenFilePayload;
    /** Present when finish_reason is "navigate_to" — navigate the UI to a specific page. */
    navigate_to?: NavigateToPayload;
    /** Present when finish_reason is "open_tab" — open a URL in a new browser tab. */
    open_tab?: OpenTabPayload;
    /** Present when the server is executing a tool call. */
    tool_call?: ToolCallEvent;
  }>;
}

// === Ask User (structured clarification questions) ===

export interface AskUserOption {
  label: string;
  description?: string;
}

export interface AskUserQuestion {
  /** Unique question key for matching answers */
  id: string;
  /** The full question text */
  question: string;
  /** Short label for compact display (max 30 chars) */
  header?: string;
  /** Pre-populated selectable options */
  options: AskUserOption[];
  /** Allow selecting multiple options (default: false) */
  multiple?: boolean;
  /** Show custom text input (default: true) */
  custom?: boolean;
}

export interface AskUserPayload {
  questions: AskUserQuestion[];
}

export interface AskUserAnswer {
  questionId: string;
  /** Labels of selected options */
  selected: string[];
  /** Custom text typed by user */
  customText?: string;
}

// === Mission Preview (interactive review before creation) ===

export interface MissionPreviewPayload {
  /** Proposed mission name */
  name: string;
  /** Parsed mission document (tasks, qualityGates, etc.) */
  data: unknown;
  /** Original user prompt that generated this mission */
  prompt?: string;
}

// === Vault Entry Metadata (safe listing — no secret values) ===

export interface VaultEntryMeta {
  /** Service name (vault key, e.g. "gmail", "stripe") */
  service: string;
  /** Credential type */
  type: "smtp" | "imap" | "oauth" | "api_key" | "login" | "custom";
  /** Human-readable label */
  label?: string;
  /** Credential field names (e.g. ["host", "port", "user", "pass"]) — values are NOT exposed */
  keys: string[];
}

// === Auth Profile Metadata (safe — no tokens exposed) ===

export type AuthProfileStatus = "active" | "cooldown" | "billing_disabled" | "expired";
export type AuthProfileType = "oauth" | "api_key";

/** Metadata for a single auth profile — tokens are NEVER exposed. */
export interface AuthProfileMeta {
  id: string;
  type: AuthProfileType;
  email?: string;
  expires?: number;
  expired: boolean;
  hasRefresh: boolean;
  lastUsed?: string;
  createdAt: string;
  status: AuthProfileStatus;
  cooldownUntil?: number;
  disabledUntil?: number;
  lastErrorReason?: string;
  disabledReason?: string;
  errorCount?: number;
}

/** Per-provider auth health info. */
export interface ProviderAuthInfo {
  hasEnvKey: boolean;
  envVar?: string;
  profiles: AuthProfileMeta[];
  oauthAvailable: boolean;
  oauthProviderName?: string;
  oauthFlow?: string;
}

/** Full auth status response — all providers. */
export interface AuthStatusResponse {
  providers: Record<string, ProviderAuthInfo>;
}

// === Vault Preview (interactive credential review before saving) ===

export interface VaultPreviewPayload {
  /** Agent name */
  agent: string;
  /** Service name (vault key, e.g. "gmail", "stripe") */
  service: string;
  /** Credential type */
  type: "smtp" | "imap" | "oauth" | "api_key" | "login" | "custom";
  /** Human-readable label */
  label?: string;
  /** Credential key-value pairs — user can edit before confirming */
  credentials: Record<string, string>;
}

// === Client-side tools (executed on the user's device, not the server) ===

export interface OpenFilePayload {
  /** File path relative to project root */
  path: string;
}

export interface NavigateToPayload {
  /** Target page: dashboard, tasks, task, missions, mission, agents, agent, skills, skill, files, activity, chat, memory, settings */
  target: string;
  /** Entity ID for detail pages (task, mission) */
  id?: string;
  /** Entity name for detail pages (agent, skill) */
  name?: string;
  /** Directory path for files target */
  path?: string;
  /** File to highlight/select for files target */
  highlight?: string;
}

/** Payload for open_tab — opens a URL in a new browser tab. */
export interface OpenTabPayload {
  /** The URL to open */
  url: string;
  /** Optional human-readable label */
  label?: string;
}
