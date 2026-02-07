// Core abstractions
export * from "./core/index.js";

// Orchestrator
export { Orchestrator, buildRetryPrompt } from "./orchestrator.js";
export type { OrchestratorOptions, AssessFn } from "./orchestrator.js";

// Stores
export { JsonTaskStore } from "./stores/index.js";

// Adapters
export { registerAdapter, getAdapter, createActivity } from "./adapters/registry.js";
export { ClaudeSDKAdapter, buildPrompt } from "./adapters/claude-sdk.js";
export { GenericAdapter, shellEscape } from "./adapters/generic.js";

// Assessment
export { assessTask, runCheck, runMetric } from "./assessment/assessor.js";
export { runLLMReview, defaultLLMQuery, computeWeightedScore, buildRubricSection, DEFAULT_DIMENSIONS } from "./assessment/index.js";
export type { LLMQueryFn } from "./assessment/llm-review.js";

// Config
export { parseConfig, generateTemplate } from "./config.js";

// Session reader
export { readSessionSummary, getRecentMessages, findTranscriptPath } from "./session-reader.js";

// Backward compat alias
export { JsonTaskStore as TaskRegistry } from "./stores/index.js";
