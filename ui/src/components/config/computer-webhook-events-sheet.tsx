/**
 * Settings → Computers → a provider's webhooks → its event log: every delivery the provider sent
 * (the last 200), newest first, with its outcome (accepted / ignored / rejected / error), the event
 * type, the sandbox and the computer it matched, and why it was ignored or refused. Filters by
 * outcome; live (`computer:webhook` over the app's SSE stream). A delivery opens in a dialog with
 * what Polpo did (the computer's status before and after) and its redacted payload.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useEvents } from "@polpo-ai/react";
import { Check, Copy, Inbox, Loader2, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { BrandIcon } from "@/components/shared/brand-icon";
import {
  COMPUTER_WEBHOOK_OUTCOMES, computerWebhooksApi, formatLastUsed, formatWebhookCountsBefore,
  type ComputerWebhookEvent, type ComputerWebhookEventPage, type ComputerWebhookEventSummary, type ComputerWebhookOutcome, type ComputerWebhookStatus,
} from "@/lib/computers-api";
import { cn } from "@/lib/utils";

const WEBHOOK_EVENTS = ["computer:webhook"];
const PAGE = 50;

/**
 * Deliveries counted before the event log existed (older instances): totals only, kept apart so the
 * counts above (the log's) and the log's entries always agree. Shown in the card and the sheet.
 */
export function WebhookCountsBefore({ s, className }: { s: ComputerWebhookStatus; className?: string }) {
  if (!s.before) return null;
  const counts = formatWebhookCountsBefore(s.before);
  if (!counts) return null;
  return (
    <p className={cn("text-caption text-muted-foreground", className)} data-testid="webhook-counts-before"
      title={`Counted before ${new Date(s.before.until).toLocaleString()}, when the event log started: only the totals were kept.`}>
      Before the event log: {counts} — no details
    </p>
  );
}

const OUTCOME: Record<ComputerWebhookOutcome, { label: string; className: string; hint: string }> = {
  accepted: { label: "Accepted", className: "border-success/30 bg-success/10 text-success", hint: "about one of this instance's computers: Polpo checked it at the provider" },
  ignored: { label: "Ignored", className: "border-border bg-muted/40 text-muted-foreground", hint: "signed, but not about a computer of this instance, a duplicate, or an event Polpo does not act on" },
  rejected: { label: "Rejected", className: "border-warning/30 bg-warning/10 text-warning", hint: "refused: signature, replay, size, rate, or webhooks not configured" },
  error: { label: "Error", className: "border-destructive/30 bg-destructive/10 text-destructive", hint: "accepted, but Polpo could not apply it" },
};

export function OutcomeBadge({ outcome }: { outcome: ComputerWebhookOutcome }) {
  const o = OUTCOME[outcome] ?? OUTCOME.ignored;
  return <Badge variant="outline" className={cn("font-normal", o.className)} data-testid="webhook-outcome" title={o.hint}>{o.label}</Badge>;
}

const time = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
};

function ComputerLink({ id }: { id: string }) {
  return <Link to={`/computers/${encodeURIComponent(id)}`} className="font-medium text-primary underline-offset-2 hover:underline" onClick={(e) => e.stopPropagation()}>{id}</Link>;
}

/** "sandbox abc → nina" */
function Target({ e }: { e: ComputerWebhookEventSummary }) {
  const machine = e.sandboxId ?? (e.snapshotName ? `snapshot ${e.snapshotName}` : undefined);
  if (!machine && !e.computerId) return null;
  return (
    <span className="flex min-w-0 items-center gap-1">
      {machine && <code className="min-w-0 truncate text-caption text-muted-foreground" title={machine}>{machine}</code>}
      {e.computerId && <><span className="text-muted-foreground" aria-hidden>→</span><ComputerLink id={e.computerId} /></>}
    </span>
  );
}

function statusLine(e: ComputerWebhookEventSummary): string | undefined {
  const s = e.statusChange;
  if (!s) return undefined;
  if (!s.appliedAt) return `checking (was ${s.from ?? "unknown"})`;
  if (s.error) return `failed: ${s.error}`;
  return s.to && s.to !== s.from ? `${s.from ?? "?"} → ${s.to}` : `no change (${s.to ?? s.from ?? "unknown"})`;
}

function EventRow({ e, onOpen }: { e: ComputerWebhookEventSummary; onOpen: () => void }) {
  const status = statusLine(e);
  return (
    <li>
      <div role="button" tabIndex={0} onClick={onOpen} onKeyDown={(k) => { if (k.key === "Enter" || k.key === " ") { k.preventDefault(); onOpen(); } }}
        className="flex w-full cursor-pointer flex-col gap-1 rounded-md px-3 py-2 text-left hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        data-testid="webhook-event-row" aria-label={`Delivery ${e.eventType ?? ""} ${e.outcome}`}>
        <div className="flex min-w-0 items-center gap-2">
          <OutcomeBadge outcome={e.outcome} />
          <span className="min-w-0 truncate font-mono text-caption">{e.eventType ?? "(no event type)"}</span>
          <span className="ml-auto shrink-0 text-caption text-muted-foreground" title={time(e.receivedAt)}>{formatLastUsed(e.receivedAt)}</span>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-caption">
          <Target e={e} />
          {status && <span className="text-muted-foreground">{status}</span>}
        </div>
        {e.reason && <p className={cn("text-caption", e.outcome === "rejected" ? "text-warning" : e.outcome === "error" ? "text-destructive" : "text-muted-foreground")}>{e.reason}</p>}
      </div>
    </li>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (<><dt className="text-muted-foreground">{label}</dt><dd className="min-w-0 break-words">{children}</dd></>);
}

/** One delivery: what Polpo did and its redacted payload. */
export function WebhookEventDialog({ provider, id, onClose }: { provider: string; id: string | null; onClose: () => void }) {
  // what was loaded, for which delivery (another id shows "Loading…" until its own answer)
  const [loaded, setLoaded] = useState<{ id: string; event?: ComputerWebhookEvent; error?: string } | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!id) return;
    let alive = true;
    computerWebhooksApi.event(provider, id).then(
      (e) => { if (alive) setLoaded({ id, event: e }); },
      (e: unknown) => { if (alive) setLoaded({ id, error: (e as Error).message }); },
    );
    return () => { alive = false; };
  }, [provider, id]);
  const current = loaded && loaded.id === id ? loaded : null;
  const event = current?.event ?? null;
  const error = current?.error ?? null;
  const payload = event?.payload === undefined ? undefined : typeof event.payload === "string" ? event.payload : JSON.stringify(event.payload, null, 2);
  const status = event ? statusLine(event) : undefined;
  return (
    <Dialog open={!!id} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="flex max-h-[85vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl" data-testid="webhook-event-dialog">
        <DialogHeader className="shrink-0 border-b px-6 pb-4 pt-6 pr-12">
          <DialogTitle className="flex flex-wrap items-center gap-2 leading-tight">
            <span className="font-mono text-body">{event?.eventType ?? "Delivery"}</span>
            {event && <OutcomeBadge outcome={event.outcome} />}
          </DialogTitle>
          <DialogDescription>{event ? `Received ${time(event.receivedAt)} (${formatLastUsed(event.receivedAt)})` : "Loading the delivery…"}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
          {!event && !error && <p className="flex items-center gap-2 py-4 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</p>}
          {event && (
            <div className="space-y-4 pb-2">
              <section className="space-y-1.5">
                <h3 className="text-small font-medium">What Polpo did</h3>
                <p className="text-sm" data-testid="webhook-event-action">{event.action ?? (event.outcome === "rejected" ? "Refused it (nothing was applied)" : "Nothing")}</p>
                {event.reason && <p className={cn("text-sm", event.outcome === "rejected" ? "text-warning" : event.outcome === "error" ? "text-destructive" : "text-muted-foreground")}>{event.reason}</p>}
              </section>
              <dl className="grid grid-cols-[minmax(7rem,auto)_1fr] gap-x-3 gap-y-1 text-xs">
                {event.sandboxId && <Field label="Sandbox"><code>{event.sandboxId}</code></Field>}
                {event.snapshotName && <Field label="Snapshot"><code>{event.snapshotName}</code></Field>}
                <Field label="Computer">{event.computerId ? <ComputerLink id={event.computerId} /> : <span className="text-muted-foreground">none of this instance's</span>}</Field>
                {event.providerState && <Field label="Provider says">{[event.providerState.from, event.providerState.to].filter(Boolean).join(" → ")}</Field>}
                {status && <Field label="Computer status">{status}</Field>}
                <Field label="Signature">{event.signature}</Field>
                <Field label="Answer">HTTP {event.httpStatus} in {event.processingMs} ms</Field>
                <Field label="Size">{event.bytes.toLocaleString()} bytes{event.events !== undefined ? ` · ${event.events} event${event.events === 1 ? "" : "s"}` : ""}</Field>
                {event.deliveryId && <Field label="Delivery id"><code>{event.deliveryId}</code></Field>}
                {event.providerEventId && <Field label="Event id"><code className="break-all">{event.providerEventId}</code></Field>}
                <Field label="Log id"><code>{event.id}</code></Field>
              </dl>
              {event.headers && Object.keys(event.headers).length > 0 && (
                <section className="space-y-1.5">
                  <h3 className="text-small font-medium">Headers <span className="font-normal text-muted-foreground">(safe ones only)</span></h3>
                  <dl className="grid grid-cols-[minmax(7rem,auto)_1fr] gap-x-3 gap-y-1 text-xs">
                    {Object.entries(event.headers).map(([k, v]) => <Field key={k} label={k}><code className="break-all">{v}</code></Field>)}
                  </dl>
                </section>
              )}
              <section className="space-y-1.5">
                <h3 className="text-small font-medium">Payload <span className="font-normal text-muted-foreground">(secrets redacted{event.payloadTruncated ? ", truncated" : ""})</span></h3>
                {payload === undefined
                  ? <p className="text-xs text-muted-foreground">Not kept ({event.httpStatus === 413 ? "too large" : event.httpStatus === 429 ? "rate limited" : "empty"}).</p>
                  : <pre className="max-h-80 overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-caption leading-relaxed" data-testid="webhook-event-payload">{payload}</pre>}
              </section>
            </div>
          )}
          <DialogFooter sticky>
            {payload !== undefined && (
              <Button variant="outline" onClick={() => { void navigator.clipboard?.writeText(payload).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => undefined); }}>
                {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />} Copy payload
              </Button>
            )}
            <Button onClick={onClose}>Close</Button>
          </DialogFooter>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

/** What the empty log says: not configured, waiting (Daytona v2 sends nothing), or nothing for this filter. */
function Empty({ s, filtered }: { s: ComputerWebhookStatus; filtered: boolean }) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-10 text-center" data-testid="webhook-events-empty">
      <Inbox className="h-6 w-6 text-muted-foreground" aria-hidden />
      {filtered ? (
        <p className="text-sm text-muted-foreground">No delivery with this outcome among the ones kept.</p>
      ) : s.state === "not-configured" ? (
        <p className="max-w-sm text-sm text-muted-foreground">
          {s.label} webhooks are not configured yet: set them up in the card. Until then deliveries are refused (and shown here as rejected) and Polpo checks every computer every 5 minutes.
        </p>
      ) : (
        <>
          <p className="text-sm font-medium">No delivery received yet</p>
          <p className="max-w-sm text-sm text-muted-foreground">{s.waitingNote ?? "Waiting for the first event. Polpo also checks every computer at its provider every 5 minutes and whenever it is used."}</p>
        </>
      )}
    </div>
  );
}

/** The provider's event log, in a sheet. */
export function WebhookEventsSheet({ s, open, onOpenChange }: { s: ComputerWebhookStatus; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [filter, setFilter] = useState<ComputerWebhookOutcome | "all">("all");
  const [page, setPage] = useState<ComputerWebhookEventPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);
  const provider = s.provider;

  useEffect(() => {
    if (!open) return;
    let alive = true;
    computerWebhooksApi.events(provider, { limit: PAGE, ...(filter !== "all" ? { outcome: [filter] } : {}) }).then(
      (p) => { if (alive) { setPage(p); setError(null); } },
      (e: unknown) => { if (alive) setError((e as Error).message); },
    );
    return () => { alive = false; };
  }, [open, provider, filter, version]);

  // live: a delivery recorded (or applied) for this provider reloads the first page
  const { events } = useEvents(WEBHOOK_EVENTS, 20);
  const latest = events.at(-1);
  const handled = useRef(latest?.id);
  useEffect(() => {
    if (!latest || handled.current === latest.id) return;
    handled.current = latest.id;
    if ((latest.data as { provider?: string } | undefined)?.provider === provider && open) reload();
  }, [latest, provider, open, reload]);

  const more = async () => {
    if (!page?.nextCursor) return;
    setLoadingMore(true);
    try {
      const next = await computerWebhooksApi.events(provider, { limit: PAGE, cursor: page.nextCursor, ...(filter !== "all" ? { outcome: [filter] } : {}) });
      setPage((p) => p && { ...next, events: [...p.events, ...next.events] });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoadingMore(false);
    }
  };

  const counts = page?.counts;
  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-xl" data-testid="webhook-events-sheet">
          <SheetHeader className="shrink-0 border-b pr-12">
            <SheetTitle className="flex items-center gap-2"><BrandIcon name={provider} size={18} /> {s.label} webhook events</SheetTitle>
            <SheetDescription>
              Every delivery {s.label} sent to this instance (the last 200 are kept), newest first. Click one for what Polpo did and its payload.
            </SheetDescription>
            <WebhookCountsBefore s={s} />
            <div className="flex flex-wrap items-center gap-1.5 pt-1" role="group" aria-label="Filter by outcome">
              {(["all", ...COMPUTER_WEBHOOK_OUTCOMES] as const).map((o) => {
                const n = o === "all" ? page?.total : counts?.[o];
                return (
                  <Button key={o} size="sm" variant={filter === o ? "default" : "outline"} className="h-7 px-2.5 text-caption" aria-pressed={filter === o}
                    onClick={() => setFilter(o)} data-testid={`webhook-filter-${o}`}>
                    {o === "all" ? "All" : OUTCOME[o].label}{n !== undefined ? <span className="tabular-nums opacity-70">{n}</span> : null}
                  </Button>
                );
              })}
              <Button size="icon" variant="ghost" className="ml-auto h-7 w-7" onClick={reload} aria-label="Refresh events"><RefreshCw className="h-3.5 w-3.5" /></Button>
            </div>
          </SheetHeader>
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {error && <p className="px-3 py-2 text-sm text-destructive" role="alert">{error}</p>}
            {!page && !error && <p className="flex items-center gap-2 px-3 py-4 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</p>}
            {page && page.events.length === 0 && <Empty s={s} filtered={filter !== "all" && page.total > 0} />}
            {page && page.events.length > 0 && (
              <ul className="divide-y" data-testid="webhook-events">
                {page.events.map((e) => <EventRow key={e.id} e={e} onOpen={() => setSelected(e.id)} />)}
              </ul>
            )}
            {page?.nextCursor && (
              <div className="flex justify-center py-3">
                <Button size="sm" variant="outline" disabled={loadingMore} onClick={() => void more()}>{loadingMore && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Older deliveries</Button>
              </div>
            )}
          </div>
        </SheetContent>
      </Sheet>
      <WebhookEventDialog provider={provider} id={selected} onClose={() => setSelected(null)} />
    </>
  );
}
