import type {
  TaskExpectation,
  ExpectedOutcome,
  RetryPolicy,
  MissionStatus,
} from "../core/types.js";
import type { PolpoEvent } from "../core/events.js";

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
  expectedOutcomes?: ExpectedOutcome[];
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

// === Mission Endpoints ===

export interface CreateMissionRequest {
  data: string;
  prompt?: string;
  name?: string;
  status?: MissionStatus;
}

export interface UpdateMissionRequest {
  data?: string;
  status?: MissionStatus;
  name?: string;
}

// === Agent Endpoints ===

export interface AddAgentRequest {
  name: string;
  role?: string;
  model?: string;
  allowedTools?: string[];
  systemPrompt?: string;
  skills?: string[];
  maxTurns?: number;
  // Identity & hierarchy (vault credentials managed via encrypted store)
  identity?: import("../core/types.js").AgentIdentity;
  reportsTo?: string;
  // Extended tool categories (browser, email, vault, image, video, audio, excel, pdf, docx, search — HTTP is always-on core)
  browserProfile?: string;
}

// === SSE Event ===

export interface SSEEvent {
  id: string;
  event: PolpoEvent;
  data: unknown;
  timestamp: string;
}

// === Server Config ===

export interface ServerConfig {
  port: number;
  host: string;
  workDir: string;
  apiKeys?: string[];
  corsOrigins?: string[];
  /** Start the supervisor loop on server start. Default: true. */
  autoStart?: boolean;
}
