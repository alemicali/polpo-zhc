/**
 * ComputerLivePanel — a remote computer's desktop, live (noVNC), with take control.
 *
 * - The live view of its virtual display, where the agents' headed browsers open (agent
 *   browserHeaded). It connects by itself whenever the desktop runs (an agent's takeover request
 *   starts it; a restarted server re-attaches); Start starts it (starts or wakes the computer).
 * - The server answers the VM's VNC password itself (the browser connects with security type
 *   None, no password ever reaches it) and lets input through only for the person holding the
 *   computer, per message: "Take control" and "Give back" flip the same connection at once, no
 *   reconnect. View-only while the agent holds it; the agent's browser tools wait while a person
 *   does. "Give back" returns it, with an optional note the agent reads.
 * - Quality follows the role: sharper and less compressed while you have control, lighter while
 *   you watch (noVNC qualityLevel/compressionLevel, changed on the fly).
 * - Agents waiting for a person (request_computer_takeover) show as a banner: reason, page, what
 *   to do, until when they wait.
 *
 * - Full screen (Fullscreen API on the viewer; Esc exits): noVNC scales the desktop to fit, and
 *   the keyboard stays on the desktop while you hold control.
 *
 * - Clipboard: what is copied on the desktop shows in the Clipboard box (Copy puts it on this
 *   device's clipboard); while you hold control, text sent from the box lands on the desktop's
 *   clipboard (paste it there with Ctrl+V). noVNC has no automatic clipboard sync.
 * - The viewer keeps the desktop's proportions (its size: the computer's desktop.size).
 *
 * Passwords and codes are typed in the live view, never in Polpo. Live: computer:takeover.
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { useEvents, type ComputerDesktopView, type ComputerTakeoverRequest } from "@polpo-ai/react";
import { ClipboardCopy, ClipboardList, ClipboardPaste, Hand, Loader2, Maximize2, Minimize2, MonitorPlay, MonitorStop, TriangleAlert, Undo2, WifiOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { config, websocketUrl } from "@/lib/config";
import { computersApi, formatLastUsed } from "@/lib/computers-api";
import { cn } from "@/lib/utils";
import { desktopAspect } from "@/lib/desktop-aspect";

type VncClient = import("@novnc/novnc").default;
type StreamState = "idle" | "connecting" | "live" | "reconnecting" | "error";

/** "until 14:05" */
const until = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

export function TakeoverRequestBanner({ requests, className }: { requests: ComputerTakeoverRequest[]; className?: string }) {
  if (!requests.length) return null;
  return (
    <div className={cn("space-y-1.5 rounded-control border border-warning/30 bg-warning/10 p-3 text-xs", className)} role="status" data-testid="takeover-requests">
      {requests.map((r) => (
        <div key={r.id} className="min-w-0 space-y-0.5" data-request={r.id}>
          <p className="flex flex-wrap items-center gap-1.5 font-medium text-warning">
            <Hand className="h-3.5 w-3.5" />
            {r.status === "in_control" ? `${r.agent} is waiting for you to give control back` : `${r.agent} needs you to take control`}
            <span className="font-normal text-muted-foreground">· waits until {until(r.expiresAt)}</span>
          </p>
          <p className="break-words text-foreground">{r.reason}</p>
          {r.url && <p className="break-all text-muted-foreground">Page: {r.url}</p>}
          {r.whatToDo && <p className="break-words text-muted-foreground">To do: {r.whatToDo}</p>}
        </div>
      ))}
    </div>
  );
}

const LIVE_EVENTS = ["computer:takeover", "computer:changed"];

/** JPEG quality and zlib compression (0-9): sharp and quick to encode in control, light to watch. */
export const LIVE_QUALITY = { control: { quality: 8, compression: 2 }, view: { quality: 5, compression: 7 } } as const;

/** The live view with this person's viewer access, live (computer:takeover, computer:changed). */
function useDesktopView(computerId: string) {
  const [view, setView] = useState<ComputerDesktopView>();
  const [isLoading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const load = useCallback(async () => {
    try { setView(await computersApi.desktop(computerId, true)); setError(null); }
    catch (e) { setError(e as Error); }
    finally { setLoading(false); }
  }, [computerId]);
  useEffect(() => { setLoading(true); void load(); }, [load]);
  const { events } = useEvents(LIVE_EVENTS, 5);
  const latest = events.at(-1);
  const [handled, setHandled] = useState(latest?.id);
  useEffect(() => {
    if (!latest || handled === latest.id) return;
    setHandled(latest.id);
    if ((latest.data as { id?: string } | undefined)?.id === computerId) void load();
  }, [latest, handled, computerId, load]);
  const apply = (p: Promise<ComputerDesktopView>) => p.then((v) => { setView(v); return v; });
  return {
    view, isLoading, error,
    start: () => apply(computersApi.desktopStart(computerId)),
    stop: () => apply(computersApi.desktopStop(computerId)),
    takeover: (o: { force?: boolean } = {}) => apply(computersApi.takeover(computerId, !!o.force)),
    release: (o: { note?: string } = {}) => apply(computersApi.release(computerId, o.note)),
  };
}

/** Whether `el` is the document's full-screen element now (kept in sync with fullscreenchange). */
function useFullscreen(ref: RefObject<HTMLElement | null>) {
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    const sync = () => setFullscreen(!!ref.current && document.fullscreenElement === ref.current);
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, [ref]);
  const toggle = useCallback(async () => {
    const el = ref.current;
    if (!el) return;
    if (document.fullscreenElement === el) { await document.exitFullscreen?.(); return; }
    if (typeof el.requestFullscreen !== "function") throw new Error("Full screen is not available in this browser");
    await el.requestFullscreen({ navigationUI: "hide" });
  }, [ref]);
  return { fullscreen, toggle };
}


/** The largest text sent to the desktop's clipboard (the server's limit for a viewer's message is larger). */
export const CLIPBOARD_MAX_CHARS = 100_000;

/**
 * The desktop's clipboard and this device's: the latest text copied on the desktop (Copy puts it
 * on this device's clipboard) and, while you hold control, a box whose text goes to the desktop's.
 */
function ClipboardBox({ fromDesktop, canSend, onSend }: { fromDesktop: string; canSend: boolean; onSend: (text: string) => void }) {
  const [draft, setDraft] = useState("");
  const [copied, setCopied] = useState(false);
  const [sent, setSent] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(fromDesktop); setCopied(true); window.setTimeout(() => setCopied(false), 1500); } catch { setCopied(false); }
  };
  return (
    <div className="grid gap-2 rounded-control border border-border bg-muted/30 p-2 text-xs sm:grid-cols-2" data-testid="computer-clipboard">
      <div className="min-w-0 space-y-1">
        <div className="flex items-center gap-2">
          <span className="font-medium">Copied on the desktop</span>
          <Button size="sm" variant="ghost" className="ml-auto h-6 gap-1 px-2 text-xs" disabled={!fromDesktop} onClick={() => void copy()} title="Put it on this device's clipboard">
            <ClipboardCopy className="h-3.5 w-3.5" /> {copied ? "Copied" : "Copy"}
          </Button>
        </div>
        <Textarea readOnly rows={3} value={fromDesktop} placeholder="Copy text on the desktop (Ctrl+C): it shows here" aria-label="Copied on the desktop" className="text-xs" data-testid="clipboard-from-desktop" />
      </div>
      <div className="min-w-0 space-y-1">
        <div className="flex items-center gap-2">
          <span className="font-medium">Send to the desktop</span>
          <Button size="sm" variant="ghost" className="ml-auto h-6 gap-1 px-2 text-xs" disabled={!canSend || !draft}
            onClick={() => { onSend(draft.slice(0, CLIPBOARD_MAX_CHARS)); setSent(true); window.setTimeout(() => setSent(false), 1500); }}
            title={canSend ? "Put it on the desktop's clipboard, then paste there with Ctrl+V" : "Take control to send text to the desktop"}>
            <ClipboardPaste className="h-3.5 w-3.5" /> {sent ? "Sent" : "Send"}
          </Button>
        </div>
        <Textarea rows={3} value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={CLIPBOARD_MAX_CHARS} disabled={!canSend}
          placeholder={canSend ? "Paste here, send, then Ctrl+V on the desktop" : "Take control to send text to the desktop"} aria-label="Send to the desktop" className="text-xs" data-testid="clipboard-to-desktop" />
      </div>
    </div>
  );
}

/** The viewer's role on a live connection: input, focus, cursor and quality (no reconnect). */
function applyRole(client: VncClient, viewOnly: boolean): void {
  const q = viewOnly ? LIVE_QUALITY.view : LIVE_QUALITY.control;
  client.viewOnly = viewOnly;
  client.focusOnClick = !viewOnly;
  // the remote cursor (x11vnc -cursor arrow) is drawn by noVNC; a dot when it is invisible
  client.showDotCursor = !viewOnly;
  client.qualityLevel = q.quality;
  client.compressionLevel = q.compression;
}

export function ComputerLivePanel({ computerId, className }: { computerId: string; className?: string }) {
  const { view, isLoading, error, start, stop, takeover, release } = useDesktopView(computerId);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [stream, setStream] = useState<StreamState>("idle");
  const [showClipboard, setShowClipboard] = useState(false);
  const [desktopClipboard, setDesktopClipboard] = useState("");
  const screenRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<HTMLDivElement | null>(null);
  const clientRef = useRef<VncClient | null>(null);
  const { fullscreen, toggle: toggleFullscreen } = useFullscreen(viewerRef);

  const desktop = view?.desktop;
  const control = view?.control;
  const viewer = view?.viewer;
  const running = desktop?.state === "running";
  const mine = viewer?.mode === "control";
  const heldByOther = control?.holder === "person" && !mine;
  const aspect = desktopAspect(desktop?.size);

  const act = async (what: string, fn: () => Promise<unknown>) => {
    setBusy(what);
    setActionError(null);
    try { await fn(); } catch (e) { setActionError((e as Error).message); } finally { setBusy(null); }
  };

  // the viewer: one connection while the live view runs (control flips on it, no reconnect)
  const path = viewer?.path;
  const viewOnly = !mine;
  const viewOnlyRef = useRef(viewOnly);
  viewOnlyRef.current = viewOnly;
  useEffect(() => {
    const screen = screenRef.current;
    if (!running || !path || !screen) { setStream("idle"); return; }
    let disposed = false;
    let retry: number | null = null;
    let attempt = 0;
    let client: VncClient | null = null;
    const connect = async () => {
      if (disposed) return;
      setStream(attempt ? "reconnecting" : "connecting");
      const { default: RFB } = await import("@novnc/novnc");
      if (disposed) return;
      screen.replaceChildren();
      const url = new URL(websocketUrl(path));
      if (config.apiKey) url.searchParams.set("api_key", config.apiKey);
      // security type None: the server authenticates to the VM, the browser never has a password
      client = new RFB(screen, url.toString(), { shared: true }) as VncClient;
      clientRef.current = client;
      client.scaleViewport = true;
      client.resizeSession = false;
      client.background = "var(--muted)";
      applyRole(client, viewOnlyRef.current);
      client.addEventListener("connect", () => { if (!disposed) { attempt = 0; setStream("live"); } });
      client.addEventListener("securityfailure", () => { if (!disposed) setStream("error"); });
      // what is copied on the desktop (ServerCutText: every viewer gets it)
      client.addEventListener("clipboard", (e) => { if (!disposed) setDesktopClipboard(e.detail.text); });
      client.addEventListener("disconnect", () => {
        if (disposed) return;
        clientRef.current = null;
        attempt += 1;
        if (attempt > 5) { setStream("error"); return; }
        setStream("reconnecting");
        retry = window.setTimeout(() => void connect(), Math.min(5000, 600 * 2 ** (attempt - 1)));
      });
    };
    void connect();
    return () => {
      disposed = true;
      if (retry !== null) window.clearTimeout(retry);
      client?.disconnect();
      clientRef.current = null;
      screen.replaceChildren();
    };
  }, [running, path]);

  // control changed hands: the same connection becomes interactive (or view-only), with its quality
  useEffect(() => {
    if (clientRef.current) applyRole(clientRef.current, viewOnly);
  }, [viewOnly]);

  // in and out of full screen: the keyboard stays on the desktop while you hold control
  useEffect(() => {
    if (!viewOnly) clientRef.current?.focus({ preventScroll: true });
  }, [fullscreen, viewOnly]);

  const fullscreenFailed = (e: unknown) => setActionError((e as Error).message || "Full screen is not available in this browser");

  if (isLoading && !view) {
    return <p className={cn("flex items-center gap-2 text-xs text-muted-foreground", className)}><Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading the live view…</p>;
  }
  if (desktop?.state === "unsupported") {
    return <p className={cn("text-xs text-muted-foreground", className)}>{desktop.note ?? "This computer has no live view."}</p>;
  }

  const holderText = control?.holder === "person"
    ? `${mine ? "You have" : `${control.person ?? "Someone"} has`} control since ${formatLastUsed(control.since)}: the agent's browser waits.`
    : "The agent has control: you watch, view-only.";

  return (
    <div className={cn("flex min-w-0 flex-col gap-3", className)} data-testid="computer-live">
      <TakeoverRequestBanner requests={control?.open ?? []} />

      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className={cn("h-2 w-2 shrink-0 rounded-pill", stream === "live" ? "bg-success" : stream === "connecting" || stream === "reconnecting" ? "animate-pulse bg-warning" : "bg-muted-foreground/40")}
          title={stream === "live" ? "Connected" : stream === "error" ? "Not connected" : "Connecting"} />
        <span className="min-w-0 flex-1 text-muted-foreground" data-testid="computer-control-holder">{running ? holderText : desktop?.state === "machine-off" ? "Its machine is off: starting the live view starts it." : desktop?.note ?? "The live view is off."}</span>
        {running ? (
          <>
            {mine ? (
              <Button size="sm" className="h-7 gap-1.5 px-2.5 text-xs" disabled={busy !== null} onClick={() => void act("release", async () => { await release(note.trim() ? { note: note.trim() } : {}); setNote(""); })}>
                {busy === "release" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Undo2 className="h-3.5 w-3.5" />} Give back
              </Button>
            ) : (
              <Button size="sm" className="h-7 gap-1.5 px-2.5 text-xs" disabled={busy !== null} onClick={() => void act("takeover", () => takeover(heldByOther ? { force: true } : {}))}
                title={heldByOther ? `${control?.person ?? "Someone"} has control: take it from them` : "Interact with the desktop; the agent's browser waits"}>
                {busy === "takeover" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Hand className="h-3.5 w-3.5" />} Take control
              </Button>
            )}
            <Button size="sm" variant="ghost" className="h-7 gap-1.5 px-2.5 text-xs" onClick={() => setShowClipboard((v) => !v)}
              title="Text copied on the desktop, and text to send to it" aria-pressed={showClipboard} data-testid="clipboard-toggle">
              <ClipboardList className="h-3.5 w-3.5" /> Clipboard
            </Button>
            <Button size="sm" variant="ghost" className="h-7 gap-1.5 px-2.5 text-xs" onClick={() => void toggleFullscreen().catch(fullscreenFailed)}
              title="Show the desktop full screen (Esc exits)" aria-pressed={fullscreen}>
              <Maximize2 className="h-3.5 w-3.5" /> Full screen
            </Button>
            <Button size="sm" variant="ghost" className="h-7 gap-1.5 px-2.5 text-xs" disabled={busy !== null} onClick={() => void act("stop", stop)}>
              {busy === "stop" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <MonitorStop className="h-3.5 w-3.5" />} Stop live view
            </Button>
          </>
        ) : (
          <Button size="sm" variant="outline" className="h-7 gap-1.5 px-2.5 text-xs" disabled={busy !== null} onClick={() => void act("start", start)}>
            {busy === "start" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <MonitorPlay className="h-3.5 w-3.5" />} Start live view
          </Button>
        )}
      </div>

      {mine && (
        <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} className="h-8 text-xs"
          placeholder="Note for the agent when you give it back (what you did; never a password)" aria-label="Note for the agent" />
      )}

      {running && showClipboard && (
        <ClipboardBox fromDesktop={desktopClipboard} canSend={mine && stream === "live"} onSend={(text) => clientRef.current?.clipboardPasteFrom(text)} />
      )}

      {(actionError || error || desktop?.error) && (
        <p className="flex items-start gap-1.5 text-xs text-destructive" role="alert"><TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />{actionError ?? error?.message ?? desktop?.error}</p>
      )}

      {running && (
        <div
          ref={viewerRef}
          className={cn(
            "relative w-full overflow-hidden bg-muted",
            fullscreen ? "h-full" : cn("rounded-control ring-1 ring-inset", aspect ? "" : "aspect-[16/10]", mine ? "ring-primary" : "ring-border"),
          )}
          style={!fullscreen && aspect ? { aspectRatio: aspect } : undefined}
          data-size={desktop?.size}
          role="application"
          aria-label={mine ? "Computer desktop (you have control)" : "Computer desktop (view-only)"}
          data-fullscreen={fullscreen || undefined}
          onPointerDown={() => { if (mine) clientRef.current?.focus({ preventScroll: true }); }}
        >
          <div ref={screenRef} className="absolute inset-0 flex items-center justify-center overflow-hidden [&_canvas]:outline-none" />
          {fullscreen && (
            <Button size="sm" variant="secondary" className="absolute right-2 top-2 z-10 h-7 gap-1.5 px-2.5 text-xs opacity-80 hover:opacity-100"
              onClick={() => void toggleFullscreen().catch(fullscreenFailed)} title="Exit full screen (Esc)">
              <Minimize2 className="h-3.5 w-3.5" /> Exit full screen
            </Button>
          )}
          {stream !== "live" && (
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 bg-muted text-xs text-muted-foreground">
              {stream === "error" ? <WifiOff className="h-5 w-5 opacity-70" /> : <Loader2 className="h-5 w-5 animate-spin" />}
              <span>{stream === "error" ? "The live view is not reachable" : "Connecting to the desktop"}</span>
            </div>
          )}
        </div>
      )}
      {running && <p className="text-micro text-muted-foreground">Type passwords and codes here, in the live view: the agent never sees them.</p>}
    </div>
  );
}
