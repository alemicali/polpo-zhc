/**
 * Triggers: public endpoints (POST <public URL>/hooks/{id}) that receive form submissions and any
 * service's webhooks. The list (status, endpoint, auth, counts, last delivery), New trigger, and a
 * trigger's sheet (overview, auth, contract, rules, deliveries). A generated secret is shown once.
 * Deep links: ?trigger=<id>&focus=hmac (an assistant's setup link for the HMAC secret).
 * No actions run on deliveries yet: the action engine comes later.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { AlertTriangle, Check, Copy, Loader2, Plus, Search, ShieldCheck, Webhook } from "lucide-react";
import { toast } from "sonner";
import { useTriggers } from "@polpo-ai/react";
import type { Trigger, TriggerContentType, TriggerInput } from "@polpo-ai/react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { PageHeader } from "@/components/shared/page-header";
import { StatusBadge, TriggerSheet, type TriggerTab } from "@/components/triggers/trigger-sheet";
import { focusSetupField, readSetupParams } from "@/lib/setup-link";
import { CONTENT_TYPES, DELIVERY_STATUSES, STATUS_LABEL } from "@/lib/triggers";
import { cn } from "@/lib/utils";

const ago = (iso?: string) => {
  if (!iso) return "no deliveries yet";
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  return s < 60 ? "just now" : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`;
};

function authLabel(t: Trigger): string {
  return [t.auth.secret ? "secret" : "", t.auth.hmac ? `HMAC ${t.auth.hmac.algorithm}` : "", t.auth.ipAllowlist?.length ? "IP allowlist" : ""].filter(Boolean).join(" + ");
}

function TriggerRow({ t, onOpen }: { t: Trigger; onOpen: () => void }) {
  const hmacMissing = !!t.auth.hmac && !t.hmacSecret?.secretSet;
  return (
    <button type="button" onClick={onOpen} data-trigger={t.id}
      className={cn("flex w-full flex-col gap-3 rounded-lg border bg-card p-4 text-left shadow-card transition-colors hover:border-primary/20 sm:flex-row sm:items-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        !t.enabled && "opacity-60")}>
      <div className={cn("flex h-10 w-10 shrink-0 items-center justify-center rounded-xl", t.enabled ? "bg-info/10" : "bg-muted-foreground/10")}>
        <Webhook className={cn("h-4 w-4", t.enabled ? "text-info" : "text-muted-foreground")} />
      </div>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-sm font-medium">{t.name}</span>
          <Badge variant="outline" className={cn("text-micro font-normal", t.enabled ? "text-success" : "text-warning")}>{t.enabled ? "Enabled" : "Disabled"}</Badge>
          <Badge variant="outline" className="text-micro font-normal">v{t.contractVersion} · {t.contract.contentTypes.join("/")}</Badge>
          <Badge variant="outline" className="text-micro font-normal" data-testid="row-actions">
            {t.actions?.length ? `${t.actions.length} action${t.actions.length === 1 ? "" : "s"}` : "No actions"}
          </Badge>
        </div>
        <p className="truncate font-mono text-caption text-muted-foreground">{t.endpoint}</p>
        <p className="flex flex-wrap items-center gap-x-2 text-caption text-muted-foreground">
          <ShieldCheck className="h-3 w-3" /> {authLabel(t)}
          {hmacMissing && <span className="flex items-center gap-1 text-warning"><AlertTriangle className="h-3 w-3" /> HMAC secret not set</span>}
        </p>
      </div>
      <div className="flex shrink-0 flex-col items-start gap-1 sm:items-end">
        <div className="flex items-center gap-2 text-caption text-muted-foreground">
          {ago(t.stats.lastDeliveryAt)}
          {t.stats.lastStatus && <StatusBadge status={t.stats.lastStatus} />}
        </div>
        <p className="text-caption tabular-nums text-muted-foreground" data-testid="row-counts">
          {DELIVERY_STATUSES.filter((s) => t.stats.counts[s]).map((s) => `${t.stats.counts[s]} ${STATUS_LABEL[s].toLowerCase()}`).join(" · ") || "0 deliveries"}
        </p>
      </div>
    </button>
  );
}

function SecretDialog({ secret, onClose }: { secret: { value: string; what: string } | null; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <Dialog open={!!secret} onOpenChange={(o) => { if (!o) { setCopied(false); onClose(); } }}>
      <DialogContent className="sm:max-w-lg" data-testid="secret-dialog">
        <DialogHeader>
          <DialogTitle>{secret?.what ?? "The secret"} — shown only now</DialogTitle>
          <DialogDescription>Copy it into the sender now. Polpo keeps only a hash (or the vault keeps it): it cannot be shown again; rotate it if it is lost.</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="flex items-center gap-1.5">
            <code className="min-w-0 flex-1 break-all rounded-xs border bg-muted/40 px-2 py-1.5 font-mono text-caption" data-testid="secret-value">{secret?.value}</code>
            <Button size="icon" variant="ghost" className="h-8 w-8 shrink-0" aria-label="Copy the secret"
              onClick={() => { void navigator.clipboard?.writeText(secret?.value ?? "").then(() => setCopied(true)).catch(() => undefined); }}>
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            </Button>
          </div>
        </DialogBody>
        <DialogFooter><Button size="sm" onClick={onClose}>I copied it</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CreateDialog({ open, onOpenChange, onCreate }: { open: boolean; onOpenChange: (o: boolean) => void; onCreate: (input: TriggerInput & { name: string }) => Promise<void> }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [types, setTypes] = useState<TriggerContentType[]>(["json"]);
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg" data-testid="create-trigger">
        <DialogHeader>
          <DialogTitle>New trigger</DialogTitle>
          <DialogDescription>A public endpoint for a form or a service's webhook. It gets a secret (shown once); signatures, the contract, filter, dedupe and mapping are set on the trigger afterwards.</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-3">
          <label className="block space-y-1"><span className="text-xs font-medium">Name</span>
            <Input className="h-8" value={name} onChange={(e) => setName(e.target.value)} placeholder="Tally signup form" aria-label="Name" autoFocus /></label>
          <label className="block space-y-1"><span className="text-xs font-medium">Description</span>
            <Textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} aria-label="Description" /></label>
          <div className="space-y-1">
            <span className="text-xs font-medium">Accepted content</span>
            <div className="flex flex-wrap gap-3">
              {CONTENT_TYPES.map((c) => (
                <label key={c.id} className="flex items-center gap-1.5 text-xs" title={c.hint}>
                  <Checkbox checked={types.includes(c.id)} onCheckedChange={(v) => setTypes(v ? [...types, c.id] : types.filter((x) => x !== c.id))} aria-label={c.label} /> {c.label}
                </label>
              ))}
            </div>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button size="sm" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button size="sm" disabled={busy || !name.trim() || !types.length} onClick={() => {
            setBusy(true);
            void onCreate({ name: name.trim(), ...(description.trim() ? { description: description.trim() } : {}), contract: { contentTypes: types } })
              .then(() => { setName(""); setDescription(""); setTypes(["json"]); })
              .finally(() => setBusy(false));
          }}>{busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Create</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function TriggersPage() {
  const { triggers, isLoading, error, createTrigger, updateTrigger, deleteTrigger } = useTriggers();
  const [params, setParams] = useSearchParams();
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState<{ value: string; what: string } | null>(null);
  const setup = useMemo(() => readSetupParams(`?${params.toString()}`), [params]);
  const selectedId = params.get("trigger") ?? undefined;
  // ?delivery=<id>: a link from what a trigger started (a task, a mission, a chat) opens that delivery
  const deliveryLink = params.get("delivery") ?? undefined;
  const [tab, setTab] = useState<TriggerTab>(setup.focus === "hmac" ? "auth" : deliveryLink ? "deliveries" : "overview");
  const selected = triggers.find((t) => t.id === selectedId);

  // an assistant's setup link (?trigger=<id>&focus=hmac): the sheet opens on Auth; focus the HMAC secret field
  useEffect(() => {
    if (!selectedId || setup.focus !== "hmac") return;
    return focusSetupField(setup);
  }, [selectedId, setup]);

  const open = useCallback((id: string | undefined, nextTab: TriggerTab = "overview") => {
    const next = new URLSearchParams(params);
    if (id) next.set("trigger", id); else { next.delete("trigger"); next.delete("focus"); next.delete("setup"); next.delete("delivery"); }
    setParams(next, { replace: true });
    setTab(nextTab);
  }, [params, setParams]);

  const save = useCallback(async (id: string, input: TriggerInput, done?: string) => {
    try {
      const r = await updateTrigger(id, input);
      if (done) toast.success(done);
      return r;
    } catch (e) {
      toast.error((e as Error).message);
      return undefined;
    }
  }, [updateTrigger]);

  const visible = triggers.filter((t) => !query.trim() || `${t.name} ${t.id} ${t.description ?? ""}`.toLowerCase().includes(query.trim().toLowerCase()));

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto p-4 sm:p-6">
      <PageHeader title="Triggers" icon={Webhook}
        description="Public endpoints that receive form submissions and webhooks: checked (secret, signature, IP, contract), filtered, de-duplicated, recorded with their mapped values, and acted on: run a playbook, start a mission, create a task, an agent turn, a notification."
        actions={<Button size="sm" onClick={() => setCreating(true)}><Plus className="h-3.5 w-3.5" /> New trigger</Button>} />
      <div className="relative max-w-sm">
        <Search className="pointer-events-none absolute left-2.5 top-2 h-4 w-4 text-muted-foreground" />
        <Input className="h-8 pl-8" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search triggers" aria-label="Search triggers" />
      </div>
      {error && <p className="text-sm text-destructive">{error.message}</p>}
      {isLoading && !triggers.length ? (
        <div className="flex justify-center py-12"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
      ) : visible.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-16 text-center" data-testid="triggers-empty">
          <Webhook className="h-8 w-8 text-muted-foreground" />
          <p className="text-sm font-medium">{triggers.length ? "No trigger matches" : "No triggers yet"}</p>
          <p className="max-w-md text-xs text-muted-foreground">Create one, give its URL to a form (Tally, Typeform…) or a service, and every delivery shows up here with its payload and mapped values.</p>
        </div>
      ) : (
        <div className="space-y-2" data-testid="trigger-list">
          {visible.map((t) => <TriggerRow key={t.id} t={t} onOpen={() => open(t.id)} />)}
        </div>
      )}
      <CreateDialog open={creating} onOpenChange={setCreating} onCreate={async (input) => {
        try {
          const r = await createTrigger(input);
          setCreating(false);
          toast.success(`Created ${r.trigger.name}`);
          open(r.trigger.id);
          if (r.secret) setSecret({ value: r.secret, what: "The trigger's secret" });
        } catch (e) {
          toast.error((e as Error).message);
        }
      }} />
      <TriggerSheet trigger={selected} open={!!selected} onOpenChange={(o) => { if (!o) open(undefined); }} tab={tab} onTab={setTab} focus={setup.focus}
        save={save} onSecret={(value, what) => setSecret({ value, what })} initialDelivery={deliveryLink}
        onDelete={async (id) => {
          try { await deleteTrigger(id); toast.success("Trigger deleted"); open(undefined); } catch (e) { toast.error((e as Error).message); }
        }} />
      <SecretDialog secret={secret} onClose={() => setSecret(null)} />
    </div>
  );
}
