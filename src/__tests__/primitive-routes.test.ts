/**
 * The REST routes the MCP primitives use: egress proxies in the settings, an agent's browser egress,
 * running a schedule now, recurring checks, Telegram chats and sending, updating a skill.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentRoutes, configRoutes, scheduleRoutes, taskRoutes } from "@polpo-ai/server";
import { parseEgressProxies } from "@polpo-ai/core";
import { FileConversationCheckStore } from "../stores/file-conversation-check-store.js";
import { ConversationCheckManager } from "../core/conversation-check-manager.js";
import { checkRoutes, telegramRoutes } from "../server/routes/checks.js";
import { skillRoutes } from "../server/routes/skills.js";
import { createAgentSkill } from "../llm/skills.js";

const json = (body: unknown, method = "POST") => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("PATCH /config/settings egressProxies", () => {
  function makeApp() {
    let config: any = { project: "p", teams: [], settings: { maxRetries: 2, egressProxies: { old: "socks5://1.2.3.4:1080" } } };
    const app = configRoutes(() => ({ getConfig: () => config, reloadConfig: async () => true, saveConfig: async (c: any) => { config = c; }, getNotificationRouter: () => null }));
    return { app, get config() { return config; } };
  }

  it("replaces them, validated as the config file is", async () => {
    const t = makeApp();
    const res = await t.app.request("/settings", json({ egressProxies: { home: "socks5://100.101.55.7:1080", office: "http://proxy.local:3128" } }, "PATCH"));
    expect(res.status).toBe(200);
    expect(t.config.settings.egressProxies).toEqual({ home: "socks5://100.101.55.7:1080", office: "http://proxy.local:3128" });
    const bad = await t.app.request("/settings", json({ egressProxies: { "bad name": "socks5://x:1" } }, "PATCH"));
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/egressProxies\.bad name/);
    const badUrl = await t.app.request("/settings", json({ egressProxies: { home: "ftp://x" } }, "PATCH"));
    expect(badUrl.status).toBe(400);
    expect(t.config.settings.egressProxies.home).toBe("socks5://100.101.55.7:1080");
  });

  it("null (or an empty object) removes them; other settings stay", async () => {
    const t = makeApp();
    expect((await t.app.request("/settings", json({ egressProxies: null }, "PATCH"))).status).toBe(200);
    expect(t.config.settings.egressProxies).toBeUndefined();
    expect(t.config.settings.maxRetries).toBe(2);
  });

  it("parseEgressProxies is the config file's rule", () => {
    expect(parseEgressProxies({ a: "socks5h://h:1" })).toEqual({ a: "socks5h://h:1" });
    expect(() => parseEgressProxies({ a: 1 })).toThrow(/egressProxies\.a/);
    expect(() => parseEgressProxies([])).toThrow();
  });
});

describe("PATCH /agents/:name browserEgress", () => {
  it("passes the agent's browser egress to the update", async () => {
    const agent: any = { name: "coach", role: "Coach" };
    const updateAgent = vi.fn(async (_name: string, u: any) => { Object.assign(agent, u); return agent; });
    const app = agentRoutes(() => ({ getAgents: async () => [agent], updateAgent } as any));
    const res = await app.request("/coach", json({ browserEgress: "home" }, "PATCH"));
    expect(res.status).toBe(200);
    expect(updateAgent).toHaveBeenCalledWith("coach", { browserEgress: "home" });
    expect((await res.json()).data.browserEgress).toBe("home");
  });

  it("computers: null or [] clears the list (live: MCP could only leave computers: [])", async () => {
    const agent: any = { name: "coach", role: "Coach", computers: ["nina"] };
    const updateAgent = vi.fn(async (_name: string, u: any) => { Object.assign(agent, u); return agent; });
    const app = agentRoutes(() => ({ getAgents: async () => [agent], updateAgent, computerIds: () => ["nina"] } as any));
    for (const computers of [null, []]) {
      agent.computers = ["nina"];
      const res = await app.request("/coach", json({ computers }, "PATCH"));
      expect(res.status).toBe(200);
      expect(updateAgent).toHaveBeenLastCalledWith("coach", { computers: undefined });
    }
    expect((await app.request("/coach", json({ computers: ["ghost"] }, "PATCH"))).status).toBe(400);
  });
});

describe("POST /tasks dependsOn", () => {
  it("refuses a dependency that does not exist (live: the task stayed pending for ever)", async () => {
    const tasks = new Map<string, any>([["t1", { id: "t1", title: "First", status: "done" }]]);
    const addTask = vi.fn(async (t: any) => { const task = { ...t, id: `t${tasks.size + 1}`, status: "pending" }; tasks.set(task.id, task); return task; });
    const app = taskRoutes(() => ({ taskStore: { getTask: async (id: string) => tasks.get(id) }, addTask } as any));
    const bad = await app.request("/", json({ title: "E2E bad dep", description: "x", assignTo: "coach", dependsOn: ["t1", "no-such-task-e2e"] }));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ code: "UNKNOWN_DEPENDENCY", error: expect.stringMatching(/there is no task "no-such-task-e2e"/) });
    expect(addTask).not.toHaveBeenCalled();
    const good = await app.request("/", json({ title: "Second", description: "x", assignTo: "coach", dependsOn: ["t1"] }));
    expect(good.status).toBe(201);
  });
});

describe("POST /schedules/:missionId/run", () => {
  it("runs a scheduled mission now; 404 without a schedule; 409 when it cannot run", async () => {
    const entry = { id: "sched-m1", missionId: "m1", expression: "0 9 * * *", recurring: true, enabled: true };
    const runNow = vi.fn((id: string) => { if (id === "m2") throw new Error("The scheduler cannot execute missions on this instance"); return { ...entry, lastRunAt: "now" }; });
    const scheduler = { getScheduleByMissionId: (id: string) => (id === "m1" || id === "m2" ? entry : undefined), runNow };
    const app = scheduleRoutes(() => ({ getScheduler: () => scheduler, getMission: async () => undefined, updateMission: async () => undefined }));
    const ok = await app.request("/m1/run", { method: "POST" });
    expect(ok.status).toBe(200);
    expect((await ok.json()).data.lastRunAt).toBe("now");
    expect((await app.request("/m9/run", { method: "POST" })).status).toBe(404);
    expect((await app.request("/m2/run", { method: "POST" })).status).toBe(409);
  });
});

describe("POST/PATCH /schedules: the expression is checked first", () => {
  it("refuses '99 99 * * *' with a clear error, and leaves the mission as it was (live: accepted, never ran)", async () => {
    const mission: any = { id: "m1", name: "Digest", status: "draft" };
    const updateMission = vi.fn(async (_id: string, u: any) => Object.assign(mission, u));
    const entry = { id: "sched-m1", missionId: "m1", expression: "0 9 * * *", recurring: true, enabled: true };
    const scheduler = { registerMission: vi.fn(() => entry), getScheduleByMissionId: () => entry, rescheduleMission: vi.fn(), setEnabled: vi.fn() };
    const app = scheduleRoutes(() => ({ getScheduler: () => scheduler, getMission: async () => mission, updateMission }));
    const bad = await app.request("/", json({ missionId: "m1", expression: "99 99 * * *", recurring: true }));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ code: "INVALID_EXPRESSION", error: expect.stringMatching(/Invalid cron expression "99 99 \* \* \*": minute "99": 99 is not between 0 and 59/) });
    expect(updateMission).not.toHaveBeenCalled();
    expect(mission.status).toBe("draft");
    expect((await app.request("/", json({ missionId: "m1", expression: "0 3 1 1 *", recurring: true }))).status).toBe(201);
    const patch = await app.request("/m1", json({ expression: "61 * * * *" }, "PATCH"));
    expect(patch.status).toBe(400);
    expect(scheduler.rescheduleMission).not.toHaveBeenCalled();
  });
});

describe("/checks", () => {
  let dir: string;
  let manager: ConversationCheckManager;
  const sessions = new Map<string, { id: string; title?: string; agent?: string }>([["s1", { id: "s1" }]]);
  const sessionStore = {
    getSession: async (id: string) => sessions.get(id),
    create: async (title?: string, agent?: string) => { const id = `s${sessions.size + 1}-${Date.now()}`; sessions.set(id, { id, ...(title ? { title } : {}), ...(agent ? { agent } : {}) }); return id; },
    deleteSession: async (id: string) => sessions.delete(id),
  } as any;
  const resolveChatTarget = vi.fn(async (to: string) => {
    if (to !== "Team") throw new Error(`No chat "${to}"`);
    return { channel: "ops", chatId: "-100", name: "Team", conversation: "telegram:group:-100" };
  });
  const app = () => checkRoutes(() => ({ checks: manager, sessions: sessionStore, agentNames: async () => ["coach"], resolveChatTarget }));

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "polpo-check-routes-"));
    manager = new ConversationCheckManager(new FileConversationCheckStore(dir));
  });
  afterEach(() => { manager.dispose(); rmSync(dir, { recursive: true, force: true }); });

  it("creates a check in a new session with a Telegram target, lists, changes, confirms and cancels", async () => {
    const res = await app().request("/", json({ agent: "coach", prompt: "Check the PRs", cron: "0 9 * * 1-5", timezone: "Europe/Rome", to: "Team", createdBy: "ada via Claude" }));
    expect(res.status).toBe(201);
    const check = (await res.json()).data;
    expect(check).toMatchObject({ agent: "coach", cron: "0 9 * * 1-5", state: "active", createdBy: "ada via Claude", target: { chatId: "-100", name: "Team" } });
    expect(sessions.get(check.sessionId)).toMatchObject({ agent: "coach", title: expect.stringMatching(/^Check: Check the PRs/) });
    const list = await (await app().request("/?state=active")).json();
    expect(list.data.map((c: { id: string }) => c.id)).toEqual([check.id]);
    // to every 30 minutes: the cron goes, the next run moves
    const patched = await (await app().request(`/${check.id}`, json({ everyMinutes: 30, cron: null }, "PATCH"))).json();
    expect(patched.data).toMatchObject({ everyMinutes: 30 });
    expect(patched.data.cron).toBeUndefined();
    expect(Date.parse(patched.data.nextRunAt) - Date.now()).toBeGreaterThan(25 * 60_000);
    const cancelled = await (await app().request(`/${check.id}`, { method: "DELETE" })).json();
    expect(cancelled.data.state).toBe("cancelled");
    expect((await app().request(`/${check.id}`, json({ prompt: "x" }, "PATCH"))).status).toBe(400);
  });

  it("refuses bad input: no instructions, unknown agent or session or chat, bad cron", async () => {
    expect((await app().request("/", json({ everyMinutes: 30 }))).status).toBe(400);
    expect((await app().request("/", json({ agent: "ghost", prompt: "x", everyMinutes: 30 }))).status).toBe(400);
    expect((await app().request("/", json({ sessionId: "nope", prompt: "x", everyMinutes: 30 }))).status).toBe(404);
    expect((await app().request("/", json({ sessionId: "s1", prompt: "x", everyMinutes: 30, to: "Elsewhere" }))).status).toBe(400);
    const bad = await app().request("/", json({ sessionId: "s1", prompt: "x", cron: "not a cron" }));
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/Invalid cron/);
    expect((await app().request("/", json({ sessionId: "s1", prompt: "x", everyMinutes: 30, extra: true }))).status).toBe(400);
  });

  it("a refused check leaves no chat session behind (live: 'Check: x' stayed after an invalid cron)", async () => {
    const before = [...sessions.keys()];
    const bad = await app().request("/", json({ agent: "coach", message: "x", cron: "not a cron" }));
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/Invalid cron/);
    expect([...sessions.keys()]).toEqual(before);
    // a good one still gets its own session
    const good = await app().request("/", json({ agent: "coach", message: "x", everyMinutes: 30 }));
    expect(good.status).toBe(201);
    expect(sessions.has((await good.json()).data.sessionId)).toBe(true);
  });

  it("DELETE ?purge=true deletes a check for good (a cancelled one too); plain DELETE only cancels", async () => {
    const check = await manager.create({ sessionId: "s1", prompt: "Say hi", everyMinutes: 60 });
    expect((await (await app().request(`/${check.id}`, { method: "DELETE" })).json()).data.state).toBe("cancelled");
    expect((await manager.list()).map((c) => c.id)).toEqual([check.id]);
    const purged = await app().request(`/${check.id}?purge=true`, { method: "DELETE" });
    expect(purged.status).toBe(200);
    expect((await purged.json()).data).toMatchObject({ id: check.id, deleted: true });
    expect(await manager.list()).toEqual([]);
    expect((await app().request(`/${check.id}?purge=true`, { method: "DELETE" })).status).toBe(404);
  });

  it("confirms a proposed check", async () => {
    const proposed = await manager.create({ sessionId: "s1", prompt: "Say hi", everyMinutes: 60, proposed: true });
    const res = await (await app().request(`/${proposed.id}`, json({ confirm: true }, "PATCH"))).json();
    expect(res.data.state).toBe("active");
    expect((await app().request("/nope", json({ confirm: true }, "PATCH"))).status).toBe(404);
  });

  it("answers 503 without checks on the instance", async () => {
    const none = checkRoutes(() => ({ agentNames: async () => [] }));
    expect((await none.request("/")).status).toBe(503);
  });
});

describe("/telegram", () => {
  it("lists bots and chats, and sends text and files through the bots", async () => {
    const sendToChat = vi.fn(async () => "ops");
    const app = telegramRoutes(() => ({
      chatBots: () => [{ key: "ops" }, { key: "coach-bot", agent: "coach" }],
      listChats: async () => [{ id: "telegram:group:-100", kind: "group" as const, chatId: "-100", name: "Team" }],
      resolveChatTarget: async (to: string) => ({ channel: "ops", chatId: "-100", name: to }),
      sendToChat,
    }));
    const chats = await (await app.request("/chats")).json();
    expect(chats.data).toEqual({ bots: [{ key: "ops" }, { key: "coach-bot", agent: "coach" }], chats: [{ id: "telegram:group:-100", kind: "group", chatId: "-100", name: "Team" }] });
    const sent = await app.request("/send", json({ to: "Team", text: "Hi", files: ["out/a.pdf"], agent: "coach" }));
    expect(sent.status).toBe(200);
    expect(sendToChat).toHaveBeenCalledWith({ channel: "ops", chatId: "-100", name: "Team" }, "Hi", "coach", ["out/a.pdf"]);
    expect((await app.request("/send", json({ to: "Team" }))).status).toBe(400);
  });

  it("answers 503 without bots", async () => {
    const app = telegramRoutes(() => ({ chatBots: () => [] }));
    expect((await (await app.request("/chats")).json()).data).toEqual({ bots: [], chats: [] });
    expect((await app.request("/send", json({ to: "x", text: "y" }))).status).toBe(503);
  });
});

describe("PUT /skills/:name", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "polpo-skill-update-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("changes only the fields given and keeps the rest", async () => {
    const polpoDir = join(dir, ".polpo");
    const path = createAgentSkill(polpoDir, "triage", "Triage bugs", "# Old steps\n", { allowedTools: ["bash"] });
    const emit = vi.fn();
    const app = skillRoutes(() => ({ polpoDir, workDir: dir, getAgents: async () => [], emit }));
    const res = await app.request("/triage", json({ content: "# New steps\n" }, "PUT"));
    expect(res.status).toBe(200);
    const md = readFileSync(join(path, "SKILL.md"), "utf-8");
    expect(md).toContain("Triage bugs");
    expect(md).toContain("# New steps");
    expect(md).not.toContain("# Old steps");
    expect(md).toContain("bash");
    expect(emit).toHaveBeenCalledWith("skill:changed", expect.objectContaining({ action: "updated", skillName: "triage" }));
    expect((await app.request("/nope", json({ content: "x" }, "PUT"))).status).toBe(404);
    expect((await app.request("/..%2Fescape", json({ content: "x" }, "PUT"))).status).toBe(404);
  });
});
