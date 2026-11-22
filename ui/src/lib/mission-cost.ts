/**
 * What a mission cost (GET /missions/:id → cost; lists → a compact cost) against its budget.
 */
import type { MissionCost, MissionCostSummary } from "@polpo-ai/react";

export type BudgetTone = "ok" | "near" | "over";

/** Spent against budget: "near" from 80%, "over" at 100%. undefined without a budget. */
export function budgetTone(usd: number | undefined, budgetUsd: number | undefined): BudgetTone | undefined {
  if (!budgetUsd || budgetUsd <= 0) return undefined;
  const used = (usd ?? 0) / budgetUsd;
  return used >= 1 ? "over" : used >= 0.8 ? "near" : "ok";
}

/** Percentage of the budget used, capped at 100 for bars. */
export function budgetPct(usd: number | undefined, budgetUsd: number | undefined): number | undefined {
  if (!budgetUsd || budgetUsd <= 0) return undefined;
  return Math.min(100, ((usd ?? 0) / budgetUsd) * 100);
}

export const TONE_TEXT: Record<BudgetTone, string> = {
  ok: "text-foreground",
  near: "text-warning",
  over: "text-destructive",
};

export const TONE_BAR: Record<BudgetTone, string> = {
  ok: "",
  near: "[&>[data-slot=progress-indicator]]:bg-warning",
  over: "[&>[data-slot=progress-indicator]]:bg-destructive",
};

/** The full cost (detail) or undefined when only the compact one is at hand. */
export function fullCost(cost: MissionCost | MissionCostSummary | undefined): MissionCost | undefined {
  return cost && "byAgent" in cost ? cost : undefined;
}

/** A budget typed by a person: a positive number of USD ("$12,50" and "12.5" alike), else undefined. */
export function parseBudgetInput(raw: string): number | undefined {
  const v = Number(raw.trim().replace(/^\$/, "").replace(",", "."));
  return Number.isFinite(v) && v > 0 ? Math.round(v * 100) / 100 : undefined;
}

export function formatTokens(n: number | undefined): string | undefined {
  if (!n) return undefined;
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}
