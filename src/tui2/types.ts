// Types for the pi-tui based TUI

import type { Orchestrator } from "../core/orchestrator.js";
import type { TaskStatus, MissionStatus, AgentProcess } from "../core/types.js";
import type { Component, TUI } from "@mariozechner/pi-tui";

/** Input mode - determines how Enter submits text */
export type InputMode = "chat" | "plan" | "task";

/** Pending tool approval request */
export interface PendingApproval {
  toolName: string;
  args: Record<string, unknown>;
  description: string;
  onApprove: () => void;
  onReject: () => void;
}

/** Approval mode preference */
export type ApprovalMode = "approval" | "accept-all";

/** Task snapshot for display */
export interface TaskSnapshot {
  id: string;
  title: string;
  status: TaskStatus;
  assignedTo?: string;
  group?: string;
  dependsOn?: string[];
  retries?: number;
  maxRetries?: number;
  duration?: number;
  score?: number;
  description?: string;
}

/** Mission snapshot for display */
export interface MissionSnapshot {
  name: string;
  status: MissionStatus;
  prompt?: string;
  taskCount?: number;
  completedCount?: number;
  failedCount?: number;
}

/** Agent activity info for TaskPanel display */
export interface AgentActivity {
  agentName: string;
  taskId?: string;
  taskTitle?: string;
  currentTool?: string;
  elapsed?: number;
  tokens?: number;
  toolCalls?: number;
}

/** Command API passed to all slash command handlers */
export interface CommandAPI {
  polpo: Orchestrator;
  tui: TUIContext;
  args: string[];
}

/** TUI context - the imperative equivalent of the old Zustand store + React context */
export interface TUIContext {
  polpo: Orchestrator;
  inputMode: InputMode;
  approvalMode: ApprovalMode;
  pendingApproval: PendingApproval | null;
  taskPanelVisible: boolean;
  processing: boolean;
  processingLabel: string;
  streaming: boolean;
  streamingTokens: number;
  activeSessionId: string | null;
  defaultAgent: string | null;

  // Methods
  setInputMode(mode: InputMode): void;
  setProcessing(active: boolean, label?: string): void;
  setStreaming(active: boolean): void;
  updateStreamingTokens(tokens: number): void;
  setPendingApproval(approval: PendingApproval | null): void;
  setApprovalMode(mode: ApprovalMode): void;
  toggleTaskPanel(): void;
  log(text: string): void;
  logUser(text: string): void;
  logResponse(segs: Seg[]): void;
  logSystem(text: string): void;
  clearLog(): void;
  requestRender(): void;
  showOverlay(component: Component): void;
  hideOverlay(): void;
  /** Finalize a streaming assistant message */
  finalizeAssistant(text: string, runId?: string): void;
  /** Drop an empty assistant message */
  dropAssistant(runId?: string): void;
  /** Start a tool execution card in the chat log */
  startTool(toolCallId: string, toolName: string, args: unknown): void;
  /** Update a tool execution card with the result */
  updateToolResult(toolCallId: string, result: unknown, opts?: { isError?: boolean; partial?: boolean }): void;
  /** Show a tool approval overlay and wait for user decision */
  showApproval(opts: {
    toolName: string;
    description: string;
    details: [string, string][];
    extraDetails?: [string, string][];
  }): Promise<boolean>;
  /** The underlying pi-tui TUI instance (needed by EditorOverlay) */
  tuiInstance: TUI;
}

/** Styled text segment - same as the old Seg type */
export interface Seg {
  text: string;
  color?: string;
  bold?: boolean;
  dim?: boolean;
  bgColor?: string;
  underline?: boolean;
  italic?: boolean;
}

/** Slash command definition for autocomplete */
export interface PolpoCommand {
  command: string;
  description: string;
  handler: (api: CommandAPI) => Promise<void> | void;
}
