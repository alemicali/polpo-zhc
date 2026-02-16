/**
 * OpenPolpo API types — mirrors the server contract.
 * Intentionally decoupled from @openpolpo/core to avoid pulling
 * server-side dependencies (blessed, sqlite, etc.) into the client bundle.
 */

// === Task ===

export type TaskStatus =
  | "pending"
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
  expectedOutcomes?: ExpectedOutcome[];
  outcomes?: TaskOutcome[];
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
  dependsOn?: string[];
  group?: string;
  maxDuration?: number;
  retryPolicy?: RetryPolicy;
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
  /** Transcript type: "stdout", "tool_use", "tool_result", "assistant", etc. */
  type?: string;
  /** Agent output text (for stdout/transcript entries) */
  text?: string;
  /** Payload data (activity snapshot, lifecycle info, etc.) */
  data?: unknown;
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
