import { eq, desc, asc, lt, and, sql, type SQL } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { TaskStore } from "@polpo-ai/core/task-store";
import type {
  Task, TaskStatus, Mission, PolpoState, AgentProcess,
} from "@polpo-ai/core/types";
import { assertValidTransition } from "@polpo-ai/core/state-machine";
import { type Dialect, serializeJson, deserializeJson } from "../utils.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyTable = any;

/**
 * Sanitize a user-provided string for an FTS5 MATCH query.
 *
 * FTS5 query syntax treats `"`, `*`, `+`, `-`, `^`, `(`, `)`, and `:` as
 * operators. The simplest safe contract for autocomplete-style search is:
 *
 *  1. Strip everything that isn't alphanumeric, whitespace, or underscore.
 *  2. Collapse multiple spaces.
 *  3. Wrap the final token in `"..."*` so it becomes a prefix match.
 *
 * Returns an empty string when input has no usable tokens — callers should
 * treat that as "no search" (fall back to cursor pagination).
 */
function sanitizeFtsQuery(raw: string): string {
  // Replace every non-word, non-space character with a space — this removes
  // ", *, :, (, ), +, -, etc. without breaking on unicode letters.
  const cleaned = raw
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}_\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "";
  // Split into tokens. Wrap each in double quotes for safety, append `*`
  // to the LAST token so the user gets prefix-match autocomplete behaviour.
  const tokens = cleaned.split(" ").filter(Boolean);
  if (tokens.length === 0) return "";
  return tokens
    .map((tok, i) => i === tokens.length - 1 ? `"${tok}"*` : `"${tok}"`)
    .join(" ");
}

export interface TaskStoreSchema {
  tasks: AnyTable;
  missions: AnyTable;
  metadata: AnyTable;
  processes: AnyTable;
}

export class DrizzleTaskStore implements TaskStore {
  constructor(
    private db: any,
    private schema: TaskStoreSchema,
    private dialect: Dialect,
  ) {}

  // ── Helpers ──────────────────────────────────────────────────────────

  private rowToTask(row: any): Task {
    const d = this.dialect;
    return {
      id: row.id,
      title: row.title,
      description: row.description,
      assignTo: row.assignTo,
      group: row.group ?? undefined,
      missionId: row.missionId ?? undefined,
      dependsOn: deserializeJson<string[]>(row.dependsOn, [], d),
      status: row.status as TaskStatus,
      retries: row.retries,
      maxRetries: row.maxRetries,
      maxDuration: row.maxDuration ?? undefined,
      retryPolicy: deserializeJson(row.retryPolicy, undefined, d),
      expectations: deserializeJson(row.expectations, [], d),
      metrics: deserializeJson(row.metrics, [], d),
      result: deserializeJson(row.result, undefined, d),
      phase: row.phase ?? undefined,
      fixAttempts: row.fixAttempts ?? 0,
      resolutionAttempts: row.resolutionAttempts ?? 0,
      originalDescription: row.originalDescription ?? undefined,
      sessionId: row.sessionId ?? undefined,
      notifications: deserializeJson(row.notifications, undefined, d),
      outcomes: deserializeJson(row.outcomes, undefined, d),
      expectedOutcomes: deserializeJson(row.expectedOutcomes, undefined, d),
      deadline: row.deadline ?? undefined,
      priority: row.priority ? Number(row.priority) : undefined,
      sideEffects: row.sideEffects ? Boolean(row.sideEffects) : undefined,
      revisionCount: row.revisionCount ?? undefined,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private taskToValues(task: Partial<Task> & { id: string }): Record<string, unknown> {
    const d = this.dialect;
    const v: Record<string, unknown> = {};
    if (task.id !== undefined) v.id = task.id;
    if (task.title !== undefined) v.title = task.title;
    if (task.description !== undefined) v.description = task.description;
    if (task.assignTo !== undefined) v.assignTo = task.assignTo;
    if (task.group !== undefined) v.group = task.group;
    if (task.missionId !== undefined) v.missionId = task.missionId;
    if (task.dependsOn !== undefined) v.dependsOn = serializeJson(task.dependsOn, d);
    if (task.status !== undefined) v.status = task.status;
    if (task.retries !== undefined) v.retries = task.retries;
    if (task.maxRetries !== undefined) v.maxRetries = task.maxRetries;
    if (task.maxDuration !== undefined) v.maxDuration = task.maxDuration;
    if (task.retryPolicy !== undefined) v.retryPolicy = serializeJson(task.retryPolicy, d);
    if (task.expectations !== undefined) v.expectations = serializeJson(task.expectations, d);
    if (task.metrics !== undefined) v.metrics = serializeJson(task.metrics, d);
    if (task.result !== undefined) v.result = serializeJson(task.result, d);
    if (task.phase !== undefined) v.phase = task.phase;
    if (task.fixAttempts !== undefined) v.fixAttempts = task.fixAttempts;
    if (task.resolutionAttempts !== undefined) v.resolutionAttempts = task.resolutionAttempts;
    if (task.originalDescription !== undefined) v.originalDescription = task.originalDescription;
    if (task.sessionId !== undefined) v.sessionId = task.sessionId;
    if (task.notifications !== undefined) v.notifications = serializeJson(task.notifications, d);
    if (task.outcomes !== undefined) v.outcomes = serializeJson(task.outcomes, d);
    if (task.expectedOutcomes !== undefined) v.expectedOutcomes = serializeJson(task.expectedOutcomes, d);
    if (task.deadline !== undefined) v.deadline = task.deadline;
    if (task.priority !== undefined) v.priority = String(task.priority);
    if (task.sideEffects !== undefined) v.sideEffects = task.sideEffects ? 1 : 0;
    if (task.revisionCount !== undefined) v.revisionCount = task.revisionCount;
    if (task.createdAt !== undefined) v.createdAt = task.createdAt;
    if (task.updatedAt !== undefined) v.updatedAt = task.updatedAt;
    return v;
  }

  private rowToMission(row: any): Mission {
    const d = this.dialect;
    return {
      id: row.id,
      name: row.name,
      data: row.data,
      prompt: row.prompt ?? undefined,
      status: row.status,
      schedule: row.schedule ?? undefined,
      endDate: row.endDate ?? undefined,
      qualityThreshold: row.qualityThreshold ? Number(row.qualityThreshold) : undefined,
      deadline: row.deadline ?? undefined,
      notifications: deserializeJson(row.notifications, undefined, d),
      executionCount: row.executionCount ?? 0,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private rowToProcess(row: any): AgentProcess {
    return {
      agentName: row.agentName,
      pid: row.pid,
      taskId: row.taskId,
      startedAt: row.startedAt,
      alive: Boolean(row.alive),
      activity: deserializeJson(row.activity, {
        filesCreated: [], filesEdited: [], toolCalls: 0, totalTokens: 0, lastUpdate: "",
      }, this.dialect),
    };
  }

  // ── State ────────────────────────────────────────────────────────────

  async getState(): Promise<PolpoState> {
    const { metadata, tasks, processes } = this.schema;

    const metaRows: any[] = await this.db.select().from(metadata);
    const meta: Record<string, string> = {};
    for (const r of metaRows) meta[r.key] = r.value;

    let teams: any[] = [];
    if (meta.teams) {
      teams = deserializeJson<any[]>(meta.teams, [], this.dialect);
    } else if (meta.team) {
      teams = [deserializeJson(meta.team, { name: "default", agents: [] }, this.dialect)];
    }

    const taskRows: any[] = await this.db.select().from(tasks).orderBy(asc(tasks.createdAt));
    const procRows: any[] = await this.db.select().from(processes);

    return {
      project: meta.project ?? "",
      teams,
      tasks: taskRows.map((r) => this.rowToTask(r)),
      processes: procRows.map((r) => this.rowToProcess(r)),
      startedAt: meta.startedAt,
      completedAt: meta.completedAt,
    };
  }

  async setState(partial: Partial<PolpoState>): Promise<void> {
    const { metadata, tasks, processes } = this.schema;
    const d = this.dialect;

    // SQLite transactions require synchronous callbacks — execute directly.
    const upsertMeta = (db: any, key: string, value: string) =>
      db.insert(metadata).values({ key, value })
        .onConflictDoUpdate({ target: metadata.key, set: { value } });

    const exec = async (db: any) => {
      if (partial.project !== undefined) {
        await upsertMeta(db, "project", partial.project);
      }
      if (partial.teams !== undefined) {
        const val = JSON.stringify(partial.teams);
        await upsertMeta(db, "teams", val);
      }
      if (partial.startedAt !== undefined) {
        await upsertMeta(db, "startedAt", partial.startedAt);
      }
      if (partial.completedAt !== undefined) {
        await upsertMeta(db, "completedAt", partial.completedAt);
      }
      if (partial.processes !== undefined) {
        await db.delete(processes);
        for (const p of partial.processes) {
          await db.insert(processes).values({
            agentName: p.agentName,
            pid: p.pid,
            taskId: p.taskId,
            startedAt: p.startedAt,
            alive: p.alive ? 1 : 0,
            activity: serializeJson(p.activity, d),
          });
        }
      }
      if (partial.tasks !== undefined) {
        await db.delete(tasks);
        for (const t of partial.tasks) {
          await db.insert(tasks).values(this.taskToValues(t));
        }
      }
    };

    // Execute directly without transaction.
    // Neon HTTP driver doesn't support transactions, and
    // SQLite better-sqlite3 transactions don't support async callbacks.
    // Individual upserts are idempotent — no transaction needed for correctness.
    await exec(this.db);
  }

  // ── Task CRUD ────────────────────────────────────────────────────────

  async addTask(input: Omit<Task, "id" | "status" | "retries" | "createdAt" | "updatedAt"> & { status?: TaskStatus }): Promise<Task> {
    const now = new Date().toISOString();
    const task: Task = {
      ...input,
      id: nanoid(),
      status: input.status ?? "pending",
      retries: 0,
      createdAt: now,
      updatedAt: now,
    };
    await this.db.insert(this.schema.tasks).values(this.taskToValues(task));
    return task;
  }

  async getTask(taskId: string): Promise<Task | undefined> {
    const rows: any[] = await this.db.select().from(this.schema.tasks)
      .where(eq(this.schema.tasks.id, taskId));
    return rows.length > 0 ? this.rowToTask(rows[0]) : undefined;
  }

  async getAllTasks(): Promise<Task[]> {
    const rows: any[] = await this.db.select().from(this.schema.tasks)
      .orderBy(asc(this.schema.tasks.createdAt));
    return rows.map((r) => this.rowToTask(r));
  }

  /**
   * Cursor-paginated task list, optionally filtered + full-text searched.
   *
   * - When `q` is set, results come from the FTS5 virtual table
   *   `tasks_fts` (ranked by relevance). Cursor is ignored because rank
   *   ordering and updated_at ordering are incompatible.
   * - When `q` is empty, results are ordered by `updated_at DESC` and the
   *   cursor is the `updated_at` of the last item from the previous page.
   * - status / group / assignTo filters are AND-combined with both modes.
   * - `hasMore` is determined by fetching `limit + 1` rows.
   *
   * Only implemented for SQLite — Postgres falls back to `getAllTasks()`
   * + in-memory filtering at the route level.
   */
  async getTasksPage(opts: {
    limit?: number;
    cursor?: string | null;
    q?: string | null;
    status?: string | null;
    group?: string | null;
    assignTo?: string | null;
  }): Promise<{ tasks: Task[]; nextCursor: string | null; hasMore: boolean }> {
    const limit = Math.min(Math.max(1, opts.limit ?? 50), 200);
    const fetchLimit = limit + 1;
    const t = this.schema.tasks;

    const filters: SQL[] = [];
    if (opts.status) filters.push(eq(t.status, opts.status));
    if (opts.group) filters.push(eq(t.group, opts.group));
    if (opts.assignTo) filters.push(eq(t.assignTo, opts.assignTo));

    let rows: any[];

    if (opts.q && opts.q.trim().length > 0 && this.dialect === "sqlite") {
      // FTS5 path. We sanitize + append `*` for prefix matching before
      // calling drizzle (see sanitizeFtsQuery() in stores/index helpers).
      const ftsQuery = sanitizeFtsQuery(opts.q);
      // Raw SQL is safer here than mixing the `MATCH` operator with the
      // Drizzle query builder — better-sqlite3 binds `?` parameters
      // positionally and FTS5 needs the raw match string.
      const filterClauses: string[] = [];
      const params: any[] = [ftsQuery];
      if (opts.status) { filterClauses.push(`t.status = ?`); params.push(opts.status); }
      if (opts.group)  { filterClauses.push(`t."group" = ?`); params.push(opts.group); }
      if (opts.assignTo) { filterClauses.push(`t.assign_to = ?`); params.push(opts.assignTo); }
      params.push(fetchLimit);
      const filterSql = filterClauses.length > 0 ? `AND ${filterClauses.join(" AND ")}` : "";
      const stmt = `
        SELECT t.* FROM tasks t
        JOIN tasks_fts f ON t.rowid = f.rowid
        WHERE tasks_fts MATCH ? ${filterSql}
        ORDER BY rank
        LIMIT ?
      `;
      try {
        // better-sqlite3 exposes the underlying client on `db.$client`.
        // Fallback: use the raw `db.session.client` (drizzle internals).
        const client = (this.db as any).$client ?? (this.db as any).session?.client;
        if (!client?.prepare) throw new Error("no raw sqlite client");
        const raw = client.prepare(stmt).all(...params);
        rows = raw.map((r: any) => this.mapSnakeRow(r));
      } catch (err) {
        // FTS5 missing or any other error: fall back to LIKE-based search
        // so the endpoint still returns *something* useful.
        const like = `%${opts.q.trim()}%`;
        const allRows: any[] = await this.db.select().from(t)
          .orderBy(desc(t.updatedAt));
        rows = allRows.filter((r: any) => {
          if (opts.status && r.status !== opts.status) return false;
          if (opts.group && r.group !== opts.group) return false;
          if (opts.assignTo && r.assignTo !== opts.assignTo) return false;
          const title = (r.title ?? "").toString();
          const desc = (r.description ?? "").toString();
          return title.includes(opts.q!) || desc.includes(opts.q!) ||
                 title.toLowerCase().includes(opts.q!.toLowerCase()) ||
                 desc.toLowerCase().includes(opts.q!.toLowerCase());
        }).slice(0, fetchLimit);
        void like;
        void err;
      }
    } else {
      // Cursor path.
      const where = [...filters];
      if (opts.cursor) where.push(lt(t.updatedAt, opts.cursor));
      const whereClause = where.length === 0 ? undefined
        : where.length === 1 ? where[0] : and(...where);

      const query = this.db.select().from(t)
        .orderBy(desc(t.updatedAt))
        .limit(fetchLimit);
      const finalQuery = whereClause ? query.where(whereClause) : query;
      rows = await finalQuery;
    }

    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;
    const tasks = data.map((r) => this.rowToTask(r));
    const nextCursor = hasMore && tasks.length > 0 ? tasks[tasks.length - 1].updatedAt : null;
    return { tasks, nextCursor, hasMore };
  }

  /**
   * Map a snake_case row (from raw SQLite query) onto the camelCase shape
   * that `rowToTask` expects. Drizzle does this automatically; raw queries
   * don't.
   */
  private mapSnakeRow(r: any): any {
    return {
      id: r.id,
      title: r.title,
      description: r.description,
      assignTo: r.assign_to,
      group: r.group,
      missionId: r.mission_id,
      dependsOn: r.depends_on,
      status: r.status,
      retries: r.retries,
      maxRetries: r.max_retries,
      maxDuration: r.max_duration,
      retryPolicy: r.retry_policy,
      expectations: r.expectations,
      metrics: r.metrics,
      result: r.result,
      phase: r.phase,
      fixAttempts: r.fix_attempts,
      resolutionAttempts: r.resolution_attempts,
      originalDescription: r.original_description,
      sessionId: r.session_id,
      notifications: r.notifications,
      outcomes: r.outcomes,
      expectedOutcomes: r.expected_outcomes,
      deadline: r.deadline,
      priority: r.priority,
      sideEffects: r.side_effects,
      revisionCount: r.revision_count,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  async updateTask(taskId: string, updates: Partial<Omit<Task, "id" | "status">>): Promise<Task> {
    const existing = await this.getTask(taskId);
    if (!existing) throw new Error(`Task "${taskId}" not found`);

    const now = new Date().toISOString();
    const merged = { ...existing, ...updates, updatedAt: now };
    const values = this.taskToValues(merged);
    delete values.id;
    await this.db.update(this.schema.tasks).set(values)
      .where(eq(this.schema.tasks.id, taskId));
    return merged;
  }

  async removeTask(taskId: string): Promise<boolean> {
    const result = await this.db.delete(this.schema.tasks)
      .where(eq(this.schema.tasks.id, taskId));
    return (result?.rowCount ?? result?.changes ?? 0) > 0;
  }

  async removeTasks(filter: (task: Task) => boolean): Promise<number> {
    const all = await this.getAllTasks();
    const toRemove = all.filter(filter);
    if (toRemove.length === 0) return 0;
    for (const t of toRemove) {
      await this.db.delete(this.schema.tasks)
        .where(eq(this.schema.tasks.id, t.id));
    }
    return toRemove.length;
  }

  // ── State machine ───────────────────────────────────────────────────

  async transition(taskId: string, newStatus: TaskStatus): Promise<Task> {
    const task = await this.getTask(taskId);
    if (!task) throw new Error(`Task "${taskId}" not found`);

    assertValidTransition(task.status, newStatus);

    const now = new Date().toISOString();
    const updates: Record<string, unknown> = { status: newStatus, updatedAt: now };

    // Increment retries on failed → pending
    if (task.status === "failed" && newStatus === "pending") {
      updates.retries = task.retries + 1;
    }

    await this.db.update(this.schema.tasks).set(updates)
      .where(eq(this.schema.tasks.id, taskId));

    return { ...task, status: newStatus, updatedAt: now, retries: (updates.retries as number) ?? task.retries };
  }

  async unsafeSetStatus(taskId: string, newStatus: TaskStatus, _reason: string): Promise<Task> {
    const task = await this.getTask(taskId);
    if (!task) throw new Error(`Task "${taskId}" not found`);

    const now = new Date().toISOString();
    await this.db.update(this.schema.tasks)
      .set({ status: newStatus, updatedAt: now })
      .where(eq(this.schema.tasks.id, taskId));

    return { ...task, status: newStatus, updatedAt: now };
  }

  // ── Missions ─────────────────────────────────────────────────────────

  async saveMission(input: Omit<Mission, "id" | "createdAt" | "updatedAt">): Promise<Mission> {
    const now = new Date().toISOString();
    const mission: Mission = {
      ...input,
      id: nanoid(),
      createdAt: now,
      updatedAt: now,
    };
    const d = this.dialect;
    await this.db.insert(this.schema.missions).values({
      id: mission.id,
      name: mission.name,
      data: mission.data,
      prompt: mission.prompt ?? null,
      status: mission.status,
      schedule: mission.schedule ?? null,
      endDate: mission.endDate ?? null,
      qualityThreshold: mission.qualityThreshold != null ? String(mission.qualityThreshold) : null,
      deadline: mission.deadline ?? null,
      notifications: serializeJson(mission.notifications, d),
      executionCount: mission.executionCount ?? 0,
      createdAt: mission.createdAt,
      updatedAt: mission.updatedAt,
    });
    return mission;
  }

  async getMission(missionId: string): Promise<Mission | undefined> {
    const rows: any[] = await this.db.select().from(this.schema.missions)
      .where(eq(this.schema.missions.id, missionId));
    return rows.length > 0 ? this.rowToMission(rows[0]) : undefined;
  }

  async getMissionByName(name: string): Promise<Mission | undefined> {
    const rows: any[] = await this.db.select().from(this.schema.missions)
      .where(eq(this.schema.missions.name, name));
    return rows.length > 0 ? this.rowToMission(rows[0]) : undefined;
  }

  async getAllMissions(): Promise<Mission[]> {
    const rows: any[] = await this.db.select().from(this.schema.missions)
      .orderBy(desc(this.schema.missions.createdAt));
    return rows.map((r) => this.rowToMission(r));
  }

  async updateMission(missionId: string, updates: Partial<Omit<Mission, "id">>): Promise<Mission> {
    const existing = await this.getMission(missionId);
    if (!existing) throw new Error(`Mission "${missionId}" not found`);

    const now = new Date().toISOString();
    const d = this.dialect;
    const values: Record<string, unknown> = { updatedAt: now };

    if (updates.name !== undefined) values.name = updates.name;
    if (updates.data !== undefined) values.data = updates.data;
    if (updates.prompt !== undefined) values.prompt = updates.prompt;
    if (updates.status !== undefined) values.status = updates.status;
    if (updates.schedule !== undefined) values.schedule = updates.schedule;
    if (updates.endDate !== undefined) values.endDate = updates.endDate;
    if (updates.qualityThreshold !== undefined) values.qualityThreshold = updates.qualityThreshold != null ? String(updates.qualityThreshold) : null;
    if (updates.deadline !== undefined) values.deadline = updates.deadline;
    if (updates.notifications !== undefined) values.notifications = serializeJson(updates.notifications, d);
    if (updates.executionCount !== undefined) values.executionCount = updates.executionCount;

    await this.db.update(this.schema.missions).set(values)
      .where(eq(this.schema.missions.id, missionId));

    return { ...existing, ...updates, updatedAt: now };
  }

  async deleteMission(missionId: string): Promise<boolean> {
    const result = await this.db.delete(this.schema.missions)
      .where(eq(this.schema.missions.id, missionId));
    return (result?.rowCount ?? result?.changes ?? 0) > 0;
  }

  async nextMissionName(): Promise<string> {
    const rows: any[] = await this.db.select().from(this.schema.missions)
      .orderBy(desc(this.schema.missions.createdAt));
    let maxNum = 0;
    for (const r of rows) {
      const match = (r.name as string).match(/^mission-(\d+)$/);
      if (match) maxNum = Math.max(maxNum, Number(match[1]));
    }
    return `mission-${maxNum + 1}`;
  }

  async close(): Promise<void> {
    // Connection lifecycle managed externally
  }
}
