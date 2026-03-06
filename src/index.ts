// Core abstractions
export * from "./core/index.js";

// Orchestrator
export { Orchestrator, buildRetryPrompt } from "./core/orchestrator.js";
export type { OrchestratorOptions, AssessFn } from "./core/orchestrator.js";

// Stores
export { FileTaskStore, FileRunStore, JsonTaskStore, SqliteTaskStore } from "./stores/index.js";

// Engine
export { spawnEngine } from "./adapters/engine.js";

// Assessment
export { assessTask, runCheck, runMetric } from "./assessment/assessor.js";
export { runLLMReview, computeWeightedScore, buildRubricSection, DEFAULT_DIMENSIONS, validateReviewPayload, ReviewPayloadSchema, findLogForTask, buildExecutionSummary } from "./assessment/index.js";
export type { LLMQueryFn } from "./assessment/llm-review.js";
export type { ValidatedReviewPayload, ExecutionSummaryResult } from "./assessment/index.js";

// Config
export { parseConfig, loadPolpoConfig, savePolpoConfig, generatePolpoConfigDefault, validateAgents } from "./core/config.js";

// Session reader
export { readSessionSummary, readSessionSummaryFromPath, getRecentMessages, findTranscriptPath } from "./core/session-reader.js";

// Server
export { PolpoServer, createApp, SSEBridge } from "./server/index.js";
export type {
  ServerConfig,
  ApiResponse,
  ApiError,
  SSEEvent,
  CreateTaskRequest,
  UpdateTaskRequest,
  CreateMissionRequest,
  UpdateMissionRequest,
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
export { safeEnv, bashSafeEnv } from "./tools/safe-env.js";

// Extended Tools
export { createCodingTools, createAllTools, ALL_EXTENDED_TOOL_NAMES } from "./tools/coding-tools.js";
export type { ExtendedToolName, CreateAllToolsOptions } from "./tools/coding-tools.js";
export { createBrowserTools, ALL_BROWSER_TOOL_NAMES } from "./tools/browser-tools.js";
export { createHttpTools, ALL_HTTP_TOOL_NAMES } from "./tools/http-tools.js";
export { createExcelTools, ALL_EXCEL_TOOL_NAMES } from "./tools/excel-tools.js";
export { createPdfTools, ALL_PDF_TOOL_NAMES } from "./tools/pdf-tools.js";
export { createDocxTools, ALL_DOCX_TOOL_NAMES } from "./tools/docx-tools.js";
export { createEmailTools, ALL_EMAIL_TOOL_NAMES } from "./tools/email-tools.js";
export { createVaultTools, ALL_VAULT_TOOL_NAMES } from "./tools/vault-tools.js";
export { createAudioTools, ALL_AUDIO_TOOL_NAMES } from "./tools/audio-tools.js";
export { createImageTools, ALL_IMAGE_TOOL_NAMES } from "./tools/image-tools.js";

// Templates
export { discoverTemplates, loadTemplate, validateParams, instantiateTemplate, validateTemplateDefinition, saveTemplate, deleteTemplate } from "./core/template.js";
export type { TemplateParameter, TemplateDefinition, TemplateInfo, ValidationResult } from "./core/template.js";

// Quality Layer
export { SLAMonitor } from "./quality/sla-monitor.js";
export { QualityController } from "./quality/quality-controller.js";

// Scheduling
export { Scheduler } from "./scheduling/scheduler.js";
export { parseCron, matchesCron, nextCronOccurrence, isCronExpression } from "./scheduling/cron.js";
