import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClassifierContext, ClassifierResult } from "@earendil-works/pi-ai";
import type { RoomMessage } from "@polpo-ai/core";
import { FileRoomStore } from "../stores/file-room-store.js";
import { GroupIntentArbiter, type IntentClassifier } from "../notifications/group-intent.js";
import { TelegramAgentRelay, type RelayBot } from "../rooms/telegram-relay.js";
import { ChannelGateway, type ChannelChatRunner } from "../notifications/channel-gateway.js";
import type { PeerStore } from "../core/peer-store.js";
import type { SessionStore } from "../core/session-store.js";
import type { Orchestrator } from "../core/orchestrator.js";

const CONV = "telegram:group:-100123";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "polpo-relay-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const classifier = (p: Record<string, number>) => vi.fn<IntentClassifier>(async (context: ClassifierContext) => ({
  api: "typesafe-system-one", provider: "typesafe", model: "jev-latest", stopReason: "stop", timestamp: 0,
  answers: Object.fromEntries(Object.keys(context.questions).map((k) => [k, { type: "bool" as const, probability: p[k] ?? 0 }])),
}) as ClassifierResult);

// ── The relay on its own ─────────────────────────────────

function relaySetup(opts: { p?: Record<string, number>; replies?: Record<string, string[]>; member?: Record<string, boolean>; modes?: Record<string, "intent" | "mentions"> } = {}) {
  const rooms = new FileRoomStore(dir);
  const classify = classifier(opts.p ?? {});
  const posted: Array<[string, string]> = [];
  const replies = Object.fromEntries(Object.entries(opts.replies ?? {}).map(([k, v]) => [k, [...v]]));
  const bot = (key: string, id: string, name: string, username: string): RelayBot => ({
    key,
    isIn: () => opts.member?.[key] ?? true,
    mode: async () => opts.modes?.[key] ?? "intent",
    threshold: () => 0.7,
    profile: async () => ({ id, name, role: name, responsibilities: [], aliases: [username] }),
    answer: async (conversation, message) => {
      const text = replies[key]?.shift();
      if (!text) return undefined;
      return rooms.addMessage(conversation, { authorKind: "agent", authorId: id, authorName: name, text, replyToId: message.id });
    },
    post: async (_c, text) => { posted.push([key, text]); },
  });
  const bots = [bot("growth-bot", "growth", "Giulia", "giulia_bot"), bot("ops-bot", "ops", "Otto", "otto_bot")];
  const relay = new TelegramAgentRelay({ rooms, bots: () => bots, intent: new GroupIntentArbiter({ apiKey: () => "k", classify, windowMs: 0 }) });
  const replyFrom = async (id: string, name: string, text: string): Promise<RoomMessage> => {
    await rooms.ensureRoom({ id: CONV, kind: "telegram", title: "Team" });
    return rooms.addMessage(CONV, { authorKind: "agent", authorId: id, authorName: name, text });
  };
  return { rooms, relay, posted, classify, replyFrom };
}

describe("TelegramAgentRelay", () => {
  it("an agent mentions another (by id or @username): it answers, posted by its own bot, and so on", async () => {
    const { relay, posted, replyFrom } = relaySetup({ replies: { "ops-bot": ["Paid. @giulia_bot done"], "growth-bot": ["thanks!"] } });
    relay.agentReplied(CONV, await replyFrom("growth", "Giulia", "420 € left. @ops pay the invoice"), "growth-bot");
    await relay.settled();
    expect(posted).toEqual([["ops-bot", "Paid. @giulia_bot done"], ["growth-bot", "thanks!"]]);
  });

  it("only bots that are in the group, never the author", async () => {
    const { relay, posted, replyFrom } = relaySetup({ member: { "ops-bot": false }, replies: { "ops-bot": ["here"] } });
    relay.agentReplied(CONV, await replyFrom("growth", "Giulia", "@ops pay it"), "growth-bot");
    await relay.settled();
    expect(posted).toEqual([]);
  });

  it("by intent between agents the bar is higher, and only for bots in intent mode", async () => {
    const low = relaySetup({ p: { "ops-bot": 0.8 }, replies: { "ops-bot": ["on it"] } });
    low.relay.agentReplied(CONV, await low.replyFrom("growth", "Giulia", "the invoice is due tomorrow"), "growth-bot");
    await low.relay.settled();
    expect(low.posted).toEqual([]); // 0.8 < 0.7 + 0.15

    rmSync(dir, { recursive: true, force: true }); dir = mkdtempSync(join(tmpdir(), "polpo-relay-"));
    const high = relaySetup({ p: { "ops-bot": 0.9 }, replies: { "ops-bot": ["on it"] } });
    high.relay.agentReplied(CONV, await high.replyFrom("growth", "Giulia", "the invoice is due tomorrow"), "growth-bot");
    await high.relay.settled();
    expect(high.posted).toEqual([["ops-bot", "on it"]]);

    rmSync(dir, { recursive: true, force: true }); dir = mkdtempSync(join(tmpdir(), "polpo-relay-"));
    const mentionsOnly = relaySetup({ p: { "ops-bot": 0.99 }, modes: { "ops-bot": "mentions" }, replies: { "ops-bot": ["on it"] } });
    mentionsOnly.relay.agentReplied(CONV, await mentionsOnly.replyFrom("growth", "Giulia", "the invoice is due tomorrow"), "growth-bot");
    await mentionsOnly.relay.settled();
    expect(mentionsOnly.posted).toEqual([]);
    expect(mentionsOnly.classify).not.toHaveBeenCalled();
  });

  it("stops at maxAgentHops, or when the room turns it off", async () => {
    const { relay, posted, replyFrom, rooms } = relaySetup({ replies: { "ops-bot": ["@growth 1", "@growth 3", "@growth 5"], "growth-bot": ["@ops 2", "@ops 4", "@ops 6"] } });
    relay.agentReplied(CONV, await replyFrom("growth", "Giulia", "@ops 0"), "growth-bot");
    await relay.settled();
    expect(posted.map(([, t]) => t)).toEqual(["@growth 1", "@ops 2", "@growth 3"]); // 3 hops (default)

    await rooms.updateRoom(CONV, { settings: { agentToAgent: false } });
    relay.agentReplied(CONV, await replyFrom("growth", "Giulia", "@ops again"), "growth-bot");
    await relay.settled();
    expect(posted).toHaveLength(3);
  });

  it("a person writing stops the chain under way, once per message whichever bot got it", async () => {
    const { relay, posted, replyFrom } = relaySetup({ replies: { "ops-bot": ["@growth 1"], "growth-bot": ["@ops 2"] } });
    relay.personSpoke(CONV, "1");
    relay.agentReplied(CONV, await replyFrom("growth", "Giulia", "@ops 0"), "growth-bot");
    relay.personSpoke(CONV, "1"); // another bot's copy of the same message: no effect
    relay.personSpoke(CONV, "2"); // a new message: the chain stops
    await relay.settled();
    expect(posted).toEqual([]);
  });
});

// ── Two real gateways of one group ───────────────────────

describe("ChannelGateway — the relay between two bots", () => {
  it("Giulia asks Otto: Otto's bot answers, having read who is in the group and what she said", async () => {
    const rooms = new FileRoomStore(dir);
    const kv = new Map<string, string>();
    const peerStore = {
      isAllowed: vi.fn(async (id: string) => id === "telegram:group:-100123" || id === "telegram:7"),
      upsertPeer: vi.fn(async () => undefined), updatePresence: vi.fn(), getPeer: vi.fn(async () => undefined),
      getSessionId: vi.fn(async (k: string) => kv.get(k)), setSessionId: vi.fn(async (k: string, v: string) => { kv.set(k, v); }),
      resolveCanonicalId: vi.fn(async (id: string) => id),
    } as unknown as PeerStore;
    let seq = 0;
    const sessionStore = {
      create: vi.fn(async () => `s${++seq}`), getSession: vi.fn(async (id: string) => ({ id, updatedAt: new Date().toISOString() })),
      getRecentMessages: vi.fn(async () => []), addMessage: vi.fn(async () => undefined),
    } as unknown as SessionStore;
    const runner = vi.fn<ChannelChatRunner>(async ({ agent }) => ({ text: agent === "growth" ? "420 € left. @ops can you pay the ad invoice?" : "Paid." }));
    const orchestrator = {
      getAgents: vi.fn().mockResolvedValue([
        { name: "growth", role: "Growth", identity: { displayName: "Giulia", title: "Growth lead" } },
        { name: "ops", role: "Operations", identity: { displayName: "Otto", title: "Operations" } },
      ]),
      getChannelChatRunner: vi.fn().mockReturnValue(runner),
      getConfig: vi.fn().mockReturnValue({ project: "test", settings: {} }),
    } as unknown as Orchestrator;
    const gateways = new Map<string, ChannelGateway>();
    for (const [key, agent] of [["growth-bot", "growth"], ["ops-bot", "ops"]] as const) {
      gateways.set(key, new ChannelGateway({
        orchestrator, peerStore, sessionStore, roomStore: rooms, key,
        channelConfig: { type: "telegram", botToken: "fake", chatId: "7", gateway: { enableInbound: true, agent } },
      }));
    }
    const posted: Array<[string, string]> = [];
    const relay = new TelegramAgentRelay({
      rooms,
      bots: () => [...gateways.entries()].map(([key, g]): RelayBot => ({
        key, isIn: (c) => g.isIn(c), mode: (c) => g.relayMode(c), threshold: () => g.relayThreshold(),
        profile: async (c) => ({ ...await g.relayProfile(c), aliases: [] }),
        answer: (c, m) => g.answerAgent(c, m), post: async (_c, text) => { posted.push([key, text]); },
      })),
    });
    for (const g of gateways.values()) g.setAgentRelay(relay);

    // Ada writes once, to Giulia; both bots get the message
    const copy = (key: string, addressed: boolean) => gateways.get(key)!.handleMessageReply({
      channel: "telegram", externalId: "7", chatId: "-100123", displayName: "Ada", text: "budget?", messageId: "500",
      group: { title: "Team", addressed },
    });
    await Promise.all([copy("ops-bot", false), copy("growth-bot", true)]);
    await relay.settled();

    expect(posted).toEqual([["ops-bot", "Paid."]]);
    const opsTurn = runner.mock.calls.find(([r]) => r.agent === "ops")![0].messages.at(-1)!.content as string;
    expect(opsTurn).toContain("[Other agents in this group: Giulia (@growth: Growth lead)");
    expect(opsTurn).toContain("Ada: budget?");
    expect(opsTurn.endsWith("Giulia (agent): 420 € left. @ops can you pay the ad invoice?")).toBe(true);
    const lines = (await rooms.getRecentMessages(CONV, 10)).map((m) => `${m.authorName}: ${m.text}`);
    expect(lines).toEqual(["Ada: budget?", "Giulia: 420 € left. @ops can you pay the ad invoice?", "Otto: Paid."]);
  });
});
