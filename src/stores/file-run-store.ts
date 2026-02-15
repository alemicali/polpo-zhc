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

  upsertRun(run: RunRecord): void {
    this.writeRun(run);
  }

  updateActivity(runId: string, activity: AgentActivity): void {
    const run = this.readRun(runId);
    if (!run) return;
    run.activity = activity;
    if (activity.sessionId) run.sessionId = activity.sessionId;
    run.updatedAt = new Date().toISOString();
    this.writeRun(run);
  }

  updateOutcomes(runId: string, outcomes: TaskOutcome[]): void {
    const run = this.readRun(runId);
    if (!run) return;
    run.outcomes = outcomes;
    run.updatedAt = new Date().toISOString();
    this.writeRun(run);
  }

  completeRun(runId: string, status: RunStatus, result: TaskResult): void {
    const run = this.readRun(runId);
    if (!run) return;
    run.status = status;
    run.result = result;
    run.updatedAt = new Date().toISOString();
    this.writeRun(run);
  }

  getRun(runId: string): RunRecord | undefined {
    return this.readRun(runId);
  }

  getRunByTaskId(taskId: string): RunRecord | undefined {
    // Scan all runs — small directory, fast enough
    for (const id of this.listRunIds()) {
      const run = this.readRun(id);
      if (run && run.taskId === taskId) return run;
    }
    return undefined;
  }

  getActiveRuns(): RunRecord[] {
    return this.allRuns().filter(r => r.status === "running");
  }

  getTerminalRuns(): RunRecord[] {
    return this.allRuns().filter(
      r => r.status === "completed" || r.status === "failed" || r.status === "killed",
    );
  }

  deleteRun(runId: string): void {
    const path = this.runPath(runId);
    try {
      unlinkSync(path);
    } catch {
      /* already gone */
    }
  }

  close(): void {
    // No-op for filesystem store
  }
}
