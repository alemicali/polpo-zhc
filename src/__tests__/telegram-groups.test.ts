import { describe, it, expect, vi, afterEach } from "vitest";
import { ChannelGateway, type ChannelChatRunner } from "../notifications/channel-gateway.js";
import { TelegramCallbackPoller, type TelegramGatewayHandler, type TelegramMessage } from "../notifications/channels/telegram.js";
import { botJoined, groupAddressing, topicOf, type InboundGroup } from "../notifications/telegram-groups.js";
import type { PeerStore } from "../core/peer-store.js";
import type { SessionStore } from "../core/session-store.js";
import type { Orchestrator } from "../core/orchestrator.js";
import type { ChannelGatewayConfig } from "../core/types.js";

const ME = { id: 999, username: "polpo_test_bot" };
const GROUP = { id: -100123, type: "supergroup" as const, title: "Team" };

const msg = (over: Partial<TelegramMessage>): TelegramMessage => ({
  message_id: 10, chat: GROUP, from: { id: 7, is_bot: false, first_name: "Ada" }, ...over,
});

// ── Which messages are for the bot ──────────────────────

describe("groupAddressing", () => {
  it("a mention addresses the bot and is removed from the text", () => {
    const m = msg({ text: "@polpo_test_bot what's on today?", entities: [{ type: "mention", offset: 0, length: 15 }] });
    expect(groupAddressing(m, ME)).toEqual({ addressed: true, forOtherBot: false, text: "what's on today?" });
  });

  it("mentions are matched case-insensitively, also in the middle of the text", () => {
    const m = msg({ text: "hey @Polpo_Test_Bot, summarize", entities: [{ type: "mention", offset: 4, length: 15 }] });
    expect(groupAddressing(m, ME).text).toBe("hey, summarize");
  });

  it("a text mention of the bot's user id addresses it", () => {
    const m = msg({ text: "Polpo help", entities: [{ type: "text_mention", offset: 0, length: 5, user: { id: 999, is_bot: true, first_name: "Polpo" } }] });
    expect(groupAddressing(m, ME)).toMatchObject({ addressed: true, text: "help" });
  });

  it("mentions of other people or bots do not", () => {
    const m = msg({ text: "@someone_else ciao", entities: [{ type: "mention", offset: 0, length: 13 }] });
    expect(groupAddressing(m, ME)).toEqual({ addressed: false, forOtherBot: false, text: "@someone_else ciao" });
  });

  it("a reply to one of the bot's messages addresses it", () => {
    const m = msg({ text: "and tomorrow?", reply_to_message: msg({ message_id: 9, from: { id: 999, is_bot: true, first_name: "Polpo" } }) });
    expect(groupAddressing(m, ME)).toEqual({ addressed: true, forOtherBot: false, text: "and tomorrow?" });
  });

  it("the forum topic opener is not a reply to the bot", () => {
    const opener = msg({ message_id: 2, from: { id: 999, is_bot: true, first_name: "Polpo" }, forum_topic_created: {} });
    expect(groupAddressing(msg({ text: "hi all", reply_to_message: opener }), ME).addressed).toBe(false);
  });

  it("commands: /cmd@me is for the bot, /cmd@other is ignored, /cmd is for every bot", () => {
    expect(groupAddressing(msg({ text: "/agent@polpo_test_bot backend" }), ME)).toEqual({ addressed: true, forOtherBot: false, text: "/agent backend" });
    expect(groupAddressing(msg({ text: "/agent@other_bot backend" }), ME)).toMatchObject({ addressed: false, forOtherBot: true });
    expect(groupAddressing(msg({ text: "/help" }), ME)).toMatchObject({ addressed: true, text: "/help" });
  });

  it("plain conversation is not addressed; without identity nothing but commands is", () => {
    expect(groupAddressing(msg({ text: "lunch at 1?" }), ME).addressed).toBe(false);
    const m = msg({ text: "@polpo_test_bot hi", entities: [{ type: "mention", offset: 0, length: 15 }] });
    expect(groupAddressing(m, undefined).addressed).toBe(false);
  });

  it("botJoined and topicOf", () => {
    expect(botJoined(msg({ new_chat_members: [{ id: 999, is_bot: true, first_name: "Polpo" }] }), ME)).toBe(true);
    expect(botJoined(msg({ new_chat_members: [{ id: 5, is_bot: false, first_name: "Bob" }] }), ME)).toBe(false);
    expect(botJoined(msg({ group_chat_created: true }), ME)).toBe(true);
    expect(topicOf(msg({ message_thread_id: 4, is_topic_message: true }))).toBe(4);
    expect(topicOf(msg({ message_thread_id: 4 }))).toBeUndefined(); // reply thread in a non-forum group
  });
});

// ── Gateway ─────────────────────────────────────────────

function createPeerStore() {
  const sessions = new Map<string, string>();
  const allowlist = new Set<string>();
  const peers = new Map<string, { id: string; displayName?: string }>();
  const store = {
    allowlist,
    sessions,
    peers,
    getPeer: vi.fn(async (id: string) => peers.get(id)),
    upsertPeer: vi.fn(async (input: any) => {
      const id = `${input.channel}:${input.externalId}`;
      const peer = { ...input, id, firstSeenAt: "", lastSeenAt: "" };
      peers.set(id, peer);
      return peer;
    }),
    listPeers: vi.fn(async () => [...peers.values()]),
    isAllowed: vi.fn(async (id: string, cfg?: ChannelGatewayConfig) => cfg?.dmPolicy === "open" || allowlist.has(id)),
    addToAllowlist: vi.fn(async (id: string) => { allowlist.add(id); }),
    removeFromAllowlist: vi.fn(async (id: string) => { allowlist.delete(id); }),
    getAllowlist: vi.fn(async () => [...allowlist]),
    createPairingRequest: vi.fn(),
    resolvePairing: vi.fn(),
    getPendingPairing: vi.fn(async () => undefined),
    listPendingPairings: vi.fn(async () => []),
    rejectPairing: vi.fn(async () => false),
    cleanExpiredPairings: vi.fn(async () => 0),
    getSessionId: vi.fn(async (key: string) => sessions.get(key)),
    setSessionId: vi.fn(async (key: string, id: string) => { sessions.set(key, id); }),
    clearSession: vi.fn(async (key: string) => { sessions.delete(key); }),
    linkPeers: vi.fn(),
    resolveCanonicalId: vi.fn(async (id: string) => id),
    updatePresence: vi.fn(),
    getPresence: vi.fn(async () => []),
    prunePresence: vi.fn(async () => 0),
  };
  return store as unknown as PeerStore & { allowlist: Set<string>; sessions: Map<string, string>; peers: typeof peers };
}

function createSessionStore() {
  const sessions = new Map<string, { id: string; title?: string; agent?: string; scope?: string; updatedAt: string }>();
  const messages = new Map<string, { role: string; content: string }[]>();
  let seq = 0;
  const store = {
    sessions,
    create: vi.fn(async (title?: string, agent?: string, opts?: { scope?: string }) => {
      const id = `s${++seq}`;
      sessions.set(id, { id, title, agent, scope: opts?.scope, updatedAt: new Date().toISOString() });
      return id;
    }),
    addMessage: vi.fn(async (id: string, role: string, content: string) => {
      messages.set(id, [...(messages.get(id) ?? []), { role, content }]);
    }),
    getRecentMessages: vi.fn(async (id: string) => (messages.get(id) ?? []).map((m, i) => ({ id: `m${i}`, ts: "", ...m }))),
    getSession: vi.fn(async (id: string) => sessions.get(id)),
    getLatestSession: vi.fn(async (agent?: string | null) => [...sessions.values()].filter(s => !s.scope && (s.agent ?? null) === (agent ?? null)).at(-1)),
    close: vi.fn(),
  };
  return store as unknown as SessionStore & { sessions: typeof sessions };
}

function setup(gatewayConfig: ChannelGatewayConfig = { enableInbound: true, dmPolicy: "pairing", agent: "backend" }) {
  const peerStore = createPeerStore();
  const sessionStore = createSessionStore();
  const runner = vi.fn<ChannelChatRunner>().mockResolvedValue({ text: "agent reply" });
  const resolver = { approve: vi.fn(async () => ({ ok: true })), reject: vi.fn(async () => ({ ok: true })) };
  const orchestrator = {
    getStore: vi.fn().mockReturnValue({ getAllTasks: vi.fn().mockResolvedValue([]), getState: vi.fn().mockResolvedValue({ processes: [] }) }),
    getAgents: vi.fn().mockResolvedValue([{ name: "backend", role: "Backend" }, { name: "growth", role: "Growth" }]),
    getAllMissions: vi.fn().mockResolvedValue([]),
    getConfig: vi.fn().mockReturnValue({ project: "test", settings: {} }),
    getApprovalRequest: vi.fn(),
    getChannelChatRunner: vi.fn().mockReturnValue(runner),
  } as unknown as Orchestrator;
  const gateway = new ChannelGateway({
    orchestrator, peerStore, sessionStore, approvalResolver: resolver,
    channelConfig: { type: "telegram", botToken: "fake", chatId: "7", gateway: gatewayConfig },
  });
  void peerStore.addToAllowlist("telegram:7"); // Ada is paired in a private chat
  let id = 100;
  const say = (from: { id: string; name: string }, text: string, group: Partial<InboundGroup> = {}, chatId = String(GROUP.id)) =>
    gateway.handleMessageReply({
      channel: "telegram", externalId: from.id, chatId, displayName: from.name, text, messageId: String(id++),
      group: { title: "Team", addressed: true, ...group },
    });
  const lastTurn = () => {
    const call = runner.mock.calls.at(-1)![0];
    return { ...call, text: call.messages.at(-1)!.content as string };
  };
  return { gateway, peerStore, sessionStore, runner, resolver, say, lastTurn };
}

const ADA = { id: "7", name: "Ada" };   // paired
const BOB = { id: "55", name: "Bob" };  // only a member of the group
const GROUP_ID = `telegram:group:${GROUP.id}`;

describe("ChannelGateway — groups", () => {
  it("stays silent in a group that is not enabled, and says how to enable it when called", async () => {
    const { say, runner, peerStore } = setup();
    expect(await say(BOB, "lunch?", { addressed: false })).toBeUndefined();
    const reply = await say(BOB, "hello");
    expect(reply?.text).toContain("/enable");
    expect(runner).not.toHaveBeenCalled();
    expect(peerStore.upsertPeer).not.toHaveBeenCalled(); // no pairing codes, no peers from strangers
  });

  it("/enable needs someone already authorized; then everyone in the group can talk", async () => {
    const { say, runner, peerStore, lastTurn } = setup();
    expect((await say(BOB, "/enable"))?.text).toContain("Only someone already authorized");
    expect(peerStore.allowlist.has(GROUP_ID)).toBe(false);

    expect((await say(ADA, "/enable"))?.text).toContain("everyone in this group can now talk to backend");
    expect(peerStore.allowlist.has(GROUP_ID)).toBe(true);
    expect(peerStore.peers.get(GROUP_ID)?.displayName).toBe("Team");

    expect((await say(BOB, "what's the status?"))?.text).toBe("agent reply");
    expect(lastTurn()).toMatchObject({ agent: "backend", text: "Bob: what's the status?" });
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it("unaddressed messages become context for the next turn, once", async () => {
    const { say, lastTurn, peerStore } = setup();
    peerStore.allowlist.add(GROUP_ID);
    await say(ADA, "deploy is at 5", { addressed: false });
    await say(BOB, "[photo] the new logo", { addressed: false });
    await say(BOB, "can you check the deploy?");
    expect(lastTurn().text).toBe("[Earlier in the group, not addressed to you]\nAda: deploy is at 5\nBob: [photo] the new logo\n\nBob: can you check the deploy?");
    await say(ADA, "thanks");
    expect(lastTurn().text).toBe("Ada: thanks");
  });

  it("a group has its own session, separate from DMs and from the web chat (even in shared mode)", async () => {
    const { gateway, say, lastTurn, peerStore, sessionStore } = setup({ enableInbound: true, dmPolicy: "pairing", agent: "backend", sessionMode: "shared" });
    peerStore.allowlist.add(GROUP_ID);
    const web = await sessionStore.create("web chat", "backend");
    await say(ADA, "in the group");
    const groupSession = lastTurn().sessionId;
    expect(groupSession).not.toBe(web);
    expect(peerStore.sessions.get(`${GROUP_ID}#agent:backend`)).toBe(groupSession);
    expect(sessionStore.sessions.get(groupSession)).toMatchObject({ title: "Team (telegram group)", scope: GROUP_ID });

    await gateway.handleMessageReply({ channel: "telegram", externalId: "7", chatId: "7", displayName: "Ada", text: "in private" });
    expect(lastTurn().sessionId).toBe(web); // the DM keeps continuing the web chat (shared mode)
  });

  it("each forum topic is a conversation of its own", async () => {
    const { say, lastTurn, peerStore } = setup();
    peerStore.allowlist.add(GROUP_ID);
    await say(ADA, "topic 1", { threadId: 1 });
    const first = lastTurn().sessionId;
    await say(ADA, "topic 2", { threadId: 2 });
    expect(lastTurn().sessionId).not.toBe(first);
    await say(ADA, "topic 1 again", { threadId: 1 });
    expect(lastTurn().sessionId).toBe(first);
  });

  it("/agent in a group picks the interlocutor of the group, not of the person", async () => {
    const { gateway, say, lastTurn, peerStore } = setup({ enableInbound: true, dmPolicy: "pairing" });
    peerStore.allowlist.add(GROUP_ID);
    expect((await say(BOB, "/agent growth"))?.text).toContain("This group is now talking to growth");
    await say(BOB, "ideas?");
    expect(lastTurn().agent).toBe("growth");
    // Ada's private chat still talks to the orchestrator.
    expect(await peerStore.getSessionId("telegram:7#active-agent")).toBeUndefined();
    expect((await gateway.handleMenuCallback("agent", "__polpo__", { channel: "telegram", externalId: "55", chatId: String(GROUP.id), group: { addressed: true } })))
      .toContain("Polpo");
  });

  it("approvals stay with authorized people, also from group buttons and commands", async () => {
    const { gateway, say, resolver, peerStore } = setup();
    peerStore.allowlist.add(GROUP_ID);
    expect((await say(BOB, "/approve abc"))?.text).toContain("Only people authorized");
    expect(await gateway.handleApprovalCallback("approve", "req", String(GROUP.id), "Bob", { peerId: "telegram:55" }))
      .toContain("Only people authorized");
    expect(resolver.approve).not.toHaveBeenCalled();

    expect(await gateway.handleApprovalCallback("approve", "req", String(GROUP.id), "Ada", { peerId: "telegram:7" })).toBe("Approved successfully");
    // The owner's chat is trusted even without pairing.
    expect(await gateway.handleApprovalCallback("approve", "req2", "1", "Owner", { peerId: "telegram:1", trusted: true })).toBe("Approved successfully");
  });

  it("reject feedback is waited for from the person who pressed the button only", async () => {
    const { gateway, say, resolver, peerStore, runner } = setup();
    peerStore.allowlist.add(GROUP_ID);
    await gateway.handleApprovalCallback("reject", "req", String(GROUP.id), "Ada", { peerId: "telegram:7", pendingKey: `${GROUP.id}:7` });
    await say(BOB, "unrelated question");
    expect(resolver.reject).not.toHaveBeenCalled();
    expect(runner).toHaveBeenCalledTimes(1);
    await say(ADA, "needs tests");
    expect(resolver.reject).toHaveBeenCalledWith("req", "Ada: needs tests".slice(5), "telegram:7");
  });

  it("joining: enabled when added by an authorized person; a migration keeps the activation", async () => {
    const { gateway, peerStore } = setup();
    expect(await gateway.handleGroupJoined("telegram", "-1", "Other", "55")).toContain("/enable");
    expect(peerStore.allowlist.has("telegram:group:-1")).toBe(false);
    expect(await gateway.handleGroupJoined("telegram", "-1", "Other", "7")).toContain("Enabled");
    expect(peerStore.allowlist.has("telegram:group:-1")).toBe(true);

    await gateway.handleGroupMigrated("telegram", "-1009", "-1", "Other");
    expect(peerStore.allowlist.has("telegram:group:-1")).toBe(false);
    expect(peerStore.allowlist.has("telegram:group:-1009")).toBe(true);
  });

  it("people in the channel's allowFrom count as authorized for /enable", async () => {
    const { say, peerStore } = setup({ enableInbound: true, dmPolicy: "pairing", agent: "backend", allowFrom: ["55"] });
    peerStore.isAllowed = vi.fn(async (id: string, cfg?: ChannelGatewayConfig) =>
      peerStore.allowlist.has(id) || !!cfg?.allowFrom?.includes(id.split(":").pop()!)) as any;
    expect((await say(BOB, "/enable"))?.text).toContain("everyone in this group");
  });

  it("/disable turns the bot off for the group (authorized people only)", async () => {
    const { say, peerStore, runner } = setup();
    peerStore.allowlist.add(GROUP_ID);
    expect((await say(BOB, "/disable"))?.text).toContain("Only someone already authorized");
    expect((await say(ADA, "/disable"))?.text).toContain("Disabled");
    expect((await say(BOB, "hello"))?.text).toContain("not enabled");
    expect(runner).not.toHaveBeenCalled();
  });

  it("message ids are per chat: the same id in two chats is not a duplicate", async () => {
    const { gateway, peerStore, runner } = setup();
    peerStore.allowlist.add(GROUP_ID);
    const base = { channel: "telegram" as const, externalId: "7", displayName: "Ada", text: "hi", messageId: "5" };
    await gateway.handleMessageReply({ ...base, chatId: "7" });
    await gateway.handleMessageReply({ ...base, chatId: String(GROUP.id), group: { addressed: true } });
    expect(runner).toHaveBeenCalledTimes(2);
  });
});

// ── Poller: from Telegram updates to the gateway and back ──

describe("TelegramCallbackPoller — groups", () => {
  afterEach(() => vi.unstubAllGlobals());

  function poller() {
    const sent: { method: string; body: any }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { body?: unknown }) => {
      const method = String(url).split("/").pop()!;
      if (method === "getMe") return new Response(JSON.stringify({ ok: true, result: { id: 999, username: "polpo_test_bot", can_read_all_group_messages: true } }));
      sent.push({ method, body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body });
      return new Response(JSON.stringify({ ok: true, result: {} }));
    }));
    const handler = {
      handleInboundMessage: vi.fn(async () => ({ text: "on it" })),
      handleApprovalCallback: vi.fn(async () => undefined),
      handleGroupEvent: vi.fn(async () => "welcome"),
    } satisfies TelegramGatewayHandler;
    const p = new TelegramCallbackPoller("token", "7");
    p.setGateway(handler);
    const handle = (m: TelegramMessage) => (p as any).handleMessage(m) as Promise<void>;
    return { handle, handler, sent };
  }

  it("passes unaddressed messages as context and sends nothing", async () => {
    const { handle, handler, sent } = poller();
    await handle(msg({ text: "lunch at 1?" }));
    expect(handler.handleInboundMessage).toHaveBeenCalledWith("7", String(GROUP.id), "lunch at 1?", "Ada", "10", [], { title: "Team", threadId: undefined, addressed: false });
    expect(sent).toEqual([]);
  });

  it("answers a mention in its topic, quoting the question", async () => {
    const { handle, handler, sent } = poller();
    await handle(msg({ message_id: 42, message_thread_id: 3, is_topic_message: true, text: "@polpo_test_bot status?", entities: [{ type: "mention", offset: 0, length: 15 }] }));
    expect(handler.handleInboundMessage).toHaveBeenCalledWith("7", String(GROUP.id), "status?", "Ada", "42", [], { title: "Team", threadId: 3, addressed: true });
    const reply = sent.find(s => s.method === "sendMessage")!;
    expect(reply.body).toMatchObject({ chat_id: String(GROUP.id), message_thread_id: 3, reply_parameters: { message_id: 42, allow_sending_without_reply: true } });
    expect(sent.find(s => s.method === "sendChatAction")!.body).toMatchObject({ message_thread_id: 3 });
  });

  it("ignores other bots and commands for other bots; reports joins", async () => {
    const { handle, handler, sent } = poller();
    await handle(msg({ text: "beep", from: { id: 5, is_bot: true, first_name: "Other" } }));
    await handle(msg({ text: "/help@other_bot" }));
    expect(handler.handleInboundMessage).not.toHaveBeenCalled();
    await handle(msg({ new_chat_members: [{ id: 999, is_bot: true, first_name: "Polpo" }] }));
    expect(handler.handleGroupEvent).toHaveBeenCalledWith({ kind: "joined", chatId: String(GROUP.id), title: "Team", senderId: "7", senderName: "Ada" });
    expect(sent.find(s => s.method === "sendMessage")!.body.text).toBe("welcome");
  });
});
