// Provider
export { OrchestraProvider } from "./provider/orchestra-provider.js";
export type { OrchestraProviderProps } from "./provider/orchestra-provider.js";

// Hooks
export { useOrchestra } from "./hooks/use-orchestra.js";
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

// Client (re-export for convenience)
export { OrchestraClient } from "./client/orchestra-client.js";
export { OrchestraApiError } from "./client/errors.js";

// Types
export type {
  Task,
  TaskStatus,
  TaskResult,
  TaskExpectation,
  TaskPhase,
  Plan,
  PlanStatus,
  PlanReport,
  AgentConfig,
  AgentProcess,
  AgentActivity,
  Team,
  AssessmentResult,
  DimensionScore,
  CheckResult,
  MetricResult,
  OrchestraState,
  OrchestraConfig,
  OrchestraSettings,
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
} from "./client/types.js";

export type { ConnectionStatus } from "./client/event-source.js";
export type { OrchestraStats, StoreState } from "./store/types.js";
export type { TaskFilter } from "./store/selectors.js";
