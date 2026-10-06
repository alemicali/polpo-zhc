import type { OrchestratorContext } from "./orchestrator-context.js";
import type { ScheduleEntry, Mission } from "./types.js";
import { isCronExpression, nextCronOccurrence } from "./cron.js";

/**
 * Scheduler — tick-driven scheduling engine for missions.
 *
 * Missions use dedicated statuses for scheduling:
 *  - `scheduled`: one-shot — waiting for the trigger time, then transitions to
 *     active. After completion the mission stays completed (schedule disabled).
 *     On failure it returns to `scheduled` for automatic retry.
 *  - `recurring`: recurring — fires on every cron tick, transitions to active,
 *     then returns to `recurring` after completion or failure.
 */
export class Scheduler {
  private schedules = new Map<string, ScheduleEntry>();
  private lastCheckMs = 0;
  private checkIntervalMs: number;
  private executeMissionFn?: (missionId: string) => void;
  private missionCompletedHandler?: (evt: { missionId: string }) => void;

  constructor(
    private ctx: OrchestratorContext,
    opts?: { checkIntervalMs?: number },
  ) {
    this.checkIntervalMs = opts?.checkIntervalMs ?? 30_000;
  }

  async init(): Promise<void> {
    const missions = await this.ctx.registry.getAllMissions?.() ?? [];
    const terminalStates = new Set(["completed", "cancelled", "draft"]);
    for (const mission of missions) {
      if (!mission.schedule) continue;
      if (terminalStates.has(mission.status)) continue;
      // Rehydration at startup, not a change: no event
      this.registerMission(mission, "none");
    }

    this.missionCompletedHandler = async ({ missionId }) => {
      const mission = await this.ctx.registry.getMission?.(missionId);
      if (!mission?.schedule) return;
      if (mission.status === "recurring" || mission.status === "scheduled") {
        this.registerMission(mission, "updated");
      }
    };
    this.ctx.emitter.on("mission:completed", this.missionCompletedHandler);
  }

  setExecutor(fn: (missionId: string) => void): void {
    this.executeMissionFn = fn;
  }

  /**
   * Schedule a mission (replacing its previous entry). `announce` picks the event: a new
   * schedule, a changed one, or none (startup rehydration).
   */
  registerMission(mission: Mission, announce: "created" | "updated" | "none" = "created"): ScheduleEntry | null {
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

    const entry: ScheduleEntry = {
      id: `sched-${mission.id}`,
      missionId: mission.id,
      expression: mission.schedule,
      recurring: isRecurring,
      enabled: true,
      nextRunAt,
      createdAt: new Date().toISOString(),
    };

    this.schedules.set(entry.id, entry);

    if (announce === "created") {
      this.ctx.emitter.emit("schedule:created", { scheduleId: entry.id, missionId: mission.id, nextRunAt });
    } else if (announce === "updated") {
      this.emitUpdated(entry);
    }

    return entry;
  }

  /** Re-schedule a mission whose schedule changed: one schedule:updated, or removed if it no longer runs. */
  rescheduleMission(mission: Mission): ScheduleEntry | null {
    const had = this.schedules.delete(`sched-${mission.id}`);
    const entry = this.registerMission(mission, had ? "updated" : "created");
    if (had && !entry) this.ctx.emitter.emit("schedule:removed", { scheduleId: `sched-${mission.id}`, missionId: mission.id });
    return entry;
  }

  /** Pause or resume a schedule without changing it. */
  setEnabled(missionId: string, enabled: boolean): ScheduleEntry | undefined {
    const entry = this.schedules.get(`sched-${missionId}`);
    if (!entry || entry.enabled === enabled) return entry;
    entry.enabled = enabled;
    this.emitUpdated(entry);
    return entry;
  }

  unregisterMission(missionId: string): boolean {
    const schedId = `sched-${missionId}`;
    const removed = this.schedules.delete(schedId);
    if (removed) this.ctx.emitter.emit("schedule:removed", { scheduleId: schedId, missionId });
    return removed;
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
    this.lastCheckMs = now;

    for (const [schedId, entry] of this.schedules) {
      if (!entry.enabled) continue;
      if (!entry.nextRunAt) continue;

      const nextRun = new Date(entry.nextRunAt).getTime();
      if (now < nextRun) continue;

      await this.triggerSchedule(schedId, entry);
    }
  }

  private async triggerSchedule(schedId: string, entry: ScheduleEntry): Promise<void> {
    const mission = await this.ctx.registry.getMission?.(entry.missionId);
    if (!mission) {
      entry.enabled = false;
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
      this.ctx.emitter.emit("schedule:skipped", { scheduleId: schedId, missionId: entry.missionId, reason: hookResult.cancelReason ?? "refused by a hook" });
      return;
    }

    this.ctx.emitter.emit("schedule:triggered", {
      scheduleId: schedId,
      missionId: entry.missionId,
      expression: entry.expression,
    });

    let executionFailed = false;
    try {
      if (this.executeMissionFn) {
        this.executeMissionFn(entry.missionId);
      }
    } catch (err) {
      executionFailed = true;
      const msg = err instanceof Error ? err.message : String(err);
      this.ctx.emitter.emit("log", {
        level: "error",
        message: `[Scheduler] Failed to execute mission ${entry.missionId}: ${msg}`,
      });
    }

    if (executionFailed && !entry.recurring) {
      return;
    }

    entry.lastRunAt = new Date().toISOString();

    if (entry.recurring && isCronExpression(entry.expression)) {
      const next = nextCronOccurrence(entry.expression, new Date());
      entry.nextRunAt = next?.toISOString();
    } else {
      entry.enabled = false;
      entry.nextRunAt = undefined;
    }

    this.ctx.emitter.emit("schedule:completed", {
      scheduleId: schedId,
      missionId: entry.missionId,
    });
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
    this.executeMissionFn = undefined;
  }
}
