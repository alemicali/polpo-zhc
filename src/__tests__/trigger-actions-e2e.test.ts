/**
 * Trigger actions end to end, no model and no channel:
 *  - the host on a real orchestrator with SQLite stores: a playbook run, a mission (and a copy with
 *    variables) and a task carry the action's origin (persisted) and the owner as requestedBy;
 *  - a real instance (createApp): POST /hooks/:id answers 202 with actions queued, the playbook and
 *    task actions create their mission and task with the origin (REST), a notification on an unknown
 *    channel fails with its reason, re-runs over REST and MCP, the delivery's runs in
 *    polpo_trigger_deliveries and the trigger card, and the trigger:actions events on the bus.
 */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { createSqliteStores, migrateSqlite } from "@polpo-ai/drizzle";
import { Orchestrator } from "../core/orchestrator.js";
import { createTriggerActionHost } from "../server/trigger-action-host.js";
import { handleMcpRequest, type McpDeps } from "../server/mcp.js";
import { InMemoryRunStore, createTestAgent } from "./fixtures.js";
import type { ActionContext } from "../triggers/actions.js";

const plan = JSON.stringify({ tasks: [{ title: "Welcome {{who}}", description: "Greet {{who}}", assignTo: "dev" }] });
const ctx = (deliveryId: string): ActionContext => ({
  origin: { kind: "trigger", triggerId: "form-1", deliveryId, triggerName: "Form", actionId: "a1", depth: 1 },
  requestedBy: "ada@example.com", owner: "ada@example.com", signal: new AbortController().signal,
});

describe("the action host on a real orchestrator (SQLite)", () => {
  const TEST_DIR = join(process.cwd(), ".test-polpo-trigger-host");
  let sqlite: InstanceType<typeof Database>;
  let runStore: InMemoryRunStore;
  let o: Orchestrator;

  beforeAll(async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    sqlite = new Database(join(TEST_DIR, "state.db"));
    const db = drizzle(sqlite);
    migrateSqlite(db);
    runStore = new InMemoryRunStore();
    o = new Orchestrator({
      workDir: TEST_DIR, store: createSqliteStores(db).taskStore, runStore,
      assessFn: async () => ({ passed: true, checks: [], metrics: [], timestamp: new Date().toISOString() }),
    });
    await o.initInteractive("test-project", { name: "team", agents: [createTestAgent({ name: "dev" })] });
  }, 60_000);

  afterAll(() => {
    sqlite?.close();
    runStore?.close();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  test("playbook, mission (and a copy with variables) and task carry the origin and the owner", async () => {
    const host = createTriggerActionHost({ orchestrator: o, completions: { request: () => new Response("{}", { status: 500 }) } });
    await o.getPlaybookStore().save({
      name: "onboarding", description: "Onboard someone", parameters: [{ name: "who", description: "Who", required: true }],
      mission: JSON.parse(plan),
    } as never);
    const pb = await host.runPlaybook("onboarding", { who: "ada" }, ctx("tdl_pb1"));
    const pm = await o.getMission(pb.missionId);
    expect(pm).toMatchObject({ owner: "ada@example.com", origin: { kind: "trigger", triggerId: "form-1", deliveryId: "tdl_pb1", actionId: "a1" } });
    const pbTasks = (await o.getStore().getAllTasks()).filter((t) => t.missionId === pb.missionId);
    expect(pbTasks.map((t) => [t.title, t.requestedBy, t.origin?.deliveryId])).toEqual([["Welcome ada", "ada@example.com", "tdl_pb1"]]);
    await expect(host.runPlaybook("onboarding", {}, ctx("tdl_pb2"))).rejects.toThrow(/Playbook "onboarding": Parameter validation failed \(Missing required parameter: who\)/);
    await expect(host.runPlaybook("nope", {}, ctx("tdl_pb3"))).rejects.toThrow(/Playbook "nope": Playbook not found/);

    // an existing mission runs as it is; its run's tasks carry this delivery
    const m = await o.saveMission({ name: "welcome", data: JSON.stringify({ tasks: [{ title: "Hello", description: "x", assignTo: "dev" }] }) });
    const run = await host.runMission("welcome", undefined, ctx("tdl_m1"));
    expect(run).toEqual({ missionId: m.id, missionName: "welcome" });
    const mTasks = (await o.getStore().getAllTasks()).filter((t) => t.missionId === m.id);
    expect(mTasks[0]).toMatchObject({ requestedBy: "ada@example.com", origin: { deliveryId: "tdl_m1" } });
    // variables: a copy with them, owned by the trigger's owner
    const tpl = await o.saveMission({ name: "greet", data: plan });
    const copy = await host.runMission(tpl.id, { who: 'Bob "the" Builder' }, ctx("tdl_m2"));
    expect(copy.copyOf).toBe(tpl.id);
    expect(copy.missionId).not.toBe(tpl.id);
    expect(await o.getMission(copy.missionId)).toMatchObject({ owner: "ada@example.com", origin: { deliveryId: "tdl_m2" } });
    const cTasks = (await o.getStore().getAllTasks()).filter((t) => t.missionId === copy.missionId);
    expect(cTasks[0]!.title).toBe('Welcome Bob "the" Builder');
    await expect(host.runMission("ghost", undefined, ctx("tdl_m3"))).rejects.toThrow(/No mission "ghost"/);

    const t = await host.createTask({ title: "Call ada", description: "Call her", assignTo: "dev" }, ctx("tdl_t1"));
    expect(await o.getStore().getTask(t.taskId)).toMatchObject({ requestedBy: "ada@example.com", origin: { kind: "trigger", deliveryId: "tdl_t1", triggerName: "Form" } });
    await expect(host.createTask({ title: "x", description: "y", assignTo: "nobody" }, ctx("tdl_t2"))).rejects.toThrow(/No agent "nobody"/);
    await expect(host.notify({ channel: "tg", title: "t", body: "b", ruleName: "Trigger Form" }, ctx("tdl_n1"))).rejects.toThrow(/not configured|not found/);
  }, 60_000);
});

describe("trigger actions on a real instance (REST + MCP)", () => {
  let tmpDir: string;
  let app: any;
  let orchestrator: Orchestrator;
  const KEY = "test-api-key";
  const api = (path: string, init?: { method?: string; body?: unknown }) => app.request(`/api/v1${path}`, {
    method: init?.method ?? (init?.body !== undefined ? "POST" : "GET"),
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
    ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const json = async (res: Response) => (await res.json()) as { ok: boolean; data: any; error?: string };
  const settled = async (id: string, deliveryId: string) => {
    for (let i = 0; i < 100; i++) {
      const d = (await json(await api(`/triggers/${id}/deliveries/${deliveryId}`))).data;
      if (d.actionsStatus && d.actionsStatus !== "queued" && d.actionsStatus !== "running") return d;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("actions did not settle");
  };
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

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "polpo-trigger-actions-e2e-"));
    await mkdir(join(tmpDir, ".polpo"), { recursive: true });
    const team = { name: "t", agents: [createTestAgent({ name: "dev" })] };
    await writeFile(join(tmpDir, ".polpo", "polpo.json"), JSON.stringify({ project: "trigger-actions-e2e", team, settings: { logLevel: "quiet" } }));
    const { Orchestrator: O } = await import("../core/orchestrator.js");
    const { SSEBridge } = await import("../server/sse-bridge.js");
    const { createApp } = await import("../server/app.js");
    orchestrator = new O(tmpDir);
    await orchestrator.initInteractive("trigger-actions-e2e", team);
    const bridge = new SSEBridge(orchestrator);
    bridge.start();
    app = createApp(orchestrator, bridge, { apiKeys: [KEY] });
  }, 60_000);

  afterAll(async () => { if (tmpDir) await rm(tmpDir, { recursive: true, force: true }); });

  test("a form delivery runs a playbook and creates a task (origin on both), a bad channel fails, re-runs over REST and MCP", async () => {
    expect((await api("/playbooks", { body: {
      name: "form-onboarding", description: "Onboard a form's sender", parameters: [{ name: "email", description: "Who", required: true }],
      mission: { tasks: [{ title: "Onboard {{email}}", description: "Send the welcome pack to {{email}}", assignTo: "dev" }] },
    } })).status).toBeLessThan(300);
    const created = await json(await api("/triggers", { body: {
      name: "Signup form", owner: "ada@example.com", mapping: { email: "{{body.email}}" },
      actions: [
        { kind: "playbook", id: "onboard", playbook: "form-onboarding", params: { email: "{{mapped.email}}" } },
        { kind: "task", id: "call", title: "Call {{mapped.email}}", description: "Mission {{steps.onboard.missionId}}", assignTo: "dev" },
        { kind: "notify", id: "tell", channel: "nope", body: "New signup {{mapped.email}}", retries: 0 },
      ],
    } }));
    expect(created.ok).toBe(true);
    const { trigger, secret } = created.data;
    expect(trigger.actions.map((a: { id: string }) => a.id)).toEqual(["onboard", "call", "tell"]);

    const seen: any[] = [];
    const onActions = (p: any) => seen.push(p);
    orchestrator.on("trigger:actions", onActions);
    const res = await app.request(`/hooks/${trigger.id}`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${secret}` }, body: JSON.stringify({ email: "ada@example.com" }),
    });
    expect(res.status).toBe(202);
    const answer = await res.json() as { deliveryId: string; actions: string };
    expect(answer.actions).toBe("queued");
    const d = await settled(trigger.id, answer.deliveryId);
    orchestrator.off("trigger:actions", onActions);
    expect(d.actionsStatus).toBe("partial");
    expect(d.actionsRequestedBy).toBe("ada@example.com");
    const [pb, task, tell] = d.actions;
    expect(pb).toMatchObject({ status: "done", refs: { playbook: "form-onboarding", missionId: expect.any(String) } });
    expect(task).toMatchObject({ status: "done", refs: { taskId: expect.any(String) } });
    expect(tell).toMatchObject({ status: "failed", error: expect.stringMatching(/Channel "nope" not found|not configured/) });
    expect(seen.some((e) => e.deliveryId === answer.deliveryId && e.status === "running")).toBe(true);

    const mission = (await json(await api(`/missions/${pb.refs.missionId}`))).data;
    expect(mission).toMatchObject({ owner: "ada@example.com", origin: { kind: "trigger", triggerId: trigger.id, deliveryId: answer.deliveryId, actionId: "onboard" } });
    const t = (await json(await api(`/tasks/${task.refs.taskId}`))).data;
    expect(t).toMatchObject({ title: "Call ada@example.com", description: `Mission ${pb.refs.missionId}`, requestedBy: "ada@example.com", origin: { deliveryId: answer.deliveryId, actionId: "call" } });

    // preview and usage
    const preview = (await json(await api(`/triggers/${trigger.id}/actions/preview`, { body: {} }))).data;
    expect(preview.deliveryId).toBe(answer.deliveryId);
    expect(preview.actions[0].rendered).toEqual({ playbook: "form-onboarding", params: { email: "ada@example.com" } });
    expect((await json(await api(`/triggers/${trigger.id}/action-usage`))).data.actions).toBe(3);

    // re-run over REST: only the notification, after removing the others
    await api(`/triggers/${trigger.id}`, { method: "PATCH", body: { actions: [{ kind: "notify", id: "tell", channel: "nope", body: "again", retries: 0 }] } });
    const rerun = await api(`/triggers/${trigger.id}/deliveries/${answer.deliveryId}/run-actions`, { method: "POST" });
    expect(rerun.status).toBe(202);
    const again = await settled(trigger.id, answer.deliveryId);
    expect(again.actions).toHaveLength(1);
    expect(again.previousActions[0].runs).toHaveLength(3);

    // over MCP: the delivery with its runs, a re-run, the card
    const work = mcp(["polpo:work"]);
    const one = await work.call("polpo_trigger_deliveries", { id: trigger.id, delivery_id: answer.deliveryId });
    expect(one.content[0].text).toMatch(/actions failed/);
    expect(one.content[0].text).toMatch(/\[tell\] notify failed/);
    const viaMcp = await work.call("polpo_trigger_run_actions", { id: trigger.id, delivery_id: answer.deliveryId });
    expect(viaMcp.isError).toBeFalsy();
    expect(viaMcp.content[0].text).toMatch(/Actions of tdl_\w+ queued/);
    await settled(trigger.id, answer.deliveryId);
    const read = mcp(["polpo:read"]);
    expect(((await read.list()).tools as Array<{ name: string }>).map((x) => x.name)).not.toContain("polpo_trigger_run_actions");
    const card = await read.call("polpo_trigger_show", { id: trigger.id });
    expect(card.structuredContent.trigger.actions).toEqual([{ id: "tell", kind: "notify", label: "Notify nope", enabled: true }]);
    expect(card.structuredContent.deliveries[0]).toMatchObject({ actionsStatus: "failed", actions: [expect.objectContaining({ actionId: "tell", status: "failed" })] });
    const got = await read.call("polpo_trigger_get", { id: trigger.id });
    expect(got.content[0].text).toContain("[tell] notify nope");

    // MCP create with actions (snake_case) and a test delivery that runs them
    const mk = await work.call("polpo_trigger_create", { name: "MCP form", actions: [{ kind: "task", title: "From {{body.who}}", description: "d", assign_to: "dev" }] });
    expect(mk.isError).toBeFalsy();
    const id2 = mk.structuredContent.trigger.id as string;
    const sent = await work.call("polpo_trigger_test", { id: id2, action: "send", sample: { body: { who: "mcp" }, run_actions: true } });
    expect(sent.content[0].text).toMatch(/actions queued/);
    const dd = await settled(id2, sent.structuredContent.delivery.id);
    expect(dd.actions[0]).toMatchObject({ status: "done", refs: { taskId: expect.any(String) } });
    const prev = await work.call("polpo_trigger_test", { id: id2, action: "preview_actions" });
    expect(prev.content[0].text).toContain("From mcp");
    // the task's text shows where it came from
    const taskText = await read.call("polpo_task_get", { id: dd.actions[0].refs.taskId });
    expect(taskText.content[0].text).toContain(`started by trigger MCP form [${id2}]`);
  }, 120_000);
});
