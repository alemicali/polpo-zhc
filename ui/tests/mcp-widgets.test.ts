/**
 * The MCP task and mission cards (widgets/work-card/view.ts) rendered in a DOM: the engine and
 * computer marks, why a task failed (and "not retried"), the mission's budget bar, and the actions.
 */
import { describe, expect, it, vi } from "vitest";
import { renderView } from "../../widgets/work-card/view";
import { brandMark, modelWithEngine } from "../../widgets/shared/brand";
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
    // the run line: the model, then the engine's mark and type
    const latest = root.querySelector(".run .model-engine")!;
    expect(latest.querySelector(".model-name")!.textContent).toBe("Sonnet 4.5");
    expect(latest.querySelector(".engine-mark")!.getAttribute("data-engine-kind")).toBe("harness");
    expect(latest.querySelector(".engine-mark [data-brand='claude-code']")).not.toBeNull();
    expect(latest.querySelector(".engine-label")!.textContent).toBe("Claude Code Harness");
    expect(latest.textContent!.indexOf("Sonnet 4.5")).toBeLessThan(latest.textContent!.indexOf("Claude Code Harness"));
    expect(latest.getAttribute("title")).toContain("Auth: Bedrock");
    expect(root.textContent).toContain("GPU box");
    expect(root.textContent).toContain("$0.42 of $2");
    expect(root.textContent).toContain("Collect data");
    // inline: the session and egress details wait for full screen
    expect(root.textContent).not.toContain("resumed session");
  });

  it("a task run more than once: the total of every run and the latest's; full screen lists each run with its cost", () => {
    const root = document.createElement("div");
    const retried = { ...failed, runs: [{ ...run, runId: "r0", cost: { harnessUsd: 1.1 } }, { ...run, runId: "r1", engine: "polpo", model: "anthropic:claude-opus-4-5", auth: undefined, cost: { modelUsd: 0.2 } }, run] };
    const card = buildTaskCard({ task: retried as never, tasks: [done, retried] as never, now: new Date(), key });
    renderView(root, env(card));
    const line = root.querySelector(".cost-task")!;
    expect(line.textContent).toContain("In all, 3 runs: $1.72");
    expect(line.textContent).toContain("latest $0.42");
    expect([...line.querySelectorAll("[data-brand]")].map((e) => e.getAttribute("data-brand"))).toEqual(["claude-code", "polpo"]);
    renderView(root, env(card, { full: true }));
    const costs = [...root.querySelectorAll(".run-cost")].map((e) => e.textContent);
    expect(costs).toEqual(expect.arrayContaining(["$0.42 of $2", "$0.20 of $2", "$1.10 of $2"]));
    // Italian
    renderView(root, env(card, { locale: "it-IT" }));
    expect(root.querySelector(".cost-task")!.textContent).toContain("Totale 3 esecuzioni: $1.72");
    expect(root.querySelector(".cost-task")!.textContent).toContain("ultima $0.42");
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

  it("a paused task: who, why and when, and Resume; a running one offers Pause", () => {
    const root = document.createElement("div");
    const paused = { ...done, id: "t3", title: "Sign up", status: "paused", pause: { at: new Date().toISOString(), by: "anna@acme.com", reason: "waiting for the client", from: "in_progress", runId: "r1" } };
    const card = buildTaskCard({ task: paused as never, tasks: [paused] as never, now: new Date(), key });
    expect(card.task.pause).toMatchObject({ by: "anna@acme.com", reason: "waiting for the client" });
    const onPause = vi.fn();
    const onResume = vi.fn();
    renderView(root, env(card, { onPause, onResume }));
    expect(root.querySelector(".paused")?.textContent).toContain("Paused by anna@acme.com");
    expect(root.querySelector(".paused")?.textContent).toContain("waiting for the client");
    const resume = [...root.querySelectorAll("button")].find((b) => b.textContent === "Resume")!;
    resume.click();
    expect(onResume).toHaveBeenCalledOnce();
    expect([...root.querySelectorAll("button")].some((b) => b.textContent === "Pause")).toBe(false);

    const running = buildTaskCard({ task: { ...done, status: "in_progress" } as never, tasks: [done] as never, now: new Date(), key });
    renderView(root, env(running, { onPause, onResume, locale: "it" }));
    expect(root.querySelector(".paused")).toBeNull();
    [...root.querySelectorAll("button")].find((b) => b.textContent === "Metti in pausa")!.click();
    expect(onPause).toHaveBeenCalledOnce();
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
    // task rows: the model with the engine's mark only (compact), its type in the tooltip
    const rowMark = root.querySelector(".row .model-engine .engine-mark")!;
    expect(rowMark.getAttribute("aria-label")).toBe("Claude Code Harness");
    expect(rowMark.querySelector(".engine-label")).toBeNull();
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

  it("model · engine for every engine kind (Polpo, a harness, a CLI), compact or full", () => {
    const polpo = modelWithEngine("gpt-6", { mark: "polpo", label: "Polpo", kind: "polpo", id: "polpo" });
    expect(polpo.textContent).toBe("gpt-6·🐙Polpo");
    const oc = modelWithEngine("kimi-k3.1", { mark: "opencode", label: "OpenCode Harness", kind: "harness" });
    expect(oc.querySelector("[data-brand='opencode']")).not.toBeNull();
    expect(oc.querySelector(".engine-label")!.textContent).toBe("OpenCode Harness");
    const cli = modelWithEngine("claude-sonnet-4-6", { mark: "claude-code", label: "Claude Code CLI", kind: "cli" }, { compact: true, auth: "personal plan" });
    expect(cli.querySelector(".engine-label")).toBeNull();
    expect(cli.querySelector(".engine-mark")!.getAttribute("aria-label")).toBe("Claude Code CLI");
    expect(cli.title).toBe("Model: claude-sonnet-4-6\nEngine: Claude Code CLI\nAuth: personal plan");
    // no model: the marker alone
    expect(modelWithEngine(undefined, { mark: "codex", label: "Codex CLI" }).querySelector(".model-name")).toBeNull();
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
