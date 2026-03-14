// Core abstractions (includes orchestrator, config, session-reader, state-machine,
// types, events, hooks, playbooks, templates, ink, quality, scheduling, etc.)
export * from "./core/index.js";

// Stores
export { FileTaskStore, FileRunStore, JsonTaskStore } from "./stores/index.js";

// Engine
export { spawnEngine } from "./adapters/engine.js";

// Assessment
export { assessTask, runCheck, runMetric } from "./assessment/assessor.js";
export { runLLMReview, computeWeightedScore, buildRubricSection, DEFAULT_DIMENSIONS, validateReviewPayload, ReviewPayloadSchema, findLogForTask, buildExecutionSummary } from "./assessment/index.js";
export type { LLMQueryFn } from "./assessment/llm-review.js";
export type { ValidatedReviewPayload, ExecutionSummaryResult } from "./assessment/index.js";

// Server
export { PolpoServer, createApp, SSEBridge } from "./server/index.js";
export type { AppOptions } from "./server/index.js";
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

// Route factories (for cloud data-plane wiring)
export {
  taskRoutes,
  missionRoutes,
  agentRoutes,
  eventRoutes,
  chatRoutes,
  skillRoutes,
  notificationRoutes,
  approvalRoutes,
  playbookRoutes,
  stateRoutes,
  completionRoutes,
  peerRoutes,
  scheduleRoutes,
  watcherRoutes,
  vaultRoutes,
  authRoutes,
  fileRoutes,
  configRoutes,
  publicConfigRoutes,
  healthRoutes,
} from "./server/index.js";

// Notifications (channels are not in core/index)
export { NotificationRouter } from "./notifications/index.js";
export type { NotificationChannel, Notification, OutcomeAttachment } from "./notifications/types.js";
export { FileNotificationStore } from "./stores/file-notification-store.js";
export { SlackChannel } from "./notifications/channels/slack.js";
export { TelegramChannel } from "./notifications/channels/telegram.js";
export { EmailChannel } from "./notifications/channels/email.js";
export { WebhookChannel } from "./notifications/channels/webhook.js";

// Security
export { safeEnv, bashSafeEnv } from "./tools/safe-env.js";

// Extended Tools
export { createSystemTools, createSystemTools as createCodingTools, createAllTools, ALL_EXTENDED_TOOL_NAMES } from "./tools/system-tools.js";
export type { ExtendedToolName, CreateAllToolsOptions } from "./tools/system-tools.js";
export { createBrowserTools, ALL_BROWSER_TOOL_NAMES } from "./tools/browser-tools.js";
export { createHttpTools, ALL_HTTP_TOOL_NAMES } from "./tools/http-tools.js";
export { createExcelTools, ALL_EXCEL_TOOL_NAMES } from "./tools/excel-tools.js";
export { createPdfTools, ALL_PDF_TOOL_NAMES } from "./tools/pdf-tools.js";
export { createDocxTools, ALL_DOCX_TOOL_NAMES } from "./tools/docx-tools.js";
export { createEmailTools, ALL_EMAIL_TOOL_NAMES } from "./tools/email-tools.js";
export { createVaultTools, ALL_VAULT_TOOL_NAMES } from "./tools/vault-tools.js";
export { createAudioTools, ALL_AUDIO_TOOL_NAMES } from "./tools/audio-tools.js";
export { createImageTools, ALL_IMAGE_TOOL_NAMES } from "./tools/image-tools.js";
