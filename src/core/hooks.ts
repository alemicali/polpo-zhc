import type { Task, AgentConfig, Plan, PlanReport, TaskResult, AssessmentResult, TaskExpectation, RetryPolicy } from "./types.js";

// ─── Lifecycle Hook Points ───────────────────────────

export type LifecycleHook =
  // Task lifecycle
  | "task:create"
  | "task:spawn"
  | "task:transition"
  | "task:complete"
  | "task:fail"
  | "task:retry"
  // Plan lifecycle
  | "plan:execute"
  | "plan:complete"
  // Assessment
  | "assessment:run"
  | "assessment:complete"
  // Quality
  | "quality:gate"
  | "quality:sla"
  // Scheduling
  | "schedule:trigger"
  // Orchestrator
  | "orchestrator:tick"
  | "orchestrator:shutdown";

// ─── Typed Payloads per Hook ─────────────────────────

export interface HookPayloads {
  "task:create": {
    title: string;
    description: string;
    assignTo: string;
    expectations?: TaskExpectation[];
    dependsOn?: string[];
    group?: string;
    maxDuration?: number;
    retryPolicy?: RetryPolicy;
  };
  "task:spawn": {
    task: Task;
    agent: AgentConfig;
  };
  "task:transition": {
    taskId: string;
    from: string;
    to: string;
    task: Task;
  };
  "task:complete": {
    taskId: string;
    task: Task;
    result?: TaskResult;
    assessment?: AssessmentResult;
  };
  "task:fail": {
    taskId: string;
    task: Task;
    result?: TaskResult;
    reason?: string;
  };
  "task:retry": {
    taskId: string;
    task: Task;
    attempt: number;
    maxRetries: number;
  };
  "plan:execute": {
    planId: string;
    plan: Plan;
    taskCount: number;
  };
  "plan:complete": {
    planId: string;
    plan: Plan;
    allPassed: boolean;
    report: PlanReport;
  };
  "assessment:run": {
    taskId: string;
    task: Task;
  };
  "assessment:complete": {
    taskId: string;
    task: Task;
    assessment: AssessmentResult;
    passed: boolean;
  };
  "quality:gate": {
    planId: string;
    gateName: string;
    avgScore?: number;
    allPassed: boolean;
    tasks: Array<{ taskId: string; title: string; status: string; score?: number }>;
  };
  "quality:sla": {
    entityId: string;
    entityType: "task" | "plan";
    deadline: string;
    status: "warning" | "violated";
    percentUsed: number;
  };
  "schedule:trigger": {
    scheduleId: string;
    planId: string;
    expression: string;
  };
  "orchestrator:tick": {
    pending: number;
    running: number;
    done: number;
    failed: number;
  };
  "orchestrator:shutdown": Record<string, never>;
}

// ─── Hook Context ────────────────────────────────────

export type HookPhase = "before" | "after";

export interface HookContext<T = unknown> {
  /** Which hook point fired. */
  readonly hook: LifecycleHook;
  /** "before" hooks can cancel/modify; "after" hooks are observe-only. */
  readonly phase: HookPhase;
  /** The payload — mutable reference for "before" hooks. */
  data: T;
  /** Cancel the operation (only available in "before" hooks). */
  cancel(reason?: string): void;
  /** Whether any handler has called cancel(). */
  readonly cancelled: boolean;
  /** Reason provided to cancel(), if any. */
  readonly cancelReason?: string;
  /** ISO timestamp when the hook was triggered. */
  readonly timestamp: string;
}

// ─── Handler Types ───────────────────────────────────

export type HookHandler<T = unknown> = (ctx: HookContext<T>) => void | Promise<void>;

export interface HookRegistration<K extends LifecycleHook = LifecycleHook> {
  /** Which lifecycle hook to listen to. */
  hook: K;
  /** "before" runs before the operation (can cancel/modify), "after" runs after. */
  phase: HookPhase;
  /** The handler function. */
  handler: HookHandler<HookPayloads[K]>;
  /** Lower priority runs first. Default: 100. */
  priority?: number;
  /** Optional name for debugging/logging. */
  name?: string;
}

// ─── Hook Result (returned by runBefore) ─────────────

export interface BeforeHookResult<T> {
  /** True if any handler called cancel(). */
  cancelled: boolean;
  /** Reason provided to cancel(), if any. */
  cancelReason?: string;
  /** The (possibly modified) payload. */
  data: T;
}

// ─── HookRegistry ────────────────────────────────────

interface StoredRegistration {
  hook: LifecycleHook;
  phase: HookPhase;
  handler: HookHandler<any>;
  priority: number;
  name?: string;
}

/**
 * Central registry for lifecycle hooks.
 *
 * "before" hooks run before an operation and can cancel or modify the payload.
 * "after" hooks run after the operation completes (fire-and-forget, observe-only).
 *
 * Handlers are sorted by priority (ascending) and run sequentially.
 * Async handlers are awaited — a slow hook delays the operation.
 */
export class HookRegistry {
  private registrations: StoredRegistration[] = [];

  /**
   * Register a lifecycle hook handler.
   * Returns an unsubscribe function.
   */
  register<K extends LifecycleHook>(reg: HookRegistration<K>): () => void {
    const stored: StoredRegistration = {
      hook: reg.hook,
      phase: reg.phase,
      handler: reg.handler as HookHandler<any>,
      priority: reg.priority ?? 100,
      name: reg.name,
    };

    this.registrations.push(stored);
    // Keep sorted by priority (stable sort)
    this.registrations.sort((a, b) => a.priority - b.priority);

    return () => {
      const idx = this.registrations.indexOf(stored);
      if (idx >= 0) this.registrations.splice(idx, 1);
    };
  }

  /**
   * Run all "before" hooks for a lifecycle point.
   * Returns whether the operation was cancelled and the (possibly modified) data.
   *
   * Handlers run sequentially in priority order.
   * If a handler calls `cancel()`, remaining handlers still run but the operation is blocked.
   */
  async runBefore<K extends LifecycleHook>(
    hook: K,
    data: HookPayloads[K],
  ): Promise<BeforeHookResult<HookPayloads[K]>> {
    const handlers = this.registrations.filter(r => r.hook === hook && r.phase === "before");
    if (handlers.length === 0) return { cancelled: false, data };

    let cancelled = false;
    let cancelReason: string | undefined;

    const ctx: HookContext<HookPayloads[K]> = {
      hook,
      phase: "before",
      data,
      cancel(reason?: string) {
        cancelled = true;
        cancelReason = reason;
      },
      get cancelled() { return cancelled; },
      get cancelReason() { return cancelReason; },
      timestamp: new Date().toISOString(),
    };

    for (const reg of handlers) {
      try {
        await reg.handler(ctx);
      } catch (err) {
        // A throwing hook does NOT cancel the operation — it's a hook bug.
        // Log but continue.
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[HookRegistry] Error in before:${hook} handler "${reg.name ?? "anonymous"}": ${msg}`);
      }
    }

    return { cancelled, cancelReason, data: ctx.data };
  }

  /**
   * Run all "after" hooks for a lifecycle point.
   * Fire-and-forget: errors are logged but never propagate.
   * "after" hooks cannot cancel or modify anything.
   */
  async runAfter<K extends LifecycleHook>(
    hook: K,
    data: HookPayloads[K],
  ): Promise<void> {
    const handlers = this.registrations.filter(r => r.hook === hook && r.phase === "after");
    if (handlers.length === 0) return;

    const ctx: HookContext<HookPayloads[K]> = {
      hook,
      phase: "after",
      data,
      cancel() { /* no-op in after hooks */ },
      get cancelled() { return false; },
      timestamp: new Date().toISOString(),
    };

    for (const reg of handlers) {
      try {
        await reg.handler(ctx);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[HookRegistry] Error in after:${hook} handler "${reg.name ?? "anonymous"}": ${msg}`);
      }
    }
  }

  /**
   * Synchronous variant of runBefore — for hot paths where async is not feasible.
   * Only runs synchronous handlers; async handlers are skipped with a warning.
   */
  runBeforeSync<K extends LifecycleHook>(
    hook: K,
    data: HookPayloads[K],
  ): BeforeHookResult<HookPayloads[K]> {
    const handlers = this.registrations.filter(r => r.hook === hook && r.phase === "before");
    if (handlers.length === 0) return { cancelled: false, data };

    let cancelled = false;
    let cancelReason: string | undefined;

    const ctx: HookContext<HookPayloads[K]> = {
      hook,
      phase: "before",
      data,
      cancel(reason?: string) {
        cancelled = true;
        cancelReason = reason;
      },
      get cancelled() { return cancelled; },
      get cancelReason() { return cancelReason; },
      timestamp: new Date().toISOString(),
    };

    for (const reg of handlers) {
      try {
        const result = reg.handler(ctx);
        if (result instanceof Promise) {
          console.warn(`[HookRegistry] Async handler "${reg.name ?? "anonymous"}" skipped in sync runBefore for ${hook}`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[HookRegistry] Error in before:${hook} handler "${reg.name ?? "anonymous"}": ${msg}`);
      }
    }

    return { cancelled, cancelReason, data: ctx.data };
  }

  /** Get the count of registered handlers (for diagnostics). */
  get size(): number {
    return this.registrations.length;
  }

  /** List all registered hooks (for diagnostics). */
  list(): Array<{ hook: LifecycleHook; phase: HookPhase; priority: number; name?: string }> {
    return this.registrations.map(r => ({
      hook: r.hook,
      phase: r.phase,
      priority: r.priority,
      name: r.name,
    }));
  }

  /** Remove all registered hooks. */
  clear(): void {
    this.registrations.length = 0;
  }
}
