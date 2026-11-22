/**
 * The MCP task and mission cards (widgets/work-card/view.ts) rendered in a DOM: the engine and
 * computer marks, why a task failed (and "not retried"), the mission's budget bar, and the actions.
 */
import { describe, expect, it, vi } from "vitest";
import { renderView } from "../../widgets/work-card/view";
import { brandMark } from "../../widgets/shared/brand";
import { buildMissionCard, buildTaskCard } from "../../src/server/mcp-work-card";

const run = {
  runId: "r2", startedAt: "2026-11-22T10:00:00.000Z", status: "failed", agent: "dev", engine: "claude-code",
  model: "us.anthropic.claude-sonnet-4-5-20250929-v1:0", auth: { kind: "bedrock", region: "eu-west-1" },
  computer: { id: "gpu-box", name: "GPU box", kind: "daytona", provider: "daytona", daytonaApi: "v2" },
  egress: { mode: "proxy", proxy: "home", tailscale: true }, session: { resumed: true, bootstrapMs: 900 },
  cost: { harnessUsd: 0.42 }, budgetUsd: 2, durationMs: 61_000,
};
const failed = {
  id: "t2", title: "Write report", status: "failed", assignTo: "dev", missionId: "m1", dependsOn: ["t1"],
  result: { exitCode: 1, stdout: "", stderr: "Bedrock: model \"x\" not enabled for this account — pick another model", duration: 1, retryable: false },
  runs: [run],
};
const done = { id: "t1", title: "Collect data", status: "done", assignTo: "dev", missionId: "m1", runs: [{ ...run, runId: "r1", status: "completed", engine: "polpo", model: "anthropic:claude-opus-4-5", auth: undefined, computer: { id: "host", kind: "host" }, egress: { mode: "direct" }, cost: { modelUsd: 0.2 } }] };
const key = { createdAt: 1, seq: 1 };

function env(card: unknown, extra: Record<string, unknown> = {}) {
  return { card: card as never, locale: "en", full: false, canFullscreen: true, busy: false, superseded: false, ...extra };
}

describe("the work card (MCP App)", () => {
  it("a failed task: the labelled reason, not retried, and the latest run with its engine, auth and computer marks", () => {
    const root = document.createElement("div");
    const card = buildTaskCard({ task: failed as never, tasks: [done, failed] as never, now: new Date(), key });
    renderView(root, env(card));
    expect(root.querySelector(".failure")?.textContent).toContain("not enabled for this account");
    expect(root.querySelector(".failure")?.textContent).toContain("Not retried");
    expect(root.querySelector(".failure")?.textContent).toContain("Model not enabled");
    const marks = [...root.querySelectorAll("[data-brand]")].map((e) => e.getAttribute("data-brand"));
    expect(marks).toEqual(expect.arrayContaining(["claude-code", "bedrock", "daytona"]));
    expect(root.textContent).toContain("Sonnet 4.5");
    expect(root.textContent).toContain("GPU box");
    expect(root.textContent).toContain("$0.42 of $2");
    expect(root.textContent).toContain("Collect data");
    // inline: the session and egress details wait for full screen
    expect(root.textContent).not.toContain("resumed session");
  });

  it("full screen adds the egress (Tailscale) and the session; the buttons call the host", () => {
    const root = document.createElement("div");
    const card = buildTaskCard({ task: failed as never, tasks: [done, failed] as never, now: new Date(), key });
    const onAsk = vi.fn();
    const onRefresh = vi.fn();
    renderView(root, env(card, { full: true, onAsk, onRefresh }));
    expect(root.querySelector("[data-brand='tailscale']")).not.toBeNull();
    expect(root.textContent).toContain("resumed session");
    expect(root.textContent).toContain("egress home");
    const buttons = [...root.querySelectorAll("button")];
    expect(buttons.map((b) => b.textContent)).toEqual(["Ask about it", "Refresh"]);
    buttons[0]!.click();
    buttons[1]!.click();
    expect(onAsk).toHaveBeenCalledOnce();
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it("a mission over budget: the bar, paused by its budget, cost by engine with marks, the failed task first", () => {
    const root = document.createElement("div");
    const card = buildMissionCard({
      mission: {
        id: "m1", name: "Report", status: "paused", pauseReason: "budget", budgetUsd: 0.5,
        cost: { usd: 0.62, tokens: 0, runs: 2, partial: false, budgetUsd: 0.5, overBudget: true, budgetUsed: 1.24, remainingUsd: -0.12, byAgent: [], byEngine: [
          { engine: "claude-code", usd: 0.42, runs: 1 }, { engine: "polpo", usd: 0.2, runs: 1 },
        ] } as never,
      },
      tasks: [done, failed] as never, now: new Date(), key,
    });
    renderView(root, env(card, { locale: "it" }));
    expect(root.textContent).toContain("In pausa: oltre il budget");
    const bar = root.querySelector("[role='progressbar']")!;
    expect(bar.getAttribute("aria-valuenow")).toBe("124");
    expect(bar.classList.contains("bar-over")).toBe(true);
    expect(root.querySelector(".chips [data-brand='claude-code']")).not.toBeNull();
    const rows = [...root.querySelectorAll(".row")].map((r) => r.textContent ?? "");
    expect(rows[0]).toContain("Write report");
    expect(rows[0]).toContain("non ritentato");
  });

  it("the marks: vector ones in their colours or the text colour, Daytona in a light and a dark variant", () => {
    expect(brandMark("bedrock").querySelector("linearGradient")).not.toBeNull();
    expect(brandMark("codex").getAttribute("class")).toContain("mark-mono");
    expect(brandMark("vertex").querySelectorAll("path").length).toBeGreaterThan(4);
    const daytona = brandMark("daytona");
    expect([...daytona.querySelectorAll("img")].map((i) => i.className)).toEqual(["mark mark-img mark-light", "mark mark-img mark-dark"]);
    expect(brandMark("e2b").tagName).toBe("IMG");
  });

  it("a task with a tool scope: a badge and what its runs get", () => {
    const root = document.createElement("div");
    const scoped = { ...done, toolScope: { connectors: ["gmail-2"] }, toolScopeStale: ["connector linear"] };
    const card = buildTaskCard({ task: scoped as never, tasks: [], connectors: [{ id: "gmail-2", name: "Gmail", account: "info@acme.com" }], now: new Date(), key });
    renderView(root, env(card));
    expect(root.querySelector(".head .chip-info")?.textContent).toBe("Tools restricted");
    expect(root.textContent).toContain("restricted: Gmail – info@acme.com");
    expect(root.textContent).toContain("the agent no longer has: connector linear");
  });

  it("shows the id while loading, and the error when the card could not load", () => {
    const root = document.createElement("div");
    renderView(root, env(undefined, { pending: "t9" }));
    expect(root.querySelector("[aria-busy='true']")?.textContent).toContain("t9");
    renderView(root, env(undefined, { error: "There is no task t9" }));
    expect(root.textContent).toContain("Could not load the card: There is no task t9");
  });
});
