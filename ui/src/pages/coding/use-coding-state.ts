/**
 * The Coding app's state, shared by the page and its navigation (the drill-in sidebar's Coding
 * level, the chat-first layout's column, the sessions sheet): projects, sessions (terminals and
 * coding chats), the active one, worktrees with no session yet. One store for the whole dashboard,
 * synced to the server (/api/v1/coding/sessions) and to this browser.
 *
 * New Claude Code / Codex sessions are coding chats (the CLI engine, a chat transcript): the store
 * creates the chat on the server (POST /api/v1/coding/chats) and keeps its id on the session.
 * Terminal sessions, and older claude / codex sessions without a chat id, stay terminals.
 */
import { useSyncExternalStore } from "react";
import { apiFetch, apiUrl } from "@/lib/config";
import type { CodingCodeServerSession, CodingTerminal, CodingWorkspace, ConnectionState, PendingWorkspace } from "./types";

const STORAGE_KEY = "polpo-coding-layout";
const PENDING_KEY = "polpo:coding:pendingWorkspaces";
const ACTIVE_PENDING_KEY = "polpo:coding:activePendingKey";
const SYNC_EVENT = "polpo:coding-state-sync";

function makeId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

export type PersistedCodingState = {
  workspaces: CodingWorkspace[];
  terminals: CodingTerminal[];
  codeServers: CodingCodeServerSession[];
  activeId: string;
};

export interface CodingStoreState extends PersistedCodingState {
  connections: Record<string, ConnectionState>;
  pendingWorkspaces: PendingWorkspace[];
  activePendingKey: string | null;
  /** Bumped when a coding chat changed files in a worktree: the changes panel refreshes. */
  changesRevision: number;
  /** How many navigation panels show the sessions outside the page (the page offers its own sheet when none). */
  navPanels: number;
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
}

function defaultState(): PersistedCodingState {
  const workspaceId = makeId("workspace");
  const terminalId = makeId("terminal");
  return {
    workspaces: [{ id: workspaceId, name: "Workspace", cwd: "." }],
    terminals: [{ id: terminalId, workspaceId, label: "", revision: 0 }],
    codeServers: [],
    activeId: terminalId,
  };
}

function readStored(): PersistedCodingState {
  const parsed = readJson<{ workspaces?: CodingWorkspace[]; terminals?: Array<Record<string, unknown>>; activeId?: string; codeServers?: unknown } | null>(STORAGE_KEY, null);
  if (!parsed?.workspaces?.length || !parsed.terminals?.length || !parsed.activeId) return defaultState();
  // older shapes: `name` → `label`
  const terminals = parsed.terminals.map((t) => ({
    ...(t as unknown as CodingTerminal),
    id: String(t.id),
    workspaceId: String(t.workspaceId),
    label: typeof t.label === "string" ? t.label : typeof t.name === "string" ? t.name : "",
    revision: typeof t.revision === "number" ? t.revision : 0,
  }));
  return {
    workspaces: parsed.workspaces,
    terminals,
    codeServers: Array.isArray(parsed.codeServers) ? (parsed.codeServers as CodingCodeServerSession[]) : [],
    activeId: parsed.activeId,
  };
}

// ── The store ──

let state: CodingStoreState | null = null;
const listeners = new Set<() => void>();
let hydrated = false;
let hydrating = false;
let saveTimer: ReturnType<typeof setTimeout> | undefined;

function init(): CodingStoreState {
  if (!state) {
    state = {
      ...readStored(),
      connections: {},
      pendingWorkspaces: readJson<PendingWorkspace[]>(PENDING_KEY, []),
      activePendingKey: readJson<string | null>(ACTIVE_PENDING_KEY, null),
      changesRevision: 0,
      navPanels: 0,
    };
  }
  return state;
}

function persisted(s: CodingStoreState): PersistedCodingState {
  return {
    workspaces: s.workspaces,
    terminals: s.terminals.map(({ chatError: _e, ...t }) => t),
    codeServers: s.codeServers,
    activeId: s.activeId,
  };
}

function set(update: (s: CodingStoreState) => Partial<CodingStoreState>): void {
  const prev = init();
  const patch = update(prev);
  state = { ...prev, ...patch };
  const layoutChanged = ["workspaces", "terminals", "codeServers", "activeId"].some((k) => k in patch);
  if (layoutChanged) {
    writeJson(STORAGE_KEY, persisted(state));
    if (hydrated) {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => { void saveServerState(persisted(state!)).catch(() => undefined); }, 300);
    }
  }
  if ("pendingWorkspaces" in patch) writeJson(PENDING_KEY, state.pendingWorkspaces);
  if ("activePendingKey" in patch) writeJson(ACTIVE_PENDING_KEY, state.activePendingKey);
  for (const l of listeners) l();
}

async function fetchServerState(): Promise<{ state: PersistedCodingState; initialized: boolean }> {
  const res = await apiFetch(apiUrl("/api/v1/coding/sessions"));
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.ok) throw new Error(body?.error || `Coding sessions request failed (${res.status})`);
  return body.data as { state: PersistedCodingState; initialized: boolean };
}

async function saveServerState(s: PersistedCodingState): Promise<void> {
  const res = await apiFetch(apiUrl("/api/v1/coding/sessions"), {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(s),
  });
  if (!res.ok) throw new Error(`Coding sessions save failed (${res.status})`);
}

function hydrate(): void {
  if (hydrated || hydrating) return;
  hydrating = true;
  fetchServerState()
    .then(({ state: server, initialized }) => {
      const next = initialized ? server : readStored();
      hydrated = true;
      set(() => ({ workspaces: next.workspaces, terminals: next.terminals, codeServers: next.codeServers ?? [], activeId: next.activeId }));
      if (!initialized) void saveServerState(next).catch(() => undefined);
    })
    .catch(() => { hydrated = true; })
    .finally(() => { hydrating = false; });
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  hydrate();
  const sync = (event: Event) => {
    const s = (event as CustomEvent<PersistedCodingState>).detail;
    if (s) set(() => ({ workspaces: s.workspaces, terminals: s.terminals, codeServers: s.codeServers ?? [], activeId: s.activeId }));
  };
  if (listeners.size === 1) window.addEventListener(SYNC_EVENT, sync);
  return () => {
    listeners.delete(fn);
    if (!listeners.size) window.removeEventListener(SYNC_EVENT, sync);
  };
}

/** Another part of the dashboard replaced the layout (e.g. the app preview). */
export function syncCodingState(s: PersistedCodingState): void {
  writeJson(STORAGE_KEY, s);
  window.dispatchEvent(new CustomEvent<PersistedCodingState>(SYNC_EVENT, { detail: s }));
}

/** Tests: start from a clean store. */
export function resetCodingStoreForTests(next?: Partial<CodingStoreState>): void {
  state = null;
  hydrated = true;
  hydrating = false;
  init();
  if (next) state = { ...state!, ...next };
  for (const l of listeners) l();
}

// ── Actions ──

/** The cwd a session works in: its worktree, else its project's folder. */
export function sessionCwd(s: Pick<CodingStoreState, "workspaces">, t: CodingTerminal): string {
  return t.cwdOverride || s.workspaces.find((w) => w.id === t.workspaceId)?.cwd || ".";
}

async function createChat(terminalId: string, kind: "claude" | "codex"): Promise<void> {
  const s = init();
  const t = s.terminals.find((x) => x.id === terminalId);
  if (!t) return;
  try {
    const res = await apiFetch(apiUrl("/api/v1/coding/chats"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind, cwd: sessionCwd(s, t), workspaceId: t.workspaceId,
        ...(t.branch ? { branch: t.branch } : {}),
        ...(t.label ? { title: t.label } : {}),
      }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body?.ok) throw new Error(body?.error || `Could not start the session (${res.status})`);
    const chatId = body.data.id as string;
    set((cur) => ({ terminals: cur.terminals.map((x) => (x.id === terminalId ? { ...x, chatId, chatError: undefined } : x)) }));
  } catch (err) {
    const chatError = err instanceof Error ? err.message : String(err);
    set((cur) => ({ terminals: cur.terminals.map((x) => (x.id === terminalId ? { ...x, chatError } : x)) }));
  }
}

export interface AddTerminalOptions {
  agentKind?: CodingTerminal["agentKind"];
  agentCommand?: string;
  cwdOverride?: string;
  branch?: string;
  label?: string;
  /** Friendly workspace name (preserves identity across branch renames). */
  workspaceLabel?: string;
  /** Do not steal focus (fire-and-forget actions like the PR button). */
  silent?: boolean;
  /** Claude Code / Codex as a terminal anyway (the PR one-shot command). */
  terminal?: boolean;
  /** Adopt an existing coding chat. */
  chatId?: string;
}

export const codingActions = {
  setActiveId(id: string) {
    set(() => ({ activeId: id, activePendingKey: null }));
  },
  setActivePendingKey(key: string | null) {
    set(() => ({ activePendingKey: key }));
  },
  setConnection(id: string, c: ConnectionState) {
    set((s) => ({ connections: { ...s.connections, [id]: c } }));
  },
  bumpChanges() {
    set((s) => ({ changesRevision: s.changesRevision + 1 }));
  },
  registerNavPanel(): () => void {
    set((s) => ({ navPanels: s.navPanels + 1 }));
    return () => set((s) => ({ navPanels: Math.max(0, s.navPanels - 1) }));
  },
  addWorkspace(opts?: { cwd?: string; name?: string }) {
    const cwd = opts?.cwd ?? ".";
    const name = opts?.name ?? (cwd === "." ? "Workspace" : cwd.split("/").filter(Boolean).pop() ?? "Workspace");
    const workspace: CodingWorkspace = { id: makeId("workspace"), name, cwd };
    const terminal: CodingTerminal = { id: makeId("terminal"), workspaceId: workspace.id, label: "", revision: 0 };
    set((s) => ({ workspaces: [...s.workspaces, workspace], terminals: [...s.terminals, terminal], activeId: terminal.id, activePendingKey: null }));
  },
  addTerminal(workspaceId: string, opts?: AddTerminalOptions): string {
    const kind = opts?.agentKind;
    const agent = !!kind && kind !== "terminal";
    // new Claude Code / Codex sessions are chats, unless a command pins them to a terminal
    const chat = agent && !opts?.agentCommand && !opts?.terminal;
    const id = makeId("terminal");
    set((s) => {
      const used = new Set<number>();
      for (const t of s.terminals) {
        if (t.workspaceId !== workspaceId) continue;
        const m = t.label.match(/^Session (\d+)$/);
        if (m) used.add(Number(m[1]));
      }
      let n = 1;
      while (used.has(n)) n++;
      const terminal: CodingTerminal = {
        id,
        workspaceId,
        label: opts?.label?.trim() ? opts.label : `Session ${n}`,
        revision: 0,
        agentKind: kind,
        agentSessionId: agent && !chat
          ? (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID() : makeId("agent"))
          : undefined,
        agentCommand: opts?.agentCommand,
        cwdOverride: opts?.cwdOverride,
        branch: opts?.branch,
        workspaceLabel: opts?.workspaceLabel,
        ...(opts?.chatId ? { chatId: opts.chatId } : {}),
      };
      return { terminals: [...s.terminals, terminal], ...(opts?.silent ? {} : { activeId: id, activePendingKey: null }) };
    });
    if (chat && !opts?.chatId) void createChat(id, kind as "claude" | "codex");
    return id;
  },
  closeTerminal(id: string) {
    const t = init().terminals.find((x) => x.id === id);
    if (t?.chatId) {
      void apiFetch(apiUrl(`/api/v1/coding/chats/${encodeURIComponent(t.chatId)}/stop`), { method: "POST" }).catch(() => undefined);
    } else {
      // kill the server-side pty too, or it runs until the server restarts
      void apiFetch(apiUrl(`/api/v1/coding/processes/terminal/${encodeURIComponent(id)}`), { method: "DELETE" }).catch(() => undefined);
    }
    set((s) => {
      const index = s.terminals.findIndex((x) => x.id === id);
      const next = s.terminals.filter((x) => x.id !== id);
      const { [id]: _gone, ...connections } = s.connections;
      return {
        terminals: next,
        connections,
        activeId: s.activeId === id ? (next[Math.max(0, index - 1)]?.id ?? next[0]?.id ?? "") : s.activeId,
      };
    });
  },
  closeWorkspace(workspaceId: string) {
    const removed = init().terminals.filter((t) => t.workspaceId === workspaceId);
    for (const t of removed) {
      if (t.chatId) void apiFetch(apiUrl(`/api/v1/coding/chats/${encodeURIComponent(t.chatId)}/stop`), { method: "POST" }).catch(() => undefined);
      else void apiFetch(apiUrl(`/api/v1/coding/processes/terminal/${encodeURIComponent(t.id)}`), { method: "DELETE" }).catch(() => undefined);
    }
    void apiFetch(apiUrl("/api/v1/coding/code-server/stop"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId }),
    }).catch(() => undefined);
    const ids = new Set(removed.map((t) => t.id));
    set((s) => {
      const terminals = s.terminals.filter((t) => !ids.has(t.id));
      return {
        terminals,
        workspaces: s.workspaces.filter((w) => w.id !== workspaceId),
        codeServers: s.codeServers.filter((c) => c.workspaceId !== workspaceId),
        connections: Object.fromEntries(Object.entries(s.connections).filter(([k]) => !ids.has(k))),
        activeId: ids.has(s.activeId) ? (terminals[0]?.id ?? "") : s.activeId,
      };
    });
  },
  renameTerminal(id: string, label: string) {
    set((s) => ({ terminals: s.terminals.map((t) => (t.id === id ? { ...t, label } : t)) }));
  },
  /** Hide a session from the tabs without ending it (History brings it back). */
  hideTerminalTab(id: string) {
    set((s) => {
      const target = s.terminals.find((t) => t.id === id);
      if (!target) return {};
      const next = s.terminals.map((t) => (t.id === id ? { ...t, tabHidden: true } : t));
      if (id !== s.activeId) return { terminals: next };
      const sameWt = next.find((t) => !t.tabHidden && t.id !== id && t.workspaceId === target.workspaceId
        && (t.branch || "") === (target.branch || "") && (t.cwdOverride || "") === (target.cwdOverride || ""));
      const sameProject = sameWt ?? next.find((t) => !t.tabHidden && t.id !== id && t.workspaceId === target.workspaceId);
      const fallback = sameProject ?? next.find((t) => !t.tabHidden && t.id !== id);
      return { terminals: next, activeId: fallback?.id ?? "" };
    });
  },
  unhideTerminalTab(id: string) {
    set((s) => ({ terminals: s.terminals.map((t) => (t.id === id ? { ...t, tabHidden: false } : t)), activeId: id, activePendingKey: null }));
  },
  reorderTerminal(sourceId: string, targetId: string) {
    if (sourceId === targetId) return;
    set((s) => {
      const src = s.terminals.findIndex((t) => t.id === sourceId);
      const tgt = s.terminals.findIndex((t) => t.id === targetId);
      if (src < 0 || tgt < 0) return {};
      const next = s.terminals.slice();
      const [moved] = next.splice(src, 1);
      next.splice(tgt, 0, moved!);
      return { terminals: next };
    });
  },
  updateWorkspace(id: string, patch: Partial<Pick<CodingWorkspace, "name" | "cwd">>) {
    set((s) => ({ workspaces: s.workspaces.map((w) => (w.id === id ? { ...w, ...patch } : w)) }));
  },
  restartTerminal(id: string) {
    set((s) => ({ terminals: s.terminals.map((t) => (t.id === id ? { ...t, revision: t.revision + 1 } : t)) }));
  },
  /** "+ Add workspace": a worktree on disk with a city name, then the quick-start screen. */
  async addWorkspaceFast(projectId: string): Promise<void> {
    const project = init().workspaces.find((w) => w.id === projectId);
    if (!project) return;
    const branch = autoBranchName();
    const res = await apiFetch(apiUrl("/api/v1/git/worktree/create"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd: project.cwd, branch }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body?.ok) throw new Error(body?.error || `Worktree create failed (${res.status})`);
    const cwd = body.data.path as string;
    const resolvedBranch = (body.data.branch as string) || branch;
    const key = `${projectId}::${resolvedBranch}::${cwd}`;
    set((s) => ({
      pendingWorkspaces: s.pendingWorkspaces.some((p) => p.key === key) ? s.pendingWorkspaces : [...s.pendingWorkspaces, { key, projectId, branch: resolvedBranch, cwd, label: branch }],
      activePendingKey: key,
    }));
  },
  /** The quick-start's cards: the first session of a new worktree (claude / codex: a chat). */
  startQuickSession(kind: "terminal" | "claude" | "codex") {
    const s = init();
    const pending = s.pendingWorkspaces.find((p) => p.key === s.activePendingKey);
    if (!pending) return;
    codingActions.addTerminal(pending.projectId, { agentKind: kind, cwdOverride: pending.cwd, branch: pending.branch, workspaceLabel: pending.label });
    set((cur) => ({ pendingWorkspaces: cur.pendingWorkspaces.filter((p) => p.key !== pending.key), activePendingKey: null }));
  },
  /** Open a coding chat by its id (a link: /coding?chat=…): its session, or a new tab for it. */
  async openChat(chatId: string): Promise<void> {
    const s = init();
    const existing = s.terminals.find((t) => t.chatId === chatId);
    if (existing) {
      set((cur) => ({ activeId: existing.id, activePendingKey: null, terminals: cur.terminals.map((t) => (t.id === existing.id ? { ...t, tabHidden: false } : t)) }));
      return;
    }
    const res = await apiFetch(apiUrl(`/api/v1/coding/chats/${encodeURIComponent(chatId)}`));
    const body = await res.json().catch(() => null);
    if (!res.ok || !body?.ok) throw new Error(body?.error || `Coding chat ${chatId} not found`);
    const chat = body.data as { kind: "claude" | "codex"; cwd: string; branch?: string; title: string; workspaceId?: string };
    const cur = init();
    const project = cur.workspaces.find((w) => w.id === chat.workspaceId)
      ?? cur.workspaces.find((w) => w.cwd !== "." && chat.cwd.startsWith(w.cwd))
      ?? cur.workspaces[0];
    if (!project) return;
    codingActions.addTerminal(project.id, {
      agentKind: chat.kind, chatId, label: chat.title,
      ...(chat.cwd !== project.cwd ? { cwdOverride: chat.cwd } : {}),
      ...(chat.branch ? { branch: chat.branch } : {}),
    });
  },
};

const CITIES = [
  "nagoya", "montreal", "salvador", "khartoum", "lisbon", "tokyo", "oslo", "vienna", "paris", "kyoto", "helsinki", "dublin", "prague", "vancouver",
  "lima", "athens", "dakar", "manila", "tunis", "cairo", "hanoi", "rome", "berlin", "madrid", "london", "sydney", "austin", "denver", "taipei",
  "seoul", "beirut", "mumbai", "bogota", "nairobi", "riga", "sofia", "zurich", "geneva", "valencia", "porto", "naples", "milan", "turin",
  "bologna", "florence", "venice", "palermo", "genoa", "bari", "trieste",
];

/** Conductor-style names: a city and a short suffix (unique in the repo; the label survives renames). */
function autoBranchName(): string {
  const c = CITIES[Math.floor(Math.random() * CITIES.length)] ?? "session";
  return `${c}-${Math.random().toString(36).slice(2, 5)}`;
}

function getSnapshot(): CodingStoreState {
  return init();
}

/** The Coding app's state and actions (one store for the page and its navigation). */
export function useCodingState() {
  const s = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return { ...s, ...codingActions };
}
