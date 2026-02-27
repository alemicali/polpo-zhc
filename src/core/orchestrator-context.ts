import type { TypedEmitter } from "./events.js";
import type { TaskStore } from "./task-store.js";
import type { RunStore } from "./run-store.js";
import type { MemoryStore } from "./memory-store.js";
import type { LogStore } from "./log-store.js";
import type { SessionStore } from "./session-store.js";
import type { PolpoConfig, Task, AssessmentResult, ReviewContext, ReasoningLevel } from "./types.js";
import type { HookRegistry } from "./hooks.js";

export type AssessFn = (
  task: Task,
  cwd: string,
  onProgress?: (msg: string) => void,
  context?: ReviewContext,
  reasoning?: ReasoningLevel,
) => Promise<AssessmentResult>;

/**
 * Shared context injected into all manager classes.
 * Managers emit events through `emitter` (which IS the Orchestrator instance).
 */
export interface OrchestratorContext {
  readonly emitter: TypedEmitter;
  readonly registry: TaskStore;
  readonly runStore: RunStore;
  readonly memoryStore: MemoryStore;
  readonly logStore: LogStore;
  readonly sessionStore: SessionStore;
  /** Lifecycle hook registry — managers call runBefore/runAfter at key points. */
  readonly hooks: HookRegistry;
  config: PolpoConfig;
  readonly workDir: string;
  readonly polpoDir: string;
  readonly assessFn: AssessFn;
}
