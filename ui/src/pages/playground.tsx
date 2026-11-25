/**
 * The Playground (agent suites phase 5; docs/agent-suites.md, "Playground"): 2–4 chat panes side
 * by side, each bound to a variant (an agent at a version with overrides) and its own mocks — tool
 * mocks (from a suite or inline), a scripted model, or real tools (admins, after a confirmation).
 * Type once and send to every pane (or one); the answers stream; each pane shows its cost, latency
 * and tokens. "Save as test case" turns an exchange into a suite case (reviewed first); "Promote
 * variant" writes a pane's overrides into the agent's draft (never deployed). Sessions are ephemeral
 * test chats, cleaned up like suite cases.
 */
import { useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { ArrowUpFromLine, FlaskConical, Gauge, Loader2, MessagesSquare, Plus, RotateCcw, Send, Settings2, Trash2 } from "lucide-react";
import {
  useAgentSuites, useAgentVersions, useAgents, usePlayground,
  type AgentConfig, type PlaygroundExchange, type PlaygroundPaneInput, type SuiteCase, type SuiteTraceToolCall,
} from "@polpo-ai/react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { MessageResponse } from "@/components/ai-elements/message";
import { AssistantSegments, ChatUserBubble } from "@/components/chat/chat-message-parts";
import { formatMs, formatUsd, traceAsChat } from "@/lib/agent-suites";
import { blankPane, cleanOverrides, overridesText, panesUseRealTools } from "@/lib/benchmarks";
import { cn } from "@/lib/utils";

const GRID: Record<number, string> = { 1: "lg:grid-cols-1", 2: "lg:grid-cols-2", 3: "lg:grid-cols-3", 4: "lg:grid-cols-2 2xl:grid-cols-4" };

function parseJson<T>(text: string, what: string): T | undefined {
  if (!text.trim()) return undefined;
  try { return JSON.parse(text) as T; } catch { throw new Error(`${what}: not valid JSON`); }
}

/** One pane's settings: the variant, the toggles, the mocks. */
function PaneSettings({ pane, agents, onChange }: { pane: PlaygroundPaneInput & { toolsText?: string; modelText?: string }; agents: AgentConfig[]; onChange: (p: PlaygroundPaneInput & { toolsText?: string; modelText?: string }) => void }) {
  const versions = useAgentVersions(pane.variant.agent || undefined);
  const suites = useAgentSuites(pane.variant.agent || undefined, { runsLimit: 1 });
  const o = pane.variant.overrides ?? {};
  const setVariant = (patch: Partial<PlaygroundPaneInput["variant"]>) => onChange({ ...pane, variant: { ...pane.variant, ...patch } });
  const setOver = (patch: Record<string, unknown>) => setVariant({ overrides: { ...o, ...patch } });
  const suite = suites.suites?.find((s) => s.id === pane.mocks?.suite?.suite);
  return (
    <div className="space-y-2 border-b border-border/40 px-3 py-2 text-caption" data-testid="pg-pane-settings">
      <div className="flex flex-wrap items-center gap-2">
        <Input className="h-7 w-28" value={pane.label ?? ""} onChange={(e) => onChange({ ...pane, label: e.target.value })} placeholder="Label" aria-label="Pane label" />
        <Select value={pane.variant.agent || undefined} onValueChange={(agent) => onChange({ ...pane, variant: { agent, version: "production" }, mocks: undefined })}>
          <SelectTrigger size="sm" className="w-32" aria-label="Agent"><SelectValue placeholder="Agent" /></SelectTrigger>
          <SelectContent>{agents.map((a) => <SelectItem key={a.name} value={a.name}>{a.name}</SelectItem>)}</SelectContent>
        </Select>
        <Select value={pane.variant.version ?? "production"} onValueChange={(version) => setVariant({ version })}>
          <SelectTrigger size="sm" className="w-28" aria-label="Version"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="production">Production</SelectItem>
            <SelectItem value="draft">Draft</SelectItem>
            {(versions.data?.versions ?? []).map((v) => <SelectItem key={v.version} value={v.version}>v{v.version}</SelectItem>)}
          </SelectContent>
        </Select>
        <Input className="h-7 w-44" value={o.model ?? ""} onChange={(e) => setOver({ model: e.target.value })} placeholder="Model override" aria-label="Model override" />
      </div>
      <Textarea rows={2} className="text-xs" value={o.instructionsAppend ?? ""} onChange={(e) => setOver({ instructionsAppend: e.target.value })} placeholder="Instructions to append (this pane only)" aria-label="Instructions to append" />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <label className="flex items-center gap-1.5"><Switch checked={pane.mockTools !== false} onCheckedChange={(v) => onChange({ ...pane, mockTools: v })} aria-label="Tool mocks" data-testid="pg-toggle-tools" /> Tool mocks</label>
        <label className="flex items-center gap-1.5"><Switch checked={pane.mockModel === true} onCheckedChange={(v) => onChange({ ...pane, mockModel: v })} aria-label="Model mock" data-testid="pg-toggle-model" /> Model mock</label>
        <label className={cn("flex items-center gap-1.5", pane.realTools && "text-warning")}><Switch checked={pane.realTools === true} onCheckedChange={(v) => onChange({ ...pane, realTools: v })} aria-label="Real tools" data-testid="pg-toggle-real" /> Real tools</label>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Select value={pane.mocks?.suite?.suite ?? "none"} onValueChange={(s) => onChange({ ...pane, mocks: { ...pane.mocks, suite: s === "none" ? undefined : { agent: pane.variant.agent, suite: s } } })}>
          <SelectTrigger size="sm" className="w-44" aria-label="Mocks from a suite"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="none">No suite mocks</SelectItem>
            {(suites.suites ?? []).map((s) => <SelectItem key={s.id} value={s.id}>Mocks of {s.name}</SelectItem>)}
          </SelectContent>
        </Select>
        {suite && (
          <Select value={pane.mocks?.suite?.caseId ?? "shared"} onValueChange={(c) => onChange({ ...pane, mocks: { ...pane.mocks, suite: { agent: pane.variant.agent, suite: suite.id, ...(c !== "shared" ? { caseId: c } : {}) } } })}>
            <SelectTrigger size="sm" className="w-44" aria-label="Case mocks"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="shared">Shared mocks only</SelectItem>
              {suite.cases.map((c) => <SelectItem key={c.id} value={c.id}>+ {c.name}</SelectItem>)}
            </SelectContent>
          </Select>
        )}
      </div>
      <Textarea rows={2} className="font-mono text-micro" value={pane.toolsText ?? ""} onChange={(e) => onChange({ ...pane, toolsText: e.target.value })}
        placeholder={'Quick tool mocks (JSON): [{ "tool": "mcp__shop__*", "response": { "ok": true } }]'} aria-label="Inline tool mocks" />
      {pane.mockModel && (
        <Textarea rows={2} className="font-mono text-micro" value={pane.modelText ?? ""} onChange={(e) => onChange({ ...pane, modelText: e.target.value })}
          placeholder={'Scripted turns (JSON): { "turns": [{ "toolCalls": [{ "name": "…", "args": {} }] }, { "text": "…" }] }'} aria-label="Scripted model turns" />
      )}
    </div>
  );
}

function ToolList({ calls }: { calls: SuiteTraceToolCall[] }) {
  if (!calls.length) return null;
  return (
    <ul className="space-y-0.5 font-mono text-micro text-muted-foreground" data-testid="pg-tools">
      {calls.map((c, i) => (
        <li key={`${c.id}-${i}`} className={cn("break-all", c.isError && "text-destructive")}>
          {c.name} {JSON.stringify(c.args).slice(0, 120)} <span className="font-sans">[{c.mocked || "real"}{c.mockId ? ` ${c.mockId}` : ""}]</span> → {c.result.slice(0, 160)}
        </li>
      ))}
    </ul>
  );
}

function Exchange({ ex, agent, onSave }: { ex: PlaygroundExchange; agent: string; onSave: () => void }) {
  const { segments } = traceAsChat(ex.trace);
  return (
    <div className="space-y-2" data-testid="pg-exchange" data-status={ex.status}>
      <div className="flex justify-end"><div className="max-w-[85%]"><ChatUserBubble text={ex.message} /></div></div>
      {segments.length ? <AssistantSegments segments={segments} isStreaming={false} /> : <p className="text-xs">{ex.trace.text || "—"}</p>}
      {ex.error && <p className="text-caption text-destructive">{ex.error}</p>}
      <div className="flex flex-wrap items-center gap-2 text-micro text-muted-foreground">
        <span data-testid="pg-metrics">{formatUsd(ex.costUsd)} · {formatMs(ex.durationMs)} · {ex.tokens.input + ex.tokens.output} tokens · {ex.trace.toolCalls.length} tool call(s) · {ex.mode === "all" ? "scripted model" : "real model"}</span>
        <Button variant="ghost" size="sm" className="h-6 text-micro" disabled={ex.status === "error"} onClick={onSave} aria-label={`Save as test case (${agent})`} data-testid="pg-save-case">
          <FlaskConical className="mr-1 h-3 w-3" /> Save as test case
        </Button>
      </div>
    </div>
  );
}

/** Review a proposed case (from caseFromTrace), choose the suite, save it. */
function SaveCaseDialog({ agent, load, onClose }: { agent: string; load: (opts: { name?: string; mockModel: boolean }) => Promise<{ case: SuiteCase }>; onClose: () => void }) {
  const suites = useAgentSuites(agent, { runsLimit: 1 });
  const [suiteId, setSuiteId] = useState<string>("");
  const [mockModel, setMockModel] = useState(true);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const propose = async () => {
    setBusy(true);
    setError(null);
    try { setText(JSON.stringify((await load({ mockModel })).case, null, 2)); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-2xl" data-testid="pg-save-dialog">
        <DialogHeader>
          <DialogTitle>Save as a test case of {agent}</DialogTitle>
          <DialogDescription>The exchange's tool calls become mocks (their observed results) and checks (same tools, same arguments, in order). Review it, then save it into a suite.</DialogDescription>
        </DialogHeader>
        <div className="space-y-2 text-caption">
          <div className="flex flex-wrap items-center gap-3">
            <Select value={suiteId || undefined} onValueChange={setSuiteId}>
              <SelectTrigger size="sm" className="w-56" aria-label="Suite"><SelectValue placeholder="Choose a suite" /></SelectTrigger>
              <SelectContent>{(suites.suites ?? []).map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}</SelectContent>
            </Select>
            <label className="flex items-center gap-1.5"><Checkbox checked={mockModel} onCheckedChange={(v) => setMockModel(v === true)} /> Script the model too (offline contract case)</label>
            <Button variant="outline" size="sm" disabled={busy} onClick={() => void propose()} data-testid="pg-propose-case">{busy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}{text ? "Propose again" : "Propose the case"}</Button>
          </div>
          {text && <Textarea rows={14} className="font-mono text-micro" value={text} onChange={(e) => setText(e.target.value)} aria-label="The case (JSON)" data-testid="pg-case-json" />}
          {error && <p className="text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button disabled={!text || !suiteId || busy} data-testid="pg-save-case-confirm" onClick={() => {
            let c: SuiteCase;
            try { c = JSON.parse(text) as SuiteCase; } catch { setError("The case is not valid JSON"); return; }
            setBusy(true);
            void suites.accept(suiteId, [c]).then(() => { toast.success(`Added "${c.name}" to ${suites.suites?.find((s) => s.id === suiteId)?.name ?? suiteId}`); onClose(); })
              .catch((e) => setError((e as Error).message)).finally(() => setBusy(false));
          }}>Save to suite</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type PaneDraft = PlaygroundPaneInput & { toolsText?: string; modelText?: string };

export function PlaygroundPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { agents } = useAgents();
  const pg = usePlayground();
  const startAgent = params.get("agent") ?? "";
  const startSuite = params.get("suite");
  const [drafts, setDrafts] = useState<PaneDraft[] | null>(null);
  const agentFor = startAgent || agents[0]?.name || "";
  const panes: PaneDraft[] = useMemo(() => drafts ?? (agentFor ? [
    blankPane(agentFor, 1, { label: "Production", ...(startSuite ? { mocks: { suite: { agent: agentFor, suite: startSuite } } } : {}) }),
    blankPane(agentFor, 2, { label: "Draft", variant: { agent: agentFor, version: "draft" }, ...(startSuite ? { mocks: { suite: { agent: agentFor, suite: startSuite } } } : {}) }),
  ] : []), [drafts, agentFor, startSuite]);
  const [dirty, setDirty] = useState(true);
  const [message, setMessage] = useState("");
  const [confirmReal, setConfirmReal] = useState<{ paneIds?: string[] } | null>(null);
  const [saving, setSaving] = useState<{ paneId: string; index: number; agent: string } | null>(null);
  const [promoting, setPromoting] = useState<PaneDraft | null>(null);
  const [settingsOpen, setSettingsOpen] = useState<Record<number, boolean>>({ 0: true, 1: true });

  const edit = (i: number, p: PaneDraft) => { setDrafts(panes.map((x, j) => (j === i ? p : x))); setDirty(true); };
  const toInput = (p: PaneDraft): PlaygroundPaneInput => {
    const tools = parseJson<unknown[]>(p.toolsText ?? "", `${p.label ?? "Pane"}: tool mocks`);
    const model = p.mockModel ? parseJson<{ turns: unknown[] }>(p.modelText ?? "", `${p.label ?? "Pane"}: scripted turns`) : undefined;
    const overrides = cleanOverrides(p.variant.overrides);
    const mocks = { ...(p.mocks?.suite ? { suite: p.mocks.suite } : {}), ...(tools ? { tools } : {}), ...(model ? { model } : {}) };
    const { toolsText: _t, modelText: _m, ...rest } = p;
    return { ...rest, variant: { agent: p.variant.agent, version: p.variant.version ?? "production", ...(overrides ? { overrides } : {}) }, ...(Object.keys(mocks).length ? { mocks: mocks as PlaygroundPaneInput["mocks"] } : { mocks: undefined }) };
  };

  const doSend = async (paneIds?: string[], allowRealTools = false) => {
    const text = message.trim();
    if (!text) return;
    try {
      const inputs = panes.map(toInput);
      if (!pg.session) await pg.open(inputs);
      else if (dirty) await pg.setPanes(inputs.map((p, i) => ({ ...p, id: pg.session!.panes[i]?.id ?? `pane-${i + 1}` })));
      setDirty(false);
      setMessage("");
      await pg.send(text, { ...(paneIds ? { paneIds } : {}), ...(allowRealTools ? { allowRealTools: true } : {}) });
    } catch (e) { toast.error((e as Error).message); }
  };
  const send = (paneIds?: string[]) => {
    const targets = paneIds ? panes.filter((_, i) => paneIds.includes(pg.session?.panes[i]?.id ?? `pane-${i + 1}`)) : panes;
    if (panesUseRealTools(targets)) setConfirmReal({ ...(paneIds ? { paneIds } : {}) });
    else void doSend(paneIds);
  };

  return (
    <div className="flex flex-1 flex-col gap-4 pb-bottom-nav lg:pb-4" data-testid="playground-page">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5 text-sm font-medium"><MessagesSquare className="h-4 w-4 text-muted-foreground" /> Playground</p>
          <p className="text-caption text-muted-foreground">Chat with up to four variants side by side. Test chats: nothing stays in the agents' conversations. Tools are mocked or blocked unless a pane runs them for real.</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => navigate("/benchmarks")}><Gauge className="mr-1 h-3.5 w-3.5" /> Benchmarks</Button>
        <Button variant="outline" size="sm" disabled={panes.length >= 4 || !agentFor} data-testid="pg-add-pane"
          onClick={() => { setDrafts([...panes, blankPane(panes.at(-1)?.variant.agent ?? agentFor, panes.length + 1)]); setDirty(true); setSettingsOpen({ ...settingsOpen, [panes.length]: true }); }}>
          <Plus className="mr-1 h-3.5 w-3.5" /> Pane
        </Button>
        <Button variant="ghost" size="sm" disabled={!pg.session} onClick={() => void pg.reset()} data-testid="pg-reset"><RotateCcw className="mr-1 h-3.5 w-3.5" /> Clear</Button>
      </div>

      {!agentFor ? <p className="text-sm text-muted-foreground">No agents yet: create one first.</p> : (
        <div className={cn("grid grid-cols-1 gap-4", GRID[panes.length] ?? GRID[4])}>
          {panes.map((p, i) => {
            const id = pg.session?.panes[i]?.id ?? `pane-${i + 1}`;
            const exchanges = pg.session?.exchanges[id] ?? [];
            const live = pg.live[id];
            const totals = exchanges.reduce((a, x) => ({ cost: a.cost + x.costUsd, ms: a.ms + x.durationMs, tokens: a.tokens + x.tokens.input + x.tokens.output }), { cost: 0, ms: 0, tokens: 0 });
            const over = overridesText(cleanOverrides(p.variant.overrides));
            return (
              <section key={i} aria-label={p.label ?? `Pane ${i + 1}`} className="flex min-w-0 flex-col rounded-lg border border-border/40 bg-card/80" data-testid="pg-pane">
                <header className="flex flex-wrap items-center gap-2 border-b border-border/40 px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium">{p.label || `Pane ${i + 1}`}</p>
                    <p className="truncate text-micro text-muted-foreground">
                      {p.variant.agent}@{p.variant.version ?? "production"}{over ? ` · ${over}` : ""} · {p.mockModel ? "scripted model" : "real model"} · tools {p.mockTools !== false ? "mocked" : "not mocked"}{p.realTools ? ", unmocked run for real" : ", unmocked blocked"}
                    </p>
                  </div>
                  {p.realTools && <Badge variant="outline" className="border-warning/40 text-micro text-warning">real tools</Badge>}
                  <Button variant="ghost" size="sm" className="h-7" aria-label="Settings" aria-pressed={!!settingsOpen[i]} onClick={() => setSettingsOpen({ ...settingsOpen, [i]: !settingsOpen[i] })}><Settings2 className="h-3.5 w-3.5" /></Button>
                  <Button variant="ghost" size="sm" className="h-7" aria-label="Promote variant" disabled={!cleanOverrides(p.variant.overrides)} onClick={() => setPromoting(p)} data-testid="pg-promote"><ArrowUpFromLine className="h-3.5 w-3.5" /></Button>
                  <Button variant="ghost" size="sm" className="h-7" aria-label="Remove pane" disabled={panes.length <= 1} onClick={() => { setDrafts(panes.filter((_, j) => j !== i)); setDirty(true); }}><Trash2 className="h-3.5 w-3.5" /></Button>
                </header>
                {settingsOpen[i] && <PaneSettings pane={p} agents={agents} onChange={(np) => edit(i, np)} />}
                <div className="flex-1 space-y-4 px-3 py-3" data-testid="pg-conversation">
                  {!exchanges.length && !live && <p className="py-6 text-center text-caption text-muted-foreground">Send a message to start.</p>}
                  {exchanges.map((ex) => <Exchange key={ex.index} ex={ex} agent={p.variant.agent} onSave={() => setSaving({ paneId: id, index: ex.index, agent: p.variant.agent })} />)}
                  {live?.running && (
                    <div className="space-y-1" data-testid="pg-live">
                      <ToolList calls={live.tools} />
                      <div className="text-xs">{live.text ? <MessageResponse>{live.text}</MessageResponse> : <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}</div>
                    </div>
                  )}
                </div>
                <footer className="flex items-center gap-2 border-t border-border/40 px-3 py-2 text-micro text-muted-foreground">
                  <span className="flex-1" data-testid="pg-pane-totals">{exchanges.length} exchange(s) · {formatUsd(totals.cost)} · {formatMs(totals.ms)} · {totals.tokens} tokens</span>
                  <Button variant="ghost" size="sm" className="h-6 text-micro" disabled={!message.trim() || pg.sending} onClick={() => send([id])} data-testid="pg-send-one"><Send className="mr-1 h-3 w-3" /> Send here</Button>
                </footer>
              </section>
            );
          })}
        </div>
      )}

      <div className="flex items-end gap-2 rounded-lg border border-border/40 bg-card/80 p-2">
        <Textarea rows={2} className="min-h-0 flex-1 resize-none border-0 bg-transparent text-sm shadow-none focus-visible:ring-0" value={message} onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }} placeholder="Type once, send to every pane" aria-label="Message" data-testid="pg-message" />
        <Button disabled={!message.trim() || pg.sending || !panes.length} onClick={() => send()} data-testid="pg-send-all">
          {pg.sending ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Send className="mr-1 h-3.5 w-3.5" />} Send to all
        </Button>
      </div>
      {pg.error && <p className="text-caption text-destructive">{pg.error.message}</p>}

      <ConfirmDialog open={confirmReal !== null} onOpenChange={(o) => { if (!o) setConfirmReal(null); }}
        title="Send with real tools?" description="A pane runs real tools: calls no mock answers really run and may send, write or spend (admins only). Approvals are never given by a test."
        confirmLabel="Send with real tools" onConfirm={() => { const c = confirmReal; setConfirmReal(null); void doSend(c?.paneIds, true); }} />

      <ConfirmDialog open={promoting !== null} onOpenChange={(o) => { if (!o) setPromoting(null); }}
        title={`Promote to ${promoting?.variant.agent ?? ""}'s draft?`}
        description={`The pane's overrides (${overridesText(cleanOverrides(promoting?.variant.overrides))}) are written into the agent's draft, from version ${promoting?.variant.version ?? "production"}. Nothing is deployed: publish and deploy the draft when ready.`}
        confirmLabel="Write the draft"
        onConfirm={() => {
          const p = promoting;
          setPromoting(null);
          const overrides = cleanOverrides(p?.variant.overrides);
          if (!p || !overrides) return;
          void pg.promote({ agent: p.variant.agent, version: p.variant.version ?? "production", overrides })
            .then((r) => toast.success(`${r.agent}'s draft updated (${Object.keys(r.fields).join(", ")}): not deployed`)).catch((e) => toast.error((e as Error).message));
        }} />

      {saving && (
        <SaveCaseDialog agent={saving.agent} onClose={() => setSaving(null)}
          load={(o) => pg.saveCase({ paneId: saving.paneId, exchange: saving.index, mockModel: o.mockModel, ...(o.name ? { name: o.name } : {}) })} />
      )}
    </div>
  );
}
