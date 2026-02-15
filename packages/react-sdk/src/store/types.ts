import type {
  Task,
  Plan,
  PlanReport,
  AgentConfig,
  AgentProcess,
  SSEEvent,
} from "../client/types.js";
import type { ConnectionStatus } from "../client/event-source.js";

export interface PolpoStats {
  pending: number;
  running: number;
  done: number;
  failed: number;
  queued: number;
}

export interface StoreState {
  tasks: Map<string, Task>;
  plans: Map<string, Plan>;
  /** Plan completion reports keyed by planId. Populated from plan:completed SSE events. */
  planReports: Map<string, PlanReport>;
  agents: AgentConfig[];
  processes: AgentProcess[];
  stats: PolpoStats | null;
  connectionStatus: ConnectionStatus;
  recentEvents: SSEEvent[];
  plansStale: boolean;
  memory: { exists: boolean; content: string } | null;
}
