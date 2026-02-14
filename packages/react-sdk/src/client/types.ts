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

export interface DimensionScore {
  dimension: string;
  score: number;
  reasoning: string;
  weight: number;
}

export interface TaskExpectation {
  type: "test" | "file_exists" | "script" | "llm_review";
  command?: string;
  paths?: string[];
  criteria?: string;
  dimensions?: EvalDimension[];
  threshold?: number;
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
  createdAt: string;
  updatedAt: string;
}

export interface TaskResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  duration: number;
  assessment?: AssessmentResult;
}

// === Agent ===

export type AdapterType = "claude-sdk" | "generic" | string;

export interface AgentConfig {
  name: string;
  adapter: AdapterType;
  role?: string;
  command?: string;
  model?: string;
  allowedTools?: string[];
  mcpServers?: Record<string, unknown>;
  systemPrompt?: string;
  skills?: string[];
  maxTurns?: number;
  volatile?: boolean;
  planGroup?: string;
}

export interface AgentActivity {
  lastTool?: string;
  lastFile?: string;
  filesCreated: string[];
  filesEdited: string[];
  toolCalls: number;
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

export interface AssessmentResult {
  passed: boolean;
  checks: CheckResult[];
  metrics: MetricResult[];
  llmReview?: string;
  scores?: DimensionScore[];
  globalScore?: number;
  timestamp: string;
}

// === Plan ===

export type PlanStatus = "draft" | "active" | "completed" | "failed" | "cancelled";

export interface Plan {
  id: string;
  name: string;
  yaml: string;
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
  }[];
  filesCreated: string[];
  filesEdited: string[];
  avgScore?: number;
}

// === Config ===

export interface OrchestraSettings {
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

export interface OrchestraConfig {
  version: string;
  project: string;
  team: Team;
  tasks: Omit<Task, "status" | "retries" | "result" | "createdAt" | "updatedAt">[];
  settings: OrchestraSettings;
}

export interface OrchestraState {
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
  settings: OrchestraSettings;
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
  yaml: string;
  prompt?: string;
  name?: string;
  status?: PlanStatus;
}

export interface UpdatePlanRequest {
  yaml?: string;
  status?: PlanStatus;
  name?: string;
}

export interface AddAgentRequest {
  name: string;
  adapter: string;
  role?: string;
  command?: string;
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
  eventCount: number;
}

export interface LogEntry {
  timestamp: string;
  event: string;
  data: unknown;
}
