import type { AgentConfig, AgentActivity, Task, TaskResult } from "./types.js";

// === Agent Handle ===
// Returned by adapter.spawn(). The orchestrator uses this to monitor and control the agent.

export interface AgentHandle {
  /** Agent name from config */
  agentName: string;
  /** Task ID this handle is working on */
  taskId: string;
  /** When the agent was started */
  startedAt: string;
  /** Live activity data — adapters update this in place */
  activity: AgentActivity;
  /** Resolves when the agent finishes (success or failure) */
  done: Promise<TaskResult>;
  /** Check if the agent is still running */
  isAlive(): boolean;
  /** Kill the agent process */
  kill(): void;
}

// === Adapter Interface ===
// Each adapter knows how to talk to one type of agent.

export interface AgentAdapter {
  /** Adapter name (for logging) */
  readonly name: string;

  /**
   * Spawn an agent to work on a task.
   * The adapter is responsible for:
   * - Starting the agent (SDK call, process spawn, etc.)
   * - Providing the task prompt/description
   * - Tracking activity (tool calls, files, progress)
   * - Resolving `handle.done` when the agent finishes
   */
  spawn(agent: AgentConfig, task: Task, cwd: string): AgentHandle;
}

// === Adapter Registry ===

type AdapterFactory = () => AgentAdapter;

const registry = new Map<string, AdapterFactory>();

export function registerAdapter(name: string, factory: AdapterFactory): void {
  registry.set(name, factory);
}

export function getAdapter(name: string): AgentAdapter {
  const factory = registry.get(name);
  if (!factory) {
    throw new Error(
      `Unknown adapter: "${name}". Available: ${[...registry.keys()].join(", ") || "none"}`
    );
  }
  return factory();
}

/** Create a fresh AgentActivity object */
export function createActivity(): AgentActivity {
  return {
    filesCreated: [],
    filesEdited: [],
    toolCalls: 0,
    lastUpdate: new Date().toISOString(),
  };
}
