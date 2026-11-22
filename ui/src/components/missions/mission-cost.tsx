/**
 * What a mission cost — every recorded run of its tasks, retries and continuations included — and
 * its budget.
 *
 * - MissionCostButton: the mission header's total, with the budget bar (warning near it,
 *   destructive over it); it opens the breakdown by engine (with their marks) and by agent, and
 *   the budget editor.
 * - MissionBudgetBanner: a mission its budget paused, and how to let it go on.
 * - MissionCostBadge: the compact cost in the missions list.
 */
import { useEffect, useState } from "react";
import { AlertTriangle, Coins, Loader2 } from "lucide-react";
import type { MissionCost, MissionCostSummary } from "@polpo-ai/react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Progress } from "@/components/ui/progress";
import { BrandIcon } from "@/components/shared/brand-icon";
import { engineBrand, engineLabel, formatUsd } from "@/lib/run-context";
import { budgetPct, budgetTone, formatTokens, parseBudgetInput, TONE_BAR, TONE_TEXT } from "@/lib/mission-cost";
import { cn } from "@/lib/utils";

/** The compact cost for lists: "$1.24", or "$1.24 / $5" with the budget's tone. */
export function MissionCostBadge({ cost, budgetUsd, className }: { cost: MissionCostSummary | undefined; budgetUsd?: number; className?: string }) {
  const budget = cost?.budgetUsd ?? budgetUsd;
  if (!cost?.runs && budget === undefined) return null;
  const usd = cost?.usd ?? 0;
  const tone = budgetTone(usd, budget);
  const title = `Cost so far: ${formatUsd(usd)}${cost?.partial ? " (partial: older runs dropped)" : ""}${budget !== undefined ? ` of a ${formatUsd(budget)} budget` : ""}`;
  return (
    <span
      className={cn("inline-flex shrink-0 items-center gap-1 tabular-nums text-caption", tone ? TONE_TEXT[tone] : "text-muted-foreground", className)}
      title={title}
      data-testid="mission-cost-badge"
      data-tone={tone ?? "none"}
    >
      <Coins className="h-3 w-3" />
      {formatUsd(usd)}{cost?.partial ? "+" : ""}
      {budget !== undefined && <span className="text-muted-foreground">/ {formatUsd(budget)}</span>}
    </span>
  );
}

function Row({ icon, label, cost, total }: { icon?: React.ReactNode; label: string; cost: { usd: number; runs: number; tokens: number }; total: number }) {
  const share = total > 0 ? Math.round((cost.usd / total) * 100) : 0;
  return (
    <li className="flex min-w-0 items-center gap-2 text-small">
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="shrink-0 text-caption text-muted-foreground">{cost.runs} run{cost.runs === 1 ? "" : "s"}{formatTokens(cost.tokens) ? ` · ${formatTokens(cost.tokens)}` : ""}</span>
      <span className="w-16 shrink-0 text-right font-medium tabular-nums">{formatUsd(cost.usd)}</span>
      <span className="w-9 shrink-0 text-right text-caption tabular-nums text-muted-foreground">{share}%</span>
    </li>
  );
}

function BudgetEditor({ budgetUsd, onSave }: { budgetUsd?: number; onSave: (budgetUsd: number | null) => Promise<unknown> }) {
  const [value, setValue] = useState(budgetUsd !== undefined ? String(budgetUsd) : "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setValue(budgetUsd !== undefined ? String(budgetUsd) : ""); }, [budgetUsd]);
  const parsed = parseBudgetInput(value);
  const dirty = value.trim() === "" ? budgetUsd !== undefined : parsed !== budgetUsd;
  const save = async (next: number | null) => {
    setSaving(true);
    setError(null);
    try { await onSave(next); } catch (e) { setError((e as Error).message); } finally { setSaving(false); }
  };
  return (
    <form
      className="space-y-1.5"
      onSubmit={(e) => { e.preventDefault(); if (value.trim() === "") void save(null); else if (parsed !== undefined) void save(parsed); }}
      data-testid="mission-budget-editor"
    >
      <label htmlFor="mission-budget" className="text-label text-muted-foreground">Budget (USD)</label>
      <div className="flex items-center gap-1.5">
        <Input
          id="mission-budget"
          inputMode="decimal"
          placeholder="No limit"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="h-8"
          aria-invalid={value.trim() !== "" && parsed === undefined}
        />
        <Button type="submit" size="sm" disabled={saving || !dirty || (value.trim() !== "" && parsed === undefined)}>
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Save"}
        </Button>
        {budgetUsd !== undefined && (
          <Button type="button" size="sm" variant="ghost" disabled={saving} onClick={() => void save(null)}>Clear</Button>
        )}
      </div>
      <p className="text-caption text-muted-foreground">
        When its tasks have spent it, no new task starts (running ones finish) and the mission pauses. Raise or clear it to go on.
      </p>
      {error && <p className="text-caption text-destructive">{error}</p>}
    </form>
  );
}

/** The mission header's cost, with its breakdown and the budget editor. */
export function MissionCostButton({
  cost, budgetUsd, loading, onSaveBudget, className,
}: {
  cost: MissionCost | undefined;
  budgetUsd?: number;
  loading?: boolean;
  onSaveBudget?: (budgetUsd: number | null) => Promise<unknown>;
  className?: string;
}) {
  const budget = cost?.budgetUsd ?? budgetUsd;
  const usd = cost?.usd ?? 0;
  const tone = budgetTone(usd, budget);
  const pct = budgetPct(usd, budget);
  const total = cost?.usd ?? 0;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn("flex items-center gap-2 rounded-control border border-border bg-card px-2.5 py-1 text-left hover:bg-accent/30", className)}
          data-testid="mission-cost"
          data-tone={tone ?? "none"}
          aria-label="Mission cost and budget"
        >
          <Coins className={cn("h-3.5 w-3.5", tone ? TONE_TEXT[tone] : "text-muted-foreground")} />
          <span className="flex flex-col">
            <span className={cn("text-small font-medium tabular-nums", tone && TONE_TEXT[tone])} data-testid="mission-cost-total">
              {loading && !cost ? "…" : formatUsd(usd)}{cost?.partial ? "+" : ""}
              {budget !== undefined && <span className="font-normal text-muted-foreground"> of {formatUsd(budget)}</span>}
            </span>
            {pct !== undefined && (
              <Progress value={pct} className={cn("mt-0.5 h-1 w-24", tone && TONE_BAR[tone])} aria-label="Budget used" data-testid="mission-budget-bar" />
            )}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 space-y-3" data-testid="mission-cost-breakdown">
        <div className="space-y-0.5">
          <p className="text-label text-muted-foreground">Cost so far</p>
          <p className={cn("text-h3 font-heading tabular-nums", tone && TONE_TEXT[tone])}>
            {formatUsd(usd)}{budget !== undefined && <span className="text-small font-normal text-muted-foreground"> of {formatUsd(budget)} ({Math.round((usd / budget) * 100)}%)</span>}
          </p>
          {cost && (
            <p className="text-caption text-muted-foreground">
              {cost.runs} run{cost.runs === 1 ? "" : "s"} over {cost.tasks} task{cost.tasks === 1 ? "" : "s"}, retries and continuations included
              {formatTokens(cost.tokens) ? ` · ${formatTokens(cost.tokens)} tokens` : ""}
            </p>
          )}
          {cost && (cost.harnessUsd > 0 || cost.modelUsd > 0) && (
            <p className="text-caption text-muted-foreground" data-testid="mission-cost-split">
              {cost.harnessUsd > 0 && <>Harness estimate {formatUsd(cost.harnessUsd)}</>}
              {cost.harnessUsd > 0 && cost.modelUsd > 0 && " · "}
              {cost.modelUsd > 0 && <>Model cost {formatUsd(cost.modelUsd)}</>}
            </p>
          )}
        </div>

        {cost && cost.byEngine.length > 0 && (
          <div className="space-y-1">
            <p className="text-label text-muted-foreground">By engine</p>
            <ul className="space-y-1" data-testid="mission-cost-by-engine">
              {cost.byEngine.map((e) => (
                <Row key={e.engine} icon={<BrandIcon name={engineBrand(e.engine)} size={14} />} label={engineLabel(e.engine)} cost={e} total={total} />
              ))}
            </ul>
          </div>
        )}
        {cost && cost.byAgent.length > 0 && (
          <div className="space-y-1">
            <p className="text-label text-muted-foreground">By agent</p>
            <ul className="space-y-1" data-testid="mission-cost-by-agent">
              {cost.byAgent.map((a) => <Row key={a.agent} label={a.agent} cost={a} total={total} />)}
            </ul>
          </div>
        )}
        {cost && cost.runs === 0 && <p className="text-small text-muted-foreground">No run yet.</p>}

        {(cost?.partial || (cost?.unpricedRuns ?? 0) > 0 || cost?.agentBudgetCapUsd !== undefined) && (
          <ul className="space-y-0.5 text-caption text-muted-foreground">
            {cost?.partial && <li className="text-warning">Partial: some tasks keep only their latest 20 runs, so the total may be higher.</li>}
            {(cost?.unpricedRuns ?? 0) > 0 && <li>{cost!.unpricedRuns} run{cost!.unpricedRuns === 1 ? "" : "s"} reported no cost (yet).</li>}
            {cost?.agentBudgetCapUsd !== undefined && (
              <li>No budget: the agents' harness budgets cap one run of each task at {formatUsd(cost.agentBudgetCapUsd)}.</li>
            )}
          </ul>
        )}

        {onSaveBudget && (
          <div className="border-t pt-3">
            <BudgetEditor budgetUsd={budget} onSave={onSaveBudget} />
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

/** A mission its budget paused. */
export function MissionBudgetBanner({ cost, budgetUsd }: { cost: MissionCostSummary | undefined; budgetUsd?: number }) {
  const budget = cost?.budgetUsd ?? budgetUsd;
  return (
    <div className="flex shrink-0 items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-2.5 text-small" role="status" data-testid="mission-budget-banner">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
      <div className="min-w-0">
        <p className="font-medium text-destructive">
          Paused: over budget{cost ? ` (${formatUsd(cost.usd)} spent${budget !== undefined ? ` of ${formatUsd(budget)}` : ""})` : ""}
        </p>
        <p className="text-muted-foreground">No new task starts; running ones finish. Raise or clear the budget and the mission goes on by itself.</p>
      </div>
      <Badge variant="outline" className="ml-auto shrink-0 border-destructive/30 text-micro text-destructive">budget</Badge>
    </div>
  );
}
