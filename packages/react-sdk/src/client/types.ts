/**
 * OpenPolpo API types — mirrors the server contract.
 * Intentionally decoupled from @openpolpo/core to avoid pulling
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
  /** Responsibilities — simple strings or structured objects with area/description/priority */
  responsibilities?: (string | AgentResponsibility)[];
  /** Communication tone — HOW the agent communicates */
  tone?: string;
  /** Personality traits — WHO the agent IS as a persona */
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

export interface AgentConfig {
  name: string;
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
  /** Per-agent credential vault — keyed by service name */
  vault?: Record<string, VaultEntry>;
  /** Agent this one reports to — org chart hierarchy for escalation */
  reportsTo?: string;
  systemPrompt?: string;
  skills?: string[];
  maxTurns?: number;
  /** Max concurrent tasks for this agent. Default: unlimited. */
  maxConcurrency?: number;
  volatile?: boolean;
  missionGroup?: string;

  // Extended tool categories (opt-in)
  /** Enable browser automation tools (browser_navigate, browser_click, etc.) */
  enableBrowser?: boolean;
  /** Browser engine: "agent-browser" (default) or "playwright" (persistent profiles) */
  browserEngine?: "agent-browser" | "playwright";
  /** Browser profile name for persistent context (cookies, auth). Only with browserEngine: "playwright". */
  browserProfile?: string;
  /** Enable HTTP/fetch tools (http_fetch, http_download) */
  enableHttp?: boolean;
  /** Enable structured git tools (git_status, git_diff, git_log, etc.) */
  enableGit?: boolean;
  /** Enable multi-file editing tools (multi_edit, regex_replace, bulk_rename) */
  enableMultifile?: boolean;
  /** Enable dependency management tools (dep_install, dep_add, etc.) */
  enableDeps?: boolean;
  /** Enable Excel/CSV tools (excel_read, excel_write, etc.) */
  enableExcel?: boolean;
  /** Enable PDF tools (pdf_read, pdf_create, pdf_merge, pdf_info) */
  enablePdf?: boolean;
  /** Enable Word/DOCX tools (docx_read, docx_create) */
  enableDocx?: boolean;
  /** Enable email tools (email_send, email_verify, email_list, email_read, email_search) */
  enableEmail?: boolean;
  /** Enable audio tools (audio_transcribe, audio_speak) */
  enableAudio?: boolean;
  /** Enable image tools (image_generate, image_analyze) */
  enableImage?: boolean;
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

export interface CheckResult {
  type: TaskExpectation["type"];
  passed: boolean;
  message: string;
  details?: string;
  scores?: DimensionScore[];
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
  llmReview?: string;
  scores?: DimensionScore[];
  globalScore?: number;
  timestamp: string;
  /** What triggered this assessment. */
  trigger?: AssessmentTrigger;
}

// === Mission ===

export type MissionStatus = "draft" | "active" | "paused" | "completed" | "failed" | "cancelled";

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
  /** Re-execute on every schedule trigger. Default: false (one-shot). */
  recurring?: boolean;
  /** Minimum average score for the mission to pass. */
  qualityThreshold?: number;
  /** Mission-level scoped notification rules. */
  notifications?: ScopedNotificationRules;
  createdAt: string;
  updatedAt: string;
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
export type NotificationChannelType = "slack" | "email" | "telegram" | "webhook";
export type NotificationStatus = "sent" | "failed";

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

// === Templates ===

export interface TemplateParameter {
  /** Parameter name — used as {{name}} in the mission template. */
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

/** Lightweight template metadata (no mission body). */
export interface TemplateInfo {
  name: string;
  description: string;
  parameters: TemplateParameter[];
  /** Absolute path to the template directory. */
  path: string;
}

/** Full template definition including the mission template. */
export interface TemplateDefinition {
  name: string;
  description: string;
  mission: Record<string, unknown>;
  parameters?: TemplateParameter[];
}

/** Result of running a template. */
export interface TemplateRunResult {
  mission: Mission;
  tasks: number;
  group: string;
}

// === Config ===

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
  orchestratorModel?: string;
  imageModel?: string;
  modelAllowlist?: Record<string, { alias?: string; maxTokens?: number }>;
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
  apiKey?: string;
  baseUrl?: string;
}

export interface PolpoConfig {
  version: string;
  project: string;
  teams: Team[];
  tasks: Omit<Task, "status" | "retries" | "result" | "createdAt" | "updatedAt">[];
  settings: PolpoSettings;
  providers?: Record<string, ProviderConfig>;
}

export interface PolpoState {
  project: string;
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
  /** Vault credentials. */
  vault?: Record<string, VaultEntry>;
  /** Org chart: who this agent reports to. */
  reportsTo?: string;
  /** Allowed email recipient domains (overrides global setting). */
  emailAllowedDomains?: string[];
  // Extended tool categories (opt-in)
  enableBrowser?: boolean;
  enableHttp?: boolean;
  enableGit?: boolean;
  enableMultifile?: boolean;
  enableDeps?: boolean;
  enableExcel?: boolean;
  enablePdf?: boolean;
  enableDocx?: boolean;
  enableEmail?: boolean;
  enableAudio?: boolean;
  enableImage?: boolean;
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
}

// === Chat Session types ===

export interface ChatSession {
  id: string;
  title?: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
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

export interface ChatCompletionMessage {
  role: "system" | "user" | "assistant";
  content: string;
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
}

export interface ChatCompletionChoice {
  index: number;
  message: { role: "assistant"; content: string };
  finish_reason: "stop" | "length" | "ask_user";
  /** Present when finish_reason is "ask_user" — structured questions for the user. */
  ask_user?: AskUserPayload;
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

export type ToolCallState = "calling" | "completed" | "error";

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
