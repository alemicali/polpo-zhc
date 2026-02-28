/**
 * TUI state — pure UI data for chat-only interface.
 * Orchestrator lives in React Context, not here.
 */

import { create } from "zustand";

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
  | { type: "response"; segs: Seg[]; ts: string; done?: boolean }
  | { type: "system"; text: string; ts: string }
  | { type: "tool"; name: string; info?: string; state: "running" | "done" | "error"; ts: string };

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
  /** Mark the last response entry as done (● turns white). */
  markLastResponseDone(): void;
  /** Update the last tool entry state. */
  updateLastTool(state: "done" | "error", info?: string): void;
  clearLines(): void;

  // Input
  inputBuffer: string;
  inputCursorPos: number;
  setInputBuffer(buf: string, cursorPos?: number): void;
  history: string[];
  pushHistory(cmd: string): void;

  // Pages
  page: Page;
  navigate(page: Page): void;
  goMain(): void;

  // Processing indicator
  processing: boolean;
  processingLabel: string;
  setProcessing(active: boolean, label?: string): void;

  // Streaming session
  streaming: boolean;
  streamingStartedAt: string | null;
  startStreaming(): void;
  stopStreaming(): void;

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

  // Voice recording
  recording: boolean;
  setRecording(active: boolean): void;
}

export const useStore = create<TUIStore>((set) => ({
  // Stream
  lines: [],
  pushLine: (entry) =>
    set((s) => ({
      lines: [...s.lines.slice(-(MAX_LINES - 1)), entry],
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
  markLastResponseDone: () =>
    set((s) => {
      if (s.lines.length === 0) return s;
      const updated = [...s.lines];
      for (let i = updated.length - 1; i >= 0; i--) {
        if (updated[i]!.type === "response") {
          updated[i] = { ...updated[i]!, done: true } as StreamEntry;
          break;
        }
      }
      return { lines: updated };
    }),
  updateLastTool: (state, info) =>
    set((s) => {
      if (s.lines.length === 0) return s;
      const updated = [...s.lines];
      for (let i = updated.length - 1; i >= 0; i--) {
        if (updated[i]!.type === "tool") {
          const tool = updated[i] as Extract<StreamEntry, { type: "tool" }>;
          updated[i] = { ...tool, state, info: info ?? tool.info };
          break;
        }
      }
      return { lines: updated };
    }),
  clearLines: () => set({ lines: [] }),

  // Input
  inputBuffer: "",
  inputCursorPos: 0,
  setInputBuffer: (buf, cursorPos) => set({ inputBuffer: buf, inputCursorPos: cursorPos ?? buf.length }),
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
  setProcessing: (active, label) =>
    set({
      processing: active,
      processingLabel: label ?? "",
    }),

  // Streaming session
  streaming: false,
  streamingStartedAt: null,
  startStreaming: () =>
    set({
      streaming: true,
      streamingStartedAt: new Date().toISOString(),
    }),
  stopStreaming: () =>
    set({
      streaming: false,
      streamingStartedAt: null,
    }),

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

  // Voice recording
  recording: false,
  setRecording: (active) => set({ recording: active }),
}));
