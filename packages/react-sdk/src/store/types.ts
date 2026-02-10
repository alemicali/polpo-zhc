import type {
  Task,
  Plan,
  AgentConfig,
  AgentProcess,
  SSEEvent,
} from "../client/types.js";
import type { ConnectionStatus } from "../client/event-source.js";

export interface OrchestraStats {
  pending: number;
  running: number;
  done: number;
  failed: number;
}

export interface StoreState {
  tasks: Map<string, Task>;
  plans: Map<string, Plan>;
  agents: AgentConfig[];
  processes: AgentProcess[];
  stats: OrchestraStats | null;
  connectionStatus: ConnectionStatus;
  recentEvents: SSEEvent[];
  plansStale: boolean;
  memory: { exists: boolean; content: string } | null;
}
