/**
 * Settings → Channels → WhatsApp Business (official, Meta Cloud API).
 *
 * WaBusinessFields: the channel's own settings in the channel form — the phone number and account
 * ids, who it talks to (customers, answered only by the gateway's agent, or operators), the window
 * and template rules, the daily caps, the retention.
 *
 * WaBusinessLive (a saved channel): the status (receiving / configured / not configured, what is
 * missing), the secrets — stored in the vault, shown only as "stored" / "not set", never again —
 * with a generated verify token to copy once, the callback URL and the Tailscale Funnel command,
 * the webhook counts and the event log, the templates waiting for approval, and a test at Meta
 * (quality rating, messaging tier). Live over channel:webhook / channel:message-status.
 */
import { useCallback, useEffect, useState } from "react";
import { Check, Copy, Inbox, Loader2, RefreshCw, ShieldCheck, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { usePolpo, useWaBusinessStatus, useWaContacts, type NotificationChannelConfig, type WaBizSecretKind, type WaBusinessEvent, type WaBusinessEventPage, type WaBusinessMessage, type WaBusinessSettings } from "@polpo-ai/react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { OutcomeBadge } from "@/components/config/computer-webhook-events-sheet";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { notifySetupSaved } from "@/lib/setup-link";
import { cn } from "@/lib/utils";

const STATE: Record<"receiving" | "configured" | "not-configured", { label: string; className: string }> = {
  receiving: { label: "Receiving", className: "border-success/30 bg-success/10 text-success" },
  configured: { label: "Configured", className: "border-info/30 bg-info/10 text-info" },
  "not-configured": { label: "Not configured", className: "border-border bg-muted/40 text-muted-foreground" },
};

const SECRETS: Array<{ kind: WaBizSecretKind; label: string; hint: string; placeholder: string }> = [
  { kind: "accessToken", label: "Access token", hint: "A system user's token with whatsapp_business_messaging and whatsapp_business_management", placeholder: "EAAG…" },
  { kind: "appSecret", label: "App secret", hint: "Meta app → Settings → Basic: verifies every webhook delivery (X-Hub-Signature-256)", placeholder: "32 hex characters" },
  { kind: "verifyToken", label: "Verify token", hint: "The same value goes in Meta's webhook configuration: generate one here and copy it", placeholder: "or Generate" },
];

const CATEGORIES = ["UTILITY", "MARKETING", "AUTHENTICATION"] as const;

function Labeled({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label className="text-xs font-medium text-foreground">{label}</label>
      {children}
      {hint && <p className="text-micro text-muted-foreground leading-tight">{hint}</p>}
    </div>
  );
}

function CopyLine({ value, label, testId }: { value: string; label: string; testId?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <code className="min-w-0 flex-1 truncate rounded-xs border bg-muted/40 px-2 py-1 text-caption" title={value} data-testid={testId}>{value}</code>
      <Button size="icon" variant="ghost" className="h-7 w-7 shrink-0" aria-label={`Copy the ${label}`}
        onClick={() => { void navigator.clipboard?.writeText(value).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => undefined); }}>
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      </Button>
    </div>
  );
}

const list = (v: string) => v.split(",").map((s) => s.trim()).filter(Boolean);

/** The channel's settings in the channel form (no secrets: those are in WaBusinessLive, once saved). */
export function WaBusinessFields({ config, onChange }: {
  config: NotificationChannelConfig;
  onChange: (patch: Partial<NotificationChannelConfig>) => void;
}) {
  const b: WaBusinessSettings = config.business ?? {};
  const setB = (patch: Partial<WaBusinessSettings>) => onChange({ business: { ...b, ...patch } });
  const categories = b.allowedCategories ?? ["UTILITY"];
  const audience = b.audience ?? "customers";
  return (
    <div className="space-y-3" data-testid="wabiz-fields">
      <div className="grid grid-cols-2 gap-2">
        <Labeled label="Phone number ID" hint="WhatsApp Manager → API setup">
          <Input data-setup-field="phoneNumberId" className="h-8 text-xs font-mono" placeholder="1234567890" value={config.phoneNumberId ?? ""}
            onChange={(e) => onChange({ phoneNumberId: e.target.value.trim() || undefined })} />
        </Labeled>
        <Labeled label="WhatsApp Business Account ID" hint="Templates and the webhook subscription">
          <Input data-setup-field="wabaId" className="h-8 text-xs font-mono" placeholder="9876543210" value={config.wabaId ?? ""}
            onChange={(e) => onChange({ wabaId: e.target.value.trim() || undefined })} />
        </Labeled>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Labeled label="Who writes to it" hint={audience === "customers"
          ? "Anyone may write; only the agent chosen below answers, never Polpo. Give that agent minimal tools: what customers write is untrusted."
          : "The team's operators (allowlist below): they may use commands."}>
          <Select value={audience} onValueChange={(v) => setB({ audience: v as WaBusinessSettings["audience"] })}>
            <SelectTrigger className="h-8 text-xs w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="customers" className="text-xs">Customers (answered by an agent)</SelectItem>
              <SelectItem value="operators" className="text-xs">Operators (the team)</SelectItem>
            </SelectContent>
          </Select>
        </Labeled>
        <Labeled label="Graph API version" hint="Default v23.0">
          <Input className="h-8 text-xs font-mono" placeholder="v23.0" value={config.graphApiVersion ?? ""}
            onChange={(e) => onChange({ graphApiVersion: e.target.value.trim() || undefined })} />
        </Labeled>
      </div>
      <Labeled label="Operators" hint="Phone numbers with country code (digits): they use commands and get the notifications">
        <Input className="h-8 text-xs font-mono" placeholder="393331234567, 393339876543" value={(b.operators ?? []).join(", ")}
          onChange={(e) => { const ops = list(e.target.value); setB({ operators: ops.length ? ops : undefined }); }} />
      </Labeled>
      <div className="grid grid-cols-2 gap-2">
        <Labeled label="Business-initiated a day" hint="Templates sent by everyone, per day (default 50)">
          <Input type="number" min={0} className="h-8 text-xs" value={b.limits?.businessInitiatedPerDay ?? ""} placeholder="50"
            onChange={(e) => setB({ limits: { ...b.limits, businessInitiatedPerDay: e.target.value === "" ? undefined : Math.max(0, Math.floor(Number(e.target.value))) } })} />
        </Labeled>
        <Labeled label="Keep messages (days)" hint="Then they are deleted (default 90)">
          <Input type="number" min={1} max={3650} className="h-8 text-xs" value={b.retentionDays ?? ""} placeholder="90"
            onChange={(e) => setB({ retentionDays: e.target.value === "" ? undefined : Math.max(1, Math.floor(Number(e.target.value))) })} />
        </Labeled>
      </div>
      <Labeled label="Template categories agents may send" hint="Marketing needs the contact's opt-in: keep it off unless you collect it">
        <div className="flex flex-wrap gap-1.5">
          {CATEGORIES.map((c) => {
            const on = categories.includes(c);
            return (
              <Button key={c} type="button" size="sm" variant={on ? "default" : "outline"} className="h-7 text-xs" aria-pressed={on}
                onClick={() => { const next = on ? categories.filter((x) => x !== c) : [...categories, c]; setB({ allowedCategories: next.length ? next : undefined }); }}>
                {c.toLowerCase()}
              </Button>
            );
          })}
        </div>
      </Labeled>
      <div className="grid grid-cols-2 gap-2">
        <Labeled label="Templates from agents and Polpo" hint="With approval, an operator confirms each one before it goes out">
          <Select value={b.approveTemplates === false ? "direct" : "approve"} onValueChange={(v) => setB({ approveTemplates: v === "direct" ? false : undefined })}>
            <SelectTrigger className="h-8 text-xs w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="approve" className="text-xs">Wait for approval</SelectItem>
              <SelectItem value="direct" className="text-xs">Send at once</SelectItem>
            </SelectContent>
          </Select>
        </Labeled>
        <Labeled label="Notifications outside 24 h" hint="Free-form only inside the window">
          <Select value={b.outsideWindow ?? "fail"} onValueChange={(v) => setB({ outsideWindow: v as WaBusinessSettings["outsideWindow"] })}>
            <SelectTrigger className="h-8 text-xs w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="fail" className="text-xs">Fail (not sent)</SelectItem>
              <SelectItem value="template" className="text-xs">Send a template</SelectItem>
            </SelectContent>
          </Select>
        </Labeled>
      </div>
      {b.outsideWindow === "template" && (
        <div className="grid grid-cols-3 gap-2">
          <Labeled label="Template">
            <Input className="h-8 text-xs font-mono" placeholder="ops_alert" value={b.notificationTemplate?.name ?? ""}
              onChange={(e) => setB({ notificationTemplate: { language: "it", ...b.notificationTemplate, name: e.target.value.trim() } })} />
          </Labeled>
          <Labeled label="Language">
            <Input className="h-8 text-xs font-mono" placeholder="it" value={b.notificationTemplate?.language ?? ""}
              onChange={(e) => setB({ notificationTemplate: { name: "", ...b.notificationTemplate, language: e.target.value.trim() } })} />
          </Labeled>
          <Labeled label="Body parameters" hint="{title}, {body}, {severity}, {event}">
            <Input className="h-8 text-xs font-mono" placeholder="{title}, {body}" value={(b.notificationTemplate?.bodyParams ?? []).join(", ")}
              onChange={(e) => setB({ notificationTemplate: { name: "", language: "it", ...b.notificationTemplate, bodyParams: list(e.target.value) } })} />
          </Labeled>
        </div>
      )}
    </div>
  );
}

function SecretRow({ channel, spec, set, onSaved }: { channel: string; spec: (typeof SECRETS)[number]; set: boolean; onSaved: () => void }) {
  const { client } = usePolpo();
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [generated, setGenerated] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await fn();
      toast.success(done);
      onSaved();
      notifySetupSaved();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-1.5" data-testid={`wabiz-secret-${spec.kind}`}>
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium">{spec.label}</span>
        <Badge variant="outline" className={cn("font-normal", set ? "border-success/30 bg-success/10 text-success" : "border-warning/30 bg-warning/10 text-warning")}>
          {set ? "Stored" : "Not set"}
        </Badge>
        {set && (
          <Button size="icon" variant="ghost" className="ml-auto h-7 w-7" aria-label={`Remove the ${spec.label.toLowerCase()}`} disabled={busy}
            onClick={() => void run(() => client.removeWaBusinessSecret(channel, spec.kind), `${spec.label} removed`)}>
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
      <div className="flex items-center gap-1.5">
        <Input type="password" autoComplete="off" data-setup-field={spec.kind} className="h-8 text-xs font-mono" placeholder={set ? "Stored: paste a new one to replace it" : spec.placeholder}
          value={value} onChange={(e) => setValue(e.target.value)} />
        <Button size="sm" className="h-8 text-xs" disabled={busy || !value.trim()}
          onClick={() => void run(() => client.setWaBusinessSecrets(channel, { [spec.kind]: value.trim() }), `${spec.label} saved`).then(() => setValue(""))}>
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Save"}
        </Button>
        {spec.kind === "verifyToken" && (
          <Button size="sm" variant="outline" className="h-8 text-xs" disabled={busy}
            onClick={() => void run(async () => setGenerated((await client.generateWaBusinessVerifyToken(channel)).verifyToken), "Verify token generated")}>
            Generate
          </Button>
        )}
      </div>
      {generated && (
        <div className="space-y-1 rounded-md border border-info/25 bg-info/5 p-2">
          <p className="text-micro text-muted-foreground">Copy it now into Meta's webhook configuration: it is not shown again.</p>
          <CopyLine value={generated} label="verify token" testId="wabiz-verify-token" />
        </div>
      )}
      <p className="text-micro text-muted-foreground leading-tight">{spec.hint}</p>
    </div>
  );
}

function PendingRow({ channel, m, onDone }: { channel: string; m: WaBusinessMessage; onDone: () => void }) {
  const { client } = usePolpo();
  const [busy, setBusy] = useState(false);
  const act = async (approve: boolean) => {
    setBusy(true);
    try {
      if (approve) await client.approveWaBusinessSend(channel, m.id);
      else await client.rejectWaBusinessSend(channel, m.id);
      toast.success(approve ? "Sent" : "Rejected");
      onDone();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-border/40 bg-muted/15 px-2.5 py-1.5 text-caption" data-testid="wabiz-pending">
      <span className="font-mono">{m.pending?.template}</span>
      <span className="text-muted-foreground">({m.pending?.language}) → {m.waId} · by {m.pending?.requestedBy}</span>
      {m.pending?.params?.length ? <span className="text-muted-foreground truncate">[{m.pending.params.join(", ")}]</span> : null}
      {m.pending?.reason && <span className="w-full text-muted-foreground">{m.pending.reason}</span>}
      <span className="ml-auto flex gap-1">
        <Button size="sm" className="h-7 text-xs" disabled={busy} onClick={() => void act(true)}>Approve</Button>
        <Button size="sm" variant="outline" className="h-7 text-xs" disabled={busy} onClick={() => void act(false)}>Reject</Button>
      </span>
    </div>
  );
}

function EventsSheet({ channel, open, onOpenChange }: { channel: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { client } = usePolpo();
  const [page, setPage] = useState<WaBusinessEventPage | null>(null);
  const [detail, setDetail] = useState<WaBusinessEvent | null>(null);
  const [loading, setLoading] = useState(false);
  const load = async () => {
    setLoading(true);
    try { setPage(await client.getWaBusinessEvents(channel, { limit: 100 })); } catch (e) { toast.error((e as Error).message); } finally { setLoading(false); }
  };
  return (
    <Sheet open={open} onOpenChange={(o) => { onOpenChange(o); if (o) void load(); }}>
      <SheetContent className="w-full sm:max-w-xl overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2"><Inbox className="h-4 w-4" /> Webhook events · {channel}</SheetTitle>
          <SheetDescription>Every delivery from Meta, newest first. Message text is never kept: types, lengths and masked numbers only.</SheetDescription>
        </SheetHeader>
        <div className="space-y-2 px-4 pb-4">
          <div className="flex items-center gap-2 text-caption text-muted-foreground">
            {page && Object.entries(page.counts).map(([k, v]) => <span key={k}>{k} {v}</span>)}
            <Button size="icon" variant="ghost" className="ml-auto h-7 w-7" aria-label="Reload" onClick={() => void load()}>
              {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            </Button>
          </div>
          {page?.events.length === 0 && <p className="text-caption text-muted-foreground">No deliveries yet.</p>}
          {page?.events.map((e) => (
            <button key={e.id} type="button" className="w-full rounded-md border border-border/40 px-2.5 py-1.5 text-left hover:bg-muted/30" data-testid="wabiz-event"
              onClick={() => void client.getWaBusinessEvent(channel, e.id).then(setDetail).catch((err: Error) => toast.error(err.message))}>
              <div className="flex items-center gap-2">
                <OutcomeBadge outcome={e.outcome} />
                <span className="text-caption font-mono">{e.eventType ?? "—"}</span>
                <span className="ml-auto text-micro text-muted-foreground">{new Date(e.receivedAt).toLocaleString()} · {e.httpStatus}</span>
              </div>
              {(e.reason || e.action) && <p className="mt-0.5 text-caption text-muted-foreground">{e.reason ?? e.action}</p>}
              {detail?.id === e.id && detail.items?.length ? (
                <ul className="mt-1 space-y-0.5 text-micro font-mono text-muted-foreground">
                  {detail.items.map((it, i) => (
                    <li key={i}>{it.kind} {it.type ?? it.status ?? ""} {it.length !== undefined ? `${it.length} chars` : ""} {it.contact ?? ""} {it.error ?? ""}</li>
                  ))}
                </ul>
              ) : null}
            </button>
          ))}
        </div>
      </SheetContent>
    </Sheet>
  );
}

/** A saved channel: status, secrets, callback, events, approvals, test. */
export function WaBusinessLive({ channel }: { channel: string }) {
  const { client } = usePolpo();
  const { status, isLoading, error, refetch } = useWaBusinessStatus(channel);
  const [pending, setPending] = useState<WaBusinessMessage[] | null>(null);
  const [eventsOpen, setEventsOpen] = useState(false);
  const [testing, setTesting] = useState(false);
  const loadPending = useCallback(() => { void client.getWaBusinessPending(channel).then(setPending).catch(() => setPending([])); }, [client, channel]);
  const waiting = status?.pendingApprovals ?? 0;
  useEffect(() => { if (waiting > 0) loadPending(); }, [waiting, loadPending]);
  if (isLoading && !status) return <div className="flex items-center gap-2 text-caption text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading the channel…</div>;
  if (!status) return <p className="text-caption text-destructive">{error?.message ?? "Save the channel to set it up."}</p>;
  const state = STATE[status.state];
  const test = async () => {
    setTesting(true);
    try {
      const info = await client.testWaBusiness(channel);
      toast.success(`Connected: ${info.displayPhoneNumber ?? channel}${info.qualityRating ? ` · quality ${info.qualityRating}` : ""}`);
      void refetch();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setTesting(false);
    }
  };
  return (
    <div className="space-y-3" data-testid="wabiz-live" data-setup-item={channel}>
      <div className="flex flex-wrap items-center gap-2">
        <ShieldCheck className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-xs font-semibold">Meta connection</span>
        <Badge variant="outline" className={cn("font-normal", state.className)} data-testid="wabiz-state">{state.label}</Badge>
        {status.phone?.qualityRating && <Badge variant="outline" className="font-normal">quality {status.phone.qualityRating}</Badge>}
        {status.phone?.messagingLimitTier && <Badge variant="outline" className="font-normal">{status.phone.messagingLimitTier}</Badge>}
        <Button size="sm" variant="outline" className="ml-auto h-7 text-xs" disabled={testing || !status.secrets.accessToken} onClick={() => void test()}>
          {testing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Test"}
        </Button>
      </div>
      {status.missing.length > 0 && <p className="text-caption text-warning">Missing: {status.missing.join(", ")}</p>}

      <div className="space-y-3">
        {SECRETS.map((spec) => <SecretRow key={spec.kind} channel={channel} spec={spec} set={status.secrets[spec.kind]} onSaved={() => void refetch()} />)}
      </div>

      <div className="space-y-1.5">
        <span className="text-xs font-medium">Callback URL (Meta → WhatsApp → Configuration → Webhook)</span>
        {status.callbackUrl
          ? <CopyLine value={status.callbackUrl} label="callback URL" testId="wabiz-callback" />
          : <p className="text-caption text-warning">POLPO_PUBLIC_URL is not set: Meta needs a public HTTPS URL.</p>}
        <span className="text-xs font-medium">Expose it (Tailscale Funnel)</span>
        <CopyLine value={status.funnelCommand} label="Funnel command" testId="wabiz-funnel" />
        <p className="text-micro text-muted-foreground leading-tight">{status.note} Then subscribe the app to the messages field.</p>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-muted-foreground">
        <span>accepted {status.counts.accepted}</span>
        <span>ignored {status.counts.ignored}</span>
        <span>rejected {status.counts.rejected}</span>
        <span>errors {status.counts.error}</span>
        <span>today {status.sentToday}/{status.limits.businessInitiatedPerDay} templates</span>
        {status.lastEventAt && <span>last {new Date(status.lastEventAt).toLocaleString()}</span>}
        <Button size="sm" variant="ghost" className="ml-auto h-7 text-xs" onClick={() => setEventsOpen(true)}>Events</Button>
      </div>
      {status.lastError && <p className="text-caption text-destructive">Last problem: {status.lastError}</p>}

      {status.pendingApprovals > 0 && (
        <div className="space-y-1.5">
          <span className="text-xs font-medium">Waiting for approval ({status.pendingApprovals})</span>
          {(pending ?? []).map((m) => <PendingRow key={m.id} channel={channel} m={m} onDone={() => { loadPending(); void refetch(); }} />)}
        </div>
      )}
      <EventsSheet channel={channel} open={eventsOpen} onOpenChange={setEventsOpen} />
    </div>
  );
}

/**
 * A channel's contacts (newest first): the 24-hour window, opt-in and opt-out, with the operator's
 * actions — record an opt-in or an opt-out (an opted-out contact gets nothing, templates included)
 * and erase a contact with its messages (a GDPR request), after a confirmation.
 */
export function WaBusinessContacts({ channel }: { channel: string }) {
  const { contacts, isLoading, error, setOptIn, erase } = useWaContacts(channel);
  const [busy, setBusy] = useState<string | null>(null);
  const [erasing, setErasing] = useState<string | null>(null);
  const run = async (waId: string, fn: () => Promise<void>, done: string) => {
    setBusy(waId);
    try {
      await fn();
      toast.success(done);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  if (isLoading && contacts.length === 0) return <div className="flex items-center gap-2 text-caption text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading contacts…</div>;
  if (error && contacts.length === 0) return <p className="text-caption text-destructive">{error.message}</p>;
  return (
    <div className="space-y-1.5" data-testid="wabiz-contacts">
      {contacts.length === 0 && <p className="text-caption text-muted-foreground">No contacts yet: they appear when someone writes to the number.</p>}
      {contacts.map((c) => {
        const optedOut = !!c.optOut;
        return (
          <div key={c.waId} className="flex flex-wrap items-center gap-2 rounded-md border border-border/40 bg-muted/15 px-2.5 py-1.5 text-caption" data-testid={`wabiz-contact-${c.waId}`}>
            <span className="font-medium">{c.name ?? c.waId}</span>
            {c.name && <span className="font-mono text-muted-foreground">{c.waId}</span>}
            <Badge variant="outline" className={cn("font-normal", c.window?.open ? "border-success/30 bg-success/10 text-success" : "text-muted-foreground")}>
              {c.window?.open ? "Window open" : "Window closed"}
            </Badge>
            {optedOut && <Badge variant="outline" className="border-warning/30 bg-warning/10 font-normal text-warning">Opted out</Badge>}
            {c.optIn && <Badge variant="outline" className="border-info/30 bg-info/10 font-normal text-info">Opted in</Badge>}
            <span className="ml-auto flex gap-1">
              <Button size="sm" variant="outline" className="h-7 text-xs" disabled={busy === c.waId}
                onClick={() => void run(c.waId, () => setOptIn(c.waId, optedOut || !c.optIn), optedOut || !c.optIn ? "Opt-in recorded" : "Opt-out recorded")}>
                {optedOut || !c.optIn ? "Record opt-in" : "Record opt-out"}
              </Button>
              {!optedOut && !c.optIn && (
                <Button size="sm" variant="ghost" className="h-7 text-xs" disabled={busy === c.waId}
                  onClick={() => void run(c.waId, () => setOptIn(c.waId, false), "Opt-out recorded")}>
                  Opt out
                </Button>
              )}
              <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive hover:text-destructive" aria-label={`Erase ${c.waId}`} disabled={busy === c.waId}
                onClick={() => setErasing(c.waId)}>
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </span>
          </div>
        );
      })}
      <ConfirmDialog
        open={!!erasing}
        onOpenChange={(o) => { if (!o) setErasing(null); }}
        title={`Erase ${erasing ?? ""}?`}
        description="This deletes the contact and every message kept for them (a GDPR erasure request). It cannot be undone."
        confirmLabel="Erase"
        destructive
        loading={!!erasing && busy === erasing}
        onConfirm={() => {
          const waId = erasing!;
          void run(waId, () => erase(waId), "Contact erased").then(() => setErasing(null));
        }}
      />
    </div>
  );
}
