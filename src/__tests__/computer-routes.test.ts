/**
 * /computers routes and agents' computers: create, list with live status and users, update,
 * start/stop/restart, reset and delete with confirm, and agent create/update validation.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentRoutes } from "@polpo-ai/server";
import { resolveSandbox, type ComputerConfig, type RemoteSandboxProvider } from "@polpo-ai/core/sandbox";
import { ComputerManager } from "../sandbox/computers.js";
import { computerRoutes } from "../server/routes/computers.js";
import type { CreateSpec, RemoteAdapter, RemoteDriver, RemoteVmSummary } from "../sandbox/remote-adapters.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const json = (body: unknown, method = "POST") => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/** A provider whose machines are records: started or stopped. */
class FakeProvider implements RemoteAdapter {
  readonly fastSuspend = false;
  machines = new Map<string, { state: string; labels: Record<string, string>; deleted?: boolean }>();
  created: CreateSpec[] = [];
  removed: string[] = [];
  private n = 0;
  constructor(readonly provider: RemoteSandboxProvider) {}
  private driver(id: string): RemoteDriver {
    return { remoteId: id, exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }), readFile: async () => new Uint8Array(), writeFile: async () => {}, suspend: async () => {}, resume: async () => {}, destroy: async () => {} };
  }
  async create(spec: CreateSpec) { const id = `m-${++this.n}`; this.machines.set(id, { state: "started", labels: spec.labels }); this.created.push(spec); return this.driver(id); }
  async connect(id: string) { const m = this.machines.get(id)!; m.state = "started"; return this.driver(id); }
  async list(labels: Record<string, string>): Promise<RemoteVmSummary[]> {
    return [...this.machines.entries()].filter(([, m]) => !m.deleted && Object.entries(labels).every(([k, v]) => m.labels[k] === v)).map(([id, m]) => ({ remoteId: id, state: m.state, labels: m.labels }));
  }
  async remove(id: string) { this.machines.get(id)!.deleted = true; this.removed.push(id); }
  async suspendById(id: string) { this.machines.get(id)!.state = "stopped"; }
}

function makeApp(opts: { computers?: ComputerConfig[]; agents?: any[]; withoutKey?: boolean } = {}) {
  const polpoDir = mkdtempSync(join(tmpdir(), "polpo-computers-"));
  dirs.push(polpoDir);
  const provider = new FakeProvider("daytona");
  const manager = new ComputerManager(polpoDir, { adapter: () => provider });
  const state = { computers: [...(opts.computers ?? [])], agents: opts.agents ?? [], events: [] as any[] };
  manager.onChange = (id, live) => state.events.push({ id, action: "status", status: live.status });
  const app = computerRoutes({
    computers: () => state.computers,
    settings: () => ({ egressProxies: { home: "socks5://100.1.2.3:1080" } } as any),
    agents: async () => state.agents,
    manager: () => manager,
    save: async (list) => { state.computers = list; },
    sandboxFor: (computer) => opts.withoutKey
      ? { error: "Daytona has no API key on this server: choose one in Settings → Sandbox" }
      : resolveSandbox({}, { scope: "task", computers: { computers: [computer], defaultComputer: computer.id, allowed: [computer.id] } }),
    emit: (payload) => state.events.push(payload),
  });
  return { app, state, provider, manager };
}

describe("/computers", () => {
  it("lists host first, then the computers with live status and the agents using them", async () => {
    const t = makeApp({
      computers: [{ id: "nina", name: "Nina", kind: "daytona" }],
      agents: [{ name: "sitoinchat", defaultComputer: "nina" }, { name: "growth", computers: ["nina"] }, { name: "dev" }],
    });
    const res = await t.app.request("/");
    expect(res.status).toBe(200);
    const { computers } = (await res.json()).data;
    expect(computers.map((c: any) => [c.id, c.status])).toEqual([["host", "running"], ["nina", "missing"]]);
    expect(computers[0].builtin).toBe(true);
    // growth may use nina but runs here by default
    expect(computers[0].agents).toEqual([{ name: "growth", isDefault: true }, { name: "dev", isDefault: true }]);
    expect(computers[1].agents).toEqual([{ name: "sitoinchat", isDefault: true }, { name: "growth", isDefault: false }]);
  });

  it("creates (validated, unique id, known egress), without a machine until it is used or started", async () => {
    const t = makeApp();
    const res = await t.app.request("/", json({ id: "nina", name: "Nina", kind: "daytona", lifecycle: { idleStopMinutes: 20 } }));
    expect(res.status).toBe(201);
    expect(t.state.computers).toEqual([{ id: "nina", name: "Nina", kind: "daytona", lifecycle: { idleStopMinutes: 20 } }]);
    expect(t.provider.created).toHaveLength(0);
    expect(t.state.events).toContainEqual({ id: "nina", action: "created", status: "missing" });
    expect((await t.app.request("/", json({ id: "nina", kind: "e2b" }))).status).toBe(409);
    expect((await t.app.request("/", json({ id: "Bad Id", kind: "e2b" }))).status).toBe(400);
    expect((await (await t.app.request("/", json({ id: "home", kind: "host", egress: "nope" }))).json()).error).toMatch(/no egress proxy "nope"/);
    expect((await t.app.request("/", json({ id: "home", kind: "host", egress: "home" }))).status).toBe(201);
    // start: true creates the machine right away
    expect((await t.app.request("/", json({ id: "box", kind: "daytona", start: true }))).status).toBe(201);
    expect(t.provider.created).toHaveLength(1);
  });

  it("updates; id and kind stay; fixed fields note a reset", async () => {
    const t = makeApp({ computers: [{ id: "nina", name: "Nina", kind: "daytona" }] });
    await t.app.request("/nina/start", { method: "POST" });
    const res = await t.app.request("/nina", json({ name: "Nina's PC", snapshot: "polpo-runner-2" }, "PATCH"));
    expect(res.status).toBe(200);
    const body = (await res.json()).data;
    expect(body.name).toBe("Nina's PC");
    expect(body.note).toMatch(/snapshot apply to a new machine/);
    expect((await t.app.request("/nina", json({ kind: "e2b" }, "PATCH"))).status).toBe(400);
    expect((await t.app.request("/host", json({ name: "x" }, "PATCH"))).status).toBe(400);
    expect((await t.app.request("/zed", json({ name: "x" }, "PATCH"))).status).toBe(404);
  });

  it("start, stop, restart; host has no machine; no API key is a clear 409", async () => {
    const t = makeApp({ computers: [{ id: "nina", name: "Nina", kind: "daytona" }] });
    const started = await t.app.request("/nina/start", { method: "POST" });
    expect((await started.json()).data.status).toBe("running");
    const stopped = await t.app.request("/nina/stop", { method: "POST" });
    expect((await stopped.json()).data.status).toBe("stopped");
    expect(t.provider.removed).toEqual([]);
    const restarted = await t.app.request("/nina/restart", { method: "POST" });
    expect((await restarted.json()).data.status).toBe("running");
    expect(t.provider.created).toHaveLength(1);
    expect(t.state.events.filter((e) => e.action === "status").map((e) => e.status)).toEqual(["creating", "running", "stopping", "stopped", "starting", "running"]);
    expect((await t.app.request("/host/stop", { method: "POST" })).status).toBe(400);
    const noKey = makeApp({ computers: [{ id: "nina", name: "Nina", kind: "daytona" }], withoutKey: true });
    const res = await noKey.app.request("/nina/start", { method: "POST" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/no API key/);
  });

  it("reset and delete need confirm; delete refuses a computer that is an agent's default", async () => {
    const t = makeApp({ computers: [{ id: "nina", name: "Nina", kind: "daytona" }], agents: [{ name: "sitoinchat", defaultComputer: "nina" }] });
    await t.app.request("/nina/start", { method: "POST" });
    const noConfirm = await t.app.request("/nina/reset", { method: "POST" });
    expect(noConfirm.status).toBe(400);
    expect((await noConfirm.json()).code).toBe("CONFIRM_REQUIRED");
    expect(t.provider.removed).toEqual([]);
    const reset = await t.app.request("/nina/reset", json({ confirm: true }));
    expect(reset.status).toBe(200);
    expect(t.provider.removed).toEqual(["m-1"]);
    expect(t.provider.created).toHaveLength(2);

    expect((await t.app.request("/nina", { method: "DELETE" })).status).toBe(400);
    const inUse = await t.app.request("/nina", json({ confirm: true }, "DELETE"));
    expect(inUse.status).toBe(409);
    expect((await inUse.json()).error).toMatch(/default of sitoinchat/);
    t.state.agents = [];
    const deleted = await t.app.request("/nina", json({ confirm: true }, "DELETE"));
    expect(deleted.status).toBe(200);
    expect(t.state.computers).toEqual([]);
    expect(t.provider.removed).toEqual(["m-1", "m-2"]);
    expect(t.state.events).toContainEqual({ id: "nina", action: "deleted" });
  });
});

describe("agents' computers", () => {
  it("create and update accept computers and defaultComputer, checked against the instance's", async () => {
    const agent: any = { name: "sitoinchat", role: "Sites" };
    const updateAgent = vi.fn(async (_name: string, u: any) => { Object.assign(agent, u); return agent; });
    const addAgent = vi.fn(async () => undefined);
    const app = agentRoutes(() => ({ getAgents: async () => [agent], updateAgent, addAgent, computerIds: () => ["nina"] } as any));

    const res = await app.request("/sitoinchat", json({ defaultComputer: "nina", computers: ["nina"] }, "PATCH"));
    expect(res.status).toBe(200);
    expect(updateAgent).toHaveBeenCalledWith("sitoinchat", { defaultComputer: "nina", computers: ["nina"] });
    const unknown = await app.request("/sitoinchat", json({ defaultComputer: "zed" }, "PATCH"));
    expect(unknown.status).toBe(400);
    expect((await unknown.json()).error).toMatch(/Unknown computer: zed/);
    // "" clears it: back to this server
    await app.request("/sitoinchat", json({ defaultComputer: "" }, "PATCH"));
    expect(updateAgent).toHaveBeenLastCalledWith("sitoinchat", { defaultComputer: undefined });

    const created = await app.request("/", json({ name: "builder", defaultComputer: "nina" }));
    expect(created.status).toBe(201);
    expect(addAgent).toHaveBeenCalledWith(expect.objectContaining({ name: "builder", defaultComputer: "nina" }), undefined);
    expect((await app.request("/", json({ name: "x", computers: ["zed"] }))).status).toBe(400);
  });
});

// ── MCP tools over the real routes ───────────────────────────────────────

describe("MCP computer tools", () => {
  async function mcp(scopes: string[] = ["polpo"]) {
    const { handleMcpRequest } = await import("../server/mcp.js");
    const t = makeApp({ agents: [{ name: "sitoinchat" }] });
    const api = async (method: string, path: string, body?: unknown) => {
      const res = await t.app.request(path.replace(/^\/api\/v1\/computers/, "") || "/", { method, headers: { "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
    };
    const deps = { api, version: "x", toolsets: ["computers"], principal: { kind: "oauth" as const, actor: "test", scopes } };
    const rpc = async (method: string, params: Record<string, unknown> = {}) => (await (await handleMcpRequest(new Request("http://localhost/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }), deps)).json()).result;
    return { t, rpc, call: (name: string, args: Record<string, unknown>) => rpc("tools/call", { name, arguments: args }) };
  }

  it("save creates then changes; control starts and stops; reset and delete need confirm", async () => {
    const { t, call } = await mcp();
    const created = await call("polpo_computer_save", { id: "nina", name: "Nina", kind: "daytona" });
    expect(created.isError).toBeFalsy();
    expect(created.structuredContent).toMatchObject({ created: true, computer: { id: "nina", status: "missing" } });
    const changed = await call("polpo_computer_save", { id: "nina", lifecycle: { idleStopMinutes: 30 } });
    expect(changed.structuredContent).toMatchObject({ created: false });
    expect(t.state.computers[0]!.lifecycle).toEqual({ idleStopMinutes: 30 });
    expect((await call("polpo_computer_save", { id: "zed" })).content[0].text).toMatch(/give kind/);

    expect((await call("polpo_computer_control", { id: "nina", action: "start" })).structuredContent.computer.status).toBe("running");
    expect((await call("polpo_computer_control", { id: "nina", action: "stop" })).structuredContent.computer.status).toBe("stopped");
    const noConfirm = await call("polpo_computer_control", { id: "nina", action: "reset" });
    expect(noConfirm.isError).toBe(true);
    expect(t.provider.removed).toEqual([]);
    expect((await call("polpo_computer_control", { id: "nina", action: "reset", confirm: true })).isError).toBeFalsy();
    expect(t.provider.removed).toEqual(["m-1"]);

    const list = await call("polpo_computers_list", {});
    expect(list.structuredContent.items.map((c: any) => c.id)).toEqual(["host", "nina"]);
    expect((await call("polpo_computer_delete", { id: "nina" })).isError).toBe(true);
    expect((await call("polpo_computer_delete", { id: "nina", confirm: true })).structuredContent).toEqual({ deleted: "nina" });
    expect(t.state.computers).toEqual([]);
  });

  it("reads need polpo:read; changes need polpo:admin", async () => {
    const work = await mcp(["polpo:work"]);
    const names = ((await work.rpc("tools/list")).tools as Array<{ name: string }>).map((x) => x.name);
    expect(names).toEqual(["polpo_computers_list"]);
    const admin = await mcp(["polpo:admin"]);
    expect(((await admin.rpc("tools/list")).tools as Array<{ name: string }>).map((x) => x.name))
      .toEqual(["polpo_computers_list", "polpo_computer_save", "polpo_computer_control", "polpo_computer_delete"]);
  });
});
