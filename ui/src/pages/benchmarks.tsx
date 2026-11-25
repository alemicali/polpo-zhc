/**
 * Benchmarks (agent suites phase 5; docs/agent-suites.md, "Benchmarks"): one or more suites × N
 * variants (any agent, a version, overrides) × R repetitions, compared — the leaderboard with its
 * weights and Pareto front, the case × variant matrix, a case side by side. Opened from the agents
 * area, an agent's Suites tab (?new=1&agent=&suite=) or a link to a run (?run=).
 */
import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { Gauge, History, Loader2, MessagesSquare, Pencil, Play, Plus, Trash2 } from "lucide-react";
import { useAgents, useBenchmarks, type BenchmarkDefinition, type BenchmarkInput } from "@polpo-ai/react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { BenchmarkEditor } from "@/components/benchmarks/benchmark-editor";
import { BenchmarkRunDialog, type BenchmarkRef } from "@/components/benchmarks/benchmark-run-dialog";
import { BenchmarkRunView } from "@/components/benchmarks/benchmark-run-view";
import { formatUsd } from "@/lib/agent-suites";
import { benchmarkIsLive, blankBenchmark } from "@/lib/benchmarks";
import { cn } from "@/lib/utils";

function when(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function editable(d: BenchmarkDefinition): BenchmarkInput {
  const { createdAt: _c, updatedAt: _u, updatedBy: _b, ...rest } = d;
  return rest;
}

export function BenchmarksPage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const { agents } = useAgents();
  const bench = useBenchmarks();
  const fromSuite = params.get("new") ? { ...(params.get("agent") ? { agent: params.get("agent")! } : {}), ...(params.get("suite") ? { suite: params.get("suite")! } : {}) } : null;
  const [editing, setEditing] = useState<{ initial: BenchmarkInput; id?: string; revision?: number; key: number } | null>(fromSuite ? { initial: blankBenchmark(fromSuite), key: Date.now() } : null);
  const [running, setRunning] = useState<(BenchmarkRef & { name: string; budget?: number }) | null>(null);
  const [deleting, setDeleting] = useState<BenchmarkDefinition | null>(null);
  const [saving, setSaving] = useState(false);
  const viewing = params.get("run");
  const open = (runId: string | null) => {
    const next = new URLSearchParams(params);
    next.delete("new"); next.delete("agent"); next.delete("suite");
    if (runId) next.set("run", runId); else next.delete("run");
    setParams(next, { replace: true });
  };

  const save = async (b: BenchmarkInput) => {
    setSaving(true);
    try {
      const saved = await bench.save(b, { ...(editing?.id ? { id: editing.id } : {}), ...(editing?.revision !== undefined ? { revision: editing.revision } : {}) });
      toast.success(`Saved ${saved.name}`);
      setEditing({ initial: editable(saved), id: saved.id, revision: saved.revision, key: Date.now() });
    } catch (e) { toast.error((e as Error).message); } finally { setSaving(false); }
  };

  return (
    <div className="flex flex-1 flex-col gap-4 pb-bottom-nav lg:pb-4" data-testid="benchmarks-page">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5 text-sm font-medium"><Gauge className="h-4 w-4 text-muted-foreground" /> Benchmarks</p>
          <p className="text-caption text-muted-foreground">Run suites against several variants — agents, versions, models, instructions — and compare quality, cost and latency.</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => navigate("/playground")}><MessagesSquare className="mr-1 h-3.5 w-3.5" /> Playground</Button>
        <Button size="sm" onClick={() => setEditing({ initial: blankBenchmark(), key: Date.now() })} data-testid="bench-new"><Plus className="mr-1 h-3.5 w-3.5" /> New benchmark</Button>
      </div>

      {editing && (
        <BenchmarkEditor key={editing.key} initial={editing.initial} agents={agents} saving={saving}
          onSave={(b) => void save(b)}
          onRun={(b) => setRunning({ benchmark: b, name: b.name, ...(b.budgetUsd !== undefined ? { budget: b.budgetUsd } : {}) })}
          onClose={() => { setEditing(null); open(viewing); }} />
      )}

      <section aria-label="Saved benchmarks" className="rounded-lg border border-border/40 bg-card/80">
        <header className="border-b border-border/40 px-4 py-2 text-xs font-medium">Saved benchmarks</header>
        {bench.error && <p className="px-4 py-3 text-caption text-destructive">{bench.error.message}</p>}
        {bench.isLoading ? <div className="flex justify-center py-6"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>
          : !bench.benchmarks?.length ? <p className="px-4 py-6 text-center text-sm text-muted-foreground">No benchmarks yet. Start one from a suite (Agents → Suites → Benchmark) or with New benchmark.</p>
            : (
              <ul>
                {bench.benchmarks.map((b) => (
                  <li key={b.id} className="flex min-w-0 items-center gap-3 border-b border-border/40 px-4 py-2 last:border-b-0" data-testid="bench-row" data-benchmark={b.id}>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-medium">{b.name}</p>
                      <p className="truncate text-caption text-muted-foreground">
                        {b.suites.map((s) => `${s.agent}/${s.suite}${s.dataset ? ` (${s.dataset})` : ""}`).join(", ")} · {b.variants.length} variant(s): {b.variants.map((v) => v.label ?? v.id).join(", ")} · ×{b.repetitions}
                        {b.mode ? ` · mode ${b.mode}` : ""}{b.budgetUsd !== undefined ? ` · cap ${formatUsd(b.budgetUsd)}` : ""}
                      </p>
                    </div>
                    <Button variant="ghost" size="sm" className="h-7" aria-label={`Edit ${b.name}`} onClick={() => setEditing({ initial: editable(b), id: b.id, revision: b.revision, key: Date.now() })}><Pencil className="h-3.5 w-3.5" /></Button>
                    <Button variant="ghost" size="sm" className="h-7" aria-label={`Delete ${b.name}`} onClick={() => setDeleting(b)}><Trash2 className="h-3.5 w-3.5" /></Button>
                    <Button variant="outline" size="sm" className="h-7" onClick={() => setRunning({ benchmarkId: b.id, name: b.name, ...(b.budgetUsd !== undefined ? { budget: b.budgetUsd } : {}) })} data-testid="bench-run-open">
                      <Play className="mr-1 h-3.5 w-3.5" /> Run
                    </Button>
                  </li>
                ))}
              </ul>
            )}
      </section>

      {viewing && <BenchmarkRunView key={viewing} runId={viewing} onClose={() => open(null)} />}

      <section aria-label="Benchmark runs" className="rounded-lg border border-border/40 bg-card/80" data-testid="bench-runs">
        <header className="flex items-center gap-2 border-b border-border/40 px-4 py-2"><History className="h-3.5 w-3.5 text-muted-foreground" /><span className="text-xs font-medium">Runs</span></header>
        {!bench.runs?.length ? <p className="px-4 py-6 text-center text-sm text-muted-foreground">No benchmark runs yet</p> : (
          <ul>
            {bench.runs.map((r) => (
              <li key={r.id} className="border-b border-border/40 last:border-b-0">
                <button type="button" onClick={() => open(viewing === r.id ? null : r.id)} aria-pressed={viewing === r.id}
                  className={cn("flex w-full min-w-0 items-center gap-3 px-4 py-2 text-left hover:bg-accent/40", viewing === r.id && "bg-accent/40")} data-testid="bench-run-row">
                  {benchmarkIsLive(r) ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" /> : <span className="h-3.5 w-3.5 shrink-0" />}
                  <span className="hidden text-xs sm:inline">{when(r.startedAt)}</span>
                  <Badge variant="outline" className="text-micro">{r.status}{r.stopReason === "budget" ? " · budget cap" : ""}</Badge>
                  <span className="min-w-0 flex-1 truncate text-caption text-muted-foreground">
                    {r.name} · {r.progress.runsDone}/{r.progress.runsTotal} runs · {formatUsd(r.spentUsd)}{r.leaderboard?.entries[0] ? ` · best: ${r.leaderboard.entries[0].label}` : ""}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {running && (
        <BenchmarkRunDialog target={running} {...(running.budget !== undefined ? { defaultBudget: running.budget } : {})} estimate={bench.estimate}
          onStart={async (ref, opts) => {
            const run = await bench.run(ref, { ...opts, source: "benchmarks" });
            setRunning(null);
            setEditing(null);
            open(run.id);
          }}
          onClose={() => setRunning(null)} />
      )}

      <ConfirmDialog open={deleting !== null} onOpenChange={(o) => { if (!o) setDeleting(null); }}
        title={`Delete ${deleting?.name ?? ""}?`} description="The benchmark is deleted; its past runs stay in the list." confirmLabel="Delete" destructive
        onConfirm={() => { const d = deleting; setDeleting(null); if (d) void bench.remove(d.id).catch((e) => toast.error((e as Error).message)); }} />
    </div>
  );
}
