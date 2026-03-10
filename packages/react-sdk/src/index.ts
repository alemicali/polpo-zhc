// Provider
export { PolpoProvider } from "./provider/polpo-provider.js";
export type { PolpoProviderProps } from "./provider/polpo-provider.js";

// Hooks
export { usePolpo } from "./hooks/use-polpo.js";
export { useTasks } from "./hooks/use-tasks.js";
export { useTask } from "./hooks/use-task.js";
export { useMissions } from "./hooks/use-missions.js";
export { useMission } from "./hooks/use-mission.js";
export { useAgents } from "./hooks/use-agents.js";
export { useAgent } from "./hooks/use-agent.js";
export { useProcesses } from "./hooks/use-processes.js";
export { useEvents } from "./hooks/use-events.js";
export { useStats } from "./hooks/use-stats.js";
export { useMemory } from "./hooks/use-memory.js";
export { useLogs } from "./hooks/use-logs.js";
export { useSessions } from "./hooks/use-sessions.js";
export { useTaskActivity } from "./hooks/use-task-activity.js";
export { useSkills } from "./hooks/use-skills.js";
export { useOrchestratorSkills } from "./hooks/use-orchestrator-skills.js";
export { useNotifications } from "./hooks/use-notifications.js";
export { useApprovals } from "./hooks/use-approvals.js";
export { useActiveDelays } from "./hooks/use-active-delays.js";
export { usePlaybooks, useTemplates } from "./hooks/use-playbooks.js";
export { useSchedules } from "./hooks/use-schedules.js";
export { useVaultEntries } from "./hooks/use-vault-entries.js";
export { useAuthStatus } from "./hooks/use-auth-status.js";
export { useAssessmentProgress } from "./hooks/use-assessment-progress.js";

// Re-export client SDK for convenience (backward compat — consumers can also use @polpo-ai/client directly)
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
} from "@polpo-ai/client";

// Re-export all types from client SDK
export type {
  PolpoClientConfig,
  ConnectionStatus,
  EventSourceConfig,
  Task,
  TaskStatus,
  TaskResult,
  TaskExpectation,
  TaskPhase,
  TaskOutcome,
  ExpectedOutcome,
  OutcomeType,
  Mission,
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
  ReasoningLevel,
  ModelConfig,
  ModelAllowlistEntry,
  CustomModelDef,
  ProviderConfig,
  SSEEvent,
  ActiveDelay,
  CreateTaskRequest,
  UpdateTaskRequest,
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
  LogSession,
  LogEntry,
  RunActivityEntry,
  ChatSession,
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
  SkillInfo,
  LoadedSkill,
  SkillWithAssignment,
  SkillIndexEntry,
  SkillIndex,
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
} from "@polpo-ai/client";
