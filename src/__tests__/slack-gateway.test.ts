/**
 * Slack inbound over Socket Mode, with a mocked socket client and web client (never real Slack):
 * DMs become sessions, mentions in channels and threads become group topics, replies go out with
 * chat.postMessage in the thread, files come in (bot-token download) and go out (files.uploadV2),
 * reply buttons are Block Kit and come back as block_actions, /polpo runs commands, the DM policy
 * (pairing, allowlist) applies, a dedicated agent answers, the socket reconnects, and the tokens
 * are never logged.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { ChannelGateway, type ChannelChatRunner } from "../notifications/channel-gateway.js";
import { SlackService, type SlackClientFactory, type SlackSocketLike, type SlackWebLike } from "../notifications/slack-service.js";
import { decodeThreadTs, encodeThreadTs, markdownToMrkdwn, replyBlocks, slackToPlain, splitSlackText } from "../notifications/slack-format.js";
import { SlackChannel } from "../notifications/channels/slack.js";
import type { PeerStore } from "../core/peer-store.js";
import type { SessionStore, Session } from "../core/session-store.js";
import type { Orchestrator } from "../core/orchestrator.js";
import type { ChannelGatewayConfig, ChannelType, NotificationChannelConfig, VaultStore } from "../core/types.js";

const BOT_TOKEN = "xoxb-1111-2222-secretbotvalue";
const APP_TOKEN = "xapp-1-A111-2222-secretappvalue";

// ── Mocked Slack clients ─────────────────────────────────

class FakeSocket implements SlackSocketLike {
  listeners = new Map<string, Array<(...a: any[]) => void>>();
  started = 0;
  failStarts = 0;
  disconnected = 0;
  on(event: string, l: (...a: any[]) => void) { this.listeners.set(event, [...(this.listeners.get(event) ?? []), l]); return this; }
  emit(event: string, ...args: any[]) { for (const l of this.listeners.get(event) ?? []) l(...args); }
  async start() {
    this.started++;
    if (this.failStarts > 0) { this.failStarts--; throw new Error(`An API error occurred: invalid_auth (${APP_TOKEN})`); }
    this.emit("connected");
    return {};
  }
  async disconnect() { this.disconnected++; }
  /** Deliver an envelope as Socket Mode does; resolves once the bridge handled it. */
  async deliver(type: string, body: unknown) {
    const ack = vi.fn().mockResolvedValue(undefined);
    this.emit("slack_event", { ack, type, body, envelope_id: "e1" });
    await flush();
    return ack;
  }
}

function fakeWeb() {
  let n = 0;
  return {
    auth: { test: vi.fn().mockResolvedValue({ ok: true, user_id: "UBOT", user: "polpo", team: "Acme" }) },
    chat: { postMessage: vi.fn().mockImplementation(async () => ({ ok: true, ts: `1700000000.00000${++n}` })) },
    filesUploadV2: vi.fn().mockResolvedValue({ ok: true }),
    users: { info: vi.fn().mockImplementation(async ({ user }: { user: string }) => ({ user: { profile: { display_name: user === "UALICE" ? "Alice" : "Bob" } } })) },
  } satisfies SlackWebLike & Record<string, unknown>;
}

const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };

// ── Stateful fakes (as in the gateway's tests) ───────────

function createPeerStore(): PeerStore & { allow: Set<string> } {
  const sessions = new Map<string, string>();
  const allow = new Set<string>();
  const pairings: Array<{ code: string; peerId: string }> = [];
  return {
    allow,
    getPeer: vi.fn().mockResolvedValue(undefined),
    upsertPeer: vi.fn().mockImplementation(async (input) => ({ id: `${input.channel}:${input.externalId}`, ...input, firstSeenAt: "", lastSeenAt: "" })),
    listPeers: vi.fn().mockResolvedValue([]),
    isAllowed: vi.fn().mockImplementation(async (peerId: string, cfg?: ChannelGatewayConfig) => {
      if (cfg?.dmPolicy === "open") return true;
      if (cfg?.dmPolicy === "disabled") return false;
      return allow.has(peerId) || !!cfg?.allowFrom?.includes(peerId.split(":").pop()!);
    }),
    addToAllowlist: vi.fn().mockImplementation(async (id: string) => { allow.add(id); }),
    removeFromAllowlist: vi.fn(),
    getAllowlist: vi.fn().mockImplementation(async () => [...allow]),
    createPairingRequest: vi.fn().mockImplementation(async (channel: ChannelType, externalId: string) => {
      const r = { id: "p1", peerId: `${channel}:${externalId}`, channel, externalId, code: "PAIR42", createdAt: "", expiresAt: new Date(Date.now() + 3_600_000).toISOString(), resolved: false };
      pairings.push(r);
      return r;
    }),
    resolvePairing: vi.fn(),
    getPendingPairing: vi.fn().mockImplementation(async (peerId: string) => pairings.find((p) => p.peerId === peerId)),
    listPendingPairings: vi.fn().mockResolvedValue([]),
    rejectPairing: vi.fn(),
    cleanExpiredPairings: vi.fn().mockResolvedValue(0),
    getSessionId: vi.fn().mockImplementation(async (k: string) => sessions.get(k)),
    setSessionId: vi.fn().mockImplementation(async (k: string, id: string) => { sessions.set(k, id); }),
    clearSession: vi.fn().mockImplementation(async (k: string) => { sessions.delete(k); }),
    linkPeers: vi.fn(),
    resolveCanonicalId: vi.fn().mockImplementation(async (id: string) => id),
    updatePresence: vi.fn(),
    getPresence: vi.fn().mockResolvedValue([]),
    prunePresence: vi.fn().mockResolvedValue(0),
  } as unknown as PeerStore & { allow: Set<string> };
}

function createSessionStore() {
  const sessions = new Map<string, Session & { agent?: string }>();
  let seq = 0;
  return {
    sessions,
    create: vi.fn().mockImplementation(async (title?: string, agent?: string) => {
      const id = `s${++seq}`;
      const now = new Date().toISOString();
      sessions.set(id, { id, title, agent, createdAt: now, updatedAt: now, messageCount: 0 } as never);
      return id;
    }),
    addMessage: vi.fn(),
    getMessages: vi.fn().mockResolvedValue([]),
    getRecentMessages: vi.fn().mockResolvedValue([]),
    listSessions: vi.fn().mockResolvedValue([]),
    getSession: vi.fn().mockImplementation(async (id: string) => sessions.get(id)),
    getLatestSession: vi.fn().mockResolvedValue(undefined),
    deleteSession: vi.fn().mockResolvedValue(false),
    prune: vi.fn().mockResolvedValue(0),
    close: vi.fn(),
  } as unknown as SessionStore & { sessions: Map<string, Session> };
}

function memoryVault(): VaultStore {
  const m = new Map<string, unknown>();
  return {
    get: async (o: string, s: string) => m.get(`${o}/${s}`) as never,
    set: async (o: string, s: string, e: unknown) => { m.set(`${o}/${s}`, e); },
    remove: async (o: string, s: string) => m.delete(`${o}/${s}`),
  } as unknown as VaultStore;
}

const AGENTS = [{ name: "backend", role: "Backend engineer" }, { name: "growth", role: "Growth" }];

interface Setup {
  gateway?: ChannelGatewayConfig;
  slack?: NotificationChannelConfig["slack"];
  runner?: ChannelChatRunner;
  tokens?: boolean;
}

async function setup(o: Setup = {}) {
  const socket = new FakeSocket();
  const web = fakeWeb();
  const logs: string[] = [];
  const peerStore = createPeerStore();
  const sessionStore = createSessionStore();
  const runner = o.runner ?? vi.fn<ChannelChatRunner>().mockImplementation(async (req) => ({ text: `answer to: ${JSON.stringify(req.messages.at(-1)?.content).slice(0, 200)}` }));
  // a dedicated agent by default: its turns go through the (mocked) chat runner
  const channel: NotificationChannelConfig = { type: "slack", slack: o.slack, gateway: { enableInbound: true, dmPolicy: "open", agent: "backend", ...o.gateway } };
  const channels = { slack: channel };
  const orchestrator = {
    getStore: vi.fn().mockReturnValue({ getAllTasks: vi.fn().mockResolvedValue([]), getState: vi.fn().mockResolvedValue({ processes: [] }) }),
    getAgents: vi.fn().mockResolvedValue(AGENTS),
    getAllMissions: vi.fn().mockResolvedValue([]),
    getConfig: vi.fn().mockReturnValue({ project: "test", settings: {} }),
    getApprovalRequest: vi.fn(),
    getChannelChatRunner: vi.fn().mockReturnValue(runner),
    getWorkDir: vi.fn().mockReturnValue("/tmp"),
    emit: vi.fn((_e: string, p: { message: string }) => { logs.push(p.message); }),
  } as unknown as Orchestrator;
  const gateway = new ChannelGateway({ orchestrator, peerStore, sessionStore, channelConfig: channel, key: "slack" });
  const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
    if (String(url).startsWith("https://files.slack.com/")) {
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${BOT_TOKEN}`);
      return new Response(Buffer.from("PDFDATA"), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  });
  const clients = vi.fn<SlackClientFactory>().mockImplementation(async () => ({ socket, web }));
  const vault = memoryVault();
  const service = new SlackService({
    channels: () => channels,
    vault: () => vault,
    log: (level, message) => logs.push(`${level} ${message}`),
    clients, fetch: fetchMock as unknown as typeof fetch, retryDelaysMs: [1],
  });
  service.setGateway("slack", gateway);
  if (o.tokens !== false) {
    await service.setSecret("slack", "botToken", BOT_TOKEN);
    await service.setSecret("slack", "appToken", APP_TOKEN);
  }
  return { socket, web, service, gateway, peerStore, sessionStore, runner, logs, clients, fetchMock, channels };
}

const dm = (text: string, extra: Record<string, unknown> = {}) => ({
  event: { type: "message", channel_type: "im", channel: "D0ALICE", user: "UALICE", text, ts: `1712345678.${String(Math.floor(Math.random() * 1e6)).padStart(6, "0")}`, ...extra },
});

let current: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => { await current?.service.dispose(); current = undefined; });

describe("Slack format helpers", () => {
  it("keeps a thread ts exact as a topic id and back", () => {
    const id = encodeThreadTs("1712345678.123456");
    expect(id).toBe(1712345678123456);
    expect(decodeThreadTs(id)).toBe("1712345678.123456");
    expect(encodeThreadTs("not-a-ts")).toBeUndefined();
  });

  it("reads Slack markup and writes mrkdwn", () => {
    expect(slackToPlain("<@UBOT> hi <@UBOB|bob> see <https://x.dev|docs> &amp; <#C1|general>", "UBOT")).toEqual({ text: "hi @bob see docs (https://x.dev) & #general", mentioned: true });
    expect(markdownToMrkdwn("**Bold** and [link](https://a.b) ~~gone~~\n# Title\n- item")).toBe("*Bold* and <https://a.b|link> ~gone~\n*Title*\n• item");
    expect(markdownToMrkdwn("`**code**` stays")).toBe("`**code**` stays");
    expect(splitSlackText("a".repeat(7000)).length).toBe(3);
  });

  it("renders reply buttons as Block Kit actions", () => {
    const blocks = replyBlocks("Pick one", [[{ text: "Backend", data: "agent:backend" }, { text: "Polpo", data: "agent:__polpo__" }]]);
    expect(blocks[0]).toMatchObject({ type: "section", text: { type: "mrkdwn", text: "Pick one" } });
    expect(blocks[1]).toMatchObject({ type: "actions", elements: [{ type: "button", value: "agent:backend" }, { type: "button", value: "agent:__polpo__" }] });
  });
});

describe("Slack Socket Mode bridge", () => {
  it("connects with the vault tokens, acks every envelope and turns a DM into a session answered in its thread", async () => {
    current = await setup();
    const { socket, web, service, sessionStore, runner, clients } = current;
    expect(clients).toHaveBeenCalledWith({ appToken: APP_TOKEN, botToken: BOT_TOKEN }, expect.anything());
    expect((await service.status("slack")).state).toBe("connected");
    expect((await service.status("slack")).botName).toBe("polpo");

    const ack = await socket.deliver("events_api", dm("What's up?", { thread_ts: "1712345600.000001" }));
    expect(ack).toHaveBeenCalledTimes(1);
    expect(runner).toHaveBeenCalledTimes(1);
    expect(sessionStore.create).toHaveBeenCalled();
    const post = web.chat.postMessage.mock.calls.at(-1)![0];
    expect(post).toMatchObject({ channel: "D0ALICE", thread_ts: "1712345600.000001" });
    expect(post.text).toContain("answer to");

    // the same person again: the same session
    await socket.deliver("events_api", dm("And now?"));
    expect(sessionStore.create).toHaveBeenCalledTimes(1);
    expect(web.chat.postMessage.mock.calls.at(-1)![0].thread_ts).toBeUndefined();
  });

  it("ignores its own messages, edits and the duplicate app_mention of a message", async () => {
    current = await setup();
    const { socket, runner } = current;
    await socket.deliver("events_api", { event: { type: "message", channel_type: "im", channel: "D0ALICE", user: "UBOT", text: "me", ts: "1.000001" } });
    await socket.deliver("events_api", { event: { type: "message", subtype: "message_changed", channel_type: "im", channel: "D0ALICE", user: "UALICE", ts: "1.000002" } });
    await socket.deliver("events_api", { event: { type: "message", bot_id: "B1", channel_type: "im", channel: "D0ALICE", text: "bot", ts: "1.000003" } });
    expect(runner).not.toHaveBeenCalled();
    const ev = { channel: "C0GEN", user: "UALICE", text: "<@UBOT> hello", ts: "1712345678.000100" };
    current.peerStore.allow.add("slack:group:C0GEN");
    await socket.deliver("events_api", { event: { type: "message", channel_type: "channel", ...ev } });
    await socket.deliver("events_api", { event: { type: "app_mention", ...ev } });
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it("answers a mention in an enabled channel in a thread, keeps the thread as its own conversation, and reads the rest as context", async () => {
    current = await setup({ gateway: { dmPolicy: "pairing" } });
    const { socket, web, runner, peerStore, sessionStore } = current;
    // not enabled yet: it says how to enable it, in the thread
    await socket.deliver("events_api", { event: { type: "app_mention", channel: "C0GEN", user: "UALICE", text: "<@UBOT> hi", ts: "1712345678.000001" } });
    expect(web.chat.postMessage.mock.calls.at(-1)![0]).toMatchObject({ channel: "C0GEN", thread_ts: "1712345678.000001" });
    expect(web.chat.postMessage.mock.calls.at(-1)![0].text).toContain("/enable");
    expect(runner).not.toHaveBeenCalled();

    peerStore.allow.add("slack:group:C0GEN");
    // a top-level message without a mention: context only, no reply
    const before = web.chat.postMessage.mock.calls.length;
    await socket.deliver("events_api", { event: { type: "message", channel_type: "channel", channel: "C0GEN", user: "UBOB", text: "lunch?", ts: "1712345679.000001" } });
    expect(web.chat.postMessage.mock.calls.length).toBe(before);

    await socket.deliver("events_api", { event: { type: "app_mention", channel: "C0GEN", user: "UALICE", text: "<@UBOT> plan the release", ts: "1712345680.000001" } });
    expect(runner).toHaveBeenCalledTimes(1);
    expect(web.chat.postMessage.mock.calls.at(-1)![0]).toMatchObject({ channel: "C0GEN", thread_ts: "1712345680.000001" });
    const sessionsAfterFirst = sessionStore.create.mock.calls.length;

    // a reply in the bot's thread, no mention: addressed (as a reply to the bot), same topic → same session
    await socket.deliver("events_api", { event: { type: "message", channel_type: "channel", channel: "C0GEN", user: "UBOB", text: "and the date?", ts: "1712345681.000001", thread_ts: "1712345680.000001" } });
    expect(runner).toHaveBeenCalledTimes(2);
    expect(sessionStore.create.mock.calls.length).toBe(sessionsAfterFirst);
    expect(web.chat.postMessage.mock.calls.at(-1)![0].thread_ts).toBe("1712345680.000001");

    // another thread: a conversation of its own
    await socket.deliver("events_api", { event: { type: "app_mention", channel: "C0GEN", user: "UALICE", text: "<@UBOT> something else", ts: "1712345690.000001" } });
    expect(sessionStore.create.mock.calls.length).toBe(sessionsAfterFirst + 1);
  });

  it("with channelMessages all, answers every message of an enabled channel", async () => {
    current = await setup({ slack: { channelMessages: "all" } });
    current.peerStore.allow.add("slack:group:C0GEN");
    await current.socket.deliver("events_api", { event: { type: "message", channel_type: "channel", channel: "C0GEN", user: "UBOB", text: "status please", ts: "1712345700.000001" } });
    expect(current.runner).toHaveBeenCalledTimes(1);
    expect(current.web.chat.postMessage.mock.calls.at(-1)![0].thread_ts).toBe("1712345700.000001");
  });

  it("downloads inbound files with the bot token and uploads reply files in the thread", async () => {
    const runner = vi.fn<ChannelChatRunner>().mockResolvedValue({ text: "Here is the report", files: [{ path: __filename, filename: "report.ts" }] });
    current = await setup({ runner });
    const { socket, web, fetchMock } = current;
    await socket.deliver("events_api", dm("Look at this", {
      subtype: "file_share", thread_ts: "1712345600.000009",
      files: [{ id: "F1", name: "brief.pdf", mimetype: "application/pdf", size: 7, url_private_download: "https://files.slack.com/files-pri/T1-F1/brief.pdf" }],
    }));
    expect(fetchMock).toHaveBeenCalledWith("https://files.slack.com/files-pri/T1-F1/brief.pdf", expect.anything());
    const turn = runner.mock.calls[0]![0].messages.at(-1)!.content;
    expect(JSON.stringify(turn)).toContain("brief.pdf");
    expect(web.filesUploadV2).toHaveBeenCalledWith(expect.objectContaining({ channel_id: "D0ALICE", filename: "report.ts", thread_ts: "1712345600.000009" }));
  });

  it("never sends the bot token to a host that is not Slack's", async () => {
    current = await setup();
    await current.socket.deliver("events_api", dm("see this", {
      subtype: "file_share",
      files: [{ id: "F2", name: "x.pdf", mimetype: "application/pdf", size: 3, url_private_download: "https://evil.example.com/steal" }],
    }));
    expect(current.fetchMock).not.toHaveBeenCalled();
    expect(current.runner).toHaveBeenCalledTimes(1);
  });

  it("sends reply buttons as Block Kit and routes the click back to the gateway", async () => {
    current = await setup({ gateway: { agent: undefined } });
    const { socket, web, runner } = current;
    // /polpo agent → the agent picker (buttons)
    await socket.deliver("slash_commands", { command: "/polpo", text: "agent", user_id: "UALICE", user_name: "alice", channel_id: "D0ALICE" });
    const post = web.chat.postMessage.mock.calls.at(-1)![0];
    const actions = (post.blocks as Array<{ type: string; elements?: Array<{ value: string; action_id: string }> }>).filter((b) => b.type === "actions");
    const backend = actions.flatMap((a) => a.elements ?? []).find((e) => e.value === "agent:backend")!;
    expect(backend.action_id).toMatch(/^polpo_reply:/);

    await socket.deliver("interactive", {
      type: "block_actions", user: { id: "UALICE", name: "alice" }, channel: { id: "D0ALICE" },
      actions: [{ action_id: backend.action_id, value: backend.value }],
    });
    expect(web.chat.postMessage.mock.calls.at(-1)![0].text).toMatch(/backend/i);
    // the next message goes to that agent
    await socket.deliver("events_api", dm("hi backend"));
    expect(runner.mock.calls.at(-1)![0].agent).toBe("backend");
  });

  it("maps /polpo to the gateway's commands (/polpo alone is /help)", async () => {
    current = await setup({ gateway: { agent: undefined } });
    await current.socket.deliver("slash_commands", { command: "/polpo", text: "", user_id: "UALICE", channel_id: "D0ALICE" });
    expect(current.web.chat.postMessage.mock.calls.at(-1)![0].text).toMatch(/\/new/);
    expect(current.runner).not.toHaveBeenCalled();
  });

  it("applies the DM policy: pairing gives a code, allowlist is silent, allowFrom lets people in", async () => {
    current = await setup({ gateway: { dmPolicy: "pairing" } });
    await current.socket.deliver("events_api", dm("hello"));
    expect(current.web.chat.postMessage.mock.calls.at(-1)![0].text).toContain("PAIR42");
    expect(current.runner).not.toHaveBeenCalled();
    await current.service.dispose();

    current = await setup({ gateway: { dmPolicy: "allowlist" } });
    await current.socket.deliver("events_api", dm("hello"));
    expect(current.web.chat.postMessage).not.toHaveBeenCalled();
    await current.service.dispose();

    current = await setup({ gateway: { dmPolicy: "allowlist", allowFrom: ["UALICE"] } });
    await current.socket.deliver("events_api", dm("hello"));
    expect(current.runner).toHaveBeenCalledTimes(1);
  });

  it("routes every message to the dedicated agent", async () => {
    current = await setup({ gateway: { agent: "growth" } });
    await current.socket.deliver("events_api", dm("grow it"));
    expect(current.runner.mock.calls[0]![0].agent).toBe("growth");
  });

  it("retries a failed start, follows the socket's reconnects, and never logs the tokens", async () => {
    current = await setup({ tokens: false });
    const { socket, service, logs } = current;
    // the first start fails (Slack refuses the app-level token), the retry connects
    socket.failStarts = 1;
    await service.setSecret("slack", "botToken", BOT_TOKEN);
    await service.setSecret("slack", "appToken", APP_TOKEN);
    expect((await service.status("slack")).state).toBe("error");
    expect((await service.status("slack")).lastError).not.toContain(APP_TOKEN);
    await new Promise((r) => setTimeout(r, 20));
    await flush();
    expect(socket.started).toBe(2);
    expect((await service.status("slack")).state).toBe("connected");

    socket.emit("disconnected");
    expect((await service.status("slack")).state).toBe("reconnecting");
    socket.emit("connected");
    expect((await service.status("slack")).state).toBe("connected");

    const all = logs.join("\n");
    expect(all).not.toContain(APP_TOKEN);
    expect(all).not.toContain(BOT_TOKEN);
    expect(all).toContain("invalid_auth");
  });

  it("keeps the socket across a reload with the same tokens and reconnects when one changes", async () => {
    current = await setup();
    const { service, clients, socket } = current;
    await service.sync();
    expect(clients).toHaveBeenCalledTimes(1);
    await service.setSecret("slack", "botToken", "xoxb-1111-2222-anothervalue");
    expect(socket.disconnected).toBe(1);
    expect(clients).toHaveBeenCalledTimes(2);
  });

  it("refuses values that are not Slack tokens and reports which are set, never their values", async () => {
    current = await setup({ tokens: false });
    await expect(current.service.setSecret("slack", "botToken", APP_TOKEN)).rejects.toThrow(/xoxb/);
    await expect(current.service.setSecret("slack", "appToken", "nope")).rejects.toThrow(/xapp/);
    await current.service.setSecret("slack", "botToken", BOT_TOKEN);
    const status = await current.service.status("slack");
    expect(status.secrets).toEqual({ botToken: true, appToken: false });
    expect(status.state).toBe("not-configured");
    expect(JSON.stringify(status)).not.toContain(BOT_TOKEN);
  });

  it("posts notifications and conversation replies with the bot token to a channel and thread", async () => {
    current = await setup({ gateway: { enableInbound: false } });
    const { service, web } = current;
    const poster = {
      hasBotToken: async () => !!(await service.botToken("slack")),
      post: (chatId: string, text: string, opts: { threadTs?: string }) => service.post("slack", chatId, text, opts),
      test: () => service.test("slack"),
    };
    const ch = new SlackChannel({ type: "slack", chatId: "C0OPS" }, () => poster);
    await ch.send({ id: "n1", channel: "slack", title: "Deploy done", body: "All **green**", severity: "info", sourceEvent: "direct:send", sourceData: {}, ruleId: "direct", timestamp: new Date().toISOString() });
    expect(web.chat.postMessage.mock.calls.at(-1)![0]).toMatchObject({ channel: "C0OPS", text: "*Deploy done*\nAll *green*" });
    await ch.send({ id: "n2", channel: "slack", title: "x", body: "in thread", severity: "info", sourceEvent: "direct:send", sourceData: { chatId: "C0DEV", threadTs: "1712345678.000001" }, ruleId: "direct", timestamp: new Date().toISOString() });
    expect(web.chat.postMessage.mock.calls.at(-1)![0]).toMatchObject({ channel: "C0DEV", thread_ts: "1712345678.000001" });
    expect(await ch.test()).toBe(true);
  });
});
