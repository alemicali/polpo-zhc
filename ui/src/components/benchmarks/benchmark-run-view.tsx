/**
 * A benchmark run: progress and spend (Cancel while it runs), the leaderboard with its weights
 * (quality vs cost vs latency) and the Pareto front, a quality × cost chart, the statistical notes,
 * per-variant details (pass rate and score ± stddev over repetitions, scorers, latency, tokens,
 * flakiness), and the case × variant matrix whose cells open the case side by side.
 */
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Ban, Diamond, Gauge, Loader2, Trophy } from "lucide-react";
import { CartesianGrid, Scatter, ScatterChart, XAxis, YAxis, ZAxis, LabelList } from "recharts";
import { useBenchmarkRun, type BenchmarkReport } from "@polpo-ai/react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Progress } from "@/components/ui/progress";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { formatMs, formatScore, formatUsd } from "@/lib/agent-suites";
import { CELL_STYLE, DEFAULT_WEIGHTS, benchmarkIsLive, formatPct, paretoPoints, variantText } from "@/lib/benchmarks";
import { cn } from "@/lib/utils";
import { BenchmarkSideBySide } from "./benchmark-side-by-side";

const chartConfig = {
  front: { label: "Pareto front", color: "var(--chart-1)" },
  other: { label: "Dominated", color: "var(--chart-3)" },
} satisfies ChartConfig;

function WeightInput({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <label className="flex items-center gap-2 text-caption">
      <span className="w-14 text-muted-foreground">{label}</span>
      <input type="range" min={0} max={1} step={0.05} value={value} onChange={(e) => onChange(Number(e.target.value))} aria-label={`${label} weight`} className="h-1.5 w-24 accent-primary" data-testid={`bench-weight-${label.toLowerCase()}`} />
      <span className="w-8 font-mono">{value.toFixed(2)}</span>
    </label>
  );
}

export function BenchmarkRunView({ runId, onClose }: { runId: string; onClose?: () => void }) {
  const [weights, setWeights] = useState<{ quality: number; cost: number; latency: number } | null>(null);
  const { report, isLoading, error, cancel, compare } = useBenchmarkRun(runId, weights ?? undefined);
  if (isLoading && !report) return <div className="flex justify-center py-6"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>;
  if (error && !report) return <p className="px-4 py-3 text-caption text-destructive">{error.message}</p>;
  if (!report) return null;
  return <BenchmarkReportView report={report} weights={weights ?? report.leaderboard.weights} onWeights={setWeights} onCancel={() => cancel().then(() => undefined)} compare={compare} {...(onClose ? { onClose } : {})} />;
}

export function BenchmarkReportView({ report, weights, onWeights, onCancel, compare, onClose }: {
  report: BenchmarkReport;
  weights: { quality: number; cost: number; latency: number };
  onWeights: (w: { quality: number; cost: number; latency: number }) => void;
  onCancel: () => Promise<void>;
  compare: (caseKey: string, opts?: { variants?: string[] }) => Promise<import("@polpo-ai/react").BenchmarkCaseComparison>;
  onClose?: () => void;
}) {
  const { run, stats, leaderboard, matrix } = report;
  const live = benchmarkIsLive(run);
  const [picked, setPicked] = useState<string[]>(() => matrix.variants.slice(0, 2).map((v) => v.id));
  const [opened, setOpened] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const pct = run.progress.casesTotal ? Math.round((run.progress.casesDone / run.progress.casesTotal) * 100) : 0;
  const points = useMemo(() => paretoPoints(leaderboard.entries), [leaderboard.entries]);
  const toggle = (id: string) => setPicked((p) => p.includes(id) ? p.filter((x) => x !== id) : p.length >= 4 ? p : [...p, id]);
  const metric = leaderboard.qualityMetric === "score" ? "Score" : "Pass rate";

  return (
    <div className="space-y-4" data-testid="bench-run" data-status={run.status}>
      <section aria-label="Benchmark run" className="rounded-lg border border-border/40 bg-card/80">
        <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border/40 px-4 py-3">
          <Gauge className="h-3.5 w-3.5 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <p className="flex items-center gap-1.5 truncate text-xs font-medium">
              {run.name}
              <Badge variant="outline" className={cn("text-micro", run.status === "completed" ? "text-success" : live ? "text-info" : "text-warning")} data-testid="bench-run-status">
                {run.status}{run.stopReason ? ` · ${run.stopReason === "budget" ? "budget cap" : run.stopReason}` : ""}
              </Badge>
            </p>
            <p className="text-caption text-muted-foreground">
              {run.spec.suites.length} suite(s) × {run.spec.variants.length} variant(s) × {run.spec.repetitions} repetition(s) · {run.progress.runsDone}/{run.progress.runsTotal} runs · {run.progress.casesDone}/{run.progress.casesTotal} cases
              {" · "}spent {formatUsd(run.spentUsd)}{run.budgetUsd !== undefined ? ` of ${formatUsd(run.budgetUsd)}` : ""} · estimate {formatUsd(run.estimate.costUsd)}
            </p>
          </div>
          {live && (
            <Button variant="outline" size="sm" disabled={cancelling} data-testid="bench-cancel"
              onClick={() => { setCancelling(true); void onCancel().catch((e) => toast.error((e as Error).message)).finally(() => setCancelling(false)); }}>
              {cancelling ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Ban className="mr-1 h-3.5 w-3.5" />} Cancel
            </Button>
          )}
          {onClose && <Button variant="ghost" size="sm" onClick={onClose}>Close</Button>}
        </header>
        {live && <div className="px-4 pt-3"><Progress value={pct} aria-label="Progress" /></div>}
        {(run.notes.length > 0 || run.error) && (
          <ul className="px-4 pt-2 text-caption text-muted-foreground">
            {run.error && <li className="text-destructive">{run.error}</li>}
            {run.notes.map((n, i) => <li key={i}>{n}</li>)}
          </ul>
        )}

        <div className="space-y-3 border-b border-border/40 px-4 py-3" data-testid="bench-leaderboard">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <p className="flex items-center gap-1.5 text-micro font-medium uppercase tracking-label text-muted-foreground"><Trophy className="h-3 w-3" /> Leaderboard</p>
            <WeightInput label="Quality" value={weights.quality} onChange={(v) => onWeights({ ...weights, quality: v })} />
            <WeightInput label="Cost" value={weights.cost} onChange={(v) => onWeights({ ...weights, cost: v })} />
            <WeightInput label="Latency" value={weights.latency} onChange={(v) => onWeights({ ...weights, latency: v })} />
            <Button variant="ghost" size="sm" className="h-6 text-caption" onClick={() => onWeights(DEFAULT_WEIGHTS)}>Reset</Button>
          </div>
          {leaderboard.entries.length ? (
            <div className="overflow-x-auto">
              <table className="w-full text-caption">
                <thead>
                  <tr className="text-left text-muted-foreground">
                    <th className="py-1 font-medium">#</th>
                    <th className="py-1 font-medium">Variant</th>
                    <th className="py-1 font-medium">{metric}</th>
                    <th className="py-1 font-medium">Pass rate</th>
                    <th className="py-1 font-medium">Cost / rep</th>
                    <th className="hidden py-1 font-medium sm:table-cell">p50 / p95</th>
                    <th className="hidden py-1 font-medium md:table-cell">Flaky</th>
                    <th className="py-1 font-medium">Composite</th>
                  </tr>
                </thead>
                <tbody>
                  {leaderboard.entries.map((e) => (
                    <tr key={e.variantId} className={cn("border-t border-border/30", e.rank === 1 && "font-medium")} data-testid="bench-lb-row" data-variant={e.variantId} data-pareto={e.pareto}>
                      <td className="py-1 font-mono">{e.rank}</td>
                      <td className="py-1">
                        <span className="inline-flex items-center gap-1">{e.label}{e.pareto && <Diamond className="h-3 w-3 fill-current text-info" aria-label="Pareto front" />}</span>
                      </td>
                      <td className="py-1 font-mono">{formatScore(e.quality)} <span className="text-muted-foreground">± {formatScore(e.qualityStddev)}</span></td>
                      <td className="py-1">{formatPct(e.passRate)}</td>
                      <td className="py-1 font-mono">{formatUsd(e.costUsd)}</td>
                      <td className="hidden py-1 font-mono sm:table-cell">{formatMs(e.latencyP50Ms)} / {formatMs(e.latencyP95Ms)}</td>
                      <td className="hidden py-1 md:table-cell">{e.flakiness ? <span className="text-warning">{formatPct(e.flakiness)}</span> : "—"}</td>
                      <td className="py-1">
                        <span className="flex items-center gap-2">
                          <span className="h-1.5 w-16 overflow-hidden rounded-pill bg-muted"><span className="block h-full bg-primary" style={{ width: `${Math.round(Math.min(1, Math.max(0, e.composite)) * 100)}%` }} /></span>
                          <span className="font-mono">{e.composite.toFixed(3)}</span>
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <p className="text-caption text-muted-foreground">{live ? "Results appear as the runs finish." : "No results."}</p>}
          {leaderboard.notes.length > 0 && (
            <ul className="space-y-0.5 text-caption text-muted-foreground" data-testid="bench-notes">
              {leaderboard.notes.map((n, i) => <li key={i}>≈ {n}</li>)}
            </ul>
          )}
          {points.length > 1 && (
            <ChartContainer config={chartConfig} className="aspect-auto h-48 w-full" data-testid="bench-pareto-chart">
              <ScatterChart margin={{ left: 0, right: 16, top: 12, bottom: 0 }}>
                <CartesianGrid />
                <XAxis type="number" dataKey="cost" name="Cost" tickLine={false} axisLine={false} tickFormatter={(v: number) => formatUsd(v)} />
                <YAxis type="number" dataKey="quality" name={metric} domain={[0, 1]} ticks={[0, 0.5, 1]} tickLine={false} axisLine={false} width={28} />
                <ZAxis range={[60, 60]} />
                <ChartTooltip content={<ChartTooltipContent labelFormatter={(_, payload) => (payload?.[0] as { payload?: { label?: string } } | undefined)?.payload?.label ?? ""} />} />
                <Scatter name="Pareto front" data={points.filter((p) => p.pareto)} fill="var(--color-front)" isAnimationActive={false}>
                  <LabelList dataKey="label" position="top" className="fill-foreground text-micro" />
                </Scatter>
                <Scatter name="Dominated" data={points.filter((p) => !p.pareto)} fill="var(--color-other)" isAnimationActive={false}>
                  <LabelList dataKey="label" position="top" className="fill-muted-foreground text-micro" />
                </Scatter>
              </ScatterChart>
            </ChartContainer>
          )}
        </div>

        <div className="space-y-2 border-b border-border/40 px-4 py-3" data-testid="bench-variants">
          <p className="text-micro font-medium uppercase tracking-label text-muted-foreground">Variants</p>
          <ul className="space-y-2">
            {stats.map((s) => (
              <li key={s.variantId} className="text-caption" data-variant={s.variantId}>
                <p className="font-medium text-foreground">{variantText({ ...s, label: s.label })}</p>
                <p className="text-muted-foreground">
                  pass {formatPct(s.passRate.mean)} ± {formatPct(s.passRate.stddev)}{s.score ? ` · score ${formatScore(s.score.mean)} ± ${formatScore(s.score.stddev)}` : ""}
                  {" · "}{formatUsd(s.costUsd.mean)}/rep ({formatUsd(s.costUsd.perCase)}/case) · p50 {formatMs(s.latency.p50Ms)} · p95 {formatMs(s.latency.p95Ms)} · {s.tokens.perCase} tokens/case
                  {" · "}{s.repetitions} rep(s), {s.cases} case(s){s.flakiness ? <span className="text-warning"> · flaky {formatPct(s.flakiness)}</span> : null}{s.errored ? <span className="text-destructive"> · {s.errored} errored</span> : null}
                </p>
                {s.scorers.length > 0 && <p className="text-muted-foreground">{s.scorers.map((x) => `${x.id} ${formatScore(x.mean)} ± ${formatScore(x.stddev)}`).join(" · ")}</p>}
              </li>
            ))}
          </ul>
        </div>

        <div className="space-y-2 px-4 py-3" data-testid="bench-matrix">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <p className="text-micro font-medium uppercase tracking-label text-muted-foreground">Case × variant</p>
            <p className="text-caption text-muted-foreground">Pick 2–4 variants, then a case to see them side by side.</p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-caption">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="py-1 pr-2 font-medium">Case</th>
                  {matrix.variants.map((v) => (
                    <th key={v.id} className="py-1 pr-2 font-medium">
                      <label className="inline-flex items-center gap-1.5">
                        <Checkbox checked={picked.includes(v.id)} onCheckedChange={() => toggle(v.id)} aria-label={`Compare ${v.label}`} data-testid="bench-pick-variant" />
                        {v.label}
                      </label>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {matrix.rows.map((r) => (
                  <tr key={r.key} className={cn("border-t border-border/30", opened === r.key && "bg-accent/40")} data-testid="bench-matrix-row" data-case={r.key} data-spread={r.spread}>
                    <td className="py-1 pr-2">
                      <button type="button" className="text-left hover:underline" onClick={() => setOpened(opened === r.key ? null : r.key)} data-testid="bench-open-case">
                        {r.caseName}{r.row ? ` #${r.row}` : ""}{r.spread ? <span className="ml-1 text-warning" title="The variants disagree">≠</span> : null}
                        <span className="block text-micro text-muted-foreground">{r.suiteName}</span>
                      </button>
                    </td>
                    {matrix.variants.map((v) => {
                      const c = r.cells[v.id];
                      const st = CELL_STYLE[c?.status ?? "missing"];
                      return (
                        <td key={v.id} className="py-1 pr-2">
                          <button type="button" onClick={() => setOpened(r.key)} className={cn("inline-flex min-w-12 items-center justify-center gap-1 rounded-control px-1.5 py-0.5 font-mono", st.className)} data-cell={c?.status ?? "missing"}
                            title={c ? `${c.passed}/${c.attempts} passed · ${formatUsd(c.costUsd)} · ${formatMs(c.durationMs)}` : "no result"}>
                            {st.label}{c && c.attempts > 1 ? ` ${c.passed}/${c.attempts}` : ""}{c?.score !== undefined ? ` ${formatScore(c.score)}` : ""}
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>
      {opened && (
        picked.length < 2
          ? <p className="text-caption text-muted-foreground">Pick at least two variants to compare.</p>
          : <BenchmarkSideBySide load={compare} caseKey={opened} variants={picked} onClose={() => setOpened(null)} />
      )}
    </div>
  );
}
