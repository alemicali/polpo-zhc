import { EventEmitter } from "node:events";
import type { Task, TaskStatus, DimensionScore, PlanStatus } from "./types.js";

export interface OrchestraEventMap {
  // Task lifecycle
  "task:created": { task: Task };
  "task:transition": { taskId: string; from: TaskStatus; to: TaskStatus; task: Task };
  "task:updated": { taskId: string; task: Task };
  "task:removed": { taskId: string };

  // Agent lifecycle
  "agent:spawned": { taskId: string; agentName: string; adapter: string; taskTitle: string };
  "agent:finished": { taskId: string; agentName: string; exitCode: number; duration: number };
  "agent:activity": { taskId: string; agentName: string; tool?: string; file?: string; summary?: string };

  // Assessment
  "assessment:started": { taskId: string };
  "assessment:complete": { taskId: string; passed: boolean; scores?: DimensionScore[]; globalScore?: number; message?: string };

  // Orchestrator lifecycle
  "orchestrator:started": { project: string; agents: string[] };
  "orchestrator:tick": { pending: number; running: number; done: number; failed: number };
  "orchestrator:deadlock": { taskIds: string[] };
  "orchestrator:shutdown": Record<string, never>;

  // Retry
  "task:retry": { taskId: string; attempt: number; maxRetries: number };
  "task:maxRetries": { taskId: string };

  // Resilience
  "task:timeout": { taskId: string; elapsed: number; timeout: number };
  "agent:stale": { taskId: string; agentName: string; idleMs: number; action: "warning" | "killed" };

  // Recovery
  "task:recovered": { taskId: string; title: string; previousStatus: TaskStatus };

  // Plans
  "plan:saved": { planId: string; name: string; status: PlanStatus };
  "plan:executed": { planId: string; group: string; taskCount: number };
  "plan:completed": { planId: string; group: string; allPassed: boolean };
  "plan:deleted": { planId: string };

  // General
  "log": { level: "info" | "warn" | "error" | "debug"; message: string };
}

export type OrchestraEvent = keyof OrchestraEventMap;

/**
 * Typed event emitter for Orchestra.
 * Wraps Node's EventEmitter with type-safe emit/on/once/off.
 */
export class TypedEmitter extends EventEmitter {
  override emit<K extends OrchestraEvent>(event: K, payload: OrchestraEventMap[K]): boolean;
  override emit(event: string | symbol, ...args: unknown[]): boolean;
  override emit(event: string | symbol, ...args: unknown[]): boolean {
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
