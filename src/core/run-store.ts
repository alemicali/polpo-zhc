import type { AgentActivity, TaskResult } from "./types.js";

export type RunStatus = "running" | "completed" | "failed" | "killed";

export interface RunRecord {
  id: string;
  taskId: string;
  pid: number;
  agentName: string;
  adapterType?: string;
  sessionId?: string;
  status: RunStatus;
  startedAt: string;
  updatedAt: string;
  activity: AgentActivity;
  result?: TaskResult;
  configPath: string;
}

export interface RunStore {
  upsertRun(run: RunRecord): void;
  updateActivity(runId: string, activity: AgentActivity): void;
  completeRun(runId: string, status: RunStatus, result: TaskResult): void;
  getRun(runId: string): RunRecord | undefined;
  getRunByTaskId(taskId: string): RunRecord | undefined;
  getActiveRuns(): RunRecord[];
  getTerminalRuns(): RunRecord[];
  deleteRun(runId: string): void;
  close(): void;
}
