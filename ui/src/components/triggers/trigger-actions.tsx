/**
 * A trigger's actions in the dashboard: the Actions tab of its sheet (add, reorder, enable, edit
 * each action with the playbook / mission / agent / channel pickers, templates with a live preview
 * against the newest accepted delivery, the limits and today's usage) and the runs of a delivery's
 * actions (status, attempts, error, links to what each created, Re-run actions).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowDown, ArrowUp, Loader2, Plus, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useAgents, useMissions, usePlaybooks, usePolpo } from "@polpo-ai/react";
import type { Trigger, TriggerActionKind, TriggerActionPreview, TriggerActionRun, TriggerActionsStatus, TriggerDelivery, TriggerInput } from "@polpo-ai/react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  ACTION_KINDS, ACTION_KIND_LABEL, ACTION_STATUS_CLASS, ACTION_STATUS_LABEL, actionDraft, actionInput, actionRefLinks, emptyAction, type ActionDraft,
} from "@/lib/triggers";
import { cn } from "@/lib/utils";

const selectClass = "h-8 w-full rounded-md border bg-transparent px-2 text-xs";
const when = (iso?: string) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "");

export function ActionStatusBadge({ status }: { status: TriggerActionsStatus }) {
  return <Badge variant="outline" className={cn("font-normal", ACTION_STATUS_CLASS[status])} data-action-status={status}>{ACTION_STATUS_LABEL[status]}</Badge>;
}

function Field({ label, hint, children, className }: { label: string; hint?: string; children: React.ReactNode; className?: string }) {
  return (
    <label className={cn("block min-w-0 space-y-1", className)}>
      <span className="text-xs font-medium">{label}</span>
      {children}
      {hint && <span className="block text-caption text-muted-foreground">{hint}</span>}
    </label>
  );
}

/** Name → template rows (playbook parameters, mission variables). */
function TemplateRows({ rows, onChange, label, placeholder }: { rows: ActionDraft["params"]; onChange: (rows: ActionDraft["params"]) => void; label: string; placeholder: string }) {
  return (
    <div className="space-y-1.5">
      <span className="text-xs font-medium">{label}</span>
      {rows.map((r, i) => (
        <div key={i} className="flex flex-col gap-1.5 sm:flex-row">
          <Input className="h-8 text-xs sm:w-36" value={r.name} placeholder="name" aria-label={`${label} ${i + 1} name`} onChange={(e) => onChange(rows.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
          <Input className="h-8 font-mono text-xs" value={r.template} placeholder={placeholder} aria-label={`${label} ${i + 1} template`} onChange={(e) => onChange(rows.map((x, j) => (j === i ? { ...x, template: e.target.value } : x)))} />
          <Button size="icon" variant="ghost" className="h-8 w-8 shrink-0" aria-label={`Remove ${label.toLowerCase()} ${i + 1}`} onClick={() => onChange(rows.filter((_, j) => j !== i))}><Trash2 className="h-3.5 w-3.5" /></Button>
        </div>
      ))}
      <Button size="sm" variant="outline" className="h-7" onClick={() => onChange([...rows, { name: "", template: "" }])}><Plus className="h-3 w-3" /> Add</Button>
    </div>
  );
}

interface Pickers {
  playbooks: Array<{ name: string; parameters?: Array<{ name: string }> }>;
  missions: Array<{ id: string; name: string; status: string }>;
  agents: Array<{ name: string }>;
  channels: Array<{ id: string; type?: string }>;
  mapping: Record<string, string>;
}

/** One action's fields. */
function ActionFields({ d, set, p, earlier }: { d: ActionDraft; set: (patch: Partial<ActionDraft>) => void; p: Pickers; earlier: string[] }) {
  const stepsHint = earlier.length ? ` Earlier actions: ${earlier.map((id) => `{{steps.${id}.…}}`).join(", ")}.` : "";
  const wait = (
    <Field label="Wait for it to end (seconds)" hint={`0: do not wait. Waiting gives later actions its result ({{steps.<id>.result}}).${stepsHint}`}>
      <Input className="h-8" inputMode="numeric" value={d.waitSeconds} placeholder="0" onChange={(e) => set({ waitSeconds: e.target.value.replace(/\D/g, "") })} aria-label="Wait seconds" />
    </Field>
  );
  switch (d.kind) {
    case "playbook":
      return (
        <div className="grid gap-3">
          <Field label="Playbook">
            <select className={selectClass} value={d.playbook} aria-label="Playbook" onChange={(e) => {
              const name = e.target.value;
              const pb = p.playbooks.find((x) => x.name === name);
              // its parameters, prefilled from mapped fields of the same name
              const params = d.params.length ? d.params : (pb?.parameters ?? []).map((x) => ({ name: x.name, template: p.mapping[x.name] ? `{{mapped.${x.name}}}` : "" }));
              set({ playbook: name, params });
            }}>
              <option value="">Choose a playbook…</option>
              {p.playbooks.map((x) => <option key={x.name} value={x.name}>{x.name}</option>)}
              {d.playbook && !p.playbooks.some((x) => x.name === d.playbook) && <option value={d.playbook}>{d.playbook} (not found)</option>}
            </select>
          </Field>
          <TemplateRows rows={d.params} onChange={(params) => set({ params })} label="Parameters" placeholder="{{mapped.email}}" />
          {wait}
        </div>
      );
    case "mission":
      return (
        <div className="grid gap-3">
          <Field label="Mission" hint="It runs as it is when it can start (draft, scheduled, failed…); with variables, or once completed, a copy runs.">
            <select className={selectClass} value={d.mission} aria-label="Mission" onChange={(e) => set({ mission: e.target.value })}>
              <option value="">Choose a mission…</option>
              {p.missions.map((m) => <option key={m.id} value={m.id}>{m.name} · {m.status}</option>)}
              {d.mission && !p.missions.some((m) => m.id === d.mission || m.name === d.mission) && <option value={d.mission}>{d.mission}</option>}
            </select>
          </Field>
          <TemplateRows rows={d.params} onChange={(params) => set({ params })} label="Variables" placeholder="{{mapped.email}}" />
          {wait}
        </div>
      );
    case "task":
      return (
        <div className="grid gap-3">
          <Field label="Agent">
            <select className={selectClass} value={d.assignTo} aria-label="Assign to" onChange={(e) => set({ assignTo: e.target.value })}>
              <option value="">Choose an agent…</option>
              {p.agents.map((a) => <option key={a.name} value={a.name}>{a.name}</option>)}
            </select>
          </Field>
          <Field label="Title"><Input className="h-8 font-mono text-xs" value={d.title} placeholder="Call {{mapped.name}}" onChange={(e) => set({ title: e.target.value })} aria-label="Task title" /></Field>
          <Field label="Description"><Textarea rows={3} className="font-mono text-xs" value={d.description} placeholder="{{mapped.email}} signed up: …" onChange={(e) => set({ description: e.target.value })} aria-label="Task description" /></Field>
          {wait}
        </div>
      );
    case "agent":
      return (
        <div className="grid gap-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Who">
              <select className={selectClass} value={d.agent} aria-label="Agent" onChange={(e) => set({ agent: e.target.value })}>
                <option value="">Polpo</option>
                {p.agents.map((a) => <option key={a.name} value={a.name}>{a.name}</option>)}
              </select>
            </Field>
            <Field label="Data it receives">
              <select className={selectClass} value={d.data} aria-label="Data" onChange={(e) => set({ data: e.target.value as ActionDraft["data"] })}>
                <option value="">Automatic (mapped values, else the body)</option>
                <option value="mapped">Mapped values</option>
                <option value="body">The body</option>
                <option value="both">Both</option>
              </select>
            </Field>
          </div>
          <Field label="Instructions" hint="Only {{trigger.name}} and {{delivery.id}} here: the delivery reaches the agent as data after the instructions, clearly marked, never as instructions. Refer to its fields by name.">
            <Textarea rows={4} value={d.instructions} placeholder="Uppercase every field of the form and reply with one field per line." onChange={(e) => set({ instructions: e.target.value })} aria-label="Instructions" />
          </Field>
          <div className="space-y-1.5">
            <label className="flex items-center gap-2 text-xs"><Switch checked={d.restrictTools} onCheckedChange={(v) => set({ restrictTools: v })} aria-label="Restrict tools" /> Only some tools in this turn</label>
            {d.restrictTools && <Input className="h-8 font-mono text-xs" value={d.allowedTools} placeholder="read_file, mcp__linear__* (empty: no tools)" onChange={(e) => set({ allowedTools: e.target.value })} aria-label="Allowed tools" />}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Steps at most" hint="Tool-loop steps for the turn (default 10)">
              <Input className="h-8" inputMode="numeric" value={d.maxSteps} placeholder="10" onChange={(e) => set({ maxSteps: e.target.value.replace(/\D/g, "") })} aria-label="Max steps" />
            </Field>
            <Field label="Send the reply to" hint="A Telegram chat, through the instance's bots">
              <div className="flex gap-1.5">
                <select className={selectClass} value={d.deliverChannel} aria-label="Reply channel" onChange={(e) => set({ deliverChannel: e.target.value })}>
                  <option value="">Nowhere</option>
                  {p.channels.filter((c) => !c.type || c.type === "telegram").map((c) => <option key={c.id} value={c.id}>{c.id}</option>)}
                </select>
                {d.deliverChannel && <Input className="h-8 text-xs" value={d.deliverChatId} placeholder="chat id" onChange={(e) => set({ deliverChatId: e.target.value })} aria-label="Reply chat id" />}
              </div>
            </Field>
          </div>
        </div>
      );
    case "notify":
      return (
        <div className="grid gap-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Channel">
              <select className={selectClass} value={d.channel} aria-label="Channel" onChange={(e) => set({ channel: e.target.value })}>
                <option value="">Choose a channel…</option>
                {p.channels.map((c) => <option key={c.id} value={c.id}>{c.id}{c.type ? ` (${c.type})` : ""}</option>)}
                {d.channel && !p.channels.some((c) => c.id === d.channel) && <option value={d.channel}>{d.channel} (not configured)</option>}
              </select>
            </Field>
            <Field label="Severity">
              <select className={selectClass} value={d.severity} aria-label="Severity" onChange={(e) => set({ severity: e.target.value as ActionDraft["severity"] })}>
                <option value="">Info</option><option value="warning">Warning</option><option value="critical">Critical</option>
              </select>
            </Field>
          </div>
          <Field label="Title" hint="Default: the trigger's name"><Input className="h-8 font-mono text-xs" value={d.title} placeholder="New signup" onChange={(e) => set({ title: e.target.value })} aria-label="Notification title" /></Field>
          <Field label="Message" hint={`Templates: {{mapped.email}}, {{body.…}}.${stepsHint}`}>
            <Textarea rows={3} className="font-mono text-xs" value={d.body} placeholder="{{mapped.name}} ({{mapped.email}}) just signed up" onChange={(e) => set({ body: e.target.value })} aria-label="Notification message" />
          </Field>
        </div>
      );
  }
}

/** The rendered actions (preview). */
function PreviewList({ preview }: { preview: TriggerActionPreview }) {
  return (
    <div className="space-y-2" data-testid="actions-preview">
      <p className="text-caption text-muted-foreground">{preview.note ?? `Rendered against delivery ${preview.deliveryId} (nothing runs; earlier actions' outputs are empty here).`}</p>
      {preview.actions.map((a) => (
        <div key={a.actionId} className="space-y-1 border-l-2 pl-3" data-preview={a.actionId}>
          <p className="text-xs font-medium">{ACTION_KIND_LABEL[a.kind]} <code className="text-caption text-muted-foreground">{a.actionId}</code></p>
          {a.error ? <p className="text-xs text-destructive">{a.error}</p> : (
            <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded-xs bg-muted/40 px-2 py-1.5 font-mono text-caption">
              {typeof a.rendered.message === "string" ? a.rendered.message : JSON.stringify(a.rendered, null, 2)}
            </pre>
          )}
        </div>
      ))}
    </div>
  );
}

export function ActionsTab({ t, save }: { t: Trigger; save: (input: TriggerInput, done?: string) => Promise<unknown> }) {
  const { client } = usePolpo();
  const { playbooks } = usePlaybooks();
  const { missions } = useMissions();
  const { agents } = useAgents();
  const [channels, setChannels] = useState<Array<{ id: string; type?: string }>>([]);
  const [drafts, setDrafts] = useState<ActionDraft[]>(() => (t.actions ?? []).map(actionDraft));
  const [adding, setAdding] = useState<TriggerActionKind>("playbook");
  const [limits, setLimits] = useState(() => ({
    concurrency: t.actionLimits?.concurrency ? String(t.actionLimits.concurrency) : "", perMinute: t.actionLimits?.perMinute ? String(t.actionLimits.perMinute) : "",
    perDay: t.actionLimits?.perDay ? String(t.actionLimits.perDay) : "", agentDailyCostUsd: t.actionLimits?.agentDailyCostUsd !== undefined ? String(t.actionLimits.agentDailyCostUsd) : "",
  }));
  const [usage, setUsage] = useState<{ actions: number; agentUsd: number } | null>(null);
  const [preview, setPreview] = useState<TriggerActionPreview | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [previewing, setPreviewing] = useState(false);

  useEffect(() => {
    void client.getConfig().then((c) => {
      const chs = ((c as { settings?: { notifications?: { channels?: Record<string, { type?: string }> } } }).settings?.notifications?.channels) ?? {};
      setChannels(Object.entries(chs).map(([id, ch]) => ({ id, ...(ch?.type ? { type: ch.type } : {}) })));
    }, () => setChannels([]));
    void client.getTriggerActionUsage(t.id).then(setUsage, () => setUsage(null));
  }, [client, t.id]);

  const inputs = useMemo(() => drafts.map(actionInput), [drafts]);
  const key = JSON.stringify(inputs);
  // live preview: re-render the draft against the newest accepted delivery as it changes
  const seq = useRef(0);
  useEffect(() => {
    if (!inputs.length) { setPreview(null); setProblems([]); return; }
    const n = ++seq.current;
    const timer = setTimeout(() => {
      setPreviewing(true);
      void client.previewTriggerActions(t.id, { actions: inputs }).then(
        (p) => { if (n === seq.current) { setPreview(p); setProblems([]); } },
        (e: Error & { details?: unknown }) => { if (n === seq.current) { setPreview(null); setProblems(Array.isArray(e.details) && e.details.length ? e.details.map(String) : [e.message]); } },
      ).finally(() => { if (n === seq.current) setPreviewing(false); });
    }, 500);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the draft's content (key), not its identity
  }, [client, t.id, key]);

  const pickers: Pickers = {
    playbooks: playbooks ?? [], missions: (missions ?? []).map((m) => ({ id: m.id, name: m.name, status: m.status })),
    agents: (agents ?? []).map((a) => ({ name: a.name })), channels, mapping: t.mapping ?? {},
  };
  const update = (i: number, patch: Partial<ActionDraft>) => setDrafts(drafts.map((d, j) => (j === i ? { ...d, ...patch } : d)));
  const move = (i: number, by: -1 | 1) => {
    const next = [...drafts];
    const [it] = next.splice(i, 1);
    next.splice(i + by, 0, it!);
    setDrafts(next);
  };
  const numOrUndef = (s: string) => (s.trim() ? Number(s) : undefined);

  return (
    <div className="space-y-5">
      <section className="space-y-3 border-b pb-5">
        <div>
          <h3 className="text-sm font-semibold">Actions</h3>
          <p className="text-caption text-muted-foreground">
            What runs on each accepted delivery, in order, after the sender got its answer (filtered, duplicate and rejected deliveries run nothing; a test only when asked).
            They run as the trigger's owner{t.owner ? ` (${t.owner})` : ""}. Templates read {"{{mapped.…}}"}, {"{{body.…}}"}, {"{{headers.…}}"}, {"{{query.…}}"}, {"{{trigger.name}}"}, {"{{delivery.id}}"} and earlier actions' outputs {"{{steps.<id>.…}}"}; never a secret.
          </p>
        </div>
        {drafts.length === 0 ? <p className="rounded-md border border-dashed px-3 py-6 text-center text-xs text-muted-foreground" data-testid="no-actions">No actions: deliveries are only recorded.</p> : (
          <ol className="divide-y rounded-md border" data-testid="action-list">
            {drafts.map((d, i) => (
              <li key={d.id ?? `new-${i}`} className="space-y-3 p-3" data-action={d.id ?? `new-${i}`} data-kind={d.kind}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs tabular-nums text-muted-foreground">{i + 1}.</span>
                  <Badge variant="outline" className="font-normal">{ACTION_KIND_LABEL[d.kind]}</Badge>
                  {d.id && <code className="text-caption text-muted-foreground">{d.id}</code>}
                  <Input className="h-7 min-w-0 flex-1 text-xs" value={d.name} placeholder="Label (optional)" aria-label={`Action ${i + 1} label`} onChange={(e) => update(i, { name: e.target.value })} />
                  <Switch checked={d.enabled} onCheckedChange={(v) => update(i, { enabled: v })} aria-label={`Action ${i + 1} enabled`} />
                  <Button size="icon" variant="ghost" className="h-7 w-7" disabled={i === 0} aria-label={`Move action ${i + 1} up`} onClick={() => move(i, -1)}><ArrowUp className="h-3.5 w-3.5" /></Button>
                  <Button size="icon" variant="ghost" className="h-7 w-7" disabled={i === drafts.length - 1} aria-label={`Move action ${i + 1} down`} onClick={() => move(i, 1)}><ArrowDown className="h-3.5 w-3.5" /></Button>
                  <Button size="icon" variant="ghost" className="h-7 w-7" aria-label={`Remove action ${i + 1}`} onClick={() => setDrafts(drafts.filter((_, j) => j !== i))}><Trash2 className="h-3.5 w-3.5" /></Button>
                </div>
                <ActionFields d={d} set={(patch) => update(i, patch)} p={pickers} earlier={drafts.slice(0, i).map((x) => x.id).filter((x): x is string => !!x)} />
                <Field label="Retries" hint={`After a failure, with backoff (default ${d.kind === "agent" ? "0 for an agent turn" : "2"}); what was created is never created again.`} className="max-w-48">
                  <Input className="h-8" inputMode="numeric" value={d.retries} placeholder={d.kind === "agent" ? "0" : "2"} onChange={(e) => update(i, { retries: e.target.value.replace(/\D/g, "") })} aria-label={`Action ${i + 1} retries`} />
                </Field>
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Switch checked={d.continueOnError} onCheckedChange={(v) => update(i, { continueOnError: v })} aria-label={`Action ${i + 1} continue on error`} />
                  If it fails, still run the next actions (otherwise they are skipped)
                </label>
              </li>
            ))}
          </ol>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <select className={cn(selectClass, "w-auto")} value={adding} aria-label="Action kind" onChange={(e) => setAdding(e.target.value as TriggerActionKind)}>
            {ACTION_KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
          </select>
          <Button size="sm" variant="outline" onClick={() => setDrafts([...drafts, emptyAction(adding)])}><Plus className="h-3.5 w-3.5" /> Add action</Button>
          <span className="text-caption text-muted-foreground">{ACTION_KINDS.find((k) => k.id === adding)?.hint}</span>
        </div>
      </section>

      {drafts.length > 0 && (
        <section className="space-y-2 border-b pb-5">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold">Preview</h3>
            {previewing && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
          </div>
          {problems.length > 0 && <ul className="list-disc space-y-0.5 pl-4 text-xs text-destructive" data-testid="action-problems">{problems.map((p) => <li key={p}>{p}</li>)}</ul>}
          {preview && <PreviewList preview={preview} />}
        </section>
      )}

      <section className="space-y-3 border-b pb-5">
        <div>
          <h3 className="text-sm font-semibold">Limits</h3>
          <p className="text-caption text-muted-foreground">Beyond a limit an action is skipped (and recorded as such). Empty: the default.</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label="At once" hint="Deliveries (default 2)"><Input className="h-8" inputMode="numeric" value={limits.concurrency} placeholder="2" onChange={(e) => setLimits({ ...limits, concurrency: e.target.value.replace(/\D/g, "") })} aria-label="Concurrency" /></Field>
          <Field label="Per minute" hint="Actions (default 30)"><Input className="h-8" inputMode="numeric" value={limits.perMinute} placeholder="30" onChange={(e) => setLimits({ ...limits, perMinute: e.target.value.replace(/\D/g, "") })} aria-label="Actions per minute" /></Field>
          <Field label="Per day" hint="Actions (default 1000)"><Input className="h-8" inputMode="numeric" value={limits.perDay} placeholder="1000" onChange={(e) => setLimits({ ...limits, perDay: e.target.value.replace(/\D/g, "") })} aria-label="Actions per day" /></Field>
          <Field label="Agents' spend a day" hint="USD; empty: no cap"><Input className="h-8" inputMode="decimal" value={limits.agentDailyCostUsd} placeholder="—" onChange={(e) => setLimits({ ...limits, agentDailyCostUsd: e.target.value.replace(/[^\d.]/g, "") })} aria-label="Agent daily cost cap" /></Field>
        </div>
        {usage && <p className="text-caption text-muted-foreground" data-testid="action-usage">Today: {usage.actions} action{usage.actions === 1 ? "" : "s"} started · agents spent ${usage.agentUsd.toFixed(2)}</p>}
      </section>

      <Button size="sm" onClick={() => void save({
        actions: inputs.length ? inputs : null,
        actionLimits: Object.values(limits).some((v) => v.trim()) ? {
          ...(numOrUndef(limits.concurrency) ? { concurrency: numOrUndef(limits.concurrency) } : {}), ...(numOrUndef(limits.perMinute) ? { perMinute: numOrUndef(limits.perMinute) } : {}),
          ...(numOrUndef(limits.perDay) ? { perDay: numOrUndef(limits.perDay) } : {}), ...(numOrUndef(limits.agentDailyCostUsd) ? { agentDailyCostUsd: numOrUndef(limits.agentDailyCostUsd) } : {}),
        } : null,
      }, "Actions saved")}>Save actions</Button>
    </div>
  );
}

/** A delivery's action runs, with links to what they created and Re-run actions. */
export function DeliveryActions({ d, onRerun }: { d: TriggerDelivery; onRerun: () => Promise<unknown> }) {
  const [busy, setBusy] = useState(false);
  const runs: TriggerActionRun[] = d.actions ?? [];
  const live = d.actionsStatus === "queued" || d.actionsStatus === "running";
  return (
    <div className="space-y-2" data-testid="delivery-actions">
      <div className="flex flex-wrap items-center gap-2">
        <p className="font-medium">Actions</p>
        {d.actionsStatus && <ActionStatusBadge status={d.actionsStatus} />}
        {d.actionsRequestedBy && <span className="text-muted-foreground">for {d.actionsRequestedBy}</span>}
        <Button size="sm" variant="outline" className="ml-auto h-7" disabled={busy || live || d.status !== "accepted"} onClick={() => {
          setBusy(true);
          void onRerun().then(() => toast.success("Actions queued again"), (e: Error) => toast.error(e.message)).finally(() => setBusy(false));
        }}>{busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} Re-run actions</Button>
      </div>
      {d.origin && <p className="text-muted-foreground">It arrived while the actions of trigger <Link className="underline" to={`/triggers?trigger=${encodeURIComponent(d.origin.triggerId)}&delivery=${encodeURIComponent(d.origin.deliveryId)}`}>{d.origin.triggerName ?? d.origin.triggerId}</Link> ran.</p>}
      {runs.length === 0 ? <p className="text-muted-foreground">{d.status === "accepted" ? (d.test ? "A test delivery: its actions did not run (send it with “run the actions” or re-run them)." : "No actions ran (the trigger had none).") : "Only an accepted delivery runs actions."}</p> : (
        <ol className="divide-y rounded-md border" data-testid="action-runs">
          {runs.map((r) => (
            <li key={r.actionId} className="space-y-1 px-3 py-2" data-run={r.actionId} data-run-status={r.status}>
              <div className="flex flex-wrap items-center gap-2">
                <ActionStatusBadge status={r.status} />
                <span className="font-medium">{r.name ?? ACTION_KIND_LABEL[r.kind]}</span>
                <code className="text-caption text-muted-foreground">{r.actionId}</code>
                <span className="ml-auto tabular-nums text-muted-foreground">
                  {r.attempts > 1 ? `${r.attempts} attempts · ` : ""}{r.startedAt ? when(r.startedAt) : when(r.queuedAt)}{r.endedAt && r.startedAt ? ` → ${when(r.endedAt)}` : ""}{r.costUsd ? ` · $${r.costUsd.toFixed(4)}` : ""}
                </span>
              </div>
              {r.error && <p className="text-destructive">{r.error}</p>}
              {r.reason && <p className="text-muted-foreground">{r.reason}</p>}
              {actionRefLinks(r.refs).length > 0 && (
                <p className="flex flex-wrap gap-x-3 gap-y-1">
                  {actionRefLinks(r.refs).map((l) => (l.to ? <Link key={l.label} to={l.to} className="text-primary underline-offset-2 hover:underline" data-ref={l.to}>{l.label}</Link> : <span key={l.label} className="text-muted-foreground">{l.label}</span>))}
                </p>
              )}
            </li>
          ))}
        </ol>
      )}
      {d.previousActions?.length ? <p className="text-caption text-muted-foreground">Earlier runs: {d.previousActions.map((p) => `${p.status ? ACTION_STATUS_LABEL[p.status].toLowerCase() : "?"}${p.endedAt ? ` (${when(p.endedAt)})` : ""}`).join(", ")}</p> : null}
    </div>
  );
}
