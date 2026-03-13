import type { AgentActivity, TaskResult, TaskOutcome, RunnerConfig } from "./types.js";

export type RunStatus = "running" | "completed" | "failed" | "killed";

export interface RunRecord {
  id: string;
  taskId: string;
  pid: number;
  agentName: string;
  sessionId?: string;
  status: RunStatus;
  startedAt: string;
  updatedAt: string;
  activity: AgentActivity;
  result?: TaskResult;
  /** Outcomes auto-collected during execution (files, media, text artifacts). */
  outcomes?: TaskOutcome[];
  /** Full runner configuration (used by cloud runners that read config from DB instead of file). */
  config?: RunnerConfig;
  configPath: string;
}

export interface RunStore {
  upsertRun(run: RunRecord): Promise<void>;
  updateActivity(runId: string, activity: AgentActivity): Promise<void>;
  /** Store auto-collected outcomes on the run record (called before completeRun). */
  updateOutcomes(runId: string, outcomes: TaskOutcome[]): Promise<void>;
  completeRun(runId: string, status: RunStatus, result: TaskResult): Promise<void>;
  getRun(runId: string): Promise<RunRecord | undefined>;
  getRunByTaskId(taskId: string): Promise<RunRecord | undefined>;
  getActiveRuns(): Promise<RunRecord[]>;
  getTerminalRuns(): Promise<RunRecord[]>;
  deleteRun(runId: string): Promise<void>;
  close(): Promise<void> | void;
}
