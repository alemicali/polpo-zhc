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
export { useNotifications } from "./hooks/use-notifications.js";
export { useApprovals } from "./hooks/use-approvals.js";
export { useTemplates } from "./hooks/use-templates.js";
export { useSchedules } from "./hooks/use-schedules.js";

// Client (re-export for convenience)
export { PolpoClient, ChatCompletionStream } from "./client/polpo-client.js";
export { PolpoApiError } from "./client/errors.js";

// Types
export type {
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
  CreateTaskRequest,
  UpdateTaskRequest,
  CreateMissionRequest,
  UpdateMissionRequest,
  AddAgentRequest,
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
  VaultPreviewPayload,
  SkillInfo,
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
  TemplateParameter,
  TemplateInfo,
  TemplateDefinition,
  TemplateRunResult,
} from "./client/types.js";

export type { ConnectionStatus } from "./client/event-source.js";
export type { PolpoStats, StoreState } from "./store/types.js";
export type { TaskFilter } from "./store/selectors.js";
