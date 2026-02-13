import { createDatabase } from "./sqlite-compat.js";
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
  session_id: string | null;
  status: string;
  started_at: string;
  updated_at: string;
  activity: string;
  result: string | null;
  config_path: string;
}

function safeJsonParse<T>(json: string | null | undefined, fallback: T): T {
  if (!json) return fallback;
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

export class SqliteRunStore implements RunStore {
  private db: any;

  private upsertRunStmt: any;
  private updateActivityStmt: any;
  private completeRunStmt: any;
  private getRunStmt: any;
  private getRunByTaskIdStmt: any;
  private getActiveRunsStmt: any;
  private getTerminalRunsStmt: any;
  private deleteRunStmt: any;

  constructor(dbPath: string) {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    this.db = createDatabase(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.initSchema();

    this.upsertRunStmt = this.db.prepare(`
      INSERT INTO runs (id, task_id, pid, agent_name, adapter_type, session_id, status, started_at, updated_at, activity, result, config_path)
      VALUES (@id, @task_id, @pid, @agent_name, @adapter_type, @session_id, @status, @started_at, @updated_at, @activity, @result, @config_path)
      ON CONFLICT(id) DO UPDATE SET
        pid = excluded.pid,
        session_id = COALESCE(excluded.session_id, runs.session_id),
        status = excluded.status,
        updated_at = excluded.updated_at,
        activity = excluded.activity,
        result = excluded.result,
        config_path = excluded.config_path
    `);

    this.updateActivityStmt = this.db.prepare(`
      UPDATE runs SET activity = @activity, session_id = COALESCE(@session_id, session_id), updated_at = @updated_at WHERE id = @id
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
        session_id   TEXT,
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

    // Migration: add session_id column for existing databases
    try {
      this.db.exec(`ALTER TABLE runs ADD COLUMN session_id TEXT`);
    } catch {
      // Column already exists — expected for new databases
    }
  }

  private rowToRecord(row: RunRow): RunRecord {
    const activity = safeJsonParse<AgentActivity>(row.activity, { filesCreated: [], filesEdited: [], toolCalls: 0, lastUpdate: "" });
    // Prefer first-class column; fall back to value inside activity JSON
    const sessionId = row.session_id ?? activity.sessionId ?? undefined;
    return {
      id: row.id,
      taskId: row.task_id,
      pid: row.pid,
      agentName: row.agent_name,
      adapterType: row.adapter_type,
      sessionId,
      status: row.status as RunStatus,
      startedAt: row.started_at,
      updatedAt: row.updated_at,
      activity,
      result: safeJsonParse(row.result, undefined),
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
      session_id: run.sessionId ?? run.activity.sessionId ?? null,
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
      session_id: activity.sessionId ?? null,
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
