/**
 * The MCP decision card (widgets/decision-card/view.ts) rendered in a DOM from the server's cards
 * (src/server/mcp-decision-card.ts): one decision's answers with probability bars, uncertain and
 * uncalibrated flags; the latest decisions, one opening its card.
 */
import { describe, expect, it, vi } from "vitest";
import { renderView } from "../../widgets/decision-card/view";
import { buildDecisionDetailCard, buildDecisionListCard, decisionCardText, type DecisionShape } from "../../src/server/mcp-decision-card";

const key = { createdAt: 1, seq: 1 };
const decision: DecisionShape = {
  id: "dec_0123456789ab", at: "2026-11-26T10:00:00Z", caller: { kind: "agent", id: "writer" }, model: "vercel-ai-gateway:typesafe-ai/jev",
  calibrated: true, costUsd: 0.00021, latencyMs: 180, status: "ok", uncertain: true,
  questions: [{ name: "refund", type: "predicate", instructions: "Refund?" }],
  answers: [
    { name: "refund", type: "predicate", value: true, probability: 0.92, confidence: 0.92, uncertain: false },
    { name: "team", type: "choice", choice: "billing", probabilities: { support: 0.45, billing: 0.55 }, confidence: 0.55, threshold: 0.7, uncertain: true },
    { name: "severity", type: "score", score: 1.6, level: "High", probabilities: { Low: 0.1, Medium: 0.2, High: 0.7 }, uncertain: false },
    { name: "plan", type: "rank", ranking: [{ id: "2", label: "Pro", score: 3.4 }, { id: "1", label: "Basic", score: 1.7 }], uncertain: false },
  ],
};
const env = (card: unknown, extra: Record<string, unknown> = {}) => ({ card: card as never, locale: "en", full: false, canFullscreen: true, busy: false, superseded: false, ...extra });

describe("the decision card (MCP App)", () => {
  it("one decision: a headline per answer, probability bars (the chosen one marked), uncertain, model and cost", () => {
    const root = document.createElement("div");
    const card = buildDecisionDetailCard({ decision, key });
    renderView(root, env(card));
    const team = root.querySelector('[data-answer="team"]')!;
    expect(team.textContent).toContain("billing");
    expect(team.textContent).toContain("Uncertain");
    expect(team.textContent).toContain("confidence 0.55 · threshold 0.70");
    const bars = [...team.querySelectorAll(".pbar")];
    expect(bars.map((b) => b.getAttribute("data-bar"))).toEqual(["billing", "support"]);
    expect(bars[0]!.classList.contains("chosen")).toBe(true);
    expect(bars[0]!.querySelector('[role="meter"]')!.getAttribute("aria-valuenow")).toBe("0.55");
    expect(root.querySelector('[data-answer="severity"]')!.textContent).toContain("1.60 · High");
    expect(root.querySelector('[data-answer="plan"]')!.textContent).toContain("Pro > Basic");
    expect(root.textContent).toContain("vercel-ai-gateway:typesafe-ai/jev · $0.00021");
    expect(decisionCardText(card)).toContain("team: billing (confidence 0.55) — uncertain [billing 55%, support 45%]");
  });

  it("uncalibrated answers say so; the list opens a decision; Italian strings", () => {
    const root = document.createElement("div");
    const onShow = vi.fn();
    const list = buildDecisionListCard({ decisions: [{ ...decision, calibrated: false }, { ...decision, id: "dec_ffffffffffff", status: "error", error: "No decision model", answers: [] }], total: 2, key });
    renderView(root, env(list, { onShow }));
    const row = root.querySelector('[data-decision="dec_0123456789ab"]')!;
    expect(row.textContent).toContain("Uncalibrated");
    expect(root.querySelector('[data-decision="dec_ffffffffffff"]')!.textContent).toContain("Failed");
    (row.querySelector(".link-btn") as HTMLButtonElement).click();
    expect(onShow).toHaveBeenCalledWith({ id: "dec_0123456789ab" });
    renderView(root, env(buildDecisionDetailCard({ decision: { ...decision, calibrated: false }, key }), { locale: "it-IT" }));
    expect(root.textContent).toContain("Non calibrata");
    expect(root.textContent).toContain("Incerta");
  });
});
