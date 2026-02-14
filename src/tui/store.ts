/**
 * TUI state — pure UI data, no business logic objects.
 * Orchestrator lives in React Context, not here.
 */

import { create } from "zustand";
import type { Task, AgentProcess, OrchestraState } from "../core/types.js";

// ─── Segment (styled text unit) ─────────────────────────

export interface Seg {
  text: string;
  color?: string;
  bold?: boolean;
  dim?: boolean;
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
  clearLines(): void;

  // Tasks (snapshot from orchestrator)
  tasks: Task[];
  processes: AgentProcess[];
  syncState(state: OrchestraState): void;

  // Input
  inputBuffer: string;
  setInputBuffer(buf: string): void;
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
  setProcessing(active: boolean, label?: string): void;

  // Chat session
  activeSessionId: string | null;
  setActiveSessionId(id: string | null): void;

  // Completion menu
  completionActive: boolean;
  setCompletionActive(active: boolean): void;

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

  // Tasks
  tasks: [],
  processes: [],
  syncState: (state) =>
    set({
      tasks: state.tasks,
      processes: state.processes,
    }),

  // Input
  inputBuffer: "",
  setInputBuffer: (buf) => set({ inputBuffer: buf }),
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
  setProcessing: (active, label) =>
    set({ processing: active, processingLabel: label ?? "" }),

  // Chat session
  activeSessionId: null,
  setActiveSessionId: (id) => set({ activeSessionId: id }),

  // Completion menu
  completionActive: false,
  setCompletionActive: (active) => set({ completionActive: active }),

  // Preferences
  defaultAgent: "",
  setDefaultAgent: (name) => set({ defaultAgent: name }),
}));
