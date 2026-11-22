/**
 * Persistence for the runtime state of schedulers: nothing that decides whether (or when) a
 * scheduled thing runs may live only in memory.
 *
 * - {@link ScheduleStore}: per mission schedule, the state the mission itself does not hold —
 *   paused or not, next and last run, how the last run went, runs missed while the server was down.
 * - {@link LeaseStore}: atomic, expiring claims shared by every process on the same storage. A
 *   scheduler claims "this schedule at this time" before firing it, so a run fires once even with
 *   two server processes (or a restart in the middle).
 * - {@link TaskWatcherStore}: task watchers ("when task X is done, do Y").
 *
 * The in-memory implementations here are for tests and single-process runtimes without storage.
 */
import type { TaskWatcher } from "./types.js";

/** What to do with a run missed while the server was down. */
export type ScheduleCatchUp = "none" | "once";

/** How the last run of a schedule went (or why it did not happen). */
export type ScheduleOutcome = "started" | "completed" | "failed" | "skipped" | "missed" | "expired";

export interface ScheduleState {
  /** The mission the schedule runs (one schedule per mission). */
  missionId: string;
  /** The expression this state was computed for: a different one means the schedule changed. */
  expression: string;
  recurring: boolean;
  /** false: paused (it does not fire until resumed). */
  enabled: boolean;
  /** Runs missed while the server was down: "once" runs one of them at startup, "none" skips them. Default "once". */
  catchUp?: ScheduleCatchUp;
  nextRunAt?: string;
  lastRunAt?: string;
  lastOutcome?: ScheduleOutcome;
  /** Why the last run failed or was skipped. */
  lastError?: string;
  /** Runs missed (not run) because the server was down, in total. */
  missedRuns?: number;
  /** When the latest missed run should have happened. */
  lastMissedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduleStore {
  getSchedule(missionId: string): Promise<ScheduleState | undefined>;
  listSchedules(): Promise<ScheduleState[]>;
  /** Insert or replace a mission's schedule state. */
  saveSchedule(state: ScheduleState): Promise<void>;
  /** false: there was none. */
  deleteSchedule(missionId: string): Promise<boolean>;
}

export interface LeaseStore {
  /**
   * Claim `key` for `owner` until `ttlMs` from now. True only for one caller while the claim lasts,
   * across processes sharing the storage; an expired claim can be taken again. The same owner
   * claiming again extends it.
   */
  tryClaim(key: string, owner: string, ttlMs: number): Promise<boolean>;
  /** Give a claim back early (only the owner's). */
  release(key: string, owner: string): Promise<void>;
  /** Forget claims expired before `before` (ISO); returns how many. */
  prune?(before: string): Promise<number>;
}

export interface TaskWatcherStore {
  listWatchers(): Promise<TaskWatcher[]>;
  saveWatcher(watcher: TaskWatcher): Promise<void>;
  deleteWatcher(id: string): Promise<boolean>;
}

/** A lease key for one occurrence of a schedule: idempotent by schedule and scheduled time. */
export function scheduleRunKey(missionId: string, scheduledFor: string): string {
  return `schedule:${missionId}@${scheduledFor}`;
}

export class InMemoryScheduleStore implements ScheduleStore {
  private readonly states = new Map<string, ScheduleState>();
  async getSchedule(missionId: string): Promise<ScheduleState | undefined> {
    const s = this.states.get(missionId);
    return s ? { ...s } : undefined;
  }
  async listSchedules(): Promise<ScheduleState[]> { return [...this.states.values()].map((s) => ({ ...s })); }
  async saveSchedule(state: ScheduleState): Promise<void> { this.states.set(state.missionId, { ...state }); }
  async deleteSchedule(missionId: string): Promise<boolean> { return this.states.delete(missionId); }
}

export class InMemoryLeaseStore implements LeaseStore {
  private readonly leases = new Map<string, { owner: string; expiresAt: number }>();
  async tryClaim(key: string, owner: string, ttlMs: number): Promise<boolean> {
    const now = Date.now();
    const current = this.leases.get(key);
    if (current && current.owner !== owner && current.expiresAt > now) return false;
    this.leases.set(key, { owner, expiresAt: now + ttlMs });
    return true;
  }
  async release(key: string, owner: string): Promise<void> {
    if (this.leases.get(key)?.owner === owner) this.leases.delete(key);
  }
  async prune(before: string): Promise<number> {
    const limit = Date.parse(before);
    let n = 0;
    for (const [key, lease] of this.leases) if (lease.expiresAt < limit) { this.leases.delete(key); n++; }
    return n;
  }
}

export class InMemoryTaskWatcherStore implements TaskWatcherStore {
  private readonly watchers = new Map<string, TaskWatcher>();
  async listWatchers(): Promise<TaskWatcher[]> { return [...this.watchers.values()].map((w) => ({ ...w })); }
  async saveWatcher(watcher: TaskWatcher): Promise<void> { this.watchers.set(watcher.id, { ...watcher }); }
  async deleteWatcher(id: string): Promise<boolean> { return this.watchers.delete(id); }
}
