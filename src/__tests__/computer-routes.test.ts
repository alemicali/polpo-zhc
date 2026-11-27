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
import { computerRoutes, egressRoutes, type ComputerRouteDeps } from "../server/routes/computers.js";
import { expectValidOutput } from "./helpers/mcp-output.js";
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

function makeApp(opts: { computers?: ComputerConfig[]; agents?: any[]; withoutKey?: boolean; tasks?: any[]; sessions?: any[] } = {}) {
  const polpoDir = mkdtempSync(join(tmpdir(), "polpo-computers-"));
  dirs.push(polpoDir);
  const provider = new FakeProvider("daytona");
  const manager = new ComputerManager(polpoDir, { adapter: () => provider });
  const state = { computers: [...(opts.computers ?? [])], agents: opts.agents ?? [], events: [] as any[] };
  manager.onChange = (id, live) => state.events.push({ id, action: "status", status: live.status });
  const deps: ComputerRouteDeps = {
    computers: () => state.computers,
    settings: () => ({ egressProxies: { home: "socks5://100.1.2.3:1080" } } as any),
    agents: async () => state.agents,
    manager: () => manager,
    save: async (list) => { state.computers = list; },
    sandboxFor: (computer) => opts.withoutKey
      ? { error: "Daytona has no API key on this server: choose one in Settings → Sandbox" }
      : resolveSandbox({}, { scope: "task", computers: { computers: [computer], defaultComputer: computer.id, allowed: [computer.id] } }),
    emit: (payload) => state.events.push(payload),
    tasks: async () => opts.tasks ?? [],
    harnessSessions: (id) => (opts.sessions ?? []).filter((s) => s.computerId === id),
  };
  const app = computerRoutes(deps);
  const egress = egressRoutes({ ...deps, reachable: async () => true });
  return { app, egress, state, provider, manager };
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

  it("a machine deleted at the provider: the list says deleted (with ?fresh=1 at once), Recreate (reset) makes a new one, Remove deletes the computer", async () => {
    const t = makeApp({ computers: [{ id: "nina", name: "Nina", kind: "daytona" }] });
    expect((await t.app.request("/nina/start", json({}))).status).toBe(200);
    let [, nina] = (await (await t.app.request("/")).json()).data.computers;
    expect(nina).toMatchObject({ status: "running", providerApi: "v0" });
    t.provider.machines.get("m-1")!.deleted = true; // deleted in the provider's dashboard
    // asked a moment ago: the answer is reused; ?fresh=1 asks the provider again
    expect((await (await t.app.request("/")).json()).data.computers[1].status).toBe("running");
    [, nina] = (await (await t.app.request("/?fresh=1")).json()).data.computers;
    expect(nina).toMatchObject({ status: "deleted", deletedAtProvider: expect.any(String), notice: expect.stringMatching(/deleted at the provider/) });
    expect(nina.remoteId).toBeUndefined();
    expect(t.state.events).toContainEqual({ id: "nina", action: "status", status: "deleted" });
    // Recreate: a reset (confirmed) makes a new machine from the image
    const recreated = await t.app.request("/nina/reset", json({ confirm: true }));
    expect((await recreated.json()).data).toMatchObject({ status: "running", remoteId: "m-2" });
    // Remove from Polpo
    t.provider.machines.get("m-2")!.deleted = true;
    await t.app.request("/nina?fresh=1");
    expect((await t.app.request("/nina", json({ confirm: true }, "DELETE"))).status).toBe(200);
    expect(t.state.computers).toEqual([]);
  });

  it("?detail=1: activity (newest first), harness sessions, recent runs on it, cost, idle stop and the machine it gets", async () => {
    const run = (over: Record<string, unknown>) => ({
      runId: "r1", startedAt: "2026-11-22T10:00:00Z", endedAt: "2026-11-22T10:02:00Z", status: "done", agent: "coder", engine: "claude-code", model: "claude-sonnet-4-5",
      computer: { id: "nina", kind: "daytona", provider: "daytona", remoteId: "m-1" }, egress: { mode: "direct" }, durationMs: 120_000, cost: { harnessUsd: 0.5, tokens: 1200 }, ...over,
    });
    const t = makeApp({
      computers: [{ id: "nina", name: "Nina", kind: "daytona", lifecycle: { idleStopMinutes: 20 }, resources: { cpus: 2 } }],
      agents: [{ name: "coder", defaultComputer: "nina" }],
      tasks: [
        { id: "t1", title: "Fix the build", status: "done", group: "m1", runs: [run({}), run({ runId: "r2", startedAt: "2026-11-22T11:00:00Z", cost: { harnessUsd: 0.25 } })] },
        { id: "t2", title: "Elsewhere", status: "done", runs: [run({ runId: "r3", computer: { id: "host", kind: "host" } })] },
        { id: "t3", title: "Never ran", status: "pending" },
      ],
      sessions: [
        { key: "task:t1", agent: "coder", harness: "claude-code", computerId: "nina", scope: "task", taskId: "t1", state: "idle", live: false, liveHere: false, resumable: true, turns: 3, costUsd: 0.75, tokens: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, createdAt: "2026-11-22T10:00:00Z", updatedAt: "2026-11-22T11:05:00Z" },
        { key: "chat:coder:s1", agent: "coder", harness: "claude-code", computerId: "nina", scope: "chat", chatSessionId: "s1", state: "idle", live: false, liveHere: false, resumable: true, turns: 1, costUsd: 0.1, tokens: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, createdAt: "2026-11-22T09:00:00Z", updatedAt: "2026-11-22T09:10:00Z" },
      ],
    });
    // without detail: the computer only
    expect((await (await t.app.request("/nina")).json()).data.runs).toBeUndefined();
    await t.app.request("/nina/start", json({}));
    const d = (await (await t.app.request("/nina?detail=1")).json()).data;
    expect(d).toMatchObject({ id: "nina", status: "running", providerApi: "v0", snapshots: [], machine: { resources: { cpus: 2 } } });
    expect(d.activity.map((a: any) => a.status)).toEqual(["running", "creating"]);
    expect(d.activity[0]).toMatchObject({ kind: "status", from: "creating", remoteId: "m-1" });
    expect(Date.parse(d.idleStopAt) - Date.parse(d.lastUsedAt)).toBe(20 * 60_000);
    expect(d.sessions.map((s: any) => s.key)).toEqual(["task:t1", "chat:coder:s1"]);
    expect(d.runs.map((r: any) => [r.taskId, r.runId])).toEqual([["t1", "r2"], ["t1", "r1"]]);
    expect(d.runs[1]).toMatchObject({ taskTitle: "Fix the build", mission: "m1", agent: "coder", engine: "claude-code", status: "done", durationMs: 120_000, costUsd: 0.5, tokens: 1200, remoteId: "m-1" });
    // task runs plus chat harness sessions (a task's session is counted in its runs)
    expect(d.cost).toEqual({ runsUsd: 0.75, chatSessionsUsd: 0.1, totalUsd: 0.85 });
    // "host" has a detail too (its runs), and nothing of a machine
    const host = (await (await t.app.request("/host?detail=1")).json()).data;
    expect(host.runs.map((r: any) => r.runId)).toEqual(["r3"]);
    expect(host.machine).toBeUndefined();
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
    const t = makeApp({ agents: [{ name: "sitoinchat" }, { name: "growth", browserEgress: "home" }, { name: "lost", browserEgress: "gone" }] });
    const api = async (method: string, path: string, body?: unknown) => {
      const egress = path.startsWith("/api/v1/egress");
      const res = await (egress ? t.egress : t.app).request(path.replace(/^\/api\/v1\/(computers|egress)/, "") || "/", { method, headers: { "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
    };
    const deps = { api, version: "x", toolsets: ["computers"], principal: { kind: "oauth" as const, actor: "test", scopes } };
    const rpc = async (method: string, params: Record<string, unknown> = {}) => (await (await handleMcpRequest(new Request("http://localhost/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }), deps)).json()).result;
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await rpc("tools/call", { name, arguments: args });
      await expectValidOutput(deps, async () => (await rpc("tools/list")).tools, name, result);
      return result;
    };
    return { t, rpc, call };
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
    // the desktop's size (REST PATCH through MCP; null clears it)
    await call("polpo_computer_save", { id: "nina", desktop: { size: "1600x900" } });
    expect(t.state.computers[0]!.desktop).toEqual({ size: "1600x900" });
    const badSize = await call("polpo_computer_save", { id: "nina", desktop: { size: "9999x9999" } });
    expect(badSize.isError).toBe(true);
    expect(badSize.content[0].text).toMatch(/800x600 to 3840x2160/);
    expect((await call("polpo_computer_get", { id: "nina" })).content[0].text).toContain("Desktop: 1600x900 (XFCE)");
    await call("polpo_computer_save", { id: "nina", desktop: null });
    expect(t.state.computers[0]!.desktop).toBeUndefined();

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
    const got = await call("polpo_computer_get", { id: "nina" });
    expect(got.structuredContent.computer).toMatchObject({ id: "nina", status: "running", sessions: [], runs: [], cost: { totalUsd: 0 } });
    expect(got.content[0].text).toMatch(/Recent activity:\n- .* creating → running/);
    expect((await call("polpo_computer_get", { id: "ghost" })).content[0].text).toMatch(/There is no computer "ghost"/);
    expect((await call("polpo_computer_delete", { id: "nina", confirm: true })).structuredContent).toEqual({ deleted: "nina" });
    expect(t.state.computers).toEqual([]);
  });

  it("reads need polpo:read; changes need polpo:admin", async () => {
    const work = await mcp(["polpo:work"]);
    const names = ((await work.rpc("tools/list")).tools as Array<{ name: string }>).map((x) => x.name);
    expect(names).toEqual(["polpo_computer_show", "polpo_computers_list", "polpo_computer_get", "polpo_egress_status"]);
    const admin = await mcp(["polpo:admin"]);
    expect(((await admin.rpc("tools/list")).tools as Array<{ name: string }>).map((x) => x.name))
      .toEqual(["polpo_computer_show", "polpo_computers_list", "polpo_computer_get", "polpo_computer_webhooks", "polpo_computer_save", "polpo_computer_control", "polpo_egress_status", "polpo_computer_desktop", "polpo_computer_takeover", "polpo_computer_release", "polpo_computer_delete"]);
  });

  it("polpo_egress_status: proxies with the agents and host computers using them, and each remote computer's egress (read-only, never starts it)", async () => {
    const { t, call } = await mcp(["polpo:read"]);
    t.state.computers = [{ id: "nina", name: "Nina", kind: "daytona", egress: "home" }, { id: "desk", name: "Desk", kind: "host", egress: "home" }];
    const all = await call("polpo_egress_status", {});
    expect(all.isError).toBeFalsy();
    expect(all.structuredContent.proxies).toEqual([{ name: "home", reachable: true, agents: ["growth"], hostComputers: ["desk"] }]);
    expect(all.structuredContent.unknown).toEqual([{ agent: "lost", proxy: "gone" }]);
    // no Tailscale settings in this instance: the reason, and nothing was started
    expect(all.structuredContent.computers).toMatchObject([{ computerId: "nina", proxy: "home", kind: "daytona", proxyReachable: false }]);
    expect(all.content[0].text).toMatch(/- home: reachable from this server; agents: growth; host computers: desk/);
    expect(all.content[0].text).toMatch(/lost \(gone\)/);
    expect(t.provider.created).toEqual([]);
    const one = await call("polpo_egress_status", { computer: "nina" });
    expect(one.structuredContent.computers[0]).toMatchObject({ computerId: "nina", kind: "daytona" });
    expect(one.content[0].text).toMatch(/^computer nina \(daytona\) → home/);
    expect((await call("polpo_egress_status", { computer: "ghost" })).content[0].text).toMatch(/There is no computer "ghost"/);
    expect(t.provider.created).toEqual([]);
  });
});
