/**
 * TUI state — pure UI data, no business logic objects.
 * Orchestrator lives in React Context, not here.
 */

import { create } from "zustand";
import type { Task, AgentProcess, PolpoState, Plan } from "../core/types.js";
import type { UserQuestion, UserAnswer } from "../llm/plan-generator.js";

// ─── Segment (styled text unit) ─────────────────────────

export interface Seg {
  text: string;
  color?: string;
  bold?: boolean;
  dim?: boolean;
  bgColor?: string;
  underline?: boolean;
  italic?: boolean;
}

// ─── Stream entries ─────────────────────────────────────

export type StreamEntry =
  | { type: "event"; segs: Seg[]; ts: string }
  | { type: "user"; text: string; ts: string }
  | { type: "response"; segs: Seg[]; ts: string }
  | { type: "system"; text: string; ts: string };

// ─── Pages (full-screen views) ──────────────────────────

export interface PickerItem {
  label: string;
  value: string;
  description?: string;
}

export type Page =
  | { id: "main" }
  | {
      id: "picker";
      title: string;
      items: PickerItem[];
      hint?: string;
      onSelect: (index: number, value: string) => void;
      onCancel: () => void;
      onKey?: (input: string, index: number, value: string) => void;
    }
  | {
      id: "editor";
      title: string;
      initial: string;
      onSave: (value: string) => void;
      onCancel: () => void;
    }
  | {
      id: "viewer";
      title: string;
      content: string;
      /** Rich content with colored segments — takes priority over plain content when present. */
      richContent?: Seg[][];
      actions?: string[];
      onAction?: (index: number) => void;
      onClose: () => void;
    }
  | {
      id: "confirm";
      message: string;
      onConfirm: () => void;
      onCancel: () => void;
    }
  | {
      id: "questions";
      title: string;
      questions: UserQuestion[];
      onSubmit: (answers: UserAnswer[]) => void;
      onCancel: () => void;
    };

// ─── Store ──────────────────────────────────────────────

const MAX_LINES = 2000;
const MAX_HISTORY = 100;

export interface TUIStore {
  // Stream
  lines: StreamEntry[];
  pushLine(entry: StreamEntry): void;
  log(text: string, segs?: Seg[]): void;
  /** Replace the last line's segments (for streaming updates). */
  updateLastLine(segs: Seg[]): void;
  clearLines(): void;

  // Tasks & plans (snapshot from orchestrator)
  tasks: Task[];
  processes: AgentProcess[];
  plans: Plan[];
  orchestratorStartedAt: string | null;
  tuiStartedAt: string;
  syncState(state: PolpoState, plans?: Plan[]): void;

  // Input
  inputBuffer: string;
  inputCursorPos: number;
  setInputBuffer(buf: string, cursorPos?: number): void;
  inputMode: "task" | "plan" | "chat";
  setInputMode(mode: "task" | "plan" | "chat"): void;
  history: string[];
  pushHistory(cmd: string): void;

  // Pages
  page: Page;
  navigate(page: Page): void;
  goMain(): void;

  // Processing indicator
  processing: boolean;
  processingLabel: string;
  processingStartedAt: string | null;
  processingTokens: number;
  setProcessing(active: boolean, label?: string): void;
  updateProcessingTokens(tokens: number): void;

  // Streaming session — stays active across the entire request lifecycle
  // (from user submit through all agentic turns until final response).
  // Unlike `processing`, this is NOT turned off during text streaming.
  streaming: boolean;
  streamingStartedAt: string | null;
  streamingTokens: number;
  startStreaming(): void;
  stopStreaming(): void;
  updateStreamingTokens(tokens: number): void;

  // Chat session
  activeSessionId: string | null;
  setActiveSessionId(id: string | null): void;

  // Completion menu
  completionActive: boolean;
  setCompletionActive(active: boolean): void;

  // Stream scroll
  scrollOffset: number;
  scrollUp(rows: number): void;
  scrollDown(rows: number): void;
  scrollToBottom(): void;
  setScrollOffset(offset: number): void;

  // Task panel visibility
  taskPanelVisible: boolean;
  toggleTaskPanel(): void;

  // Voice recording
  recording: boolean;
  setRecording(active: boolean): void;

  // Approval mode
  approvalMode: "approval" | "accept-all";
  toggleApprovalMode(): void;
  pendingApproval: {
    toolName: string;
    args: Record<string, unknown>;
    description: string;
    onApprove: () => void;
    onReject: () => void;
  } | null;
  setPendingApproval(pending: TUIStore["pendingApproval"]): void;
  clearPendingApproval(): void;

  // Preferences
  defaultAgent: string;
  setDefaultAgent(name: string): void;
}

export const useStore = create<TUIStore>((set) => ({
  // Stream
  lines: [],
  pushLine: (entry) =>
    set((s) => ({
      lines: [...s.lines.slice(-(MAX_LINES - 1)), entry],
      // Preserve scroll position: if user scrolled up, don't jump to bottom.
      // scrollOffset 0 = already at bottom, so new content stays visible.
      // scrollOffset > 0 = user is reading history, keep their position.
    })),
  log: (text, segs) =>
    set((s) => ({
      lines: [
        ...s.lines.slice(-(MAX_LINES - 1)),
        {
          type: "event" as const,
          segs: segs ?? [{ text }],
          ts: new Date().toISOString(),
        },
      ],
    })),
  updateLastLine: (segs) =>
    set((s) => {
      if (s.lines.length === 0) return s;
      const updated = [...s.lines];
      const last = updated[updated.length - 1]!;
      if (last.type === "response" || last.type === "event") {
        updated[updated.length - 1] = { ...last, segs };
      }
      return { lines: updated };
    }),
  clearLines: () => set({ lines: [] }),

  // Tasks & plans
  tasks: [],
  processes: [],
  plans: [],
  orchestratorStartedAt: null,
  tuiStartedAt: new Date().toISOString(),
  syncState: (state, plans) =>
    set({
      tasks: state.tasks,
      processes: state.processes,
      plans: plans ?? [],
      orchestratorStartedAt: state.startedAt ?? null,
    }),

  // Input
  inputBuffer: "",
  inputCursorPos: 0,
  setInputBuffer: (buf, cursorPos) => set({ inputBuffer: buf, inputCursorPos: cursorPos ?? buf.length }),
  inputMode: "chat",
  setInputMode: (mode) => set({ inputMode: mode }),
  history: [],
  pushHistory: (cmd) =>
    set((s) => ({
      history: [...s.history.slice(-MAX_HISTORY), cmd],
    })),

  // Pages
  page: { id: "main" },
  navigate: (page) => set({ page }),
  goMain: () => set({ page: { id: "main" } }),

  // Processing
  processing: false,
  processingLabel: "",
  processingStartedAt: null,
  processingTokens: 0,
  setProcessing: (active, label) =>
    set((s) => ({
      processing: active,
      processingLabel: label ?? "",
      processingStartedAt: active ? new Date().toISOString() : null,
      // Only reset processingTokens when starting fresh (not during an active streaming session)
      processingTokens: s.streaming ? s.processingTokens : 0,
    })),
  updateProcessingTokens: (tokens) =>
    set((s) => ({
      processingTokens: s.processingTokens + tokens,
      streamingTokens: s.streamingTokens + tokens,
    })),

  // Streaming session — persists across the entire request lifecycle
  streaming: false,
  streamingStartedAt: null,
  streamingTokens: 0,
  startStreaming: () =>
    set({
      streaming: true,
      streamingStartedAt: new Date().toISOString(),
      streamingTokens: 0,
    }),
  stopStreaming: () =>
    set({
      streaming: false,
      streamingStartedAt: null,
    }),
  updateStreamingTokens: (tokens) =>
    set((s) => ({ streamingTokens: s.streamingTokens + tokens })),

  // Chat session
  activeSessionId: null,
  setActiveSessionId: (id) => set({ activeSessionId: id }),

  // Completion menu
  completionActive: false,
  setCompletionActive: (active) => set({ completionActive: active }),

  // Stream scroll
  scrollOffset: 0,
  scrollUp: (rows) => set((s) => ({ scrollOffset: s.scrollOffset + rows })),
  scrollDown: (rows) => set((s) => ({ scrollOffset: Math.max(0, s.scrollOffset - rows) })),
  scrollToBottom: () => set({ scrollOffset: 0 }),
  setScrollOffset: (offset) => set({ scrollOffset: Math.max(0, offset) }),

  // Task panel visibility
  taskPanelVisible: true,
  toggleTaskPanel: () => set((s) => ({ taskPanelVisible: !s.taskPanelVisible })),

  // Voice recording
  recording: false,
  setRecording: (active) => set({ recording: active }),

  // Approval mode
  approvalMode: "approval",
  toggleApprovalMode: () =>
    set((s) => ({
      approvalMode: s.approvalMode === "approval" ? "accept-all" : "approval",
    })),
  pendingApproval: null,
  setPendingApproval: (pending) => set({ pendingApproval: pending }),
  clearPendingApproval: () => set({ pendingApproval: null }),

  // Preferences
  defaultAgent: "",
  setDefaultAgent: (name) => set({ defaultAgent: name }),
}));
