import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentConfig } from "@polpo-ai/core";
import type { Room, RoomMessage } from "@polpo-ai/core/room-store";
import { DriveManager, FileDriveStore, drivePrompt, reflectionPrompt, isReflectionScope } from "../core/drive.js";
import { ConversationCheckManager } from "../core/conversation-check-manager.js";
import { FileConversationCheckStore } from "../stores/file-conversation-check-store.js";
import { execConfirmCheck, execScheduleCheck, execSendMessage, type ChatAccess } from "../tools/conversation-check-tools.js";
import { createDriveTools } from "../tools/drive-tools.js";
import { isLearningExcluded } from "../core/learning.js";

type Msg = { id: string; role: "user" | "assistant"; content: string; ts: string };

function sessionStore() {
  const sessions = new Map<string, { id: string; agent?: string; scope?: string; title?: string; createdAt: string; updatedAt: string; messageCount: number }>();
  const messages = new Map<string, Msg[]>();
  let n = 0;
  return {
    create: vi.fn(async (title?: string, agent?: string, opts?: { scope?: string }) => {
      const id = `s${++n}`;
      sessions.set(id, { id, title, agent, scope: opts?.scope, createdAt: "", updatedAt: new Date().toISOString(), messageCount: 0 });
      messages.set(id, []);
      return id;
    }),
    say: (id: string, role: "user" | "assistant", content: string, ts = new Date().toISOString()) => {
      messages.get(id)!.push({ id: `m${++n}`, role, content, ts });
      sessions.get(id)!.updatedAt = ts;
    },
    getSession: vi.fn(async (id: string) => sessions.get(id)),
    listSessions: vi.fn(async () => [...sessions.values()]),
    getMessages: vi.fn(async (id: string) => messages.get(id) ?? []),
  };
}

function roomStore() {
  const rooms: Room[] = [];
  const messages = new Map<string, RoomMessage[]>();
  let n = 0;
  return {
    rooms, messages,
    add: (id: string, title: string) => { rooms.push({ id, kind: "telegram", title, agents: [], settings: {}, createdAt: "", updatedAt: "" }); messages.set(id, []); },
    say: (roomId: string, m: Partial<RoomMessage> & { authorName: string; text: string }) => {
      messages.get(roomId)!.push({ id: `r${++n}`, roomId, ts: new Date(Date.now() + n).toISOString(), authorKind: "person", authorId: m.authorName, ...m });
    },
    listRooms: async () => rooms,
    getRecentMessages: async (id: string, limit: number) => (messages.get(id) ?? []).slice(-limit),
  };
}

let dir: string;
let agents: AgentConfig[];
let sessions: ReturnType<typeof sessionStore>;
let rooms: ReturnType<typeof roomStore>;
let checks: ConversationCheckManager;
let store: FileDriveStore;
let manager: DriveManager;
let emitted: any[];
const runner = vi.fn();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "polpo-drive-"));
  agents = [
    { name: "coach", identity: { personality: "warm, direct, a bit ironic", timezone: "Europe/Rome" },
      drive: { enabled: true, purpose: "Be Alessio's health coach", goals: ["Three workouts a week"], autonomy: "balanced", reflectEveryMinutes: 60 } },
    { name: "quiet" },
  ];
  sessions = sessionStore();
  rooms = roomStore();
  checks = new ConversationCheckManager(new FileConversationCheckStore(dir));
  store = new FileDriveStore(dir);
  emitted = [];
  runner.mockReset();
  manager = new DriveManager({
    getAgents: async () => agents,
    sessions: sessions as any,
    rooms: rooms as any,
    inRoom: (agent, room) => room.agents.includes(agent),
    checks,
    store,
    createReflectionSession: (agent) => sessions.create(`Reflection: ${agent}`, agent, { scope: `reflection:${agent}` }),
    emit: (event, payload) => emitted.push({ event, payload }),
    log: () => {},
  });
  manager.setRunner(runner);
});
afterEach(() => {
  manager.dispose();
  checks.dispose();
  rmSync(dir, { recursive: true, force: true });
});

describe("FileDriveStore", () => {
  it("keeps the self-portrait with its history, the journal and the state", () => {
    expect(store.getSelf("coach")).toBe("");
    store.setSelf("coach", "I am Coach.", "reflection");
    store.setSelf("coach", "I am Coach, ironic.", "chat");
    expect(store.getSelf("coach")).toBe("I am Coach, ironic.");
    expect(store.listSelfHistory("coach").map((r) => [r.before, r.source])).toEqual([["I am Coach.", "chat"], ["", "reflection"]]);
    const entry = store.addJournal("coach", { at: "2026-10-13T08:00:00Z", trigger: "daily", messages: 0, summary: "Nothing to do.", actions: [] });
    expect(entry.id).toMatch(/^ref_/);
    expect(store.listJournal("coach")).toEqual([entry]);
    expect(store.getState("coach")).toEqual({ cursors: {}, roomCursors: {} });
  });
});

describe("prompts", () => {
  it("the purpose section: purpose, goals, autonomy, self-portrait (or how to write it), customs, intentions", async () => {
    const empty = drivePrompt(agents[0]!, "");
    expect(empty).toContain("Purpose: Be Alessio's health coach");
    expect(empty).toContain("- Three workouts a week");
    expect(empty).toMatch(/Autonomy \(balanced\): Act on what clearly serves/);
    expect(empty).toMatch(/Not written yet\. Define yourself now \(starting from personality: warm, direct, a bit ironic\)/);
    expect(empty).toMatch(/birthdays, name days, anniversaries/);
    const check = await checks.create({ sessionId: "s", agent: "coach", prompt: "", message: "Happy birthday Grazia!", everyMinutes: 0,
      firstRunAt: "2026-10-14T07:00:00Z", why: "Grazia's birthday, Alessio's partner", proposed: true, target: { channel: "b", chatId: "-1", name: "Family" } });
    const full = drivePrompt(agents[0]!, "I am Coach.", [check]);
    expect(full).toContain("I am Coach.");
    expect(full).toContain(`- ${check.id} [proposed, waiting for a yes] Wednesday 2026-10-14 09:00 (Europe/Rome) → Family: Happy birthday Grazia! (why: Grazia's birthday, Alessio's partner)`);
  });

  it("the reflection prompt says why it reflects, the time, and what happened", () => {
    const now = new Date("2026-10-13T06:30:00Z");
    const p = reflectionPrompt(agents[0]!, { trigger: "daily", material: "", count: 0, now, self: "" });
    expect(p).toMatch(/^\[Reflection — your daily reflection: nothing new was said, but time passed\. Now: Tuesday 2026-10-13 08:30 \(Europe\/Rome\)\]/);
    expect(p).toContain("You have no self-portrait yet: write it first (update_self).");
    expect(p).toContain("--- nothing new was said since your last reflection ---");
    expect(reflectionPrompt(agents[0]!, { trigger: "activity", material: "## Group\n[..] Alessio: hi", count: 1, now, self: "me" })).toContain("1 new message(s) since your last reflection");
  });

  it("reflections are not conversations to learn from or reflect on", () => {
    expect(isReflectionScope("reflection:coach")).toBe(true);
    expect(isLearningExcluded("reflection:coach")).toBe(true);
  });
});

describe("DriveManager", () => {
  it("reads its private chats and the groups it takes part in (also what was not for it), then only what is new", async () => {
    const chat = await sessions.create("Diet", "coach");
    sessions.say(chat, "user", "Can I skip the diet tonight?");
    sessions.say(chat, "assistant", "Once, yes.");
    const other = await sessions.create("x", "quiet");
    sessions.say(other, "user", "not for coach");
    const reflection = await sessions.create("Reflection", "coach", { scope: "reflection:coach" });
    sessions.say(reflection, "user", "[Reflection …]");
    rooms.add("telegram:group:-100", "Family");
    rooms.say("telegram:group:-100", { authorName: "Alessio", text: "It's Grazia's birthday today!" });
    rooms.say("telegram:group:-100", { authorKind: "agent", authorId: "coach", authorName: "Coach", text: "Enjoy the cake 🎂" });
    rooms.add("telegram:group:-200", "Work");
    rooms.say("telegram:group:-200", { authorName: "Bob", text: "not coach's group" });

    const first = await manager.collect("coach", store.getState("coach"));
    expect(first.count).toBe(4);
    expect(first.text).toMatch(/## Private chat "Diet"\n\[.*\] Them: Can I skip the diet tonight\?\n\[.*\] You: Once, yes\./);
    expect(first.text).toMatch(/## Group "Family" \(id telegram:group:-100\)\n\[.*\] Alessio: It's Grazia's birthday today!\n\[.*\] You: Enjoy the cake/);
    expect(first.text).not.toMatch(/not for coach|not coach's group|\[Reflection/);

    store.saveState("coach", { ...store.getState("coach"), cursors: first.cursors, roomCursors: first.roomCursors, lastReflectionAt: new Date(Date.now() - 1000).toISOString() });
    rooms.say("telegram:group:-100", { authorName: "Grazia", text: "Thanks!", addressedTo: ["coach"] });
    const second = await manager.collect("coach", store.getState("coach"));
    expect(second.count).toBe(1);
    expect(second.text).toMatch(/Grazia \(to you\): Thanks!/);
  });

  it("reflects the first time, then after its interval when something happened, and daily; journals what it did", async () => {
    const t0 = new Date("2026-10-13T10:00:00Z");
    const at = (minutes: number) => new Date(t0.getTime() + minutes * 60_000);
    runner.mockImplementation(async ({ agent }) => {
      manager.setSelf(agent.name, "I am Coach: warm, direct.", "reflection");
      manager.noteAction(agent.name, "planned chk_1 → Family (wishes)");
      return { text: "Tomorrow I wish Grazia a happy birthday." };
    });
    await manager.tick(t0);
    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner.mock.calls[0]![0].prompt).toMatch(/^\[Reflection — your first reflection/);
    const [entry] = manager.listJournal("coach");
    expect(entry).toMatchObject({ trigger: "first", summary: "Tomorrow I wish Grazia a happy birthday.", actions: ["updated its self-portrait", "planned chk_1 → Family (wishes)"] });
    expect(emitted[0]).toMatchObject({ event: "agent:reflected", payload: { agentName: "coach", trigger: "first" } });

    // within its interval: nothing
    await manager.tick(t0);
    expect(runner).toHaveBeenCalledTimes(1);
    // after its interval, but nothing new: nothing
    await manager.tick(at(61));
    expect(runner).toHaveBeenCalledTimes(1);
    // something new after its interval: reflects
    const chat = await sessions.create("Diet", "coach");
    sessions.say(chat, "user", "Went to the gym!", new Date().toISOString());
    await manager.tick(at(62));
    expect(runner).toHaveBeenCalledTimes(2);
    expect(runner.mock.calls[1]![0].prompt).toMatch(/^\[Reflection — 1 new message\(s\) since your last reflection/);
    // a day later, even with nothing new
    await manager.tick(at(25 * 60));
    expect(runner).toHaveBeenCalledTimes(3);
    expect(runner.mock.calls[2]![0].prompt).toMatch(/^\[Reflection — the start of your day\. Now: Wednesday 2026-10-14 13:00/);
    // agents without a drive never reflect
    expect(runner.mock.calls.every(([input]) => input.agent.name === "coach")).toBe(true);
  });

  it("update_self keeps the self-portrait", async () => {
    const [tool] = createDriveTools("coach", manager);
    const result = await tool!.execute("t", { portrait: "I am Coach." } as any);
    expect(result.content[0]!.text).toBe("Self-portrait saved (11 characters).");
    expect(manager.getSelf("coach")).toBe("I am Coach.");
    expect(manager.listSelfHistory("coach")[0]!.source).toBe("chat");
  });
});

describe("intentions", () => {
  const target = { channel: "coach-bot", chatId: "-100", conversation: "telegram:group:-100", name: "Family" };
  const access: ChatAccess = {
    listChats: async () => [],
    chatBots: () => [{ key: "coach-bot", agent: "coach" }],
    resolveChatTarget: async () => target,
    sendToChat: vi.fn(async () => "coach-bot"),
  };

  it("an intention with a why is planned; with autonomy propose it waits for a yes, then confirm_check", async () => {
    const actions: string[] = [];
    const base = { manager: checks, sessionId: "chat-1", agent: "coach", chats: access, timezone: "Europe/Rome", noteAction: (a: string) => actions.push(a) };
    const planned = await execScheduleCheck({ to: "Family", in_minutes: 600, message: "Happy birthday Grazia! 🎉", why: "Grazia's birthday" }, { ...base, autonomy: "balanced" });
    expect(planned).toMatch(/^Check chk_[\w-]+ scheduled once/);
    const proposed = await execScheduleCheck({ to: "Family", in_minutes: 600, message: "Happy birthday Grazia! 🎉", why: "Grazia's birthday" }, { ...base, autonomy: "propose" });
    expect(proposed).toMatch(/^Proposed chk_[\w-]+: once, .* It waits for a yes/);
    const id = /chk_[\w-]+/.exec(proposed)![0];
    expect((await checks.list({ agent: "coach" })).find((c) => c.id === id)).toMatchObject({ state: "proposed", why: "Grazia's birthday" });
    expect(actions[0]).toMatch(/^planned chk_.* → Family \(Grazia's birthday\)/);
    expect(actions[1]).toMatch(/^proposed chk_/);

    // nothing runs while proposed
    const deliver = vi.fn(async () => {});
    checks.setDelivery(deliver);
    checks.setRunner(vi.fn());
    await checks.tick(new Date(Date.now() + 601 * 60_000));
    await vi.waitFor(() => expect((checks as any).running.size).toBe(0));
    expect(deliver).toHaveBeenCalledTimes(1); // only the planned one

    expect(await execConfirmCheck({ id }, { manager: checks, agent: "other", sessionId: "x" })).toBe(`Error: no check ${id}`);
    expect(await execConfirmCheck({ id }, { manager: checks, agent: "coach", timezone: "Europe/Rome" })).toMatch(new RegExp(`^Check ${id} confirmed: it runs at `));
    expect((await checks.list({ agent: "coach" })).find((c) => c.id === id)!.state).toBe("active");
    expect(await execConfirmCheck({ id }, { manager: checks })).toBe(`Check ${id} is active, not waiting for a yes.`);
  });

  it("at a reflection, an agent that proposes does not write on its own: the message is proposed", async () => {
    const ctx = { manager: checks, sessionId: "refl", agent: "coach", chats: access, autonomy: "propose" as const, reflecting: () => true };
    const result = await execSendMessage({ to: "Family", text: "How was the party?" }, ctx);
    expect(result).toMatch(/^Proposed chk_[\w-]+: the message to the Telegram group "Family" waits for a yes/);
    expect(access.sendToChat).not.toHaveBeenCalled();
    // in a conversation (not a reflection), or with more autonomy, it writes
    expect(await execSendMessage({ to: "Family", text: "Hi" }, { ...ctx, reflecting: () => false })).toMatch(/^Sent to/);
    expect(await execSendMessage({ to: "Family", text: "Hi" }, { ...ctx, autonomy: "act" })).toMatch(/^Sent to/);
  });
});

describe("Polpo's drive tools", () => {
  async function polpoTools() {
    const { executeOrchestratorTool } = await import("../llm/orchestrator-tools.js");
    const updateAgent = vi.fn(async () => {});
    const polpo = { getAgents: async () => agents, getDriveManager: () => manager, getConversationCheckManager: () => checks, updateAgent } as any;
    return { run: (name: string, args: Record<string, unknown>) => executeOrchestratorTool(name, args, polpo), updateAgent };
  }

  it("update_agent sets a drive (keeping what is not given); get_agent_drive and reflect_agent", async () => {
    const { run, updateAgent } = await polpoTools();
    await run("update_agent", { name: "coach", drive: { autonomy: "act" } });
    expect(updateAgent).toHaveBeenCalledWith("coach", expect.objectContaining({ drive: expect.objectContaining({ enabled: true, purpose: "Be Alessio's health coach", autonomy: "act" }) }));

    expect(await run("reflect_agent", { agent: "quiet" })).toMatch(/quiet has no drive/);
    runner.mockResolvedValueOnce({ text: "Nothing to do now." });
    expect(await run("reflect_agent", { agent: "coach" })).toBe("coach reflected (0 new message(s)): Nothing to do now.");
    const shown = await run("get_agent_drive", { agent: "coach" });
    expect(shown).toContain("Drive of coach: on. Purpose: Be Alessio's health coach");
    expect(shown).toContain("Autonomy: balanced");
    expect(shown).toContain("(not written yet)");
    expect(shown).toMatch(/Latest reflections:\n- .* \(manual, 0 msg\): Nothing to do now\./);
  });
});

describe("goals: cascade, plan tree, review rhythm", () => {
  it("dueReviews: daily once its day has started; weekly, monthly, quarterly on a new period", async () => {
    const { dueReviews } = await import("../core/drive.js");
    const tz = "Europe/Rome";
    // Wednesday 2026-10-14 06:00 in Rome: the day has not started (07:30)
    expect(dueReviews({ day: "2026-10-13T06:00:00Z", week: "2026-10-12T06:00:00Z", month: "2026-10-01T06:00:00Z", quarter: "2026-10-01T06:00:00Z" }, new Date("2026-10-14T04:00:00Z"), tz)).toEqual([]);
    // 08:00 in Rome: the daily review only (same week, month, quarter)
    expect(dueReviews({ day: "2026-10-13T06:00:00Z", week: "2026-10-12T06:00:00Z", month: "2026-10-01T06:00:00Z", quarter: "2026-10-01T06:00:00Z" }, new Date("2026-10-14T06:00:00Z"), tz)).toEqual(["day"]);
    // already reviewed today
    expect(dueReviews({ day: "2026-10-14T05:40:00Z" }, new Date("2026-10-14T09:00:00Z"), tz)).toEqual([]);
    // Monday 2026-10-19: a new week
    expect(dueReviews({ day: "2026-10-18T06:00:00Z", week: "2026-10-12T06:00:00Z", month: "2026-10-01T06:00:00Z", quarter: "2026-10-01T06:00:00Z" }, new Date("2026-10-19T06:00:00Z"), tz)).toEqual(["day", "week"]);
    // Sunday 2026-11-01: a new month (and still the same week)
    expect(dueReviews({ day: "2026-10-31T06:00:00Z", week: "2026-10-26T06:00:00Z", month: "2026-10-01T06:00:00Z", quarter: "2026-10-01T06:00:00Z" }, new Date("2026-11-01T07:00:00Z"), tz)).toEqual(["day", "month"]);
    // 2027-01-01: new week, month and quarter; a custom day start
    expect(dueReviews({ day: "2026-12-31T06:00:00Z", week: "2026-12-21T06:00:00Z", month: "2026-12-01T06:00:00Z", quarter: "2026-10-01T06:00:00Z" }, new Date("2027-01-01T08:00:00Z"), tz, "09:30")).toEqual([]);
    expect(dueReviews({ day: "2026-12-31T06:00:00Z", week: "2026-12-21T06:00:00Z", month: "2026-12-01T06:00:00Z", quarter: "2026-10-01T06:00:00Z" }, new Date("2027-01-01T09:00:00Z"), tz, "09:30")).toEqual(["day", "week", "month", "quarter"]);
  });

  it("the plan is a tree of goals by horizon with steps, owners, measures and progress", async () => {
    const { describePlanTree } = await import("../core/drive.js");
    const [, add, update] = createDriveTools("coach", manager);
    const text = async (tool: typeof add, args: Record<string, unknown>) => (await tool!.execute("t", args as any)).content[0]!.text;
    const long = await text(add, { title: "Alessio is fit and eats well by spring", horizon: "long", owner: "Alessio", measure: "-6 kg, runs 10 km" });
    const longId = /pln_[\w-]+/.exec(long)![0];
    const week = await text(add, { title: "Three workouts this week", horizon: "week", parent: longId, owner: "Alessio", measure: "3 sessions logged" });
    const weekId = /pln_[\w-]+/.exec(week)![0];
    await text(add, { title: "Learn sports nutrition basics and write a skill", parent: longId });
    expect(await text(add, { title: "x", parent: "pln_nope" })).toMatch(/No goal pln_nope/);
    expect(await text(update, { id: weekId, progress: 66, notes: "Mon and Wed done", status: "doing" })).toBe(`${weekId} [doing, 66%]: Three workouts this week — Mon and Wed done`);

    const tree = describePlanTree(manager.listPlan("coach"));
    expect(tree[0]).toMatch(/^- pln_\S+ \[long goal, todo\] Alessio is fit and eats well by spring \(for Alessio, measure: -6 kg, runs 10 km\)/);
    expect(tree[1]).toMatch(/^ {2}- pln_\S+ \[week goal, doing\] Three workouts this week \(for Alessio, measure: 3 sessions logged, 66%\) — Mon and Wed done/);
    expect(tree[2]).toMatch(/^ {2}- pln_\S+ \[step, todo\] Learn sports nutrition basics/);

    // it is part of every chat
    expect(drivePrompt(agents[0]!, "me", [], manager.listPlan("coach"))).toContain("### Your plan (open goals and steps)");
    await text(update, { id: weekId, status: "done" });
    expect(manager.listPlan("coach").find((i) => i.id === weekId)).toMatchObject({ status: "done", progress: 100 });
  });

  it("the start of the day brings the daily planning, and the weekly review on a new week", async () => {
    store.saveState("coach", { cursors: {}, roomCursors: {}, lastReflectionAt: "2026-10-18T20:00:00Z", lastReviews: { day: "2026-10-18T06:00:00Z", week: "2026-10-12T06:00:00Z", month: "2026-10-01T06:00:00Z", quarter: "2026-10-01T06:00:00Z" } });
    runner.mockResolvedValue({ text: "Planned the week." });
    await manager.tick(new Date("2026-10-19T06:00:00Z")); // Monday 08:00 in Rome
    expect(runner).toHaveBeenCalledTimes(1);
    const prompt = runner.mock.calls[0]![0].prompt as string;
    expect(prompt).toMatch(/^\[Reflection — the start of your day, with your weekly review\. Now: Monday 2026-10-19 08:00 \(Europe\/Rome\)\]/);
    expect(prompt).toContain("- Weekly review: get clear");
    expect(prompt).toContain("- Daily planning: what moved yesterday");
    expect(prompt).not.toContain("Monthly review");
    expect(manager.listJournal("coach")[0]).toMatchObject({ trigger: "daily", reviews: ["day", "week"] });
    expect(store.getState("coach").lastReviews?.week).toBeDefined();
  });

  it("the first reflection sets up every horizon", async () => {
    runner.mockResolvedValue({ text: "Set up." });
    await manager.tick();
    const prompt = runner.mock.calls[0]![0].prompt as string;
    expect(prompt).toContain("Set up: break your purpose and goals down into long-term (6–12 months), quarter, month, week and today goals");
    expect(prompt).toContain("- Quarterly review");
    expect(manager.listJournal("coach")[0]!.reviews).toEqual(["quarter", "month", "week", "day"]);
  });
});
