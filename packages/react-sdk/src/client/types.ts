/**
 * OpenPolpo API types — mirrors the server contract.
 * Intentionally decoupled from @openpolpo/core to avoid pulling
 * server-side dependencies (blessed, sqlite, etc.) into the client bundle.
 */

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
  producedAt?: string;
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

/**
 * Adapter type for external agent runtimes.
 * When not specified (undefined), Polpo's built-in engine (Pi Agent) is used.
 */
export type AdapterType = "claude-sdk" | string;

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

export interface AgentConfig {
  name: string;
  /** External adapter. When omitted, Polpo's built-in engine is used. */
  adapter?: AdapterType;
  role?: string;
  model?: string;
  allowedTools?: string[];
  /** MCP servers to connect to. Works with both the built-in engine and claude-sdk adapter. */
  mcpServers?: Record<string, McpServerConfig>;
  /** Filesystem sandbox — directories the agent is allowed to access.
   *  When omitted, defaults to the project workDir. */
  allowedPaths?: string[];
  systemPrompt?: string;
  skills?: string[];
  maxTurns?: number;
  /** Max concurrent tasks for this agent. Default: unlimited. */
  maxConcurrency?: number;
  volatile?: boolean;
  planGroup?: string;
}

export interface AgentActivity {
  lastTool?: string;
  lastFile?: string;
  filesCreated: string[];
  filesEdited: string[];
  toolCalls: number;
  totalTokens?: number;
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

// === Plan ===

export type PlanStatus = "draft" | "active" | "completed" | "failed" | "cancelled";

export interface Plan {
  id: string;
  name: string;
  data: string;
  prompt?: string;
  status: PlanStatus;
  /** Absolute deadline (ISO timestamp). */
  deadline?: string;
  /** Cron expression or ISO timestamp for scheduled execution. */
  schedule?: string;
  /** Re-execute on every schedule trigger. Default: false (one-shot). */
  recurring?: boolean;
  /** Minimum average score for the plan to pass. */
  qualityThreshold?: number;
  /** Plan-level scoped notification rules. */
  notifications?: ScopedNotificationRules;
  createdAt: string;
  updatedAt: string;
}

export interface PlanReport {
  planId: string;
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
  planId?: string;
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
  planId: string;
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
  entityType: "task" | "agent" | "plan";
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

// === Workflows ===

export interface WorkflowParameter {
  /** Parameter name — used as {{name}} in the plan template. */
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

/** Lightweight workflow metadata (no plan body). */
export interface WorkflowInfo {
  name: string;
  description: string;
  parameters: WorkflowParameter[];
  /** Absolute path to the workflow directory. */
  path: string;
}

/** Full workflow definition including the plan template. */
export interface WorkflowDefinition {
  name: string;
  description: string;
  plan: Record<string, unknown>;
  parameters?: WorkflowParameter[];
}

/** Result of running a workflow. */
export interface WorkflowRunResult {
  plan: Plan;
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
  orchestratorModel?: string;
}

export interface PolpoConfig {
  version: string;
  project: string;
  team: Team;
  tasks: Omit<Task, "status" | "retries" | "result" | "createdAt" | "updatedAt">[];
  settings: PolpoSettings;
}

export interface PolpoState {
  project: string;
  team: Team;
  tasks: Task[];
  processes: AgentProcess[];
  startedAt?: string;
  completedAt?: string;
}

export interface ProviderConfig {
  apiKey?: string;
  baseUrl?: string;
}

export interface PolpoConfig {
  project: string;
  team: Team;
  settings: PolpoSettings;
  providers?: Record<string, ProviderConfig>;
}

// === API ===

export interface ProjectInfo {
  id: string;
  name: string;
  workDir: string;
  status: "running" | "stopped" | "idle";
  taskCount: number;
  agentCount: number;
}

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

export interface CreatePlanRequest {
  data: string;
  prompt?: string;
  name?: string;
  status?: PlanStatus;
  notifications?: ScopedNotificationRules;
}

export interface UpdatePlanRequest {
  data?: string;
  status?: PlanStatus;
  name?: string;
}

export interface AddAgentRequest {
  name: string;
  adapter?: string;
  role?: string;
  model?: string;
  allowedTools?: string[];
  systemPrompt?: string;
  skills?: string[];
  maxTurns?: number;
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

export interface ExecutePlanResult {
  tasks: Task[];
  group: string;
}

export interface ResumePlanResult {
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
  source: "polpo" | "claude" | "home";
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
}

export interface ChatResponse {
  response: string;
  sessionId: string;
}
