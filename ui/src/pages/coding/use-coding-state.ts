import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiUrl } from "@/lib/config";
import type { CodingCodeServerSession, CodingTerminal, CodingWorkspace, ConnectionState } from "./types";

const STORAGE_KEY = "polpo-coding-layout";
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

export function syncCodingState(state: PersistedCodingState): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  window.dispatchEvent(new CustomEvent<PersistedCodingState>(SYNC_EVENT, { detail: state }));
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
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    const parsed = JSON.parse(raw) as { workspaces?: CodingWorkspace[]; terminals?: Array<Record<string, unknown>>; activeId?: string };
    if (!parsed.workspaces?.length || !parsed.terminals?.length || !parsed.activeId) return defaultState();
    // Migrate `name` → `label` from older shape
    const terminals: CodingTerminal[] = parsed.terminals.map((t) => ({
      id: String(t.id),
      workspaceId: String(t.workspaceId),
      label: typeof t.label === "string" ? t.label : typeof t.name === "string" ? t.name : "",
      revision: typeof t.revision === "number" ? t.revision : 0,
    }));
    return {
      workspaces: parsed.workspaces as CodingWorkspace[],
      terminals,
      codeServers: Array.isArray((parsed as any).codeServers) ? (parsed as any).codeServers as CodingCodeServerSession[] : [],
      activeId: parsed.activeId,
    };
  } catch {
    return defaultState();
  }
}

async function fetchServerState(): Promise<{ state: PersistedCodingState; initialized: boolean }> {
  const res = await fetch(apiUrl("/api/v1/coding/sessions"), { credentials: "include" });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.ok) {
    throw new Error(body?.error || `Coding sessions request failed (${res.status})`);
  }
  return body.data as { state: PersistedCodingState; initialized: boolean };
}

async function saveServerState(state: PersistedCodingState): Promise<void> {
  const res = await fetch(apiUrl("/api/v1/coding/sessions"), {
    method: "PATCH",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(state),
  });
  if (!res.ok) throw new Error(`Coding sessions save failed (${res.status})`);
}

export function useCodingState() {
  const initial = useMemo(readStored, []);
  const [workspaces, setWorkspaces] = useState<CodingWorkspace[]>(initial.workspaces);
  const [terminals, setTerminals] = useState<CodingTerminal[]>(initial.terminals);
  const [codeServers, setCodeServers] = useState<CodingCodeServerSession[]>(initial.codeServers);
  const [activeId, setActiveId] = useState(initial.activeId);
  const [connections, setConnections] = useState<Record<string, ConnectionState>>({});
  const hydratedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;

    fetchServerState()
      .then(({ state, initialized }) => {
        if (cancelled) return;
        const next = initialized ? state : readStored();
        setWorkspaces(next.workspaces);
        setTerminals(next.terminals);
        setCodeServers(next.codeServers ?? []);
        setActiveId(next.activeId);
        hydratedRef.current = true;
        if (!initialized) void saveServerState(next).catch(() => undefined);
      })
      .catch(() => {
        if (cancelled) return;
        hydratedRef.current = true;
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const sync = (event: Event) => {
      const state = (event as CustomEvent<PersistedCodingState>).detail;
      if (!state) return;
      setWorkspaces(state.workspaces);
      setTerminals(state.terminals);
      setCodeServers(state.codeServers ?? []);
      setActiveId(state.activeId);
      hydratedRef.current = true;
    };
    window.addEventListener(SYNC_EVENT, sync);
    return () => window.removeEventListener(SYNC_EVENT, sync);
  }, []);

  useEffect(() => {
    const state = { workspaces, terminals, codeServers, activeId };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    if (!hydratedRef.current) return;
    const timeout = window.setTimeout(() => {
      void saveServerState(state).catch(() => undefined);
    }, 300);
    return () => window.clearTimeout(timeout);
  }, [activeId, codeServers, terminals, workspaces]);

  const addWorkspace = useCallback((opts?: { cwd?: string; name?: string }) => {
    const cwd = opts?.cwd ?? ".";
    const name = opts?.name ?? (cwd === "." ? "Workspace" : cwd.split("/").filter(Boolean).pop() ?? "Workspace");
    const workspace: CodingWorkspace = {
      id: makeId("workspace"),
      name,
      cwd,
    };
    const terminal: CodingTerminal = {
      id: makeId("terminal"),
      workspaceId: workspace.id,
      label: "",
      revision: 0,
    };
    setWorkspaces((current) => [...current, workspace]);
    setTerminals((current) => [...current, terminal]);
    setActiveId(terminal.id);
  }, []);

  const addTerminal = useCallback((
    workspaceId: string,
    opts?: {
      agentKind?: CodingTerminal["agentKind"];
      agentCommand?: string;
      cwdOverride?: string;
      branch?: string;
      label?: string;
      /** Friendly workspace name (preserves identity across branch renames). */
      workspaceLabel?: string;
      /** When true, do not steal focus to the new terminal. Used for
       * fire-and-forget actions like the PR button — the session is
       * still in the sidebar so the user can monitor/kill it, but their
       * current terminal stays in view. */
      silent?: boolean;
    },
  ) => {
    const useAgent = !!opts?.agentKind && opts.agentKind !== "terminal";
    const id = makeId("terminal");
    setTerminals((current) => {
      // Pick the lowest available "Session N" slot in this workspace —
      // never reuse a number that another live terminal already owns,
      // even after the user has closed earlier sessions.
      const used = new Set<number>();
      for (const t of current) {
        if (t.workspaceId !== workspaceId) continue;
        const m = t.label.match(/^Session (\d+)$/);
        if (m) used.add(Number(m[1]));
      }
      let n = 1;
      while (used.has(n)) n++;
      const autoLabel = `Session ${n}`;
      const terminal: CodingTerminal = {
        id,
        workspaceId,
        label: opts?.label?.trim() ? opts.label : autoLabel,
        revision: 0,
        agentKind: opts?.agentKind,
        // crypto.randomUUID is available in modern browsers; we generate the
        // id up-front so the agent CLI gets a stable handle for --resume.
        agentSessionId: useAgent
          ? (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID() : makeId("agent"))
          : undefined,
        agentCommand: opts?.agentCommand,
        cwdOverride: opts?.cwdOverride,
        branch: opts?.branch,
        workspaceLabel: opts?.workspaceLabel,
      };
      return [...current, terminal];
    });
    if (!opts?.silent) setActiveId(id);
    return id;
  }, []);

  const closeTerminal = useCallback((id: string) => {
    // Kill the server-side pty too — otherwise archiving from the UI just
    // hides the row and leaves an orphan process running until the polpo
    // server itself restarts.
    void fetch(apiUrl(`/api/v1/coding/processes/terminal/${encodeURIComponent(id)}`), {
      method: "DELETE",
      credentials: "include",
    }).catch(() => undefined);
    setTerminals((current) => {
      const index = current.findIndex((t) => t.id === id);
      const next = current.filter((t) => t.id !== id);
      setActiveId((prev) => (prev === id ? (next[Math.max(0, index - 1)]?.id ?? next[0]?.id ?? "") : prev));
      setConnections(({ [id]: _gone, ...rest }) => rest);
      return next;
    });
  }, []);

  const closeWorkspace = useCallback((workspaceId: string) => {
    setTerminals((currentTerminals) => {
      const removedIds = new Set(currentTerminals.filter((t) => t.workspaceId === workspaceId).map((t) => t.id));
      // Kill server-side ptys for every terminal owned by this workspace.
      for (const id of removedIds) {
        void fetch(apiUrl(`/api/v1/coding/processes/terminal/${encodeURIComponent(id)}`), {
          method: "DELETE",
          credentials: "include",
        }).catch(() => undefined);
      }
      const nextTerminals = currentTerminals.filter((t) => !removedIds.has(t.id));
      setActiveId((prev) => (removedIds.has(prev) ? (nextTerminals[0]?.id ?? "") : prev));
      setConnections((current) => {
        const next: Record<string, ConnectionState> = {};
        for (const [id, state] of Object.entries(current)) {
          if (!removedIds.has(id)) next[id] = state;
        }
        return next;
      });
      return nextTerminals;
    });
    // Stop the workspace's code-server too so we don't leave that process hanging.
    void fetch(apiUrl(`/api/v1/coding/code-server/stop`), {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId }),
    }).catch(() => undefined);
    setWorkspaces((current) => current.filter((w) => w.id !== workspaceId));
    setCodeServers((current) => current.filter((session) => session.workspaceId !== workspaceId));
  }, []);

  const renameTerminal = useCallback((id: string, label: string) => {
    setTerminals((current) => current.map((t) => (t.id === id ? { ...t, label } : t)));
  }, []);

  /** Hide a session from the tabs strip without killing it. The pty keeps
   * running on the server; the user re-opens via the History popover. */
  const hideTerminalTab = useCallback((id: string) => {
    setTerminals((current) => {
      const target = current.find((t) => t.id === id);
      if (!target) return current;
      const next = current.map((t) => (t.id === id ? { ...t, tabHidden: true } : t));
      // If we just hid the active tab, jump to another visible sibling
      // in the same worktree (or any visible tab in the project, then
      // anywhere). Avoids leaving the user staring at a hidden session.
      if (id === activeId) {
        const sameWt = next.find((t) =>
          !t.tabHidden && t.id !== id
            && t.workspaceId === target.workspaceId
            && (t.branch || "") === (target.branch || "")
            && (t.cwdOverride || "") === (target.cwdOverride || ""));
        const sameProject = sameWt ?? next.find((t) => !t.tabHidden && t.id !== id && t.workspaceId === target.workspaceId);
        const fallback = sameProject ?? next.find((t) => !t.tabHidden && t.id !== id);
        setActiveId(fallback?.id ?? "");
      }
      return next;
    });
  }, [activeId]);

  const unhideTerminalTab = useCallback((id: string) => {
    setTerminals((current) => current.map((t) => (t.id === id ? { ...t, tabHidden: false } : t)));
    setActiveId(id);
  }, []);

  /** Move terminal `sourceId` to occupy `targetId`'s slot. Reorders the
   * underlying array so the visual order in the tab strip persists. */
  const reorderTerminal = useCallback((sourceId: string, targetId: string) => {
    if (sourceId === targetId) return;
    setTerminals((current) => {
      const srcIdx = current.findIndex((t) => t.id === sourceId);
      const tgtIdx = current.findIndex((t) => t.id === targetId);
      if (srcIdx < 0 || tgtIdx < 0) return current;
      const next = current.slice();
      const [moved] = next.splice(srcIdx, 1);
      next.splice(tgtIdx, 0, moved!);
      return next;
    });
  }, []);

  const updateWorkspace = useCallback((id: string, patch: Partial<Pick<CodingWorkspace, "name" | "cwd">>) => {
    setWorkspaces((current) => current.map((w) => (w.id === id ? { ...w, ...patch } : w)));
  }, []);

  const restartTerminal = useCallback((id: string) => {
    setTerminals((current) => current.map((t) => (t.id === id ? { ...t, revision: t.revision + 1 } : t)));
  }, []);

  const setConnection = useCallback((id: string, state: ConnectionState) => {
    setConnections((current) => ({ ...current, [id]: state }));
  }, []);

  return {
    workspaces,
    terminals,
    codeServers,
    activeId,
    connections,
    setActiveId,
    addWorkspace,
    closeWorkspace,
    addTerminal,
    closeTerminal,
    hideTerminalTab,
    unhideTerminalTab,
    reorderTerminal,
    renameTerminal,
    updateWorkspace,
    restartTerminal,
    setConnection,
  };
}
