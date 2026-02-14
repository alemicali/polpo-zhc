import type { Orchestrator } from "../core/orchestrator.js";
import type { OrchestraState, ProjectConfig } from "../core/types.js";
import type { BridgeManager } from "../bridge/index.js";

// ─── TUI Config ──────────────────────────────────────────

export type TUIConfig = ProjectConfig;

// ─── TUI Logger ──────────────────────────────────────────

export interface TUILogger {
  /** Verbose log (shows in verbose mode) */
  log(msg: string): void;
  /** Always visible in both modes */
  logAlways(msg: string): void;
  /** Event log (shows in clean mode) */
  logEvent(msg: string): void;
}

// ─── Command Context ─────────────────────────────────────

export interface CommandContext extends TUILogger {
  orchestrator: Orchestrator;
  config: TUIConfig;
  workDir: string;

  // State
  getState(): OrchestraState | null;
  loadState(): void;
  getDefaultAgent(): string;
  setDefaultAgent(name: string): void;

  // Processing indicator
  setProcessing(active: boolean, label?: string): void;
  setProcessingDetail(detail: string): void;

  // Input mode
  getInputMode(): "task" | "plan" | "chat";
  setInputMode(mode: "task" | "plan" | "chat"): void;

  // Bridge
  bridge: BridgeManager | null;
  setBridge(b: BridgeManager | null): void;
}
