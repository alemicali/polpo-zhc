/**
 * Decisions (decide()): the request mapping to Vercel AI Gateway's Decisions API and the response
 * parsing for every type, the rank composite, thresholds, validation, the TypeSafe mapping, the
 * shared gateway resolver (vault entry, env fallback, host allowlist), the service (gateway call,
 * log, usage; not configured; the uncalibrated fallback through the chat), mission decision nodes'
 * helpers and the suites' decision scorer. Mocks only: no real gateway call.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DecisionError, GatewayError, assertGatewayHost, buildAnswers, decisionNodeBranch, decisionNodeItems, decisionScore, decisionScorerRequest,
  decisionsRequestBody, describeDecisionAnswer, expandQuestions, fallbackDecisionPrompt, gatewayDefinition, gatewayUrl, gatewaysWith,
  missionDecisionProblems, parseDecisionModel, parseDecisionsResponse, parseFallbackDecision, parseMissionDocument, renderDecisionNodeState,
  resolveGateway, typeSafeRequestBody, validateDecideInput,
  type DecisionQuestion, type MissionDecision, type SuiteScorer, type VaultStore,
} from "@polpo-ai/core";
import { DecisionService } from "../decisions/service.js";

const vault = (entries: Record<string, Record<string, string>>): VaultStore => ({
  get: async (owner: string, service: string) => (entries[`${owner}/${service}`] ? { credentials: entries[`${owner}/${service}`] } : undefined),
} as unknown as VaultStore);

const QUESTIONS: DecisionQuestion[] = [
  { name: "refund", type: "predicate", instructions: "Is the customer asking for money back?" },
  { name: "team", type: "choice", instructions: "Which team?", choices: [{ value: "billing", description: "Charges" }, { value: "support" }] },
  { name: "severity", type: "score", instructions: "How severe?", levels: [{ label: "Low" }, { label: "Medium", description: "Workaround" }, { label: "High" }] },
  { name: "best", type: "rank", instructions: "Which plan fits?", items: [{ id: "a", label: "Basic" }, { id: "b", label: "Pro" }] },
];

describe("validation", () => {
  test("a valid request: choices from an object, rank levels defaulted, thresholds kept", () => {
    const v = validateDecideInput({
      state: { msg: "x" }, thresholds: { team: 0.8 },
      questions: [{ name: "team", type: "choice", instructions: "Which?", choices: { billing: "Charges", support: "Other" } }, { name: "r", type: "rank", instructions: "Rank", items: ["a", "b"] }],
    });
    expect(v.questions[0].choices).toEqual([{ value: "billing", description: "Charges" }, { value: "support", description: "Other" }]);
    expect(v.questions[1].levels).toHaveLength(5);
    expect(v.questions[1].items).toEqual([{ id: "1", label: "a" }, { id: "2", label: "b" }]);
  });

  test("every problem is listed", () => {
    let err: DecisionError | undefined;
    try { validateDecideInput({ state: "", questions: [{ name: "1bad", type: "choice", instructions: "", choices: [{ value: "x" }] }, { name: "q", type: "nope" }], thresholds: 2 }); } catch (e) { err = e as DecisionError; }
    expect(err).toBeInstanceOf(DecisionError);
    expect(err!.status).toBe(400);
    expect(err!.problems).toEqual(expect.arrayContaining([
      expect.stringContaining("state is required"), expect.stringContaining("questions[0].name"), expect.stringContaining("questions[0].instructions"),
      expect.stringContaining("at least 2 options"), expect.stringContaining("questions[1].type"), "thresholds must be between 0 and 1",
    ]));
  });

  test("the decision model setting: a string (default gateway) or an object with a vault entry and a fallback", () => {
    expect(parseDecisionModel("vercel-ai-gateway:typesafe-ai/jev")).toEqual({ gateway: "vercel-ai-gateway", model: "typesafe-ai/jev" });
    expect(parseDecisionModel("typesafe-ai/jev")).toEqual({ gateway: "vercel-ai-gateway", model: "typesafe-ai/jev" });
    expect(parseDecisionModel({ model: "typesafe-ai/jev", credentialRef: { owner: "polpo-infra", service: "vercel-ai-gateway" }, credentialField: "token", fallback: { model: "openai/gpt", confidenceBelow: 0.7 } }))
      .toEqual({ gateway: "vercel-ai-gateway", model: "typesafe-ai/jev", credentialRef: { owner: "polpo-infra", service: "vercel-ai-gateway" }, credentialField: "token", fallback: { model: "openai/gpt", confidenceBelow: 0.7 } });
    expect(() => parseDecisionModel({ model: "x", credentialRef: { owner: "$channels", service: "y" } })).toThrow(/vault entry/);
    expect(parseDecisionModel(undefined)).toBeUndefined();
  });
});

describe("Vercel AI Gateway Decisions format", () => {
  test("request: text input, typed questions (rank expanded into one score per item), fallback and zero data retention", () => {
    const wire = expandQuestions(QUESTIONS);
    expect(wire.map((q) => [q.name, q.type])).toEqual([["refund", "predicate"], ["team", "choice"], ["severity", "score"], ["best__item1", "score"], ["best__item2", "score"]]);
    const body = decisionsRequestBody("typesafe-ai/jev", "I was charged twice", wire, { fallback: { model: "openai/gpt-6-luna", confidenceBelow: 0.6 }, zeroDataRetention: true });
    expect(body).toMatchObject({
      model: "typesafe-ai/jev", input: "I was charged twice",
      providerOptions: { gateway: { models: [{ model: "openai/gpt-6-luna", when: { confidenceBelow: 0.6 } }], zeroDataRetention: true } },
    });
    const qs = body.questions as Array<Record<string, unknown>>;
    expect(qs[0]).toEqual({ type: "predicate", name: "refund", instructions: "Is the customer asking for money back?" });
    expect(qs[1]).toMatchObject({ type: "choice", choices: [{ value: "billing", description: "Charges" }, { value: "support" }] });
    expect(qs[2]).toMatchObject({ type: "score", levels: [{ label: "Low" }, { label: "Medium" }, { label: "High" }] });
    expect(qs[2].instructions).toContain("1. Medium: Workaround");
    expect(qs[3].instructions).toContain("Rate this item: Basic");
  });

  test("request: JSON state is one user message with an input_json part; a plain fallback model", () => {
    const body = decisionsRequestBody("m", { order: 1 }, expandQuestions([QUESTIONS[0]]), { fallback: { model: "other" } });
    expect(body.input).toEqual([{ role: "user", content: [{ type: "input_json", data: { order: 1 } }] }]);
    expect(body.providerOptions).toEqual({ gateway: { models: ["other"] } });
  });

  test("response: every type (arrays or keyed objects; probabilities by value, label or index), usage and cost", () => {
    const wire = expandQuestions(QUESTIONS);
    const r = parseDecisionsResponse({
      model: "typesafe-ai/jev",
      answers: [
        { type: "predicate", name: "refund", probability: 0.92 },
        { type: "choice", name: "team", choice: "billing", probabilities: [{ value: "billing", probability: 0.8 }, { value: "support", probability: 0.2 }] },
        { type: "score", name: "severity", score: 1.6, probabilities: { 0: 0.1, 1: 0.2, 2: 0.7 } },
        { type: "score", name: "best__item1", score: 1, probabilities: { Poor: 0, "1": 1 } },
        { type: "score", name: "best__item2", score: 3.5, confidence: 0.4 },
      ],
      usage: { input_tokens: 120, output_tokens: 8 },
      provider_metadata: { gateway: { cost: "0.00042" } },
    }, wire);
    expect(r.model).toBe("typesafe-ai/jev");
    expect(r.usage).toEqual({ inputTokens: 120, outputTokens: 8 });
    expect(r.costUsd).toBeCloseTo(0.00042);
    const answers = buildAnswers(QUESTIONS, wire, r.answers, { severity: 0.8 });
    expect(answers[0]).toMatchObject({ name: "refund", value: true, probability: 0.92, confidence: 0.92, uncertain: false });
    expect(answers[1]).toMatchObject({ choice: "billing", probabilities: { billing: 0.8, support: 0.2 }, confidence: 0.8 });
    expect(answers[2]).toMatchObject({ score: 1.6, level: "High", probabilities: { Low: 0.1, Medium: 0.2, High: 0.7 }, confidence: 0.7, threshold: 0.8, uncertain: true });
    expect(answers[3].ranking!.map((x) => x.label)).toEqual(["Pro", "Basic"]);
    expect(answers[3].confidence).toBe(0.4);
    expect(describeDecisionAnswer(answers[0])).toBe("refund: yes (P(yes) 0.92)");
    expect(describeDecisionAnswer(answers[3])).toContain("best: Pro > Basic");
  });

  test("response: keyed answers, a missing answer and a refusal are errors (502)", () => {
    const wire = expandQuestions([QUESTIONS[0], QUESTIONS[1]]);
    const ok = parseDecisionsResponse({ answers: { refund: { type: "predicate", probability: 0.1 }, team: { type: "choice", probabilities: { billing: 0.3, support: 0.7 } } } }, wire);
    expect(ok.answers[1].choice).toBe("support");
    expect(() => parseDecisionsResponse({ answers: [{ name: "refund", probability: 0.2 }] }, wire)).toThrow(/no answer to "team"/);
    expect(() => parseDecisionsResponse({ answers: [{ name: "refund", type: "refusal" }, { name: "team", choice: "billing" }] }, wire)).toThrow(/refused.*refund/);
    expect(() => parseDecisionsResponse({ answers: [{ name: "refund", probability: 0.2 }, { name: "team", choice: "sales" }] }, wire)).toThrow(/not one of its options/);
  });

  test("thresholds: a number for all, a question's own wins; unknown confidence with a threshold is uncertain", () => {
    const qs: DecisionQuestion[] = [{ name: "a", type: "predicate", instructions: "?", threshold: 0.95 }, { name: "b", type: "choice", instructions: "?", choices: [{ value: "x" }, { value: "y" }] }];
    const wire = expandQuestions(qs);
    const answers = buildAnswers(qs, wire, [{ name: "a", probability: 0.9 }, { name: "b", choice: "x" }], 0.5);
    expect(answers[0]).toMatchObject({ threshold: 0.95, uncertain: true });
    expect(answers[1]).toMatchObject({ threshold: 0.5, uncertain: true });
    expect(answers[1].confidence).toBeUndefined();
  });

  test("TypeSafe's native schema from the same questions", () => {
    const t = typeSafeRequestBody({ a: 1 }, expandQuestions(QUESTIONS.slice(0, 3)));
    expect(t.state).toEqual({ a: 1 });
    expect(t.questions.refund).toEqual({ type: "choice", instructions: QUESTIONS[0].instructions, criteria: { yes: "Yes", no: "No" } });
    expect(t.questions.team.criteria).toEqual({ billing: "Charges", support: "support" });
    expect(t.questions.severity.criteria).toEqual(["Low", "Medium: Workaround", "High"]);
  });

  test("the uncalibrated fallback: prompt and normalized answers", () => {
    const wire = expandQuestions(QUESTIONS.slice(0, 3));
    expect(fallbackDecisionPrompt("state text", wire)).toContain('"severity" (score)');
    const answers = parseFallbackDecision('```json\n{"answers":{"refund":{"probability":0.3},"team":{"probabilities":{"billing":2,"support":2}},"severity":{"probabilities":{"0":0,"1":1,"2":1}}}}\n```', wire);
    expect(answers[0].probability).toBe(0.3);
    expect(answers[1].probabilities).toEqual({ billing: 0.5, support: 0.5 });
    expect(answers[2].score).toBeCloseTo(1.5);
    expect(() => parseFallbackDecision('{"answers":{}}', wire)).toThrow(/no answer for "refund"/);
  });
});

describe("the gateway resolver", () => {
  test("gateways come from the presets: Vercel AI Gateway offers decisions, OpenRouter does not", () => {
    expect(gatewaysWith("decisions").map((g) => g.id)).toEqual(["vercel-ai-gateway"]);
    expect(gatewayDefinition("vercel-ai-gateway")).toMatchObject({ baseUrl: "https://ai-gateway.vercel.sh/v1", envVar: "AI_GATEWAY_API_KEY", allowedHosts: ["ai-gateway.vercel.sh"] });
    expect(gatewayDefinition("openrouter")?.capabilities).toEqual([]);
  });

  test("a vault entry (a chosen field) wins; the env var is the fallback only when no entry is chosen", async () => {
    const v = vault({ "polpo-infra/vercel-ai-gateway": { token: "vck_from_vault", other: "x" } });
    const fromVault = await resolveGateway("vercel-ai-gateway", { credentialRef: { owner: "polpo-infra", service: "vercel-ai-gateway" }, credentialField: "token" }, { vault: v, env: { AI_GATEWAY_API_KEY: "env-key" }, capability: "decisions" });
    expect(fromVault).toMatchObject({ key: "vck_from_vault", keySource: { kind: "vault", field: "token" }, headers: { authorization: "Bearer vck_from_vault" } });
    const picked = await resolveGateway("vercel-ai-gateway", { credentialRef: { owner: "polpo-infra", service: "vercel-ai-gateway" } }, { vault: v, env: {} });
    expect(picked.key).toBe("vck_from_vault");
    const fromEnv = await resolveGateway("vercel-ai-gateway", {}, { env: { AI_GATEWAY_API_KEY: "env-key" } });
    expect(fromEnv).toMatchObject({ key: "env-key", keySource: { kind: "env", envVar: "AI_GATEWAY_API_KEY" } });
    await expect(resolveGateway("vercel-ai-gateway", { credentialRef: { owner: "x", service: "missing" } }, { vault: v, env: { AI_GATEWAY_API_KEY: "env-key" } })).rejects.toMatchObject({ code: "vault_missing" });
    await expect(resolveGateway("vercel-ai-gateway", { credentialRef: { owner: "polpo-infra", service: "vercel-ai-gateway" }, credentialField: "nope" }, { vault: v })).rejects.toMatchObject({ code: "vault_field" });
    await expect(resolveGateway("vercel-ai-gateway", {}, { env: {} })).rejects.toMatchObject({ code: "no_key" });
    await expect(resolveGateway("openrouter", {}, { env: { OPENROUTER_API_KEY: "k" }, capability: "decisions" })).rejects.toMatchObject({ code: "unsupported" });
    await expect(resolveGateway("nope", {})).rejects.toBeInstanceOf(GatewayError);
  });

  test("the key only goes to the gateway's own https host", () => {
    expect(gatewayUrl({ baseUrl: "https://ai-gateway.vercel.sh/v1", allowedHosts: ["ai-gateway.vercel.sh"], label: "V" }, "decisions")).toBe("https://ai-gateway.vercel.sh/v1/decisions");
    expect(() => assertGatewayHost("https://evil.example/v1/decisions", ["ai-gateway.vercel.sh"])).toThrow(/only go to/);
    expect(() => assertGatewayHost("http://ai-gateway.vercel.sh/v1", ["ai-gateway.vercel.sh"])).toThrow(GatewayError);
    expect(() => assertGatewayHost("https://user:pw@ai-gateway.vercel.sh/v1", ["ai-gateway.vercel.sh"])).toThrow(GatewayError);
  });
});

describe("the decision service", () => {
  let dir: string | undefined;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; });
  const make = (settings: Record<string, unknown>, extra: Partial<ConstructorParameters<typeof DecisionService>[0]> = {}) => {
    dir = mkdtempSync(join(tmpdir(), "polpo-decisions-"));
    const d = dir;
    return new DecisionService({ polpoDir: () => d, settings: () => settings as never, vault: () => undefined, env: () => ({}), ...extra });
  };

  test("a gateway call: the Decisions request with the key, answers, usage recorded, logged and announced", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({
      model: "typesafe-ai/jev", answers: [{ type: "predicate", name: "refund", probability: 0.97 }],
      usage: { input_tokens: 50, output_tokens: 2 }, provider_metadata: { gateway: { cost: 0.0001 } },
    }), { status: 200 }));
    const usage = vi.fn(async () => {});
    const emit = vi.fn();
    const s = make({ decisionModel: { model: "typesafe-ai/jev", credentialRef: { owner: "polpo-infra", service: "vercel-ai-gateway" }, credentialField: "token" } }, {
      vault: () => vault({ "polpo-infra/vercel-ai-gateway": { token: "vck_secret_value" } }), fetch: fetchMock as unknown as typeof fetch, recordUsage: usage, emit,
    });
    const r = await s.decide({ state: "Charged twice, refund please", questions: [QUESTIONS[0]] }, { kind: "api", by: "ada@example.com" });
    expect(r).toMatchObject({ model: "vercel-ai-gateway:typesafe-ai/jev", calibrated: true, costUsd: 0.0001, uncertain: false, answers: [{ name: "refund", value: true }] });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://ai-gateway.vercel.sh/v1/decisions");
    expect((init!.headers as Record<string, string>).authorization).toBe("Bearer vck_secret_value");
    expect(JSON.parse(init!.body as string)).toMatchObject({ model: "typesafe-ai/jev", input: "Charged twice, refund please" });
    expect(usage).toHaveBeenCalledWith({ provider: "vercel-ai-gateway", model: "typesafe-ai/jev", inputTokens: 50, outputTokens: 2, cost: 0.0001 });
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ id: r.id, caller: "api", status: "ok", calibrated: true }));
    const entry = s.store.get(r.id)!;
    expect(entry).toMatchObject({ caller: { kind: "api", by: "ada@example.com" }, state: "Charged twice, refund please", status: "ok" });
    expect(entry.stateHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(entry)).not.toContain("vck_secret_value");
    expect(s.store.list().decisions[0].questions).toEqual([{ name: "refund", type: "predicate" }]);
    const status = await s.status();
    expect(status).toMatchObject({ configured: true, model: "vercel-ai-gateway:typesafe-ai/jev", key: { ok: true, source: "vault", detail: "vault polpo-infra / vercel-ai-gateway (token)" } });
    expect(JSON.stringify(status)).not.toContain("vck_secret_value");
  });

  test("not configured: a 409 with a link to Settings (default), nothing called", async () => {
    const s = make({});
    await expect(s.decide({ state: "x", questions: [QUESTIONS[0]] }, { kind: "api" })).rejects.toMatchObject({ status: 409, code: "NOT_CONFIGURED", message: expect.stringContaining("/config?section=decisions") });
    expect((await s.status()).configured).toBe(false);
  });

  test("not configured with the orchestrator fallback: Polpo's chat answers, calibrated false", async () => {
    const chatTurn = vi.fn(async (_prompt: string, check: (t: string) => string | undefined) => {
      expect(check("not json")).toBeTruthy();
      return { text: '{"answers":{"refund":{"probability":0.2}}}', model: "Polpo (claude-x)", costUsd: 0.002 };
    });
    const s = make({ decisions: { unconfigured: "orchestrator" } }, { chatTurn });
    const r = await s.decide({ state: "Thanks!", questions: [{ ...QUESTIONS[0], threshold: 0.9 }] }, { kind: "chat" });
    expect(r).toMatchObject({ calibrated: false, model: "Polpo (claude-x)", costUsd: 0.002, uncertain: true, answers: [{ value: false, probability: 0.2 }] });
    expect(chatTurn.mock.calls[0][0]).toContain("## State\nThanks!");
    expect(s.store.get(r.id)).toMatchObject({ calibrated: false, caller: { kind: "chat" } });
  });

  test("an upstream error is a 502, never echoes the key, and is logged as an error; storeInputs hash keeps no state", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: { message: "bad key vck_secret_value" } }), { status: 401 }));
    const s = make({ decisionModel: "vercel-ai-gateway:typesafe-ai/jev", decisions: { storeInputs: "hash" } }, { env: () => ({ AI_GATEWAY_API_KEY: "vck_secret_value" }), fetch: fetchMock as unknown as typeof fetch });
    const err = await s.decide({ state: "x", questions: [QUESTIONS[0]] }, { kind: "api" }).catch((e) => e as DecisionError);
    expect(err).toMatchObject({ status: 502, code: "UPSTREAM" });
    expect(err.message).toContain("HTTP 401");
    expect(err.message).not.toContain("vck_secret_value");
    const logged = s.store.list({ status: "error" }).decisions[0];
    expect(logged).toMatchObject({ status: "error", model: "vercel-ai-gateway:typesafe-ai/jev" });
    expect(s.store.get(logged.id)!.state).toBeUndefined();
  });

  test("a missing key is a 409 pointing to Settings; the log keeps at most `retention` decisions", async () => {
    const s = make({ decisionModel: "vercel-ai-gateway:typesafe-ai/jev", decisions: { retention: 2 } });
    await expect(s.decide({ state: "x", questions: [QUESTIONS[0]] }, { kind: "api" })).rejects.toMatchObject({ status: 409, message: expect.stringContaining("AI_GATEWAY_API_KEY") });
    await s.decide({ state: "x", questions: [QUESTIONS[0]] }, { kind: "api" }).catch(() => {});
    await s.decide({ state: "x", questions: [QUESTIONS[0]] }, { kind: "api" }).catch(() => {});
    expect(s.store.list().total).toBe(2);
  });
});

describe("mission decision nodes", () => {
  const node = (over: Partial<MissionDecision> = {}): MissionDecision => ({
    name: "route", afterTasks: ["Triage"], question: { type: "choice", instructions: "Which team?", choices: [{ value: "billing" }, { value: "support" }] },
    branches: { billing: ["Refund"], support: ["Reply"] }, ...over,
  });
  const ans = (o: Record<string, unknown>) => ({ name: "decision", uncertain: false, ...o }) as never;

  test("branches by answer: predicate yes/no, choice value, score range or label, rank", () => {
    expect(decisionNodeBranch(node(), ans({ type: "choice", choice: "support" }))).toBe("support");
    const p = node({ question: { type: "predicate", instructions: "?" }, branches: { yes: ["A"], no: ["B"] } });
    expect(decisionNodeBranch(p, ans({ type: "predicate", value: true }))).toBe("yes");
    expect(decisionNodeBranch(p, ans({ type: "predicate", value: false }))).toBe("no");
    const s = node({ question: { type: "score", instructions: "?", levels: ["Low", "Mid", "High"] }, branches: { "0-1": ["A"], High: ["B"] } });
    expect(decisionNodeBranch(s, ans({ type: "score", score: 0.7 }))).toBe("0-1");
    expect(decisionNodeBranch(s, ans({ type: "score", score: 1.8 }))).toBe("High");
    expect(decisionNodeBranch(node({ question: { type: "rank", instructions: "?", items: ["a", "b"] }, branches: { ranked: ["Use"] } }), ans({ type: "rank", ranking: [] }))).toBe("ranked");
    expect(decisionNodeBranch(node({ branches: { billing: ["Refund"] } }), ans({ type: "choice", choice: "support" }))).toBeUndefined();
  });

  test("state and rank items from the after tasks' results", () => {
    const tasks = [{ title: "Triage", status: "done", result: { stdout: "- Basic\n- Pro\n" } }];
    expect(renderDecisionNodeState({ afterTasks: ["Triage"] }, tasks)).toBe("## Triage\n- Basic\n- Pro");
    expect(renderDecisionNodeState({ afterTasks: ["Triage"], state: "Plans: {{tasks.Triage}}" }, tasks)).toBe("Plans: - Basic\n- Pro");
    expect(decisionNodeItems({ afterTasks: ["Triage"], question: { type: "rank", instructions: "?", items: "{{tasks.Triage}}" } }, tasks)).toEqual([{ id: "1", label: "Basic" }, { id: "2", label: "Pro" }]);
  });

  test("a mission document with decisions is validated (unknown tasks, branches matching no answer, onUncertain)", () => {
    const doc = {
      tasks: [{ title: "Triage", description: "t" }, { title: "Refund", description: "r", dependsOn: ["Triage"] }, { title: "Reply", description: "r" }],
      decisions: [node()],
    };
    expect(() => parseMissionDocument(doc)).not.toThrow();
    const titles = new Set(["Triage", "Refund", "Reply"]);
    const deps = new Map([["Triage", new Set<string>()], ["Refund", new Set(["Triage"])], ["Reply", new Set<string>()]]);
    expect(missionDecisionProblems(node({ branches: { sales: ["Nope"] }, onUncertain: { branch: "x" } }), titles, deps)).toEqual(expect.arrayContaining([
      expect.stringContaining('branch "sales" matches no answer'), expect.stringContaining('unknown task "Nope"'), expect.stringContaining("onUncertain"),
    ]));
    expect(() => parseMissionDocument({ ...doc, decisions: [node({ afterTasks: ["Refund"] })] })).toThrow(/cannot be both before/);
  });
});

describe("the suites' decision scorer", () => {
  test("predicate, choice and score answers become scores", () => {
    const pred = { type: "decision", question: "predicate", instructions: "Is it polite?" } as Extract<SuiteScorer, { type: "decision" }>;
    const req = decisionScorerRequest(pred, { trace: { input: [{ role: "user", content: "hi" }], text: "Hello!", toolCalls: [], turns: [], usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 }, durationMs: 1, notes: [], approvals: [] } as never });
    expect(req.state).toEqual({ message: "hi", reply: "Hello!" });
    expect(req.questions[0]).toMatchObject({ name: "check", type: "predicate" });
    expect(decisionScore(pred, { name: "check", type: "predicate", probability: 0.9, uncertain: false }).score).toBe(0.9);
    expect(decisionScore({ ...pred, expected: false }, { name: "check", type: "predicate", probability: 0.9, uncertain: false }).score).toBeCloseTo(0.1);
    const choice = { type: "decision", question: "choice", instructions: "Tone?", choices: [{ value: "formal" }, { value: "casual" }], expected: "formal" } as Extract<SuiteScorer, { type: "decision" }>;
    expect(decisionScore(choice, { name: "check", type: "choice", choice: "casual", probabilities: { formal: 0.3, casual: 0.7 }, uncertain: false }).score).toBe(0.3);
    const score = { type: "decision", question: "score", instructions: "Quality?", levels: ["bad", "ok", "great"] } as Extract<SuiteScorer, { type: "decision" }>;
    expect(decisionScore(score, { name: "check", type: "score", score: 1.5, uncertain: false }).score).toBe(0.75);
  });
});
