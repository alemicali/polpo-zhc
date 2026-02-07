import type { AgentConfig, AgentActivity, Task, TaskResult } from "./types.js";

/**
 * Handle returned by adapter.spawn().
 * The orchestrator uses this to monitor and control the agent.
 */
export interface AgentHandle {
  /** Agent name from config */
  agentName: string;
  /** Task ID this handle is working on */
  taskId: string;
  /** When the agent was started */
  startedAt: string;
  /** Process ID (0 for SDK adapter, real PID for generic) */
  pid: number;
  /** SDK session ID — for reading conversation transcripts */
  sessionId?: string;
  /** Live activity data — adapters update this in place */
  activity: AgentActivity;
  /** Resolves when the agent finishes (success or failure) */
  done: Promise<TaskResult>;
  /** Check if the agent is still running */
  isAlive(): boolean;
  /** Kill the agent process */
  kill(): void;
}

/**
 * Adapter interface — each adapter knows how to talk to one type of agent.
 */
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
