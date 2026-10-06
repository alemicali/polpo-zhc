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

  it("mentions-only room with one agent: whatever the person writes is for it", async () => {
    const { say, classify } = setup({ agents: ["polpo"], settings: { replyMode: "mentions" } });
    expect(await say("status?")).toEqual(["Ada: status?", "Polpo: polpo here"]);
    expect(classify).not.toHaveBeenCalled();
  });

  it("the orchestrator runs as itself (no agent)", async () => {
    const { say, runner } = setup({ agents: ["polpo", "growth"], p: { polpo: 0.9 } });
    await say("what is running?");
    expect(runner.mock.calls.some(([r]) => r.agent === undefined)).toBe(true);
  });
});
