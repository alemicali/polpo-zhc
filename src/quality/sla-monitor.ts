import type { OrchestratorContext } from "../core/orchestrator-context.js";
import type { NotificationRouter } from "../notifications/index.js";
import type { SLAConfig, Task, Plan } from "../core/types.js";

/**
 * SLA Monitor — tracks deadlines on tasks and plans.
 *
 * Runs periodically (driven by the orchestrator tick) and emits:
 *   - sla:warning  — when a configurable % of the deadline has elapsed
 *   - sla:violated — when the deadline has passed
 *   - sla:met      — when an entity completes before its deadline
 *
 * Can optionally force-fail tasks that violate their SLA.
 * When warningChannels/violationChannels are configured, registers dynamic
 * notification rules to route SLA events to those specific channels.
 */
export class SLAMonitor {
  private config: Required<SLAConfig>;
  private warned = new Set<string>();    // entity IDs already warned
  private violated = new Set<string>();  // entity IDs already violated
  private lastCheckMs = 0;
  private notificationRouter?: NotificationRouter;

  constructor(
    private ctx: OrchestratorContext,
    slaConfig?: SLAConfig,
  ) {
    this.config = {
      warningThreshold: slaConfig?.warningThreshold ?? 0.8,
      checkIntervalMs: slaConfig?.checkIntervalMs ?? 30_000,
      warningChannels: slaConfig?.warningChannels ?? [],
      violationChannels: slaConfig?.violationChannels ?? [],
      violationAction: slaConfig?.violationAction ?? "notify",
    };
  }

  /**
   * Set the notification router — enables SLA channel routing.
   * Called by the orchestrator after both SLAMonitor and NotificationRouter are initialized.
   */
  setNotificationRouter(router: NotificationRouter): void {
    this.notificationRouter = router;
  }

  /**
   * Initialize: register hooks and notification rules for SLA channels.
   */
  init(): void {
    // Register dynamic notification rules for SLA channels
    this.registerNotificationRules();
    // Detect SLA met when task/plan completes
    this.ctx.hooks.register({
      hook: "task:complete",
      phase: "after",
      priority: 200,
      name: "sla-monitor:met",
      handler: (hookCtx) => {
        const { taskId, task } = hookCtx.data;
        if (task?.deadline) {
          const deadline = new Date(task.deadline).getTime();
          const now = Date.now();
          if (now <= deadline) {
            this.ctx.emitter.emit("sla:met", {
              entityId: taskId,
              entityType: "task",
              deadline: task.deadline,
              marginMs: deadline - now,
            });
          }
          this.warned.delete(taskId);
          this.violated.delete(taskId);
        }
      },
    });
  }

  /**
   * Check all active tasks and plans for SLA status.
   * Called from the orchestrator tick loop (or on a timer).
   */
  check(): void {
    const now = Date.now();

    // Throttle checks
    if (now - this.lastCheckMs < this.config.checkIntervalMs) return;
    this.lastCheckMs = now;

    // Check tasks
    const tasks = this.ctx.registry.getAllTasks();
    for (const task of tasks) {
      if (!task.deadline) continue;
      if (task.status === "done" || task.status === "failed") continue;

      this.checkEntity(task.id, "task", task.deadline, task.createdAt, now);
    }

    // Check plans
    const plans = this.ctx.registry.getAllPlans?.() ?? [];
    for (const plan of plans) {
      if (!plan.deadline) continue;
      if (plan.status === "completed" || plan.status === "failed" || plan.status === "cancelled") continue;

      this.checkEntity(plan.id, "plan", plan.deadline, plan.createdAt, now);
    }
  }

  private checkEntity(
    entityId: string,
    entityType: "task" | "plan",
    deadlineStr: string,
    createdAtStr: string,
    now: number,
  ): void {
    const deadline = new Date(deadlineStr).getTime();
    const createdAt = new Date(createdAtStr).getTime();
    const totalBudget = deadline - createdAt;
    const elapsed = now - createdAt;
    const remaining = deadline - now;
    const percentUsed = totalBudget > 0 ? elapsed / totalBudget : 1;

    // Already violated
    if (this.violated.has(entityId)) return;

    // Check violation (deadline passed)
    if (now > deadline) {
      this.violated.add(entityId);
      this.warned.add(entityId);

      this.ctx.emitter.emit("sla:violated", {
        entityId,
        entityType,
        deadline: deadlineStr,
        overdueMs: now - deadline,
      });

      // Optionally force-fail the task
      if (this.config.violationAction === "fail" && entityType === "task") {
        try {
          this.ctx.registry.unsafeSetStatus(entityId, "failed", "SLA violated — deadline exceeded");
        } catch { /* task may not exist or be in terminal state */ }
      }
      return;
    }

    // Check warning threshold
    if (!this.warned.has(entityId) && percentUsed >= this.config.warningThreshold) {
      this.warned.add(entityId);

      this.ctx.emitter.emit("sla:warning", {
        entityId,
        entityType,
        deadline: deadlineStr,
        elapsed,
        remaining,
        percentUsed,
      });
    }
  }

  /**
   * Clear tracking for an entity (e.g. when retried or deleted).
   */
  clearEntity(entityId: string): void {
    this.warned.delete(entityId);
    this.violated.delete(entityId);
  }

  /**
   * Register dynamic notification rules for SLA warning/violation channels.
   * This wires up SLAConfig.warningChannels and violationChannels to the
   * notification system so SLA events are actually routed to those channels.
   */
  private registerNotificationRules(): void {
    if (!this.notificationRouter) return;

    if (this.config.warningChannels.length > 0) {
      this.notificationRouter.addRule({
        id: "sla-auto-warning",
        name: "SLA Warning (auto-registered)",
        events: ["sla:warning"],
        channels: this.config.warningChannels,
        severity: "warning",
      });
    }

    if (this.config.violationChannels.length > 0) {
      this.notificationRouter.addRule({
        id: "sla-auto-violated",
        name: "SLA Violation (auto-registered)",
        events: ["sla:violated"],
        channels: this.config.violationChannels,
        severity: "critical",
      });

      // Also route sla:met to violation channels (good news to the same audience)
      this.notificationRouter.addRule({
        id: "sla-auto-met",
        name: "SLA Met (auto-registered)",
        events: ["sla:met"],
        channels: this.config.violationChannels,
        severity: "info",
      });
    }
  }

  dispose(): void {
    this.warned.clear();
    this.violated.clear();
  }
}
