import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClassifierContext, ClassifierResult } from "@earendil-works/pi-ai";
import type { RoomSettings } from "@polpo-ai/core";
import { FileRoomStore } from "../stores/file-room-store.js";
import { GroupIntentArbiter, type IntentClassifier } from "../notifications/group-intent.js";
import { RoomEngine, mentionedAgents, type AgentProfile, type RoomEvent } from "../rooms/room-engine.js";
import type { ChannelChatRunner } from "../notifications/channel-gateway.js";
import type { SessionStore } from "../core/session-store.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "polpo-room-engine-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const PROFILES: Record<string, AgentProfile> = {
  growth: { id: "growth", name: "Giulia", role: "Growth lead", responsibilities: ["Ads budget"] },
  ops: { id: "ops", name: "Otto", role: "Operations", responsibilities: ["Invoices"] },
  polpo: { id: "polpo", name: "Polpo", role: "the orchestrator", responsibilities: [] },
};

function sessions(): SessionStore {
  const list: Array<{ id: string; agent?: string; scope?: string; updatedAt: string }> = [];
  return {
    listSessions: vi.fn(async () => list),
    create: vi.fn(async (_t?: string, agent?: string, opts?: { scope?: string }) => {
      const id = `s${list.length + 1}`;
      list.push({ id, ...(agent ? { agent } : {}), ...(opts?.scope ? { scope: opts.scope } : {}), updatedAt: new Date().toISOString() });
      return id;
    }),
    getRecentMessages: vi.fn(async () => []),
  } as unknown as SessionStore;
}

/** A classifier answering each agent's question with the probability given for it. */
const classifier = (p: Record<string, number>) => vi.fn<IntentClassifier>(async (context: ClassifierContext) => ({
  api: "typesafe-system-one", provider: "typesafe", model: "jev-latest", stopReason: "stop", timestamp: 0,
  answers: Object.fromEntries(Object.keys(context.questions).map((k) => [k, { type: "bool" as const, probability: p[k] ?? 0 }])),
}) as ClassifierResult);

function setup(opts: { agents?: string[]; settings?: RoomSettings; p?: Record<string, number>; replies?: Record<string, string[]> } = {}) {
  const rooms = new FileRoomStore(dir);
  const classify = classifier(opts.p ?? {});
  const replies = Object.fromEntries(Object.entries(opts.replies ?? {}).map(([k, v]) => [k, [...v]]));
  const runner = vi.fn<ChannelChatRunner>(async ({ agent }) => {
    const who = agent ?? "polpo";
    return { text: replies[who]?.shift() ?? `${who} here` };
  });
  const events: RoomEvent[] = [];
  const engine = new RoomEngine({
    rooms,
    sessions: sessions(),
    runner: () => runner,
    profile: async (a) => PROFILES[a]!,
    intent: new GroupIntentArbiter({ apiKey: () => "k", classify, windowMs: 0 }),
    emit: (e) => events.push(e),
  });
  const ready = rooms.ensureRoom({ id: "web:r1", kind: "web", title: "Team", agents: opts.agents ?? ["growth", "ops"], settings: { replyMode: "intent", ...opts.settings } });
  const say = async (text: string) => {
    await ready;
    await engine.post("web:r1", { id: "web:user", name: "Ada" }, text);
    await engine.settled();
    return (await rooms.getRecentMessages("web:r1", 50)).map((m) => `${m.authorName}: ${m.text}`);
  };
  const turnText = (agent: string) => {
    const call = runner.mock.calls.filter(([r]) => (r.agent ?? "polpo") === agent).at(-1)![0];
    return call.messages.at(-1)!.content as string;
  };
  return { rooms, engine, runner, classify, events, say, turnText };
}

describe("mentionedAgents", () => {
  it("finds @id and @display name, whole words only", () => {
    const all = Object.values(PROFILES);
    expect(mentionedAgents("@growth, and @Otto?", all)).toEqual(["growth", "ops"]);
    expect(mentionedAgents("@growthbot hi", all)).toEqual([]);
    expect(mentionedAgents("no one", all)).toEqual([]);
  });
});

describe("RoomEngine", () => {
  it("a mention: that agent answers, its reply in the room with what it answers", async () => {
    const { say, rooms, events, classify } = setup({ p: { ops: 0.1 } });
    const lines = await say("@growth how much budget is left?");
    expect(lines).toEqual(["Ada: @growth how much budget is left?", "Giulia: growth here"]);
    const [q, a] = await rooms.getRecentMessages("web:r1", 10);
    expect(q).toMatchObject({ authorKind: "person", addressedTo: ["growth"] });
    expect(a).toMatchObject({ authorKind: "agent", authorId: "growth", replyToId: q!.id });
    expect(events.map((e) => e.type)).toEqual(["room:message", "room:typing", "room:message", "room:typing"]);
    // ops asked about the message (below threshold), then about Giulia's reply (between agents)
    expect(classify).toHaveBeenCalledTimes(2);
  });

  it("by intent: every agent above the threshold answers, all at once", async () => {
    const { say, runner } = setup({ p: { growth: 0.9, ops: 0.8 } });
    const lines = await say("budget and the invoice?");
    expect(lines.slice(1).sort()).toEqual(["Giulia: growth here", "Otto: ops here"]);
    // both spoke: neither is asked again about the other's reply
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it("nobody above the threshold: the agent most likely meant answers a person", async () => {
    const { say } = setup({ p: { growth: 0.2, ops: 0.4 } });
    expect(await say("hmm, what now?")).toEqual(["Ada: hmm, what now?", "Otto: ops here"]);
  });

  it("one after the other: the second reads what the first said", async () => {
    const { say, turnText } = setup({ p: { growth: 0.9, ops: 0.8 }, settings: { replyOrder: "sequential", agentToAgent: false } });
    await say("budget and the invoice?");
    expect(turnText("ops")).toContain("Giulia (agent): growth here");
    expect(turnText("ops")).toContain("[Group chat \"Team\"");
  });

  it("agents talk to each other through mentions, and stop", async () => {
    const { say, runner } = setup({
      p: {},
      settings: { maxAgentHops: 2 },
      replies: { growth: ["420 € left. @ops can you pay the ad invoice?", "thanks @ops"], ops: ["Paid. @growth done", "you're welcome @growth"] },
    });
    const lines = await say("@growth budget?");
    expect(lines).toEqual([
      "Ada: @growth budget?",
      "Giulia: 420 € left. @ops can you pay the ad invoice?",
      "Otto: Paid. @growth done",
      "Giulia: thanks @ops",
    ]);
    expect(runner).toHaveBeenCalledTimes(3); // hops 0, 1, 2: the third round (ops again) is past maxAgentHops
  });

  it("no agent-to-agent: replies set nothing off", async () => {
    const { say } = setup({ settings: { agentToAgent: false }, replies: { growth: ["@ops pay it"] } });
    expect(await say("@growth budget?")).toEqual(["Ada: @growth budget?", "Giulia: @ops pay it"]);
  });

  it("mentions-only room with one agent: only a mention is answered (the setting is respected, as seen live)", async () => {
    const { say, classify, runner } = setup({ agents: ["polpo"], settings: { replyMode: "mentions" } });
    expect(await say("status?")).toEqual(["Ada: status?"]);
    expect(runner).not.toHaveBeenCalled();
    expect(await say("@polpo status?")).toEqual(["Ada: status?", "Ada: @polpo status?", "Polpo: polpo here"]);
    expect(classify).not.toHaveBeenCalled();
    // an "intent" room with one agent still answers everything
    rmSync(dir, { recursive: true, force: true });
    dir = mkdtempSync(join(tmpdir(), "polpo-room-engine-"));
    const intent = setup({ agents: ["growth"], settings: { replyMode: "intent" } });
    expect(await intent.say("hello")).toEqual(["Ada: hello", "Giulia: growth here"]);
  });

  it("a mention is never lost to a quick follow-up, and the agent stays typing while its queued turns run (live: no PONG, room_wait settled early)", async () => {
    const { rooms, engine, runner, events } = setup({ agents: ["growth"], settings: { replyMode: "mentions" } });
    await rooms.ensureRoom({ id: "web:r1", kind: "web", title: "Team", agents: ["growth"], settings: { replyMode: "mentions" } });
    // one turn per session (as the completion route's lease does): the second waits for the first
    let busy: Promise<unknown> = Promise.resolve();
    const gates: Array<() => void> = [];
    runner.mockImplementation(async ({ messages }) => {
      const prev = busy;
      let done!: () => void;
      busy = new Promise<void>((r) => { done = r; });
      await prev;
      await new Promise<void>((r) => gates.push(r));
      done();
      // the message it answers is the turn's last line
      const target = String(messages.at(-1)!.content).split("\n").at(-1) ?? "";
      return { text: target.includes("reply with PONG") ? "PONG" : "ok" };
    });
    const user = { id: "web:user", name: "Ada" };
    await engine.post("web:r1", user, "@growth ping 1");
    await vi.waitFor(() => expect(gates).toHaveLength(1));
    await engine.post("web:r1", user, "@growth reply with PONG");
    // a follow-up without a mention right after: it must not swallow the mention's answer
    await engine.post("web:r1", user, "thanks");
    // the first turn ends: the second (the PONG) is queued, so growth is still typing
    gates.shift()!();
    await vi.waitFor(() => expect(gates).toHaveLength(1));
    expect(engine.typingIn("web:r1")).toEqual([{ agent: "growth", name: "Giulia" }]);
    gates.shift()!();
    await engine.settled();
    expect(engine.typingIn("web:r1")).toEqual([]);
    const transcript = (await rooms.getRecentMessages("web:r1", 50)).map((m) => `${m.authorName}: ${m.text}`);
    expect(transcript).toContain("Giulia: PONG");
    expect(runner).toHaveBeenCalledTimes(2); // "thanks" (no mention) is not answered
    // typing went on once and off once
    expect(events.filter((e) => e.type === "room:typing").map((e) => (e as { typing: boolean }).typing)).toEqual([true, false]);
  });

  it("the orchestrator runs as itself (no agent)", async () => {
    const { say, runner } = setup({ agents: ["polpo", "growth"], p: { polpo: 0.9 } });
    await say("what is running?");
    expect(runner.mock.calls.some(([r]) => r.agent === undefined)).toBe(true);
  });
});

describe("group chats in the Grok Bot style", () => {
  it("@everyone calls every agent of the group", async () => {
    expect(mentionedAgents("@everyone where are we?", Object.values(PROFILES))).toEqual(["growth", "ops", "polpo"]);
    expect(mentionedAgents("@tutti a che punto siamo?", [PROFILES.growth!, PROFILES.ops!])).toEqual(["growth", "ops"]);
    expect(mentionedAgents("write to everyone@acme.com", [PROFILES.growth!])).toEqual([]);
    const { say } = setup({ settings: { replyMode: "mentions" } });
    expect(await say("@everyone status?")).toEqual(expect.arrayContaining(["Giulia: growth here", "Otto: ops here"]));
  });

  it("replying to an agent's message calls that agent in, without a mention", async () => {
    const { rooms, engine, runner } = setup({ settings: { replyMode: "mentions" } });
    await rooms.ensureRoom({ id: "web:r1", kind: "web", title: "Team", agents: ["growth", "ops"], settings: { replyMode: "mentions" } });
    await engine.post("web:r1", { id: "web:user", name: "Ada" }, "@ops invoices?");
    await engine.settled();
    const otto = (await rooms.getRecentMessages("web:r1", 10)).find((m) => m.authorId === "ops")!;
    runner.mockClear();
    const reply = await engine.post("web:r1", { id: "web:user", name: "Ada" }, "and the late ones?", { replyToId: otto.id });
    await engine.settled();
    expect(reply).toMatchObject({ replyToId: otto.id, addressedTo: ["ops"] });
    expect(runner.mock.calls.map(([r]) => r.agent)).toEqual(["ops"]);
  });

  it("the owner of the next step answers what nobody picks up, and every agent knows the goal", async () => {
    const { say, turnText } = setup({ p: { growth: 0.2, ops: 0.3 }, settings: { goal: "launch the spring campaign", owner: "growth" } });
    expect(await say("so, what now?")).toContain("Giulia: growth here");
    expect(turnText("growth")).toContain("The group's goal: launch the spring campaign. You own the next step");
  });
});
