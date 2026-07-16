/**
 * Agent adapter type definitions.
 * Pure interfaces — no runtime dependencies.
 *
 * SpawnContext uses generic types for vault/whatsapp to avoid
 * coupling @polpo-ai/core to specific runtime implementations.
 */

import type { AgentActivity, TaskResult, TaskOutcome, ReasoningLevel } from "./types.js";

/**
 * Handle returned by the engine after spawning an agent.
 * The orchestrator uses this to monitor and control the agent.
 */
export interface AgentHandle {
  /** Agent name from config */
  agentName: string;
  /** Task ID this handle is working on */
  taskId: string;
  /** When the agent was started */
  startedAt: string;
  /** Process ID (0 when running in-process) */
  pid: number;
  /** Session ID — for reading conversation transcripts */
  sessionId?: string;
  /** Live activity data — updated in place by the engine */
  activity: AgentActivity;
  /** Resolves when the agent finishes (success or failure) */
  done: Promise<TaskResult>;
  /** Check if the agent is still running */
  isAlive(): boolean;
  /** Kill the agent process */
  kill(): void;
  /** Queue a human direction after the current turn. */
  steer?(message: string, directionId?: string): void;
  /** Queue work after the agent would otherwise finish. */
  followUp?(message: string, directionId?: string): void;
  /** Persist the last fully-consistent conversation after each completed turn. */
  onCheckpoint?: (messages: unknown[], turnCount: number) => Promise<void> | void;
  /** Notify the runner when an initial continuation has entered the agent context. */
  onDirectionApplied?: (directionIds: string[]) => Promise<void> | void;
  /**
   * Transcript callback — set by the runner to persist every agent message.
   * The engine calls this for each message/event (assistant text, tool use, tool result, etc.)
   */
  onTranscript?: (entry: Record<string, unknown>) => void;
  /**
   * Auto-collected outcomes from tool executions.
   * Populated by the engine when tools produce files, media, or other artifacts.
   * The runner reads this after completion and stores them on the run record.
   */
  outcomes?: TaskOutcome[];
}

/** Extra context passed to the engine at spawn time. */
export interface SpawnContext {
  /** Absolute path to the .polpo directory. Used for skill loading, logs, etc. */
  polpoDir: string;
  /** Per-task output directory (.polpo/output/<taskId>/). Agents write deliverables here. */
  outputDir?: string;
  /** Email domain allowlist — restricts email_send tool to these domains. */
  emailAllowedDomains?: string[];
  /** Global reasoning level from settings — used as fallback when agent doesn't specify one. */
  reasoning?: ReasoningLevel;
  /** Consistent conversation messages restored for a manual continuation. */
  resumeMessages?: unknown[];
  /** Human direction that triggered this continuation run. */
  continuation?: { directionIds: string[]; message: string };
  /** Encrypted vault store — runtime-specific, provided by the shell layer. */
  vaultStore?: unknown;
  /** WhatsApp message store — runtime-specific, provided by the shell layer. */
  whatsappStore?: unknown;
  /** WhatsApp send function — runtime-specific, provided by the shell layer. */
  whatsappSendMessage?: (jid: string, text: string) => Promise<string | undefined>;
}
