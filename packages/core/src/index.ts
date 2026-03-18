// ── Types ────────────────────────────────────────────────────────────────
export * from "./types.js";

// ── Events (pure type definitions only, TypedEmitter lives in shell) ─────
export * from "./events.js";

// ── State Machine ────────────────────────────────────────────────────────
export { VALID_TRANSITIONS, isValidTransition, assertValidTransition } from "./state-machine.js";

// ── Schemas (Zod validation) ─────────────────────────────────────────────
export * from "./schemas.js";

// ── Hooks ────────────────────────────────────────────────────────────────
export { HookRegistry } from "./hooks.js";
export type {
  LifecycleHook,
  HookPhase,
  HookContext,
  HookHandler,
  HookRegistration,
  HookPayloads,
  BeforeHookResult,
} from "./hooks.js";

// ── Store Interfaces ─────────────────────────────────────────────────────
export type { TaskStore } from "./task-store.js";
export type { RunStore, RunRecord, RunStatus } from "./run-store.js";
export type { ConfigStore } from "./config-store.js";
export type { MemoryStore } from "./memory-store.js";
export { agentMemoryScope } from "./memory-store.js";
export type { LogStore, LogEntry, SessionInfo } from "./log-store.js";
export type { SessionStore, Session, Message, MessageRole, ToolCallInfo, ToolCallState } from "./session-store.js";
export type { ApprovalStore } from "./approval-store.js";
export type { NotificationStore, NotificationRecord, NotificationStatus } from "./notification-store.js";
export type { PeerStore } from "./peer-store.js";
export type { TeamStore } from "./team-store.js";
export type { AgentStore } from "./agent-store.js";
export type { VaultStore } from "./vault-store.js";
export type { PlaybookStore } from "./playbook-store.js";

// ── FileSystem & Shell Abstractions ──────────────────────────────────────
export type { FileSystem, FileEntry, FileStat } from "./filesystem.js";
export type { Shell, ShellOptions, ShellResult } from "./shell.js";

// ── Spawner Abstraction ─────────────────────────────────────────────────
export type { Spawner, SpawnResult } from "./spawner.js";

// ── Agent Prompt Builder ────────────────────────────────────────────────
export { buildAgentSystemPrompt } from "./agent-prompt.js";

// ── Skills Reader (async, FileSystem-based) ────────────────────────────
export {
  discoverSkills, loadAgentSkills, listSkillsWithAssignments,
  buildSkillPrompt, parseSkillFrontmatter, extractSkillBody,
} from "./skills-reader.js";
export type { SkillInfo, LoadedSkill, SkillWithAssignment, SkillIndex, SkillIndexEntry } from "./skills-reader.js";

// ── Model Spec Parsing ─────────────────────────────────────────────────
export { parseModelSpec, PROVIDER_ENV_MAP } from "./model-spec.js";
export type { ParsedModelSpec } from "./model-spec.js";

// ── EventBus Interface ──────────────────────────────────────────────────
export type { EventBus } from "./event-bus.js";

// ── Additional Store Interfaces ─────────────────────────────────────────
export type { CheckpointStore, CheckpointState } from "./checkpoint-store.js";
export type { DelayStore, DelayState } from "./delay-store.js";
export type { NotificationRouterPort } from "./notification-router-port.js";

// ── OrchestratorContext ─────────────────────────────────────────────────
export type { OrchestratorContext, AssessFn, CheckProgressEvent } from "./orchestrator-context.js";

// ── Cron (pure) ─────────────────────────────────────────────────────────
export { parseCron, matchesCron, nextCronOccurrence, isCronExpression } from "./cron.js";

// ── Core Managers ───────────────────────────────────────────────────────
export { TaskManager } from "./task-manager.js";
export { AgentManager } from "./agent-manager.js";
export { ApprovalManager } from "./approval-manager.js";
export { EscalationManager } from "./escalation-manager.js";
export { TaskWatcherManager } from "./task-watcher.js";
export { QualityController } from "./quality-controller.js";
export { SLAMonitor } from "./sla-monitor.js";
export { Scheduler } from "./scheduler.js";

// ── MissionExecutor ─────────────────────────────────────────────────────
export { MissionExecutor } from "./mission-executor.js";

// ── TaskRunner ──────────────────────────────────────────────────────────
export { TaskRunner } from "./task-runner.js";

// ── OrchestratorEngine ──────────────────────────────────────────────────
export { OrchestratorEngine } from "./orchestrator-engine.js";
export type {
  OrchestratorEngineDeps,
  TaskRunnerPort,
  AssessmentOrchestratorPort,
  MissionExecutorPort,
  DeadlockResolverPort,
  DeadlockFacade,
  TaskWatcherManagerPort,
} from "./orchestrator-engine.js";

// ── Assessment Pipeline ──────────────────────────────────────────────────
export { AssessmentOrchestrator, type AssessmentPorts } from "./assessment-orchestrator.js";
export { buildFixPrompt, buildRetryPrompt, buildSideEffectFixPrompt, buildSideEffectRetryPrompt, buildJudgePrompt, sleep, type JudgeCorrectionFix, type JudgeCorrection, type JudgeVerdict } from "./assessment-prompts.js";
export { looksLikeQuestion, classifyAsQuestion } from "./question-detector.js";

// ── Adapter Types ────────────────────────────────────────────────────────
export type { AgentHandle, SpawnContext } from "./adapter.js";

// ── Assessment (pure — no Node.js deps) ─────────────────────────────────
export { assessTask, runCheck, runMetric, type AssessmentDeps, type CheckProgressEvent as AssessorCheckProgressEvent } from "./assessor.js";
export { DEFAULT_DIMENSIONS, buildRubricSection, computeWeightedScore, computeMedianScores } from "./assessment-scoring.js";
export { validateReviewPayload, ReviewPayloadSchema, ReviewScoreSchema, REVIEW_JSON_SCHEMA, type ValidatedReviewPayload } from "./assessment-schemas.js";
export { withRetry, isTransientError, type RetryOptions } from "./retry.js";
