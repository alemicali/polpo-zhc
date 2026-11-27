/**
 * The engine marker after every model: `model · [mark] Polpo | <X> Harness | <X> CLI`, compact
 * (mark only) or full, a tooltip with the engine, runtime and auth (never a secret); resolved from an
 * agent's config or a run's record. Spot checks: the agent hero card, the chat header and the
 * task's Run card.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { TaskRunContext } from "@polpo-ai/react";
import { TooltipProvider } from "@/components/ui/tooltip";

const chatAgents = [{ name: "rev", model: "anthropic:claude-opus-4-5", engine: { type: "cli", cli: "claude", model: "claude-sonnet-4-6", account: "ada-claude" } }];
vi.mock("@polpo-ai/react", () => ({
  usePolpo: () => ({ client: { getApprovals: async () => [] }, connectionStatus: "connected" }),
  useEvents: () => ({ events: [] }),
  useAgents: () => ({ agents: chatAgents }),
}));
vi.mock("@/hooks/use-polpo", () => ({ useProjectInfo: () => ({ info: { project: "demo", version: "1.0.0" } }) }));
vi.mock("@/hooks/chat-context", () => ({
  useSidebarOpen: () => false,
  sidebarActions: { toggleSidebar: () => {} },
  useChatPageSessionsOpen: () => false,
  useChatState: () => ({ messages: [], isLoading: false, sessionId: null, sessions: [], selectedAgent: "rev" }),
  useChatActions: () => ({ newSession: () => {}, clear: () => {} }),
  chatPageSessionActions: { toggle: () => {} },
}));
vi.mock("@/pages/chat", () => ({ ChatHistoryPanel: () => <div /> }));
vi.mock("../src/components/layout/chat-tabs", () => ({ ChatTabs: () => <div /> }));
const heroAgent: { agent: Record<string, unknown> } = { agent: {} };
vi.mock("../src/components/agents/agent-detail-context", () => ({
  useAgentDetail: () => ({ state: { agent: heroAgent.agent, process: undefined, teamColorIndex: 0, isRefreshing: false }, actions: { refetch: async () => {} }, meta: { agentName: "dev" } }),
}));

import { AgentModelWithEngine, EngineMark, ModelWithEngine, RunModelWithEngine } from "../src/components/shared/model-with-engine";
import { agentEngineInfo, engineInfo, engineTooltip, runEngineInfo } from "../src/lib/engine-mark";
import { Header } from "../src/components/layout/header";
import { AgentHeroCard } from "../src/components/agents/agent-hero-card";
import { RunContextCard } from "../src/components/shared/run-context";

beforeEach(() => {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, onchange: null, dispatchEvent: () => false }));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true, data: {} }))));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const wrap = (ui: React.ReactNode, at = "/") => render(<MemoryRouter initialEntries={[at]}><TooltipProvider>{ui}</TooltipProvider></MemoryRouter>);
const mark = (el: ParentNode = document.body) => el.querySelector<HTMLElement>('[data-testid="engine-mark"]')!;

describe("ModelWithEngine: every engine", () => {
  const cases: Array<{ engine: string; label: string; kind: string; brand: string }> = [
    { engine: "polpo", label: "Polpo", kind: "polpo", brand: "polpo" },
    { engine: "claude-code", label: "Claude Code Harness", kind: "harness", brand: "claude-code" },
    { engine: "codex", label: "Codex Harness", kind: "harness", brand: "codex" },
    { engine: "opencode", label: "OpenCode Harness", kind: "harness", brand: "opencode" },
    { engine: "claude-cli", label: "Claude Code CLI", kind: "cli", brand: "claude-code" },
    { engine: "codex-cli", label: "Codex CLI", kind: "cli", brand: "codex" },
  ];
  for (const c of cases) {
    test(`${c.engine}: model · mark + "${c.label}"; compact keeps the mark, the label goes to the tooltip`, () => {
      const { container, unmount } = wrap(<ModelWithEngine model="m-1" engine={c.engine} />);
      const full = mark(container);
      expect(container.querySelector('[data-testid="model-name"]')!.textContent).toBe("m-1");
      expect(full.getAttribute("data-engine")).toBe(c.engine);
      expect(full.getAttribute("data-engine-kind")).toBe(c.kind);
      expect(full.querySelector(`[data-brand="${c.brand}"]`)).not.toBeNull();
      expect(full.textContent).toContain(c.label);
      expect(full.getAttribute("title")).toContain(`Engine: ${c.label}`);
      expect(full.getAttribute("title")).toContain("Model: m-1");
      // model first, then the marker
      const text = container.textContent!;
      expect(text.indexOf("m-1")).toBeLessThan(text.indexOf(c.label));
      unmount();

      const compact = wrap(<ModelWithEngine model="m-1" engine={c.engine} compact />);
      const m = mark(compact.container);
      expect(m.querySelector(`[data-brand="${c.brand}"]`)).not.toBeNull();
      expect(m.textContent).not.toContain(c.kind === "polpo" ? "Polpo" : c.label);
      expect(m.getAttribute("aria-label")).toBe(c.label);
      expect(m.getAttribute("title")).toContain(`Engine: ${c.label}`);
    });
  }

  test("no model: the marker alone (or the fallback); EngineMark on its own", () => {
    const { container } = wrap(<><ModelWithEngine model={undefined} engine="codex" /><span data-testid="fb"><ModelWithEngine model={undefined} engine="polpo" fallback="default" /></span></>);
    expect(container.querySelectorAll('[data-testid="model-name"]')).toHaveLength(1);
    expect(within(screen.getByTestId("fb")).getByTestId("model-name").textContent).toBe("default");
    wrap(<EngineMark engine="opencode" />);
    expect(screen.getAllByTestId("engine-mark").at(-1)!.textContent).toBe("OpenCode Harness");
  });

  test("pretty: a readable model name, the raw id in its tooltip", () => {
    const { container } = wrap(<ModelWithEngine model="us.anthropic.claude-haiku-4-5-20251001-v1:0" engine="claude-code" pretty />);
    const name = container.querySelector('[data-testid="model-name"]')!;
    expect(name.textContent).toBe("Haiku 4.5");
    expect(name.getAttribute("title")).toBe("us.anthropic.claude-haiku-4-5-20251001-v1:0");
  });
});

describe("resolution and tooltip", () => {
  test("agents: absent engine → Polpo with the agent's model; a harness or CLI with its own model", () => {
    expect(agentEngineInfo({ model: "openai:gpt-6" })).toMatchObject({ model: "openai:gpt-6", engine: { id: "polpo", label: "Polpo" } });
    expect(agentEngineInfo({ model: "x", engine: "polpo" }).engine.id).toBe("polpo");
    expect(agentEngineInfo({ model: "x", engine: { harness: "opencode", model: "kimi-k3.1" } })).toMatchObject({ model: "kimi-k3.1", engine: { id: "opencode", label: "OpenCode Harness" } });
    // a harness without its own model: the agent's Polpo model is not what runs
    expect(agentEngineInfo({ model: "x", engine: { harness: "codex" } }).model).toBeUndefined();
    expect(agentEngineInfo({ engine: { type: "cli", cli: "codex" } }).engine.label).toBe("Codex CLI");
  });

  test("runs: what the run recorded (engine, auth)", () => {
    const r = runEngineInfo({ engine: "opencode", model: "global.moonshotai.kimi-k3.1", auth: { kind: "bedrock", region: "us-west-2" } });
    expect(r.engine.label).toBe("OpenCode Harness");
    expect(engineTooltip(r.engine, r.model)).toBe(
      "Model: global.moonshotai.kimi-k3.1\nEngine: OpenCode Harness\nRuntime: OpenCode in the Vercel AI SDK harness\nAuth: Bedrock · us-west-2");
    expect(engineTooltip(runEngineInfo({ engine: "claude-cli" }).engine)).toContain("Auth: personal plan");
    expect(engineTooltip(engineInfo("polpo"))).toBe("Engine: Polpo\nRuntime: Polpo's built-in agent loop (any provider)");
  });

  test("the tooltip names auth kinds, gateways and accounts, never a secret", () => {
    const agent = { name: "rev", engine: { type: "cli", cli: "claude", account: "ada-claude", model: "claude-sonnet-4-6", apiKey: "sk-ant-SECRET", token: "tok-SECRET" } };
    const { container } = wrap(<AgentModelWithEngine agent={agent} />);
    const tip = mark(container).getAttribute("title")!;
    expect(tip).toContain("Engine: Claude Code CLI");
    expect(tip).toContain("Runtime: the official `claude` program");
    expect(tip).toContain("Auth: personal plan · ada-claude");
    expect(container.innerHTML).not.toContain("SECRET");
    const gw = engineTooltip(engineInfo("codex", { kind: "gateway", gateway: "LiteLLM" }));
    expect(gw).toContain("Auth: model gateway · LiteLLM");
  });
});

describe("spot checks", () => {
  test("the agent hero card: the harness and the model on two rows (not repeated in the header)", () => {
    heroAgent.agent = { name: "dev", model: "anthropic:claude-opus-4-5", engine: { harness: "opencode", model: "kimi-k3.1" }, identity: {} };
    wrap(<AgentHeroCard />);
    expect(screen.queryByTestId("agent-hero-model")).toBeNull();
    const row = screen.getByTestId("agent-hero-model-row");
    expect(row.textContent).toContain("kimi-k3.1");
    expect(row.getAttribute("data-engine")).toBe("opencode");
    expect(row.querySelector('[data-testid="engine-mark"]')).toBeNull();
    const marks = screen.getAllByTestId("engine-mark");
    expect(marks.map((m) => m.textContent)).toContain("OpenCode Harness");
  });

  test("the agent hero card on Polpo's engine: its model, and Polpo as the harness", () => {
    heroAgent.agent = { name: "dev", model: "openai:gpt-6", identity: {} };
    wrap(<AgentHeroCard />);
    expect(screen.getByTestId("agent-hero-model-row").textContent).toContain("openai:gpt-6");
    const marks = screen.getAllByTestId("engine-mark");
    expect(marks.some((m) => m.getAttribute("data-engine") === "polpo" && (m.textContent ?? "").includes("Polpo"))).toBe(true);
  });

  test("the chat header: the agent's model with its engine's mark", () => {
    wrap(<Header />, "/chat");
    const chip = screen.getByTestId("header-chat-model");
    expect(chip.textContent).toContain("claude-sonnet-4-6");
    expect(mark(chip).getAttribute("data-engine")).toBe("claude-cli");
    expect(mark(chip).getAttribute("aria-label")).toBe("Claude Code CLI");
  });

  test("the task's Run card: the recorded run's model · engine", () => {
    const run: TaskRunContext = {
      runId: "c1", startedAt: "2026-11-24T10:00:00.000Z", status: "completed", engine: "codex-cli", model: "gpt-6-codex", auth: { kind: "subscription" },
      computer: { id: "host", kind: "host" }, egress: { mode: "direct" },
    };
    wrap(<RunContextCard runs={[run]} />);
    expect(screen.getByTestId("run-model").textContent).toBe("gpt-6-codex");
    expect(screen.getByTestId("run-engine").textContent).toMatch(/Codex CLI$/);
    expect(mark(screen.getByTestId("run-engine")).getAttribute("title")).toContain("Auth: personal plan");
  });

  test("RunModelWithEngine from a slim summary", () => {
    const { container } = wrap(<RunModelWithEngine run={{ engine: "claude-code", model: "claude-sonnet-4-6" }} compact />);
    expect(container.textContent).toContain("claude-sonnet-4-6");
    expect(mark(container).getAttribute("aria-label")).toBe("Claude Code Harness");
  });
});
