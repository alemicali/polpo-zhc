import type { AgentActivity, TaskResult, TaskOutcome } from "./types.js";

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
  /** Outcomes auto-collected during execution (files, media, text artifacts). */
  outcomes?: TaskOutcome[];
  configPath: string;
}

export interface RunStore {
  upsertRun(run: RunRecord): void;
  updateActivity(runId: string, activity: AgentActivity): void;
  /** Store auto-collected outcomes on the run record (called before completeRun). */
  updateOutcomes(runId: string, outcomes: TaskOutcome[]): void;
  completeRun(runId: string, status: RunStatus, result: TaskResult): void;
  getRun(runId: string): RunRecord | undefined;
  getRunByTaskId(taskId: string): RunRecord | undefined;
  getActiveRuns(): RunRecord[];
  getTerminalRuns(): RunRecord[];
  deleteRun(runId: string): void;
  close(): void;
}
