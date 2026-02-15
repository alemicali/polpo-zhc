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
export { PolpoServer, createApp, ProjectManager, SSEBridge, WSBridge } from "./server/index.js";
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
export type { NotificationChannel, Notification, OutcomeAttachment } from "./notifications/types.js";
export type { NotificationStore, NotificationRecord, NotificationStatus } from "./core/notification-store.js";
export { FileNotificationStore } from "./stores/file-notification-store.js";
export { SqliteNotificationStore } from "./stores/sqlite-notification-store.js";
export { SlackChannel } from "./notifications/channels/slack.js";
export { TelegramChannel } from "./notifications/channels/telegram.js";
export { EmailChannel } from "./notifications/channels/email.js";
export { WebhookChannel } from "./notifications/channels/webhook.js";

// Security
export { safeEnv, bashSafeEnv, mcpSafeEnv } from "./tools/safe-env.js";

// Extended Tools
export { createCodingTools, createAllTools, ALL_EXTENDED_TOOL_NAMES } from "./tools/coding-tools.js";
export type { ExtendedToolName, CreateAllToolsOptions } from "./tools/coding-tools.js";
export { createBrowserTools, ALL_BROWSER_TOOL_NAMES } from "./tools/browser-tools.js";
export { createHttpTools, ALL_HTTP_TOOL_NAMES } from "./tools/http-tools.js";
export { createGitTools, ALL_GIT_TOOL_NAMES } from "./tools/git-tools.js";
export { createMultifileTools, ALL_MULTIFILE_TOOL_NAMES } from "./tools/multifile-tools.js";
export { createDepTools, ALL_DEP_TOOL_NAMES } from "./tools/dep-tools.js";
export { createExcelTools, ALL_EXCEL_TOOL_NAMES } from "./tools/excel-tools.js";
export { createPdfTools, ALL_PDF_TOOL_NAMES } from "./tools/pdf-tools.js";
export { createDocxTools, ALL_DOCX_TOOL_NAMES } from "./tools/docx-tools.js";
export { createEmailTools, ALL_EMAIL_TOOL_NAMES } from "./tools/email-tools.js";
export { createAudioTools, ALL_AUDIO_TOOL_NAMES } from "./tools/audio-tools.js";
export { createImageTools, ALL_IMAGE_TOOL_NAMES } from "./tools/image-tools.js";

// Quality Layer
export { SLAMonitor } from "./quality/sla-monitor.js";
export { QualityController } from "./quality/quality-controller.js";

// Scheduling
export { Scheduler } from "./scheduling/scheduler.js";
export { parseCron, matchesCron, nextCronOccurrence, isCronExpression } from "./scheduling/cron.js";
