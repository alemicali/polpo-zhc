import { describe, it, expect, vi, afterEach } from "vitest";
import type { ClassifierContext, ClassifierResult } from "@earendil-works/pi-ai";
import { ChannelGateway } from "../notifications/channel-gateway.js";
import { TelegramCallbackPoller, type TelegramGatewayHandler, type TelegramMessage } from "../notifications/channels/telegram.js";
import { GroupIntentArbiter, intentContext, type IntentCandidate, type IntentClassifier, type IntentMessage } from "../notifications/group-intent.js";
import type { PeerStore } from "../core/peer-store.js";
import type { SessionStore } from "../core/session-store.js";
import type { Orchestrator } from "../core/orchestrator.js";
import type { ChannelGatewayConfig } from "../core/types.js";

const GROUP_ID = "telegram:group:-100123";
const GROWTH: IntentCandidate = { key: "growth-bot", name: "Giulia", role: "Growth lead", responsibilities: ["Social campaigns"] };
const OPS: IntentCandidate = { key: "ops-bot", name: "Otto", role: "Operations", responsibilities: ["Invoices"] };

const message = (over: Partial<IntentMessage> = {}): IntentMessage => ({
  conversation: GROUP_ID, messageId: "10", title: "Team", speaker: "Ada",
  text: "how did yesterday's instagram campaign go?", ...over,
});

/** A classifier that answers each question with the probability given for its key. */
function fakeClassifier(p: Record<string, number>) {
  return vi.fn<IntentClassifier>(async (context: ClassifierContext) => ({
    api: "typesafe-system-one", provider: "typesafe", model: "jev-latest", stopReason: "stop", timestamp: 0,
    answers: Object.fromEntries(Object.keys(context.questions).map((k) => [k, { type: "bool" as const, probability: p[k] ?? 0 }])),
  }) as ClassifierResult);
}

// ── The arbiter ──────────────────────────────────────────

describe("GroupIntentArbiter", () => {
  it("asks one yes/no question per agent, on the conversation and each agent's involvement", () => {
    const now = Date.now();
    const transcript = [
      { name: "Ada", text: "can you check the ad budget?", at: now - 5 * 60_000 },
      { name: "Giulia", text: "Sure: 420 € left this week. Want me to move some to stories?", agent: true, to: "Ada", at: now - 4 * 60_000 },
    ];
    const ctx = intentContext(message({ text: "yes, half of it" }), [GROWTH, OPS], transcript, now);
    expect(Object.keys(ctx.questions)).toEqual(["growth-bot", "ops-bot"]);
    expect(ctx.questions["growth-bot"]).toMatchObject({ type: "bool" });
    expect(ctx.questions["growth-bot"]!.instructions).toContain("Giulia (Growth lead)");
    const state = ctx.state as { conversation: Array<Record<string, unknown>>; agentsInGroup: Array<Record<string, unknown>> };
    expect(state.conversation[1]).toMatchObject({ from: "Giulia (agent)", replyingTo: "Ada", minutesAgo: 4 });
    expect(state.agentsInGroup[0]).toMatchObject({ name: "Giulia", spokeInThisConversation: true, lastSpokeMinutesAgo: 4, lastAnswered: "Ada", talkingWith: ["Ada"] });
    expect(state.agentsInGroup[1]).toMatchObject({ name: "Otto", spokeInThisConversation: false, lastSpokeMinutesAgo: null });
  });

  it("keeps one transcript per conversation, a message heard once whichever bot got it", () => {
    const arbiter = new GroupIntentArbiter({ apiKey: () => "k", windowMs: 0 });
    arbiter.hear(GROUP_ID, { name: "Ada", text: "hi all" }, "1");
    arbiter.hear(GROUP_ID, { name: "Ada", text: "hi all" }, "1");
    arbiter.hear(GROUP_ID, { name: "Giulia", text: "hi Ada", agent: true, to: "Ada" });
    for (let i = 0; i < 20; i++) arbiter.hear(GROUP_ID, { name: "Bob", text: `line ${i}` }, String(100 + i));
    expect(arbiter.transcript(GROUP_ID)).toHaveLength(12);
    expect(arbiter.transcript(`${GROUP_ID}:topic:3`)).toEqual([]);
    const fresh = new GroupIntentArbiter({ apiKey: () => "k", windowMs: 0 });
    fresh.hear(GROUP_ID, { name: "Ada", text: "hi all" }, "1");
    fresh.hear(GROUP_ID, { name: "Ada", text: "hi all" }, "1");
    expect(fresh.transcript(GROUP_ID)).toHaveLength(1);
  });

  it("classifies a message once, for the bots whose copies arrive within the window", async () => {
    const classify = fakeClassifier({ "growth-bot": 0.94, "ops-bot": 0.08 });
    const arbiter = new GroupIntentArbiter({ apiKey: () => "k", classify, windowMs: 20 });
    const [a, b] = await Promise.all([arbiter.decide(message(), GROWTH), arbiter.decide(message(), OPS)]);
    expect(a).toEqual({ "growth-bot": 0.94, "ops-bot": 0.08 });
    expect(b).toBe(a);
    expect(classify).toHaveBeenCalledTimes(1);
    await arbiter.decide(message({ messageId: "11" }), GROWTH);
    expect(classify).toHaveBeenCalledTimes(2);
  });

  it("only the bots that got the message are asked about; a late copy gets no say", async () => {
    const classify = fakeClassifier({ "growth-bot": 0.9, "ops-bot": 0.9 });
    const arbiter = new GroupIntentArbiter({ apiKey: () => "k", classify, windowMs: 5 });
    await arbiter.decide(message(), GROWTH);
    expect(Object.keys(classify.mock.calls[0]![0].questions)).toEqual(["growth-bot"]);
    expect(await arbiter.decide(message(), OPS)).toEqual({ "growth-bot": 0.9 });
    expect(classify).toHaveBeenCalledTimes(1);
  });

  it("without a key nobody joins and nothing is called", async () => {
    const classify = fakeClassifier({ "growth-bot": 1 });
    const arbiter = new GroupIntentArbiter({ apiKey: () => undefined, classify, windowMs: 0 });
    expect(arbiter.available).toBe(false);
    expect(await arbiter.decide(message(), GROWTH)).toEqual({});
    expect(classify).not.toHaveBeenCalled();
  });

  it("a failed call means nobody joins, and says why", async () => {
    const log = vi.fn();
    const classify = vi.fn<IntentClassifier>(async () => ({
      api: "typesafe-system-one", provider: "typesafe", model: "jev-latest", answers: {}, stopReason: "error", errorMessage: "429", timestamp: 0,
    }));
    const arbiter = new GroupIntentArbiter({ apiKey: () => "k", classify, log, windowMs: 0 });
    expect(await arbiter.decide(message(), GROWTH)).toEqual({});
    expect(log).toHaveBeenCalledWith("warn", expect.stringContaining("429"));
  });

  it("one person alone with one agent: the agent answers, nothing is asked", async () => {
    const classify = fakeClassifier({ "growth-bot": 0 });
    const arbiter = new GroupIntentArbiter({ apiKey: () => "k", classify, windowMs: 0 });
    expect(await arbiter.decide(message({ text: "I'm talking to you", members: 2 }), GROWTH)).toEqual({ "growth-bot": 1 });
    expect(classify).not.toHaveBeenCalled();
  });

  it("tells the classifier who is in the room: the people besides the speaker", async () => {
    const classify = fakeClassifier({});
    const arbiter = new GroupIntentArbiter({ apiKey: () => "k", classify, windowMs: 5 });
    await Promise.all([arbiter.decide(message({ members: 3 }), GROWTH), arbiter.decide(message({ members: 3 }), OPS)]);
    const group = (classify.mock.calls[0]![0].state as { group: Record<string, unknown> }).group;
    expect(group).toMatchObject({ members: 3, agentsHere: 2, otherPeopleBesidesSpeaker: 0, speakerIsTheOnlyPerson: true, peopleInTheConversation: ["Ada"] });
    await arbiter.decide(message({ messageId: "11", members: 6 }), GROWTH);
    expect((classify.mock.calls[1]![0].state as { group: Record<string, unknown> }).group).toMatchObject({ otherPeopleBesidesSpeaker: 4, speakerIsTheOnlyPerson: false });
  });

  it("the classifier reads the group's transcript", async () => {
    const classify = fakeClassifier({});
    const arbiter = new GroupIntentArbiter({ apiKey: () => "k", classify, windowMs: 0 });
    arbiter.hear(GROUP_ID, { name: "Giulia", text: "Want me to move some budget?", agent: true, to: "Ada" });
    await arbiter.decide(message({ text: "yes please" }), GROWTH);
    const state = classify.mock.calls[0]![0].state as { conversation: Array<{ from: string }> };
    expect(state.conversation.map((l) => l.from)).toEqual(["Giulia (agent)"]);
  });
});

// ── The gateway ──────────────────────────────────────────

function gateway(key: string, config: ChannelGatewayConfig, opts: { enabled?: boolean } = {}) {
  const peerStore = {
    isAllowed: vi.fn(async (id: string) => opts.enabled !== false && id === GROUP_ID),
  } as unknown as PeerStore;
  const orchestrator = {
    getAgents: vi.fn().mockResolvedValue([
      { name: "growth", role: "Growth", identity: { displayName: "Giulia", title: "Growth lead", responsibilities: [{ area: "Social", description: "campaigns" }] } },
      { name: "ops", role: "Operations" },
    ]),
  } as unknown as Orchestrator;
  return new ChannelGateway({
    orchestrator, peerStore, sessionStore: {} as SessionStore, key,
    channelConfig: { type: "telegram", botToken: "fake", chatId: "7", gateway: { enableInbound: true, ...config } },
  });
}

const inbound = (over: Partial<Parameters<ChannelGateway["joinsByIntent"]>[0]> = {}) => ({
  channel: "telegram" as const, externalId: "7", chatId: "-100123", displayName: "Ada",
  text: "how did yesterday's instagram campaign go?", messageId: "10",
  group: { title: "Team", addressed: false }, ...over,
});

describe("ChannelGateway — joining in by intent", () => {
  function pair(p: Record<string, number>, growth: ChannelGatewayConfig = {}, ops: ChannelGatewayConfig = {}) {
    const classify = fakeClassifier(p);
    const gws = [
      gateway("growth-bot", { agent: "growth", groupReplies: "intent", ...growth }),
      gateway("ops-bot", { agent: "ops", groupReplies: "intent", ...ops }),
    ];
    const arbiter = new GroupIntentArbiter({ apiKey: () => "k", classify, windowMs: 20 });
    gws.forEach((g) => g.setIntentArbiter(arbiter));
    return { growth: gws[0]!, ops: gws[1]!, classify };
  }

  it("the agent above the threshold joins, the other keeps quiet, with one call", async () => {
    const { growth, ops, classify } = pair({ "growth-bot": 0.94, "ops-bot": 0.08 });
    expect(await Promise.all([growth.joinsByIntent(inbound()), ops.joinsByIntent(inbound())])).toEqual([true, false]);
    expect(classify).toHaveBeenCalledTimes(1);
    const state = classify.mock.calls[0]![0].state as { agentsInGroup: Array<{ name: string; role: string; responsibilities: string[] }> };
    expect(state.agentsInGroup[0]).toMatchObject({ name: "Giulia", role: "Growth lead", responsibilities: ["Social: campaigns"], spokeInThisConversation: false });
  });

  it("the threshold is per channel", async () => {
    const { growth } = pair({ "growth-bot": 0.8 }, { intentThreshold: 0.9 });
    expect(await growth.joinsByIntent(inbound())).toBe(false);
  });

  it("several agents can join the same message", async () => {
    const { growth, ops } = pair({ "growth-bot": 0.8, "ops-bot": 0.75 });
    expect(await Promise.all([growth.joinsByIntent(inbound()), ops.joinsByIntent(inbound())])).toEqual([true, true]);
  });

  it("a bot in mentions mode is not a candidate and never joins", async () => {
    const { growth, ops, classify } = pair({ "growth-bot": 0.9, "ops-bot": 0.9 }, {}, { groupReplies: "mentions" });
    expect(await Promise.all([ops.joinsByIntent(inbound()), growth.joinsByIntent(inbound())])).toEqual([false, true]);
    expect(Object.keys(classify.mock.calls[0]![0].questions)).toEqual(["growth-bot"]);
  });

  it("nothing is asked for addressed messages, commands, or groups not enabled", async () => {
    const classify = fakeClassifier({ "x-bot": 1 });
    const gw = gateway("x-bot", { agent: "growth", groupReplies: "intent" }, { enabled: false });
    gw.setIntentArbiter(new GroupIntentArbiter({ apiKey: () => "k", classify, windowMs: 0 }));
    expect(await gw.joinsByIntent(inbound())).toBe(false);
    expect(await gw.joinsByIntent(inbound({ text: "/tasks", messageId: "12" }))).toBe(false);
    expect(await gw.joinsByIntent(inbound({ group: { addressed: true }, messageId: "13" }))).toBe(false);
    expect(classify).not.toHaveBeenCalled();
  });
});

// ── The Telegram bot ─────────────────────────────────────

describe("TelegramCallbackPoller — joining in by intent", () => {
  afterEach(() => vi.unstubAllGlobals());

  function poller(joins: boolean) {
    const sent: { method: string; body: any }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { body?: unknown }) => {
      const method = String(url).split("/").pop()!;
      if (method === "getMe") return new Response(JSON.stringify({ ok: true, result: { id: 999, username: "polpo_test_bot", can_read_all_group_messages: true } }));
      if (method.startsWith("getChatMemberCount")) return new Response(JSON.stringify({ ok: true, result: 2 }));
      sent.push({ method, body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body });
      return new Response(JSON.stringify({ ok: true, result: {} }));
    }));
    const handler = {
      handleInboundMessage: vi.fn(async () => ({ text: "on it" })),
      handleApprovalCallback: vi.fn(async () => undefined),
      joinsByIntent: vi.fn(async () => joins),
    } satisfies TelegramGatewayHandler;
    const p = new TelegramCallbackPoller("token", "7");
    p.setGateway(handler);
    const m: TelegramMessage = {
      message_id: 42, chat: { id: -100123, type: "supergroup", title: "Team" },
      from: { id: 7, is_bot: false, first_name: "Ada" }, text: "how did the campaign go?",
    };
    const handle = () => (p as any).handleMessage(m) as Promise<void>;
    return { handle, handler, sent };
  }

  it("answers an unaddressed message the agent joins, quoting it", async () => {
    const { handle, handler, sent } = poller(true);
    await handle();
    expect(handler.joinsByIntent).toHaveBeenCalledWith("7", "-100123", "how did the campaign go?", "Ada", "42", { title: "Team", threadId: undefined, addressed: false, members: 2 });
    expect(handler.handleInboundMessage).toHaveBeenCalledWith("7", "-100123", "how did the campaign go?", "Ada", "42", [], { title: "Team", threadId: undefined, addressed: true });
    expect(sent.find((s) => s.method === "sendMessage")!.body).toMatchObject({ reply_parameters: { message_id: 42 } });
  });

  it("otherwise keeps it as context and sends nothing", async () => {
    const { handle, handler, sent } = poller(false);
    await handle();
    expect(handler.handleInboundMessage).toHaveBeenCalledWith("7", "-100123", "how did the campaign go?", "Ada", "42", [], { title: "Team", threadId: undefined, addressed: false });
    expect(sent).toEqual([]);
  });
});
