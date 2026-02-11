import { create } from "zustand";
import type { Orchestrator } from "../orchestrator.js";
import type { OrchestraState, ProjectConfig } from "../core/types.js";

// ─── Log Entry ──────────────────────────────────────────

export type LogSeg = { text: string; color?: string; bold?: boolean; dim?: boolean };

export interface LogEntry {
  text: string;
  segments?: LogSeg[];
  type: "event" | "verbose" | "always";
  ts: number;
}

// ─── Overlay Types ──────────────────────────────────────

export type OverlayType =
  | "plan-preview"
  | "task-browser"
  | "picker"
  | "text-input"
  | "content-viewer"
  | "yaml-editor"
  | null;

// ─── Menu Types ─────────────────────────────────────────

export interface MenuItem {
  label: string;
  value: string;
  description?: string;
}

// ─── Store Interface ────────────────────────────────────

export interface TUIStore {
  // Orchestrator
  orchestrator: Orchestrator | null;
  state: OrchestraState | null;
  config: ProjectConfig;
  workDir: string;
  defaultAgent: string;

  // UI state
  inputMode: "task" | "plan" | "chat";
  inputBuffer: string;
  processing: boolean;
  processingStart: number;
  processingLabel: string;
  processingDetail: string;
  taskPanelVisible: boolean;
  verboseLog: boolean;
  frame: number;
  quitting: boolean;

  // Log
  logs: LogEntry[];
  fullLogLines: string[];
  eventLogLines: string[];

  // Overlay
  activeOverlay: OverlayType;
  overlayProps: Record<string, unknown>;

  // Menu
  menuType: "command" | "agent" | null;
  menuItems: MenuItem[];
  menuIndex: number;
  menuJustClosed: boolean;

  // Actions
  setOrchestrator(o: Orchestrator): void;
  setState(s: OrchestraState): void;
  setConfig(c: ProjectConfig): void;
  setWorkDir(d: string): void;
  setDefaultAgent(name: string): void;

  addLog(entry: LogEntry): void;
  log(msg: string): void;
  logAlways(msg: string, segments?: LogSeg[]): void;
  logEvent(msg: string, segments?: LogSeg[]): void;
  clearLogs(): void;

  setInputMode(mode: "task" | "plan" | "chat"): void;
  toggleMode(): void;
  setInputBuffer(buf: string): void;
  setProcessing(active: boolean, label?: string): void;
  setProcessingDetail(detail: string): void;
  toggleTaskPanel(): void;
  toggleVerbose(): void;
  tick(): void;
  setQuitting(q: boolean): void;

  openOverlay(type: OverlayType, props?: Record<string, unknown>): void;
  closeOverlay(): void;

  setMenu(type: "command" | "agent" | null, items?: MenuItem[]): void;
  setMenuIndex(n: number): void;
  setMenuJustClosed(v: boolean): void;

  loadState(): void;
}

// ─── Store Implementation ───────────────────────────────

const MAX_LOGS = 2000;

export const useTUIStore = create<TUIStore>((set, get) => ({
  // Orchestrator
  orchestrator: null,
  state: null,
  config: { project: "", judge: "claude-sdk", judgeModel: "claude-sonnet-4-5-20250929", agent: "claude-sdk", model: "claude-sonnet-4-5-20250929" },
  workDir: ".",
  defaultAgent: "dev",

  // UI state
  inputMode: "task",
  inputBuffer: "",
  processing: false,
  processingStart: 0,
  processingLabel: "",
  processingDetail: "",
  taskPanelVisible: true,
  verboseLog: false,
  frame: 0,
  quitting: false,

  // Log
  logs: [],
  fullLogLines: [],
  eventLogLines: [],

  // Overlay
  activeOverlay: null,
  overlayProps: {},

  // Menu
  menuType: null,
  menuItems: [],
  menuIndex: 0,
  menuJustClosed: false,

  // Actions
  setOrchestrator: (o) => set({ orchestrator: o }),
  setState: (s) => set({ state: s }),
  setConfig: (c) => set({ config: c }),
  setWorkDir: (d) => set({ workDir: d }),
  setDefaultAgent: (name) => set({ defaultAgent: name }),

  addLog: (entry) => set((s) => {
    const logs = s.logs.length >= MAX_LOGS
      ? [...s.logs.slice(-MAX_LOGS + 1), entry]
      : [...s.logs, entry];
    return { logs };
  }),

  log: (msg) => {
    const entry: LogEntry = { text: msg, type: "verbose", ts: Date.now() };
    get().addLog(entry);
    set((s) => ({ fullLogLines: [...s.fullLogLines, msg] }));
  },

  logAlways: (msg, segments) => {
    const entry: LogEntry = { text: msg, segments, type: "always", ts: Date.now() };
    get().addLog(entry);
    set((s) => ({
      fullLogLines: [...s.fullLogLines, msg],
      eventLogLines: [...s.eventLogLines, msg],
    }));
  },

  logEvent: (msg, segments) => {
    const entry: LogEntry = { text: msg, segments, type: "event", ts: Date.now() };
    get().addLog(entry);
    set((s) => ({
      fullLogLines: [...s.fullLogLines, msg],
      eventLogLines: [...s.eventLogLines, msg],
    }));
  },

  clearLogs: () => set({ logs: [], fullLogLines: [], eventLogLines: [] }),

  setInputMode: (mode) => set({ inputMode: mode }),
  toggleMode: () => set((s) => {
    const modes: Array<"task" | "plan" | "chat"> = ["task", "plan", "chat"];
    const idx = modes.indexOf(s.inputMode);
    return { inputMode: modes[(idx + 1) % modes.length] };
  }),

  setInputBuffer: (buf) => set({ inputBuffer: buf }),

  setProcessing: (active, label) => set({
    processing: active,
    processingLabel: label ?? "",
    processingDetail: "",
    processingStart: active ? Date.now() : 0,
  }),

  setProcessingDetail: (detail) => set({ processingDetail: detail }),

  toggleTaskPanel: () => set((s) => ({ taskPanelVisible: !s.taskPanelVisible })),
  toggleVerbose: () => set((s) => ({ verboseLog: !s.verboseLog })),

  tick: () => set((s) => ({ frame: s.frame + 1 })),

  setQuitting: (q) => set({ quitting: q }),

  openOverlay: (type, props) => set({
    activeOverlay: type,
    overlayProps: props ?? {},
  }),

  closeOverlay: () => set({
    activeOverlay: null,
    overlayProps: {},
  }),

  setMenu: (type, items) => set({
    menuType: type,
    menuItems: items ?? [],
    menuIndex: 0,
  }),

  setMenuIndex: (n) => set({ menuIndex: n }),

  setMenuJustClosed: (v) => set({ menuJustClosed: v }),

  loadState: () => {
    const orch = get().orchestrator;
    if (!orch) return;
    try {
      const newState = orch.getStore().getState();
      if (newState) set({ state: newState });
    } catch {
      // Store not ready
    }
  },
}));
