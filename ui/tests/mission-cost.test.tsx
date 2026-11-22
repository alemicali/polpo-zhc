/**
 * A mission's cost and budget: the header button (total, budget bar in the warning or destructive
 * tone), its breakdown by engine (with their marks) and agent, the budget editor, the banner of a
 * mission its budget paused, and the list badge.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { MissionCost } from "@polpo-ai/react";
import { MissionBudgetBanner, MissionCostBadge, MissionCostButton } from "../src/components/missions/mission-cost";
import { budgetPct, budgetTone, parseBudgetInput } from "../src/lib/mission-cost";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

const render = async (node: React.ReactNode) => { await act(async () => root.render(node)); };
const q = (sel: string, el: ParentNode = document.body) => el.querySelector<HTMLElement>(sel);

const cost: MissionCost = {
  currency: "USD", usd: 4.2, harnessUsd: 4, modelUsd: 0.2, tokens: 152_000, runs: 5, tasks: 3, unpricedRuns: 1, runsActive: 1,
  byEngine: [
    { engine: "claude-code", usd: 4, harnessUsd: 4, modelUsd: 0, tokens: 2000, runs: 3 },
    { engine: "polpo", usd: 0.2, harnessUsd: 0, modelUsd: 0.2, tokens: 150_000, runs: 2 },
  ],
  byAgent: [
    { agent: "coder", usd: 4, harnessUsd: 4, modelUsd: 0, tokens: 2000, runs: 3 },
    { agent: "writer", usd: 0.2, harnessUsd: 0, modelUsd: 0.2, tokens: 150_000, runs: 2 },
  ],
  partial: true, partialTaskIds: ["t1"], budgetUsd: 5, remainingUsd: 0.8, budgetUsed: 0.84, overBudget: false,
};

test("budget tones and input", () => {
  expect(budgetTone(1, undefined)).toBeUndefined();
  expect(budgetTone(1, 5)).toBe("ok");
  expect(budgetTone(4.2, 5)).toBe("near");
  expect(budgetTone(5, 5)).toBe("over");
  expect(budgetPct(7, 5)).toBe(100);
  expect(parseBudgetInput("$12,50")).toBe(12.5);
  expect(parseBudgetInput("0")).toBeUndefined();
  expect(parseBudgetInput("abc")).toBeUndefined();
});

test("the header shows the total against the budget, near it in the warning tone; the breakdown by engine (marks) and agent, the notes, and the budget editor", async () => {
  const onSaveBudget = vi.fn(async () => {});
  await render(<MissionCostButton cost={cost} onSaveBudget={onSaveBudget} />);
  const button = q('[data-testid="mission-cost"]')!;
  expect(button.dataset.tone).toBe("near");
  expect(q('[data-testid="mission-cost-total"]')!.textContent).toBe("$4.20+ of $5.00");
  expect(q('[data-testid="mission-budget-bar"]')!.className).toContain("bg-warning");

  await act(async () => { button.click(); });
  const panel = q('[data-testid="mission-cost-breakdown"]')!;
  expect(panel.textContent).toContain("5 runs over 3 tasks");
  expect(q('[data-testid="mission-cost-split"]')!.textContent).toBe("Harness estimate $4.00 · Model cost $0.20");
  const engines = q('[data-testid="mission-cost-by-engine"]')!;
  expect([...engines.querySelectorAll("[data-brand]")].map((e) => e.getAttribute("data-brand"))).toEqual(["claude-code", "polpo"]);
  expect(engines.textContent).toMatch(/Claude Code.*3 runs.*\$4\.00.*95%/);
  expect(q('[data-testid="mission-cost-by-agent"]')!.textContent).toMatch(/coder.*\$4\.00.*writer.*\$0\.20/);
  expect(panel.textContent).toContain("Partial");
  expect(panel.textContent).toContain("1 run reported no cost");

  // raise the budget
  const input = q("#mission-budget") as HTMLInputElement;
  expect(input.value).toBe("5");
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, "10");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => { (q('[data-testid="mission-budget-editor"] button[type="submit"]') as HTMLButtonElement).click(); });
  expect(onSaveBudget).toHaveBeenCalledWith(10);
  // clear it
  await act(async () => { [...panel.querySelectorAll("button")].find((b) => b.textContent === "Clear")!.click(); });
  expect(onSaveBudget).toHaveBeenLastCalledWith(null);
});

test("over budget: destructive tone and the paused banner; no budget: the agents' harness cap as a hint", async () => {
  const over = { ...cost, usd: 6, partial: false, overBudget: true };
  await render(<><MissionCostButton cost={over} /><MissionBudgetBanner cost={over} /></>);
  expect(q('[data-testid="mission-cost"]')!.dataset.tone).toBe("over");
  expect(q('[data-testid="mission-budget-bar"]')!.className).toContain("bg-destructive");
  expect(q('[data-testid="mission-budget-banner"]')!.textContent).toContain("Paused: over budget ($6.00 spent of $5.00)");

  const none = { ...cost, budgetUsd: undefined, remainingUsd: undefined, budgetUsed: undefined, overBudget: undefined, partial: false, agentBudgetCapUsd: 6 };
  await render(<MissionCostButton cost={none} />);
  expect(q('[data-testid="mission-cost"]')!.dataset.tone).toBe("none");
  expect(q('[data-testid="mission-budget-bar"]')).toBeNull();
  await act(async () => { q('[data-testid="mission-cost"]')!.click(); });
  expect(q('[data-testid="mission-cost-breakdown"]')!.textContent).toContain("cap one run of each task at $6.00");
});

test("the list badge: cost alone, or against the budget with its tone; nothing for a mission that never ran without budget", async () => {
  await render(<>
    <MissionCostBadge cost={{ usd: 1.234, tokens: 10, runs: 2 }} />
    <MissionCostBadge cost={{ usd: 5.5, tokens: 10, runs: 3, budgetUsd: 5, overBudget: true }} />
    <MissionCostBadge cost={{ usd: 0, tokens: 0, runs: 0 }} />
  </>);
  const badges = [...container.querySelectorAll<HTMLElement>('[data-testid="mission-cost-badge"]')];
  expect(badges.map((b) => [b.textContent, b.dataset.tone])).toEqual([["$1.23", "none"], ["$5.50/ $5.00", "over"]]);
});
