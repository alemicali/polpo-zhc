import { useCallback, useEffect, useRef, useState } from "react";
import {
  Check,
  Fingerprint,
  Loader2,
  MonitorUp,
  MousePointerClick,
  PanelsTopLeft,
  Play,
  Square,
  TriangleAlert,
  WifiOff,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { apiUrl, websocketUrl } from "@/lib/config";
import { cn } from "@/lib/utils";

type DashboardStatus = { running: boolean; port: number };
type BrowserSession = { engine: string; port: number; session: string };
type StreamState = "idle" | "connecting" | "live" | "reconnecting" | "error";
type ViewportMode = "responsive" | "full-hd";
type VncClient = import("@novnc/novnc").default;

const USER_AGENTS = {
  iphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  android: "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36",
} as const;

export function AgentBrowserLivePage() {
  const [status, setStatus] = useState<DashboardStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [chromeRunning, setChromeRunning] = useState(false);
  const [chromeBusy, setChromeBusy] = useState(false);
  const [sessions, setSessions] = useState<BrowserSession[]>([]);
  const [vncState, setVncState] = useState<StreamState>("idle");
  const [viewportMode, setViewportMode] = useState<ViewportMode>("responsive");
  const [userAgentLabel, setUserAgentLabel] = useState("Default");
  const [userAgentBusy, setUserAgentBusy] = useState(false);
  const vncViewportRef = useRef<HTMLDivElement | null>(null);
  const vncScreenRef = useRef<HTMLDivElement | null>(null);
  const vncClientRef = useRef<VncClient | null>(null);
  const lastViewportRef = useRef({ width: 0, height: 0 });

  const orchestratorSession = sessions.find((item) => item.session === "orchestrator") ?? null;
  const selected = orchestratorSession ?? (chromeRunning
    ? { engine: "TigerVNC", port: 0, session: "orchestrator" }
    : null);

  const fetchStatus = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setStatusError(null);
    try {
      const res = await fetch(apiUrl("/api/v1/browser-dashboard/status"), { credentials: "include" });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.ok) throw new Error(body?.error || `status failed (${res.status})`);
      setStatus(body.data as DashboardStatus);
    } catch (err) {
      if (!opts?.silent) setStatusError(err instanceof Error ? err.message : "status failed");
    }
  }, []);

  const fetchChrome = useCallback(async () => {
    try {
      const res = await fetch(apiUrl("/api/v1/browser-dashboard/chrome/status"), { credentials: "include" });
      const body = await res.json().catch(() => null);
      if (body?.ok) {
        setChromeRunning(Boolean(body.data?.running));
      }
    } catch { /* status polling is best effort */ }
  }, []);

  const fetchSessions = useCallback(async () => {
    try {
      const res = await fetch(apiUrl("/api/v1/browser-dashboard/sessions"), { credentials: "include" });
      const body = await res.json().catch(() => null);
      if (res.ok && body?.ok && Array.isArray(body.data)) setSessions(body.data as BrowserSession[]);
    } catch { /* dashboard state already communicates availability */ }
  }, []);

  useEffect(() => {
    void fetchStatus();
    void fetchChrome();
    const id = window.setInterval(() => {
      void fetchStatus({ silent: true });
      void fetchChrome();
    }, 5000);
    return () => window.clearInterval(id);
  }, [fetchChrome, fetchStatus]);

  useEffect(() => {
    if (!status?.running) {
      setSessions([]);
      return;
    }
    void fetchSessions();
    const id = window.setInterval(() => void fetchSessions(), 3000);
    return () => window.clearInterval(id);
  }, [fetchSessions, status?.running]);

  useEffect(() => {
    if (!chromeRunning) {
      setVncState("idle");
      return;
    }

    let disposed = false;
    let reconnectTimer: number | null = null;
    let activeClient: VncClient | null = null;
    let connecting = false;
    let reconnectAttempt = 0;
    const screen = vncScreenRef.current;
    setVncState("connecting");
    setStatusError(null);

    const clearClient = () => {
      const client = activeClient;
      activeClient = null;
      if (vncClientRef.current === client) vncClientRef.current = null;
      client?.disconnect();
      screen?.replaceChildren();
    };

    const scheduleReconnect = (message?: string) => {
      if (disposed || reconnectTimer !== null) return;
      setVncState("reconnecting");
      reconnectAttempt += 1;
      if (message && reconnectAttempt >= 3) setStatusError(message);
      const delay = Math.min(5_000, 750 * (2 ** Math.min(reconnectAttempt - 1, 3)));
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        void connect();
      }, delay);
    };

    async function connect() {
      if (disposed || connecting) return;
      connecting = true;
      clearClient();
      try {
        const response = await fetch(apiUrl("/api/v1/browser-dashboard/vnc/start"), {
          method: "POST",
          credentials: "include",
        });
        const body = await response.json().catch(() => null);
        if (!response.ok || !body?.ok) throw new Error(body?.error || "VNC failed to start");
        if (disposed || !screen) return;

        const { default: RFB } = await import("@novnc/novnc");
        if (disposed) return;
        screen.replaceChildren();
        const client = new RFB(screen, websocketUrl("/api/v1/browser-dashboard/vnc"), {
          shared: true,
        }) as VncClient;
        client.scaleViewport = true;
        client.resizeSession = false;
        client.viewOnly = false;
        client.focusOnClick = true;
        client.showDotCursor = true;
        client.qualityLevel = 6;
        client.compressionLevel = 6;
        client.background = "#20211f";
        client.addEventListener("connect", () => {
          if (!disposed && activeClient === client) {
            reconnectAttempt = 0;
            setVncState("live");
            setStatusError(null);
            void fetchChrome();
            window.setTimeout(() => void fetchSessions(), 250);
          }
        });
        client.addEventListener("disconnect", (event) => {
          if (disposed || activeClient !== client) return;
          activeClient = null;
          if (vncClientRef.current === client) vncClientRef.current = null;
          screen.replaceChildren();
          scheduleReconnect(event.detail.clean ? undefined : "VNC connection is unstable. Retrying automatically.");
        });
        client.addEventListener("securityfailure", (event) => {
          if (!disposed) {
            setVncState("error");
            setStatusError(event.detail.reason || "VNC security negotiation failed");
          }
        });
        activeClient = client;
        vncClientRef.current = client;
      } catch (err) {
        if (!disposed) {
          scheduleReconnect(err instanceof Error ? err.message : "VNC failed to start");
        }
      } finally {
        connecting = false;
      }
    }

    void connect();
    return () => {
      disposed = true;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      clearClient();
    };
  }, [chromeRunning, fetchChrome, fetchSessions]);

  useEffect(() => {
    const viewport = vncViewportRef.current;
    if (!chromeRunning || !viewport) return;
    let timer: number | null = null;
    const update = (width: number, height: number) => {
      const next = viewportMode === "full-hd"
        ? { width: 1920, height: 1080 }
        : {
            width: Math.max(320, Math.min(1920, Math.round(width))),
            height: Math.max(240, Math.min(1080, Math.round(height))),
          };
      const previous = lastViewportRef.current;
      if (Math.abs(previous.width - next.width) < 24 && Math.abs(previous.height - next.height) < 24) return;
      lastViewportRef.current = next;
      void fetch(apiUrl("/api/v1/browser-dashboard/chrome/viewport"), {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next),
      }).catch(() => {});
    };

    if (viewportMode === "full-hd") {
      update(1920, 1080);
      return;
    }

    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => update(entry.contentRect.width, entry.contentRect.height), 450);
    });
    observer.observe(viewport);
    return () => {
      observer.disconnect();
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [chromeRunning, viewportMode]);

  const launchChrome = useCallback(async () => {
    setChromeBusy(true);
    setStatusError(null);
    try {
      let dashboard = status;
      if (!dashboard?.running) {
        const started = await fetch(apiUrl("/api/v1/browser-dashboard/start"), {
          method: "POST", credentials: "include",
          headers: { "Content-Type": "application/json" }, body: "{}",
        });
        const startedBody = await started.json().catch(() => null);
        if (!started.ok || !startedBody?.ok) throw new Error(startedBody?.error || "live service failed to start");
        dashboard = startedBody.data as DashboardStatus;
        setStatus(dashboard);
      }
      const res = await fetch(apiUrl("/api/v1/browser-dashboard/chrome/start"), {
        method: "POST", credentials: "include",
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.ok) throw new Error(body?.error || `chrome start failed (${res.status})`);
      setChromeRunning(true);
      await fetchSessions();
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : "chrome start failed");
    } finally {
      setChromeBusy(false);
    }
  }, [fetchSessions, status]);

  const stopChrome = useCallback(async () => {
    setChromeBusy(true);
    try {
      const res = await fetch(apiUrl("/api/v1/browser-dashboard/chrome/stop"), {
        method: "POST", credentials: "include",
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.ok) throw new Error(body?.error || "chrome stop failed");
      setChromeRunning(false);
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : "chrome stop failed");
    } finally {
      setChromeBusy(false);
    }
  }, []);

  const setUserAgent = useCallback(async (label: string, userAgent: string | null) => {
    setUserAgentBusy(true);
    setStatusError(null);
    try {
      const response = await fetch(apiUrl("/api/v1/browser-dashboard/chrome/user-agent"), {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userAgent }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok || !body?.ok) throw new Error(body?.error || "User-Agent update failed");
      setUserAgentLabel(label);
    } catch (error) {
      setStatusError(error instanceof Error ? error.message : "User-Agent update failed");
    } finally {
      setUserAgentBusy(false);
    }
  }, []);

  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      {statusError && (
        <div className="shrink-0 border-b border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-xs text-amber-700 dark:text-amber-300">
          <TriangleAlert className="mr-1.5 inline h-3.5 w-3.5 align-text-bottom" />
          {statusError}
        </div>
      )}

      {selected ? (
        <div className="flex min-h-0 flex-1 flex-col bg-muted/15">
          <div className="flex h-9 min-w-0 shrink-0 items-center justify-end gap-1 border-b border-border bg-background px-1.5">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" size="sm" variant="ghost" className="h-7 gap-1.5 px-2 text-xs" title="Viewport mode">
                  <MonitorUp className="h-3.5 w-3.5" />
                  <span>{viewportMode === "responsive" ? "Responsive" : "Full HD"}</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-48">
                <DropdownMenuLabel className="text-[10px] font-semibold uppercase text-muted-foreground/70">
                  Resolution
                </DropdownMenuLabel>
                <DropdownMenuItem onSelect={() => setViewportMode("responsive")} className="gap-2 text-xs">
                  <span className="flex h-4 w-4 items-center justify-center">
                    {viewportMode === "responsive" && <Check className="h-3.5 w-3.5 text-primary" />}
                  </span>
                  <span className="flex-1">Responsive</span>
                  <span className="text-[10px] text-muted-foreground">Fit panel</span>
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setViewportMode("full-hd")} className="gap-2 text-xs">
                  <span className="flex h-4 w-4 items-center justify-center">
                    {viewportMode === "full-hd" && <Check className="h-3.5 w-3.5 text-primary" />}
                  </span>
                  <span className="flex-1">Full HD</span>
                  <span className="text-[10px] text-muted-foreground">1920 x 1080</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" size="sm" variant="ghost" className="h-7 gap-1.5 px-2 text-xs" disabled={userAgentBusy} title="Change User-Agent">
                  {userAgentBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Fingerprint className="h-3.5 w-3.5" />}
                  <span>UA</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-52">
                <DropdownMenuLabel className="text-[10px] font-semibold uppercase text-muted-foreground/70">
                  User-Agent - {userAgentLabel}
                </DropdownMenuLabel>
                <DropdownMenuItem onSelect={() => void setUserAgent("Default", null)} className="text-xs">
                  Default Chrome
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void setUserAgent("iPhone", USER_AGENTS.iphone)} className="text-xs">
                  iPhone Safari
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void setUserAgent("Android", USER_AGENTS.android)} className="text-xs">
                  Android Chrome
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="text-xs"
                  onSelect={() => window.setTimeout(() => {
                    const value = window.prompt("Custom User-Agent");
                    if (value?.trim()) void setUserAgent("Custom", value.trim());
                  }, 0)}
                >
                  Custom...
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" size="sm" variant="ghost" className="h-7 gap-1.5 px-2 text-xs" title={`${sessions.length} browser session${sessions.length === 1 ? "" : "s"}`}>
                  <PanelsTopLeft className="h-3.5 w-3.5" />
                  <span>{selected.session}</span>
                  <span className="text-[10px] text-muted-foreground">{sessions.length}</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-56">
                <DropdownMenuLabel className="text-[10px] font-semibold uppercase text-muted-foreground/70">
                  Active sessions
                </DropdownMenuLabel>
                {sessions.length === 0 ? (
                  <DropdownMenuItem disabled className="text-xs text-muted-foreground">
                    No active sessions
                  </DropdownMenuItem>
                ) : sessions.map((session) => (
                  <DropdownMenuItem key={`${session.session}:${session.port}`} disabled className="gap-2 text-xs opacity-100">
                    <span className="flex h-4 w-4 items-center justify-center">
                      {session.session === selected.session && <Check className="h-3.5 w-3.5 text-primary" />}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-medium text-foreground">{session.session}</span>
                    <span className="text-[10px] text-muted-foreground">{session.engine}</span>
                    <span className="font-mono text-[10px] text-muted-foreground">:{session.port}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <span
              className={cn("h-2 w-2 shrink-0 rounded-full", vncState === "live" ? "bg-emerald-500" : vncState === "connecting" || vncState === "reconnecting" ? "animate-pulse bg-amber-500" : "bg-destructive")}
              title={vncState === "live" ? "VNC connected" : vncState === "connecting" || vncState === "reconnecting" ? "VNC connecting" : "VNC disconnected"}
            />
            <Button type="button" size="sm" variant="ghost" className="h-7 gap-1.5 px-2 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={stopChrome} disabled={chromeBusy} title="Stop Chrome">
              {chromeBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Square className="h-3 w-3" />}
              Stop
            </Button>
          </div>

          <div
            ref={vncViewportRef}
            className="relative min-h-0 flex-1 overflow-hidden bg-[#20211f] outline-none ring-1 ring-inset ring-border"
            role="application"
            aria-label="Interactive browser viewport"
            onPointerDown={() => vncClientRef.current?.focus({ preventScroll: true })}
          >
            <div
              ref={vncScreenRef}
              className="absolute inset-0 flex items-center justify-center overflow-hidden bg-[#20211f] [&_canvas]:outline-none"
            />
            {vncState !== "live" && (
              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 bg-[#20211f] text-xs text-[#b6b7b0]">
                {vncState === "connecting" || vncState === "reconnecting"
                  ? <Loader2 className="h-5 w-5 animate-spin" />
                  : <WifiOff className="h-6 w-6 opacity-70" />}
                <span>{vncState === "error" ? "VNC unavailable" : "Starting VNC control"}</span>
              </div>
            )}
          </div>

        </div>
      ) : (
        <EmptyState
          running={status?.running ?? false}
          probing={status === null && statusError === null}
          onLaunch={launchChrome}
          starting={chromeBusy}
        />
      )}
    </section>
  );
}

function EmptyState({
  running,
  probing,
  onLaunch,
  starting,
}: {
  running: boolean;
  probing: boolean;
  onLaunch: () => void;
  starting: boolean;
}) {
  if (probing) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Probing live service
      </div>
    );
  }
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <MousePointerClick className="h-8 w-8 text-muted-foreground/50" />
      <p className="text-sm font-medium text-foreground">{running ? "No active browser session" : "Agent Live is stopped"}</p>
      <Button type="button" size="sm" className="h-8 gap-1.5 text-xs" onClick={onLaunch} disabled={starting}>
        {starting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
        Launch Browser Automation
      </Button>
    </div>
  );
}
