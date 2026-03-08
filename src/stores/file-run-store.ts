import { join } from "node:path";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import type { AgentActivity, TaskResult, TaskOutcome } from "../core/types.js";
import type { RunStore, RunRecord, RunStatus } from "../core/run-store.js";

function safeJsonParse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Atomic write: write to tmp file then rename. */
function atomicWrite(filePath: string, data: unknown): void {
  const tmp = filePath + ".tmp";
  writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
  renameSync(tmp, filePath);
}

/**
 * Filesystem-based RunStore.
 * Each run is a single JSON file in .polpo/runs/<runId>.json.
 *
 * Concurrency model: the runner subprocess owns its run file (writes),
 * the orchestrator only reads. No cross-process write conflicts.
 */
export class FileRunStore implements RunStore {
  private runsDir: string;

  constructor(polpoDir: string) {
    this.runsDir = join(polpoDir, "runs");
    if (!existsSync(this.runsDir)) mkdirSync(this.runsDir, { recursive: true });
  }

  private runPath(id: string): string {
    return join(this.runsDir, `${id}.json`);
  }

  private readRun(id: string): RunRecord | undefined {
    const path = this.runPath(id);
    if (!existsSync(path)) return undefined;
    try {
      return safeJsonParse<RunRecord | undefined>(
        readFileSync(path, "utf-8"),
        undefined,
      );
    } catch {
      return undefined;
    }
  }

  private writeRun(run: RunRecord): void {
    atomicWrite(this.runPath(run.id), run);
  }

  private listRunIds(): string[] {
    if (!existsSync(this.runsDir)) return [];
    return readdirSync(this.runsDir)
      .filter(f => f.endsWith(".json") && !f.endsWith(".tmp"))
      .map(f => f.slice(0, -5));
  }

  private allRuns(): RunRecord[] {
    const records: RunRecord[] = [];
    for (const id of this.listRunIds()) {
      const run = this.readRun(id);
      if (run) records.push(run);
    }
    return records;
  }

  async upsertRun(run: RunRecord): Promise<void> {
    this.writeRun(run);
  }

  async updateActivity(runId: string, activity: AgentActivity): Promise<void> {
    const run = this.readRun(runId);
    if (!run) return;
    run.activity = activity;
    if (activity.sessionId) run.sessionId = activity.sessionId;
    run.updatedAt = new Date().toISOString();
    this.writeRun(run);
  }

  async updateOutcomes(runId: string, outcomes: TaskOutcome[]): Promise<void> {
    const run = this.readRun(runId);
    if (!run) return;
    run.outcomes = outcomes;
    run.updatedAt = new Date().toISOString();
    this.writeRun(run);
  }

  async completeRun(runId: string, status: RunStatus, result: TaskResult): Promise<void> {
    const run = this.readRun(runId);
    if (!run) return;
    // Don't let a later write overwrite a run already in terminal state.
    // This prevents the runner process from clobbering the orchestrator's
    // "killed" status with a stale "completed" result (race condition).
    const terminal: RunStatus[] = ["completed", "failed", "killed"];
    if (terminal.includes(run.status)) return;
    run.status = status;
    run.result = result;
    run.updatedAt = new Date().toISOString();
    this.writeRun(run);
  }

  async getRun(runId: string): Promise<RunRecord | undefined> {
    return this.readRun(runId);
  }

  async getRunByTaskId(taskId: string): Promise<RunRecord | undefined> {
    // Scan all runs — small directory, fast enough
    for (const id of this.listRunIds()) {
      const run = this.readRun(id);
      if (run && run.taskId === taskId) return run;
    }
    return undefined;
  }

  async getActiveRuns(): Promise<RunRecord[]> {
    return this.allRuns().filter(r => r.status === "running");
  }

  async getTerminalRuns(): Promise<RunRecord[]> {
    return this.allRuns().filter(
      r => r.status === "completed" || r.status === "failed" || r.status === "killed",
    );
  }

  async deleteRun(runId: string): Promise<void> {
    const path = this.runPath(runId);
    try {
      unlinkSync(path);
    } catch {
      /* already gone */
    }
  }

  async close(): Promise<void> {
    // No-op for filesystem store
  }
}
