import type { TypedEmitter } from "./events.js";
import type { TaskStore } from "./task-store.js";
import type { RunStore } from "./run-store.js";
import type { MemoryStore } from "./memory-store.js";
import type { LogStore } from "./log-store.js";
import type { SessionStore } from "./session-store.js";
import type { OrchestraConfig, Task, AssessmentResult, ReviewContext } from "./types.js";

export type AssessFn = (
  task: Task,
  cwd: string,
  onProgress?: (msg: string) => void,
  context?: ReviewContext,
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
  config: OrchestraConfig;
  readonly workDir: string;
  readonly polpoDir: string;
  readonly assessFn: AssessFn;
}
