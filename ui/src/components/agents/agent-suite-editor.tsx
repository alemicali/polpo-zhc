/**
 * A suite's editor in the Suites tab: a structured form (the suite's name, default mode and budgets;
 * each case's input, mode, dataset, scripted model turns, tool mocks and assertions), the datasets
 * (rows, CSV / JSON import) and the whole suite as JSON or YAML. Saving sends the revision it
 * started from, so a save over someone else's change is refused.
 */
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Code2, Database, FileText, ListChecks, Loader2, Plus, Save, Trash2, Upload } from "lucide-react";
import type { AgentSuite, AgentSuiteInput, SuiteAssertion, SuiteAssertionType, SuiteCase, SuiteMockMode, ToolMock, ScriptedTurn, UseAgentSuitesReturn } from "@polpo-ai/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ASSERTION_LABELS, ASSERTION_TEMPLATES, SUITE_MODES, blankCase } from "@/lib/agent-suites";
import { cn } from "@/lib/utils";

type View = "form" | "datasets" | "json" | "yaml";
type Draft = AgentSuiteInput & { id?: string };

/** A JSON value edited as text: applied when it parses, the error shown when it does not. */
function JsonField({ value, onChange, label, rows = 2, placeholder }: { value: unknown; onChange: (v: unknown) => void; label: string; rows?: number; placeholder?: string }) {
  const [text, setText] = useState(() => (value === undefined ? "" : JSON.stringify(value, null, 1)));
  const [error, setError] = useState<string | null>(null);
  return (
    <label className="block min-w-0">
      <span className="text-micro text-muted-foreground">{label}</span>
      <Textarea
        value={text}
        rows={rows}
        placeholder={placeholder}
        aria-label={label}
        className={cn("font-mono text-caption", error && "border-destructive")}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          if (!text.trim()) { setError(null); onChange(undefined); return; }
          try { onChange(JSON.parse(text)); setError(null); } catch (err) { setError((err as Error).message); }
        }}
      />
      {error && <span className="text-micro text-destructive">{error}</span>}
    </label>
  );
}

function ModeSelect({ value, onChange, inherit }: { value: SuiteMockMode | undefined; onChange: (m: SuiteMockMode | undefined) => void; inherit?: string }) {
  return (
    <Select value={value ?? "inherit"} onValueChange={(v) => onChange(v === "inherit" ? undefined : v as SuiteMockMode)}>
      <SelectTrigger size="sm" className="w-48" aria-label="Mock mode"><SelectValue /></SelectTrigger>
      <SelectContent>
        {inherit && <SelectItem value="inherit">{inherit}</SelectItem>}
        {SUITE_MODES.map((m) => <SelectItem key={m.id} value={m.id}>{m.label}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

function RowHeader({ title, onRemove }: { title: string; onRemove?: () => void }) {
  return (
    <div className="flex items-center gap-2">
      <span className="min-w-0 flex-1 truncate text-micro font-medium uppercase tracking-label text-muted-foreground">{title}</span>
      {onRemove && <Button variant="ghost" size="sm" className="h-6 px-1.5" onClick={onRemove} aria-label={`Remove ${title}`}><Trash2 className="h-3 w-3" /></Button>}
    </div>
  );
}

function CaseForm({ value, onChange, onRemove, defaultMode, datasets }: { value: SuiteCase; onChange: (c: SuiteCase) => void; onRemove: () => void; defaultMode: SuiteMockMode; datasets: Array<{ id: string; name: string }> }) {
  const mode = value.mode ?? defaultMode;
  const mocksModel = mode === "model" || mode === "all";
  const mocksTools = mode === "tools" || mode === "all";
  const turns = value.mocks?.model?.turns ?? [];
  const tools = value.mocks?.tools ?? [];
  const setMocks = (m: Partial<NonNullable<SuiteCase["mocks"]>>) => onChange({ ...value, mocks: { ...value.mocks, ...m } });
  const setTurn = (i: number, t: ScriptedTurn) => setMocks({ model: { ...value.mocks?.model, turns: turns.map((x, j) => (j === i ? t : x)) } });
  const setTool = (i: number, t: ToolMock) => setMocks({ tools: tools.map((x, j) => (j === i ? t : x)) });
  const setAssertion = (i: number, a: SuiteAssertion) => onChange({ ...value, assertions: value.assertions.map((x, j) => (j === i ? a : x)) });
  const [newType, setNewType] = useState<SuiteAssertionType>("tool_called");
  return (
    <li className="space-y-3 border-b border-border/40 px-4 py-3 last:border-b-0" data-testid="suite-case-form">
      <div className="flex flex-wrap items-center gap-2">
        <Input value={value.name} onChange={(e) => onChange({ ...value, name: e.target.value })} aria-label="Case name" className="h-8 min-w-0 flex-1 text-xs font-medium" />
        <Select value={value.input.kind} onValueChange={(k) => onChange({ ...value, input: { ...value.input, kind: k as "chat" | "task" } })}>
          <SelectTrigger size="sm" className="w-28" aria-label="Input kind"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="chat">Chat</SelectItem><SelectItem value="task">Task</SelectItem></SelectContent>
        </Select>
        <ModeSelect value={value.mode} onChange={(m) => onChange({ ...value, mode: m })} inherit="Suite default" />
        <Select value={value.dataset ?? "none"} onValueChange={(d) => onChange({ ...value, dataset: d === "none" ? undefined : d })}>
          <SelectTrigger size="sm" className="w-40" aria-label="Dataset"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="none">No dataset</SelectItem>
            {datasets.map((d) => <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>)}
          </SelectContent>
        </Select>
        <Button variant="ghost" size="sm" className="h-8" onClick={onRemove} aria-label={`Remove ${value.name}`}><Trash2 className="h-3.5 w-3.5" /></Button>
      </div>
      <Textarea value={value.input.message} rows={2} aria-label="Message" placeholder={value.input.kind === "task" ? "The task description ({{row.column}} from the dataset)" : "The message to the agent ({{row.column}} from the dataset)"}
        className="text-xs" onChange={(e) => onChange({ ...value, input: { ...value.input, message: e.target.value } })} />

      {mocksModel && (
        <div className="space-y-2">
          <RowHeader title="Scripted model turns" />
          {turns.map((t, i) => (
            <div key={i} className="grid gap-2 sm:grid-cols-2" data-testid="suite-turn">
              <Textarea value={t.text ?? ""} rows={2} aria-label={`Turn ${i + 1} text`} placeholder={`Turn ${i + 1}: what the model says`} className="text-xs"
                onChange={(e) => setTurn(i, { ...t, text: e.target.value || undefined })} />
              <div className="flex gap-1">
                <div className="min-w-0 flex-1"><JsonField label={`Turn ${i + 1} tool calls`} value={t.toolCalls} placeholder='[{"name": "mcp__printful__shipping_rates", "args": {"country": "IT"}}]'
                  onChange={(v) => setTurn(i, { ...t, toolCalls: v as ScriptedTurn["toolCalls"] })} /></div>
                <Button variant="ghost" size="sm" className="h-7 px-1.5" aria-label={`Remove turn ${i + 1}`} onClick={() => setMocks({ model: { ...value.mocks?.model, turns: turns.filter((_, j) => j !== i) } })}><Trash2 className="h-3 w-3" /></Button>
              </div>
            </div>
          ))}
          <Button variant="outline" size="sm" className="h-7" onClick={() => setMocks({ model: { ...value.mocks?.model, turns: [...turns, { text: "" }] } })}><Plus className="mr-1 h-3 w-3" /> Turn</Button>
        </div>
      )}

      {mocksTools && (
        <div className="space-y-2">
          <RowHeader title="Tool mocks" />
          {tools.map((t, i) => (
            <div key={i} className="grid gap-2 border-l-2 border-border/60 pl-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto]" data-testid="suite-tool-mock">
              <Input value={t.tool} aria-label={`Mock ${i + 1} tool`} placeholder="tool or glob (mcp__printful__*)" className="h-8 font-mono text-caption" onChange={(e) => setTool(i, { ...t, tool: e.target.value })} />
              <JsonField label="When args" value={t.when?.args} placeholder='{"country": "IT"}' onChange={(v) => setTool(i, { ...t, when: v === undefined ? undefined : { ...t.when, args: v } })} />
              {t.error !== undefined
                ? <Input value={t.error} aria-label={`Mock ${i + 1} error`} className="h-8 text-caption" onChange={(e) => setTool(i, { ...t, error: e.target.value })} />
                : <JsonField label="Response" value={t.response} placeholder='{"rates": []}' onChange={(v) => setTool(i, { ...t, response: v })} />}
              <div className="flex items-start gap-1">
                <Button variant="ghost" size="sm" className="h-7 px-1.5 text-micro" onClick={() => setTool(i, t.error !== undefined ? { ...t, error: undefined, response: "" } : { ...t, response: undefined, error: "" })}>{t.error !== undefined ? "Respond" : "Fail"}</Button>
                <Button variant="ghost" size="sm" className="h-7 px-1.5" aria-label={`Remove mock ${i + 1}`} onClick={() => setMocks({ tools: tools.filter((_, j) => j !== i) })}><Trash2 className="h-3 w-3" /></Button>
              </div>
            </div>
          ))}
          <Button variant="outline" size="sm" className="h-7" onClick={() => setMocks({ tools: [...tools, { tool: "", response: "" }] })}><Plus className="mr-1 h-3 w-3" /> Tool mock</Button>
        </div>
      )}

      <div className="space-y-2">
        <RowHeader title="Assertions" />
        {value.assertions.map((a, i) => {
          const { type, ...params } = a;
          return (
            <div key={`${i}-${type}`} className="flex items-start gap-2" data-testid="suite-assertion-form">
              <span className="mt-2 w-36 shrink-0 text-caption font-medium">{ASSERTION_LABELS[type]}</span>
              <div className="min-w-0 flex-1">
                <JsonField label={`${type} parameters`} value={params} onChange={(v) => setAssertion(i, { ...(v as object ?? {}), type } as SuiteAssertion)} />
              </div>
              <Button variant="ghost" size="sm" className="mt-1 h-7 px-1.5" aria-label={`Remove assertion ${i + 1}`} onClick={() => onChange({ ...value, assertions: value.assertions.filter((_, j) => j !== i) })}><Trash2 className="h-3 w-3" /></Button>
            </div>
          );
        })}
        <div className="flex items-center gap-2">
          <Select value={newType} onValueChange={(v) => setNewType(v as SuiteAssertionType)}>
            <SelectTrigger size="sm" className="w-48" aria-label="Assertion type"><SelectValue /></SelectTrigger>
            <SelectContent>{(Object.keys(ASSERTION_LABELS) as SuiteAssertionType[]).map((t) => <SelectItem key={t} value={t}>{ASSERTION_LABELS[t]}</SelectItem>)}</SelectContent>
          </Select>
          <Button variant="outline" size="sm" className="h-7" data-testid="suite-add-assertion"
            onClick={() => onChange({ ...value, assertions: [...value.assertions, { type: newType, ...ASSERTION_TEMPLATES[newType] } as SuiteAssertion] })}>
            <Plus className="mr-1 h-3 w-3" /> Assertion
          </Button>
        </div>
      </div>
    </li>
  );
}

function DatasetsView({ draft, setDraft, saved, suites }: { draft: Draft; setDraft: (d: Draft) => void; saved?: AgentSuite; suites: UseAgentSuitesReturn }) {
  const [format, setFormat] = useState<"csv" | "json">("csv");
  const [text, setText] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const datasets = draft.datasets ?? [];
  const importIt = async () => {
    if (!saved) { toast.error("Save the suite first, then import its datasets"); return; }
    setBusy(true);
    try {
      const s = await suites.importDataset(saved.id, { format, text, ...(name.trim() ? { name: name.trim() } : {}) });
      setDraft({ ...draft, datasets: s.datasets });
      setText("");
      toast.success(`Imported: ${s.datasets.map((d) => `${d.name} (${d.rows.length} rows)`).join(", ")}`);
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="space-y-3 px-4 py-3" data-testid="suite-datasets">
      {datasets.length === 0 && <p className="text-caption text-muted-foreground">No datasets. A case with a dataset runs once per row, with {"{{row.column}}"} filled in its message, mocks and assertions.</p>}
      {datasets.map((d, i) => (
        <div key={d.id ?? i} className="space-y-1">
          <div className="flex items-center gap-2">
            <Database className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate text-xs font-medium">{d.name} <span className="font-mono text-micro text-muted-foreground">{d.id}</span> · {d.rows.length} rows</span>
            <Button variant="ghost" size="sm" className="h-6 px-1.5" aria-label={`Remove ${d.name}`} onClick={() => setDraft({ ...draft, datasets: datasets.filter((_, j) => j !== i) })}><Trash2 className="h-3 w-3" /></Button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-caption">
              <thead><tr>{(d.columns ?? Object.keys(d.rows[0] ?? {})).map((c) => <th key={c} className="border-b border-border/40 px-2 py-1 text-left font-medium text-muted-foreground">{c}</th>)}</tr></thead>
              <tbody>
                {d.rows.slice(0, 5).map((r, j) => <tr key={j}>{(d.columns ?? Object.keys(r)).map((c) => <td key={c} className="border-b border-border/20 px-2 py-1 font-mono">{String(r[c] ?? "")}</td>)}</tr>)}
              </tbody>
            </table>
            {d.rows.length > 5 && <p className="px-2 pt-1 text-micro text-muted-foreground">… {d.rows.length - 5} more rows</p>}
          </div>
        </div>
      ))}
      <div className="space-y-2 border-t border-border/40 pt-3">
        <div className="flex flex-wrap items-center gap-2">
          <Upload className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-xs font-medium">Import</span>
          <Select value={format} onValueChange={(f) => setFormat(f as "csv" | "json")}>
            <SelectTrigger size="sm" className="w-24" aria-label="Format"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="csv">CSV</SelectItem><SelectItem value="json">JSON</SelectItem></SelectContent>
          </Select>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Dataset name" aria-label="Dataset name" className="h-8 w-48 text-xs" />
          <input type="file" accept=".csv,.json,.tsv,text/csv,application/json" aria-label="Dataset file" className="max-w-56 text-caption"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) { void f.text().then(setText); if (!name) setName(f.name.replace(/\.[^.]+$/, "")); if (/\.json$/i.test(f.name)) setFormat("json"); } }} />
        </div>
        <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={4} aria-label="Dataset text" placeholder={format === "csv" ? "country,rate\nIT,4.99\nFR,5.49" : '[{"country": "IT", "rate": 4.99}]'} className="font-mono text-caption" />
        <Button size="sm" disabled={!text.trim() || busy} onClick={() => void importIt()} data-testid="suite-import">
          {busy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Upload className="mr-1 h-3.5 w-3.5" />} Import rows
        </Button>
      </div>
    </div>
  );
}

export function AgentSuiteEditor({ saved, initial, suites, onSaved, onClose }: {
  saved?: AgentSuite;
  initial: Draft;
  suites: UseAgentSuitesReturn;
  onSaved: (s: AgentSuite) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<Draft>(initial);
  const [view, setView] = useState<View>("form");
  const [jsonText, setJsonText] = useState("");
  const [yamlText, setYamlText] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => { if (view === "json") setJsonText(JSON.stringify(draft, null, 2)); }, [view]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (view !== "yaml" || !saved) return;
    let cancelled = false;
    setYamlText(null);
    suites.yaml(saved.id).then((y) => { if (!cancelled) setYamlText(y.yaml); }).catch((e) => toast.error((e as Error).message));
    return () => { cancelled = true; };
  }, [view, saved, suites]);

  const save = async (body: Draft | { yaml: string }) => {
    setSaving(true);
    try {
      const s = await suites.save(body, saved ? { id: saved.id, revision: saved.revision } : {});
      toast.success(`Saved ${s.name} (revision ${s.revision})`);
      onSaved(s);
    } catch (e) { toast.error((e as Error).message); } finally { setSaving(false); }
  };
  const saveCurrent = () => {
    if (view === "yaml") { if (yamlText !== null) void save({ yaml: yamlText }); return; }
    if (view === "json") {
      try { void save(JSON.parse(jsonText) as Draft); } catch (e) { toast.error(`JSON: ${(e as Error).message}`); }
      return;
    }
    void save(draft);
  };
  const cases = (draft.cases ?? []) as SuiteCase[];
  const views: Array<{ id: View; label: string; icon: typeof ListChecks; disabled?: boolean }> = [
    { id: "form", label: "Cases", icon: ListChecks },
    { id: "datasets", label: "Datasets", icon: Database },
    { id: "json", label: "JSON", icon: Code2 },
    { id: "yaml", label: "YAML", icon: FileText, disabled: !saved },
  ];

  return (
    <section aria-label="Suite editor" className="rounded-lg border border-border/40 bg-card/80" data-testid="suite-editor">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border/40 px-4 py-3">
        <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} aria-label="Suite name" className="h-8 min-w-0 flex-1 text-xs font-medium" />
        <ModeSelect value={draft.defaultMode} onChange={(m) => setDraft({ ...draft, defaultMode: m ?? "all" })} />
        <Button size="sm" disabled={saving} onClick={saveCurrent} data-testid="suite-save">
          {saving ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Save className="mr-1 h-3.5 w-3.5" />} Save
        </Button>
        <Button variant="ghost" size="sm" onClick={onClose}>Close</Button>
      </header>
      <nav className="flex gap-1 overflow-x-auto border-b border-border/40 px-3 py-1.5" aria-label="Editor views">
        {views.map((v) => (
          <Button key={v.id} variant={view === v.id ? "secondary" : "ghost"} size="sm" className="h-7" disabled={v.disabled} aria-pressed={view === v.id}
            onClick={() => { if (view === "json" && v.id !== "json") { try { setDraft(JSON.parse(jsonText) as Draft); } catch { /* keep the form's */ } } setView(v.id); }}
            title={v.disabled ? "Save the suite first" : undefined} data-testid={`suite-view-${v.id}`}>
            <v.icon className="mr-1 h-3.5 w-3.5" /> {v.label}
          </Button>
        ))}
      </nav>
      {view === "form" && (
        <>
          <ul>
            {cases.map((c, i) => (
              <CaseForm key={`${i}-${c.id ?? ""}`} value={c} defaultMode={draft.defaultMode ?? "all"} datasets={(draft.datasets ?? []).map((d, j) => ({ id: d.id ?? `dataset-${j}`, name: d.name }))}
                onChange={(n) => setDraft({ ...draft, cases: cases.map((x, j) => (j === i ? n : x)) })}
                onRemove={() => setDraft({ ...draft, cases: cases.filter((_, j) => j !== i) })} />
            ))}
          </ul>
          <div className="px-4 py-3">
            <Button variant="outline" size="sm" onClick={() => setDraft({ ...draft, cases: [...cases, blankCase(cases.length + 1)] })} data-testid="suite-add-case">
              <Plus className="mr-1 h-3.5 w-3.5" /> Case
            </Button>
          </div>
        </>
      )}
      {view === "datasets" && <DatasetsView draft={draft} setDraft={setDraft} saved={saved} suites={suites} />}
      {view === "json" && (
        <div className="px-4 py-3">
          <Textarea value={jsonText} onChange={(e) => setJsonText(e.target.value)} rows={18} aria-label="Suite JSON" className="font-mono text-caption" data-testid="suite-json" />
        </div>
      )}
      {view === "yaml" && (
        <div className="px-4 py-3">
          {yamlText === null
            ? <div className="flex justify-center py-6"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>
            : <Textarea value={yamlText} onChange={(e) => setYamlText(e.target.value)} rows={18} aria-label="Suite YAML" className="font-mono text-caption" data-testid="suite-yaml" />}
        </div>
      )}
    </section>
  );
}
