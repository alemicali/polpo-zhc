// ── Types ────────────────────────────────────────────────────────────────
export * from "./types.js";

// ── Events (pure type definitions only, TypedEmitter lives in shell) ─────
export * from "./events.js";

// ── Hook event catalog (SSOT for lifecycle hook names + glossary) ────────
export * from "./hook-events.js";

// ── State Machine ────────────────────────────────────────────────────────
export { VALID_TRANSITIONS, isValidTransition, assertValidTransition } from "./state-machine.js";

// ── Schemas (Zod validation) ─────────────────────────────────────────────
export * from "./schemas.js";

// ── Custom providers / AI gateways (schema, presets, helpers) ────────────
export * from "./provider-config.js";

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
// Where and with what a task run executed (engine, computer, egress, session, cost)
export * from "./run-context.js";
export * from "./mission-cost.js";
export * from "./dependency-results.js";
export * from "./task-tool-scope.js";
export type { ConfigStore } from "./config-store.js";
export type { MemoryStore } from "./memory-store.js";
export { agentMemoryScope } from "./memory-store.js";
export type { LogStore, LogEntry, LogPruneResult, SessionInfo } from "./log-store.js";
export type { CreateSessionOptions, SessionStore, Session, Message, MessageSegment, MessageRole, ToolCallInfo, ToolCallState, ForkSessionOptions, ForkSessionResult, ChatQueueItem, ChatQueueState, ChatQueueStore } from "./session-store.js";
export type { Room, RoomKind, RoomReplyMode, RoomSettings, RoomMessage, RoomAuthorKind, NewRoomMessage, RoomStore } from "./room-store.js";
export type { CodingSessionStore, CodingSessionState, CodingWorkspace, CodingTerminal, CodingCodeServerSession } from "./coding-session-store.js";
export type { ApprovalStore } from "./approval-store.js";
export type { NotificationStore, NotificationRecord, NotificationStatus } from "./notification-store.js";
export type { PeerStore } from "./peer-store.js";
export type { TeamStore } from "./team-store.js";
export type { AgentStore } from "./agent-store.js";
export type { VaultStore } from "./vault-store.js";
export { isReservedVaultOwner, RESERVED_VAULT_OWNER_PREFIX } from "./vault-store.js";
export type { PlaybookStore } from "./playbook-store.js";
export type { AttachmentStore, Attachment } from "./attachment-store.js";

// ── FileSystem & Shell Abstractions ──────────────────────────────────────
export type { FileSystem, FileEntry, FileStat } from "./filesystem.js";
export type { Shell, ShellOptions, ShellResult } from "./shell.js";

// ── Spawner Abstraction ─────────────────────────────────────────────────
export type { Spawner, SpawnResult } from "./spawner.js";

// ── Agent Prompt Builder ────────────────────────────────────────────────
export { buildAgentSystemPrompt } from "./agent-prompt.js";
export type { AgentPromptOptions } from "./agent-prompt.js";

// ── Skills Reader (async, FileSystem-based) ────────────────────────────
export {
  discoverSkills, loadAgentSkills, listSkillsWithAssignments,
  buildSkillPrompt, parseSkillFrontmatter, extractSkillBody,
  sanitizeFrontmatterValue, buildSkillFrontmatter,
} from "./skills-reader.js";
export type { SkillInfo, LoadedSkill, SkillWithAssignment, SkillIndex, SkillIndexEntry } from "./skills-reader.js";

// ── Source parsing & secret redaction (security helpers) ──────────────
export {
  parseGitSource, parseGitHubSource, isLocalSourcePath, shellQuote,
  InvalidSourceError, GITHUB_OWNER_REPO_RE,
} from "./git-source.js";
export type { GitSource } from "./git-source.js";
export {
  redactSecrets, restoreRedactedSecrets, maskSecret, maskUrlPassword, maskCapabilityUrl,
  isSecretKey, isRedactedValue, isEnvReference, REDACTED_MARK, UnrestorableSecretError, urlOrigin,
} from "./secret-redaction.js";

// ── Model Spec Parsing ─────────────────────────────────────────────────
export { parseModelSpec, PROVIDER_ENV_MAP } from "./model-spec.js";
export type { ParsedModelSpec } from "./model-spec.js";

// ── Context Budgeting ──────────────────────────────────────────────────
export {
  compactContextMessages,
  contextBudgetForModel,
  estimateContextTokens,
  estimateMessageTokens,
  selectCompactionCut,
  summarizeContextMessages,
} from "./context-compaction.js";
export type {
  ContextBudget,
  ContextEstimateInput,
  ContextMessageLike,
  ContextModelLimits,
} from "./context-compaction.js";
export {
  ContextCompactor,
  checkpointMessage,
  defaultPinned,
  serializeForSummary,
  buildSummaryPrompt,
  parseSummary,
  isContextOverflowError,
  CHECKPOINT_START,
  CHECKPOINT_END,
} from "./context-compactor.js";
export type {
  CompactionSettings,
  CompactionInfo,
  CompactionReason,
  CompactionMode,
  ContextSummarizer,
  SummaryRequest,
  SummaryResult,
  CompactorState,
  ContextCompactorOptions,
} from "./context-compactor.js";

// ── Progressive tool discovery ──────────────────────────────────────────
export {
  ProgressiveToolSet,
  AGENT_TOOL_GROUPS,
  POLPO_TOOL_GROUPS,
  DEFAULT_PROGRESSIVE_THRESHOLD,
  TOOLS_SEARCH,
  TOOLS_LOAD,
  META_TOOL_NAMES,
  connectorIdOf,
  declaredTools,
  loadedToolsFromHistory,
  progressiveEnabled,
  progressiveModeFor,
  restoreToolAnnouncements,
} from "./progressive-tools.js";
export type {
  ProgressiveToolsMode,
  ToolsSettings,
  ToolLike,
  ToolDeclaration,
  ToolAnnouncement,
  ToolGroupRule,
  ToolGroup,
  SearchHit,
  ProgressiveMetaTool,
  ProgressiveToolSetOptions,
} from "./progressive-tools.js";

// ── EventBus Interface ──────────────────────────────────────────────────
export type { EventBus } from "./event-bus.js";

// ── Additional Store Interfaces ─────────────────────────────────────────
export type { CheckpointStore, CheckpointState } from "./checkpoint-store.js";
export type { DelayStore, DelayState } from "./delay-store.js";
export type { NotificationRouterPort } from "./notification-router-port.js";

// ── OrchestratorContext ─────────────────────────────────────────────────
export type { OrchestratorContext, AssessFn, CheckProgressEvent } from "./orchestrator-context.js";

// ── Cron (pure) ─────────────────────────────────────────────────────────
export { parseCron, matchesCron, nextCronOccurrence, isCronExpression, scheduleExpressionProblem } from "./cron.js";

// ── Core Managers ───────────────────────────────────────────────────────
export { TaskManager } from "./task-manager.js";
export { AgentManager } from "./agent-manager.js";
export { ApprovalManager } from "./approval-manager.js";
export { EscalationManager } from "./escalation-manager.js";
export { TaskWatcherManager } from "./task-watcher.js";
export { QualityController } from "./quality-controller.js";
export { SLAMonitor } from "./sla-monitor.js";
export { Scheduler } from "./scheduler.js";
export { InMemoryScheduleStore, InMemoryLeaseStore, InMemoryTaskWatcherStore, scheduleRunKey } from "./schedule-store.js";
export type { ScheduleState, ScheduleStore, ScheduleCatchUp, ScheduleOutcome, LeaseStore, TaskWatcherStore } from "./schedule-store.js";

// ── MissionExecutor ─────────────────────────────────────────────────────
export { MissionExecutor, MISSION_EDIT } from "./mission-executor.js";
export type { MissionEdit } from "./mission-executor.js";

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
export type {
  AgentConversationCheckpoint,
  BackgroundWait,
  BackgroundWaitStore,
  BackgroundWaitState,
  TaskControlStore,
  TaskDirection,
  TaskDirectionMode,
  TaskDirectionStatus,
} from "./task-control-store.js";

// ── Assessment (pure — no Node.js deps) ─────────────────────────────────
export { assessTask, runCheck, runMetric, type AssessmentDeps, type CheckProgressEvent as AssessorCheckProgressEvent } from "./assessor.js";
export { DEFAULT_DIMENSIONS, buildRubricSection, computeWeightedScore, computeMedianScores } from "./assessment-scoring.js";
export { validateReviewPayload, ReviewPayloadSchema, ReviewScoreSchema, REVIEW_JSON_SCHEMA, type ValidatedReviewPayload } from "./assessment-schemas.js";
export { withRetry, isTransientError, type RetryOptions } from "./retry.js";

// ── Sandboxes and storage mounts ────────────────────────────────────────
export {
  resolveSandbox, normalizeSandboxSettings, toolPlacement, TOOL_PLACEMENT, DEFAULT_LIFECYCLE, DEFAULT_ISOLATION, REMOTE_SANDBOX_PROVIDERS, effectiveLifecycle, resolveRuntimeLevels, SandboxVolumeGrantError, SANDBOX_VOLUME_ROOT, SANDBOX_VOLUME_NAME_PATTERN, readsExternalContent, LOCAL_PROVIDERS, PROVIDER_ISOLATION, EXTERNAL_CONTENT_TOOLS,
} from "./sandbox.js";
export type {
  Workspace, ExecOptions, ExecResult, WorkspaceFileStat, WorkspaceEntry, SandboxProviderId, SandboxNetwork,
  SandboxNetworkMode, SandboxResources, SandboxSettings, EffectiveSandbox, SandboxCascade,
  StorageMountSpec, StorageMountProvider, ToolPlacement, SandboxLifecycleSettings, RemoteSandboxProvider, SandboxIsolation, SandboxReleasePolicy, SandboxVolumeAccess, SandboxVolumeWriteBack, SandboxVolumeStrategy, SandboxVolumeSelection, ResolvedSandboxVolume,
} from "./sandbox.js";
// Computers: a persistent machine per agent (settings.computers)
export * from "./computers.js";
// Agent harnesses: official agent runtimes (Claude Code, Codex) as an agent's engine
export * from "./harnesses.js";
export { computerSelection } from "./sandbox.js";
// open Polpo's sandbox ports and runtime policy (copied as is from lumea-labs/polpo)
export { resolveRuntimeSandboxOptions } from "./runtime-sandbox.js";
export type { RuntimeSandboxOptions, RuntimeSandboxLifecycleOptions, RuntimeSandboxVolumeSelection } from "./runtime-sandbox.js";
export type {
  SandboxProvider, SandboxSession, SandboxLifecycle, SandboxUsage, SandboxRuntimeEvent,
  SandboxRuntimeEventType, SandboxRuntimeOperation, SandboxAcquisitionSource, SandboxReleaseOutcome, SandboxLifecycleInfo,
  ResolvedSandboxVolumeAttachment, SandboxWorkspaceContext,
} from "./sandbox-provider.js";
export {
  STORAGE_SLUG_PATTERN, 
  normalizeStoragePrefix, normalizeStoragePath, storageGrantFor, storageAccessFor, storagePathAllowed,
  assertStorageAccess, scopeStorageListing, validateStorageEntry, VOLUME_REVISION_OBJECT,
} from "./storage-registry.js";
export type {
  StorageProvider, StorageDriver, StorageAccess, StorageGrant, StorageCacheOptions, StorageEntry, CreateStorageEntry,
  StorageRegistryChangeEvent, StorageRegistryChangeEmitter, StorageRegistryStore, StorageCredentials,
  StorageCredentialStatus, StorageAccessGrant, StorageVolumeSettings,
} from "./storage-registry.js";
export { CHECK_NOTHING_TO_REPORT, MIN_CHECK_INTERVAL_MINUTES, afterCheckRun, todayLine } from "./conversation-checks.js";
export type {
  ConversationCheck, ConversationCheckState, ConversationCheckStore, ConversationCheckTarget, NewConversationCheck,
} from "./conversation-checks.js";

export { isVaultRef, normalizeVaultRef, describeVaultRef, resolveVaultRef, pickCredential, CREDENTIAL_NAMES } from "./vault-ref.js";
export type { VaultRef } from "./vault-ref.js";

// Artifacts: documents, dashboards, designs, diagrams
export {
  ARTIFACT_TYPES, ARTIFACT_KINDS, MAX_ARTIFACT_BYTES, MAX_ARTIFACT_VERSIONS,
  isArtifactType, artifactContentProblem, summarizeArtifact, matchesArtifactFilter,
  applyArtifactPatch, buildArtifact, applyArtifactEdits,
} from "./artifacts.js";
export type {
  Artifact, ArtifactType, ArtifactVersion, ArtifactSummary, NewArtifact, ArtifactPatch, ArtifactFilter, ArtifactStore,
} from "./artifacts.js";

// Connectors: external tools over MCP (Linear, Notion, Google Workspace, custom servers)
export {
  CONNECTOR_ID_PATTERN, CONNECTORS_VAULT_OWNER, DEFAULT_CONNECTOR_TOOL_TIMEOUT_MS, connectorGrants, connectorSlug,
  connectorToolSelected, connectorToolsProblems, normalizeConnectorTools,
} from "./connectors.js";
export type {
  ConnectorConfig, ConnectorIcon, ConnectorTransport, ConnectorAuth, ConnectorAuthType, ConnectorOAuthSettings, ConnectorAccess,
  ConnectorToolPolicy, ConnectorStatus, ConnectorOAuthApp, AgentConnectorTools, ConnectorsFile, ConnectorCatalogEntry, ConnectorChangedEvent,
} from "./connectors.js";
export { EGRESS_PROXY_NAME, EGRESS_PROXY_URL, parseEgressProxies } from "./egress-proxies.js";
export {
  APPEARANCE_THEMES, APPEARANCE_PALETTES, APPEARANCE_TOKENS, APPEARANCE_TOKEN_NAMES, APPEARANCE_TOKEN_GROUPS, APPEARANCE_COLOR, APPEARANCE_HEX,
  APPEARANCE_FONT, APPEARANCE_SHADOW, APPEARANCE_FONT_PRESETS, APPEARANCE_RADIUS_MIN, APPEARANCE_RADIUS_MAX,
  APPEARANCE_SIZE, APPEARANCE_SIZE_RANGE, APPEARANCE_TRACKING, APPEARANCE_TRACKING_RANGE, APPEARANCE_WEIGHT_MIN, APPEARANCE_WEIGHT_MAX, APPEARANCE_CASES,
  parseAppearanceSettings, parseAppearanceTokens, sanitizeAppearanceSettings, parseAppearanceToken, isEmptyAppearance,
  APPEARANCE_NUMBER_RANGES, APPEARANCE_GRADIENT_ANGLE, APPEARANCE_FONT_HOSTS, APPEARANCE_MAX_WEB_FONTS, APPEARANCE_FONT_FAMILY, APPEARANCE_BUNDLED_FONTS,
  APPEARANCE_PRELOADED_FONTS, normalizeFontWeights, normalizeFontUrl, webFontHref, parseWebFont, parseWebFonts, unloadedFontFamilies, parseAppearanceGradient,
} from "./appearance.js";
export type {
  AppearanceTheme, AppearancePalette, AppearanceColors, AppearanceCustom, AppearanceSettings, AppearanceTokens, AppearanceTokenName,
  AppearanceTokenGroup, AppearanceTokenKind, AppearanceWebFont, AppearanceGradient,
} from "./appearance.js";
