export type TaskDirectionMode = "steer" | "follow_up" | "continue";
export type TaskDirectionStatus = "queued" | "delivered" | "applied" | "failed";

export interface TaskDirection {
  id: string;
  taskId: string;
  runId?: string;
  mode: TaskDirectionMode;
  message: string;
  status: TaskDirectionStatus;
  createdAt: string;
  deliveredAt?: string;
  appliedAt?: string;
  error?: string;
}

export interface AgentConversationCheckpoint {
  taskId: string;
  runId: string;
  /** Last fully-consistent pi-agent-core message history. */
  messages: unknown[];
  savedAt: string;
  turnCount: number;
}

export interface TaskControlStore {
  enqueueDirection(input: {
    taskId: string;
    runId?: string;
    mode: TaskDirectionMode;
    message: string;
  }): Promise<TaskDirection>;
  /** Atomically claim queued directions for this task and run. */
  claimDirections(taskId: string, runId: string): Promise<TaskDirection[]>;
  markDirectionApplied(id: string): Promise<void>;
  failDirection(id: string, error: string): Promise<void>;
  /** Return an interrupted continuation to the unbound queue for a replacement run. */
  requeueDirection(id: string): Promise<void>;
  listDirections(taskId: string): Promise<TaskDirection[]>;
  saveCheckpoint(checkpoint: AgentConversationCheckpoint): Promise<void>;
  getCheckpoint(taskId: string): Promise<AgentConversationCheckpoint | undefined>;
}
