import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { DecideResult, DecisionLogSummary, DecisionNodeState, DecisionStatus } from "@polpo-ai/react";

// ── SDK mock: the decision hooks and the client behind them ──
const state = vi.hoisted(() => ({
  status: undefined as unknown as DecisionStatus,
  decisions: [] as DecisionLogSummary[],
  nodes: [] as DecisionNodeState[],
  calls: [] as Array<{ fn: string; args: unknown[] }>,
  result: null as DecideResult | null,
  config: { settings: {} as Record<string, unknown> },
}));

vi.mock("@polpo-ai/react", async () => {
  const React = await import("react");
  const client = {
    getConfig: async () => state.config,
    getDecisionStatus: async () => state.status,
    updateSettings: async (patch: unknown) => { state.calls.push({ fn: "updateSettings", args: [patch] }); return state.config; },
    getDecision: async (id: string) => ({ ...state.decisions.find((d) => d.id === id)!, questions: [{ name: "refund", type: "predicate", instructions: "Refund?" }], state: "I was charged twice" }),
  };
  return {
    usePolpo: () => ({ client }),
    useEvents: () => ({ events: [] }),
    useDecide: () => {
      const [result, setResult] = React.useState<DecideResult | null>(null);
      return {
        decide: async (req: unknown) => { state.calls.push({ fn: "decide", args: [req] }); setResult(state.result); return state.result; },
        result, isDeciding: false, error: null, reset: () => setResult(null),
      };
    },
    useDecisions: (o: unknown) => {
      state.calls.push({ fn: "useDecisions", args: [o] });
      return {
        page: { decisions: state.decisions, total: state.decisions.length }, status: state.status, nodes: state.nodes, isLoading: false, error: null,
        refetch: async () => {}, resolveNode: async (...args: unknown[]) => { state.calls.push({ fn: "resolveNode", args }); return state.nodes[0]; },
      };
    },
  };
});

vi.mock("@/hooks/use-vault-catalog", () => ({
  useVaultCatalog: () => ({ entries: [{ owner: "polpo-infra", service: "vercel-ai-gateway", type: "api_key", keys: ["token"], allowedAgents: [] }], error: null, loading: false, reload: () => {} }),
}));

import { MemoryRouter } from "react-router-dom";
import { DecisionsPage } from "../src/pages/decisions";
import { DecisionsSection } from "../src/components/config/decisions-section";
import { answerBars, decisionFormFrom, decisionPatchFrom, draftToQuestion, parseDecisionState } from "../src/lib/decisions";
import { parseMissionData } from "../src/lib/mission-data";

const STATUS: DecisionStatus = {
  configured: true, model: "vercel-ai-gateway:typesafe-ai/jev", gateway: { id: "vercel-ai-gateway", label: "Vercel AI Gateway" },
  key: { ok: true, source: "vault", detail: "vault polpo-infra / vercel-ai-gateway (token)" }, unconfigured: "error", retention: 1000, retentionDays: 30, storeInputs: "capped",
  gateways: [{ id: "vercel-ai-gateway", label: "Vercel AI Gateway", envVar: "AI_GATEWAY_API_KEY" }],
};
const RESULT: DecideResult = {
  id: "dec_aaaaaa111111", model: "vercel-ai-gateway:typesafe-ai/jev", usage: {}, costUsd: 0.00021, calibrated: true, latencyMs: 180, uncertain: true,
  answers: [
    { name: "refund", type: "predicate", value: true, probability: 0.92, confidence: 0.92, uncertain: false },
    { name: "team", type: "choice", choice: "billing", probabilities: { billing: 0.55, support: 0.45 }, confidence: 0.55, threshold: 0.7, uncertain: true },
  ],
};

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  state.status = STATUS;
  state.result = RESULT;
  state.decisions = [{
    id: "dec_bbbbbb222222", at: "2026-11-26T10:00:00Z", caller: { kind: "agent", id: "writer" }, status: "ok", model: RESULT.model, calibrated: false, latencyMs: 100,
    costUsd: 0.001, usage: {}, answers: RESULT.answers, uncertain: true, stateHash: "ab".repeat(32), stateChars: 20, questions: [{ name: "refund", type: "predicate" }, { name: "team", type: "choice" }],
  }];
  state.nodes = [{ group: "Tickets", missionId: "m1", node: "route", status: "awaiting", suggested: "billing", reason: "The answer is uncertain (confidence 0.55 below 0.7)", startedAt: "2026-11-26T10:00:00Z" }];
  state.calls = [];
  state.config = { settings: {} };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

const flush = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); });
const $ = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);
const buttons = (text: string | RegExp) => [...document.querySelectorAll("button")].filter((b) => (typeof text === "string" ? b.textContent?.trim() === text : text.test(b.textContent ?? "")));
const click = async (el: Element) => { await act(async () => { (el as HTMLElement).click(); }); await flush(); };
const type = async (el: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  await act(async () => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const pick = async (el: HTMLSelectElement, value: string) => {
  await act(async () => { el.value = value; el.dispatchEvent(new Event("change", { bubbles: true })); });
};

describe("the Decisions page", () => {
  const render = async (path = "/decisions") => {
    await act(async () => root.render(<MemoryRouter initialEntries={[path]}><DecisionsPage /></MemoryRouter>));
    await flush();
  };

  test("status, the playground (JSON state, a choice question) and the answers with probability bars", async () => {
    await render();
    expect($('[data-testid="decision-status"]')!.textContent).toContain("vercel-ai-gateway:typesafe-ai/jev");
    expect($('[data-testid="decision-status"]')!.textContent).toContain("vault polpo-infra / vercel-ai-gateway (token)");
    await type($<HTMLTextAreaElement>('textarea[aria-label="State"]')!, '{"ticket":"charged twice"}');
    await type($<HTMLInputElement>('input[aria-label="Question name"]')!, "team");
    await pick($<HTMLSelectElement>('select[aria-label="Question type"]')!, "choice");
    await type($<HTMLInputElement>('input[aria-label="Instructions"]')!, "Which team?");
    await type($<HTMLTextAreaElement>('textarea[aria-label^="Options"]')!, "billing: Charges\nsupport");
    await type($<HTMLInputElement>('input[aria-label="Threshold"]')!, "0.7");
    await click(buttons("Decide")[0]!);
    expect(state.calls.find((c) => c.fn === "decide")!.args[0]).toEqual({
      state: { ticket: "charged twice" },
      questions: [{ name: "team", type: "choice", instructions: "Which team?", choices: [{ value: "billing", description: "Charges" }, { value: "support" }], threshold: 0.7 }],
    });
    const result = $('[data-testid="decide-result"]')!;
    expect(result.textContent).toContain("$0.00021");
    const team = result.querySelector('[data-answer="team"]')!;
    expect(team.textContent).toContain("billing");
    expect(team.textContent).toContain("Uncertain");
    expect(team.querySelector('[data-bar="billing"] [role="meter"]')!.getAttribute("aria-valuenow")).toBe("0.55");
    expect(team.querySelector('[data-bar="billing"]')!.textContent).toContain("55%");
  });

  test("a node waiting for a person: take the suggestion; the log opens a decision with its state", async () => {
    await render();
    const nodes = $('[data-testid="decision-nodes"]')!;
    expect(nodes.textContent).toContain("route");
    expect(nodes.textContent).toContain("confidence 0.55 below 0.7");
    await click(buttons(/Take “billing”/)[0]!);
    expect(state.calls.find((c) => c.fn === "resolveNode")!.args).toEqual(["Tickets", "route", "billing"]);
    const row = $('[data-decision="dec_bbbbbb222222"]')!;
    expect(row.textContent).toContain("refund: yes · team: billing");
    expect(row.textContent).toContain("Uncalibrated");
    expect(row.textContent).toContain("agent · writer");
    await click(row.querySelector("button")!);
    expect($('[data-testid="decision-detail"]')!.textContent).toContain("I was charged twice");
  });

  test("not configured: the playground points to Settings", async () => {
    state.status = { ...STATUS, configured: false, model: undefined, key: undefined };
    await render();
    expect($('[data-testid="decision-status"]')!.textContent).toContain("decide() refuses until one is set");
    expect($('[data-testid="decisions-playground"] a[href="/config?section=decisions"]')).toBeTruthy();
  });
});

describe("Settings → Decisions", () => {
  test("loads the saved model with its vault entry and saves the form as settings", async () => {
    state.config = { settings: { decisionModel: { gateway: "vercel-ai-gateway", model: "typesafe-ai/jev", credentialRef: { owner: "polpo-infra", service: "vercel-ai-gateway" }, credentialField: "token" } } };
    await act(async () => root.render(<MemoryRouter><DecisionsSection /></MemoryRouter>));
    await flush();
    expect($<HTMLInputElement>('input[aria-label="Decision model"]')!.value).toBe("typesafe-ai/jev");
    expect($('[data-testid="decision-key-status"]')!.textContent).toContain("key from vault polpo-infra / vercel-ai-gateway (token)");
    await type($<HTMLInputElement>('input[aria-label="Fallback model"]')!, "openai/gpt-6-luna");
    await type($<HTMLInputElement>('input[aria-label="Fallback confidence"]')!, "0.6");
    await pick($<HTMLSelectElement>('select[aria-label="Without a decision model"]')!, "orchestrator");
    await click(buttons("Save")[0]!);
    expect(state.calls.find((c) => c.fn === "updateSettings")!.args[0]).toEqual({
      decisionModel: {
        gateway: "vercel-ai-gateway", model: "typesafe-ai/jev", credentialRef: { owner: "polpo-infra", service: "vercel-ai-gateway" }, credentialField: "token",
        fallback: { model: "openai/gpt-6-luna", confidenceBelow: 0.6 },
      },
      decisions: { unconfigured: "orchestrator" },
    });
  });

  test("the form helpers: a string model, an empty model removes it", () => {
    expect(decisionFormFrom("vercel-ai-gateway:typesafe-ai/jev", undefined)).toMatchObject({ gateway: "vercel-ai-gateway", model: "typesafe-ai/jev", credentialRef: null });
    expect(decisionPatchFrom(decisionFormFrom(undefined, { retention: 50 }))).toEqual({ decisionModel: null, decisions: { retention: 50 } });
  });
});

describe("mission and playbook documents", () => {
  test("decision nodes are read for the graph; malformed ones are left out", () => {
    const parsed = parseMissionData(JSON.stringify({
      tasks: [{ title: "Triage" }, { title: "Refund", dependsOn: ["Triage"] }],
      decisions: [
        { name: "route", afterTasks: ["Triage"], question: { type: "choice", instructions: "Team?", choices: [{ value: "billing" }] }, branches: { billing: ["Refund"] } },
        { name: "broken" },
      ],
    }));
    expect(parsed?.decisions?.map((d) => d.name)).toEqual(["route"]);
    expect(parseMissionData(JSON.stringify({ tasks: [] }))?.decisions).toBeUndefined();
  });
});

describe("decision helpers", () => {
  test("bars per type; drafts; state parsing", () => {
    expect(answerBars({ name: "a", type: "predicate", value: false, probability: 0.2, uncertain: false }).bars).toEqual([{ label: "yes", value: 0.2, chosen: false }, { label: "no", value: 0.8, chosen: true }]);
    expect(answerBars({ name: "r", type: "rank", uncertain: false, ranking: [{ id: "1", label: "Pro", score: 4 }, { id: "2", label: "Basic", score: 2 }] })).toMatchObject({ headline: "Pro > Basic", relative: true, bars: [{ value: 1 }, { value: 0.5 }] });
    expect(draftToQuestion({ name: "s", type: "score", instructions: "How bad?", list: "Low\nHigh\n", threshold: "" })).toEqual({ name: "s", type: "score", instructions: "How bad?", levels: ["Low", "High"] });
    expect(parseDecisionState("plain text")).toBe("plain text");
    expect(parseDecisionState("[1,2]")).toEqual([1, 2]);
  });
});
