/**
 * Agent tests over REST and MCP: a real instance (createApp, the real routes) runs the checks that
 * need no model (tools, connectors, vault, skills, channels, versioning), finds the connector-access
 * misconfiguration (mcp__printful__* in allowedTools, access.agents []) and fixes it in one call;
 * the history; input errors. MCP polpo_agent_test: read scope for the checks, admin for the smoke
 * run and the fix. No model, connector or machine is called.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import { handleMcpRequest, type McpDeps, type McpPrincipal } from "../server/mcp.js";

const MCP_KEY = "mcp-key-for-agent-tests";
let tmpDir: string;
let app: Hono;

beforeAll(async () => {
  process.env.POLPO_MCP_KEY = MCP_KEY;
  tmpDir = await mkdtemp(join(tmpdir(), "polpo-agent-tests-"));
  await mkdir(join(tmpDir, ".polpo"), { recursive: true });
  const agents = [{ name: "shop", role: "Sells", allowedTools: ["read", "reed", "mcp__printful__*"] }];
  await writeFile(join(tmpDir, ".polpo", "polpo.json"), JSON.stringify({ project: "agent-tests", team: { name: "t", agents }, settings: { logLevel: "quiet" } }));
  await writeFile(join(tmpDir, ".polpo", "connectors.json"), JSON.stringify({ connectors: [{
    id: "printful", name: "Printful", kind: "mcp", transport: { type: "http", url: "https://printful.invalid/mcp" }, auth: { type: "none" },
    access: { agents: [], polpo: false }, enabled: true, createdAt: "2026-11-01T00:00:00.000Z",
  }] }));
  const { Orchestrator } = await import("../core/orchestrator.js");
  const { SSEBridge } = await import("../server/sse-bridge.js");
  const { createApp } = await import("../server/app.js");
  const orchestrator = new Orchestrator(tmpDir);
  await orchestrator.initInteractive("agent-tests", { name: "t", agents });
  app = createApp(orchestrator, new SSEBridge(orchestrator), { workDir: tmpDir });
}, 60_000);

afterAll(async () => {
  delete process.env.POLPO_MCP_KEY;
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
});

const auth = { authorization: `Bearer ${MCP_KEY}` };
const rest = async (method: string, path: string, body?: unknown) => {
  const res = await app.request(`/api/v1${path}`, { method, headers: { ...auth, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, body: await res.json() as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
};
const STATIC = ["tools", "connectors", "vault", "skills", "channels", "versioning"];

describe("agent tests REST", () => {
  it("runs the checks, finds the connector access that leaves the agent out, fixes it, keeps the history", async () => {
    const run = await rest("POST", "/agents/shop/tests", { checks: STATIC });
    expect(run.status).toBe(200);
    const data = run.body.data;
    expect(data).toMatchObject({ agent: "shop", target: "production", version: "1.0.0", status: "fail" });
    expect(data.checks.map((c: { id: string }) => c.id)).toEqual(STATIC);
    const connectors = data.checks.find((c: { id: string }) => c.id === "connectors");
    expect(connectors.status).toBe("fail");
    expect(connectors.items[0]).toMatchObject({
      label: "Printful (mcp__printful__*)", status: "fail",
      fix: { label: "Grant shop access", action: { type: "grant-connector-access", connector: "printful" } },
    });
    const tools = data.checks.find((c: { id: string }) => c.id === "tools");
    expect(tools.items.find((i: { label: string }) => i.label === "reed")).toMatchObject({ status: "warn" });

    const fix = await rest("POST", "/agents/shop/tests/fix", { type: "grant-connector-access", connector: "printful" });
    expect(fix.status).toBe(200);
    expect(fix.body.data.message).toMatch(/Printful now grants shop/);
    expect((await rest("GET", "/connectors/printful")).body.data.access.agents).toEqual(["shop"]);

    const history = await rest("GET", "/agents/shop/tests");
    expect(history.body.data.map((r: { id: string }) => r.id)).toContain(data.id);
    const one = await rest("GET", `/agents/shop/tests/${data.id}`);
    expect(one.body.data.id).toBe(data.id);
  });

  it("refuses bad input: unknown agent, check, target, version, fix", async () => {
    expect((await rest("POST", "/agents/ghost/tests", {})).status).toBe(404);
    expect((await rest("POST", "/agents/shop/tests", { checks: ["nope"] })).status).toBe(400);
    expect((await rest("POST", "/agents/shop/tests", { checks: ["versioning"], target: "nightly" })).status).toBe(400);
    expect((await rest("POST", "/agents/shop/tests", { checks: ["versioning"], target: "9.9.9" })).status).toBe(404);
    expect((await rest("GET", "/agents/shop/tests/nope")).status).toBe(404);
    expect((await rest("POST", "/agents/shop/tests/fix", { type: "grant-connector-access", connector: "ghost" })).status).toBe(404);
    expect((await rest("POST", "/agents/shop/tests/fix", { type: "delete-everything" })).status).toBe(400);
  });

  it("tests the draft", async () => {
    const r = await rest("POST", "/agents/shop/tests", { checks: ["versioning"], target: "draft" });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ target: "draft" });
    expect(r.body.data.checks[0].items.at(-1)).toMatchObject({ label: "Tested", detail: "The draft (not what runs)" });
  });
});

describe("polpo_agent_test over MCP", () => {
  it("runs on the real instance and lists the history", async () => {
    const call = async (args: Record<string, unknown>) => (await (await app.request("/mcp", {
      method: "POST",
      headers: { ...auth, "x-forwarded-host": "polpo.example.com", "x-forwarded-proto": "https", "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "polpo_agent_test", arguments: args } }),
    })).json()).result;
    const r = await call({ name: "shop", checks: ["tools", "versioning"] });
    expect(r.isError).toBeFalsy();
    expect(r.content[0].text).toMatch(/⚠ shop@1\.0\.0 \(production\)/);
    expect(r.content[0].text).toMatch(/⚠ Tools: .*\n\s+⚠ reed: Unknown tool name/);
    expect(r.structuredContent.run.checks).toHaveLength(2);
    const h = await call({ name: "shop", history: true });
    expect(h.structuredContent.runs.length).toBeGreaterThanOrEqual(2);
  });

  const principal = (scopes: string[]): McpPrincipal => ({ kind: "oauth", actor: "ada@example.com via Claude", scopes });
  const fake = () => {
    const calls: Array<{ method: string; path: string; body?: unknown }> = [];
    const run = {
      id: "r1", agent: "shop", target: "production", version: "1.2.0", status: "fail", startedAt: "2026-11-25T10:00:00.000Z", finishedAt: "2026-11-25T10:00:01.000Z",
      checks: [{ id: "connectors", title: "Connectors", status: "fail", summary: "1 failed", durationMs: 3, items: [
        { label: "Printful (mcp__printful__*)", status: "fail", detail: "access does not include shop", fix: { label: "Grant shop access", action: { type: "grant-connector-access", connector: "printful" } } },
      ] }],
    };
    const api: McpDeps["api"] = async (method, path, body) => {
      calls.push({ method, path, body });
      if (path.endsWith("/tests/fix")) return { status: 200, body: { ok: true, data: { message: "Printful now grants shop" } }, headers: new Headers() };
      return { status: 200, body: { ok: true, data: run }, headers: new Headers() };
    };
    return { calls, api };
  };
  const rpc = (deps: McpDeps, args: Record<string, unknown>) => handleMcpRequest(new Request("http://localhost/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "polpo_agent_test", arguments: args } }),
  }), deps).then(async (res) => (await res.json()).result);

  it("read scope runs the checks and shows the fix; the smoke run and the fix need admin", async () => {
    const f = fake();
    const deps: McpDeps = { api: f.api, version: "x", toolsets: ["all"], principal: principal(["polpo:read"]) };
    const r = await rpc(deps, { name: "shop" });
    expect(r.isError).toBeFalsy();
    expect(r.content[0].text).toMatch(/✗ Printful \(mcp__printful__\*\): access does not include shop → fix: polpo_agent_test with fix_connector "printful"/);
    expect(f.calls.at(-1)).toMatchObject({ method: "POST", path: "/api/v1/agents/shop/tests", body: {} });
    const smoke = await rpc(deps, { name: "shop", checks: ["smoke"] });
    expect(smoke.isError).toBe(true);
    expect(smoke.content[0].text).toMatch(/admin scope/);
    const fix = await rpc(deps, { name: "shop", fix_connector: "printful" });
    expect(fix.isError).toBe(true);
    expect(f.calls).toHaveLength(1);
  });

  it("admin runs the smoke run on a version and applies the fix", async () => {
    const f = fake();
    const deps: McpDeps = { api: f.api, version: "x", toolsets: ["all"], principal: principal(["polpo:admin"]) };
    await rpc(deps, { name: "shop", checks: ["smoke"], target: "1.2.0", smoke_prompt: "Call ls" });
    expect(f.calls[0]).toMatchObject({ path: "/api/v1/agents/shop/tests", body: { checks: ["smoke"], target: "1.2.0", smokePrompt: "Call ls" } });
    const fix = await rpc(deps, { name: "shop", fix_connector: "printful" });
    expect(fix.isError).toBeFalsy();
    expect(f.calls[1]).toMatchObject({ path: "/api/v1/agents/shop/tests/fix", body: { type: "grant-connector-access", connector: "printful" } });
  });
});
