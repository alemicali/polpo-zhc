/**
 * Decisions end to end on a real instance (orchestrator + createApp): Settings (decisionModel with
 * a vault entry), POST /api/v1/decide through the shared gateway resolver to a mocked Vercel AI
 * Gateway (no real call), the decision log and status, the event on the bus, the MCP tools with
 * their scopes and the card, and the agents' decide tool.
 */
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Orchestrator } from "../core/orchestrator.js";
import { handleMcpRequest, type McpDeps } from "../server/mcp.js";
import { createDecisionTools } from "../tools/decision-tools.js";

let tmpDir: string;
let app: any;
let orchestrator: Orchestrator;
const KEY = "test-api-key";
const GATEWAY_KEY = "vck_e2e_secret_value";
const gatewayCalls: Array<{ url: string; auth?: string; body: any }> = [];

const api = (path: string, init?: { method?: string; body?: unknown }) => app.request(`/api/v1${path}`, {
  method: init?.method ?? (init?.body !== undefined ? "POST" : "GET"),
  headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
  ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
});
const json = async (res: Response) => (await res.json()) as { ok: boolean; data: any; error?: string; code?: string; details?: string[] };

/** A fake Vercel AI Gateway Decisions API: answers every question from the request. */
function gatewayAnswer(body: any) {
  return {
    model: body.model,
    answers: body.questions.map((q: any) => q.type === "predicate" ? { type: "predicate", name: q.name, probability: 0.88 }
      : q.type === "choice" ? { type: "choice", name: q.name, choice: q.choices[0].value, probabilities: Object.fromEntries(q.choices.map((c: any, i: number) => [c.value, i === 0 ? 0.6 : 0.4 / (q.choices.length - 1)])) }
      : { type: "score", name: q.name, score: q.name.endsWith("item2") ? 3.4 : 1.2, probabilities: Object.fromEntries(q.levels.map((_: unknown, i: number) => [String(i), i === 1 ? 0.8 : 0.2 / (q.levels.length - 1)])) }),
    usage: { input_tokens: 40, output_tokens: 3 },
    provider_metadata: { gateway: { cost: 0.00021 } },
  };
}

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "polpo-decisions-e2e-"));
  await mkdir(join(tmpDir, ".polpo"), { recursive: true });
  await writeFile(join(tmpDir, ".polpo", "polpo.json"), JSON.stringify({ project: "decisions-e2e", team: { name: "t", agents: [] }, settings: { logLevel: "quiet" } }));
  const { Orchestrator: O } = await import("../core/orchestrator.js");
  const { SSEBridge } = await import("../server/sse-bridge.js");
  const { createApp } = await import("../server/app.js");
  orchestrator = new O(tmpDir);
  await orchestrator.initInteractive("decisions-e2e", { name: "t", agents: [] });
  const bridge = new SSEBridge(orchestrator);
  bridge.start();
  app = createApp(orchestrator, bridge, { apiKeys: [KEY] });
  const real = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith("https://ai-gateway.vercel.sh/")) return real(input, init);
    const body = JSON.parse(init.body);
    gatewayCalls.push({ url, auth: init.headers?.authorization, body });
    return new Response(JSON.stringify(gatewayAnswer(body)), { status: 200, headers: { "content-type": "application/json" } });
  });
}, 60_000);

afterAll(async () => {
  vi.restoreAllMocks();
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
});

describe("decisions over REST on a real instance", () => {
  test("not configured → 409 with the Settings link; configured with a vault entry → answers from the gateway, logged, announced", async () => {
    const none = await api("/decide", { body: { state: "x", questions: [{ name: "q", type: "predicate", instructions: "?" }] } });
    expect(none.status).toBe(409);
    expect((await json(none)).error).toContain("/config?section=decisions");
    expect((await json(await api("/decisions/status"))).data).toMatchObject({ configured: false, unconfigured: "error", gateways: [{ id: "vercel-ai-gateway" }] });

    await orchestrator.getVaultStore()!.set("polpo-infra", "vercel-ai-gateway", { type: "api_key", credentials: { token: GATEWAY_KEY } });
    const bad = await api("/config/settings", { method: "PATCH", body: { decisionModel: "openrouter:x" } });
    expect(bad.status).toBe(400);
    const saved = await api("/config/settings", { method: "PATCH", body: {
      decisionModel: { gateway: "vercel-ai-gateway", model: "typesafe-ai/jev", credentialRef: { owner: "polpo-infra", service: "vercel-ai-gateway" }, credentialField: "token" },
      decisions: { retention: 50 },
    } });
    expect(saved.status).toBe(200);
    const status = (await json(await api("/decisions/status"))).data;
    expect(status).toMatchObject({ configured: true, model: "vercel-ai-gateway:typesafe-ai/jev", key: { ok: true, source: "vault" }, retention: 50 });
    expect(JSON.stringify(status)).not.toContain(GATEWAY_KEY);

    const seen: any[] = [];
    const on = (p: any) => seen.push(p);
    orchestrator.on("decision:made", on);
    const r = await json(await api("/decide", { body: {
      state: { ticket: "I was charged twice" }, thresholds: { team: 0.7 },
      questions: [
        { name: "refund", type: "predicate", instructions: "Refund?" },
        { name: "team", type: "choice", instructions: "Team?", choices: [{ value: "billing" }, { value: "support" }] },
        { name: "plan", type: "rank", instructions: "Best plan?", items: ["Basic", "Pro"] },
      ],
    } }));
    orchestrator.off("decision:made", on);
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({ model: "vercel-ai-gateway:typesafe-ai/jev", calibrated: true, costUsd: 0.00021, uncertain: true });
    expect(r.data.answers[0]).toMatchObject({ name: "refund", value: true, probability: 0.88 });
    expect(r.data.answers[1]).toMatchObject({ choice: "billing", confidence: 0.6, uncertain: true });
    expect(r.data.answers[2].ranking.map((x: any) => x.label)).toEqual(["Pro", "Basic"]);
    const call = gatewayCalls.at(-1)!;
    expect(call.url).toBe("https://ai-gateway.vercel.sh/v1/decisions");
    expect(call.auth).toBe(`Bearer ${GATEWAY_KEY}`);
    expect(call.body.input).toEqual([{ role: "user", content: [{ type: "input_json", data: { ticket: "I was charged twice" } }] }]);
    expect(seen).toEqual([expect.objectContaining({ id: r.data.id, caller: "api", status: "ok", uncertain: true })]);

    const log = (await json(await api("/decisions"))).data;
    expect(log.decisions[0]).toMatchObject({ id: r.data.id, caller: { kind: "api" }, questions: [{ name: "refund", type: "predicate" }, { name: "team", type: "choice" }, { name: "plan", type: "rank" }] });
    const one = (await json(await api(`/decisions/${r.data.id}`))).data;
    expect(one.state).toContain("I was charged twice");
    expect((await api("/decisions/dec_000000000000")).status).toBe(404);
    expect((await json(await api("/decisions?uncertain=false"))).data.total).toBe(0);
    const invalid = await json(await api("/decide", { body: { state: "x", questions: [{ name: "q", type: "choice", instructions: "?", choices: [{ value: "a" }] }] } }));
    expect(invalid).toMatchObject({ ok: false, code: "INVALID" });
    expect((await json(await api("/decisions/nodes"))).data).toEqual([]);
  }, 30_000);
});

describe("decisions over MCP and the agents' tool (on the real instance)", () => {
  const mcp = (scopes: string[]) => {
    const deps: McpDeps = {
      version: "x", toolsets: ["all"], principal: { kind: "oauth", actor: "ada@example.com via Claude", scopes },
      api: async (method, path, body) => {
        const res = await app.request(path, { method, headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
        return { status: res.status, body: await res.json(), headers: res.headers };
      },
    };
    const rpc = (method: string, params: Record<string, unknown>) => handleMcpRequest(new Request("http://localhost/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }), deps).then(async (res) => (await res.json()).result);
    return { call: (name: string, args: Record<string, unknown>) => rpc("tools/call", { name, arguments: args }), list: () => rpc("tools/list", {}) };
  };

  test("read sees the log and the card; work decides; the card draws probability bars", async () => {
    const names = async (scopes: string[]) => ((await mcp(scopes).list()).tools as Array<{ name: string }>).map((t) => t.name).filter((n) => n.startsWith("polpo_decision") || n === "polpo_decide");
    expect((await names(["polpo:read"])).sort()).toEqual(["polpo_decision_show", "polpo_decisions"]);
    expect((await names(["polpo:work"])).sort()).toEqual(["polpo_decide", "polpo_decision_resolve", "polpo_decision_show", "polpo_decisions"]);

    const work = mcp(["polpo:work"]);
    const r = await work.call("polpo_decide", { state: "Love the product, but the invoice is wrong", questions: [{ name: "complaint", type: "predicate", instructions: "Is it a complaint?" }] });
    expect(r.isError).toBeFalsy();
    expect(r.content[0].text).toContain("complaint: yes (P(yes) 0.88)");
    const id = r.structuredContent.id as string;

    const read = mcp(["polpo:read"]);
    const log = await read.call("polpo_decisions", {});
    expect(log.content[0].text).toContain(id);
    const card = await read.call("polpo_decision_show", { id });
    expect(card.structuredContent).toMatchObject({ kind: "decision", decision: { id, answers: [{ name: "complaint", headline: "yes", bars: [{ label: "yes", value: 0.88, chosen: true }, { label: "no" }] }] } });
    expect(card.content[0].text).toContain("complaint: yes");
    expect((await read.call("polpo_decision_show", {})).structuredContent.kind).toBe("decisions");
    expect((await work.call("polpo_decision_resolve", { group: "nope", node: "x", branch: null })).isError).toBe(true);
  }, 30_000);

  test("the agents' decide tool: only with allowedTools decide; logged with the agent as caller", async () => {
    expect(createDecisionTools(orchestrator.getPolpoDir(), "writer", ["read"])).toEqual([]);
    const [tool] = createDecisionTools(orchestrator.getPolpoDir(), "writer", ["decide"], { taskId: "t1" });
    const out = await tool.execute("call-1", { state: "Ship it?", questions: [{ name: "ship", type: "predicate", instructions: "Ready to ship?" }] }, undefined as never);
    expect(out.content[0].text).toContain("ship: yes");
    expect(out.details).toMatchObject({ calibrated: true });
    const log = (await json(await api("/decisions?caller=agent&callerId=writer"))).data;
    expect(log.decisions[0]).toMatchObject({ caller: { kind: "agent", id: "writer", label: "task t1" } });
    const bad = await tool.execute("call-2", { state: "x", questions: [] }, undefined as never);
    expect(bad.content[0].text).toMatch(/^Error: questions needs at least one question/);
  }, 30_000);
});
