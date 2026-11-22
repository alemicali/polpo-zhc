/**
 * Where and with what a run executed: the task detail's Run card (an agent harness on a Daytona
 * computer vs Polpo's engine on this server), the list badges, the official marks and their labels.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import type { TaskRunContext } from "@polpo-ai/react";
import { RunContextCard, RunBadge, TaskEngineBadge, EngineBadge } from "../src/components/shared/run-context";
import { BrandIcon } from "../src/components/shared/brand-icon";
import { computerKindLabel, engineDetail, formatMs, formatUsd, latestRun, modelLabel } from "../src/lib/run-context";
import type { Computer } from "../src/lib/computers-api";

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
  vi.restoreAllMocks();
});

async function render(node: React.ReactNode) {
  await act(async () => root.render(<MemoryRouter>{node}</MemoryRouter>));
}
const q = (sel: string, el: ParentNode = container) => el.querySelector<HTMLElement>(sel);

const harnessRun: TaskRunContext = {
  runId: "r2", startedAt: "2026-11-22T14:55:55.499Z", endedAt: "2026-11-22T14:56:22.125Z", status: "completed", continuation: true,
  engine: "claude-code", model: "us.anthropic.claude-haiku-4-5-20251001-v1:0", auth: { kind: "bedrock", region: "us-east-1" }, permissionMode: "allow-all",
  computer: { id: "coder-box", name: "Coder box", kind: "daytona", provider: "daytona", daytonaApi: "v2", remoteId: "vm-1" },
  sandbox: { provider: "daytona", ephemeral: false }, egress: { mode: "proxy", proxy: "home", tailscale: true },
  session: { resumed: true, bootstrapMs: 1300 }, cost: { harnessUsd: 1.5, tokens: 144585 }, budgetUsd: 2, durationMs: 26_626, exitCode: 0,
};
const firstRun: TaskRunContext = {
  ...harnessRun, runId: "r1", continuation: undefined, status: "failed", session: { resumed: false, bootstrapMs: 14_800 }, cost: { harnessUsd: 0.07 }, exitCode: 1,
};
const nativeRun: TaskRunContext = {
  runId: "n1", startedAt: "2026-11-22T10:00:00.000Z", status: "running", engine: "polpo", model: "anthropic:claude-sonnet-4-5",
  computer: { id: "host", kind: "host" }, sandbox: { provider: "local", ephemeral: false }, egress: { mode: "direct" }, cost: { modelUsd: 0.012, tokens: 900 },
};
const coderBox = { id: "coder-box", name: "Coder box", kind: "daytona", status: "running", uptimeMinutes: 3, agents: [] } as unknown as Computer;

test("an agent harness run: Claude Code mark, model via Bedrock, the Daytona v2 computer with its status and link, egress via Tailscale, resumed session, cost against the budget; earlier runs", async () => {
  await render(<RunContextCard runs={[firstRun, harnessRun]} computers={[coderBox]} />);
  const card = q('[data-testid="run-context-card"]')!;
  expect(card.textContent).toContain("Run 2 of 2");
  expect(card.textContent).toContain("continuation");
  expect(q('[data-testid="run-engine"]')!.textContent).toBe("Claude Code");
  expect(q('[data-testid="run-model"]')!.textContent).toBe("Haiku 4.5 via Bedrock");
  expect(q('[data-brand="claude-code"]', card)).not.toBeNull();
  expect(q('[data-brand="bedrock"]', card)).not.toBeNull();
  expect(card.textContent).toContain("us-east-1");
  const computer = q('[data-testid="run-computer"]')!;
  expect(computer.textContent).toBe("Coder box");
  expect(computer.getAttribute("href")).toBe("/computers/coder-box");
  expect(q('[data-testid="run-computer-kind"]')!.textContent).toBe("Daytona v2");
  expect(q('[data-testid="computer-status"]', card)!.textContent).toBe("Running");
  expect(q('[data-brand="daytona"]', card)).not.toBeNull();
  expect(card.textContent).toContain("vm-1");
  expect(q('[data-testid="run-egress"]')!.textContent).toBe("homevia Tailscale");
  expect(q('[data-brand="tailscale"]', card)).not.toBeNull();
  expect(q('[data-testid="run-session"]')!.textContent).toMatch(/^Resumed1\.3 s$/);
  expect(q('[data-testid="run-cost"]')!.textContent).toMatch(/\$1\.50of \$2\.00 budget/);
  expect(q('[data-testid="run-budget"]')).not.toBeNull();
  expect(q('[data-testid="run-cost"]')!.textContent).toContain("144.6k tokens");
  // the runs before it, and picking one
  expect(q('[data-testid="run-history"]')!.querySelectorAll("li")).toHaveLength(2);
  await act(async () => q('[data-testid="run-history-r1"]')!.click());
  expect(card.textContent).toContain("Run 1 of 2");
  expect(q('[data-testid="run-session"]')!.textContent).toMatch(/^New14\.8 s$/);
  expect(card.textContent).toContain("exit 1");
});

test("a run on Polpo's engine on this server: the model, direct egress, the model cost, no harness session or budget", async () => {
  await render(<RunContextCard runs={[nativeRun]} />);
  expect(q('[data-testid="run-engine"]')!.textContent).toBe("Polpo");
  expect(q('[data-testid="run-model"]')!.textContent).toBe("Sonnet 4.5");
  expect(q('[data-testid="run-computer"]')!.textContent).toBe("This server");
  expect(q('[data-testid="run-computer"]')!.tagName).toBe("SPAN");
  expect(q('[data-testid="run-computer-kind"]')!.textContent).toBe("Host");
  expect(q('[data-testid="run-egress"]')!.textContent).toContain("Direct");
  expect(q('[data-testid="run-session"]')!.textContent).toBe("In process");
  expect(q('[data-testid="run-cost"]')!.textContent).toMatch(/\$0\.01model cost/);
  expect(q('[data-testid="run-budget"]')).toBeNull();
  expect(q('[data-testid="run-history"]')).toBeNull();
  expect(q('[data-brand="claude-code"]')).toBeNull();
});

test("no runs: no card", async () => {
  await render(<RunContextCard runs={undefined} />);
  expect(q('[data-testid="run-context-card"]')).toBeNull();
});

test("list badges: a harness's mark and its remote computer; nothing for Polpo's engine on this server; the agent's engine before the first run", async () => {
  await render(<>
    <div data-testid="a"><RunBadge run={{ engine: "codex", computerId: "box", computerName: "Box", computerKind: "e2b", provider: "e2b", status: "running", model: "gpt-5-codex" }} /></div>
    <div data-testid="b"><RunBadge run={latestRun({ runs: [nativeRun] })} /></div>
    <div data-testid="c"><TaskEngineBadge task={{}} agentEngine={{ harness: "claude-code" }} /></div>
    <div data-testid="d"><TaskEngineBadge task={{ lastRun: { engine: "claude-code", computerId: "coder-box", computerKind: "daytona", provider: "daytona", status: "completed" } }} /></div>
    <div data-testid="e"><EngineBadge engine="polpo" /></div>
    <div data-testid="f"><EngineBadge engine="polpo" showPolpo withLabel /></div>
  </>);
  const a = q('[data-testid="a"] [data-testid="run-badge"]')!;
  expect(a.getAttribute("title")).toBe("Codex · gpt-5-codex · on Box (E2B)");
  expect(q('[data-brand="codex"]', a)).not.toBeNull();
  expect(q('[data-brand="e2b"]', a)).not.toBeNull();
  expect(q('[data-testid="b"]')!.innerHTML).toBe("");
  expect(q('[data-testid="c"] [data-testid="engine-badge"]')!.getAttribute("data-engine")).toBe("claude-code");
  expect(q('[data-testid="d"] [data-testid="run-badge"]')!.getAttribute("title")).toBe("Claude Code · on coder-box (Daytona)");
  expect(q('[data-testid="e"]')!.innerHTML).toBe("");
  expect(q('[data-testid="f"]')!.textContent).toContain("Polpo");
});

test("marks: inline vectors take the brand colour (mono ones the text colour), vendor PNGs for Daytona (light and dark) and E2B, a letter for the unknown", async () => {
  await render(<>
    <BrandIcon name="claude-code" />
    <BrandIcon name="anthropic" />
    <BrandIcon name="daytona" />
    <BrandIcon name="e2b" />
    <BrandIcon name="mystery" />
  </>);
  const cc = q('[data-brand="claude-code"]')!;
  expect(cc.getAttribute("aria-label")).toBe("Claude Code");
  expect(cc.querySelector("path")!.getAttribute("fill")).toMatch(/^#/);
  expect(q('[data-brand="anthropic"]')!.querySelector("path")!.getAttribute("fill")).toBeNull();
  expect([...q('[data-brand="daytona"]')!.querySelectorAll("img")].map((i) => i.getAttribute("src"))).toEqual(["/brand-icons/daytona-light.png", "/brand-icons/daytona-dark.png"]);
  expect(q('[data-brand="e2b"]')!.getAttribute("src")).toBe("/brand-icons/e2b.png");
  expect(q('[data-brand="mystery"]')!.textContent).toBe("m");
});

test("labels", () => {
  expect(modelLabel("us.anthropic.claude-haiku-4-5-20251001-v1:0")).toBe("Haiku 4.5");
  expect(modelLabel("anthropic:claude-opus-5-5")).toBe("Opus 5.5");
  expect(modelLabel("claude-3-5-sonnet-20241022")).toBe("Sonnet 3.5");
  expect(modelLabel("openai:gpt-5")).toBe("gpt-5");
  expect(engineDetail({ model: "us.anthropic.claude-sonnet-4-5", auth: { kind: "vertex" } })).toBe("Sonnet 4.5 via Vertex AI");
  expect(computerKindLabel({ kind: "ephemeral", provider: "e2b" })).toBe("Ephemeral · E2B");
  expect(computerKindLabel({ kind: "daytona", daytonaApi: "v0" })).toBe("Daytona v0");
  expect(formatUsd(0.0072)).toBe("$0.0072");
  expect(formatUsd(1.5)).toBe("$1.50");
  expect(formatMs(14_800)).toBe("14.8 s");
  expect(formatMs(95_000)).toBe("1 min 35 s");
});
