import type { OrchestratorContext } from "./orchestrator-context.js";
import type { ScheduleEntry, Mission } from "./types.js";
import { isCronExpression, nextCronOccurrence } from "./cron.js";
import {
  InMemoryLeaseStore, InMemoryScheduleStore, scheduleRunKey,
  type LeaseStore, type ScheduleState, type ScheduleStore,
} from "./schedule-store.js";

/** At startup, a run due more than this long ago was missed (the server was down), not just late. */
export const MISSED_RUN_TOLERANCE_MS = 60_000;
/** A one-shot schedule missed while the server was down still runs at startup ("once") if at most this late. */
export const ONE_SHOT_CATCH_UP_GRACE_MS = 24 * 60 * 60_000;
/** How long the claim on one occurrence lasts (it outlives any restart that could fire it again). */
const RUN_CLAIM_TTL_MS = 7 * 24 * 60 * 60_000;
/** Most missed occurrences counted one by one. */
const MAX_COUNTED_MISSES = 10_000;

/**
 * Scheduler — tick-driven scheduling engine for missions.
 *
 * Missions use dedicated statuses for scheduling:
 *  - `scheduled`: one-shot — waiting for the trigger time, then transitions to
 *     active. After completion the mission stays completed (schedule disabled).
 *     On failure it returns to `scheduled` for automatic retry.
 *  - `recurring`: recurring — fires on every cron tick, transitions to active,
 *     then returns to `recurring` after completion or failure.
 *
 * What the mission does not hold — paused or not, next and last run, the last outcome, runs
 * missed while the server was down — is persisted in the {@link ScheduleStore}, so a restart
 * keeps it. Every occurrence is claimed in the {@link LeaseStore} before it fires (idempotent by
 * mission and scheduled time): two processes on the same storage, or a restart in the middle,
 * never fire it twice.
 */
export class Scheduler {
  private schedules = new Map<string, ScheduleEntry>();
  /** The entry being replaced by rescheduleMission (its pause and last run carry over). */
  private replacing = new Map<string, ScheduleEntry>();
  /** updatedAt of the state this process last wrote or read, per mission: newer in the store = changed elsewhere. */
  private stamps = new Map<string, string>();
  private lastCheckMs = 0;
  private checkIntervalMs: number;
  private checking = false;
  private writes: Promise<void> = Promise.resolve();
  private readonly store: ScheduleStore;
  private readonly leases: LeaseStore;
  private readonly owner = `scheduler-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
  private executeMissionFn?: (missionId: string) => unknown;
  private missionCompletedHandler?: (evt: { missionId: string; allPassed?: boolean }) => void;

  constructor(
    private ctx: OrchestratorContext,
    opts?: { checkIntervalMs?: number; store?: ScheduleStore; leases?: LeaseStore },
  ) {
    this.checkIntervalMs = opts?.checkIntervalMs ?? 30_000;
    this.store = opts?.store ?? ctx.scheduleStore ?? new InMemoryScheduleStore();
    this.leases = opts?.leases ?? ctx.leaseStore ?? new InMemoryLeaseStore();
  }

  async init(): Promise<void> {
    await this.flush();
    const missions = await this.ctx.registry.getAllMissions?.() ?? [];
    let states: ScheduleState[] = [];
    try {
      states = await this.store.listSchedules();
    } catch (err) {
      this.log("warn", `[Scheduler] Could not read the schedules' state: ${err instanceof Error ? err.message : String(err)}`);
    }
    const byMission = new Map(states.map((s) => [s.missionId, s]));
    const terminalStates = new Set(["completed", "cancelled", "draft"]);
    const scheduled = new Set<string>();
    for (const mission of missions) {
      if (!mission.schedule) continue;
      if (terminalStates.has(mission.status)) continue;
      scheduled.add(mission.id);
      // Rehydration at startup, not a change: no event
      this.restore(mission, byMission.get(mission.id));
    }
    // the state of a mission that no longer exists, or no longer runs on a schedule
    for (const s of states) if (!scheduled.has(s.missionId)) this.enqueue(() => this.store.deleteSchedule(s.missionId).then(() => undefined));
    await this.flush();

    if (!this.missionCompletedHandler) {
      this.missionCompletedHandler = async ({ missionId, allPassed }) => {
        const entry = this.schedules.get(`sched-${missionId}`);
        if (entry && allPassed !== undefined) {
          entry.lastOutcome = allPassed ? "completed" : "failed";
          if (allPassed) delete entry.lastError;
          this.persist(entry);
        }
        const mission = await this.ctx.registry.getMission?.(missionId);
        if (!mission?.schedule) return;
        if (mission.status === "recurring" || mission.status === "scheduled") {
          this.registerMission(mission, "updated");
        }
      };
      this.ctx.emitter.on("mission:completed", this.missionCompletedHandler);
    }
  }

  setExecutor(fn: (missionId: string) => unknown): void {
    this.executeMissionFn = fn;
  }

  /** Wait until every state change so far is in the store. */
  async flush(): Promise<void> {
    await this.writes;
  }

  /**
   * Back from storage at startup: paused stays paused, the next run stays where it was, and a run
   * missed while the server was down is caught up once or skipped (the schedule's `catchUp`).
   */
  private restore(mission: Mission, state: ScheduleState | undefined): void {
    if (!state || state.expression !== mission.schedule) {
      // new, or its expression changed while the state was written: computed again, keeping the pause
      if (state) this.replacing.set(mission.id, this.fromState(state));
      try {
        this.registerMission(mission, "none");
      } finally {
        this.replacing.delete(mission.id);
      }
      return;
    }
    const entry = this.fromState(state);
    entry.recurring = mission.status === "recurring";
    if (mission.owner) entry.owner = mission.owner;
    this.schedules.set(entry.id, entry);
    this.stamps.set(mission.id, state.updatedAt);
    // paused, nothing next, or the previous run still going (a late run, not a missed one)
    if (!entry.enabled || !entry.nextRunAt || mission.status === "active") return;
    const due = Date.parse(entry.nextRunAt);
    const now = Date.now();
    if (!(due < now - MISSED_RUN_TOLERANCE_MS)) return;

    // missed while down: every occurrence from the due one up to now
    const cron = isCronExpression(entry.expression);
    let latest = new Date(due);
    let previous: Date | undefined;
    let missed = 1;
    let next: Date | null = null;
    if (cron && entry.recurring) {
      for (;;) {
        next = nextCronOccurrence(entry.expression, latest);
        if (!next || next.getTime() > now || missed >= MAX_COUNTED_MISSES) break;
        previous = latest;
        latest = next;
        missed++;
      }
      if (next && next.getTime() <= now) next = nextCronOccurrence(entry.expression, new Date(now));
    }
    const policy = entry.catchUp ?? "once";
    // "once": the latest missed occurrence runs now, if it is at most one interval late
    const grace = cron && entry.recurring ? (next ? next.getTime() - latest.getTime() : 0) : ONE_SHOT_CATCH_UP_GRACE_MS;
    const catchUp = policy === "once" && now - latest.getTime() <= grace;
    const skipped = catchUp ? missed - 1 : missed;
    if (skipped > 0) {
      entry.missedRuns = (entry.missedRuns ?? 0) + skipped;
      entry.lastMissedAt = (catchUp ? previous ?? latest : latest).toISOString();
    }
    if (catchUp) {
      entry.nextRunAt = latest.toISOString();
    } else {
      entry.lastOutcome = "missed";
      if (cron && entry.recurring && next) {
        entry.nextRunAt = next.toISOString();
      } else {
        entry.nextRunAt = undefined;
        entry.enabled = false;
      }
    }
    if (skipped > 0) {
      this.ctx.emitter.emit("schedule:skipped", {
        scheduleId: entry.id, missionId: entry.missionId,
        reason: `missed ${skipped} run${skipped === 1 ? "" : "s"} while the server was down${catchUp ? "; the latest runs now" : ""}`,
      });
    }
    this.log("info", `[Scheduler] ${entry.missionId}: ${missed} run(s) missed while the server was down; ${catchUp ? `running the one of ${entry.nextRunAt} now` : `skipped (catchUp: ${policy})`}.`);
    this.persist(entry);
  }

  /**
   * Schedule a mission (replacing its previous entry). `announce` picks the event: a new
   * schedule, a changed one, or none (startup rehydration).
   */
  registerMission(mission: Mission, announce: "created" | "updated" | "none" = "created", opts?: { catchUp?: ScheduleEntry["catchUp"] }): ScheduleEntry | null {
    if (!mission.schedule) return null;

    const isRecurring = mission.status === "recurring";
    const isCron = isCronExpression(mission.schedule);
    const now = new Date();

    let nextRunAt: string | undefined;
    if (isCron) {
      const next = nextCronOccurrence(mission.schedule, now);
      nextRunAt = next?.toISOString();
    } else {
      const scheduled = new Date(mission.schedule);
      if (scheduled.getTime() > now.getTime()) {
        nextRunAt = scheduled.toISOString();
      } else if (!isRecurring) {
        return null;
      }
    }

    // re-registered (a run finished, the expression changed): a paused schedule stays paused,
    // and keeps its last run, outcome, missed runs and creation time
    const prev = this.schedules.get(`sched-${mission.id}`) ?? this.replacing.get(mission.id);
    const catchUp = opts?.catchUp ?? prev?.catchUp;
    const entry: ScheduleEntry = {
      id: `sched-${mission.id}`,
      missionId: mission.id,
      expression: mission.schedule,
      recurring: isRecurring,
      enabled: prev?.enabled ?? true,
      nextRunAt,
      ...(catchUp ? { catchUp } : {}),
      ...(prev?.lastRunAt ? { lastRunAt: prev.lastRunAt } : {}),
      ...(prev?.lastOutcome ? { lastOutcome: prev.lastOutcome } : {}),
      ...(prev?.lastError ? { lastError: prev.lastError } : {}),
      ...(prev?.missedRuns ? { missedRuns: prev.missedRuns } : {}),
      ...(prev?.lastMissedAt ? { lastMissedAt: prev.lastMissedAt } : {}),
      // the mission's owner owns its schedule: the runs' tasks are that member's work
      ...(mission.owner ? { owner: mission.owner } : {}),
      createdAt: prev?.createdAt ?? new Date().toISOString(),
    };

    this.schedules.set(entry.id, entry);
    this.persist(entry);

    if (announce === "created") {
      this.ctx.emitter.emit("schedule:created", { scheduleId: entry.id, missionId: mission.id, nextRunAt });
    } else if (announce === "updated") {
      this.emitUpdated(entry);
    }

    return entry;
  }

  /** Re-schedule a mission whose schedule changed: one schedule:updated, or removed if it no longer runs. */
  rescheduleMission(mission: Mission): ScheduleEntry | null {
    const prev = this.schedules.get(`sched-${mission.id}`);
    const had = this.schedules.delete(`sched-${mission.id}`);
    if (prev) this.replacing.set(mission.id, prev);
    let entry: ScheduleEntry | null;
    try {
      entry = this.registerMission(mission, had ? "updated" : "created");
    } finally {
      this.replacing.delete(mission.id);
    }
    if (had && !entry) {
      this.forget(mission.id);
      this.ctx.emitter.emit("schedule:removed", { scheduleId: `sched-${mission.id}`, missionId: mission.id });
    }
    return entry;
  }

  /**
   * Pause or resume a schedule without changing it (persisted: a restart keeps it). A resumed
   * schedule does not run what came due while it was paused: its next run is the next one from now.
   */
  setEnabled(missionId: string, enabled: boolean): ScheduleEntry | undefined {
    const entry = this.schedules.get(`sched-${missionId}`);
    if (!entry || entry.enabled === enabled) return entry;
    entry.enabled = enabled;
    if (enabled && entry.nextRunAt && Date.parse(entry.nextRunAt) <= Date.now() && entry.recurring && isCronExpression(entry.expression)) {
      entry.nextRunAt = nextCronOccurrence(entry.expression, new Date())?.toISOString();
    }
    this.persist(entry);
    this.emitUpdated(entry);
    return entry;
  }

  /** What to do with runs missed while the server was down (persisted). */
  setCatchUp(missionId: string, catchUp: NonNullable<ScheduleEntry["catchUp"]>): ScheduleEntry | undefined {
    const entry = this.schedules.get(`sched-${missionId}`);
    if (!entry || entry.catchUp === catchUp) return entry;
    entry.catchUp = catchUp;
    this.persist(entry);
    return entry;
  }

  /**
   * Run a scheduled mission now, out of turn: the next scheduled run stays as it is. Throws when
   * the mission has no schedule or nothing can execute it.
   */
  runNow(missionId: string): ScheduleEntry {
    const entry = this.schedules.get(`sched-${missionId}`);
    if (!entry) throw new Error(`No schedule for mission "${missionId}"`);
    if (!this.executeMissionFn) throw new Error("The scheduler cannot execute missions on this instance");
    this.ctx.emitter.emit("schedule:triggered", { scheduleId: entry.id, missionId, expression: entry.expression });
    entry.lastRunAt = new Date().toISOString();
    entry.lastOutcome = "started";
    delete entry.lastError;
    this.execute(entry);
    this.persist(entry);
    this.ctx.emitter.emit("schedule:completed", { scheduleId: entry.id, missionId });
    return entry;
  }

  unregisterMission(missionId: string): boolean {
    const schedId = `sched-${missionId}`;
    const removed = this.schedules.delete(schedId);
    this.forget(missionId);
    if (removed) this.ctx.emitter.emit("schedule:removed", { scheduleId: schedId, missionId });
    return removed;
  }

  private forget(missionId: string): void {
    this.stamps.delete(missionId);
    this.enqueue(() => this.store.deleteSchedule(missionId).then(() => undefined));
  }

  private emitUpdated(entry: ScheduleEntry): void {
    this.ctx.emitter.emit("schedule:updated", {
      scheduleId: entry.id, missionId: entry.missionId, expression: entry.expression, enabled: entry.enabled,
      ...(entry.nextRunAt ? { nextRunAt: entry.nextRunAt } : {}),
    });
  }

  async check(): Promise<void> {
    const now = Date.now();

    if (now - this.lastCheckMs < this.checkIntervalMs) return;
    if (this.checking) return;
    this.lastCheckMs = now;
    this.checking = true;
    try {
      await this.flush();
      await this.refresh();
      for (const [schedId, entry] of this.schedules) {
        if (!entry.enabled) continue;
        if (!entry.nextRunAt) continue;

        const nextRun = new Date(entry.nextRunAt).getTime();
        if (now < nextRun) continue;

        await this.triggerSchedule(schedId, entry);
      }
    } finally {
      this.checking = false;
    }
  }

  /**
   * Take what changed in the store since this process last wrote it (another process paused a
   * schedule, fired it, created one).
   */
  private async refresh(): Promise<void> {
    let states: ScheduleState[];
    try {
      states = await this.store.listSchedules();
    } catch {
      return;
    }
    for (const state of states) {
      const entry = this.schedules.get(`sched-${state.missionId}`);
      if (entry) {
        this.adopt(entry, state);
        continue;
      }
      // created by another process: run it here too (the claim keeps it to one run)
      const mission = await this.ctx.registry.getMission?.(state.missionId).catch(() => undefined);
      if (!mission?.schedule || mission.schedule !== state.expression) continue;
      if (mission.status !== "scheduled" && mission.status !== "recurring") continue;
      const created = this.fromState(state);
      created.recurring = mission.status === "recurring";
      if (mission.owner) created.owner = mission.owner;
      this.schedules.set(created.id, created);
      this.stamps.set(state.missionId, state.updatedAt);
    }
  }

  /** The store's state, when it is newer than what this process knows. */
  private adopt(entry: ScheduleEntry, state: ScheduleState): boolean {
    const stamp = this.stamps.get(entry.missionId);
    if (state.expression !== entry.expression || (stamp && state.updatedAt <= stamp)) return false;
    Object.assign(entry, {
      enabled: state.enabled,
      nextRunAt: state.nextRunAt,
      lastRunAt: state.lastRunAt,
      lastOutcome: state.lastOutcome,
      lastError: state.lastError,
      missedRuns: state.missedRuns,
      lastMissedAt: state.lastMissedAt,
      catchUp: state.catchUp,
    });
    for (const key of ["nextRunAt", "lastRunAt", "lastOutcome", "lastError", "missedRuns", "lastMissedAt", "catchUp"] as const) {
      if (entry[key] === undefined) delete entry[key];
    }
    this.stamps.set(entry.missionId, state.updatedAt);
    return true;
  }

  private async triggerSchedule(schedId: string, entry: ScheduleEntry): Promise<void> {
    // the store first: paused or fired by another process meanwhile
    const stored = await this.store.getSchedule(entry.missionId).catch(() => undefined);
    if (stored && this.adopt(entry, stored)) {
      if (!entry.enabled || !entry.nextRunAt || Date.parse(entry.nextRunAt) > Date.now()) return;
    }
    const scheduledFor = entry.nextRunAt!;

    const mission = await this.ctx.registry.getMission?.(entry.missionId);
    if (!mission) {
      entry.enabled = false;
      entry.lastOutcome = "skipped";
      entry.lastError = "mission not found";
      this.persist(entry);
      this.ctx.emitter.emit("schedule:skipped", { scheduleId: schedId, missionId: entry.missionId, reason: "mission not found" });
      return;
    }

    if (mission.status !== "scheduled" && mission.status !== "recurring") {
      return;
    }

    if (mission.endDate) {
      const endTime = new Date(mission.endDate).getTime();
      if (Date.now() >= endTime) {
        entry.enabled = false;
        entry.nextRunAt = undefined;
        entry.lastOutcome = "expired";
        this.persist(entry);
        await this.ctx.registry.updateMission?.(entry.missionId, { status: "completed" });
        this.ctx.emitter.emit("schedule:expired", {
          scheduleId: schedId,
          missionId: entry.missionId,
          endDate: mission.endDate,
        });
        this.ctx.emitter.emit("log", {
          level: "info",
          message: `[Scheduler] Mission ${entry.missionId} schedule expired (endDate: ${mission.endDate}). Transitioned to completed.`,
        });
        return;
      }
    }

    const hookResult = this.ctx.hooks.runBeforeSync("schedule:trigger", {
      scheduleId: schedId,
      missionId: entry.missionId,
      expression: entry.expression,
    });
    if (hookResult.cancelled) {
      const reason = hookResult.cancelReason ?? "refused by a hook";
      if (entry.lastOutcome !== "skipped" || entry.lastError !== reason) {
        entry.lastOutcome = "skipped";
        entry.lastError = reason;
        this.persist(entry);
      }
      this.ctx.emitter.emit("schedule:skipped", { scheduleId: schedId, missionId: entry.missionId, reason });
      return;
    }

    // one run per occurrence, whoever gets here first (another process, or this one before a restart)
    let claimed = false;
    try {
      claimed = await this.leases.tryClaim(scheduleRunKey(entry.missionId, scheduledFor), this.owner, RUN_CLAIM_TTL_MS);
    } catch (err) {
      this.log("warn", `[Scheduler] Could not claim the run of ${entry.missionId} at ${scheduledFor}: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (!claimed) {
      // already fired: move on to the next occurrence (the other process's state arrives with the next refresh)
      this.advance(entry);
      this.persist(entry);
      this.ctx.emitter.emit("schedule:skipped", { scheduleId: schedId, missionId: entry.missionId, reason: `the run of ${scheduledFor} was already started` });
      return;
    }

    this.ctx.emitter.emit("schedule:triggered", {
      scheduleId: schedId,
      missionId: entry.missionId,
      expression: entry.expression,
    });

    // the run and the next occurrence are stored before the mission starts
    entry.lastRunAt = new Date().toISOString();
    entry.lastOutcome = "started";
    delete entry.lastError;
    this.advance(entry);
    this.persist(entry);
    await this.flush();

    this.execute(entry);

    this.ctx.emitter.emit("schedule:completed", {
      scheduleId: schedId,
      missionId: entry.missionId,
    });
  }

  /** The next occurrence of a recurring cron; a one-shot is done. */
  private advance(entry: ScheduleEntry): void {
    if (entry.recurring && isCronExpression(entry.expression)) {
      const next = nextCronOccurrence(entry.expression, new Date());
      entry.nextRunAt = next?.toISOString();
    } else {
      entry.enabled = false;
      entry.nextRunAt = undefined;
    }
  }

  /** Start the mission; a failure to start is the run's outcome. */
  private execute(entry: ScheduleEntry): void {
    const fail = (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      entry.lastOutcome = "failed";
      entry.lastError = msg.slice(0, 500);
      this.persist(entry);
      this.ctx.emitter.emit("log", {
        level: "error",
        message: `[Scheduler] Failed to execute mission ${entry.missionId}: ${msg}`,
      });
    };
    try {
      const result = this.executeMissionFn?.(entry.missionId);
      if (result && typeof (result as Promise<unknown>).then === "function") (result as Promise<unknown>).then(undefined, fail);
    } catch (err) {
      fail(err);
    }
  }

  private fromState(state: ScheduleState): ScheduleEntry {
    return {
      id: `sched-${state.missionId}`,
      missionId: state.missionId,
      expression: state.expression,
      recurring: state.recurring,
      enabled: state.enabled,
      ...(state.nextRunAt ? { nextRunAt: state.nextRunAt } : {}),
      ...(state.lastRunAt ? { lastRunAt: state.lastRunAt } : {}),
      ...(state.catchUp ? { catchUp: state.catchUp } : {}),
      ...(state.lastOutcome ? { lastOutcome: state.lastOutcome } : {}),
      ...(state.lastError ? { lastError: state.lastError } : {}),
      ...(state.missedRuns ? { missedRuns: state.missedRuns } : {}),
      ...(state.lastMissedAt ? { lastMissedAt: state.lastMissedAt } : {}),
      createdAt: state.createdAt,
    };
  }

  /** Write the entry's state (in order, in the background; {@link flush} waits for it). */
  private persist(entry: ScheduleEntry): void {
    const updatedAt = new Date().toISOString();
    const stamp = this.stamps.get(entry.missionId);
    // strictly increasing per mission, so a newer write is always seen as newer
    const at = stamp && updatedAt <= stamp ? new Date(Date.parse(stamp) + 1).toISOString() : updatedAt;
    this.stamps.set(entry.missionId, at);
    const state: ScheduleState = {
      missionId: entry.missionId,
      expression: entry.expression,
      recurring: entry.recurring,
      enabled: entry.enabled,
      ...(entry.catchUp ? { catchUp: entry.catchUp } : {}),
      ...(entry.nextRunAt ? { nextRunAt: entry.nextRunAt } : {}),
      ...(entry.lastRunAt ? { lastRunAt: entry.lastRunAt } : {}),
      ...(entry.lastOutcome ? { lastOutcome: entry.lastOutcome } : {}),
      ...(entry.lastError ? { lastError: entry.lastError } : {}),
      ...(entry.missedRuns ? { missedRuns: entry.missedRuns } : {}),
      ...(entry.lastMissedAt ? { lastMissedAt: entry.lastMissedAt } : {}),
      createdAt: entry.createdAt,
      updatedAt: at,
    };
    this.enqueue(() => this.store.saveSchedule(state));
  }

  private enqueue(write: () => Promise<void>): void {
    this.writes = this.writes.then(write).catch((err) => {
      this.log("warn", `[Scheduler] Could not save a schedule's state: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  private log(level: "info" | "warn", message: string): void {
    this.ctx.emitter.emit("log", { level, message });
  }

  getSchedule(scheduleId: string): ScheduleEntry | undefined {
    return this.schedules.get(scheduleId);
  }

  getScheduleByMissionId(missionId: string): ScheduleEntry | undefined {
    return this.schedules.get(`sched-${missionId}`);
  }

  getAllSchedules(): ScheduleEntry[] {
    return [...this.schedules.values()];
  }

  getActiveSchedules(): ScheduleEntry[] {
    return [...this.schedules.values()].filter(s => s.enabled);
  }

  dispose(): void {
    if (this.missionCompletedHandler) {
      this.ctx.emitter.off("mission:completed", this.missionCompletedHandler);
      this.missionCompletedHandler = undefined;
    }
    this.schedules.clear();
    this.stamps.clear();
    this.executeMissionFn = undefined;
  }
}
