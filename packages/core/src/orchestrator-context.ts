/**
 * OrchestratorContext — shared dependency injection container for all core managers.
 *
 * All store fields are interfaces (not concrete implementations).
 * The shell layer creates concrete stores and assembles this context.
 */
import type { EventBus } from "./event-bus.js";
import type { TaskStore } from "./task-store.js";
import type { RunStore } from "./run-store.js";
import type { MemoryStore } from "./memory-store.js";
import type { LogStore } from "./log-store.js";
import type { SessionStore } from "./session-store.js";
import type { ApprovalStore } from "./approval-store.js";
import type { NotificationStore } from "./notification-store.js";
import type { CheckpointStore } from "./checkpoint-store.js";
import type { DelayStore } from "./delay-store.js";
import type { PeerStore } from "./peer-store.js";
import type { ConfigStore } from "./config-store.js";
import type { TeamStore } from "./team-store.js";
import type { AgentStore } from "./agent-store.js";
import type { PolpoConfig, PolpoFileConfig, Task, AssessmentResult, ReviewContext, ReasoningLevel, ModelConfig } from "./types.js";
import type { HookRegistry } from "./hooks.js";
import type { Spawner } from "./spawner.js";

/** Progress event for individual assessment checks. */
export interface CheckProgressEvent {
  index: number;
  total: number;
  type: string;
  label: string;
  phase: "started" | "complete";
  passed?: boolean;
  message?: string;
}

export type AssessFn = (
  task: Task,
  cwd: string,
  onProgress?: (msg: string) => void,
  context?: ReviewContext,
  reasoning?: ReasoningLevel,
  onCheckProgress?: (event: CheckProgressEvent) => void,
) => Promise<AssessmentResult>;

/**
 * Shared context injected into all manager classes.
 *
 * Required fields are the minimum for any runtime (Node, Convex, Workers).
 * Optional port fields allow the shell to inject runtime-specific capabilities.
 */
export interface OrchestratorContext {
  readonly emitter: EventBus;
  readonly registry: TaskStore;
  readonly runStore: RunStore;
  readonly memoryStore: MemoryStore;
  readonly logStore: LogStore;
  readonly sessionStore: SessionStore;
  readonly teamStore: TeamStore;
  readonly agentStore: AgentStore;
  readonly hooks: HookRegistry;
  config: PolpoConfig;
  readonly workDir: string;
  /** Resolved working directory for agent processes (settings.workDir resolved against workDir). */
  readonly agentWorkDir: string;
  readonly polpoDir: string;
  readonly assessFn: AssessFn;
  readonly spawner: Spawner;

  // ── Optional ports (injected by shell) ──────────────────────────

  /** Kill an OS process by PID (Node shell: process.kill). */
  readonly killProcess?: (pid: number, signal?: string) => void;

  /** Load polpo.json config from disk. */
  readonly loadConfig?: () => PolpoFileConfig | undefined;

  /** Save polpo.json config to disk. */
  readonly saveConfig?: (config: PolpoFileConfig) => void;

  /** Query LLM for text completion (used by escalation, deadlock resolver). */
  readonly queryLLM?: (prompt: string, model?: string | ModelConfig) => Promise<{ text: string }>;

  /** Find JSONL activity log path for a task/run. */
  readonly findLogForTask?: (polpoDir: string, taskId: string, runId?: string) => string | null;

  /** Build execution summary from JSONL log. */
  readonly buildExecutionSummary?: (logPath: string) => { summary: string; toolsSummary?: string };

  /** Validate that provider API keys are configured. */
  readonly validateProviderKeys?: (config: PolpoConfig) => { valid: boolean; missing: string[] };

  // ── Optional store ports (injected by shell for non-file backends) ──

  /** Approval request store (when storage is "postgres", injected by shell). */
  readonly approvalStore?: ApprovalStore;
  /** Notification record store (when storage is "postgres", injected by shell). */
  readonly notificationStore?: NotificationStore;
  /** Checkpoint persistence store (when storage is "postgres", injected by shell). */
  readonly checkpointStore?: CheckpointStore;
  /** Delay persistence store (when storage is "postgres", injected by shell). */
  readonly delayStore?: DelayStore;
  /** Peer identity store (when storage is "postgres", injected by shell). */
  readonly peerStore?: PeerStore;
  /** Config persistence store (when storage is "postgres", injected by shell). */
  readonly configStore?: ConfigStore;
}
