import Database from "better-sqlite3";
import type { Database as DatabaseType, Statement } from "better-sqlite3";
import { join } from "node:path";
import { existsSync, readFileSync, renameSync, mkdirSync } from "node:fs";
import { nanoid } from "nanoid";
import type { Task, TaskStatus, OrchestraState, AgentProcess, Team } from "../core/types.js";
import type { TaskStore } from "../core/task-store.js";
import { assertValidTransition } from "../core/state-machine.js";

interface TaskRow {
  id: string;
  title: string;
  description: string;
  assign_to: string;
  group: string | null;
  depends_on: string;
  status: string;
  retries: number;
  max_retries: number;
  expectations: string;
  metrics: string;
  result: string | null;
  created_at: string;
  updated_at: string;
}

interface ProcessRow {
  agent_name: string;
  pid: number;
  task_id: string;
  started_at: string;
  alive: number;
  activity: string;
}

export class SqliteTaskStore implements TaskStore {
  private db: DatabaseType;
  private orchestraDir: string;

  // Prepared statements
  private insertTaskStmt: Statement;
  private getTaskStmt: Statement;
  private getAllTasksStmt: Statement;
  private deleteTaskStmt: Statement;
  private deleteAllTasksStmt: Statement;
  private getMetaStmt: Statement;
  private upsertMetaStmt: Statement;
  private clearProcessesStmt: Statement;
  private insertProcessStmt: Statement;
  private getAllProcessesStmt: Statement;

  constructor(orchestraDir: string) {
    this.orchestraDir = orchestraDir;
    const dbPath = join(orchestraDir, "state.db");
    if (!existsSync(orchestraDir)) {
      mkdirSync(orchestraDir, { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.initSchema();

    // Prepare statements
    this.insertTaskStmt = this.db.prepare(`
      INSERT INTO tasks (id, title, description, assign_to, "group", depends_on, status, retries, max_retries, expectations, metrics, result, created_at, updated_at)
      VALUES (@id, @title, @description, @assign_to, @group, @depends_on, @status, @retries, @max_retries, @expectations, @metrics, @result, @created_at, @updated_at)
    `);
    this.getTaskStmt = this.db.prepare(`SELECT * FROM tasks WHERE id = ?`);
    this.getAllTasksStmt = this.db.prepare(`SELECT * FROM tasks ORDER BY created_at ASC`);
    this.deleteTaskStmt = this.db.prepare(`DELETE FROM tasks WHERE id = ?`);
    this.deleteAllTasksStmt = this.db.prepare(`DELETE FROM tasks`);
    this.getMetaStmt = this.db.prepare(`SELECT value FROM metadata WHERE key = ?`);
    this.upsertMetaStmt = this.db.prepare(`INSERT INTO metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
    this.clearProcessesStmt = this.db.prepare(`DELETE FROM processes`);
    this.insertProcessStmt = this.db.prepare(`
      INSERT INTO processes (agent_name, pid, task_id, started_at, alive, activity)
      VALUES (@agent_name, @pid, @task_id, @started_at, @alive, @activity)
    `);
    this.getAllProcessesStmt = this.db.prepare(`SELECT * FROM processes`);

    this.migrateFromJson();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS metadata (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id          TEXT PRIMARY KEY,
        title       TEXT NOT NULL,
        description TEXT NOT NULL,
        assign_to   TEXT NOT NULL,
        "group"     TEXT,
        depends_on  TEXT NOT NULL DEFAULT '[]',
        status      TEXT NOT NULL DEFAULT 'pending',
        retries     INTEGER NOT NULL DEFAULT 0,
        max_retries INTEGER NOT NULL DEFAULT 2,
        expectations TEXT NOT NULL DEFAULT '[]',
        metrics     TEXT NOT NULL DEFAULT '[]',
        result      TEXT,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_group ON tasks("group");
      CREATE INDEX IF NOT EXISTS idx_tasks_assign_to ON tasks(assign_to);

      CREATE TABLE IF NOT EXISTS processes (
        agent_name TEXT NOT NULL,
        pid        INTEGER NOT NULL,
        task_id    TEXT NOT NULL,
        started_at TEXT NOT NULL,
        alive      INTEGER NOT NULL DEFAULT 1,
        activity   TEXT NOT NULL DEFAULT '{}'
      );
    `);
  }

  private migrateFromJson(): void {
    const jsonPath = join(this.orchestraDir, "state.json");
    if (!existsSync(jsonPath)) return;

    // Only migrate if DB has no tasks (fresh DB)
    const count = this.db.prepare("SELECT COUNT(*) as c FROM tasks").get() as { c: number };
    if (count.c > 0) return;

    try {
      const raw = readFileSync(jsonPath, "utf-8");
      const state: OrchestraState = JSON.parse(raw);

      this.db.transaction(() => {
        if (state.project) this.upsertMetaStmt.run("project", state.project);
        if (state.team) this.upsertMetaStmt.run("team", JSON.stringify(state.team));
        if (state.startedAt) this.upsertMetaStmt.run("startedAt", state.startedAt);
        if (state.completedAt) this.upsertMetaStmt.run("completedAt", state.completedAt);

        for (const task of state.tasks) {
          this.insertTaskStmt.run(this.taskToRow(task));
        }
      })();

      renameSync(jsonPath, jsonPath + ".migrated");
    } catch {
      // Migration failed — non-fatal, start fresh
    }
  }

  // === Row ↔ Task conversion ===

  private rowToTask(row: TaskRow): Task {
    return {
      id: row.id,
      title: row.title,
      description: row.description,
      assignTo: row.assign_to,
      group: row.group ?? undefined,
      dependsOn: JSON.parse(row.depends_on),
      status: row.status as TaskStatus,
      retries: row.retries,
      maxRetries: row.max_retries,
      expectations: JSON.parse(row.expectations),
      metrics: JSON.parse(row.metrics),
      result: row.result ? JSON.parse(row.result) : undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private taskToRow(task: Task): Record<string, unknown> {
    return {
      id: task.id,
      title: task.title,
      description: task.description,
      assign_to: task.assignTo,
      group: task.group ?? null,
      depends_on: JSON.stringify(task.dependsOn ?? []),
      status: task.status,
      retries: task.retries,
      max_retries: task.maxRetries,
      expectations: JSON.stringify(task.expectations ?? []),
      metrics: JSON.stringify(task.metrics ?? []),
      result: task.result ? JSON.stringify(task.result) : null,
      created_at: task.createdAt,
      updated_at: task.updatedAt,
    };
  }

  private rowToProcess(row: ProcessRow): AgentProcess {
    return {
      agentName: row.agent_name,
      pid: row.pid,
      taskId: row.task_id,
      startedAt: row.started_at,
      alive: row.alive === 1,
      activity: JSON.parse(row.activity),
    };
  }

  // === TaskStore interface ===

  getState(): OrchestraState {
    const projectRow = this.getMetaStmt.get("project") as { value: string } | undefined;
    const teamRow = this.getMetaStmt.get("team") as { value: string } | undefined;
    const startedRow = this.getMetaStmt.get("startedAt") as { value: string } | undefined;
    const completedRow = this.getMetaStmt.get("completedAt") as { value: string } | undefined;

    const tasks = (this.getAllTasksStmt.all() as TaskRow[]).map(r => this.rowToTask(r));
    const processes = (this.getAllProcessesStmt.all() as ProcessRow[]).map(r => this.rowToProcess(r));

    const state: OrchestraState = {
      project: projectRow?.value ?? "",
      team: teamRow ? JSON.parse(teamRow.value) as Team : { name: "", agents: [] },
      tasks,
      processes,
    };
    if (startedRow) state.startedAt = startedRow.value;
    if (completedRow) state.completedAt = completedRow.value;
    return state;
  }

  setState(partial: Partial<OrchestraState>): void {
    this.db.transaction(() => {
      if (partial.project !== undefined) {
        this.upsertMetaStmt.run("project", partial.project);
      }
      if (partial.team !== undefined) {
        this.upsertMetaStmt.run("team", JSON.stringify(partial.team));
      }
      if (partial.startedAt !== undefined) {
        this.upsertMetaStmt.run("startedAt", partial.startedAt);
      }
      if (partial.completedAt !== undefined) {
        this.upsertMetaStmt.run("completedAt", partial.completedAt);
      }
      if (partial.processes !== undefined) {
        this.clearProcessesStmt.run();
        for (const proc of partial.processes) {
          this.insertProcessStmt.run({
            agent_name: proc.agentName,
            pid: proc.pid,
            task_id: proc.taskId,
            started_at: proc.startedAt,
            alive: proc.alive ? 1 : 0,
            activity: JSON.stringify(proc.activity),
          });
        }
      }
      if (partial.tasks !== undefined) {
        this.deleteAllTasksStmt.run();
        for (const task of partial.tasks) {
          this.insertTaskStmt.run(this.taskToRow(task));
        }
      }
    })();
  }

  addTask(
    task: Omit<Task, "id" | "status" | "retries" | "createdAt" | "updatedAt">
  ): Task {
    const now = new Date().toISOString();
    const newTask: Task = {
      ...task,
      id: nanoid(),
      status: "pending",
      retries: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.insertTaskStmt.run(this.taskToRow(newTask));
    return newTask;
  }

  getTask(taskId: string): Task | undefined {
    const row = this.getTaskStmt.get(taskId) as TaskRow | undefined;
    return row ? this.rowToTask(row) : undefined;
  }

  getAllTasks(): Task[] {
    return (this.getAllTasksStmt.all() as TaskRow[]).map(r => this.rowToTask(r));
  }

  updateTask(taskId: string, updates: Partial<Omit<Task, "id">>): Task {
    const existing = this.getTaskStmt.get(taskId) as TaskRow | undefined;
    if (!existing) throw new Error(`Task not found: ${taskId}`);

    const now = new Date().toISOString();
    const setClauses: string[] = ["updated_at = @updated_at"];
    const params: Record<string, unknown> = { id: taskId, updated_at: now };

    if (updates.title !== undefined) { setClauses.push("title = @title"); params.title = updates.title; }
    if (updates.description !== undefined) { setClauses.push("description = @description"); params.description = updates.description; }
    if (updates.assignTo !== undefined) { setClauses.push("assign_to = @assign_to"); params.assign_to = updates.assignTo; }
    if (updates.group !== undefined) { setClauses.push('"group" = @group'); params.group = updates.group ?? null; }
    if (updates.dependsOn !== undefined) { setClauses.push("depends_on = @depends_on"); params.depends_on = JSON.stringify(updates.dependsOn); }
    if (updates.status !== undefined) { setClauses.push("status = @status"); params.status = updates.status; }
    if (updates.retries !== undefined) { setClauses.push("retries = @retries"); params.retries = updates.retries; }
    if (updates.maxRetries !== undefined) { setClauses.push("max_retries = @max_retries"); params.max_retries = updates.maxRetries; }
    if (updates.expectations !== undefined) { setClauses.push("expectations = @expectations"); params.expectations = JSON.stringify(updates.expectations); }
    if (updates.metrics !== undefined) { setClauses.push("metrics = @metrics"); params.metrics = JSON.stringify(updates.metrics); }
    if (updates.result !== undefined) { setClauses.push("result = @result"); params.result = JSON.stringify(updates.result); }
    if (updates.createdAt !== undefined) { setClauses.push("created_at = @created_at"); params.created_at = updates.createdAt; }

    const sql = `UPDATE tasks SET ${setClauses.join(", ")} WHERE id = @id`;
    this.db.prepare(sql).run(params);

    return this.rowToTask(this.getTaskStmt.get(taskId) as TaskRow);
  }

  removeTask(taskId: string): boolean {
    const result = this.deleteTaskStmt.run(taskId);
    return result.changes > 0;
  }

  removeTasks(filter: (task: Task) => boolean): number {
    const all = this.getAllTasks();
    const toRemove = all.filter(filter);
    if (toRemove.length === 0) return 0;

    const placeholders = toRemove.map(() => "?").join(",");
    const ids = toRemove.map(t => t.id);
    this.db.prepare(`DELETE FROM tasks WHERE id IN (${placeholders})`).run(...ids);
    return toRemove.length;
  }

  transition(taskId: string, newStatus: TaskStatus): Task {
    const row = this.getTaskStmt.get(taskId) as TaskRow | undefined;
    if (!row) throw new Error(`Task not found: ${taskId}`);

    const currentStatus = row.status as TaskStatus;
    assertValidTransition(currentStatus, newStatus);

    const now = new Date().toISOString();
    let retries = row.retries;
    if (newStatus === "pending" && currentStatus === "failed") {
      retries += 1;
    }

    this.db.prepare(`UPDATE tasks SET status = ?, retries = ?, updated_at = ? WHERE id = ?`)
      .run(newStatus, retries, now, taskId);

    return this.rowToTask(this.getTaskStmt.get(taskId) as TaskRow);
  }

  close(): void {
    this.db.close();
  }
}
