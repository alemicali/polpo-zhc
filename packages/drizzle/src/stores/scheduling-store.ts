import { and, eq, lt, or } from "drizzle-orm";
import type { LeaseStore, ScheduleState, ScheduleStore, TaskWatcherStore } from "@polpo-ai/core/schedule-store";
import type { TaskWatcher } from "@polpo-ai/core/types";
import { deserializeJson, serializeJson, type Dialect } from "../utils.js";

type AnyTable = any;

/** Schedules' runtime state: one row per mission, the whole state in `doc`. */
export class DrizzleScheduleStore implements ScheduleStore {
  constructor(private db: any, private table: AnyTable, private dialect: Dialect) {}

  async getSchedule(missionId: string): Promise<ScheduleState | undefined> {
    const rows: any[] = await this.db.select().from(this.table).where(eq(this.table.missionId, missionId));
    return rows[0] ? this.toState(rows[0]) : undefined;
  }

  async listSchedules(): Promise<ScheduleState[]> {
    const rows: any[] = await this.db.select().from(this.table);
    return rows.map((r) => this.toState(r));
  }

  async saveSchedule(state: ScheduleState): Promise<void> {
    const row = { missionId: state.missionId, doc: serializeJson(state, this.dialect), updatedAt: state.updatedAt };
    await this.db.insert(this.table).values(row)
      .onConflictDoUpdate({ target: this.table.missionId, set: { doc: row.doc, updatedAt: row.updatedAt } });
  }

  async deleteSchedule(missionId: string): Promise<boolean> {
    if (!(await this.getSchedule(missionId))) return false;
    await this.db.delete(this.table).where(eq(this.table.missionId, missionId));
    return true;
  }

  private toState(row: any): ScheduleState {
    return deserializeJson<ScheduleState>(row.doc, { missionId: row.missionId } as ScheduleState, this.dialect);
  }
}

/**
 * Claims shared by every process on the database. A claim is one atomic upsert: it inserts the
 * key, or takes it over only when the current claim has expired (or is the caller's own); the
 * claim is the caller's when the row then names it.
 */
export class DrizzleLeaseStore implements LeaseStore {
  constructor(private db: any, private table: AnyTable) {}

  async tryClaim(key: string, owner: string, ttlMs: number): Promise<boolean> {
    const now = new Date();
    const nowIso = now.toISOString();
    const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
    await this.db.insert(this.table).values({ key, owner, expiresAt, createdAt: nowIso })
      .onConflictDoUpdate({
        target: this.table.key,
        set: { owner, expiresAt, createdAt: nowIso },
        setWhere: or(lt(this.table.expiresAt, nowIso), eq(this.table.owner, owner)),
      });
    const rows: any[] = await this.db.select().from(this.table).where(eq(this.table.key, key));
    return rows[0]?.owner === owner;
  }

  async release(key: string, owner: string): Promise<void> {
    await this.db.delete(this.table).where(and(eq(this.table.key, key), eq(this.table.owner, owner)));
  }

  async prune(before: string): Promise<number> {
    const rows: any[] = await this.db.select({ key: this.table.key }).from(this.table).where(lt(this.table.expiresAt, before));
    if (rows.length === 0) return 0;
    await this.db.delete(this.table).where(lt(this.table.expiresAt, before));
    return rows.length;
  }
}

/** Task watchers: the whole watcher in `doc`. */
export class DrizzleTaskWatcherStore implements TaskWatcherStore {
  constructor(private db: any, private table: AnyTable, private dialect: Dialect) {}

  async listWatchers(): Promise<TaskWatcher[]> {
    const rows: any[] = await this.db.select().from(this.table);
    return rows.map((r) => deserializeJson<TaskWatcher>(r.doc, { id: r.id } as TaskWatcher, this.dialect))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async saveWatcher(watcher: TaskWatcher): Promise<void> {
    const row = { id: watcher.id, taskId: watcher.taskId, doc: serializeJson(watcher, this.dialect), createdAt: watcher.createdAt };
    await this.db.insert(this.table).values(row).onConflictDoUpdate({ target: this.table.id, set: { doc: row.doc, taskId: row.taskId } });
  }

  async deleteWatcher(id: string): Promise<boolean> {
    const rows: any[] = await this.db.select({ id: this.table.id }).from(this.table).where(eq(this.table.id, id));
    if (rows.length === 0) return false;
    await this.db.delete(this.table).where(eq(this.table.id, id));
    return true;
  }
}
