/**
 * The benchmark editor: its suites (an agent's suite, optionally only the cases of one dataset),
 * its variants (any agent, a version, overrides: model, reasoning, instructions, max turns), the
 * repetitions, the mode, the budget cap. Save it, or run it without saving.
 */
import { useState } from "react";
import { FlaskConical, Plus, Trash2 } from "lucide-react";
import { useAgentSuites, useAgentVersions, type AgentConfig, type BenchmarkInput, type SuiteMockMode } from "@polpo-ai/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SUITE_MODES } from "@/lib/agent-suites";
import { cleanOverrides } from "@/lib/benchmarks";

type SuiteRow = BenchmarkInput["suites"][number];
type VariantRow = BenchmarkInput["variants"][number];

function SuiteRefRow({ row, agents, onChange, onRemove }: { row: SuiteRow; agents: AgentConfig[]; onChange: (r: SuiteRow) => void; onRemove: () => void }) {
  const { suites } = useAgentSuites(row.agent || undefined, { runsLimit: 1 });
  const suite = suites?.find((s) => s.id === row.suite);
  return (
    <li className="flex flex-wrap items-center gap-2" data-testid="bench-suite-row">
      <Select value={row.agent || undefined} onValueChange={(agent) => onChange({ agent, suite: "" })}>
        <SelectTrigger size="sm" className="w-36" aria-label="Suite's agent"><SelectValue placeholder="Agent" /></SelectTrigger>
        <SelectContent>{agents.map((a) => <SelectItem key={a.name} value={a.name}>{a.name}</SelectItem>)}</SelectContent>
      </Select>
      <Select value={row.suite || undefined} onValueChange={(s) => onChange({ agent: row.agent, suite: s })} disabled={!row.agent}>
        <SelectTrigger size="sm" className="w-44" aria-label="Suite"><SelectValue placeholder="Suite" /></SelectTrigger>
        <SelectContent>{(suites ?? []).map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}</SelectContent>
      </Select>
      {suite && suite.datasets.length > 0 && (
        <Select value={row.dataset ?? "all"} onValueChange={(d) => onChange({ agent: row.agent, suite: row.suite, ...(d !== "all" ? { dataset: d } : {}) })}>
          <SelectTrigger size="sm" className="w-44" aria-label="Dataset"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Every case</SelectItem>
            {suite.datasets.map((d) => <SelectItem key={d.id} value={d.id}>Only dataset {d.name}</SelectItem>)}
          </SelectContent>
        </Select>
      )}
      {suite && <span className="text-caption text-muted-foreground">{suite.cases.length} case(s)</span>}
      <Button variant="ghost" size="sm" className="h-7" onClick={onRemove} aria-label="Remove suite"><Trash2 className="h-3.5 w-3.5" /></Button>
    </li>
  );
}

function VariantRowEditor({ row, agents, onChange, onRemove }: { row: VariantRow; agents: AgentConfig[]; onChange: (r: VariantRow) => void; onRemove: () => void }) {
  const versions = useAgentVersions(row.agent || undefined);
  const o = row.overrides ?? {};
  const set = (patch: Partial<NonNullable<VariantRow["overrides"]>>) => onChange({ ...row, overrides: { ...o, ...patch } });
  return (
    <li className="space-y-2 border-t border-border/30 pt-2 first:border-t-0 first:pt-0" data-testid="bench-variant-row">
      <div className="flex flex-wrap items-center gap-2">
        <Input className="h-8 w-36" value={row.label ?? ""} onChange={(e) => onChange({ ...row, label: e.target.value })} placeholder="Label" aria-label="Variant label" />
        <Select value={row.agent || undefined} onValueChange={(agent) => onChange({ ...row, agent })}>
          <SelectTrigger size="sm" className="w-36" aria-label="Variant's agent"><SelectValue placeholder="Agent" /></SelectTrigger>
          <SelectContent>{agents.map((a) => <SelectItem key={a.name} value={a.name}>{a.name}</SelectItem>)}</SelectContent>
        </Select>
        <Select value={row.version ?? "production"} onValueChange={(version) => onChange({ ...row, version })}>
          <SelectTrigger size="sm" className="w-32" aria-label="Version"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="production">Production</SelectItem>
            <SelectItem value="draft">Draft</SelectItem>
            {(versions.data?.versions ?? []).map((v) => <SelectItem key={v.version} value={v.version}>v{v.version}</SelectItem>)}
          </SelectContent>
        </Select>
        <Input className="h-8 w-52" value={o.model ?? ""} onChange={(e) => set({ model: e.target.value })} placeholder="Model (e.g. anthropic:claude-…)" aria-label="Model override" />
        <Select value={o.reasoning ?? "default"} onValueChange={(r) => set({ reasoning: r === "default" ? undefined : r })}>
          <SelectTrigger size="sm" className="w-32" aria-label="Reasoning"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="default">Reasoning: agent's</SelectItem>
            {["off", "minimal", "low", "medium", "high"].map((r) => <SelectItem key={r} value={r}>{r}</SelectItem>)}
          </SelectContent>
        </Select>
        <Input className="h-8 w-24" type="number" min={1} max={200} value={o.maxTurns ?? ""} onChange={(e) => set({ maxTurns: e.target.value ? Number(e.target.value) : undefined })} placeholder="Max turns" aria-label="Max turns" />
        <Button variant="ghost" size="sm" className="h-7" onClick={onRemove} aria-label="Remove variant"><Trash2 className="h-3.5 w-3.5" /></Button>
      </div>
      <Textarea rows={2} className="text-xs" value={o.instructionsAppend ?? ""} onChange={(e) => set({ instructionsAppend: e.target.value })} placeholder="Instructions to append for this variant (optional)" aria-label="Instructions to append" />
    </li>
  );
}

export function BenchmarkEditor({ initial, agents, saving, onSave, onRun, onClose }: {
  initial: BenchmarkInput;
  agents: AgentConfig[];
  saving?: boolean;
  onSave: (b: BenchmarkInput) => void;
  onRun: (b: BenchmarkInput) => void;
  onClose: () => void;
}) {
  const [b, setB] = useState<BenchmarkInput>(initial);
  const clean = (): BenchmarkInput => ({
    ...b,
    suites: b.suites.filter((s) => s.agent && s.suite),
    variants: b.variants.filter((v) => v.agent).map((v) => {
      const overrides = cleanOverrides(v.overrides);
      const { overrides: _o, label, ...rest } = v;
      return { ...rest, ...(label?.trim() ? { label: label.trim() } : {}), ...(overrides ? { overrides } : {}) };
    }),
  });
  const ready = b.name.trim() && b.suites.some((s) => s.agent && s.suite) && b.variants.some((v) => v.agent);
  const firstAgent = agents[0]?.name ?? "";
  return (
    <section aria-label="Benchmark editor" className="rounded-lg border border-border/40 bg-card/80" data-testid="bench-editor">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border/40 px-4 py-3">
        <FlaskConical className="h-3.5 w-3.5 text-muted-foreground" />
        <Input className="h-8 min-w-48 flex-1" value={b.name} onChange={(e) => setB({ ...b, name: e.target.value })} aria-label="Benchmark name" />
        <Button variant="ghost" size="sm" onClick={onClose}>Close</Button>
        <Button variant="outline" size="sm" disabled={!ready || saving} onClick={() => onRun(clean())} data-testid="bench-editor-run">Run without saving</Button>
        <Button size="sm" disabled={!ready || saving} onClick={() => onSave(clean())} data-testid="bench-editor-save">Save</Button>
      </header>
      <div className="space-y-4 px-4 py-3">
        <div className="space-y-2">
          <p className="text-micro font-medium uppercase tracking-label text-muted-foreground">Suites</p>
          <ul className="space-y-2">
            {b.suites.map((s, i) => (
              <SuiteRefRow key={i} row={s} agents={agents}
                onChange={(r) => setB({ ...b, suites: b.suites.map((x, j) => (j === i ? r : x)) })}
                onRemove={() => setB({ ...b, suites: b.suites.filter((_, j) => j !== i) })} />
            ))}
          </ul>
          <Button variant="outline" size="sm" className="h-7" disabled={b.suites.length >= 20} onClick={() => setB({ ...b, suites: [...b.suites, { agent: firstAgent, suite: "" }] })} data-testid="bench-add-suite">
            <Plus className="mr-1 h-3.5 w-3.5" /> Suite
          </Button>
        </div>
        <div className="space-y-2">
          <p className="text-micro font-medium uppercase tracking-label text-muted-foreground">Variants <span className="normal-case tracking-normal">· any agent, a version, overrides for this benchmark only (nothing is saved to the agent)</span></p>
          <ul className="space-y-2">
            {b.variants.map((v, i) => (
              <VariantRowEditor key={i} row={v} agents={agents}
                onChange={(r) => setB({ ...b, variants: b.variants.map((x, j) => (j === i ? r : x)) })}
                onRemove={() => setB({ ...b, variants: b.variants.filter((_, j) => j !== i) })} />
            ))}
          </ul>
          <Button variant="outline" size="sm" className="h-7" disabled={b.variants.length >= 8} onClick={() => setB({ ...b, variants: [...b.variants, { agent: b.variants.at(-1)?.agent ?? firstAgent, version: "production", label: `Variant ${b.variants.length + 1}` }] })} data-testid="bench-add-variant">
            <Plus className="mr-1 h-3.5 w-3.5" /> Variant
          </Button>
        </div>
        <div className="flex flex-wrap items-end gap-4">
          <label className="space-y-1 text-caption">
            <span className="block text-muted-foreground">Repetitions</span>
            <Input className="h-8 w-20" type="number" min={1} max={10} value={b.repetitions ?? 1} onChange={(e) => setB({ ...b, repetitions: Math.max(1, Math.min(10, Number(e.target.value) || 1)) })} aria-label="Repetitions" />
          </label>
          <label className="space-y-1 text-caption">
            <span className="block text-muted-foreground">Mode</span>
            <Select value={b.mode ?? "own"} onValueChange={(m) => setB({ ...b, mode: m === "own" ? undefined : m as SuiteMockMode })}>
              <SelectTrigger size="sm" className="w-48" aria-label="Mode"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="own">Each case's mode</SelectItem>
                {SUITE_MODES.map((m) => <SelectItem key={m.id} value={m.id}>{m.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </label>
          <label className="space-y-1 text-caption">
            <span className="block text-muted-foreground">Cases at once</span>
            <Input className="h-8 w-20" type="number" min={1} max={4} value={b.concurrency ?? 1} onChange={(e) => setB({ ...b, concurrency: Math.max(1, Math.min(4, Number(e.target.value) || 1)) })} aria-label="Cases at once" />
          </label>
          <label className="space-y-1 text-caption">
            <span className="block text-muted-foreground">Budget cap (USD)</span>
            <Input className="h-8 w-28" type="number" min={0} step={0.5} value={b.budgetUsd ?? ""} onChange={(e) => setB({ ...b, budgetUsd: e.target.value === "" ? undefined : Math.max(0, Number(e.target.value)) })} placeholder="none" aria-label="Budget cap" />
          </label>
        </div>
        <p className="text-caption text-muted-foreground">
          Each suite × variant × repetition is a suite run (two at a time on this instance). Mode Contract (offline) is free; a real model costs money: you see an estimate and confirm before it starts.
        </p>
      </div>
    </section>
  );
}
