import type {
  TaskExpectation,
  RetryPolicy,
  PlanStatus,
} from "../core/types.js";
import type { OrchestraEvent } from "../core/events.js";

// === API Response Envelope ===

export interface ApiResponse<T> {
  ok: true;
  data: T;
}

export interface ApiError {
  ok: false;
  error: string;
  code: string;
  details?: unknown;
}

export type ApiResult<T> = ApiResponse<T> | ApiError;

// === Error Codes ===

export type ErrorCode =
  | "NOT_FOUND"
  | "INVALID_STATE"
  | "VALIDATION_ERROR"
  | "AUTH_REQUIRED"
  | "FORBIDDEN"
  | "CONFLICT"
  | "INTERNAL_ERROR";

// === Task Endpoints ===

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

// === Plan Endpoints ===

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

// === Agent Endpoints ===

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

// === SSE Event ===

export interface SSEEvent {
  id: string;
  event: OrchestraEvent;
  data: unknown;
  timestamp: string;
}

// === Project ===

export interface ProjectInfo {
  id: string;
  name: string;
  workDir: string;
  status: "running" | "stopped" | "idle";
  taskCount: number;
  agentCount: number;
}

// === Server Config ===

export interface ServerConfig {
  port: number;
  host: string;
  apiKeys?: string[];
  projects: ProjectEntry[];
  corsOrigins?: string[];
}

export interface ProjectEntry {
  id: string;
  workDir: string;
  autoStart?: boolean;
}

// === WebSocket Protocol ===

export interface WSSubscribeMessage {
  type: "subscribe";
  events?: OrchestraEvent[];
}

export interface WSUnsubscribeMessage {
  type: "unsubscribe";
  events?: OrchestraEvent[];
}

export interface WSCommandMessage {
  type: "command";
  action: string;
  params: Record<string, unknown>;
}

export type WSClientMessage = WSSubscribeMessage | WSUnsubscribeMessage | WSCommandMessage;

export interface WSServerEvent {
  type: "event";
  event: OrchestraEvent;
  data: unknown;
  id: string;
  timestamp: string;
}

export interface WSServerError {
  type: "error";
  error: string;
  code: ErrorCode;
}

export type WSServerMessage = WSServerEvent | WSServerError;
