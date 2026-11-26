// Provider
export { PolpoProvider } from "./provider/polpo-provider.js";
export type { PolpoProviderProps } from "./provider/polpo-provider.js";

// Hooks
export { useMutation } from "./hooks/use-mutation.js";
export type { MutationState } from "./hooks/use-mutation.js";
export { usePolpo } from "./hooks/use-polpo.js";
export { useTasks } from "./hooks/use-tasks.js";
export type { UseTasksReturn } from "./hooks/use-tasks.js";
export { useTasksInfinite } from "./hooks/use-tasks-infinite.js";
export type { UseTasksInfiniteOpts, UseTasksInfiniteReturn } from "./hooks/use-tasks-infinite.js";
export { useTask } from "./hooks/use-task.js";
export { useMissions } from "./hooks/use-missions.js";
export type { UseMissionsReturn } from "./hooks/use-missions.js";
export { useMission } from "./hooks/use-mission.js";
export { useMissionCost } from "./hooks/use-mission-cost.js";
export type { UseMissionCostReturn } from "./hooks/use-mission-cost.js";
export { useConnectors, connectorLabel } from "./hooks/use-connectors.js";
export { useWaBusinessStatus, useWaTemplates, useWaConversation, useWaContacts } from "./hooks/use-whatsapp-business.js";
export { useSlackStatus, usePeers } from "./hooks/use-channels.js";
export type { UseSlackStatusReturn, UsePeersReturn } from "./hooks/use-channels.js";
export { useTriggers, useTriggerDeliveries, useTriggerDelivery } from "./hooks/use-triggers.js";
export type { UseTriggersReturn, UseTriggerDeliveriesReturn, UseTriggerDeliveryReturn } from "./hooks/use-triggers.js";
export { useDecide, useDecisions, useDecisionNodes } from "./hooks/use-decisions.js";
export type { UseDecideReturn, UseDecisionsReturn } from "./hooks/use-decisions.js";
export type { UseWaBusinessStatusReturn, UseWaTemplatesReturn, UseWaConversationReturn, UseWaContactsReturn } from "./hooks/use-whatsapp-business.js";
export type { UseConnectorsReturn } from "./hooks/use-connectors.js";
export { useAgents } from "./hooks/use-agents.js";
export type { UseAgentsReturn } from "./hooks/use-agents.js";
export { useAgent } from "./hooks/use-agent.js";
export { useProcesses } from "./hooks/use-processes.js";
export { useEvents } from "./hooks/use-events.js";
export { useStats } from "./hooks/use-stats.js";
export type { UseStatsReturn } from "./hooks/use-stats.js";
export { useMemory, useAgentMemory } from "./hooks/use-memory.js";
export { useLogs } from "./hooks/use-logs.js";
export { useSessions } from "./hooks/use-sessions.js";
export { useTaskActivity } from "./hooks/use-task-activity.js";
export { useTaskDirections } from "./hooks/use-task-directions.js";
export type { UseTaskDirectionsReturn } from "./hooks/use-task-directions.js";
export { useSkills } from "./hooks/use-skills.js";
export { useOrchestratorSkills } from "./hooks/use-orchestrator-skills.js";
export { useSkillFiles } from "./hooks/use-skill-files.js";
export type { UseSkillFilesReturn } from "./hooks/use-skill-files.js";
export { useSkillVersions } from "./hooks/use-skill-versions.js";
export type { UseSkillVersionsReturn } from "./hooks/use-skill-versions.js";
export { useAgentVersions, useAgentDeploys, useAgentDeployGates } from "./hooks/use-agent-versions.js";
export type { UseAgentVersionsReturn, UseAgentDeploysReturn, UseAgentDeployGatesReturn } from "./hooks/use-agent-versions.js";
export { useAgentTests } from "./hooks/use-agent-tests.js";
export type { UseAgentTestsReturn } from "./hooks/use-agent-tests.js";
export { useAgentLines } from "./hooks/use-agent-lines.js";
export type { UseAgentLinesReturn } from "./hooks/use-agent-lines.js";
export { useAgentSuites, useAgentSuiteRun, useAgentSuiteTrend, useSuiteCassette, useTargetSuites, useTargetSuiteRun } from "./hooks/use-agent-suites.js";
export type { UseAgentSuitesReturn, UseAgentSuiteRunReturn, UseAgentSuiteTrendReturn, UseSuiteCassetteReturn, UseTargetSuitesReturn } from "./hooks/use-agent-suites.js";
export { useBenchmarks, useBenchmarkRun, usePlayground } from "./hooks/use-benchmarks.js";
export type { UseBenchmarksReturn, UseBenchmarkRunReturn, UsePlaygroundReturn, PlaygroundLivePane } from "./hooks/use-benchmarks.js";
export { useMcpServers, useMcpServer } from "./hooks/use-mcp-servers.js";
export type { UseMcpServersReturn, UseMcpServerReturn } from "./hooks/use-mcp-servers.js";
export { useSkillBundleUpload } from "./hooks/use-skill-bundle-upload.js";
export { useArtifactUpload, ARTIFACT_UPLOAD_PART_BYTES } from "./hooks/use-artifact-upload.js";
export type { UseArtifactUploadReturn } from "./hooks/use-artifact-upload.js";
export type { UseSkillBundleUploadReturn } from "./hooks/use-skill-bundle-upload.js";
export { useNotifications } from "./hooks/use-notifications.js";
export { useApprovals } from "./hooks/use-approvals.js";
export type { UseApprovalsReturn } from "./hooks/use-approvals.js";
export { useActiveDelays } from "./hooks/use-active-delays.js";
export { usePlaybooks, useTemplates } from "./hooks/use-playbooks.js";
export { useSchedules } from "./hooks/use-schedules.js";
export { useVaultEntries } from "./hooks/use-vault-entries.js";
export type { UseVaultEntriesReturn } from "./hooks/use-vault-entries.js";
export { useAuthStatus } from "./hooks/use-auth-status.js";
export { usePreferences } from "./hooks/use-preferences.js";
export type { UsePreferencesReturn } from "./hooks/use-preferences.js";
export { useSearch } from "./hooks/use-search.js";
export type { UseSearchOptions, UseSearchReturn } from "./hooks/use-search.js";
export { useSearchAsk } from "./hooks/use-search-ask.js";
export type { UseSearchAskReturn, SearchAskState } from "./hooks/use-search-ask.js";
export { useAssessmentProgress } from "./hooks/use-assessment-progress.js";

// Re-export client SDK for convenience (backward compat — consumers can also use @polpo-ai/sdk directly)
export {
  PolpoClient,
  ChatCompletionStream,
  PolpoApiError,
  EventSourceManager,
  PolpoStore,
  reduceEvent,
  selectTasks,
  selectTask,
  selectMissions,
  selectMission,
  selectMissionReport,
  selectProcesses,
  selectEvents,
  selectAssessmentProgress,
  selectAssessmentChecks,
} from "@polpo-ai/sdk";

// Re-export all types from client SDK
export type {
  PolpoClientConfig,
  ConnectionStatus,
  EventSourceConfig,
  Task,
  TaskSlim,
  TaskStatus,
  TaskResult,
  TaskExpectation,
  TaskPhase,
  TaskOutcome,
  ExpectedOutcome,
  OutcomeType,
  Mission,
  MissionSlim,
  MissionStatus,
  MissionReport,
  MissionDelay,
  AgentConfig,
  AgentIdentity,
  AgentResponsibility,
  AgentProcess,
  AgentActivity,
  Team,
  AssessmentResult,
  AssessmentTrigger,
  DimensionScore,
  DimensionScoreEvidence,
  EvalDimension,
  CheckResult,
  ReviewerResult,
  ReviewerMessage,
  ReviewerExploration,
  MetricResult,
  PolpoState,
  PolpoConfig,
  PolpoSettings,
  BrandingConfig,
  AppearanceConfig,
  SidebarStyle,
  AppearanceTokens,
  ReasoningLevel,
  ModelConfig,
  ModelAllowlistEntry,
  CustomModelDef,
  ProviderConfig,
  ProviderApi,
  ProviderAuthConfig,
  CustomProviderInfo,
  SSEEvent,
  ActiveDelay,
  CreateTaskRequest,
  UpdateTaskRequest,
  TaskDirection,
  TaskDirectionMode,
  TaskDirectionStatus,
  SendTaskDirectionRequest,
  SendTaskDirectionResult,
  CreateMissionRequest,
  UpdateMissionRequest,
  AddMissionTaskRequest,
  UpdateMissionTaskRequest,
  ReorderMissionTasksRequest,
  AddMissionCheckpointRequest,
  UpdateMissionCheckpointRequest,
  AddMissionDelayRequest,
  UpdateMissionDelayRequest,
  AddMissionQualityGateRequest,
  UpdateMissionQualityGateRequest,
  AddMissionTeamMemberRequest,
  UpdateMissionTeamMemberRequest,
  UpdateMissionNotificationsRequest,
  ExecuteMissionResult,
  ResumeMissionResult,
  AddAgentRequest,
  UpdateAgentRequest,
  UpdateSettingsRequest,
  AddTeamRequest,
  TaskFilters,
  TasksPageRequest,
  TasksPageResponse,
  LogSession,
  LogEntry,
  RunActivityEntry,
  TaskRunContext,
  TaskToolScope,
  TaskRunEngine,
  AgentCliEngine,
  CliAccount,
  TaskRunSummary,
  TaskFailure,
  TaskFailureKind,
  Connector,
  ConnectorStatus,
  ConnectorTool,
  ConnectorToolPolicy,
  MissionCost,
  MissionCostBucket,
  MissionCostSummary,
  TaskCost,
  TaskCostRun,
  TaskCostSummary,
  ChatSession,
  ChatQueueItem,
  ChatQueueState,
  ChatQueueSendResult,
  SteerResult,
  ForkSessionResult,
  ChatMessage,
  ChatCompletionMessage,
  TextContentPart,
  ImageUrlContentPart,
  ContentPart,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatCompletionChoice,
  ChatCompletionChunk,
  ChatCompletionChunkDelta,
  ToolCallState,
  ToolCallEvent,
  AskUserOption,
  AskUserQuestion,
  AskUserPayload,
  AskUserAnswer,
  MissionPreviewPayload,
  VaultEntryMeta,
  VaultPreviewPayload,
  AuthProfileStatus,
  AuthProfileType,
  AuthProfileMeta,
  ProviderAuthInfo,
  AuthStatusResponse,
  ChatNavigationPreferences,
  MemberPreferences,
  MemberPreferencesPatch,
  MemberPreferencesResponse,
  SearchType,
  SearchRange,
  SearchResult,
  SearchGroup,
  SearchResponse,
  SearchOptions,
  SearchAskPage,
  SearchAskCommand,
  SearchAskIntent,
  SearchAskResult,
  SearchAskEvent,
  SearchAskOptions,
  SkillInfo,
  LoadedSkill,
  SkillWithAssignment,
  SkillIndexEntry,
  SkillIndex,
  SkillPool,
  SkillFileEntry,
  SkillFileList,
  SkillBundleSkill,
  SkillBundlePreview,
  SkillBundleInstallOptions,
  SkillBundleInstallResult,
  SkillVersionSource,
  SkillVersion,
  SkillVersionList,
  SkillVersionFiles,
  SkillFileDiff,
  SkillVersionDiff,
  AgentVersionBump,
  AgentFieldChange,
  AgentVersion,
  AgentVersionState,
  AgentVersioningSummary,
  AgentVersionList,
  AgentVersionDiff,
  AgentDeployEntry,
  AgentDeployOutcome,
  AgentTestCheckId, AgentTestStatus, AgentTestFixAction, AgentTestItem, AgentTestCheckResult, AgentTestRun, AgentTestRunRequest,
  AgentSuite, AgentSuiteInput, SuiteRun, SuiteRunRequest, SuiteDatasetImport, SuiteMockMode, ArgsMatchMode, ToolMock, ScriptedTurn, SuiteMocks, SuiteCaseInput, SuiteAssertion, SuiteAssertionType, SuiteScorer, SuiteBudgets, SuiteCase, SuiteDataset, SuiteVariantOverrides, SuiteRunStatus, SuiteCaseStatus, SuiteAssertionResult, SuiteTraceToolCall, SuiteTraceTurn, SuiteTrace, SuiteCaseResult, SuiteRunStats,
  ScorerSource, JudgeCriterion, SuiteScorerType, SuiteEvalSettings, SuiteRole, SuiteRoleName, SuiteScoreResult, SuiteScorerAggregate, SuiteCaseAggregate, SuiteRunAggregates,
  SuiteChange, SuiteScorerDelta, SuiteCaseDelta, SuiteBaselineComparison, SuiteRunReview, SuiteTrendPoint, SuiteTrend,
  SuiteGate, DeployGateTrigger, DeployGateStatus, DeployGateSuiteStatus, DeployGateSuite, AgentDeployGate, AgentDeployGateRef, AgentVersionGateStatus,
  CassetteMatch, SuiteCassetteRef, SimulatedUser, HttpMock, SuiteCassette, SuiteCassetteCall, SuiteCassetteSummary, SuiteCassetteEdit, CaseGenerationRequest, GeneratedCaseProposal, SuiteTargetKind,
  BenchmarkVariantSpec, BenchmarkSuiteRef, BenchmarkWeights, BenchmarkDefinition, BenchmarkInput, BenchmarkEstimateCell, BenchmarkEstimate, BenchmarkRunStatus, BenchmarkRunEntry, BenchmarkRun,
  MeanSd, BenchmarkVariantStats, BenchmarkLeaderboardEntry, BenchmarkLeaderboard, BenchmarkCellStatus, BenchmarkMatrixCell, BenchmarkMatrixRow, BenchmarkMatrix, BenchmarkReport,
  DiffSegment, BenchmarkCompareColumn, BenchmarkCaseComparison, BenchmarkProgressEvent, PlaygroundMocks, PlaygroundPane, PlaygroundPaneInput, PlaygroundExchange, PlaygroundSession, PlaygroundStreamEvent,
  AgentPublishResult,
  McpSecretRef, McpServerAuth, McpServerTool, McpServerSpec, McpServerSummary, McpHostedServer, McpServerTemplateInfo, McpServerTemplateSecret, McpServerTemplateStatus, McpServerSettingField, McpServerInstallRequest, McpServerInstallResult, McpServerTestCase,
  McpServerVersionInfo, McpServerDeploy, McpServerDeployBlocked, McpServerDiff, McpToolTestResult, McpServerCallLog, McpPendingCall, McpServerGenerateRequest, McpServerGenerateResult,
  SkillRestoreResult,
  NotificationChannelType,
  NotificationChannelConfig,
  ChannelGatewayConfig,
  DmPolicy,
  NotificationRule,
  NotificationRecord,
  NotificationStats,
  NotificationSeverity,
  NotificationStatus,
  ScopedNotificationRules,
  SendNotificationRequest,
  SendNotificationResult,
  ApprovalRequest,
  ApprovalStatus,
  ScheduleEntry,
  QualityMetrics,
  PlaybookParameter,
  PlaybookInfo,
  PlaybookDefinition,
  PlaybookRunResult,
  TemplateParameter,
  TemplateInfo,
  TemplateDefinition,
  TemplateRunResult,
  StoreState,
  PolpoStats,
  AssessmentProgressEntry,
  AssessmentCheckStatus,
  TaskFilter,
  ComputerWebhookProvider,
  WaBusinessSettings,
  WaBizOutcome,
  WaBizSecretKind,
  WaBusinessStatus,
  WaBusinessEventSummary,
  WaBusinessEvent,
  WaBusinessEventPage,
  WaBusinessContact,
  SlackStatus,
  SlackSecretKind,
  SlackConnectionState,
  ChannelPeer,
  PeerPresence,
  WaBusinessMessage,
  WaBusinessConversation,
  WaBusinessTemplate,
  WaBusinessSendResult,
  ComputerWebhookOutcome,
  ComputerWebhookStatus,
  ComputerWebhookCountsBefore,
  ComputerWebhookEventSummary,
  ComputerWebhookEvent,
  ComputerWebhookEventPage,
  TriggerContentType,
  TriggerDeliveryStatus,
  TriggerFilterOp,
  TriggerHmacConfig,
  TriggerContract,
  TriggerFilter,
  Trigger,
  TriggerInput,
  TriggerDeliverySummary,
  TriggerDelivery,
  TriggerDeliveryPage,
  TriggerSample,
  TriggerDraft,
  TriggerDryRun,
  TriggerContractRevision,
  TriggerActionKind, TriggerActionStatus, TriggerActionsStatus, TriggerAction, TriggerActionInput, TriggerPlaybookAction, TriggerMissionAction,
  TriggerTaskAction, TriggerAgentAction, TriggerNotifyAction, TriggerDeliverTo, TriggerActionLimits, TriggerActionRefs, TriggerActionRun, TriggerActionPreview, WorkOrigin,
  DecisionQuestionType, DecisionQuestion, DecisionFallbackModel, DecisionModelSetting, DecisionSettings, DecideRequest, DecisionAnswer, DecisionUsage, DecideResult,
  DecisionCallerKind, DecisionLogSummary, DecisionLogEntry, DecisionLogPage, DecisionStatus, DecisionNodeState, MissionDecision,
  AgentTalksTo, AgentLinesMode, AgentLines, AgentLinesChart,
} from "@polpo-ai/sdk";
