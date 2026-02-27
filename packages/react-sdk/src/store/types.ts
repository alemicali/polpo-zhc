import type {
  Task,
  Mission,
  MissionReport,
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
  missions: Map<string, Mission>;
  /** Mission completion reports keyed by missionId. Populated from mission:completed SSE events. */
  missionReports: Map<string, MissionReport>;
  agents: AgentConfig[];
  processes: AgentProcess[];
  stats: PolpoStats | null;
  connectionStatus: ConnectionStatus;
  recentEvents: SSEEvent[];
  missionsStale: boolean;
  memory: { exists: boolean; content: string } | null;
}
