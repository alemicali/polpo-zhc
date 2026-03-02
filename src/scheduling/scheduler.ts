import type { OrchestratorContext } from "../core/orchestrator-context.js";
import type { ScheduleEntry, Mission } from "../core/types.js";
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
 *
 * The `mission.schedule` field holds the cron expression or ISO timestamp.
 * The mission status itself encodes whether it's one-shot or recurring.
 *
 * Schedule entries are kept in-memory — rebuilt on init from mission definitions.
 */
export class Scheduler {
  /** In-memory schedule registry */
  private schedules = new Map<string, ScheduleEntry>();
  private lastCheckMs = 0;
  private checkIntervalMs: number;
  /** Callback to execute a mission — injected to avoid circular dependency with MissionExecutor */
  private executeMissionFn?: (missionId: string) => void;

  constructor(
    private ctx: OrchestratorContext,
    opts?: { checkIntervalMs?: number },
  ) {
    this.checkIntervalMs = opts?.checkIntervalMs ?? 30_000;
  }

  /**
   * Initialize: scan all missions for schedule definitions and build the schedule registry.
   * Registers missions that are schedulable:
   *  - scheduled: one-shot waiting for trigger
   *  - recurring: waiting for next scheduled run (any non-active state)
   */
  init(): void {
    const missions = this.ctx.registry.getAllMissions?.() ?? [];
    for (const mission of missions) {
      if (!mission.schedule) continue;
      if (mission.status === "scheduled" || mission.status === "recurring") {
        this.registerMission(mission);
      }
    }
  }

  /**
   * Set the mission execution callback.
   * Called by the orchestrator after MissionExecutor is initialized.
   */
  setExecutor(fn: (missionId: string) => void): void {
    this.executeMissionFn = fn;
  }

  /**
   * Register or update a schedule for a mission.
   */
  registerMission(mission: Mission): ScheduleEntry | null {
    if (!mission.schedule) return null;

    const isRecurring = mission.status === "recurring";
    const isCron = isCronExpression(mission.schedule);
    const now = new Date();

    let nextRunAt: string | undefined;
    if (isCron) {
      const next = nextCronOccurrence(mission.schedule, now);
      nextRunAt = next?.toISOString();
    } else {
      // ISO timestamp — one-shot
      const scheduled = new Date(mission.schedule);
      if (scheduled.getTime() > now.getTime()) {
        nextRunAt = scheduled.toISOString();
      }
      // If the timestamp is in the past and mission is not recurring, skip
      else if (!isRecurring) {
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

    this.ctx.emitter.emit("schedule:created", {
      scheduleId: entry.id,
      missionId: mission.id,
      nextRunAt,
    });

    return entry;
  }

  /**
   * Remove a schedule for a mission.
   */
  unregisterMission(missionId: string): boolean {
    const schedId = `sched-${missionId}`;
    return this.schedules.delete(schedId);
  }

  /**
   * Main check — called from the orchestrator tick loop.
   * Checks all active schedules and triggers missions that are due.
   */
  check(): void {
    const now = Date.now();

    // Throttle checks
    if (now - this.lastCheckMs < this.checkIntervalMs) return;
    this.lastCheckMs = now;

    for (const [schedId, entry] of this.schedules) {
      if (!entry.enabled) continue;
      if (!entry.nextRunAt) continue;

      const nextRun = new Date(entry.nextRunAt).getTime();
      if (now < nextRun) continue;

      // Time to trigger!
      this.triggerSchedule(schedId, entry);
    }
  }

  private triggerSchedule(schedId: string, entry: ScheduleEntry): void {
    // Check mission still exists and is in a triggerable state
    const mission = this.ctx.registry.getMission?.(entry.missionId);
    if (!mission) {
      entry.enabled = false;
      return;
    }

    // Triggerable states: only `scheduled` and `recurring`
    // Everything else (active, paused, draft, completed, failed, cancelled) — skip
    if (mission.status !== "scheduled" && mission.status !== "recurring") {
      return;
    }

    // Check endDate — if past, disable schedule and complete the mission
    if (mission.endDate) {
      const endTime = new Date(mission.endDate).getTime();
      if (Date.now() >= endTime) {
        entry.enabled = false;
        entry.nextRunAt = undefined;
        this.ctx.registry.updateMission?.(entry.missionId, { status: "completed" });
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

    // Run before hook — allows cancellation
    const hookResult = this.ctx.hooks.runBeforeSync("schedule:trigger", {
      scheduleId: schedId,
      missionId: entry.missionId,
      expression: entry.expression,
    });
    if (hookResult.cancelled) {
      return;
    }

    // Emit trigger event
    this.ctx.emitter.emit("schedule:triggered", {
      scheduleId: schedId,
      missionId: entry.missionId,
      expression: entry.expression,
    });

    // Execute the mission
    // executeMission now accepts scheduled/recurring status directly
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

    // If execution failed, don't update schedule timing for one-shot —
    // it should be retried on the next check, not permanently disabled
    if (executionFailed && !entry.recurring) {
      return;
    }

    // Update schedule entry
    entry.lastRunAt = new Date().toISOString();

    if (entry.recurring && isCronExpression(entry.expression)) {
      // Calculate next occurrence
      const next = nextCronOccurrence(entry.expression, new Date());
      entry.nextRunAt = next?.toISOString();
    } else {
      // One-shot: disable after execution
      entry.enabled = false;
      entry.nextRunAt = undefined;
    }

    // Emit completion event
    this.ctx.emitter.emit("schedule:completed", {
      scheduleId: schedId,
      missionId: entry.missionId,
    });
  }

  // ─── Accessors ─────────────────────────────────────

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
    this.schedules.clear();
    this.executeMissionFn = undefined;
  }
}
