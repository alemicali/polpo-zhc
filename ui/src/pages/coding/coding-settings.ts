import { useCallback, useEffect, useRef, useState } from "react";
import { apiUrl } from "@/lib/config";
import type { CodingAgentKind } from "./types";

export type CodingSettings = {
  /** Override the shell command launched for each agent kind. Undefined =
   * fall back to the server-side default reported by /capabilities. */
  agentCommands: Partial<Record<CodingAgentKind, string>>;
  /** Absolute paths the user has whitelisted as additional workspace roots.
   * Persisted server-side — also used by the server's terminal/code-server
   * cwd-check, so this is the security source of truth. */
  allowedExtraRoots: string[];
  /** Shell command launched by the workspace "PR" button when no PR yet
   * exists. Defaults to a non-interactive `claude -p` invocation. */
  prCommand: string;
  /** Local-only UI preference: whether the "Add workspace" picker should
   * surface the extra roots. The server enforces the whitelist regardless. */
  allowOutsideWorkspace: boolean;
};

export const DEFAULT_PR_COMMAND =
  'claude -p --dangerously-skip-permissions "Operator mode: act, do not ask. Procedure: (1) if HEAD is on main or master, create and switch to a new branch named feat/wt-<short-utc-timestamp>; (2) run `git add -A`; if there are pending changes, commit them with a one-line message inferred from the diff; (3) `git push -u origin HEAD`; (4) `gh pr create --fill`. If --fill fails (no template, ambiguous, base==head), retry with explicit `gh pr create --title <inferred from diff> --body <short summary + test plan inferred from diff>`. Decide every title/message/branch-name yourself. Print only essential progress lines. Never present options to the user, never ask clarifying questions, never wait for confirmation."';

export const DEFAULT_SETTINGS: CodingSettings = {
  agentCommands: {},
  allowedExtraRoots: [],
  prCommand: DEFAULT_PR_COMMAND,
  allowOutsideWorkspace: false,
};

const LOCAL_FLAG_KEY = "polpo:coding:allowOutside";

function loadLocalFlag(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(LOCAL_FLAG_KEY) === "1";
}

function saveLocalFlag(v: boolean) {
  try { window.localStorage.setItem(LOCAL_FLAG_KEY, v ? "1" : "0"); } catch { /* ignore */ }
}

type ServerConfig = {
  agentCommands: Partial<Record<CodingAgentKind, string>>;
  allowedExtraRoots: string[];
  prCommand: string;
};

async function fetchConfig(): Promise<ServerConfig | null> {
  try {
    const res = await fetch(apiUrl("/api/v1/coding/config"), { credentials: "include" });
    if (!res.ok) return null;
    const body = await res.json().catch(() => null);
    if (!body?.ok) return null;
    return {
      agentCommands: body.data?.agentCommands ?? {},
      allowedExtraRoots: Array.isArray(body.data?.allowedExtraRoots) ? body.data.allowedExtraRoots : [],
      prCommand: typeof body.data?.prCommand === "string" && body.data.prCommand ? body.data.prCommand : DEFAULT_PR_COMMAND,
    };
  } catch {
    return null;
  }
}

async function putConfig(cfg: ServerConfig): Promise<ServerConfig | null> {
  try {
    const res = await fetch(apiUrl("/api/v1/coding/config"), {
      method: "PUT",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(cfg),
    });
    if (!res.ok) return null;
    const body = await res.json().catch(() => null);
    if (!body?.ok) return null;
    return {
      agentCommands: body.data?.agentCommands ?? {},
      allowedExtraRoots: Array.isArray(body.data?.allowedExtraRoots) ? body.data.allowedExtraRoots : [],
      prCommand: typeof body.data?.prCommand === "string" && body.data.prCommand ? body.data.prCommand : DEFAULT_PR_COMMAND,
    };
  } catch {
    return null;
  }
}

export function useCodingSettings() {
  const [settings, setSettings] = useState<CodingSettings>(() => ({
    ...DEFAULT_SETTINGS,
    allowOutsideWorkspace: loadLocalFlag(),
  }));
  const [loading, setLoading] = useState(true);

  // Initial load from server.
  useEffect(() => {
    let cancelled = false;
    fetchConfig().then((cfg) => {
      if (cancelled) return;
      if (cfg) {
        setSettings((prev) => ({ ...prev, ...cfg }));
      }
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, []);

  // Debounced server sync. Local-only flag persists immediately; server
  // payload (commands + roots) is PUT after the user pauses for 400ms.
  const syncRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSyncedRef = useRef<string>("");

  const update = useCallback((patch: Partial<CodingSettings> | ((prev: CodingSettings) => CodingSettings)) => {
    setSettings((prev) => {
      const next = typeof patch === "function" ? patch(prev) : { ...prev, ...patch };
      if (next.allowOutsideWorkspace !== prev.allowOutsideWorkspace) {
        saveLocalFlag(next.allowOutsideWorkspace);
      }
      const serverPayload: ServerConfig = {
        agentCommands: next.agentCommands,
        allowedExtraRoots: next.allowedExtraRoots,
        prCommand: next.prCommand,
      };
      const serial = JSON.stringify(serverPayload);
      if (serial !== lastSyncedRef.current) {
        if (syncRef.current) clearTimeout(syncRef.current);
        syncRef.current = setTimeout(async () => {
          const saved = await putConfig(serverPayload);
          if (saved) {
            lastSyncedRef.current = JSON.stringify(saved);
            setSettings((current) => ({ ...current, ...saved }));
          }
        }, 400);
      }
      return next;
    });
  }, []);

  return [settings, update, loading] as const;
}
