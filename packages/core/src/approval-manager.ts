import { nanoid } from "nanoid";
import type { OrchestratorContext } from "./orchestrator-context.js";
import type { ApprovalStore } from "./approval-store.js";
import type { ApprovalGate, ApprovalRequest, ApprovalStatus } from "./types.js";
import type { LifecycleHook } from "./hooks.js";
import type { NotificationRouterPort } from "./notification-router-port.js";

/**
 * Manages approval gates — both automatic (condition-based) and human (blocking).
 *
 * Automatic gates evaluate a condition against the hook payload and either
 * allow or block the operation immediately.
 *
 * Human gates pause the operation (task enters "awaiting_approval"),
 * emit a notification event, and wait for external resolution (API call,
 * TUI action, or timeout).
 */
export class ApprovalManager {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private notificationRouter?: NotificationRouterPort;
  private registeredGateRules = new Set<string>();

  constructor(
    private ctx: OrchestratorContext,
    private store: ApprovalStore,
  ) {}

  /** Wire the notification router so per-gate notifyChannels work. */
  setNotificationRouter(router: NotificationRouterPort): void {
    this.notificationRouter = router;

    const gates = this.ctx.config.settings.approvalGates;
    if (gates) {
      for (const gate of gates) {
        this.ensureGateNotificationRules(gate);
      }
    }
  }

  /** Initialize: register hooks for all configured approval gates. */
  init(): void {
    const gates = this.ctx.config.settings.approvalGates;
    if (!gates || gates.length === 0) return;

    for (const gate of gates) {
      this.registerGate(gate);
    }

    // Resume any pending approval timeouts from previous session
    const pending = this.store.list("pending");
    for (const req of pending) {
      const gate = gates.find(g => g.id === req.gateId);
      if (gate?.timeoutMs && gate.timeoutMs > 0) {
        const elapsed = Date.now() - new Date(req.requestedAt).getTime();
        const remaining = gate.timeoutMs - elapsed;
        if (remaining <= 0) {
          this.resolveTimeout(req, gate);
        } else {
          this.startTimer(req.id, remaining, gate);
        }
      }
    }
  }

  private ensureGateNotificationRules(gate: ApprovalGate): void {
    if (!this.notificationRouter) return;
    if (!gate.notifyChannels || gate.notifyChannels.length === 0) return;
    if (this.registeredGateRules.has(gate.id)) return;

    this.registeredGateRules.add(gate.id);

    this.notificationRouter.addRule({
      id: `approval-req-${gate.id}`,
      name: `Approval "${gate.name}" Requested (auto)`,
      events: ["approval:requested"],
      condition: { field: "gateId", op: "==", value: gate.id },
      channels: gate.notifyChannels,
      severity: "warning",
      includeOutcomes: gate.includeOutcomes,
      outcomeFilter: ["media", "file"],
      maxAttachmentSize: 10 * 1024 * 1024,
    });

    this.notificationRouter.addRule({
      id: `approval-res-${gate.id}`,
      name: `Approval "${gate.name}" Resolved (auto)`,
      events: ["approval:resolved"],
      channels: gate.notifyChannels,
      severity: "info",
    });

    this.notificationRouter.addRule({
      id: `approval-timeout-${gate.id}`,
      name: `Approval "${gate.name}" Timed Out (auto)`,
      events: ["approval:timeout"],
      channels: gate.notifyChannels,
      severity: "critical",
    });
  }

  private registerGate(gate: ApprovalGate): void {
    const hook = gate.hook as LifecycleHook;

    this.ensureGateNotificationRules(gate);

    this.ctx.hooks.register({
      hook,
      phase: "before",
      priority: gate.priority ?? 50,
      name: `approval-gate:${gate.name}`,
      handler: (ctx) => {
        if (gate.condition?.expression) {
          const matches = this.evaluateCondition(gate.condition.expression, ctx.data);
          if (!matches) return;
        }

        if (gate.handler === "auto") {
          if (gate.condition?.expression) {
            ctx.cancel(`Auto gate "${gate.name}" condition matched — blocking`);
          }
          return;
        }

        const request = this.createRequest(gate, ctx.data);
        ctx.cancel(`Awaiting human approval: ${gate.name} (request: ${request.id})`);

        const taskId = this.extractTaskId(ctx.data);
        if (taskId) {
          try {
            this.ctx.registry.transition(taskId, "awaiting_approval");
          } catch { /* Task may already be in a state that doesn't allow this transition */ }
        }

        this.ctx.emitter.emit("approval:requested", {
          requestId: request.id,
          gateId: gate.id,
          gateName: gate.name,
          taskId: request.taskId,
          missionId: request.missionId,
        });

        if (gate.timeoutMs && gate.timeoutMs > 0) {
          this.startTimer(request.id, gate.timeoutMs, gate);
        }
      },
    });
  }

  private createRequest(gate: ApprovalGate, payload: unknown): ApprovalRequest {
    const request: ApprovalRequest = {
      id: nanoid(),
      gateId: gate.id,
      gateName: gate.name,
      taskId: this.extractTaskId(payload),
      missionId: this.extractMissionId(payload),
      status: "pending",
      payload,
      requestedAt: new Date().toISOString(),
    };
    this.store.upsert(request);
    return request;
  }

  approve(requestId: string, resolvedBy?: string, note?: string): ApprovalRequest | null {
    return this.resolve(requestId, "approved", resolvedBy, note);
  }

  reject(requestId: string, feedback: string, resolvedBy?: string): ApprovalRequest | null {
    const request = this.store.get(requestId);
    if (!request || request.status !== "pending") return null;
    if (!request.taskId) return null;

    const gate = this.ctx.config.settings.approvalGates?.find(g => g.id === request.gateId);
    const maxRevisions = gate?.maxRevisions ?? 3;
    const task = this.ctx.registry.getTask(request.taskId);
    if (!task) return null;

    const currentCount = task.revisionCount ?? 0;
    if (currentCount >= maxRevisions) return null;

    request.status = "rejected";
    request.resolvedAt = new Date().toISOString();
    request.resolvedBy = resolvedBy ?? "user";
    request.note = feedback;
    this.store.upsert(request);

    this.clearTimer(requestId);

    const newCount = currentCount + 1;
    this.ctx.registry.updateTask(request.taskId, { revisionCount: newCount });

    const separator = "\n\n---\n";
    const feedbackBlock = `**Rejection #${newCount} feedback:** ${feedback}`;
    const updatedDescription = task.description + separator + feedbackBlock;
    this.ctx.registry.updateTask(request.taskId, { description: updatedDescription });

    this.ctx.emitter.emit("approval:rejected", {
      requestId,
      taskId: request.taskId,
      feedback,
      rejectionCount: newCount,
      resolvedBy: request.resolvedBy,
    });

    this.ctx.registry.updateTask(request.taskId, { outcomes: [] });

    try {
      this.ctx.registry.transition(request.taskId, "pending");
    } catch { /* Task may have been modified externally */ }

    return request;
  }

  canReject(requestId: string): { allowed: boolean; rejectionCount: number; maxRejections: number } {
    const request = this.store.get(requestId);
    if (!request || request.status !== "pending" || !request.taskId) {
      return { allowed: false, rejectionCount: 0, maxRejections: 0 };
    }

    const gate = this.ctx.config.settings.approvalGates?.find(g => g.id === request.gateId);
    const maxRejections = gate?.maxRevisions ?? 3;
    const task = this.ctx.registry.getTask(request.taskId);
    const currentCount = task?.revisionCount ?? 0;

    return { allowed: currentCount < maxRejections, rejectionCount: currentCount, maxRejections };
  }

  private resolve(
    requestId: string,
    status: "approved" | "rejected",
    resolvedBy?: string,
    note?: string,
  ): ApprovalRequest | null {
    const request = this.store.get(requestId);
    if (!request || request.status !== "pending") return null;

    request.status = status;
    request.resolvedAt = new Date().toISOString();
    request.resolvedBy = resolvedBy ?? "user";
    request.note = note;
    this.store.upsert(request);

    this.clearTimer(requestId);

    this.ctx.emitter.emit("approval:resolved", {
      requestId,
      status,
      resolvedBy: request.resolvedBy,
    });

    if (request.taskId) {
      try {
        if (status === "approved") {
          const gate = this.ctx.config.settings.approvalGates?.find(g => g.id === request.gateId);
          const targetStatus = gate?.hook === "task:complete" ? "done" : "assigned";
          this.ctx.registry.transition(request.taskId, targetStatus as any);
        } else {
          this.ctx.registry.transition(request.taskId, "failed");
        }
      } catch { /* Task may have been modified externally */ }
    }

    return request;
  }

  private resolveTimeout(request: ApprovalRequest, gate: ApprovalGate): void {
    if (request.status !== "pending") return;

    const action = gate.timeoutAction ?? "reject";
    request.status = "timeout";
    request.resolvedAt = new Date().toISOString();
    request.resolvedBy = "timeout";
    this.store.upsert(request);

    this.ctx.emitter.emit("approval:timeout", {
      requestId: request.id,
      action,
    });

    if (request.taskId) {
      try {
        if (action === "approve") {
          this.ctx.registry.transition(request.taskId, "assigned");
        } else {
          this.ctx.registry.transition(request.taskId, "failed");
        }
      } catch { /* Task may have been modified externally */ }
    }
  }

  getPending(): ApprovalRequest[] {
    return this.store.list("pending");
  }

  getAll(status?: ApprovalStatus): ApprovalRequest[] {
    return this.store.list(status);
  }

  getRequest(id: string): ApprovalRequest | undefined {
    return this.store.get(id);
  }

  // ─── Helpers ───────────────────────────────────────

  private startTimer(requestId: string, ms: number, gate: ApprovalGate): void {
    const timer = setTimeout(() => {
      const request = this.store.get(requestId);
      if (request) this.resolveTimeout(request, gate);
      this.timers.delete(requestId);
    }, ms);
    this.timers.set(requestId, timer);
  }

  private clearTimer(requestId: string): void {
    const timer = this.timers.get(requestId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(requestId);
    }
  }

  private evaluateCondition(expression: string, data: unknown): boolean {
    try {
      const fn = new Function("data", "task", "mission", `try { return !!(${expression}); } catch { return false; }`);
      const taskData = this.isRecord(data) ? (data as Record<string, unknown>).task : undefined;
      const missionData = this.isRecord(data) ? (data as Record<string, unknown>).mission : undefined;
      return fn(data, taskData, missionData) === true;
    } catch {
      return false;
    }
  }

  private isRecord(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null;
  }

  private extractTaskId(data: unknown): string | undefined {
    if (!this.isRecord(data)) return undefined;
    const d = data as Record<string, unknown>;
    if (typeof d.taskId === "string") return d.taskId;
    if (this.isRecord(d.task) && typeof (d.task as Record<string, unknown>).id === "string") {
      return (d.task as Record<string, unknown>).id as string;
    }
    return undefined;
  }

  private extractMissionId(data: unknown): string | undefined {
    if (!this.isRecord(data)) return undefined;
    const d = data as Record<string, unknown>;
    if (typeof d.missionId === "string") return d.missionId;
    if (this.isRecord(d.mission) && typeof (d.mission as Record<string, unknown>).id === "string") {
      return (d.mission as Record<string, unknown>).id as string;
    }
    return undefined;
  }

  dispose(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    this.store.close?.();
  }
}
