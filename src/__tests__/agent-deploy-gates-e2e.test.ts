/**
 * Deploy gates end to end (agent suites phase 3) on a real instance: suites marked required run
 * against a version before a deploy, through REST (202 pending → passed and deployed; 409 blocked,
 * recorded in the history), the auto-deploy of API updates (published, not deployed), an admin's
 * override (and a non-admin refused), rollbacks never gated, publish checks, events (agent:gate),
 * MCP (polpo_agent_deploy, polpo_agent_deploy_gates, the suite card) and Polpo's chat tool.
 * Offline suites only (scripted model, mocked tools): the model provider must never be called.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { vi } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { trustedApiCallHeaders } from "@polpo-ai/server";
import type { Orchestrator } from "../core/orchestrator.js";
import { withEventOrigin } from "../core/events.js";
import { handleMcpRequest, type McpDeps } from "../server/mcp.js";

let streamSimpleImpl: (...args: unknown[]) => unknown;
const providerCalls: unknown[] = [];

async function buildMockPiModule(importOriginal: () => Promise<unknown>) {
  const { buildPiAiMock, mockTextStream } = await import("./helpers/mock-llm.js");
  streamSimpleImpl ??= () => mockTextStream("Default mock response.");
  const base = buildPiAiMock((...args: unknown[]) => streamSimpleImpl(...args) as any);
  const { validateToolArguments } = await importOriginal() as { validateToolArguments: unknown };
  return { ...base, validateToolArguments, streamSimple: (...args: unknown[]) => streamSimpleImpl(...args) };
}
vi.mock("@earendil-works/pi-ai", (importOriginal) => buildMockPiModule(importOriginal));
vi.mock("@earendil-works/pi-ai/compat", (importOriginal) => buildMockPiModule(importOriginal));
vi.mock("@earendil-works/pi-ai/providers/all", async () => {
  const { mockModel } = await import("./helpers/mock-llm.js");
  return { getBuiltinModel: () => mockModel(), getBuiltinModels: () => [mockModel()], getBuiltinProviders: () => ["anthropic"] };
});
vi.mock("../llm/pi-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../llm/pi-client.js")>();
  const { mockModel } = await import("./helpers/mock-llm.js");
  return {
    ...actual,
    resolveModel: () => mockModel(),
    resolveModelSpec: (spec: unknown) => spec ?? "anthropic:mock-model",
    resolveApiKeyAsync: async () => "mock-api-key",
    streamSimpleWithAuth: (...args: unknown[]) => { providerCalls.push(args[0]); return streamSimpleImpl(...args); },
    completeSimpleWithAuth: async () => { throw new Error("completeSimple must not be called in these tests"); },
    buildStreamOpts: () => undefined,
  };
});

let tmpDir: string;
let app: any;
let orchestrator: Orchestrator;
const gateEvents: Array<{ agentName: string; status: string; version: string; summary: string }> = [];

const api = (path: string, init?: { method?: string; body?: unknown; headers?: Record<string, string> }) => app.request(`/api/v1${path}`, {
  method: init?.method ?? (init?.body !== undefined ? "POST" : "GET"),
  headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
});
const json = async (res: Response) => (await res.json()) as { ok: boolean; data: any; error?: string; code?: string };
/** A request made by an agent through the API (never an admin). */
const asAgent = (path: string, body: unknown, method = "POST") => withEventOrigin({ source: "agent", by: "helper" }, () => api(path, { method, body, headers: trustedApiCallHeaders() }));

/** An offline suite (scripted model): passes when the reply quotes 4.99. */
const suite = (name: string, reply: string, gate?: Record<string, unknown>) => ({
  name, defaultMode: "all",
  cases: [{
    name: "Quote", input: { kind: "chat", message: "How much is shipping to Italy?" },
    mocks: { model: { turns: [{ text: reply }] } },
    assertions: [{ type: "text_contains", value: "4.99" }],
  }],
  ...(gate ? { gate } : {}),
});

const AGENTS = ["shop", "desk", "api", "mcpa", "pub"].map((name) => ({ name, role: `${name} agent`, allowedTools: ["read"] }));

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "polpo-gates-e2e-"));
  await mkdir(join(tmpDir, ".polpo"), { recursive: true });
  await writeFile(join(tmpDir, ".polpo", "polpo.json"), JSON.stringify({ project: "gates-e2e", team: { name: "t", agents: AGENTS }, settings: { logLevel: "quiet" } }));
  const { Orchestrator: O } = await import("../core/orchestrator.js");
  const { SSEBridge } = await import("../server/sse-bridge.js");
  const { createApp } = await import("../server/app.js");
  orchestrator = new O(tmpDir);
  await orchestrator.initInteractive("gates-e2e", { name: "t", agents: AGENTS });
  orchestrator.on("agent:gate", (e: { agentName: string; status: string; version: string; summary: string }) => gateEvents.push(e));
  const bridge = new SSEBridge(orchestrator);
  bridge.start();
  app = createApp(orchestrator, bridge);
}, 60_000);

afterAll(async () => { if (tmpDir) await rm(tmpDir, { recursive: true, force: true }); });

beforeEach(() => {
  streamSimpleImpl = () => { throw new Error("the model provider was called"); };
});

/** Publish a change of `agent` (not deployed): its new version. */
async function publishChange(agent: string, prompt: string): Promise<string> {
  const r = await json(await api(`/agents/${agent}`, { method: "PATCH", body: { systemPrompt: prompt, publish: true } }));
  expect(r.ok).toBe(true);
  return r.data.versioning.published.version;
}
const production = async (agent: string) => (await json(await api(`/agents/${agent}/versions`))).data.state.production as string;

describe("deploy gates over REST", () => {
  test("required suites pass: 202 in verifica, then production moves; the history and the versions show the gate; agent:gate events", async () => {
    expect((await json(await api("/agents/shop/suites", { body: suite("Shipping", "Shipping to Italy is 4.99 EUR.", { required: true, minPassRate: 1 }) }))).ok).toBe(true);
    const version = await publishChange("shop", "Quote shipping politely.");
    const res = await api("/agents/shop/deploy", { body: { version, note: "ship" } });
    expect(res.status).toBe(202);
    const pending = await json(res);
    expect(pending.data).toMatchObject({ status: "pending", gate: { status: "running", version, from: "1.0.0", trigger: "deploy" } });
    const gate = (await json(await api(`/agents/shop/deploy-gates/${pending.data.gate.id}?wait=20`))).data;
    expect(gate).toMatchObject({ status: "passed", suites: [{ suiteName: "Shipping", status: "passed", passRate: 1 }] });
    expect(await production("shop")).toBe(version);

    const deploys = (await json(await api("/agents/shop/deploys"))).data;
    expect(deploys[0]).toMatchObject({ to: version, action: "deploy", note: "ship", gate: { status: "passed" } });
    const versions = (await json(await api("/agents/shop/versions"))).data;
    expect(versions.state.gate.requiredSuites).toEqual([{ id: "shipping", name: "Shipping", onPublish: false, allowRealTools: false }]);
    expect(versions.versions[0]).toMatchObject({ version, gate: { status: "passed", trigger: "deploy" } });
    // the gate's run is a deploy-triggered run against the version
    const runs = (await json(await api("/agents/shop/suite-runs"))).data;
    expect(runs[0]).toMatchObject({ trigger: "deploy", target: version, gate: { decision: "pass" } });
    expect(gateEvents.filter((e) => e.agentName === "shop").map((e) => e.status)).toContain("running");
    expect(gateEvents.filter((e) => e.agentName === "shop").at(-1)).toMatchObject({ status: "passed", version });
    expect(providerCalls).toHaveLength(0);
  });

  test("a failing required suite blocks (409 GATE_BLOCKED, recorded); a non-admin cannot override; an admin can, with a reason; rollback is never gated", async () => {
    await json(await api("/agents/desk/suites", { body: suite("Quotes", "I do not know.", { required: true }) }));
    const version = await publishChange("desk", "Answer the desk.");
    const res = await api("/agents/desk/deploy", { body: { version, wait: true } });
    expect(res.status).toBe(409);
    const blocked = await json(res);
    expect(blocked).toMatchObject({ ok: false, code: "GATE_BLOCKED", data: { status: "blocked", gate: { status: "blocked" } } });
    expect(blocked.error).toContain("Blocked by suites: Quotes: pass rate 0% < 100% (0/1 passed)");
    expect(await production("desk")).toBe("1.0.0");
    const history = (await json(await api("/agents/desk/deploys"))).data;
    expect(history[0]).toMatchObject({ action: "blocked", from: "1.0.0", to: version, gate: { status: "blocked", failed: ["Quotes: pass rate 0% < 100% (0/1 passed)"], suites: [{ suiteName: "Quotes", status: "failed" }] } });
    const gateId = blocked.data.gate.id;
    expect(blocked.data.gate.suites[0].failedCases[0]).toMatchObject({ caseName: "Quote", failed: [expect.stringContaining("4.99")] });

    // an agent (not an admin) cannot deploy past the suites
    const refused = await asAgent(`/agents/desk/deploy-gates/${gateId}/override`, { reason: "I insist" });
    expect(refused.status).toBe(403);
    const refused2 = await asAgent("/agents/desk/deploy", { version, override: { reason: "I insist" } });
    expect(refused2.status).toBe(403);
    expect(await production("desk")).toBe("1.0.0");

    // an admin (a dashboard member) can, with a reason
    const forced = await json(await api(`/agents/desk/deploy-gates/${gateId}/override`, { body: { reason: "Hotfix for the outage" } }));
    expect(forced.ok).toBe(true);
    expect(forced.data).toMatchObject({ status: "deployed", to: version, gate: { status: "override", override: { reason: "Hotfix for the outage", failed: ["Quotes: pass rate 0% < 100% (0/1 passed)"] } } });
    expect(await production("desk")).toBe(version);
    const after = (await json(await api("/agents/desk/deploys"))).data;
    expect(after[0]).toMatchObject({ action: "deploy", to: version, gate: { status: "override", override: { reason: "Hotfix for the outage" } } });

    // rollback: no suite runs, it always works
    const runsBefore = (await json(await api("/agents/desk/suite-runs"))).data.length;
    const rb = await json(await api("/agents/desk/rollback", { body: {} }));
    expect(rb.data).toMatchObject({ action: "rollback", to: "1.0.0" });
    expect((await json(await api("/agents/desk/suite-runs"))).data.length).toBe(runsBefore);
  });

  test("auto-deploy of an API update: published, not deployed, and the response says why", async () => {
    await json(await api("/agents/api/suites", { body: suite("Quotes", "No idea.", { required: true }) }));
    const r = await json(await api("/agents/api", { method: "PATCH", body: { systemPrompt: "Be helpful.", wait: true } }));
    expect(r.ok).toBe(true);
    expect(r.data.versioning).toMatchObject({
      mode: "deploy", published: { version: "1.0.1" }, deployStatus: "blocked", production: "1.0.0",
      gate: { status: "blocked", failed: ["Quotes: pass rate 0% < 100% (0/1 passed)"] },
    });
    expect(r.data.versioning.deployed).toBeUndefined();
    expect(r.data.versioning.warning).toContain("Published as 1.0.1 but not deployed: Blocked by suites");
    expect(r.data.systemPrompt).not.toBe("Be helpful.");
    // without wait: the response says the deploy is pending
    const p = await json(await api("/agents/api", { method: "PATCH", body: { systemPrompt: "Be very helpful." } }));
    expect(p.data.versioning).toMatchObject({ published: { version: "1.0.2" }, deployStatus: "pending", gate: { status: "running" } });
    await json(await api(`/agents/api/deploy-gates/${p.data.versioning.gate.id}?wait=20`));
  });

  test("a pending verification can be cancelled: nothing is deployed", async () => {
    // a slow mocked tool keeps the case running
    await json(await api("/agents/api/suites/quotes", { method: "PUT", body: {
      ...suite("Quotes", "4.99", { required: true }), id: "quotes",
      mocks: { tools: [{ tool: "read", response: "ok", delayMs: 3000 }] },
      cases: [{ name: "Slow", input: { kind: "chat", message: "go" }, mocks: { model: { turns: [{ toolCalls: [{ name: "read", args: { path: "a.txt" } }] }, { text: "4.99" }] } }, assertions: [] }],
    } }));
    const version = await publishChange("api", "Slow down.");
    const pending = await json(await api("/agents/api/deploy", { body: { version } }));
    expect(pending.data.status).toBe("pending");
    const cancelled = await json(await api(`/agents/api/deploy-gates/${pending.data.gate.id}/cancel`, { body: {} }));
    expect(cancelled.data).toMatchObject({ status: "cancelled" });
    expect(await production("api")).toBe("1.0.0");
    expect((await api(`/agents/api/deploy-gates/${pending.data.gate.id}/cancel`, { body: {} })).status).toBe(409);
  }, 30_000);

  test("publish checks annotate the version; gate.allowRealTools needs an admin", async () => {
    await json(await api("/agents/pub/suites", { body: suite("Shipping", "4.99 EUR", { required: true, onPublish: true }) }));
    const r = await json(await api("/agents/pub/publish", { body: {} }).then(async (res) => {
      // nothing to publish yet: change the draft first
      if (res.status === 409) {
        await api("/agents/pub", { method: "PATCH", body: { systemPrompt: "Quote.", publish: false } });
        return api("/agents/pub/publish", { body: {} });
      }
      return res;
    }));
    expect(r.data.check).toMatchObject({ trigger: "publish", status: "running", version: r.data.version.version });
    await json(await api(`/agents/pub/deploy-gates/${r.data.check.id}?wait=20`));
    const versions = (await json(await api("/agents/pub/versions"))).data;
    expect(versions.versions[0].gate).toMatchObject({ status: "passed", trigger: "publish" });
    expect(await production("pub")).toBe("1.0.0");

    const forbidden = await asAgent("/agents/pub/suites", suite("Live", "4.99", { required: true, allowRealTools: true }));
    expect(forbidden.status).toBe(403);
    expect((await json(forbidden)).error).toContain("only an admin");
    const allowed = await json(await api("/agents/pub/suites", { body: suite("Live", "4.99", { required: true, allowRealTools: true }) }));
    expect(allowed.data.gate).toMatchObject({ allowRealTools: true });
  });
});

describe("deploy gates over MCP and Polpo's chat", () => {
  const mcp = (scopes: string[]) => {
    const deps: McpDeps = {
      version: "x", toolsets: ["all"], principal: { kind: "oauth", actor: "ada@example.com via Claude", scopes },
      api: async (method, path, body) => {
        const res = await app.request(path, { method, headers: { "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
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

  test("deploy returns the gate (blocked with what failed), gate status, override for admins, the suite card shows required suites and gates", async () => {
    await json(await api("/agents/mcpa/suites", { body: suite("Quotes", "Unknown.", { required: true }) }));
    const version = await publishChange("mcpa", "MCP change.");
    const admin = mcp(["polpo:admin"]);
    const blocked = await admin.call("polpo_agent_deploy", { name: "mcpa", version, confirm: true });
    expect(blocked.isError).toBe(true);
    expect(blocked.content[0].text).toContain("Blocked by suites: Quotes: pass rate 0% < 100%");
    expect(blocked.content[0].text).toContain("✗ Quote:");
    expect(blocked.content[0].text).toContain("override_reason");

    const gates = await admin.call("polpo_agent_deploy_gates", { name: "mcpa" });
    expect(gates.content[0].text).toContain("mcpa's deploys are gated by: Quotes [quotes]");
    expect(gates.content[0].text).toContain(`✗ blocked · mcpa@${version}`);
    const versions = await admin.call("polpo_agent_versions", { name: "mcpa" });
    expect(versions.content[0].text).toContain("Deploys are gated by: Quotes");
    expect(versions.content[0].text).toMatch(/suites ✗ blocked/);
    const history = await admin.call("polpo_agent_deploys", { name: "mcpa" });
    expect(history.content[0].text).toContain("BLOCKED by suites");

    const card = await admin.call("polpo_agent_suite_show", { agent: "mcpa" });
    expect(card.structuredContent.suites[0]).toMatchObject({ id: "quotes", gate: { required: true, minPassRate: 1 } });
    expect(card.structuredContent.gates[0]).toMatchObject({ version, status: "blocked", failed: ["Quotes: pass rate 0% < 100% (0/1 passed)"] });
    expect(card.content[0].text).toContain("REQUIRED to deploy");
    const list = await admin.call("polpo_agent_suite_list", { agent: "mcpa" });
    expect(list.content[0].text).toContain("REQUIRED to deploy (pass rate ≥ 100%)");

    const forced = await admin.call("polpo_agent_deploy", { name: "mcpa", version, override_reason: "Customers are waiting", confirm: true });
    expect(forced.isError).toBeFalsy();
    expect(forced.content[0].text).toContain(`Deployed mcpa@${version} to production (was 1.0.0) with an override`);
    expect(forced.structuredContent.status).toBe("deployed");

    // read scope: the gates' status, not the deploy
    const read = mcp(["polpo:read"]);
    const names = ((await read.list()).tools as Array<{ name: string }>).map((t) => t.name);
    expect(names).toContain("polpo_agent_deploy_gates");
    expect(names).not.toContain("polpo_agent_deploy");
  });

  test("a passing gate over MCP waits for the verdict and deploys; Polpo's chat has agent_deploy_gates", async () => {
    await json(await api("/agents/mcpa/suites/quotes", { method: "PUT", body: { ...suite("Quotes", "It is 4.99.", { required: true }), id: "quotes" } }));
    const version = await publishChange("mcpa", "MCP change 2.");
    const ok = await mcp(["polpo:admin"]).call("polpo_agent_deploy", { name: "mcpa", version, confirm: true });
    expect(ok.isError).toBeFalsy();
    expect(ok.content[0].text).toContain(`Deployed mcpa@${version} to production: every required suite passed.`);
    expect(await production("mcpa")).toBe(version);

    const { BRIDGED_TOOLS } = await import("../llm/polpo-mcp-bridge.js");
    expect(BRIDGED_TOOLS.some((t) => t.mcp === "polpo_agent_deploy_gates" && t.name === "agent_deploy_gates")).toBe(true);
  });
});
