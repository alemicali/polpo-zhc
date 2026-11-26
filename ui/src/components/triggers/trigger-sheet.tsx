/**
 * A trigger's sheet: Overview (endpoint, curl, on/off, name), Auth (the generated secret with
 * rotation, the HMAC check and its secret, the IP allowlist), Contract (content types, sizes, the
 * JSON Schema with a JSON / YAML view, inference from a sample, validation, versions and diffs),
 * Rules (filter, dedupe, rate limit, retention, mapping with a preview), Actions (what runs on each
 * accepted delivery: trigger-actions.tsx) and Deliveries (by status, a delivery's payload / errors /
 * mapped values / action runs with links to what they created, re-run actions, replay as a dry run,
 * send a test delivery, optionally running the actions).
 */
import { useEffect, useMemo, useState } from "react";
import { Check, Copy, History, Loader2, Play, Plus, RefreshCw, RotateCcw, Send, Sparkles, Trash2, Wand2 } from "lucide-react";
import { toast } from "sonner";
import { usePolpo, useTriggerDeliveries, useTriggerDelivery } from "@polpo-ai/react";
import type { Trigger, TriggerContentType, TriggerContractRevision, TriggerDelivery, TriggerDeliveryStatus, TriggerDraft, TriggerDryRun, TriggerFilter, TriggerFilterOp, TriggerInput } from "@polpo-ai/react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { JsonBlock } from "@/components/json-block";
import { notifySetupSaved } from "@/lib/setup-link";
import {
  CONTENT_TYPES, DELIVERY_STATUSES, STATUS_CLASS, STATUS_LABEL, curlExample, formatBytes, mappingObject, mappingRows, parseJson, toYaml, type MappingRow,
} from "@/lib/triggers";
import { cn } from "@/lib/utils";
import { ActionStatusBadge, ActionsTab, DeliveryActions } from "./trigger-actions";

export type TriggerTab = "overview" | "auth" | "contract" | "rules" | "actions" | "deliveries";

const when = (iso?: string) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "—");

export function StatusBadge({ status }: { status: TriggerDeliveryStatus }) {
  return <Badge variant="outline" className={cn("font-normal", STATUS_CLASS[status])} data-status={status}>{STATUS_LABEL[status]}</Badge>;
}

export function CopyBox({ text, label, multiline = false }: { text: string; label: string; multiline?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex min-w-0 items-start gap-1.5">
      {multiline
        ? <pre className="min-w-0 flex-1 overflow-x-auto whitespace-pre rounded-xs border bg-muted/40 px-2 py-1.5 font-mono text-caption" data-testid={`copy-${label}`}>{text}</pre>
        : <code className="min-w-0 flex-1 truncate rounded-xs border bg-muted/40 px-2 py-1 text-caption" data-testid={`copy-${label}`}>{text}</code>}
      <Button size="icon" variant="ghost" className="h-7 w-7 shrink-0" aria-label={`Copy the ${label}`}
        onClick={() => { void navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => undefined); }}>
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      </Button>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium">{label}</span>
      {children}
      {hint && <span className="block text-caption text-muted-foreground">{hint}</span>}
    </label>
  );
}

function Section({ title, description, children, actions }: { title: string; description?: string; children: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <section className="space-y-3 border-b pb-5 last:border-b-0">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">{title}</h3>
          {description && <p className="text-caption text-muted-foreground">{description}</p>}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}

/** The result of a dry run (validate, preview, replay). */
export function DryRunResult({ r }: { r: TriggerDryRun }) {
  return (
    <div className="space-y-2 rounded-md border bg-muted/20 p-3 text-xs" data-testid="dry-run">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={r.status} />
        <span className="text-muted-foreground">contract v{r.contractVersion} · filter {r.filterMatched ? "matches" : "does not match"}{r.dedupeKey ? ` · dedupe key ${r.dedupeKey}` : ""}</span>
      </div>
      {r.reasons.map((x) => <p key={x} className="text-muted-foreground">{x}</p>)}
      {r.errors.length > 0 && <ul className="list-disc space-y-0.5 pl-4 text-destructive" data-testid="dry-run-errors">{r.errors.map((e) => <li key={e}>{e}</li>)}</ul>}
      {r.mapped && <div><p className="mb-1 font-medium">Mapped values (what the actions receive)</p><JsonBlock data={r.mapped} /></div>}
      {r.mappingErrors?.map((e) => <p key={e} className="text-warning">{e}</p>)}
    </div>
  );
}

// ── Overview ──

function OverviewTab({ t, save, onDelete }: { t: Trigger; save: (input: TriggerInput, done?: string) => Promise<unknown>; onDelete: () => void }) {
  const [name, setName] = useState(t.name);
  const [description, setDescription] = useState(t.description ?? "");
  const local = t.endpoint.startsWith("/");
  return (
    <div className="space-y-5">
      <Section title="Endpoint" description="Give this URL to the form or the service. Only POST is accepted.">
        <CopyBox text={t.endpoint} label="endpoint" />
        {local
          ? <p className="text-xs text-warning">POLPO_PUBLIC_URL is not set: senders need the instance's public address in front of this path.</p>
          : <p className="text-caption text-muted-foreground">Behind Tailscale Funnel the path <code>/&lt;instance&gt;/hooks/</code> must be published (see docs/triggers.md).</p>}
        <CopyBox text={curlExample(t)} label="curl" multiline />
      </Section>
      <Section title="Status" actions={<Switch checked={t.enabled} onCheckedChange={(v) => void save({ enabled: v }, v ? "Trigger enabled" : "Trigger disabled")} aria-label="Enabled" />}>
        <p className="text-xs text-muted-foreground">{t.enabled ? "Receiving deliveries." : "Disabled: the endpoint answers 404 and nothing is recorded."}</p>
        <div className="flex flex-wrap gap-1.5" data-testid="trigger-counts">
          {DELIVERY_STATUSES.map((s) => <Badge key={s} variant="outline" className={cn("font-normal", STATUS_CLASS[s])}>{t.stats.counts[s] ?? 0} {STATUS_LABEL[s].toLowerCase()}</Badge>)}
        </div>
        <p className="text-caption text-muted-foreground">Last delivery: {t.stats.lastDeliveryAt ? `${when(t.stats.lastDeliveryAt)} (${STATUS_LABEL[t.stats.lastStatus!]})` : "none yet"}. {t.actions?.length ? `${t.actions.filter((a) => a.enabled).length} of ${t.actions.length} action${t.actions.length === 1 ? "" : "s"} run on each accepted delivery.` : "No actions: deliveries are only recorded."}</p>
      </Section>
      <Section title="Details">
        <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} className="h-8" /></Field>
        <Field label="Description"><Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} /></Field>
        <p className="text-caption text-muted-foreground">Owner: {t.owner ?? "—"} · created {when(t.createdAt)}</p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={!name.trim()} onClick={() => void save({ name, description: description.trim() ? description : null }, "Saved")}>Save</Button>
          <Button size="sm" variant="ghost" className="text-destructive" onClick={onDelete}><Trash2 className="h-3.5 w-3.5" /> Delete</Button>
        </div>
      </Section>
    </div>
  );
}

// ── Auth ──

const OVERLAPS = [{ v: "0", label: "Revoke now" }, { v: "3600", label: "1 hour" }, { v: "86400", label: "1 day" }, { v: "604800", label: "7 days" }];

function AuthTab({ t, save, onSecret, focus }: { t: Trigger; save: (input: TriggerInput, done?: string) => Promise<unknown>; onSecret: (secret: string, what: string) => void; focus?: string }) {
  const { client } = usePolpo();
  const [overlap, setOverlap] = useState("86400");
  const [busy, setBusy] = useState(false);
  const [hmac, setHmac] = useState(() => ({
    scheme: t.auth.hmac?.scheme ?? "custom",
    header: t.auth.hmac?.header ?? "", algorithm: t.auth.hmac?.algorithm ?? "sha256", encoding: t.auth.hmac?.encoding ?? "hex", prefix: t.auth.hmac?.prefix ?? "",
    timestampHeader: t.auth.hmac?.timestampHeader ?? "", toleranceSeconds: String(t.auth.hmac?.toleranceSeconds ?? ""), signedPayload: t.auth.hmac?.signedPayload ?? "",
  }));
  const [hmacOn, setHmacOn] = useState(!!t.auth.hmac || focus === "hmac");
  const [hmacSecret, setHmacSecret] = useState("");
  const [ips, setIps] = useState((t.auth.ipAllowlist ?? []).join("\n"));
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try { await fn(); } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  };
  const saveHmac = () => run(async () => {
    await save({ auth: { hmac: !hmacOn ? null : hmac.scheme === "standard-webhooks" ? {
      scheme: "standard-webhooks", header: "webhook-signature", algorithm: "sha256", encoding: "base64",
      ...(hmac.toleranceSeconds ? { toleranceSeconds: Number(hmac.toleranceSeconds) } : {}),
    } : {
      header: hmac.header, algorithm: hmac.algorithm as "sha256", encoding: hmac.encoding as "hex", ...(hmac.prefix ? { prefix: hmac.prefix } : {}),
      ...(hmac.timestampHeader ? { timestampHeader: hmac.timestampHeader } : {}), ...(hmac.toleranceSeconds ? { toleranceSeconds: Number(hmac.toleranceSeconds) } : {}),
      ...(hmac.signedPayload ? { signedPayload: hmac.signedPayload } : {}),
    } } }, hmacOn ? "HMAC check saved" : "HMAC check removed");
    if (!hmacOn && t.hmacSecret?.secretSet) await client.removeTriggerHmacSecret(t.id);
  });
  return (
    <div className="space-y-5">
      <Section title="Generated secret" description="Senders put it in Authorization: Bearer <secret> or X-Polpo-Secret. Only a hash is stored: it is shown once."
        actions={<Switch checked={t.auth.secret} onCheckedChange={(v) => void run(async () => {
          const r = await save({ auth: { secret: v } }, v ? "Secret required" : "Secret no longer required") as { secret?: string } | undefined;
          if (r?.secret) onSecret(r.secret, "The new secret");
        })} aria-label="Require the generated secret" />}>
        {t.auth.secret && (
          <>
            <ul className="space-y-1 text-xs" data-testid="secret-hints">
              {t.secrets.map((s) => (
                <li key={s.id} className="flex flex-wrap items-center gap-2">
                  <code className="rounded-xs bg-muted/40 px-1.5">{s.hint}</code>
                  <span className="text-muted-foreground">created {when(s.createdAt)}</span>
                  {s.expiresAt && <Badge variant="outline" className="border-warning/30 bg-warning/10 font-normal text-warning">works until {when(s.expiresAt)}</Badge>}
                </li>
              ))}
            </ul>
            <div className="flex flex-wrap items-end gap-2">
              <Field label="The previous secret keeps working">
                <Select value={overlap} onValueChange={setOverlap}>
                  <SelectTrigger className="h-8 w-36" aria-label="Overlap"><SelectValue /></SelectTrigger>
                  <SelectContent>{OVERLAPS.map((o) => <SelectItem key={o.v} value={o.v}>{o.label}</SelectItem>)}</SelectContent>
                </Select>
              </Field>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(async () => {
                const r = await client.rotateTriggerSecret(t.id, Number(overlap));
                onSecret(r.secret, "The new secret");
              })}><RotateCcw className="h-3.5 w-3.5" /> Rotate</Button>
            </div>
            <label className="flex items-center gap-2 text-xs">
              <Switch checked={!!t.auth.allowQueryToken} onCheckedChange={(v) => void save({ auth: { allowQueryToken: v } })} aria-label="Accept ?token=" />
              Also accept <code>?token=&lt;secret&gt;</code> (only for senders that cannot set headers: URLs end up in logs)
            </label>
          </>
        )}
      </Section>
      <Section title="HMAC signature" description="The sender signs the raw body with a shared secret (GitHub, Typeform, Stripe-style). The secret goes to the vault and is never shown again."
        actions={<Switch checked={hmacOn} onCheckedChange={setHmacOn} aria-label="Check an HMAC signature" />}>
        {hmacOn && (
          <div className="space-y-3" data-setup-item={t.id}>
            <Field label="Format" hint="Standard Webhooks: webhook-id / webhook-timestamp / webhook-signature (v1,<base64>) with a whsec_ secret (Svix, SitoInChat…)">
              <Select value={hmac.scheme} onValueChange={(v) => setHmac({ ...hmac, scheme: v as "custom" })}>
                <SelectTrigger className="h-8" aria-label="Signature format"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="custom">Custom HMAC</SelectItem><SelectItem value="standard-webhooks">Standard Webhooks</SelectItem></SelectContent>
              </Select>
            </Field>
            {hmac.scheme === "standard-webhooks" ? (
              <Field label="Tolerance (seconds)"><Input className="h-8" inputMode="numeric" value={hmac.toleranceSeconds} placeholder="300" onChange={(e) => setHmac({ ...hmac, toleranceSeconds: e.target.value.replace(/\D/g, "") })} /></Field>
            ) : (<>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Signature header"><Input className="h-8" value={hmac.header} placeholder="x-hub-signature-256" onChange={(e) => setHmac({ ...hmac, header: e.target.value })} /></Field>
              <Field label="Prefix" hint="Stripped before comparing, e.g. sha256="><Input className="h-8" value={hmac.prefix} onChange={(e) => setHmac({ ...hmac, prefix: e.target.value })} /></Field>
              <Field label="Algorithm">
                <Select value={hmac.algorithm} onValueChange={(v) => setHmac({ ...hmac, algorithm: v as "sha256" })}>
                  <SelectTrigger className="h-8" aria-label="Algorithm"><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="sha256">SHA-256</SelectItem><SelectItem value="sha1">SHA-1</SelectItem></SelectContent>
                </Select>
              </Field>
              <Field label="Encoding">
                <Select value={hmac.encoding} onValueChange={(v) => setHmac({ ...hmac, encoding: v as "hex" })}>
                  <SelectTrigger className="h-8" aria-label="Encoding"><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="hex">hex</SelectItem><SelectItem value="base64">base64</SelectItem></SelectContent>
                </Select>
              </Field>
              <Field label="Timestamp header" hint="Optional: refuse replays outside the tolerance"><Input className="h-8" value={hmac.timestampHeader} onChange={(e) => setHmac({ ...hmac, timestampHeader: e.target.value })} /></Field>
              <Field label="Tolerance (seconds)"><Input className="h-8" inputMode="numeric" value={hmac.toleranceSeconds} placeholder="300" onChange={(e) => setHmac({ ...hmac, toleranceSeconds: e.target.value.replace(/\D/g, "") })} /></Field>
            </div>
            <Field label="Signed payload" hint="{body} (default) or a template like {timestamp}.{body}"><Input className="h-8 font-mono" value={hmac.signedPayload} placeholder="{body}" onChange={(e) => setHmac({ ...hmac, signedPayload: e.target.value })} /></Field>
            </>)}
            <Button size="sm" disabled={busy || (hmac.scheme !== "standard-webhooks" && !hmac.header.trim())} onClick={() => void saveHmac()}>Save signature settings</Button>
            {t.auth.hmac && (
              <form className="space-y-2 rounded-md border bg-muted/20 p-3" onSubmit={(e) => {
                e.preventDefault();
                void run(async () => {
                  await client.setTriggerHmacSecret(t.id, { secret: hmacSecret, overlapSeconds: Number(overlap) });
                  setHmacSecret("");
                  toast.success("Signing secret saved");
                  notifySetupSaved();
                });
              }}>
                <p className="text-xs">Signing secret: {t.hmacSecret?.secretSet
                  ? <span className="text-success">set{t.hmacSecret.previousUntil ? ` (the previous works until ${when(t.hmacSecret.previousUntil)})` : ""}</span>
                  : <span className="text-warning">not set — every delivery is refused until it is</span>}</p>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Input type="password" autoComplete="off" className="h-8" value={hmacSecret} onChange={(e) => setHmacSecret(e.target.value)} data-setup-field="hmac"
                    placeholder={t.hmacSecret?.secretSet ? "•••••• (saved; paste a new one to replace it)" : "The sender's signing secret"} aria-label="HMAC signing secret" />
                  <Button type="submit" size="sm" disabled={busy || hmacSecret.trim().length < 8}>Save</Button>
                  <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void run(async () => {
                    const r = await client.setTriggerHmacSecret(t.id, { generate: true, overlapSeconds: Number(overlap) });
                    if (r.secret) onSecret(r.secret, "The HMAC signing secret");
                  })}><Wand2 className="h-3.5 w-3.5" /> Generate</Button>
                </div>
              </form>
            )}
          </div>
        )}
        {!hmacOn && t.auth.hmac && <Button size="sm" variant="outline" disabled={busy} onClick={() => void saveHmac()}>Remove the HMAC check</Button>}
      </Section>
      <Section title="IP allowlist" description="Only these addresses or CIDR ranges (one per line, IPv4 or IPv6); empty: any. Behind a proxy the address it forwards is used.">
        <Textarea rows={3} className="font-mono text-xs" value={ips} onChange={(e) => setIps(e.target.value)} placeholder={"34.200.0.0/16\n2001:db8::/32"} aria-label="IP allowlist" />
        <Button size="sm" variant="outline" onClick={() => void save({ auth: { ipAllowlist: ips.split(/[\s,]+/).filter(Boolean) } }, "IP allowlist saved")}>Save allowlist</Button>
      </Section>
    </div>
  );
}

// ── Contract ──

function ContractTab({ t, save }: { t: Trigger; save: (input: TriggerInput, done?: string) => Promise<unknown> }) {
  const { client } = usePolpo();
  const [types, setTypes] = useState<TriggerContentType[]>(t.contract.contentTypes);
  const [maxKb, setMaxKb] = useState(String(Math.round(t.contract.maxBodyBytes / 1024)));
  const [maxFileKb, setMaxFileKb] = useState(t.contract.maxFileBytes ? String(Math.round(t.contract.maxFileBytes / 1024)) : "");
  const [schemaText, setSchemaText] = useState(t.contract.schema ? JSON.stringify(t.contract.schema, null, 2) : "");
  const [view, setView] = useState<"json" | "yaml">("json");
  const [sample, setSample] = useState("");
  const [result, setResult] = useState<TriggerDryRun | null>(null);
  const [note, setNote] = useState("");
  const [versions, setVersions] = useState<TriggerContractRevision[]>([]);
  const [diff, setDiff] = useState<{ title: string; text: string } | null>(null);
  useEffect(() => { void client.getTriggerContractVersions(t.id).then(setVersions).catch(() => setVersions([])); }, [client, t.id, t.contractVersion]);
  const parsedSchema = parseJson(schemaText);
  const parsedSample = parseJson(sample);
  const draftContract = (): TriggerDraft["contract"] => ({
    contentTypes: types, maxBodyBytes: Math.max(1, Number(maxKb) || 256) * 1024, ...(maxFileKb ? { maxFileBytes: Number(maxFileKb) * 1024 } : {}),
    schema: parsedSchema.ok && parsedSchema.value ? parsedSchema.value as Record<string, unknown> : null,
  });
  const act = async (fn: () => Promise<void>) => { try { await fn(); } catch (e) { toast.error((e as Error).message); } };
  return (
    <div className="space-y-5">
      <Section title="Accepted content">
        <div className="flex flex-wrap gap-3">
          {CONTENT_TYPES.map((c) => (
            <label key={c.id} className="flex items-center gap-1.5 text-xs" title={c.hint}>
              <Checkbox checked={types.includes(c.id)} onCheckedChange={(v) => setTypes(v ? [...types, c.id] : types.filter((x) => x !== c.id))} aria-label={c.label} /> {c.label}
            </label>
          ))}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Max body (KB)" hint="At most 10240"><Input className="h-8" inputMode="numeric" value={maxKb} onChange={(e) => setMaxKb(e.target.value.replace(/\D/g, ""))} /></Field>
          <Field label="Max file (KB, multipart)" hint="Default 5120"><Input className="h-8" inputMode="numeric" value={maxFileKb} onChange={(e) => setMaxFileKb(e.target.value.replace(/\D/g, ""))} /></Field>
        </div>
      </Section>
      <Section title="JSON Schema" description="The parsed body must satisfy it; a mismatch is answered 400 with the list of errors."
        actions={
          <div className="flex gap-1" role="group" aria-label="Schema view">
            <Button size="sm" variant={view === "json" ? "secondary" : "ghost"} onClick={() => setView("json")}>JSON</Button>
            <Button size="sm" variant={view === "yaml" ? "secondary" : "ghost"} disabled={!parsedSchema.ok} onClick={() => setView("yaml")}>YAML</Button>
          </div>
        }>
        {view === "json"
          ? <Textarea rows={10} className="font-mono text-xs" value={schemaText} onChange={(e) => setSchemaText(e.target.value)} placeholder='{ "type": "object", "required": ["email"] }' aria-label="JSON Schema" />
          : <pre className="max-h-72 overflow-auto rounded-md border bg-muted/20 p-3 font-mono text-xs" data-testid="schema-yaml">{parsedSchema.ok && parsedSchema.value ? toYaml(parsedSchema.value) : "# no schema"}</pre>}
        {!parsedSchema.ok && <p className="text-xs text-destructive">{parsedSchema.error}</p>}
        <Field label="Sample delivery body (JSON)" hint="Paste what the form or service sends: infer a schema from it, or validate it against the schema above.">
          <Textarea rows={4} className="font-mono text-xs" value={sample} onChange={(e) => setSample(e.target.value)} aria-label="Sample body" />
        </Field>
        {!parsedSample.ok && <p className="text-xs text-destructive">{parsedSample.error}</p>}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={!parsedSample.ok || parsedSample.value === undefined} onClick={() => void act(async () => {
            const { schema } = await client.inferTriggerSchema({ triggerId: t.id, sample: parsedSample.ok ? parsedSample.value : undefined });
            setSchemaText(JSON.stringify(schema, null, 2));
            setView("json");
          })}><Sparkles className="h-3.5 w-3.5" /> Infer schema</Button>
          <Button size="sm" variant="outline" disabled={!parsedSample.ok || parsedSample.value === undefined || !parsedSchema.ok} onClick={() => void act(async () => {
            setResult(await client.validateTriggerSample(t.id, { body: parsedSample.ok ? parsedSample.value : undefined }, { contract: draftContract() }));
          })}><Play className="h-3.5 w-3.5" /> Validate sample</Button>
        </div>
        {result && <DryRunResult r={result} />}
      </Section>
      <Section title="Save" description={`Saving a change makes contract version ${t.contractVersion + 1}.`}>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input className="h-8" value={note} onChange={(e) => setNote(e.target.value)} placeholder="What changed (optional)" aria-label="Version note" />
          <Button size="sm" disabled={!parsedSchema.ok || !types.length} onClick={() => void save({ contract: draftContract(), ...(note ? { contractNote: note } : {}) }, "Contract saved").then(() => setNote(""))}>Save contract</Button>
        </div>
      </Section>
      <Section title="Versions" description="Each saved contract change, newest first.">
        <ul className="space-y-1.5 text-xs" data-testid="contract-versions">
          {versions.map((v, i) => (
            <li key={v.version} className="flex flex-wrap items-center gap-2">
              <Badge variant="outline" className="font-normal">v{v.version}</Badge>
              <span className="text-muted-foreground">{when(v.createdAt)}{v.by ? ` · ${v.by}` : ""}{v.note ? ` — ${v.note}` : ""}</span>
              {versions[i + 1] && (
                <Button size="sm" variant="ghost" className="h-6 px-2" onClick={() => void act(async () => {
                  const prev = versions[i + 1]!;
                  const d = await client.diffTriggerContract(t.id, prev.version, v.version);
                  setDiff({ title: `v${prev.version} → v${v.version}`, text: d.diff });
                })}><History className="h-3 w-3" /> Diff</Button>
              )}
            </li>
          ))}
        </ul>
        {diff && (
          <div className="space-y-1">
            <p className="text-xs font-medium">{diff.title}</p>
            <pre className="max-h-72 overflow-auto rounded-md border bg-muted/20 p-3 font-mono text-xs" data-testid="contract-diff">
              {diff.text.split("\n").map((l, i) => <span key={i} className={cn("block", l.startsWith("+") && !l.startsWith("+++") ? "text-success" : l.startsWith("-") && !l.startsWith("---") ? "text-destructive" : "")}>{l}</span>)}
            </pre>
          </div>
        )}
      </Section>
    </div>
  );
}

// ── Rules: filter, dedupe, rate limit, mapping ──

const OPS: TriggerFilterOp[] = ["equals", "not_equals", "contains", "in", "gte", "lte", "exists", "not_exists"];
type CondRow = { path: string; op: TriggerFilterOp; value: string };
const valueText = (v: unknown) => (v === undefined ? "" : typeof v === "string" ? v : JSON.stringify(v));
const parseValue = (op: TriggerFilterOp, s: string): unknown => {
  if (op === "exists" || op === "not_exists" || !s.trim()) return undefined;
  if (op === "in") return s.trim().startsWith("[") ? (parseJson(s).ok ? (parseJson(s) as { value: unknown }).value : s.split(",").map((x) => x.trim())) : s.split(",").map((x) => x.trim());
  if (op === "gte" || op === "lte") return Number(s);
  return s;
};

function RulesTab({ t, save }: { t: Trigger; save: (input: TriggerInput, done?: string) => Promise<unknown> }) {
  const { client } = usePolpo();
  const [mode, setMode] = useState<"all" | "any">(t.filter?.mode ?? "all");
  const [conds, setConds] = useState<CondRow[]>((t.filter?.conditions ?? []).map((c) => ({ path: c.path, op: c.op, value: valueText(c.value) })));
  const [dedupeKey, setDedupeKey] = useState(t.dedupe?.key ?? "");
  const [ttl, setTtl] = useState(String(t.dedupe?.ttlSeconds ?? 86400));
  const [rate, setRate] = useState(String(t.rateLimitPerMinute));
  const [retention, setRetention] = useState(String(t.retention));
  const [rows, setRows] = useState<MappingRow[]>(() => mappingRows(t.mapping));
  const [sample, setSample] = useState("");
  const [preview, setPreview] = useState<TriggerDryRun | null>(null);
  const filter = (): TriggerFilter | null => {
    const kept = conds.filter((c) => c.path.trim());
    return kept.length ? { mode, conditions: kept.map((c) => ({ path: c.path.trim(), op: c.op, ...(parseValue(c.op, c.value) !== undefined ? { value: parseValue(c.op, c.value) } : {}) })) } : null;
  };
  const draft = (): TriggerDraft => ({ filter: filter(), mapping: mappingObject(rows), dedupe: dedupeKey.trim() ? { key: dedupeKey.trim(), ttlSeconds: Number(ttl) || 86400 } : null });
  const parsedSample = parseJson(sample);
  return (
    <div className="space-y-5">
      <Section title="Filter" description="Paths read body.*, headers.* or query.* (e.g. body.data.fields[0].value). Deliveries not matching are recorded as filtered."
        actions={
          <Select value={mode} onValueChange={(v) => setMode(v as "all" | "any")}>
            <SelectTrigger className="h-8 w-36" aria-label="Filter mode"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="all">All must hold</SelectItem><SelectItem value="any">Any holds</SelectItem></SelectContent>
          </Select>
        }>
        <div className="space-y-2" data-testid="filter-conditions">
          {conds.map((c, i) => (
            <div key={i} className="flex flex-col gap-1.5 sm:flex-row">
              <Input className="h-8 font-mono text-xs" value={c.path} placeholder="body.status" aria-label={`Condition ${i + 1} path`} onChange={(e) => setConds(conds.map((x, j) => (j === i ? { ...x, path: e.target.value } : x)))} />
              <Select value={c.op} onValueChange={(v) => setConds(conds.map((x, j) => (j === i ? { ...x, op: v as TriggerFilterOp } : x)))}>
                <SelectTrigger className="h-8 sm:w-32" aria-label={`Condition ${i + 1} operator`}><SelectValue /></SelectTrigger>
                <SelectContent>{OPS.map((o) => <SelectItem key={o} value={o}>{o.replace("_", " ")}</SelectItem>)}</SelectContent>
              </Select>
              {c.op !== "exists" && c.op !== "not_exists" && <Input className="h-8 text-xs" value={c.value} placeholder={c.op === "in" ? "a, b, c" : "value"} aria-label={`Condition ${i + 1} value`} onChange={(e) => setConds(conds.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />}
              <Button size="icon" variant="ghost" className="h-8 w-8 shrink-0" aria-label={`Remove condition ${i + 1}`} onClick={() => setConds(conds.filter((_, j) => j !== i))}><Trash2 className="h-3.5 w-3.5" /></Button>
            </div>
          ))}
          <Button size="sm" variant="outline" onClick={() => setConds([...conds, { path: "", op: "equals", value: "" }])}><Plus className="h-3.5 w-3.5" /> Add condition</Button>
        </div>
      </Section>
      <Section title="Dedupe" description="The same key within the window is recorded as duplicate and answered 200 with the original delivery's id. Empty: no dedupe.">
        <div className="grid gap-3 sm:grid-cols-[1fr_10rem]">
          <Field label="Key template"><Input className="h-8 font-mono text-xs" value={dedupeKey} placeholder="{{body.submission_id}}" onChange={(e) => setDedupeKey(e.target.value)} /></Field>
          <Field label="Window (seconds)"><Input className="h-8" inputMode="numeric" value={ttl} onChange={(e) => setTtl(e.target.value.replace(/\D/g, ""))} /></Field>
        </div>
      </Section>
      <Section title="Limits">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Requests per minute" hint="Beyond: 429"><Input className="h-8" inputMode="numeric" value={rate} onChange={(e) => setRate(e.target.value.replace(/\D/g, ""))} /></Field>
          <Field label="Deliveries kept" hint="The newest; older ones are pruned"><Input className="h-8" inputMode="numeric" value={retention} onChange={(e) => setRetention(e.target.value.replace(/\D/g, ""))} /></Field>
        </div>
      </Section>
      <Section title="Mapping" description="Named fields an action would receive, as templates over body, headers and query ({{body.email}}, {{query.ref ?? &quot;direct&quot;}}). Stored on every delivery; the actions read them as {{mapped.name}}.">
        <div className="space-y-2" data-testid="mapping-rows">
          {rows.map((r, i) => (
            <div key={i} className="flex flex-col gap-1.5 sm:flex-row">
              <Input className="h-8 text-xs sm:w-40" value={r.name} placeholder="email" aria-label={`Field ${i + 1} name`} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
              <Input className="h-8 font-mono text-xs" value={r.template} placeholder="{{body.email}}" aria-label={`Field ${i + 1} template`} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, template: e.target.value } : x)))} />
              <Button size="icon" variant="ghost" className="h-8 w-8 shrink-0" aria-label={`Remove field ${i + 1}`} onClick={() => setRows(rows.filter((_, j) => j !== i))}><Trash2 className="h-3.5 w-3.5" /></Button>
            </div>
          ))}
          <Button size="sm" variant="outline" onClick={() => setRows([...rows, { name: "", template: "" }])}><Plus className="h-3.5 w-3.5" /> Add field</Button>
        </div>
        <Field label="Preview with a sample body (JSON)">
          <Textarea rows={3} className="font-mono text-xs" value={sample} onChange={(e) => setSample(e.target.value)} aria-label="Preview sample" />
        </Field>
        <Button size="sm" variant="outline" disabled={!parsedSample.ok || parsedSample.value === undefined} onClick={() => void client.validateTriggerSample(t.id, { body: parsedSample.ok ? parsedSample.value : undefined }, draft()).then(setPreview, (e: Error) => toast.error(e.message))}>
          <Play className="h-3.5 w-3.5" /> Preview
        </Button>
        {preview && <DryRunResult r={preview} />}
      </Section>
      <Button size="sm" onClick={() => void save({ ...draft(), rateLimitPerMinute: Number(rate) || 60, retention: Number(retention) || 500 }, "Rules saved")}>Save rules</Button>
    </div>
  );
}

// ── Deliveries ──

function DeliveryDialog({ t, id, onClose }: { t: Trigger; id: string | null; onClose: () => void }) {
  const { client } = usePolpo();
  // live: the actions' progress refreshes it
  const { delivery, error, rerunActions } = useTriggerDelivery(t.id, id ?? undefined);
  const d: TriggerDelivery | null = delivery ?? null;
  const [replay, setReplay] = useState<TriggerDryRun | null>(null);
  useEffect(() => { if (error) toast.error(error.message); }, [error]);
  return (
    <Dialog open={!!id} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="flex max-h-[85vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl" data-testid="delivery-dialog">
        <DialogHeader className="border-b px-5 py-4">
          <DialogTitle className="flex flex-wrap items-center gap-2">{d ? <StatusBadge status={d.status} /> : null} Delivery {id}</DialogTitle>
          <DialogDescription>{d ? `${when(d.receivedAt)} · HTTP ${d.httpStatus} · ${formatBytes(d.bytes)}${d.kind ? ` · ${d.kind}` : ""}${d.test ? " · test" : ""}${d.ip ? ` · from ${d.ip}` : ""} · contract v${d.contractVersion}` : "Loading…"}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4 overflow-y-auto px-5 py-4 text-xs">
          {d && (
            <>
              {d.reasons.map((r) => <p key={r} className="text-muted-foreground">{r}</p>)}
              {d.errors?.length ? <ul className="list-disc space-y-0.5 pl-4 text-destructive">{d.errors.map((e) => <li key={e}>{e}</li>)}</ul> : null}
              {d.duplicateOf && <p>Duplicate of <code>{d.duplicateOf}</code>.</p>}
              {d.mapped && <div><p className="mb-1 font-medium">Mapped values</p><JsonBlock data={d.mapped} /></div>}
              <DeliveryActions d={d} onRerun={rerunActions} />
              <div><p className="mb-1 font-medium">Body{d.bodyTruncated ? " (truncated)" : ""}</p>{d.body !== undefined ? <JsonBlock data={d.body} /> : <p className="text-muted-foreground">Not kept: the request was refused before it was authenticated or read.</p>}</div>
              {d.files?.length ? <div><p className="mb-1 font-medium">Files (metadata only)</p><ul className="space-y-0.5">{d.files.map((f) => <li key={f.sha256 + f.field}><code>{f.field}</code> {f.filename} · {f.contentType} · {formatBytes(f.size)}</li>)}</ul></div> : null}
              <div><p className="mb-1 font-medium">Headers (secrets redacted)</p><JsonBlock data={d.headers} /></div>
              {Object.keys(d.query).length > 0 && <div><p className="mb-1 font-medium">Query</p><JsonBlock data={d.query} /></div>}
              <div className="space-y-2">
                <Button size="sm" variant="outline" disabled={d.body === undefined || d.bodyTruncated} onClick={() => void client.replayTriggerDelivery(t.id, d.id).then(setReplay, (e: Error) => toast.error(e.message))}>
                  <RefreshCw className="h-3.5 w-3.5" /> Replay through the current contract (dry run)
                </Button>
                {replay && <DryRunResult r={replay} />}
              </div>
            </>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

function DeliveriesTab({ t, initialDelivery }: { t: Trigger; initialDelivery?: string }) {
  const { client } = usePolpo();
  const [status, setStatus] = useState<TriggerDeliveryStatus[]>([]);
  const { page, isLoading } = useTriggerDeliveries(t.id, { status, limit: 100 });
  const [open, setOpen] = useState<string | null>(initialDelivery ?? null);
  const [runActions, setRunActions] = useState(false);
  const [body, setBody] = useState('{\n  "hello": "world"\n}');
  const [kind, setKind] = useState<TriggerContentType>(t.contract.contentTypes[0] ?? "json");
  const [sending, setSending] = useState(false);
  const parsed = kind === "text" ? { ok: true as const, value: body } : parseJson(body);
  return (
    <div className="space-y-5">
      <Section title="Send a test delivery" description="Goes through the contract, filter, dedupe and mapping and is recorded as a test (no secret, IP or rate check). Its actions run only when you tick “Run the actions too”.">
        <Textarea rows={4} className="font-mono text-xs" value={body} onChange={(e) => setBody(e.target.value)} aria-label="Test body" />
        {!parsed.ok && <p className="text-xs text-destructive">{parsed.error}</p>}
        <div className="flex flex-wrap items-center gap-2">
          <Select value={kind} onValueChange={(v) => setKind(v as TriggerContentType)}>
            <SelectTrigger className="h-8 w-32" aria-label="Test content type"><SelectValue /></SelectTrigger>
            <SelectContent>{CONTENT_TYPES.map((c) => <SelectItem key={c.id} value={c.id}>{c.label}</SelectItem>)}</SelectContent>
          </Select>
          <Button size="sm" disabled={!parsed.ok || sending} onClick={() => {
            setSending(true);
            void client.sendTriggerTest(t.id, { body: parsed.ok ? parsed.value : undefined, contentType: kind, ...(runActions ? { runActions: true } : {}) })
              .then((d) => { toast.success(`Test delivery: ${STATUS_LABEL[d.status].toLowerCase()}`); setOpen(d.id); }, (e: Error) => toast.error(e.message))
              .finally(() => setSending(false));
          }}>{sending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />} Send test</Button>
          {t.actions?.length ? (
            <label className="flex items-center gap-2 text-xs"><Checkbox checked={runActions} onCheckedChange={(v) => setRunActions(v === true)} aria-label="Run the actions" /> Run the actions too</label>
          ) : null}
        </div>
      </Section>
      <Section title="Deliveries" description={`The newest ${t.retention} are kept.`}>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter by status">
          <Button size="sm" variant={status.length ? "ghost" : "secondary"} className="h-7" onClick={() => setStatus([])}>All {page?.total ?? 0}</Button>
          {DELIVERY_STATUSES.map((s) => (
            <Button key={s} size="sm" variant={status.includes(s) ? "secondary" : "ghost"} className="h-7" data-filter={s}
              onClick={() => setStatus(status.includes(s) ? status.filter((x) => x !== s) : [...status, s])}>
              {STATUS_LABEL[s]} {page?.counts[s] ?? 0}
            </Button>
          ))}
        </div>
        {isLoading && !page ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /> : (
          <ul className="divide-y rounded-md border" data-testid="delivery-list">
            {(page?.deliveries ?? []).length === 0 && <li className="px-3 py-6 text-center text-xs text-muted-foreground">No deliveries{status.length ? " with this status" : " yet"}.</li>}
            {(page?.deliveries ?? []).map((d) => (
              <li key={d.id}>
                <button type="button" onClick={() => setOpen(d.id)} data-delivery={d.id}
                  className="flex w-full flex-wrap items-center gap-2 px-3 py-2 text-left text-xs hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  <StatusBadge status={d.status} />
                  {d.test && <Badge variant="outline" className="border-info/30 bg-info/10 font-normal text-info">test</Badge>}
                  {d.actionsStatus && <ActionStatusBadge status={d.actionsStatus} />}
                  <span className="tabular-nums text-muted-foreground">{when(d.receivedAt)} · HTTP {d.httpStatus}{d.count && d.count > 1 ? ` · ×${d.count}` : ""}</span>
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">{d.reasons.join("; ")}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Section>
      <DeliveryDialog key={open ?? "closed"} t={t} id={open} onClose={() => setOpen(null)} />
    </div>
  );
}

// ── The sheet ──

export function TriggerSheet({ trigger, open, onOpenChange, tab, onTab, focus, save, onSecret, onDelete, initialDelivery }: {
  trigger: Trigger | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tab: TriggerTab;
  onTab: (tab: TriggerTab) => void;
  focus?: string;
  save: (id: string, input: TriggerInput, done?: string) => Promise<{ secret?: string } | undefined>;
  onSecret: (secret: string, what: string) => void;
  onDelete: (id: string) => Promise<void>;
  /** A delivery to open (a deep link from a task, a mission or a chat the trigger started). */
  initialDelivery?: string;
}) {
  const [confirm, setConfirm] = useState(false);
  const t = trigger;
  const bound = useMemo(() => (t ? (input: TriggerInput, done?: string) => save(t.id, input, done) : async () => undefined), [t, save]);
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-2xl" data-testid="trigger-sheet">
        {t && (
          <>
            <SheetHeader className="shrink-0 border-b pr-12">
              <SheetTitle className="flex flex-wrap items-center gap-2">{t.name}{!t.enabled && <Badge variant="outline" className="font-normal">Disabled</Badge>}</SheetTitle>
              <SheetDescription className="truncate font-mono text-caption">{t.id}</SheetDescription>
            </SheetHeader>
            <Tabs value={tab} onValueChange={(v) => onTab(v as TriggerTab)} className="flex min-h-0 flex-1 flex-col">
              <TabsList className="mx-4 mt-3 w-auto shrink-0 justify-start overflow-x-auto">
                <TabsTrigger value="overview">Overview</TabsTrigger>
                <TabsTrigger value="auth">Auth</TabsTrigger>
                <TabsTrigger value="contract">Contract</TabsTrigger>
                <TabsTrigger value="rules">Rules</TabsTrigger>
                <TabsTrigger value="actions">Actions{t.actions?.length ? ` ${t.actions.length}` : ""}</TabsTrigger>
                <TabsTrigger value="deliveries">Deliveries</TabsTrigger>
              </TabsList>
              <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
                <TabsContent value="overview"><OverviewTab key={`${t.id}-${t.updatedAt}`} t={t} save={bound} onDelete={() => setConfirm(true)} /></TabsContent>
                <TabsContent value="auth"><AuthTab key={`${t.id}-${t.updatedAt}`} t={t} save={bound} onSecret={onSecret} focus={focus} /></TabsContent>
                <TabsContent value="contract"><ContractTab key={`${t.id}-${t.contractVersion}`} t={t} save={bound} /></TabsContent>
                <TabsContent value="rules"><RulesTab key={`${t.id}-${t.updatedAt}`} t={t} save={bound} /></TabsContent>
                <TabsContent value="actions"><ActionsTab key={`${t.id}-${t.updatedAt}`} t={t} save={bound} /></TabsContent>
                <TabsContent value="deliveries"><DeliveriesTab t={t} initialDelivery={initialDelivery} /></TabsContent>
              </div>
            </Tabs>
            <ConfirmDialog open={confirm} onOpenChange={setConfirm} destructive title={`Delete ${t.name}?`}
              description="The endpoint stops answering (404); its deliveries, contract history and HMAC secret are removed."
              confirmLabel="Delete" onConfirm={() => { setConfirm(false); void onDelete(t.id); }} />
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
