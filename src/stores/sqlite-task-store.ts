import { createDatabase, type PolpoDatabase, type PolpoStatement } from "./sqlite-compat.js";
import { join } from "node:path";
import { existsSync, readFileSync, renameSync, mkdirSync } from "node:fs";
import { nanoid } from "nanoid";
import type { Task, TaskStatus, PolpoState, AgentProcess, Team, Mission, MissionStatus } from "../core/types.js";
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
  max_duration: number | null;
  retry_policy: string | null;
  expectations: string;
  metrics: string;
  result: string | null;
  phase: string | null;
  fix_attempts: number;
  resolution_attempts: number;
  original_description: string | null;
  session_id: string | null;
  notifications: string | null;
  outcomes: string | null;
  expected_outcomes: string | null;
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

interface MissionRow {
  id: string;
  name: string;
  data: string;
  prompt: string | null;
  status: string;
  notifications: string | null;
  created_at: string;
  updated_at: string;
}

function safeJsonParse<T>(json: string | null | undefined, fallback: T): T {
  if (!json) return fallback;
  try {
    return JSON.parse(json) as T;
  } catch { /* malformed JSON — use fallback */
    return fallback;
  }
}

export class SqliteTaskStore implements TaskStore {
  private db: PolpoDatabase;
  private polpoDir: string;

  // Prepared statements
  private insertTaskStmt: PolpoStatement;
  private getTaskStmt: PolpoStatement;
  private getAllTasksStmt: PolpoStatement;
  private deleteTaskStmt: PolpoStatement;
  private deleteAllTasksStmt: PolpoStatement;
  private getMetaStmt: PolpoStatement;
  private upsertMetaStmt: PolpoStatement;
  private clearProcessesStmt: PolpoStatement;
  private insertProcessStmt: PolpoStatement;
  private getAllProcessesStmt: PolpoStatement;
  private insertMissionStmt!: PolpoStatement;
  private getMissionStmt!: PolpoStatement;
  private getMissionByNameStmt!: PolpoStatement;
  private getAllMissionsStmt!: PolpoStatement;
  private deleteMissionStmt!: PolpoStatement;

  constructor(polpoDir: string) {
    this.polpoDir = polpoDir;
    const dbPath = join(polpoDir, "state.db");
    if (!existsSync(polpoDir)) {
      mkdirSync(polpoDir, { recursive: true });
    }
    this.db = createDatabase(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.initSchema();
    this.migrateSchema();

    // Prepare statements
    this.insertTaskStmt = this.db.prepare(`
      INSERT INTO tasks (id, title, description, assign_to, "group", depends_on, status, retries, max_retries, max_duration, retry_policy, expectations, metrics, result, phase, fix_attempts, original_description, session_id, notifications, outcomes, expected_outcomes, created_at, updated_at)
      VALUES (@id, @title, @description, @assign_to, @group, @depends_on, @status, @retries, @max_retries, @max_duration, @retry_policy, @expectations, @metrics, @result, @phase, @fix_attempts, @original_description, @session_id, @notifications, @outcomes, @expected_outcomes, @created_at, @updated_at)
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

    // Mission statements
    this.insertMissionStmt = this.db.prepare(`
      INSERT INTO missions (id, name, data, prompt, status, notifications, created_at, updated_at)
      VALUES (@id, @name, @data, @prompt, @status, @notifications, @created_at, @updated_at)
    `);
    this.getMissionStmt = this.db.prepare(`SELECT * FROM missions WHERE id = ?`);
    this.getMissionByNameStmt = this.db.prepare(`SELECT * FROM missions WHERE name = ?`);
    this.getAllMissionsStmt = this.db.prepare(`SELECT * FROM missions ORDER BY created_at DESC`);
    this.deleteMissionStmt = this.db.prepare(`DELETE FROM missions WHERE id = ?`);

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
        phase       TEXT,
        fix_attempts INTEGER NOT NULL DEFAULT 0,
        original_description TEXT,
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

      CREATE TABLE IF NOT EXISTS missions (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL UNIQUE,
        data        TEXT NOT NULL,
        prompt      TEXT,
        status      TEXT NOT NULL DEFAULT 'draft',
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_missions_status ON missions(status);
    `);
  }

  private migrateSchema(): void {
    // Add columns that didn't exist in the initial schema
    const migrations = [
      `ALTER TABLE tasks ADD COLUMN max_duration INTEGER`,
      `ALTER TABLE tasks ADD COLUMN retry_policy TEXT`,
      `ALTER TABLE tasks ADD COLUMN phase TEXT`,
      `ALTER TABLE tasks ADD COLUMN fix_attempts INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE tasks ADD COLUMN original_description TEXT`,
      `ALTER TABLE tasks ADD COLUMN resolution_attempts INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE tasks ADD COLUMN session_id TEXT`,
      `ALTER TABLE tasks ADD COLUMN notifications TEXT`,
      `ALTER TABLE tasks ADD COLUMN outcomes TEXT`,
      `ALTER TABLE tasks ADD COLUMN expected_outcomes TEXT`,
      `ALTER TABLE missions ADD COLUMN notifications TEXT`,
      `ALTER TABLE missions RENAME COLUMN yaml TO data`,
    ];
    for (const sql of migrations) {
      try { this.db.exec(sql); } catch { /* column already exists or rename already applied */ }
    }

    // Rename legacy "plans" table → "missions"
    try {
      this.db.exec(`ALTER TABLE plans RENAME TO missions`);
    } catch { /* table already renamed or doesn't exist */ }
  }

  private migrateFromJson(): void {
    const jsonPath = join(this.polpoDir, "state.json");
    if (!existsSync(jsonPath)) return;

    // Only migrate if DB has no tasks (fresh DB)
    const count = this.db.prepare("SELECT COUNT(*) as c FROM tasks").get() as { c: number };
    if (count.c > 0) return;

    try {
      const raw = readFileSync(jsonPath, "utf-8");
      const state: PolpoState = JSON.parse(raw);

      this.db.transaction(() => {
        if (state.project) this.upsertMetaStmt.run("project", state.project);
        // Migrate legacy: state may have singular `team` or new `teams`
        const teams = (state as any).teams ?? ((state as any).team ? [(state as any).team] : []);
        if (teams.length > 0) this.upsertMetaStmt.run("teams", JSON.stringify(teams));
        if (state.startedAt) this.upsertMetaStmt.run("startedAt", state.startedAt);
        if (state.completedAt) this.upsertMetaStmt.run("completedAt", state.completedAt);

        for (const task of state.tasks) {
          this.insertTaskStmt.run(this.taskToRow(task));
        }
      })();

      renameSync(jsonPath, jsonPath + ".migrated");
    } catch { /* migration failed — start fresh */
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
      dependsOn: safeJsonParse<string[]>(row.depends_on, []),
      status: row.status as TaskStatus,
      retries: row.retries,
      maxRetries: row.max_retries,
      maxDuration: row.max_duration ?? undefined,
      retryPolicy: safeJsonParse(row.retry_policy, undefined),
      expectations: safeJsonParse(row.expectations, []),
      metrics: safeJsonParse(row.metrics, []),
      result: safeJsonParse(row.result, undefined),
      phase: (row.phase as Task["phase"]) ?? undefined,
      fixAttempts: row.fix_attempts ?? 0,
      resolutionAttempts: row.resolution_attempts ?? 0,
      originalDescription: row.original_description ?? undefined,
      sessionId: row.session_id ?? undefined,
      notifications: safeJsonParse(row.notifications, undefined),
      outcomes: safeJsonParse(row.outcomes, undefined),
      expectedOutcomes: safeJsonParse(row.expected_outcomes, undefined),
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
      max_duration: task.maxDuration ?? null,
      retry_policy: task.retryPolicy ? JSON.stringify(task.retryPolicy) : null,
      expectations: JSON.stringify(task.expectations ?? []),
      metrics: JSON.stringify(task.metrics ?? []),
      result: task.result ? JSON.stringify(task.result) : null,
      phase: task.phase ?? null,
      fix_attempts: task.fixAttempts ?? 0,
      resolution_attempts: task.resolutionAttempts ?? 0,
      original_description: task.originalDescription ?? null,
      session_id: task.sessionId ?? null,
      notifications: task.notifications ? JSON.stringify(task.notifications) : null,
      outcomes: task.outcomes ? JSON.stringify(task.outcomes) : null,
      expected_outcomes: task.expectedOutcomes ? JSON.stringify(task.expectedOutcomes) : null,
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
      activity: safeJsonParse(row.activity, { filesCreated: [], filesEdited: [], toolCalls: 0, totalTokens: 0, lastUpdate: "" }),
    };
  }

  // === TaskStore interface ===

  getState(): PolpoState {
    const projectRow = this.getMetaStmt.get("project") as { value: string } | undefined;
    const teamRow = this.getMetaStmt.get("team") as { value: string } | undefined;
    const startedRow = this.getMetaStmt.get("startedAt") as { value: string } | undefined;
    const completedRow = this.getMetaStmt.get("completedAt") as { value: string } | undefined;

    const tasks = (this.getAllTasksStmt.all() as TaskRow[]).map(r => this.rowToTask(r));
    const processes = (this.getAllProcessesStmt.all() as ProcessRow[]).map(r => this.rowToProcess(r));

    // Support both legacy "team" key and new "teams" key
    const teamsRow = this.getMetaStmt.get("teams") as { value: string } | undefined;
    let teams: Team[];
    if (teamsRow) {
      teams = JSON.parse(teamsRow.value) as Team[];
    } else if (teamRow) {
      // Legacy migration: singular team → array
      teams = [JSON.parse(teamRow.value) as Team];
    } else {
      teams = [{ name: "", agents: [] }];
    }

    const state: PolpoState = {
      project: projectRow?.value ?? "",
      teams,
      tasks,
      processes,
    };
    if (startedRow) state.startedAt = startedRow.value;
    if (completedRow) state.completedAt = completedRow.value;
    return state;
  }

  setState(partial: Partial<PolpoState>): void {
    this.db.transaction(() => {
      if (partial.project !== undefined) {
        this.upsertMetaStmt.run("project", partial.project);
      }
      if (partial.teams !== undefined) {
        this.upsertMetaStmt.run("teams", JSON.stringify(partial.teams));
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
    task: Omit<Task, "id" | "status" | "retries" | "createdAt" | "updatedAt"> & { status?: TaskStatus },
  ): Task {
    const now = new Date().toISOString();
    const newTask: Task = {
      ...task,
      id: nanoid(),
      status: task.status ?? "pending",
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

  unsafeSetStatus(taskId: string, newStatus: TaskStatus, reason: string): Task {
    const row = this.getTaskStmt.get(taskId) as TaskRow | undefined;
    if (!row) throw new Error(`Task not found: ${taskId}`);
    const from = row.status;
    const now = new Date().toISOString();
    this.db.prepare("UPDATE tasks SET status = @status, updated_at = @now WHERE id = @id")
      .run({ id: taskId, status: newStatus, now });
    console.warn(`[unsafeSetStatus] ${taskId}: ${from} → ${newStatus} — ${reason}`);
    return this.rowToTask(this.getTaskStmt.get(taskId) as TaskRow);
  }

  updateTask(taskId: string, updates: Partial<Omit<Task, "id" | "status">>): Task {
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
    if (updates.retries !== undefined) { setClauses.push("retries = @retries"); params.retries = updates.retries; }
    if (updates.maxRetries !== undefined) { setClauses.push("max_retries = @max_retries"); params.max_retries = updates.maxRetries; }
    if (updates.maxDuration !== undefined) { setClauses.push("max_duration = @max_duration"); params.max_duration = updates.maxDuration; }
    if (updates.retryPolicy !== undefined) { setClauses.push("retry_policy = @retry_policy"); params.retry_policy = JSON.stringify(updates.retryPolicy); }
    if (updates.expectations !== undefined) { setClauses.push("expectations = @expectations"); params.expectations = JSON.stringify(updates.expectations); }
    if (updates.metrics !== undefined) { setClauses.push("metrics = @metrics"); params.metrics = JSON.stringify(updates.metrics); }
    if (updates.result !== undefined) { setClauses.push("result = @result"); params.result = JSON.stringify(updates.result); }
    if ("phase" in updates) { setClauses.push("phase = @phase"); params.phase = updates.phase ?? null; }
    if (updates.fixAttempts !== undefined) { setClauses.push("fix_attempts = @fix_attempts"); params.fix_attempts = updates.fixAttempts; }
    if (updates.resolutionAttempts !== undefined) { setClauses.push("resolution_attempts = @resolution_attempts"); params.resolution_attempts = updates.resolutionAttempts; }
    if (updates.originalDescription !== undefined) { setClauses.push("original_description = @original_description"); params.original_description = updates.originalDescription ?? null; }
    if (updates.sessionId !== undefined) { setClauses.push("session_id = @session_id"); params.session_id = updates.sessionId ?? null; }
    if (updates.notifications !== undefined) { setClauses.push("notifications = @notifications"); params.notifications = updates.notifications ? JSON.stringify(updates.notifications) : null; }
    if (updates.outcomes !== undefined) { setClauses.push("outcomes = @outcomes"); params.outcomes = updates.outcomes ? JSON.stringify(updates.outcomes) : null; }
    if (updates.expectedOutcomes !== undefined) { setClauses.push("expected_outcomes = @expected_outcomes"); params.expected_outcomes = updates.expectedOutcomes ? JSON.stringify(updates.expectedOutcomes) : null; }
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

  // === Mission persistence ===

  private rowToMission(row: MissionRow): Mission {
    return {
      id: row.id,
      name: row.name,
      data: row.data,
      prompt: row.prompt ?? undefined,
      status: row.status as MissionStatus,
      notifications: safeJsonParse(row.notifications, undefined),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  saveMission(mission: Omit<Mission, "id" | "createdAt" | "updatedAt">): Mission {
    const now = new Date().toISOString();
    const newMission: Mission = {
      ...mission,
      id: nanoid(),
      createdAt: now,
      updatedAt: now,
    };
    this.insertMissionStmt.run({
      id: newMission.id,
      name: newMission.name,
      data: newMission.data,
      prompt: newMission.prompt ?? null,
      status: newMission.status,
      notifications: newMission.notifications ? JSON.stringify(newMission.notifications) : null,
      created_at: newMission.createdAt,
      updated_at: newMission.updatedAt,
    });
    return newMission;
  }

  getMission(missionId: string): Mission | undefined {
    const row = this.getMissionStmt.get(missionId) as MissionRow | undefined;
    return row ? this.rowToMission(row) : undefined;
  }

  getMissionByName(name: string): Mission | undefined {
    const row = this.getMissionByNameStmt.get(name) as MissionRow | undefined;
    return row ? this.rowToMission(row) : undefined;
  }

  getAllMissions(): Mission[] {
    return (this.getAllMissionsStmt.all() as MissionRow[]).map(r => this.rowToMission(r));
  }

  updateMission(missionId: string, updates: Partial<Omit<Mission, "id">>): Mission {
    const existing = this.getMissionStmt.get(missionId) as MissionRow | undefined;
    if (!existing) throw new Error(`Mission not found: ${missionId}`);

    const now = new Date().toISOString();
    const setClauses: string[] = ["updated_at = @updated_at"];
    const params: Record<string, unknown> = { id: missionId, updated_at: now };

    if (updates.name !== undefined) { setClauses.push("name = @name"); params.name = updates.name; }
    if (updates.data !== undefined) { setClauses.push("data = @data"); params.data = updates.data; }
    if (updates.prompt !== undefined) { setClauses.push("prompt = @prompt"); params.prompt = updates.prompt ?? null; }
    if (updates.status !== undefined) { setClauses.push("status = @status"); params.status = updates.status; }
    if (updates.notifications !== undefined) { setClauses.push("notifications = @notifications"); params.notifications = updates.notifications ? JSON.stringify(updates.notifications) : null; }

    const sql = `UPDATE missions SET ${setClauses.join(", ")} WHERE id = @id`;
    this.db.prepare(sql).run(params);

    return this.rowToMission(this.getMissionStmt.get(missionId) as MissionRow);
  }

  deleteMission(missionId: string): boolean {
    const result = this.deleteMissionStmt.run(missionId);
    return result.changes > 0;
  }

  nextMissionName(): string {
    const row = this.db.prepare("SELECT COUNT(*) as c FROM missions").get() as { c: number };
    return `mission-${row.c + 1}`;
  }

  close(): void {
    this.db.close();
  }
}
