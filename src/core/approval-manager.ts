import { nanoid } from "nanoid";
import type { OrchestratorContext } from "./orchestrator-context.js";
import type { ApprovalStore } from "./approval-store.js";
import type { ApprovalGate, ApprovalRequest, ApprovalStatus } from "./types.js";
import type { LifecycleHook, HookPayloads } from "./hooks.js";

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

  constructor(
    private ctx: OrchestratorContext,
    private store: ApprovalStore,
  ) {}

  /**
   * Initialize: register hooks for all configured approval gates.
   * Called once during orchestrator startup.
   */
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

  /**
   * Register a single gate as a "before" hook.
   */
  private registerGate(gate: ApprovalGate): void {
    const hook = gate.hook as LifecycleHook;

    this.ctx.hooks.register({
      hook,
      phase: "before",
      priority: gate.priority ?? 50,  // Gates run before user hooks (default 100)
      name: `approval-gate:${gate.name}`,
      handler: (ctx) => {
        // Evaluate condition if present
        if (gate.condition?.expression) {
          const matches = this.evaluateCondition(gate.condition.expression, ctx.data);
          if (!matches) return;  // Condition doesn't match — gate not applicable
        }

        if (gate.handler === "auto") {
          // Auto gate: condition already matched, which means the gate triggers.
          // For auto gates, matching the condition means BLOCK (it's a guard condition).
          // If there's no condition, auto gates always pass (no-op).
          if (gate.condition?.expression) {
            ctx.cancel(`Auto gate "${gate.name}" condition matched — blocking`);
          }
          return;
        }

        // Human gate: block and create approval request
        const request = this.createRequest(gate, ctx.data);
        ctx.cancel(`Awaiting human approval: ${gate.name} (request: ${request.id})`);

        // Transition task to awaiting_approval if this is a task-related hook
        const taskId = this.extractTaskId(ctx.data);
        if (taskId) {
          try {
            this.ctx.registry.transition(taskId, "awaiting_approval");
          } catch {
            // Task may already be in a state that doesn't allow this transition
          }
        }

        // Emit approval:requested event (triggers notification rules)
        this.ctx.emitter.emit("approval:requested", {
          requestId: request.id,
          gateId: gate.id,
          gateName: gate.name,
          taskId: request.taskId,
          planId: request.planId,
        });

        // Start timeout timer if configured
        if (gate.timeoutMs && gate.timeoutMs > 0) {
          this.startTimer(request.id, gate.timeoutMs, gate);
        }
      },
    });
  }

  /**
   * Create and persist an approval request.
   */
  private createRequest(gate: ApprovalGate, payload: unknown): ApprovalRequest {
    const request: ApprovalRequest = {
      id: nanoid(),
      gateId: gate.id,
      gateName: gate.name,
      taskId: this.extractTaskId(payload),
      planId: this.extractPlanId(payload),
      status: "pending",
      payload,
      requestedAt: new Date().toISOString(),
    };
    this.store.upsert(request);
    return request;
  }

  /**
   * Approve a pending request. Returns the updated request or null if not found/already resolved.
   */
  approve(requestId: string, resolvedBy?: string, note?: string): ApprovalRequest | null {
    return this.resolve(requestId, "approved", resolvedBy, note);
  }

  /**
   * Reject a pending request. Returns the updated request or null if not found/already resolved.
   */
  reject(requestId: string, resolvedBy?: string, note?: string): ApprovalRequest | null {
    return this.resolve(requestId, "rejected", resolvedBy, note);
  }

  /**
   * Revise a pending request: send the task back for rework with feedback.
   *
   * The task's description is appended with the revision feedback,
   * `revisionCount` is incremented on the task, and the task transitions
   * back to `assigned` so the agent re-spawns with the new instructions.
   *
   * Returns the updated request, or `null` if:
   * - Request not found or already resolved
   * - No taskId on the request
   * - Max revisions exceeded (check with `canRevise()` first)
   */
  revise(requestId: string, feedback: string, resolvedBy?: string): ApprovalRequest | null {
    const request = this.store.get(requestId);
    if (!request || request.status !== "pending") return null;
    if (!request.taskId) return null;

    // Check max revisions
    const gate = this.ctx.config.settings.approvalGates?.find(g => g.id === request.gateId);
    const maxRevisions = gate?.maxRevisions ?? 3;
    const task = this.ctx.registry.getTask(request.taskId);
    if (!task) return null;

    const currentCount = task.revisionCount ?? 0;
    if (currentCount >= maxRevisions) return null;

    // 1. Mark request as revised
    request.status = "revised";
    request.resolvedAt = new Date().toISOString();
    request.resolvedBy = resolvedBy ?? "user";
    request.note = feedback;
    this.store.upsert(request);

    // 2. Clear timeout timer
    this.clearTimer(requestId);

    // 3. Increment revisionCount on the task
    const newCount = currentCount + 1;
    this.ctx.registry.updateTask(request.taskId, {
      revisionCount: newCount,
    });

    // 4. Append feedback to task description
    const separator = "\n\n---\n";
    const feedbackBlock = `**Revision #${newCount} feedback:** ${feedback}`;
    const updatedDescription = task.description + separator + feedbackBlock;
    this.ctx.registry.updateTask(request.taskId, {
      description: updatedDescription,
    });

    // 5. Emit event
    this.ctx.emitter.emit("approval:revised", {
      requestId,
      taskId: request.taskId,
      feedback,
      revisionCount: newCount,
      resolvedBy: request.resolvedBy,
    });

    // 6. Transition task back to assigned (triggers re-spawn)
    try {
      this.ctx.registry.transition(request.taskId, "assigned");
    } catch {
      // Task may have been modified externally
    }

    return request;
  }

  /**
   * Check whether a request can be revised (not at max revisions).
   */
  canRevise(requestId: string): { allowed: boolean; revisionCount: number; maxRevisions: number } {
    const request = this.store.get(requestId);
    if (!request || request.status !== "pending" || !request.taskId) {
      return { allowed: false, revisionCount: 0, maxRevisions: 0 };
    }

    const gate = this.ctx.config.settings.approvalGates?.find(g => g.id === request.gateId);
    const maxRevisions = gate?.maxRevisions ?? 3;
    const task = this.ctx.registry.getTask(request.taskId);
    const currentCount = task?.revisionCount ?? 0;

    return { allowed: currentCount < maxRevisions, revisionCount: currentCount, maxRevisions };
  }

  /**
   * Resolve a pending request (approve or reject).
   */
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

    // Clear timeout timer
    this.clearTimer(requestId);

    // Emit resolution event
    this.ctx.emitter.emit("approval:resolved", {
      requestId,
      status,
      resolvedBy: request.resolvedBy,
    });

    // If task was awaiting_approval, transition it
    if (request.taskId) {
      try {
        if (status === "approved") {
          this.ctx.registry.transition(request.taskId, "assigned");
        } else {
          this.ctx.registry.transition(request.taskId, "failed");
        }
      } catch {
        // Task may have been modified externally
      }
    }

    return request;
  }

  /**
   * Handle timeout for a pending approval.
   */
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

    // Apply timeout action
    if (request.taskId) {
      try {
        if (action === "approve") {
          this.ctx.registry.transition(request.taskId, "assigned");
        } else {
          this.ctx.registry.transition(request.taskId, "failed");
        }
      } catch {
        // Task may have been modified externally
      }
    }
  }

  /**
   * Get all pending approval requests.
   */
  getPending(): ApprovalRequest[] {
    return this.store.list("pending");
  }

  /**
   * Get all approval requests.
   */
  getAll(status?: ApprovalStatus): ApprovalRequest[] {
    return this.store.list(status);
  }

  /**
   * Get a specific request by ID.
   */
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

  /**
   * Evaluate a simple condition expression against a data payload.
   * Supports dot-access paths and simple comparisons.
   *
   * Examples:
   *   "task.group === 'production'"
   *   "data.allPassed === false"
   *   "task.retries >= 2"
   */
  private evaluateCondition(expression: string, data: unknown): boolean {
    try {
      // Safe evaluation: create a function with the data as scope
      const fn = new Function("data", "task", "plan", `try { return !!(${expression}); } catch { return false; }`);
      const taskData = this.isRecord(data) ? (data as Record<string, unknown>).task : undefined;
      const planData = this.isRecord(data) ? (data as Record<string, unknown>).plan : undefined;
      return fn(data, taskData, planData) === true;
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

  private extractPlanId(data: unknown): string | undefined {
    if (!this.isRecord(data)) return undefined;
    const d = data as Record<string, unknown>;
    if (typeof d.planId === "string") return d.planId;
    if (this.isRecord(d.plan) && typeof (d.plan as Record<string, unknown>).id === "string") {
      return (d.plan as Record<string, unknown>).id as string;
    }
    return undefined;
  }

  /**
   * Cleanup: clear all timers and close the store.
   */
  dispose(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    this.store.close?.();
  }
}
