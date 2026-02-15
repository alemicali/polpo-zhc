import type { OrchestratorContext } from "../core/orchestrator-context.js";
import type { ScheduleEntry, Plan } from "../core/types.js";
import { isCronExpression, nextCronOccurrence } from "./cron.js";

/**
 * Scheduler — tick-driven scheduling engine for plans.
 *
 * Plans can define:
 *  - `schedule`: a cron expression ("0 2 * * *") or ISO timestamp for one-shot
 *  - `recurring`: if true, re-execute on every cron tick (default: false = one-shot)
 *
 * The scheduler is checked on every orchestrator tick. It:
 *  1. Loads all plans with schedule definitions
 *  2. Computes next run times from cron expressions
 *  3. Triggers plan execution when the time arrives
 *  4. For recurring plans, resets after completion
 *  5. For one-shot plans, disables after first execution
 *
 * Schedule entries are kept in-memory — rebuilt on init from plan definitions.
 */
export class Scheduler {
  /** In-memory schedule registry */
  private schedules = new Map<string, ScheduleEntry>();
  private lastCheckMs = 0;
  private checkIntervalMs: number;
  /** Callback to execute a plan — injected to avoid circular dependency with PlanExecutor */
  private executePlanFn?: (planId: string) => void;

  constructor(
    private ctx: OrchestratorContext,
    opts?: { checkIntervalMs?: number },
  ) {
    this.checkIntervalMs = opts?.checkIntervalMs ?? 30_000;
  }

  /**
   * Initialize: scan all plans for schedule definitions and build the schedule registry.
   */
  init(): void {
    const plans = this.ctx.registry.getAllPlans?.() ?? [];
    for (const plan of plans) {
      if (plan.schedule && plan.status === "draft") {
        this.registerPlan(plan);
      }
    }
  }

  /**
   * Set the plan execution callback.
   * Called by the orchestrator after PlanExecutor is initialized.
   */
  setExecutor(fn: (planId: string) => void): void {
    this.executePlanFn = fn;
  }

  /**
   * Register or update a schedule for a plan.
   */
  registerPlan(plan: Plan): ScheduleEntry | null {
    if (!plan.schedule) return null;

    const isCron = isCronExpression(plan.schedule);
    const now = new Date();

    let nextRunAt: string | undefined;
    if (isCron) {
      const next = nextCronOccurrence(plan.schedule, now);
      nextRunAt = next?.toISOString();
    } else {
      // ISO timestamp — one-shot
      const scheduled = new Date(plan.schedule);
      if (scheduled.getTime() > now.getTime()) {
        nextRunAt = scheduled.toISOString();
      }
      // If the timestamp is in the past and plan is not recurring, skip
      else if (!plan.recurring) {
        return null;
      }
    }

    const entry: ScheduleEntry = {
      id: `sched-${plan.id}`,
      planId: plan.id,
      expression: plan.schedule,
      recurring: plan.recurring ?? false,
      enabled: true,
      nextRunAt,
      createdAt: new Date().toISOString(),
    };

    this.schedules.set(entry.id, entry);

    this.ctx.emitter.emit("schedule:created", {
      scheduleId: entry.id,
      planId: plan.id,
      nextRunAt,
    });

    return entry;
  }

  /**
   * Remove a schedule for a plan.
   */
  unregisterPlan(planId: string): boolean {
    const schedId = `sched-${planId}`;
    return this.schedules.delete(schedId);
  }

  /**
   * Main check — called from the orchestrator tick loop.
   * Checks all active schedules and triggers plans that are due.
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
    // Check plan still exists and is in a triggerable state
    const plan = this.ctx.registry.getPlan?.(entry.planId);
    if (!plan) {
      entry.enabled = false;
      return;
    }

    // Only trigger draft or completed (for recurring) plans
    if (plan.status !== "draft" && plan.status !== "completed") {
      // Plan is active/failed/cancelled — skip this tick, will retry next
      return;
    }

    // Run before hook — allows cancellation
    const hookResult = this.ctx.hooks.runBeforeSync("schedule:trigger", {
      scheduleId: schedId,
      planId: entry.planId,
      expression: entry.expression,
    });
    if (hookResult.cancelled) {
      return;
    }

    // Emit trigger event
    this.ctx.emitter.emit("schedule:triggered", {
      scheduleId: schedId,
      planId: entry.planId,
      expression: entry.expression,
    });

    // Execute the plan
    try {
      if (this.executePlanFn) {
        // For recurring plans on completed state, reset to draft first
        if (plan.status === "completed") {
          this.ctx.registry.updatePlan?.(plan.id, { status: "draft" });
        }
        this.executePlanFn(entry.planId);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.ctx.emitter.emit("log", {
        level: "error",
        message: `[Scheduler] Failed to execute plan ${entry.planId}: ${msg}`,
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
      planId: entry.planId,
    });
  }

  // ─── Accessors ─────────────────────────────────────

  getSchedule(scheduleId: string): ScheduleEntry | undefined {
    return this.schedules.get(scheduleId);
  }

  getScheduleByPlanId(planId: string): ScheduleEntry | undefined {
    return this.schedules.get(`sched-${planId}`);
  }

  getAllSchedules(): ScheduleEntry[] {
    return [...this.schedules.values()];
  }

  getActiveSchedules(): ScheduleEntry[] {
    return [...this.schedules.values()].filter(s => s.enabled);
  }

  dispose(): void {
    this.schedules.clear();
    this.executePlanFn = undefined;
  }
}
