import Database from "better-sqlite3";
import type { Database as DatabaseType, Statement } from "better-sqlite3";
import { mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentActivity, TaskResult } from "../core/types.js";
import type { RunStore, RunRecord, RunStatus } from "../core/run-store.js";

interface RunRow {
  id: string;
  task_id: string;
  pid: number;
  agent_name: string;
  adapter_type: string;
  status: string;
  started_at: string;
  updated_at: string;
  activity: string;
  result: string | null;
  config_path: string;
}

export class SqliteRunStore implements RunStore {
  private db: DatabaseType;

  private upsertRunStmt: Statement;
  private updateActivityStmt: Statement;
  private completeRunStmt: Statement;
  private getRunStmt: Statement;
  private getRunByTaskIdStmt: Statement;
  private getActiveRunsStmt: Statement;
  private getTerminalRunsStmt: Statement;
  private deleteRunStmt: Statement;

  constructor(dbPath: string) {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("busy_timeout = 5000");
    this.initSchema();

    this.upsertRunStmt = this.db.prepare(`
      INSERT INTO runs (id, task_id, pid, agent_name, adapter_type, status, started_at, updated_at, activity, result, config_path)
      VALUES (@id, @task_id, @pid, @agent_name, @adapter_type, @status, @started_at, @updated_at, @activity, @result, @config_path)
      ON CONFLICT(id) DO UPDATE SET
        pid = excluded.pid,
        status = excluded.status,
        updated_at = excluded.updated_at,
        activity = excluded.activity,
        result = excluded.result,
        config_path = excluded.config_path
    `);

    this.updateActivityStmt = this.db.prepare(`
      UPDATE runs SET activity = @activity, updated_at = @updated_at WHERE id = @id
    `);

    this.completeRunStmt = this.db.prepare(`
      UPDATE runs SET status = @status, result = @result, updated_at = @updated_at WHERE id = @id
    `);

    this.getRunStmt = this.db.prepare(`SELECT * FROM runs WHERE id = ?`);
    this.getRunByTaskIdStmt = this.db.prepare(`SELECT * FROM runs WHERE task_id = ? ORDER BY started_at DESC LIMIT 1`);
    this.getActiveRunsStmt = this.db.prepare(`SELECT * FROM runs WHERE status = 'running'`);
    this.getTerminalRunsStmt = this.db.prepare(`SELECT * FROM runs WHERE status IN ('completed', 'failed', 'killed')`);
    this.deleteRunStmt = this.db.prepare(`DELETE FROM runs WHERE id = ?`);
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id           TEXT PRIMARY KEY,
        task_id      TEXT NOT NULL,
        pid          INTEGER NOT NULL DEFAULT 0,
        agent_name   TEXT NOT NULL,
        adapter_type TEXT NOT NULL,
        status       TEXT NOT NULL DEFAULT 'running',
        started_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL,
        activity     TEXT NOT NULL DEFAULT '{}',
        result       TEXT,
        config_path  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
      CREATE INDEX IF NOT EXISTS idx_runs_task_id ON runs(task_id);
    `);
  }

  private rowToRecord(row: RunRow): RunRecord {
    return {
      id: row.id,
      taskId: row.task_id,
      pid: row.pid,
      agentName: row.agent_name,
      adapterType: row.adapter_type,
      status: row.status as RunStatus,
      startedAt: row.started_at,
      updatedAt: row.updated_at,
      activity: JSON.parse(row.activity),
      result: row.result ? JSON.parse(row.result) : undefined,
      configPath: row.config_path,
    };
  }

  upsertRun(run: RunRecord): void {
    this.upsertRunStmt.run({
      id: run.id,
      task_id: run.taskId,
      pid: run.pid,
      agent_name: run.agentName,
      adapter_type: run.adapterType,
      status: run.status,
      started_at: run.startedAt,
      updated_at: run.updatedAt,
      activity: JSON.stringify(run.activity),
      result: run.result ? JSON.stringify(run.result) : null,
      config_path: run.configPath,
    });
  }

  updateActivity(runId: string, activity: AgentActivity): void {
    this.updateActivityStmt.run({
      id: runId,
      activity: JSON.stringify(activity),
      updated_at: new Date().toISOString(),
    });
  }

  completeRun(runId: string, status: RunStatus, result: TaskResult): void {
    this.completeRunStmt.run({
      id: runId,
      status,
      result: JSON.stringify(result),
      updated_at: new Date().toISOString(),
    });
  }

  getRun(runId: string): RunRecord | undefined {
    const row = this.getRunStmt.get(runId) as RunRow | undefined;
    return row ? this.rowToRecord(row) : undefined;
  }

  getRunByTaskId(taskId: string): RunRecord | undefined {
    const row = this.getRunByTaskIdStmt.get(taskId) as RunRow | undefined;
    return row ? this.rowToRecord(row) : undefined;
  }

  getActiveRuns(): RunRecord[] {
    return (this.getActiveRunsStmt.all() as RunRow[]).map(r => this.rowToRecord(r));
  }

  getTerminalRuns(): RunRecord[] {
    return (this.getTerminalRunsStmt.all() as RunRow[]).map(r => this.rowToRecord(r));
  }

  deleteRun(runId: string): void {
    this.deleteRunStmt.run(runId);
  }

  close(): void {
    this.db.close();
  }
}
