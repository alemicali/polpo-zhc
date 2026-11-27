/**
 * ComputerLivePanel — a remote computer's desktop, live (noVNC), with take control.
 *
 * - The live view of its virtual display, where the agents' headed browsers open (agent
 *   browserHeaded). Start it (starts or wakes the computer) or stop it; it never starts by itself.
 * - View-only while the agent holds the computer. "Take control" gives it to this person: the
 *   viewer becomes interactive (the server hands out the full-control VNC password only to the
 *   person holding it, and changes the passwords whenever control changes hands, so viewers
 *   reconnect) and the agent's browser tools wait. "Give back" returns it, with an optional note
 *   the agent reads.
 * - Agents waiting for a person (request_computer_takeover) show as a banner: reason, page, what
 *   to do, until when they wait.
 *
 * Passwords and codes are typed in the live view, never in Polpo. Live: computer:takeover.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useEvents, type ComputerDesktopView, type ComputerTakeoverRequest } from "@polpo-ai/react";
import { Hand, Loader2, MonitorPlay, MonitorStop, TriangleAlert, Undo2, WifiOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { config, websocketUrl } from "@/lib/config";
import { computersApi, formatLastUsed } from "@/lib/computers-api";
import { cn } from "@/lib/utils";

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

export function ComputerLivePanel({ computerId, className }: { computerId: string; className?: string }) {
  const { view, isLoading, error, start, stop, takeover, release } = useDesktopView(computerId);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [stream, setStream] = useState<StreamState>("idle");
  const screenRef = useRef<HTMLDivElement | null>(null);
  const clientRef = useRef<VncClient | null>(null);

  const desktop = view?.desktop;
  const control = view?.control;
  const viewer = view?.viewer;
  const running = desktop?.state === "running";
  const mine = viewer?.mode === "control";
  const heldByOther = control?.holder === "person" && !mine;

  const act = async (what: string, fn: () => Promise<unknown>) => {
    setBusy(what);
    setActionError(null);
    try { await fn(); } catch (e) { setActionError((e as Error).message); } finally { setBusy(null); }
  };

  // the viewer: (re)connect whenever the password changes (control changed hands) or the mode does
  const password = viewer?.password;
  const path = viewer?.path;
  const viewOnly = !mine;
  useEffect(() => {
    const screen = screenRef.current;
    if (!running || !password || !path || !screen) { setStream("idle"); return; }
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
      client = new RFB(screen, url.toString(), { shared: true, credentials: { password } }) as VncClient;
      clientRef.current = client;
      client.scaleViewport = true;
      client.resizeSession = false;
      client.viewOnly = viewOnly;
      client.focusOnClick = !viewOnly;
      client.showDotCursor = !viewOnly;
      client.qualityLevel = 6;
      client.compressionLevel = 6;
      client.background = "var(--muted)";
      client.addEventListener("credentialsrequired", () => client?.sendCredentials({ password }));
      client.addEventListener("connect", () => { if (!disposed) { attempt = 0; setStream("live"); } });
      client.addEventListener("securityfailure", () => { if (!disposed) setStream("error"); });
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
  }, [running, password, path, viewOnly]);

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
        <span className="min-w-0 flex-1 text-muted-foreground" data-testid="computer-control-holder">{running ? holderText : desktop?.state === "machine-off" ? "Its machine is off: starting the live view starts it." : "The live view is off."}</span>
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

      {(actionError || error || desktop?.error) && (
        <p className="flex items-start gap-1.5 text-xs text-destructive" role="alert"><TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />{actionError ?? error?.message ?? desktop?.error}</p>
      )}

      {running && (
        <div
          className={cn("relative aspect-[16/10] w-full overflow-hidden rounded-control bg-muted ring-1 ring-inset", mine ? "ring-primary" : "ring-border")}
          role="application"
          aria-label={mine ? "Computer desktop (you have control)" : "Computer desktop (view-only)"}
          onPointerDown={() => { if (mine) clientRef.current?.focus({ preventScroll: true }); }}
        >
          <div ref={screenRef} className="absolute inset-0 flex items-center justify-center overflow-hidden [&_canvas]:outline-none" />
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
