/**
 * Before a benchmark runs: its cost estimate (per suite and variant: the cases, those on a real
 * model, the judges, how it was priced), a budget cap, and the confirmations — the cost when a real
 * model is called (offline benchmarks are free and need none), real tools when a run would use them.
 */
import { useEffect, useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import type { BenchmarkEstimate, BenchmarkInput } from "@polpo-ai/react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { formatUsd } from "@/lib/agent-suites";

export type BenchmarkRef = { benchmarkId?: string; benchmark?: BenchmarkInput };

export function BenchmarkRunDialog({ target, defaultBudget, estimate, onStart, onClose }: {
  target: BenchmarkRef & { name: string };
  defaultBudget?: number;
  estimate: (ref: BenchmarkRef) => Promise<BenchmarkEstimate>;
  onStart: (ref: BenchmarkRef, opts: { confirm: boolean; allowRealTools: boolean; budgetUsd?: number }) => Promise<void>;
  onClose: () => void;
}) {
  const [est, setEst] = useState<BenchmarkEstimate | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [costOk, setCostOk] = useState(false);
  const [realOk, setRealOk] = useState(false);
  const [budget, setBudget] = useState<string>(defaultBudget !== undefined ? String(defaultBudget) : "");
  const [starting, setStarting] = useState(false);
  useEffect(() => {
    let alive = true;
    estimate({ ...(target.benchmarkId ? { benchmarkId: target.benchmarkId } : {}), ...(target.benchmark ? { benchmark: target.benchmark } : {}) })
      .then((e) => { if (alive) setEst(e); })
      .catch((e) => { if (alive) setError((e as Error).message); });
    return () => { alive = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const budgetUsd = budget.trim() === "" ? undefined : Number(budget);
  const overBudget = est && budgetUsd !== undefined && est.costUsd > budgetUsd;
  const can = !!est && (est.offline || costOk) && (!est.realTools || realOk) && !overBudget && !starting;
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-xl" data-testid="bench-run-dialog">
        <DialogHeader>
          <DialogTitle>Run {target.name}</DialogTitle>
          <DialogDescription>Each suite × variant × repetition runs as a suite run, two at a time on this instance.</DialogDescription>
        </DialogHeader>
        {error ? <p className="text-caption text-destructive">{error}</p> : !est ? (
          <div className="flex justify-center py-4"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>
        ) : (
          <div className="space-y-3 text-caption">
            <p data-testid="bench-estimate">
              {est.runs} run(s) · {est.cases} case run(s) · {est.realModelCases} on a real model ·{" "}
              {est.offline ? <span className="font-medium text-success">offline: free</span> : <span className="font-medium">about {formatUsd(est.costUsd)} (up to {formatUsd(est.maxCostUsd)})</span>}
            </p>
            {est.cells.length > 0 && (
              <div className="max-h-48 overflow-auto">
                <table className="w-full">
                  <thead><tr className="text-left text-muted-foreground"><th className="py-0.5 font-medium">Suite</th><th className="py-0.5 font-medium">Variant</th><th className="py-0.5 font-medium">Real model</th><th className="py-0.5 font-medium">Cost</th><th className="py-0.5 font-medium">From</th></tr></thead>
                  <tbody>
                    {est.cells.map((c, i) => (
                      <tr key={i} className="border-t border-border/30">
                        <td className="py-0.5">{c.owner}/{c.suite}</td>
                        <td className="py-0.5">{c.variantId}</td>
                        <td className="py-0.5">{c.realModelCases}/{c.cases}{c.judgeCalls ? ` · ${c.judgeCalls} judge` : ""}</td>
                        <td className="py-0.5 font-mono">{formatUsd(c.costUsd)}</td>
                        <td className="py-0.5 text-muted-foreground">{c.basis}{c.model ? ` · ${c.model}` : ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {est.notes.map((n, i) => <p key={i} className="text-muted-foreground">{n}</p>)}
            <label className="flex items-center gap-2">
              <span className="text-muted-foreground">Budget cap (USD)</span>
              <Input className="h-8 w-28" type="number" min={0} step={0.5} value={budget} onChange={(e) => setBudget(e.target.value)} placeholder="none" aria-label="Budget cap" />
              <span className="text-muted-foreground">it stops once spent</span>
            </label>
            {overBudget && <p className="text-destructive">The estimate is above the cap: raise it, or run fewer variants or repetitions.</p>}
            {!est.offline && (
              <label className="flex items-start gap-2">
                <Checkbox checked={costOk} onCheckedChange={(v) => setCostOk(v === true)} data-testid="bench-confirm-cost" />
                <span>Real models cost money: I accept about {formatUsd(est.costUsd)}{est.unknownPrice ? " (plus models with no known price)" : ""}.</span>
              </label>
            )}
            {est.realTools && (
              <label className="flex items-start gap-2 text-warning">
                <Checkbox checked={realOk} onCheckedChange={(v) => setRealOk(v === true)} data-testid="bench-confirm-real" />
                <span><AlertTriangle className="mr-1 inline h-3 w-3" />Some runs use real tools: they may send, write or spend. Approvals are never given by a test.</span>
              </label>
            )}
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button disabled={!can} data-testid="bench-start"
            onClick={() => {
              setStarting(true);
              void onStart({ ...(target.benchmarkId ? { benchmarkId: target.benchmarkId } : {}), ...(target.benchmark ? { benchmark: target.benchmark } : {}) },
                { confirm: !est?.offline, allowRealTools: !!est?.realTools, ...(budgetUsd !== undefined ? { budgetUsd } : {}) })
                .catch((e) => setError((e as Error).message)).finally(() => setStarting(false));
            }}>
            {starting && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />} Start
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
