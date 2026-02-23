import type {
  TaskExpectation,
  ExpectedOutcome,
  RetryPolicy,
  PlanStatus,
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
  role?: string;
  model?: string;
  allowedTools?: string[];
  systemPrompt?: string;
  skills?: string[];
  maxTurns?: number;
  // Identity, vault, hierarchy
  identity?: import("../core/types.js").AgentIdentity;
  vault?: Record<string, import("../core/types.js").VaultEntry>;
  reportsTo?: string;
  // Extended tool categories
  enableBrowser?: boolean;
  browserEngine?: "agent-browser" | "playwright";
  browserProfile?: string;
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

// === SSE Event ===

export interface SSEEvent {
  id: string;
  event: PolpoEvent;
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


