import type { OrchestratorContext } from "./orchestrator-context.js";
import type { NotificationRouterPort } from "./notification-router-port.js";
import type { SLAConfig } from "./types.js";

/**
 * SLA Monitor — tracks deadlines on tasks and missions.
 *
 * Runs periodically (driven by the orchestrator tick) and emits:
 *   - sla:warning  — when a configurable % of the deadline has elapsed
 *   - sla:violated — when the deadline has passed
 *   - sla:met      — when an entity completes before its deadline
 *
 * Can optionally force-fail tasks that violate their SLA.
 */
export class SLAMonitor {
  private config: Required<SLAConfig>;
  private warned = new Set<string>();
  private violated = new Set<string>();
  private lastCheckMs = 0;
  private notificationRouter?: NotificationRouterPort;

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

  setNotificationRouter(router: NotificationRouterPort): void {
    this.notificationRouter = router;
  }

  init(): void {
    this.registerNotificationRules();
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

  async check(): Promise<void> {
    const now = Date.now();

    if (now - this.lastCheckMs < this.config.checkIntervalMs) return;
    this.lastCheckMs = now;

    const tasks = await this.ctx.registry.getAllTasks();
    for (const task of tasks) {
      if (!task.deadline) continue;
      if (task.status === "done" || task.status === "failed") continue;
      await this.checkEntity(task.id, "task", task.deadline, task.createdAt, now);
    }

    const missions = await this.ctx.registry.getAllMissions?.() ?? [];
    for (const mission of missions) {
      if (!mission.deadline) continue;
      if (mission.status === "completed" || mission.status === "failed" || mission.status === "cancelled" ||
          mission.status === "scheduled" || mission.status === "recurring") continue;
      await this.checkEntity(mission.id, "mission", mission.deadline, mission.createdAt, now);
    }
  }

  private async checkEntity(
    entityId: string,
    entityType: "task" | "mission",
    deadlineStr: string,
    createdAtStr: string,
    now: number,
  ): Promise<void> {
    const deadline = new Date(deadlineStr).getTime();
    const createdAt = new Date(createdAtStr).getTime();
    const totalBudget = deadline - createdAt;
    const elapsed = now - createdAt;
    const remaining = deadline - now;
    const percentUsed = totalBudget > 0 ? elapsed / totalBudget : 1;

    if (this.violated.has(entityId)) return;

    if (now > deadline) {
      this.violated.add(entityId);
      this.warned.add(entityId);

      this.ctx.emitter.emit("sla:violated", {
        entityId,
        entityType,
        deadline: deadlineStr,
        overdueMs: now - deadline,
      });

      if (this.config.violationAction === "fail" && entityType === "task") {
        try {
          await this.ctx.registry.unsafeSetStatus(entityId, "failed", "SLA violated — deadline exceeded");
        } catch { /* task may not exist or be in terminal state */ }
      }
      return;
    }

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

  clearEntity(entityId: string): void {
    this.warned.delete(entityId);
    this.violated.delete(entityId);
  }

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
