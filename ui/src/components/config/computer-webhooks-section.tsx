/**
 * Settings → Computers: whether the computers' providers push their machines' state to Polpo
 * (webhooks). Per provider: receiving / configured / not configured, the last event, the URL to give
 * the provider; Daytona: its signing secret (stored in the vault, never shown again); E2B: Register /
 * Unregister (Polpo registers the endpoint itself). Without webhooks, computers are checked every
 * 5 minutes (every 20 while events arrive, as a safety net) and whenever they are used. Each card's
 * "Events" row opens the provider's event log (every delivery and what Polpo did with it).
 */
import { useCallback, useEffect, useState } from "react";
import { Check, ChevronRight, Copy, Info, Loader2, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { BrandIcon } from "@/components/shared/brand-icon";
import { WebhookEventsSheet } from "@/components/config/computer-webhook-events-sheet";
import { computerWebhooksApi, formatLastUsed, type ComputerWebhookStatus } from "@/lib/computers-api";
import { notifySetupSaved } from "@/lib/setup-link";
import { cn } from "@/lib/utils";

const STATE: Record<ComputerWebhookStatus["state"], { label: string; className: string }> = {
  receiving: { label: "Receiving", className: "border-success/30 bg-success/10 text-success" },
  configured: { label: "Configured", className: "border-info/30 bg-info/10 text-info" },
  "not-configured": { label: "Not configured", className: "border-border bg-muted/40 text-muted-foreground" },
};

function CopyUrl({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <code className="min-w-0 flex-1 truncate rounded-xs border bg-muted/40 px-2 py-1 text-caption" data-testid="webhook-url">{url}</code>
      <Button size="icon" variant="ghost" className="h-7 w-7 shrink-0" aria-label="Copy the URL"
        onClick={() => { void navigator.clipboard?.writeText(url).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => undefined); }}>
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      </Button>
    </div>
  );
}

function ProviderCard({ s, onChanged }: { s: ComputerWebhookStatus; onChanged: (s: ComputerWebhookStatus) => void }) {
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [eventsOpen, setEventsOpen] = useState(false);
  const run = async (fn: () => Promise<ComputerWebhookStatus>, done?: string) => {
    setBusy(true);
    try {
      onChanged(await fn());
      if (done) toast.success(done);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const state = STATE[s.state];
  return (
    <div className="space-y-3 rounded-card border bg-card p-4" data-testid={`webhook-${s.provider}`} data-setup-item={s.provider}>
      <div className="flex flex-wrap items-center gap-2">
        <BrandIcon name={s.provider} size={18} />
        <span className="font-medium">{s.label}</span>
        <Badge variant="outline" className={cn("font-normal", state.className)} data-testid="webhook-state">{state.label}</Badge>
        {!s.inUse && <span className="text-caption text-muted-foreground">no computer on it</span>}
      </div>
      <button type="button" onClick={() => setEventsOpen(true)} data-testid="webhook-events-open" aria-label={`${s.label} webhook events`}
        className="group flex w-full items-center gap-3 rounded-md border bg-muted/20 px-3 py-2 text-left hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <dl className="grid min-w-0 flex-1 grid-cols-[minmax(6rem,auto)_1fr] gap-x-3 gap-y-1 text-xs">
          <dt className="text-muted-foreground">Last event</dt>
          <dd>{s.lastEventAt ? `${formatLastUsed(s.lastEventAt)}${s.lastEventType ? ` · ${s.lastEventType}` : ""}` : "none yet"}</dd>
          <dt className="text-muted-foreground">Deliveries</dt>
          <dd className="tabular-nums" data-testid="webhook-counts">
            {s.received - s.ignored - (s.errors ?? 0)} accepted · {s.ignored} ignored · {s.rejected} rejected{s.errors ? ` · ${s.errors} errors` : ""}
          </dd>
          {s.lastError && (<><dt className="text-muted-foreground">Last problem</dt><dd className="text-destructive" data-testid="webhook-last-error">{s.lastError}</dd></>)}
        </dl>
        <span className="flex shrink-0 items-center gap-0.5 text-caption text-muted-foreground group-hover:text-foreground">Events <ChevronRight className="h-3.5 w-3.5" /></span>
      </button>
      {s.waitingNote && (
        <p className="flex gap-2 rounded-md border border-info/30 bg-info/10 px-3 py-2 text-xs text-info" data-testid="webhook-waiting">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden /> <span>{s.waitingNote}</span>
        </p>
      )}
      {s.url ? <CopyUrl url={s.url} /> : <p className="text-xs text-warning">POLPO_PUBLIC_URL is not set: the provider has no address to call.</p>}
      {s.provider === "daytona" ? (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            In Daytona's dashboard: Webhooks → Add Endpoint, paste the URL above and pick <code>sandbox.created</code>, <code>sandbox.state.updated</code> and <code>snapshot.removed</code>. Then paste the endpoint's signing secret here (it goes to the vault and is never shown again).
          </p>
          <form className="flex flex-col gap-2 sm:flex-row" onSubmit={(e) => {
            e.preventDefault();
            void run(() => computerWebhooksApi.setSecret("daytona", secret), "Signing secret saved").then(() => { setSecret(""); notifySetupSaved(); });
          }}>
            <Input type="password" autoComplete="off" placeholder={s.secretSet ? "•••••• (saved; paste a new one to replace it)" : "whsec_…"} value={secret}
              onChange={(e) => setSecret(e.target.value)} aria-label="Daytona signing secret" data-setup-field="secret" className="h-8 text-sm" />
            <Button type="submit" size="sm" disabled={busy || !secret.trim()}>{busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Save</Button>
            {s.secretSet && (
              <Button type="button" size="sm" variant="ghost" className="text-destructive" disabled={busy}
                onClick={() => void run(() => computerWebhooksApi.removeSecret("daytona"), "Signing secret removed")} aria-label="Remove the Daytona signing secret">
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            )}
          </form>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <p className="min-w-0 flex-1 text-xs text-muted-foreground">Polpo registers this URL at E2B with a secret of its own (kept in the vault); it does so by itself when you have E2B computers.</p>
          {s.registered ? (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(() => computerWebhooksApi.unregisterE2b(), "E2B webhook removed")}>Unregister</Button>
          ) : (
            <Button size="sm" disabled={busy || !s.url} onClick={() => void run(() => computerWebhooksApi.registerE2b(), "E2B webhook registered")}>
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Register
            </Button>
          )}
        </div>
      )}
      <WebhookEventsSheet s={s} open={eventsOpen} onOpenChange={setEventsOpen} />
    </div>
  );
}

export function ComputerWebhooksSection() {
  const [data, setData] = useState<{ providers: ComputerWebhookStatus[]; note: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // bumped by the refresh button: the effect below loads again
  const [version, setVersion] = useState(0);
  const load = useCallback(() => setVersion((v) => v + 1), []);
  useEffect(() => {
    let alive = true;
    computerWebhooksApi.status().then(
      (d) => { if (alive) { setData(d); setError(null); } },
      (e: unknown) => { if (alive) setError((e as Error).message); },
    );
    return () => { alive = false; };
  }, [version]);
  return (
    <div className="space-y-4" data-testid="computer-webhooks">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="font-heading text-h3">Computers: provider webhooks</h2>
          <p className="max-w-prose text-small text-muted-foreground">
            With webhooks the provider tells Polpo at once when a computer's machine is stopped, paused or deleted outside Polpo. Without them,
            Polpo checks every 5 minutes (every 20 while events arrive, as a safety net) and whenever a computer is used. Open a provider's
            events to see every delivery it sent and what Polpo did with it.
          </p>
        </div>
        <Button size="icon" variant="outline" className="h-8 w-8 shrink-0" onClick={load} aria-label="Refresh webhooks"><RefreshCw className="h-3.5 w-3.5" /></Button>
      </div>
      {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
      {!data && !error && <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</p>}
      {data && (
        <>
          <div className="grid gap-3 lg:grid-cols-2">
            {data.providers.map((s) => (
              <ProviderCard key={s.provider} s={s} onChanged={(next) => setData((d) => d && { ...d, providers: d.providers.map((p) => (p.provider === next.provider ? next : p)) })} />
            ))}
          </div>
          <p className="text-xs text-muted-foreground">{data.note} Vercel Sandbox has no lifecycle webhooks: its computers are only checked.</p>
        </>
      )}
    </div>
  );
}
