import type { OrchestratorContext } from "../core/orchestrator-context.js";
import type { ScheduleEntry, Mission } from "../core/types.js";
import { isCronExpression, nextCronOccurrence } from "./cron.js";

/**
 * Scheduler — tick-driven scheduling engine for missions.
 *
 * Missions can define:
 *  - `schedule`: a cron expression ("0 2 * * *") or ISO timestamp for one-shot
 *  - `recurring`: if true, re-execute on every cron tick (default: false = one-shot)
 *
 * The scheduler is checked on every orchestrator tick. It:
 *  1. Loads all missions with schedule definitions
 *  2. Computes next run times from cron expressions
 *  3. Triggers mission execution when the time arrives
 *  4. For recurring missions, resets after completion
 *  5. For one-shot missions, disables after first execution
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
   */
  init(): void {
    const missions = this.ctx.registry.getAllMissions?.() ?? [];
    for (const mission of missions) {
      if (mission.schedule && mission.status === "draft") {
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
      else if (!mission.recurring) {
        return null;
      }
    }

    const entry: ScheduleEntry = {
      id: `sched-${mission.id}`,
      missionId: mission.id,
      expression: mission.schedule,
      recurring: mission.recurring ?? false,
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

    // Only trigger draft or completed (for recurring) missions
    if (mission.status !== "draft" && mission.status !== "completed") {
      // Mission is active/failed/cancelled — skip this tick, will retry next
      return;
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
    try {
      if (this.executeMissionFn) {
        // For recurring missions on completed state, reset to draft first
        if (mission.status === "completed") {
          this.ctx.registry.updateMission?.(mission.id, { status: "draft" });
        }
        this.executeMissionFn(entry.missionId);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.ctx.emitter.emit("log", {
        level: "error",
        message: `[Scheduler] Failed to execute mission ${entry.missionId}: ${msg}`,
      });
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
