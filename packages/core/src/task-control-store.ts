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

export type BackgroundWaitState = "waiting" | "ready" | "running" | "completed" | "failed" | "cancelled";

export interface BackgroundWait {
  id: string;
  taskId: string;
  sessionId: string;
  targetStatus?: string;
  state: BackgroundWaitState;
  lastTaskStatus?: string;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  triggeredAt?: string;
  completedAt?: string;
  error?: string;
}

export interface BackgroundWaitStore {
  createBackgroundWait(input: { taskId: string; sessionId: string; targetStatus?: string }): Promise<BackgroundWait>;
  getBackgroundWait(id: string): Promise<BackgroundWait | undefined>;
  listBackgroundWaits(sessionId?: string): Promise<BackgroundWait[]>;
  markBackgroundWaitReady(id: string, taskStatus: string): Promise<boolean>;
  claimBackgroundWait(id: string): Promise<BackgroundWait | undefined>;
  completeBackgroundWait(id: string): Promise<void>;
  failBackgroundWait(id: string, error: string): Promise<void>;
  requeueBackgroundWait(id: string): Promise<void>;
  cancelBackgroundWait(id: string): Promise<boolean>;
  recoverBackgroundWaits(): Promise<number>;
}

export interface TaskControlStore extends Partial<BackgroundWaitStore> {
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
