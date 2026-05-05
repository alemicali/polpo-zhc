import { useEffect, useMemo, useRef, useState } from "react";
import { Terminal as WTermTerminal, type TerminalHandle } from "@wterm/react";
import "@wterm/react/css";
import { Terminal as TerminalIcon, Loader2, ShieldAlert, RefreshCcw, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTerminalCore } from "@/hooks/use-terminal-core";
import { apiUrl, config, websocketUrl } from "@/lib/config";
import { cn } from "@/lib/utils";

type TerminalStatus = {
  enabled: boolean;
  workDir: string;
  agentWorkDir: string;
  shell: string;
};

type ConnectionState = "loading" | "connecting" | "connected" | "closed" | "error";
type TerminalTab = {
  id: string;
  name: string;
  revision: number;
};

function createTerminalTab(index: number): TerminalTab {
  const id = `term_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  return { id, name: `Terminal ${index}`, revision: 0 };
}

export function TerminalPage() {
  const [status, setStatus] = useState<TerminalStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [loadingStep, setLoadingStep] = useState("Checking terminal status...");
  const [tabs, setTabs] = useState<TerminalTab[]>(() => [createTerminalTab(1)]);
  const [activeId, setActiveId] = useState(() => tabs[0].id);
  const [connections, setConnections] = useState<Record<string, ConnectionState>>({});

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 8_000);
    setStatusError(null);
    setLoadingStep("Checking terminal status...");

    fetch(apiUrl("/api/v1/terminal/status"), { credentials: "include", signal: controller.signal })
      .then(async (res) => {
        const body = await res.json().catch(() => null);
        if (!res.ok || !body?.ok) {
          throw new Error(body?.error || `Terminal status failed (${res.status})`);
        }
        return body.data as TerminalStatus;
      })
      .then((data) => {
        if (!cancelled) setStatus(data);
      })
      .catch((err) => {
        if (!cancelled) {
          setStatusError(err instanceof Error && err.name === "AbortError"
            ? "Terminal status request timed out."
            : err instanceof Error ? err.message : "Terminal status failed");
        }
      });

    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, []);

  const retryStatus = () => {
    setStatus(null);
    setStatusError(null);
    window.location.reload();
  };

  const addTab = () => {
    const tab = createTerminalTab(tabs.length + 1);
    setTabs((current) => [...current, tab]);
    setActiveId(tab.id);
  };

  const closeTab = (id: string) => {
    setTabs((current) => {
      if (current.length <= 1) return current;
      const index = current.findIndex((tab) => tab.id === id);
      const next = current.filter((tab) => tab.id !== id);
      if (activeId === id) {
        setActiveId(next[Math.max(0, index - 1)]?.id ?? next[0].id);
      }
      setConnections((states) => {
        const { [id]: _closed, ...rest } = states;
        return rest;
      });
      return next;
    });
  };

  const restartActive = () => {
    setTabs((current) => current.map((tab) =>
      tab.id === activeId ? { ...tab, revision: tab.revision + 1 } : tab,
    ));
  };

  const updateConnection = (id: string, state: ConnectionState) => {
    setConnections((current) => ({ ...current, [id]: state }));
  };

  const activeTab = tabs.find((tab) => tab.id === activeId) ?? tabs[0];
  const activeConnection = connections[activeId] ?? "loading";

  if (statusError) {
    return (
      <TerminalShell>
        <TerminalNotice
          icon={<ShieldAlert className="h-5 w-5" />}
          title="Terminal unavailable"
          detail={statusError}
          action={<Button size="sm" variant="outline" onClick={retryStatus}><RefreshCcw className="h-4 w-4" /> Retry</Button>}
        />
      </TerminalShell>
    );
  }

  if (!status) {
    return (
      <TerminalShell>
        <TerminalNotice
          icon={<Loader2 className="h-5 w-5 animate-spin" />}
          title="Loading terminal"
          detail={loadingStep}
        />
      </TerminalShell>
    );
  }

  if (!status.enabled) {
    return (
      <TerminalShell>
        <TerminalNotice
          icon={<ShieldAlert className="h-5 w-5" />}
          title="Terminal disabled"
          detail="Set POLPO_TERMINAL_ENABLED=true on the server to enable interactive shell sessions."
        />
      </TerminalShell>
    );
  }

  return (
    <TerminalShell
      status={
        <div className="flex min-w-0 items-center gap-3 text-xs text-muted-foreground">
          <StatusDot state={activeConnection} />
          <span className="truncate">{activeConnection}</span>
          <span className="hidden min-w-0 truncate sm:block">{status.agentWorkDir}</span>
        </div>
      }
      action={<Button size="sm" variant="outline" onClick={restartActive}><RefreshCcw className="h-4 w-4" /> Restart</Button>}
    >
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-border/60 bg-[#101418]">
        <div className="flex h-10 shrink-0 items-center gap-1 overflow-x-auto border-b border-white/10 bg-black/20 px-2">
          {tabs.map((tab) => {
            const selected = tab.id === activeId;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveId(tab.id)}
                className={cn(
                  "group inline-flex h-8 max-w-[180px] shrink-0 items-center gap-2 rounded-md px-2 text-xs transition-colors",
                  selected ? "bg-white/10 text-white" : "text-white/60 hover:bg-white/5 hover:text-white",
                )}
              >
                <StatusDot state={connections[tab.id] ?? "loading"} />
                <span className="truncate">{tab.name}</span>
                <span
                  role="button"
                  tabIndex={0}
                  onClick={(event) => {
                    event.stopPropagation();
                    closeTab(tab.id);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      event.stopPropagation();
                      closeTab(tab.id);
                    }
                  }}
                  className={cn(
                    "ml-1 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-white/45 hover:bg-white/10 hover:text-white",
                    tabs.length <= 1 && "pointer-events-none opacity-30",
                  )}
                  aria-label={`Close ${tab.name}`}
                >
                  <X className="h-3.5 w-3.5" />
                </span>
              </button>
            );
          })}
          <Button size="icon" variant="ghost" className="h-8 w-8 shrink-0 text-white/60 hover:bg-white/5 hover:text-white" onClick={addTab}>
            <Plus className="h-4 w-4" />
          </Button>
        </div>

        <div className="relative min-h-0 flex-1 overflow-hidden">
          {tabs.map((tab) => (
            <TerminalSession
              key={tab.id}
              tab={tab}
              active={tab.id === activeTab.id}
              onConnectionChange={(state) => updateConnection(tab.id, state)}
            />
          ))}
        </div>
      </div>
    </TerminalShell>
  );
}

function TerminalSession({
  tab,
  active,
  onConnectionChange,
}: {
  tab: TerminalTab;
  active: boolean;
  onConnectionChange: (state: ConnectionState) => void;
}) {
  const [terminalReady, setTerminalReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const terminalCore = useTerminalCore(tab.revision);
  const terminalRef = useRef<TerminalHandle>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const sizeRef = useRef({ cols: 100, rows: 30 });
  const activeRef = useRef(active);
  const onConnectionChangeRef = useRef(onConnectionChange);

  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  useEffect(() => {
    onConnectionChangeRef.current = onConnectionChange;
  }, [onConnectionChange]);

  useEffect(() => {
    setTerminalReady(false);
    setError(null);
    onConnectionChangeRef.current("loading");
  }, [tab.revision, terminalCore.loading]);

  const wsUrl = useMemo(() => {
    const url = new URL(websocketUrl("/ws/terminal"));
    url.searchParams.set("session_id", tab.id);
    url.searchParams.set("cols", String(sizeRef.current.cols));
    url.searchParams.set("rows", String(sizeRef.current.rows));
    url.searchParams.set("revision", String(tab.revision));
    if (config.apiKey) url.searchParams.set("api_key", config.apiKey);
    return url.toString();
  }, [tab.id, tab.revision]);

  useEffect(() => {
    if (!terminalReady || terminalCore.loading || terminalCore.error) return;

    onConnectionChangeRef.current("connecting");
    const ws = new WebSocket(wsUrl);
    socketRef.current = ws;

    ws.addEventListener("open", () => {
      onConnectionChangeRef.current("connected");
      if (activeRef.current) terminalRef.current?.focus();
      ws.send(JSON.stringify({ type: "resize", ...sizeRef.current }));
    });
    ws.addEventListener("message", (event) => {
      terminalRef.current?.write(typeof event.data === "string" ? event.data : new Uint8Array(event.data));
    });
    ws.addEventListener("close", () => {
      onConnectionChangeRef.current("closed");
    });
    ws.addEventListener("error", () => {
      onConnectionChangeRef.current("error");
    });

    return () => {
      socketRef.current = null;
      ws.close();
    };
  }, [terminalCore.error, terminalCore.loading, terminalReady, wsUrl]);

  useEffect(() => {
    if (!active) return;
    const id = window.requestAnimationFrame(() => {
      terminalRef.current?.resize(sizeRef.current.cols, sizeRef.current.rows);
      terminalRef.current?.focus();
      if (socketRef.current?.readyState === WebSocket.OPEN) {
        socketRef.current.send(JSON.stringify({ type: "resize", ...sizeRef.current }));
      }
    });
    return () => window.cancelAnimationFrame(id);
  }, [active]);

  return (
    <div
      className={cn(
        "absolute inset-0 transition-opacity duration-100",
        active ? "z-10 opacity-100" : "z-0 opacity-0 pointer-events-none",
      )}
      aria-hidden={!active}
    >
      {terminalCore.error || error ? (
        <TerminalNotice
          icon={<ShieldAlert className="h-5 w-5" />}
          title="Terminal unavailable"
          detail={terminalCore.error ?? error ?? "Terminal failed to initialize."}
        />
      ) : terminalCore.loading ? (
        <TerminalNotice
          icon={<Loader2 className="h-5 w-5 animate-spin" />}
          title="Loading terminal"
          detail="Loading Ghostty terminal core..."
        />
      ) : (
        <WTermTerminal
          key={tab.revision}
          ref={terminalRef}
          core={terminalCore.core ?? undefined}
          autoResize
          cursorBlink
          className="h-full w-full !rounded-none !border-0 !shadow-none"
          onReady={() => setTerminalReady(true)}
          onData={(data) => {
            if (socketRef.current?.readyState === WebSocket.OPEN) {
              socketRef.current.send(JSON.stringify({ type: "input", data }));
            }
          }}
          onResize={(cols, rows) => {
            sizeRef.current = { cols, rows };
            if (socketRef.current?.readyState === WebSocket.OPEN) {
              socketRef.current.send(JSON.stringify({ type: "resize", cols, rows }));
            }
          }}
          onError={(err) => {
            setError(err instanceof Error ? err.message : "Terminal failed to initialize.");
            onConnectionChange("error");
          }}
        />
      )}
    </div>
  );
}

function StatusDot({ state }: { state: ConnectionState }) {
  return (
    <span className={cn(
      "inline-flex h-2 w-2 shrink-0 rounded-full",
      state === "connected" ? "bg-teal-400" : state === "error" ? "bg-rose-500" : state === "closed" ? "bg-zinc-500" : "bg-amber-400",
    )} />
  );
}

function TerminalShell({
  children,
  status,
  action,
}: {
  children: React.ReactNode;
  status?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex shrink-0 items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-muted/50">
            <TerminalIcon className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <h1 className="truncate text-base font-semibold tracking-tight">Terminal</h1>
            <p className="truncate text-xs text-muted-foreground">Interactive shell in the agent workspace</p>
          </div>
        </div>
        <div className="flex min-w-0 shrink-0 items-center gap-3">
          {status}
          {action}
        </div>
      </div>
      {children}
    </div>
  );
}

function TerminalNotice({
  icon,
  title,
  detail,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  detail: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center rounded-lg border border-border/60 bg-muted/30 p-6">
      <div className="flex max-w-md flex-col items-center gap-3 text-center">
        <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-background text-muted-foreground shadow-sm">
          {icon}
        </span>
        <div>
          <h2 className="text-sm font-semibold">{title}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{detail}</p>
        </div>
        {action}
      </div>
    </div>
  );
}
