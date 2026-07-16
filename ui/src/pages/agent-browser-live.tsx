import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, WheelEvent as ReactWheelEvent } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Globe2,
  Loader2,
  LockKeyhole,
  MonitorUp,
  MousePointerClick,
  PanelsTopLeft,
  Play,
  Plus,
  Radio,
  RotateCw,
  Square,
  TriangleAlert,
  WifiOff,
  X,
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
type BrowserViewport = { width: number; height: number };
type BrowserTab = {
  active: boolean;
  label: string | null;
  tabId: string;
  title: string;
  type: string;
  url: string;
};
type StreamState = "idle" | "connecting" | "live" | "reconnecting" | "error";
type ViewportMode = "auto" | "1920x1080" | "1600x900" | "1280x720";
type BrowserCommand =
  | { action: "activate-tab" | "close-tab"; tabId: string }
  | { action: "new-tab"; url?: string }
  | { action: "navigate"; url: string }
  | { action: "back" | "forward" | "reload" };

const DEFAULT_VIEWPORT: BrowserViewport = { width: 1920, height: 1080 };
const VIEWPORT_OPTIONS: Array<{ value: ViewportMode; label: string; detail: string }> = [
  { value: "auto", label: "Auto", detail: "Follow panel size" },
  { value: "1920x1080", label: "Full HD", detail: "1920 × 1080" },
  { value: "1600x900", label: "Balanced", detail: "1600 × 900" },
  { value: "1280x720", label: "Efficient", detail: "1280 × 720" },
];

export function AgentBrowserLivePage() {
  const [status, setStatus] = useState<DashboardStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"start" | "stop" | null>(null);
  const [chromeRunning, setChromeRunning] = useState(false);
  const [chromeBusy, setChromeBusy] = useState(false);
  const [sessions, setSessions] = useState<BrowserSession[]>([]);
  const [selectedSession, setSelectedSession] = useState("orchestrator");
  const [tabs, setTabs] = useState<BrowserTab[]>([]);
  const [viewport, setViewport] = useState<BrowserViewport>(DEFAULT_VIEWPORT);
  const [streamState, setStreamState] = useState<StreamState>("idle");
  const [hasFrame, setHasFrame] = useState(false);
  const [address, setAddress] = useState("");
  const [commandBusy, setCommandBusy] = useState<string | null>(null);
  const [metrics, setMetrics] = useState({ fps: 0, frameKb: 0 });
  const [viewportMode, setViewportMode] = useState<ViewportMode>("auto");
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const viewportContainerRef = useRef<HTMLDivElement | null>(null);
  const addressRef = useRef<HTMLInputElement | null>(null);
  const pendingFrameRef = useRef<string | null>(null);
  const animationRef = useRef<number | null>(null);
  const decodingRef = useRef(false);
  const frameCountRef = useRef(0);
  const metricStartRef = useRef(performance.now());
  const socketRef = useRef<WebSocket | null>(null);
  const frameSequenceRef = useRef(0);

  const selected = sessions.find((item) => item.session === selectedSession) ?? null;
  const activeTab = tabs.find((tab) => tab.active) ?? null;

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
        if (body.data?.viewport) setViewport(body.data.viewport as BrowserViewport);
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

  const fetchTabs = useCallback(async (port: number) => {
    try {
      const res = await fetch(apiUrl(`/api/v1/browser-dashboard/cdp/${port}/api/tabs`), {
        credentials: "include",
      });
      const body = await res.json().catch(() => null);
      if (res.ok && Array.isArray(body)) setTabs(body as BrowserTab[]);
    } catch { /* the WebSocket remains the primary source */ }
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
    if (sessions.length === 0 || sessions.some((item) => item.session === selectedSession)) return;
    setSelectedSession((sessions.find((item) => item.session === "orchestrator") ?? sessions[0]).session);
  }, [selectedSession, sessions]);

  useEffect(() => {
    if (!selected) {
      setTabs([]);
      setHasFrame(false);
      setStreamState("idle");
      const canvas = canvasRef.current;
      if (canvas) canvas.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }

    let disposed = false;
    let reconnectTimer: number | null = null;
    let socket: WebSocket | null = null;
    setTabs([]);
    setHasFrame(false);
    setStreamState("connecting");
    void fetchTabs(selected.port);

    const renderPendingFrame = () => {
      animationRef.current = null;
      const frame = pendingFrameRef.current;
      pendingFrameRef.current = null;
      const canvas = canvasRef.current;
      if (!frame || !canvas || decodingRef.current) return;
      decodingRef.current = true;
      const generation = frameSequenceRef.current;
      const decoded = new window.Image();
      decoded.onload = () => {
        if (!disposed && generation === frameSequenceRef.current) {
          if (canvas.width !== decoded.naturalWidth || canvas.height !== decoded.naturalHeight) {
            canvas.width = decoded.naturalWidth;
            canvas.height = decoded.naturalHeight;
          }
          canvas.getContext("2d", { alpha: false })?.drawImage(decoded, 0, 0);
          setHasFrame(true);
          frameCountRef.current += 1;
          const now = performance.now();
          const elapsed = now - metricStartRef.current;
          if (elapsed >= 1000) {
            setMetrics({
              fps: Math.round((frameCountRef.current * 1000) / elapsed),
              frameKb: Math.max(1, Math.round((frame.length * 0.75) / 1024)),
            });
            frameCountRef.current = 0;
            metricStartRef.current = now;
          }
        }
        decodingRef.current = false;
        if (!disposed && pendingFrameRef.current && animationRef.current === null) {
          animationRef.current = window.requestAnimationFrame(renderPendingFrame);
        }
      };
      decoded.onerror = () => {
        decodingRef.current = false;
        if (!disposed && pendingFrameRef.current && animationRef.current === null) {
          animationRef.current = window.requestAnimationFrame(renderPendingFrame);
        }
      };
      decoded.src = `data:image/jpeg;base64,${frame}`;
    };

    const connect = () => {
      if (disposed) return;
      setStreamState((current) => current === "live" ? "reconnecting" : "connecting");
      socket = new WebSocket(websocketUrl(`/api/v1/browser-dashboard/cdp/${selected.port}`));
      socketRef.current = socket;
      socket.onopen = () => { if (!disposed) setStreamState("live"); };
      socket.onmessage = (event) => {
        if (disposed || typeof event.data !== "string") return;
        try {
          const message = JSON.parse(event.data) as Record<string, unknown>;
          if (message.type === "frame" && typeof message.data === "string") {
            pendingFrameRef.current = message.data;
            if (!decodingRef.current && animationRef.current === null) {
              animationRef.current = window.requestAnimationFrame(renderPendingFrame);
            }
          } else if (message.type === "tabs" && Array.isArray(message.tabs)) {
            setTabs(message.tabs as BrowserTab[]);
          } else if (message.type === "status") {
            const width = Number(message.viewportWidth);
            const height = Number(message.viewportHeight);
            if (width > 0 && height > 0) setViewport({ width, height });
          } else if (message.type === "url" && typeof message.url === "string") {
            if (document.activeElement !== addressRef.current) setAddress(message.url);
          }
        } catch { /* ignore non-protocol messages */ }
      };
      socket.onerror = () => { if (!disposed) setStreamState("error"); };
      socket.onclose = () => {
        if (disposed) return;
        setStreamState("reconnecting");
        reconnectTimer = window.setTimeout(connect, 1500);
      };
    };

    connect();
    return () => {
      disposed = true;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      if (animationRef.current !== null) window.cancelAnimationFrame(animationRef.current);
      animationRef.current = null;
      pendingFrameRef.current = null;
      decodingRef.current = false;
      frameSequenceRef.current += 1;
      if (socketRef.current === socket) socketRef.current = null;
      socket?.close();
    };
  }, [fetchTabs, selected?.port]);

  useEffect(() => {
    if (document.activeElement !== addressRef.current) setAddress(activeTab?.url ?? "");
  }, [activeTab?.url]);

  const runCommand = useCallback(async (command: BrowserCommand, key: string = command.action) => {
    if (!selected) return;
    setCommandBusy(key);
    setStatusError(null);
    try {
      const res = await fetch(apiUrl(
        `/api/v1/browser-dashboard/sessions/${encodeURIComponent(selected.session)}/command`,
      ), {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(command),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.ok) throw new Error(body?.error || `browser command failed (${res.status})`);
      window.setTimeout(() => void fetchTabs(selected.port), 120);
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : "browser command failed");
    } finally {
      setCommandBusy(null);
    }
  }, [fetchTabs, selected]);

  const updateViewport = useCallback(async (width: number, height: number) => {
    if (!selected) return;
    setStatusError(null);
    const next = {
      width: Math.max(320, Math.min(1920, Math.round(width))),
      height: Math.max(240, Math.min(1080, Math.round(height))),
    };
    if (
      Math.abs(next.width - viewport.width) < 24 &&
      Math.abs(next.height - viewport.height) < 24
    ) return;
    try {
      const res = await fetch(apiUrl(
        `/api/v1/browser-dashboard/sessions/${encodeURIComponent(selected.session)}/viewport`,
      ), {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.ok) throw new Error(body?.error || "viewport update failed");
      setViewport(next);
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : "viewport update failed");
    }
  }, [selected, viewport.height, viewport.width]);

  useEffect(() => {
    if (viewportMode !== "auto" || !selected || !viewportContainerRef.current) return;
    let timer: number | null = null;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const { width, height } = entry.contentRect;
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => void updateViewport(width, height), 450);
    });
    observer.observe(viewportContainerRef.current);
    return () => {
      observer.disconnect();
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [selected?.session, updateViewport, viewportMode]);

  useEffect(() => {
    if (!selected || viewportMode === "auto") return;
    const [width, height] = viewportMode.split("x").map(Number);
    void updateViewport(width, height);
  }, [selected?.session, updateViewport, viewportMode]);

  const selectViewportMode = (mode: ViewportMode) => {
    setViewportMode(mode);
    if (mode === "auto") {
      const element = viewportContainerRef.current;
      if (element) void updateViewport(element.clientWidth, element.clientHeight);
      return;
    }
    const [width, height] = mode.split("x").map(Number);
    void updateViewport(width, height);
  };

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
      if (body.data?.viewport) setViewport(body.data.viewport as BrowserViewport);
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

  const start = useCallback(async () => {
    setBusy("start");
    setStatusError(null);
    try {
      const res = await fetch(apiUrl("/api/v1/browser-dashboard/start"), {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" }, body: "{}",
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.ok) throw new Error(body?.error || `start failed (${res.status})`);
      setStatus(body.data as DashboardStatus);
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : "start failed");
    } finally {
      setBusy(null);
    }
  }, []);

  const stop = useCallback(async () => {
    setBusy("stop");
    setStatusError(null);
    try {
      const res = await fetch(apiUrl("/api/v1/browser-dashboard/stop"), {
        method: "POST", credentials: "include",
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.ok) throw new Error(body?.error || `stop failed (${res.status})`);
      setStatus({ running: false, port: status?.port ?? 4848 });
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : "stop failed");
    } finally {
      setBusy(null);
    }
  }, [status?.port]);

  const navigateAddress = (event: FormEvent) => {
    event.preventDefault();
    const url = address.trim();
    if (url) void runCommand({ action: "navigate", url });
  };

  const sendInput = (payload: Record<string, unknown>) => {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
  };

  const viewportPoint = (clientX: number, clientY: number) => {
    const element = viewportContainerRef.current;
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    const scale = Math.min(rect.width / viewport.width, rect.height / viewport.height);
    const renderedWidth = viewport.width * scale;
    const renderedHeight = viewport.height * scale;
    const left = rect.left + (rect.width - renderedWidth) / 2;
    const top = rect.top + (rect.height - renderedHeight) / 2;
    if (clientX < left || clientX > left + renderedWidth || clientY < top || clientY > top + renderedHeight) return null;
    return {
      x: Math.round((clientX - left) / scale),
      y: Math.round((clientY - top) / scale),
    };
  };

  const mouseButton = (button: number) => button === 0 ? "left" : button === 1 ? "middle" : button === 2 ? "right" : "none";
  const modifiers = (event: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) =>
    (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0);

  const sendMouse = (event: ReactMouseEvent<HTMLDivElement>, eventType: "mouseMoved" | "mousePressed" | "mouseReleased") => {
    const point = viewportPoint(event.clientX, event.clientY);
    if (!point) return;
    sendInput({
      type: "input_mouse",
      eventType,
      ...point,
      button: mouseButton(event.button),
      clickCount: eventType === "mousePressed" ? 1 : 0,
      modifiers: modifiers(event),
    });
  };

  const sendWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    const point = viewportPoint(event.clientX, event.clientY);
    if (!point) return;
    event.preventDefault();
    sendInput({
      type: "input_mouse",
      eventType: "mouseWheel",
      ...point,
      button: "none",
      clickCount: 0,
      deltaX: event.deltaX,
      deltaY: event.deltaY,
      modifiers: modifiers(event),
    });
  };

  const sendKey = (event: ReactKeyboardEvent<HTMLDivElement>, eventType: "keyDown" | "keyUp") => {
    event.preventDefault();
    event.stopPropagation();
    const native = event.nativeEvent;
    const keyCode = native.keyCode || (event.key.length === 1 ? event.key.toUpperCase().charCodeAt(0) : 0);
    sendInput({
      type: "input_keyboard",
      eventType,
      key: event.key,
      code: event.code,
      text: eventType === "keyDown" && event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey
        ? event.key
        : undefined,
      windowsVirtualKeyCode: keyCode,
      modifiers: modifiers(event),
    });
  };

  const streamLabel = streamState === "live"
    ? "Live"
    : streamState === "reconnecting"
      ? "Reconnecting"
      : streamState === "connecting"
        ? "Connecting"
        : streamState === "error"
          ? "Stream error"
          : "Offline";

  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden border border-border bg-background">
      <div className="flex min-h-12 shrink-0 flex-wrap items-center gap-1.5 border-b border-border px-3 py-2">
          {status?.running && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" size="sm" variant="ghost" className="h-8 gap-1.5 px-2 text-xs" title="Browser sessions">
                  <PanelsTopLeft className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">{selected?.session ?? "Sessions"}</span>
                  <span className="font-mono text-[10px] text-muted-foreground">{sessions.length}</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-56">
                <DropdownMenuLabel className="text-[10px] font-semibold uppercase text-muted-foreground/70">Browser sessions</DropdownMenuLabel>
                {sessions.length === 0 ? (
                  <DropdownMenuItem disabled className="text-xs text-muted-foreground">No active sessions</DropdownMenuItem>
                ) : sessions.map((item) => (
                  <DropdownMenuItem key={`${item.session}:${item.port}`} onSelect={() => setSelectedSession(item.session)} className="gap-2 text-xs">
                    <span className="flex h-5 w-5 items-center justify-center">
                      {selectedSession === item.session && <Check className="h-3.5 w-3.5 text-primary" />}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-medium">{item.session}</span>
                    <span className="font-mono text-[10px] text-muted-foreground">:{item.port}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {selected && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" size="sm" variant="ghost" className="h-8 gap-1.5 px-2 text-xs" title="Viewport resolution">
                  <MonitorUp className="h-3.5 w-3.5" />
                  <span>{viewportMode === "auto" ? "Auto" : `${viewport.width}×${viewport.height}`}</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="min-w-52">
                <DropdownMenuLabel className="text-[10px] font-semibold uppercase text-muted-foreground/70">Viewport</DropdownMenuLabel>
                {VIEWPORT_OPTIONS.map((option) => (
                  <DropdownMenuItem key={option.value} onSelect={() => selectViewportMode(option.value)} className="gap-2 text-xs">
                    <span className="flex h-5 w-5 items-center justify-center">
                      {viewportMode === option.value && <Check className="h-3.5 w-3.5 text-primary" />}
                    </span>
                    <span className="min-w-0 flex-1">{option.label}</span>
                    <span className="text-[10px] text-muted-foreground">{option.detail}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <Button
            type="button"
            size="sm"
            variant={chromeRunning ? "outline" : "default"}
            className="h-8 gap-1.5 text-xs"
            onClick={chromeRunning ? stopChrome : launchChrome}
            disabled={chromeBusy}
            title={chromeRunning ? "Stop Chrome and its orchestrator session" : "Launch Chrome for the orchestrator"}
          >
            {chromeBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : chromeRunning ? <Square className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
            {chromeRunning ? "Stop Chrome" : "Launch Chrome"}
          </Button>
          {!status?.running && (
            <Button type="button" size="sm" variant="outline" className="h-8 gap-1.5 text-xs" onClick={start} disabled={busy !== null}>
              {busy === "start" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Radio className="h-3.5 w-3.5" />}
              Start live view
            </Button>
          )}
          {status?.running && (
            <Button type="button" size="icon" variant="ghost" className="h-8 w-8" onClick={stop} disabled={busy !== null} title="Stop the Agent Live streaming service; Chrome stays open">
              {busy === "stop" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Square className="h-3.5 w-3.5" />}
            </Button>
          )}
      </div>

      {statusError && (
        <div className="shrink-0 border-b border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          <TriangleAlert className="mr-1.5 inline h-3.5 w-3.5 align-text-bottom" />
          {statusError}
        </div>
      )}

      {selected ? (
        <div className="flex min-h-0 flex-1 flex-col bg-muted/15">
          <div className="flex h-9 shrink-0 items-end gap-px overflow-x-auto border-b border-border bg-muted/45 px-1 pt-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {tabs.map((tab) => (
              <button
                key={tab.tabId}
                type="button"
                onClick={() => !tab.active && void runCommand({ action: "activate-tab", tabId: tab.tabId }, `activate-${tab.tabId}`)}
                className={cn(
                  "group flex h-8 min-w-28 max-w-56 flex-1 items-center gap-2 border border-b-0 px-2 text-left text-xs transition-colors sm:min-w-36 sm:flex-none sm:w-48",
                  tab.active
                    ? "relative -mb-px h-[33px] border-border bg-background text-foreground"
                    : "border-transparent text-muted-foreground hover:bg-background/55 hover:text-foreground",
                )}
                title={tab.title || tab.url}
              >
                {commandBusy === `activate-${tab.tabId}` ? <Loader2 className="h-3 w-3 shrink-0 animate-spin" /> : <Globe2 className="h-3 w-3 shrink-0" />}
                <span className="min-w-0 flex-1 truncate">{tab.title || "New tab"}</span>
                <span
                  role="button"
                  tabIndex={0}
                  aria-label={`Close ${tab.title || "tab"}`}
                  className={cn("flex h-5 w-5 shrink-0 items-center justify-center hover:bg-muted", tabs.length <= 1 && "invisible")}
                  onClick={(event) => {
                    event.stopPropagation();
                    if (tabs.length > 1) void runCommand({ action: "close-tab", tabId: tab.tabId }, `close-${tab.tabId}`);
                  }}
                  onKeyDown={(event) => {
                    if ((event.key === "Enter" || event.key === " ") && tabs.length > 1) {
                      event.stopPropagation();
                      void runCommand({ action: "close-tab", tabId: tab.tabId }, `close-${tab.tabId}`);
                    }
                  }}
                >
                  {commandBusy === `close-${tab.tabId}` ? <Loader2 className="h-3 w-3 animate-spin" /> : <X className="h-3 w-3" />}
                </span>
              </button>
            ))}
            <Button type="button" size="icon-xs" variant="ghost" className="mb-1 ml-1 h-7 w-7 shrink-0" onClick={() => void runCommand({ action: "new-tab" })} disabled={commandBusy !== null} title="New tab">
              {commandBusy === "new-tab" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
            </Button>
          </div>

          <form className="flex h-11 shrink-0 items-center gap-1 border-b border-border bg-background px-2" onSubmit={navigateAddress}>
            <Button type="button" size="icon-sm" variant="ghost" className="h-8 w-8" onClick={() => void runCommand({ action: "back" })} disabled={commandBusy !== null} title="Back">
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <Button type="button" size="icon-sm" variant="ghost" className="h-8 w-8" onClick={() => void runCommand({ action: "forward" })} disabled={commandBusy !== null} title="Forward">
              <ArrowRight className="h-4 w-4" />
            </Button>
            <Button type="button" size="icon-sm" variant="ghost" className="h-8 w-8" onClick={() => void runCommand({ action: "reload" })} disabled={commandBusy !== null} title="Reload">
              <RotateCw className={cn("h-3.5 w-3.5", commandBusy === "reload" && "animate-spin")} />
            </Button>
            <div className="flex h-8 min-w-0 flex-1 items-center gap-2 border border-input bg-muted/30 px-2 focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/20">
              {address.startsWith("https://") ? <LockKeyhole className="h-3 w-3 shrink-0 text-emerald-600" /> : <Globe2 className="h-3 w-3 shrink-0 text-muted-foreground" />}
              <input
                ref={addressRef}
                value={address}
                onChange={(event) => setAddress(event.target.value)}
                className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
                placeholder="Search or enter an address"
                aria-label="Browser address"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
              />
              {commandBusy === "navigate" && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
            </div>
          </form>

          <div
            ref={viewportContainerRef}
            className="relative min-h-0 flex-1 overflow-hidden bg-[#20211f] outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
            tabIndex={0}
            role="application"
            aria-label="Interactive browser viewport"
            onMouseMove={(event) => sendMouse(event, "mouseMoved")}
            onMouseDown={(event) => {
              event.currentTarget.focus();
              sendMouse(event, "mousePressed");
            }}
            onMouseUp={(event) => sendMouse(event, "mouseReleased")}
            onWheel={sendWheel}
            onKeyDown={(event) => sendKey(event, "keyDown")}
            onKeyUp={(event) => sendKey(event, "keyUp")}
            onContextMenu={(event) => event.preventDefault()}
          >
            {!hasFrame && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-xs text-[#b6b7b0]">
                {streamState === "connecting" || streamState === "reconnecting" ? <Loader2 className="h-5 w-5 animate-spin" /> : <MonitorUp className="h-7 w-7 opacity-60" />}
                <span>{streamLabel}</span>
              </div>
            )}
            <canvas
              ref={canvasRef}
              aria-label="Live browser viewport"
              className={cn("pointer-events-none h-full w-full select-none object-contain", !hasFrame && "invisible")}
            />
          </div>

          <div className="flex h-7 shrink-0 items-center justify-between gap-3 border-t border-border bg-background px-2.5 font-mono text-[10px] text-muted-foreground">
            <div className="flex min-w-0 items-center gap-2.5">
              <span className={cn("inline-flex items-center gap-1.5 font-sans font-medium", streamState === "live" ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground")}>
                {streamState === "error" ? <WifiOff className="h-3 w-3" /> : <Radio className={cn("h-3 w-3", streamState === "live" && "animate-pulse")} />}
                {streamLabel}
              </span>
              <span className="truncate">{selected.session}</span>
              <span className="hidden sm:inline">{selected.engine}</span>
              <span className="hidden md:inline">interactive</span>
            </div>
            <div className="flex shrink-0 items-center gap-2.5">
              <span>{metrics.fps} fps</span>
              <span className="hidden sm:inline">{metrics.frameKb} KB/frame</span>
              <span>{viewport.width}×{viewport.height}</span>
            </div>
          </div>
        </div>
      ) : (
        <EmptyState
          running={status?.running ?? false}
          probing={status === null && statusError === null}
          onStart={start}
          onLaunch={launchChrome}
          starting={busy === "start" || chromeBusy}
        />
      )}
    </section>
  );
}

function EmptyState({
  running,
  probing,
  onStart,
  onLaunch,
  starting,
}: {
  running: boolean;
  probing: boolean;
  onStart: () => void;
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
      <Button type="button" size="sm" className="h-8 gap-1.5 text-xs" onClick={running ? onLaunch : onStart} disabled={starting}>
        {starting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
        {running ? "Launch Chrome" : "Start live view"}
      </Button>
    </div>
  );
}
