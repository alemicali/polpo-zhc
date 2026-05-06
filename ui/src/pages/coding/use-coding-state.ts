import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiUrl } from "@/lib/config";
import type { CodingCodeServerSession, CodingTerminal, CodingWorkspace, ConnectionState } from "./types";

const STORAGE_KEY = "polpo-coding-layout";

function makeId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

type Persisted = {
  workspaces: CodingWorkspace[];
  terminals: CodingTerminal[];
  codeServers: CodingCodeServerSession[];
  activeId: string;
};

function defaultState(): Persisted {
  const workspaceId = makeId("workspace");
  const terminalId = makeId("terminal");
  return {
    workspaces: [{ id: workspaceId, name: "Workspace", cwd: "." }],
    terminals: [{ id: terminalId, workspaceId, label: "", revision: 0 }],
    codeServers: [],
    activeId: terminalId,
  };
}

function readStored(): Persisted {
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

async function fetchServerState(): Promise<{ state: Persisted; initialized: boolean }> {
  const res = await fetch(apiUrl("/api/v1/coding/sessions"), { credentials: "include" });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.ok) {
    throw new Error(body?.error || `Coding sessions request failed (${res.status})`);
  }
  return body.data as { state: Persisted; initialized: boolean };
}

async function saveServerState(state: Persisted): Promise<void> {
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
      };
      return [...current, terminal];
    });
    if (!opts?.silent) setActiveId(id);
    return id;
  }, []);

  const closeTerminal = useCallback((id: string) => {
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
    setWorkspaces((current) => current.filter((w) => w.id !== workspaceId));
    setCodeServers((current) => current.filter((session) => session.workspaceId !== workspaceId));
  }, []);

  const renameTerminal = useCallback((id: string, label: string) => {
    setTerminals((current) => current.map((t) => (t.id === id ? { ...t, label } : t)));
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
    renameTerminal,
    updateWorkspace,
    restartTerminal,
    setConnection,
  };
}
