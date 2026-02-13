// Core abstractions
export * from "./core/index.js";

// Orchestrator
export { Orchestrator, buildRetryPrompt } from "./core/orchestrator.js";
export type { OrchestratorOptions, AssessFn } from "./core/orchestrator.js";

// Stores
export { JsonTaskStore, SqliteTaskStore } from "./stores/index.js";

// Adapters
export { registerAdapter, getAdapter, createActivity } from "./adapters/registry.js";
export { ClaudeSDKAdapter, buildPrompt } from "./adapters/claude-sdk.js";
export { GenericAdapter, shellEscape } from "./adapters/generic.js";

// Assessment
export { assessTask, runCheck, runMetric } from "./assessment/assessor.js";
export { runLLMReview, computeWeightedScore, buildRubricSection, DEFAULT_DIMENSIONS } from "./assessment/index.js";
export type { LLMQueryFn } from "./assessment/llm-review.js";

// Config
export { parseConfig, generateTemplate } from "./core/config.js";

// Session reader
export { readSessionSummary, readSessionSummaryFromPath, getRecentMessages, findTranscriptPath } from "./core/session-reader.js";

// Bridge
export { BridgeManager } from "./bridge/index.js";
export type { BridgeConfig, BridgeSessionState, BridgeSessionStatus } from "./bridge/types.js";

// Server
export { OrchestraServer, createApp, ProjectManager, SSEBridge, WSBridge } from "./server/index.js";
export type {
  ServerConfig,
  ProjectEntry,
  ProjectInfo,
  ApiResponse,
  ApiError,
  SSEEvent,
  CreateTaskRequest,
  UpdateTaskRequest,
  CreatePlanRequest,
  UpdatePlanRequest,
  AddAgentRequest,
} from "./server/index.js";

// Backward compat alias
export { JsonTaskStore as TaskRegistry } from "./stores/index.js";
