import type { AgentConfig, AgentActivity, Task, TaskResult, TaskOutcome, ReasoningLevel } from "./types.js";
import type { VaultStore } from "./vault-store.js";
import type { WhatsAppStore } from "../stores/whatsapp-store.js";

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
  /** Vault store — for resolving agent credentials at runtime. */
  vaultStore?: VaultStore;
  /** WhatsApp message store — for whatsapp_* agent tools. */
  whatsappStore?: WhatsAppStore;
  /** WhatsApp send function — for whatsapp_send agent tool. */
  whatsappSendMessage?: (jid: string, text: string) => Promise<string | undefined>;
}
