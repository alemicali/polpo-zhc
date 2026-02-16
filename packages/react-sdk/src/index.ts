// Provider
export { PolpoProvider } from "./provider/polpo-provider.js";
export type { PolpoProviderProps } from "./provider/polpo-provider.js";

// Hooks
export { usePolpo } from "./hooks/use-polpo.js";
export { useTasks } from "./hooks/use-tasks.js";
export { useTask } from "./hooks/use-task.js";
export { usePlans } from "./hooks/use-plans.js";
export { usePlan } from "./hooks/use-plan.js";
export { useAgents } from "./hooks/use-agents.js";
export { useProcesses } from "./hooks/use-processes.js";
export { useEvents } from "./hooks/use-events.js";
export { useStats } from "./hooks/use-stats.js";
export { useMemory } from "./hooks/use-memory.js";
export { useLogs } from "./hooks/use-logs.js";
export { useSessions } from "./hooks/use-sessions.js";
export { useTaskActivity } from "./hooks/use-task-activity.js";
export { useSkills } from "./hooks/use-skills.js";

// Client (re-export for convenience)
export { PolpoClient } from "./client/polpo-client.js";
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
  Plan,
  PlanStatus,
  PlanReport,
  AgentConfig,
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
  ProjectInfo,
  SSEEvent,
  CreateTaskRequest,
  UpdateTaskRequest,
  CreatePlanRequest,
  UpdatePlanRequest,
  AddAgentRequest,
  TaskFilters,
  LogSession,
  LogEntry,
  RunActivityEntry,
  ChatSession,
  ChatMessage,
  ChatResponse,
  SkillInfo,
} from "./client/types.js";

export type { ConnectionStatus } from "./client/event-source.js";
export type { PolpoStats, StoreState } from "./store/types.js";
export type { TaskFilter } from "./store/selectors.js";
