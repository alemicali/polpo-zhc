import type {
  Task,
  Mission,
  MissionReport,
  ActiveDelay,
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

export interface AssessmentProgressEntry {
  message: string;
  timestamp: number;
}

export interface AssessmentCheckStatus {
  index: number;
  total: number;
  type: string;
  label: string;
  phase: "started" | "complete";
  passed?: boolean;
  message?: string;
  timestamp: number;
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
  /** Agent-specific memory keyed by agent name. */
  agentMemory: Map<string, { exists: boolean; content: string }>;
  /** Live assessment progress messages keyed by taskId. Cleared on assessment:complete. */
  assessmentProgress: Map<string, AssessmentProgressEntry[]>;
  /** Per-check status keyed by taskId. Tracks which expectations are running/done. Cleared on assessment:complete. */
  assessmentChecks: Map<string, AssessmentCheckStatus[]>;
  /** Active delay timers keyed by "group:delayName". Updated from delay:started/delay:expired SSE events. */
  activeDelays: Map<string, ActiveDelay>;
}
