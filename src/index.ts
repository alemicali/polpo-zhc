// Core abstractions
export * from "./core/index.js";

// Orchestrator
export { Orchestrator, buildRetryPrompt } from "./core/orchestrator.js";
export type { OrchestratorOptions, AssessFn } from "./core/orchestrator.js";

// Stores
export { FileTaskStore, FileRunStore, JsonTaskStore, SqliteTaskStore } from "./stores/index.js";

// Adapters & Engine
export { registerAdapter, getAdapter, createActivity } from "./adapters/registry.js";
export { spawnEngine } from "./adapters/engine.js";

// Assessment
export { assessTask, runCheck, runMetric } from "./assessment/assessor.js";
export { runLLMReview, computeWeightedScore, buildRubricSection, DEFAULT_DIMENSIONS } from "./assessment/index.js";
export type { LLMQueryFn } from "./assessment/llm-review.js";

// Config
export { parseConfig, loadPolpoConfig, savePolpoConfig, generatePolpoConfigDefault, validateAgents } from "./core/config.js";

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

// Notifications
export { NotificationRouter } from "./notifications/index.js";
export type { NotificationChannel, Notification } from "./notifications/types.js";
export { SlackChannel } from "./notifications/channels/slack.js";
export { TelegramChannel } from "./notifications/channels/telegram.js";
export { EmailChannel } from "./notifications/channels/email.js";
export { WebhookChannel } from "./notifications/channels/webhook.js";

// Security
export { safeEnv, bashSafeEnv, mcpSafeEnv } from "./tools/safe-env.js";

// Quality Layer
export { SLAMonitor } from "./quality/sla-monitor.js";
export { QualityController } from "./quality/quality-controller.js";

// Scheduling
export { Scheduler } from "./scheduling/scheduler.js";
export { parseCron, matchesCron, nextCronOccurrence, isCronExpression } from "./scheduling/cron.js";
