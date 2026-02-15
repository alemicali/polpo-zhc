import { EventEmitter } from "node:events";
import type { Task, TaskStatus, DimensionScore, PlanStatus, PlanReport } from "./types.js";
import type { LogStore } from "./log-store.js";

export interface OrchestraEventMap {
  // Task lifecycle
  "task:created": { task: Task };
  "task:transition": { taskId: string; from: TaskStatus; to: TaskStatus; task: Task };
  "task:updated": { taskId: string; task: Task };
  "task:removed": { taskId: string };

  // Agent lifecycle
  "agent:spawned": { taskId: string; agentName: string; adapter?: string; taskTitle: string };
  "agent:finished": { taskId: string; agentName: string; exitCode: number; duration: number; sessionId?: string };
  "agent:activity": { taskId: string; agentName: string; tool?: string; file?: string; summary?: string };

  // Assessment
  "assessment:started": { taskId: string };
  "assessment:progress": { taskId: string; message: string };
  "assessment:complete": { taskId: string; passed: boolean; scores?: DimensionScore[]; globalScore?: number; message?: string };
  "assessment:corrected": { taskId: string; corrections: number };

  // Orchestrator lifecycle
  "orchestrator:started": { project: string; agents: string[] };
  "orchestrator:tick": { pending: number; running: number; done: number; failed: number; queued: number };
  "orchestrator:deadlock": { taskIds: string[] };
  "orchestrator:shutdown": Record<string, never>;

  // Retry & Fix
  "task:retry": { taskId: string; attempt: number; maxRetries: number };
  "task:fix": { taskId: string; attempt: number; maxFix: number };
  "task:maxRetries": { taskId: string };

  // Question detection & auto-resolution
  "task:question": { taskId: string; question: string };
  "task:answered": { taskId: string; question: string; answer: string };

  // Deadlock resolution
  "deadlock:detected": { taskIds: string[]; resolvableCount: number };
  "deadlock:resolving": { taskId: string; failedDepId: string };
  "deadlock:resolved": { taskId: string; failedDepId: string; action: "absorb" | "retry"; reason: string };
  "deadlock:unresolvable": { taskId: string; reason: string };

  // Resilience
  "task:timeout": { taskId: string; elapsed: number; timeout: number };
  "agent:stale": { taskId: string; agentName: string; idleMs: number; action: "warning" | "killed" };

  // Recovery
  "task:recovered": { taskId: string; title: string; previousStatus: TaskStatus };

  // Plans
  "plan:saved": { planId: string; name: string; status: PlanStatus };
  "plan:executed": { planId: string; group: string; taskCount: number };
  "plan:completed": { planId: string; group: string; allPassed: boolean; report: PlanReport };
  "plan:resumed": { planId: string; name: string; retried: number; pending: number };
  "plan:deleted": { planId: string };

  // Chat sessions
  "session:created": { sessionId: string; title?: string };
  "message:added": { sessionId: string; messageId: string; role: "user" | "assistant" };

  // Bridge (passive session discovery)
  "bridge:session:discovered": { sessionId: string; projectPath: string; transcriptPath: string };
  "bridge:session:activity": { sessionId: string; projectPath: string; messageCount: number; toolCalls: string[]; filesCreated: string[]; filesEdited: string[]; lastMessage: string };
  "bridge:session:completed": { sessionId: string; projectPath: string; summary: import("./session-reader.js").SessionSummary | null; duration: number };

  // General
  "log": { level: "info" | "warn" | "error" | "debug"; message: string };
}

export type OrchestraEvent = keyof OrchestraEventMap;

/**
 * Typed event emitter for Orchestra.
 * Wraps Node's EventEmitter with type-safe emit/on/once/off.
 */
/** Events to exclude from persistent logging (too frequent or internal). */
const LOG_EXCLUDED = new Set<string>(["orchestrator:tick", "bridge:session:activity", "newListener", "removeListener"]);

export class TypedEmitter extends EventEmitter {
  private logSink?: LogStore;

  /** Attach a persistent log store. All emitted events will be written to it. */
  setLogSink(store: LogStore): void {
    this.logSink = store;
  }

  override emit<K extends OrchestraEvent>(event: K, payload: OrchestraEventMap[K]): boolean;
  override emit(event: string | symbol, ...args: unknown[]): boolean;
  override emit(event: string | symbol, ...args: unknown[]): boolean {
    // Persist to log store before dispatching
    if (this.logSink && typeof event === "string" && !LOG_EXCLUDED.has(event)) {
      try {
        this.logSink.append({
          ts: new Date().toISOString(),
          event,
          data: args[0],
        });
      } catch { /* never let logging break the system */ }
    }
    return super.emit(event, ...args);
  }

  override on<K extends OrchestraEvent>(event: K, listener: (payload: OrchestraEventMap[K]) => void): this;
  override on(event: string | symbol, listener: (...args: unknown[]) => void): this;
  override on(event: string | symbol, listener: (...args: unknown[]) => void): this {
    return super.on(event, listener);
  }

  override once<K extends OrchestraEvent>(event: K, listener: (payload: OrchestraEventMap[K]) => void): this;
  override once(event: string | symbol, listener: (...args: unknown[]) => void): this;
  override once(event: string | symbol, listener: (...args: unknown[]) => void): this {
    return super.once(event, listener);
  }

  override off<K extends OrchestraEvent>(event: K, listener: (payload: OrchestraEventMap[K]) => void): this;
  override off(event: string | symbol, listener: (...args: unknown[]) => void): this;
  override off(event: string | symbol, listener: (...args: unknown[]) => void): this {
    return super.off(event, listener);
  }
}
