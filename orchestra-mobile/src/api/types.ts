/**
 * Polpo Mobile - Type Definitions
 * Duplicated from react-sdk to avoid pulling server dependencies
 */

// ── Task Types ────────────────────────────────────────────
export type TaskStatus = "pending" | "assigned" | "in_progress" | "review" | "done" | "failed";

export interface Task {
  id: string;
  title: string;
  description?: string;
  status: TaskStatus;
  assignTo?: string;
  group?: string;
  dependencies?: string[];
  acceptanceCriteria?: string[];
  result?: string;
  error?: string;
  retries?: number;
  maxRetries?: number;
  createdAt: string;
  updatedAt?: string;
}

export interface CreateTaskRequest {
  title: string;
  description?: string;
  assignTo?: string;
  group?: string;
  dependencies?: string[];
  acceptanceCriteria?: string[];
  maxRetries?: number;
}

export interface UpdateTaskRequest {
  title?: string;
  description?: string;
  assignTo?: string;
  group?: string;
  dependencies?: string[];
  acceptanceCriteria?: string[];
  maxRetries?: number;
}

export interface TaskFilters {
  status?: TaskStatus;
  group?: string;
  assignTo?: string;
}

// ── Plan Types ────────────────────────────────────────────
export type PlanStatus = "draft" | "running" | "completed" | "failed" | "aborted";

export interface Plan {
  id: string;
  name: string;
  description?: string;
  tasks: Task[];
  status: PlanStatus;
  group: string;
  createdAt: string;
  completedAt?: string;
}

export interface CreatePlanRequest {
  name: string;
  description?: string;
  tasks: CreateTaskRequest[];
  group?: string;
}

export interface UpdatePlanRequest {
  name?: string;
  description?: string;
  status?: PlanStatus;
}

export interface ExecutePlanResult {
  executed: boolean;
  taskIds: string[];
}

export interface ResumePlanResult {
  resumed: boolean;
  taskIds: string[];
}

// ── Agent Types ───────────────────────────────────────────
export interface AgentConfig {
  name: string;
  adapter: string;
  command?: string;
  maxConcurrent?: number;
  env?: Record<string, string>;
}

export interface AddAgentRequest {
  name: string;
  adapter: string;
  command?: string;
  maxConcurrent?: number;
  env?: Record<string, string>;
}

export interface Team {
  name: string;
  agents: AgentConfig[];
}

export interface AgentProcess {
  taskId: string;
  agentName: string;
  pid: number;
  sessionId?: string;
  startedAt: string;
  alive: boolean;
}

// ── State & Config Types ──────────────────────────────────
export interface OrchestraState {
  tasks: Task[];
  plans: Plan[];
  agents: AgentConfig[];
  team: Team;
  processes: AgentProcess[];
}

export interface OrchestraConfig {
  projectPath: string;
  projectId: string;
  pollInterval?: number;
  taskTimeout?: number;
  staleThreshold?: number;
}

// ── Memory & Logs ─────────────────────────────────────────
export interface LogSession {
  sessionId: string;
  taskId: string;
  agentName: string;
  startedAt: string;
  finishedAt?: string;
}

export interface LogEntry {
  timestamp: string;
  level: string;
  message: string;
  data?: unknown;
}

// ── Project & Health ──────────────────────────────────────
export interface ProjectInfo {
  id: string;
  path: string;
  name: string;
}

export interface HealthResponse {
  status: "ok";
  version: string;
  uptime: number;
}

// ── API Response ──────────────────────────────────────────
export interface ApiResult<T> {
  ok: boolean;
  data: T;
  error?: string;
  code?: string;
  details?: unknown;
}

// ── SSE Events ────────────────────────────────────────────
export type OrchestraEventType =
  | "task:created"
  | "task:transition"
  | "task:updated"
  | "task:removed"
  | "task:retry"
  | "task:fix"
  | "task:maxRetries"
  | "task:question"
  | "task:answered"
  | "task:timeout"
  | "task:recovered"
  | "agent:spawned"
  | "agent:finished"
  | "agent:activity"
  | "agent:stale"
  | "assessment:started"
  | "assessment:progress"
  | "assessment:complete"
  | "assessment:corrected"
  | "orchestrator:started"
  | "orchestrator:tick"
  | "orchestrator:deadlock"
  | "orchestrator:shutdown"
  | "deadlock:detected"
  | "deadlock:resolving"
  | "deadlock:resolved"
  | "deadlock:unresolvable"
  | "plan:saved"
  | "plan:executed"
  | "plan:completed"
  | "plan:resumed"
  | "plan:deleted"
  | "log";

export interface SSEEvent {
  id: string;
  event: string;
  data: unknown;
  timestamp: string;
}

export type ConnectionStatus =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected"
  | "error";
