import { describe, it, expect, vi } from "vitest";
import { ChannelGateway, type ChannelChatRunner } from "../notifications/channel-gateway.js";
import type { PeerStore } from "../core/peer-store.js";
import type { SessionStore, Session } from "../core/session-store.js";
import type { Orchestrator } from "../core/orchestrator.js";
import type { ChannelGatewayConfig, ChannelType } from "../core/types.js";

// ── Stateful fakes ──────────────────────────────────────

function createPeerStore(overrides: Partial<PeerStore> = {}): PeerStore & { sessions: Map<string, string> } {
  const sessions = new Map<string, string>();
  const allowlist = new Set<string>();
  const store = {
    sessions,
    getPeer: vi.fn().mockResolvedValue(undefined),
    upsertPeer: vi.fn().mockImplementation(async (input) => ({
      id: `${input.channel}:${input.externalId}`,
      channel: input.channel,
      externalId: input.externalId,
      firstSeenAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
    })),
    listPeers: vi.fn().mockResolvedValue([]),
    isAllowed: vi.fn().mockImplementation(async (peerId: string) => allowlist.has(peerId)),
    addToAllowlist: vi.fn().mockImplementation(async (peerId: string) => { allowlist.add(peerId); }),
    removeFromAllowlist: vi.fn(),
    getAllowlist: vi.fn().mockImplementation(async () => [...allowlist]),
    createPairingRequest: vi.fn().mockResolvedValue({
      id: "pair-1", peerId: "telegram:7", channel: "telegram" as ChannelType, externalId: "7",
      code: "ABC123", createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600000).toISOString(), resolved: false,
    }),
    resolvePairing: vi.fn().mockResolvedValue(undefined),
    getPendingPairing: vi.fn().mockResolvedValue(undefined),
    listPendingPairings: vi.fn().mockResolvedValue([]),
    rejectPairing: vi.fn().mockResolvedValue(false),
    cleanExpiredPairings: vi.fn().mockResolvedValue(0),
    getSessionId: vi.fn().mockImplementation(async (key: string) => sessions.get(key)),
    setSessionId: vi.fn().mockImplementation(async (key: string, id: string) => { sessions.set(key, id); }),
    clearSession: vi.fn().mockImplementation(async (key: string) => { sessions.delete(key); }),
    linkPeers: vi.fn(),
    resolveCanonicalId: vi.fn().mockImplementation(async (id: string) => id),
    updatePresence: vi.fn(),
    getPresence: vi.fn().mockResolvedValue([]),
    prunePresence: vi.fn().mockResolvedValue(0),
    ...overrides,
  };
  return store as PeerStore & { sessions: Map<string, string> };
}

function createSessionStore() {
  const sessions = new Map<string, Session & { agent?: string }>();
  let seq = 0;
  const store = {
    sessions,
    create: vi.fn().mockImplementation(async (title?: string, agent?: string) => {
      const id = `s${++seq}`;
      const now = new Date().toISOString();
      sessions.set(id, { id, title, agent, createdAt: now, updatedAt: now, messageCount: 0 } as any);
      return id;
    }),
    addMessage: vi.fn(),
    getMessages: vi.fn().mockResolvedValue([]),
    getRecentMessages: vi.fn().mockResolvedValue([
      { id: "m1", role: "user", content: "earlier question", ts: new Date().toISOString() },
      { id: "m2", role: "assistant", content: "earlier answer", ts: new Date().toISOString() },
      { id: "m3", role: "assistant", content: "", ts: new Date().toISOString() },
    ]),
    listSessions: vi.fn().mockResolvedValue([]),
    getSession: vi.fn().mockImplementation(async (id: string) => sessions.get(id)),
    getLatestSession: vi.fn().mockImplementation(async (agent?: string | null) => {
      const matching = [...sessions.values()].filter(s => (s.agent ?? null) === (agent ?? null));
      return matching.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    }),
    deleteSession: vi.fn().mockResolvedValue(false),
    prune: vi.fn().mockResolvedValue(0),
    close: vi.fn(),
  };
  return store as unknown as SessionStore & { sessions: typeof sessions; create: ReturnType<typeof vi.fn> };
}

const AGENTS = [
  { name: "backend", role: "Backend engineer" },
  { name: "growth", role: "Growth" },
];

function setup(opts: { gatewayConfig?: ChannelGatewayConfig; runner?: ChannelChatRunner | null; allowed?: boolean } = {}) {
  const peerStore = createPeerStore();
  const sessionStore = createSessionStore();
  const runner = opts.runner === null
    ? undefined
    : (opts.runner ?? vi.fn<ChannelChatRunner>().mockResolvedValue({ text: "agent reply" }));
  const orchestrator = {
    getStore: vi.fn().mockReturnValue({ getAllTasks: vi.fn().mockResolvedValue([]), getState: vi.fn().mockResolvedValue({ processes: [] }) }),
    getAgents: vi.fn().mockResolvedValue(AGENTS),
    getAllMissions: vi.fn().mockResolvedValue([]),
    getConfig: vi.fn().mockReturnValue({ project: "test", settings: {} }),
    getApprovalRequest: vi.fn(),
    getChannelChatRunner: vi.fn().mockReturnValue(runner),
  } as unknown as Orchestrator;

  const gateway = new ChannelGateway({
    orchestrator,
    peerStore,
    sessionStore,
    channelConfig: {
      type: "telegram",
      botToken: "fake",
      chatId: "",
      gateway: opts.gatewayConfig ?? { enableInbound: true, dmPolicy: "pairing" },
    },
  });
  if (opts.allowed !== false) void peerStore.addToAllowlist("telegram:7");

  const send = (text: string) => gateway.handleMessage({
    channel: "telegram", externalId: "7", chatId: "chat-7", displayName: "Alessio", text,
  });
  return { gateway, peerStore, sessionStore, runner: runner as ReturnType<typeof vi.fn> | undefined, send };
}

// ── Invite links ────────────────────────────────────────

describe("ChannelGateway — invite links", () => {
  it("/start TOKEN pairs an unknown peer and records the chat id", async () => {
    const { gateway, peerStore, send } = setup({ allowed: false });
    const invite = gateway.createInvite();

    const reply = await send(`/start ${invite.token}`);

    expect(reply).toContain("Connected, Alessio");
    expect(peerStore.addToAllowlist).toHaveBeenCalledWith("telegram:7");
    expect(gateway.getInvite(invite.token)).toMatchObject({
      status: "paired", peerId: "telegram:7", externalId: "7", chatId: "chat-7", displayName: "Alessio",
    });
    expect(peerStore.createPairingRequest).not.toHaveBeenCalled();
  });

  it("resolves a pending pairing code of the same peer", async () => {
    const { gateway, peerStore, send } = setup({ allowed: false });
    (peerStore.getPendingPairing as any).mockResolvedValue({ code: "OLD111" });
    await send(`/start ${gateway.createInvite().token}`);
    expect(peerStore.resolvePairing).toHaveBeenCalledWith("OLD111");
  });

  it("is single-use: a second /start with the same token falls back to pairing", async () => {
    const { gateway, send } = setup({ allowed: false });
    const invite = gateway.createInvite();
    await send(`/start ${invite.token}`);

    const other = gateway.handleMessage({ channel: "telegram", externalId: "8", chatId: "chat-8", text: `/start ${invite.token}` });
    expect(await other).toContain("pairing code");
  });

  it("expired invites are not redeemed", async () => {
    const { gateway, peerStore, send } = setup({ allowed: false });
    const invite = gateway.createInvite(-1);

    const reply = await send(`/start ${invite.token}`);

    expect(reply).toContain("pairing code");
    expect(peerStore.addToAllowlist).not.toHaveBeenCalledWith("telegram:7");
    expect(gateway.getInvite(invite.token)?.status).toBe("expired");
  });

  it("ignores invites when the DM policy is disabled", async () => {
    const { gateway, peerStore, send } = setup({ allowed: false, gatewayConfig: { enableInbound: true, dmPolicy: "disabled" } });
    expect(await send(`/start ${gateway.createInvite().token}`)).toBeUndefined();
    expect(peerStore.addToAllowlist).not.toHaveBeenCalledWith("telegram:7");
  });
});

// ── /agent and /polpo ───────────────────────────────────

describe("ChannelGateway — direct agent chat", () => {
  it("/agent without args shows the current interlocutor and the agents", async () => {
    const { send } = setup();
    const reply = await send("/agent");
    expect(reply).toContain("Polpo (orchestrator)");
    expect(reply).toContain("backend, growth");
  });

  it("/agent NAME switches the conversation to that agent (case-insensitive)", async () => {
    const { send, runner, sessionStore } = setup();
    expect(await send("/agent Backend")).toContain("now talking to backend");

    const reply = await send("deploy the API");

    expect(reply).toBe("agent reply");
    expect(sessionStore.create).toHaveBeenCalledWith("deploy the API", "backend");
    const request = runner!.mock.calls[0][0];
    expect(request.agent).toBe("backend");
    expect(request.messages).toEqual([
      { role: "user", content: "earlier question" },
      { role: "assistant", content: "earlier answer" },
      { role: "user", content: "deploy the API" },
    ]);
    // The host pipeline persists messages; the gateway must not duplicate them.
    expect(sessionStore.addMessage).not.toHaveBeenCalled();
  });

  it("rejects unknown agents", async () => {
    const { send, runner } = setup();
    expect(await send("/agent ghost")).toContain('Agent "ghost" not found');
    expect(runner).not.toHaveBeenCalled();
  });

  it("refuses /agent when the host provides no chat runner", async () => {
    const { send } = setup({ runner: null });
    expect(await send("/agent backend")).toContain("not available");
  });

  it("/polpo returns to the orchestrator", async () => {
    const { send, peerStore } = setup();
    await send("/agent backend");
    expect(await send("/polpo")).toContain("Polpo (orchestrator)");
    expect(peerStore.sessions.has("telegram:7#active-agent")).toBe(false);
  });

  it("falls back to the orchestrator when the selected agent no longer exists", async () => {
    const { send, peerStore } = setup();
    peerStore.sessions.set("telegram:7#active-agent", "removed-agent");
    expect(await send("/agent")).toContain("Polpo (orchestrator)");
  });

  it("truncates replies over the Telegram limit and reports runner errors", async () => {
    const runner = vi.fn<ChannelChatRunner>()
      .mockResolvedValueOnce({ text: "x".repeat(5000) })
      .mockRejectedValueOnce(new Error("model down"));
    const { send } = setup({ runner });
    await send("/agent backend");

    expect(await send("long")).toMatch(/\(truncated\)$/);
    expect(await send("again")).toContain("model down");
  });
});

// ── Session modes ───────────────────────────────────────

describe("ChannelGateway — session modes", () => {
  it("per-peer (default) reuses the channel session and keeps agents separate", async () => {
    const { send, sessionStore, runner } = setup();
    await send("/agent backend");
    await send("one");
    await send("two");
    await send("/agent growth");
    await send("three");

    const ids = runner!.mock.calls.map(c => c[0].sessionId);
    expect(ids[0]).toBe(ids[1]);
    expect(ids[2]).not.toBe(ids[0]);
    expect(sessionStore.create).toHaveBeenCalledTimes(2);
  });

  it("per-peer ignores the web UI's latest session", async () => {
    const { send, sessionStore, runner } = setup();
    const webSession = await sessionStore.create("from web", "backend");
    await send("/agent backend");
    await send("hello");
    expect(runner!.mock.calls[0][0].sessionId).not.toBe(webSession);
  });

  it("shared continues the interlocutor's latest session (the one the web UI uses)", async () => {
    const { send, sessionStore, runner, peerStore } = setup({ gatewayConfig: { enableInbound: true, dmPolicy: "pairing", sessionMode: "shared" } });
    const webSession = await sessionStore.create("from web", "backend");
    await sessionStore.create("orchestrator chat");
    await send("/agent backend");
    await send("hello");

    expect(runner!.mock.calls[0][0].sessionId).toBe(webSession);
    expect(peerStore.sessions.get("telegram:7#agent:backend")).toBe(webSession);
  });

  it("starts a new session after sessionIdleMinutes in both modes", async () => {
    for (const sessionMode of ["per-peer", "shared"] as const) {
      const { send, sessionStore, runner } = setup({ gatewayConfig: { enableInbound: true, dmPolicy: "pairing", sessionMode, sessionIdleMinutes: 5 } });
      await send("/agent backend");
      await send("first");
      const first = runner!.mock.calls[0][0].sessionId;
      sessionStore.sessions.get(first)!.updatedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();

      await send("second");
      expect(runner!.mock.calls[1][0].sessionId).not.toBe(first);
    }
  });

  it("/new starts a fresh session even in shared mode", async () => {
    const { send, runner } = setup({ gatewayConfig: { enableInbound: true, dmPolicy: "pairing", sessionMode: "shared" } });
    await send("/agent backend");
    await send("first");
    expect(await send("/new")).toContain("new conversation with backend");
    await send("second");

    const [first, second] = runner!.mock.calls.map(c => c[0].sessionId);
    expect(second).not.toBe(first);
  });
});

// ── Per-agent session settings ──────────────────────────

describe("ChannelGateway — per-agent session settings", () => {
  const HOURS_AGO = (h: number) => new Date(Date.now() - h * 3600 * 1000).toISOString();

  it("an agent override applies only to that agent", async () => {
    const { send, sessionStore, runner } = setup({
      gatewayConfig: { enableInbound: true, dmPolicy: "pairing", agentSessions: { backend: { sessionMode: "shared" } } },
    });
    const webBackend = await sessionStore.create("web backend", "backend");
    const webGrowth = await sessionStore.create("web growth", "growth");

    await send("/agent backend");
    await send("hi backend");
    await send("/agent growth");
    await send("hi growth");

    const [backendTurn, growthTurn] = runner!.mock.calls.map(c => c[0]);
    expect(backendTurn.sessionId).toBe(webBackend);     // shared via override
    expect(growthTurn.sessionId).not.toBe(webGrowth);   // channel default: per-peer
  });

  it("sessionIdleMinutes 0 never expires, in shared and per-peer mode", async () => {
    for (const sessionMode of ["shared", "per-peer"] as const) {
      const { send, sessionStore, runner } = setup({
        gatewayConfig: { enableInbound: true, dmPolicy: "pairing", agentSessions: { backend: { sessionMode, sessionIdleMinutes: 0 } } },
      });
      await send("/agent backend");
      await send("first");
      const first = runner!.mock.calls[0][0].sessionId;
      sessionStore.sessions.get(first)!.updatedAt = HOURS_AGO(24 * 90);

      await send("three months later");
      expect(runner!.mock.calls[1][0].sessionId).toBe(first);
    }
  });

  it("shared + never-expire resumes a months-old web session", async () => {
    const { send, sessionStore, runner } = setup({
      gatewayConfig: { enableInbound: true, dmPolicy: "pairing", agentSessions: { backend: { sessionMode: "shared", sessionIdleMinutes: 0 } } },
    });
    const old = await sessionStore.create("old web chat", "backend");
    sessionStore.sessions.get(old)!.updatedAt = HOURS_AGO(24 * 120);

    await send("/agent backend");
    await send("still there?");
    expect(runner!.mock.calls[0][0].sessionId).toBe(old);
  });

  it("an override may change only the idle timeout and inherit the mode", async () => {
    const { send, sessionStore, runner } = setup({
      gatewayConfig: { enableInbound: true, dmPolicy: "pairing", sessionMode: "shared", sessionIdleMinutes: 5, agentSessions: { backend: { sessionIdleMinutes: 0 } } },
    });
    const web = await sessionStore.create("web", "backend");
    sessionStore.sessions.get(web)!.updatedAt = HOURS_AGO(48);

    await send("/agent backend");
    await send("hello");
    expect(runner!.mock.calls[0][0].sessionId).toBe(web);
  });

  it("/new still starts a fresh session when the session never expires", async () => {
    const { send, runner } = setup({
      gatewayConfig: { enableInbound: true, dmPolicy: "pairing", agentSessions: { backend: { sessionMode: "shared", sessionIdleMinutes: 0 } } },
    });
    await send("/agent backend");
    await send("first");
    await send("/new");
    await send("second");
    const [a, b] = runner!.mock.calls.map(c => c[0].sessionId);
    expect(b).not.toBe(a);
  });
});

// ── Dedicated-agent bots ────────────────────────────────

describe("ChannelGateway — dedicated agent channel", () => {
  const dedicated = { enableInbound: true, dmPolicy: "pairing" as const, agent: "backend" };

  it("routes every message to the dedicated agent without /agent", async () => {
    const { send, runner } = setup({ gatewayConfig: dedicated });
    expect(await send("hello coach")).toBe("agent reply");
    expect(runner!.mock.calls[0][0].agent).toBe("backend");
  });

  it("disables /agent and /polpo", async () => {
    const { send, runner } = setup({ gatewayConfig: dedicated });
    expect(await send("/agent growth")).toContain("dedicated to backend");
    expect(await send("/polpo")).toContain("dedicated to backend");
    await send("still backend?");
    expect(runner!.mock.calls[0][0].agent).toBe("backend");
  });

  it("uses the same agent session key as the main bot, so conversations are shared", async () => {
    const { send, peerStore } = setup({ gatewayConfig: dedicated });
    await send("hello");
    expect(peerStore.sessions.has("telegram:7#agent:backend")).toBe(true);
    expect(peerStore.sessions.has("telegram:7#active-agent")).toBe(false);
  });

  it("applies the agent's session override", async () => {
    const { send, sessionStore, runner } = setup({
      gatewayConfig: { ...dedicated, agentSessions: { backend: { sessionMode: "shared", sessionIdleMinutes: 0 } } },
    });
    const web = await sessionStore.create("web", "backend");
    sessionStore.sessions.get(web)!.updatedAt = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
    await send("hi");
    expect(runner!.mock.calls[0][0].sessionId).toBe(web);
  });

  it("welcomes invite redeemers with the agent name", async () => {
    const { gateway, send } = setup({ allowed: false, gatewayConfig: dedicated });
    expect(await send(`/start ${gateway.createInvite().token}`)).toContain("talk to backend here");
  });
});

// ── Inbound attachments ─────────────────────────────────

import { attachmentContent } from "../notifications/channel-gateway.js";
import { inboundMediaOf } from "../notifications/channels/telegram.js";
import type { InboundAttachment } from "../notifications/channels/telegram.js";

const photo = (): InboundAttachment => ({ kind: "photo", filename: "photo.jpg", mimeType: "image/jpeg", data: Buffer.from("jpeg-bytes") });
const pdf = (): InboundAttachment => ({ kind: "document", filename: "referto.pdf", mimeType: "application/pdf", data: Buffer.from("%PDF") });
const voice = (): InboundAttachment => ({ kind: "voice", filename: "voice.ogg", mimeType: "audio/ogg", data: Buffer.from("ogg") });

describe("attachmentContent", () => {
  it("sends images as vision input and other files as file parts", () => {
    const parts = attachmentContent("guarda", [photo(), pdf()]);
    expect(parts[0]).toEqual({ type: "text", text: "guarda" });
    expect(parts[1]).toEqual({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${Buffer.from("jpeg-bytes").toString("base64")}` } });
    expect(parts[2]).toMatchObject({ type: "file", file: { filename: "referto.pdf" } });
    expect((parts[2] as any).file.file_data).toMatch(/^data:application\/pdf;base64,/);
  });

  it("describes caption-less media and asks to transcribe audio", () => {
    const [text] = attachmentContent("", [voice()]);
    expect((text as any).text).toContain("a voice message (voice.ogg)");
    expect((text as any).text).toContain("transcribe it");
  });

  it("keeps the caption and adds the audio hint separately", () => {
    const parts = attachmentContent("ascolta", [voice()]);
    expect(parts[0]).toEqual({ type: "text", text: "ascolta" });
    expect((parts[1] as any).text).toContain("transcribe");
  });
});

describe("ChannelGateway — inbound attachments", () => {
  it("routes an orchestrator turn with media through the host pipeline", async () => {
    const { gateway, runner } = setup();
    const reply = await gateway.handleMessage({ channel: "telegram", externalId: "7", chatId: "chat-7", text: "", attachments: [photo()] });

    expect(reply).toBe("agent reply");
    const request = runner!.mock.calls[0][0];
    expect(request.agent).toBeUndefined();
    const last = request.messages[request.messages.length - 1];
    expect(Array.isArray(last.content)).toBe(true);
    expect((last.content as any[]).some(p => p.type === "image_url")).toBe(true);
  });

  it("sends media to the selected agent in its session", async () => {
    const { gateway, send, runner, sessionStore } = setup();
    await send("/agent backend");
    await gateway.handleMessage({ channel: "telegram", externalId: "7", chatId: "chat-7", text: "il referto", attachments: [pdf()] });

    const request = runner!.mock.calls[0][0];
    expect(request.agent).toBe("backend");
    expect(sessionStore.create).toHaveBeenCalledWith("il referto", "backend");
  });

  it("names a caption-less session after the file", async () => {
    const { gateway, sessionStore } = setup();
    await gateway.handleMessage({ channel: "telegram", externalId: "7", chatId: "chat-7", text: "", attachments: [pdf()] });
    expect(sessionStore.create).toHaveBeenCalledWith("referto.pdf", undefined);
  });

  it("rejects files over 15 MB before calling the model", async () => {
    const { gateway, runner } = setup();
    const big = { ...pdf(), data: Buffer.alloc(16 * 1024 * 1024) };
    const reply = await gateway.handleMessage({ channel: "telegram", externalId: "7", chatId: "chat-7", text: "", attachments: [big] });
    expect(reply).toContain("too large");
    expect(runner).not.toHaveBeenCalled();
  });

  it("explains when the host has no pipeline for media", async () => {
    const { gateway } = setup({ runner: null });
    const reply = await gateway.handleMessage({ channel: "telegram", externalId: "7", chatId: "chat-7", text: "", attachments: [photo()] });
    expect(reply).toContain("not supported");
  });

  it("still requires authorization for media from unknown peers", async () => {
    const { gateway, runner } = setup({ allowed: false });
    const reply = await gateway.handleMessage({ channel: "telegram", externalId: "7", chatId: "chat-7", text: "", attachments: [photo()] });
    expect(reply).toContain("pairing code");
    expect(runner).not.toHaveBeenCalled();
  });
});

describe("inboundMediaOf (Telegram)", () => {
  const base = { message_id: 1, chat: { id: 1 } };
  it("takes the largest photo size and maps voice, audio, video and documents", () => {
    const refs = inboundMediaOf({
      ...base,
      photo: [{ file_id: "small", file_unique_id: "s", file_size: 10 }, { file_id: "big", file_unique_id: "b", file_size: 900 }],
      voice: { file_id: "v", file_unique_id: "v", mime_type: "audio/ogg" },
      audio: { file_id: "a", file_unique_id: "a", file_name: "song.mp3", mime_type: "audio/mpeg" },
      video_note: { file_id: "vn", file_unique_id: "vn" },
      document: { file_id: "d", file_unique_id: "d", file_name: "dieta.xlsx" },
    });
    expect(refs.map(r => [r.kind, r.fileId, r.filename, r.mimeType])).toEqual([
      ["photo", "big", "photo.jpg", "image/jpeg"],
      ["document", "d", "dieta.xlsx", "application/octet-stream"],
      ["voice", "v", "voice.ogg", "audio/ogg"],
      ["audio", "a", "song.mp3", "audio/mpeg"],
      ["video", "vn", "video.mp4", "video/mp4"],
    ]);
  });

  it("returns nothing for text-only messages", () => {
    expect(inboundMediaOf({ ...base, text: "ciao" })).toEqual([]);
  });
});

// ── Command menu and agent picker ───────────────────────

import { TelegramGatewayAdapter } from "../notifications/telegram-gateway-adapter.js";

describe("ChannelGateway — command menu and agent picker", () => {
  it("/agent without a name replies with one button per agent plus Polpo, two per row", async () => {
    const { gateway } = setup();
    const reply = await gateway.handleMessageReply({ channel: "telegram", externalId: "7", chatId: "chat-7", text: "/agent" });

    expect(reply?.buttons).toEqual([
      [{ text: "🐙 Polpo ✓", data: "agent:__polpo__" }, { text: "backend", data: "agent:backend" }],
      [{ text: "growth", data: "agent:growth" }],
    ]);
  });

  it("marks the current agent in the picker", async () => {
    const { gateway, send } = setup();
    await send("/agent backend");
    const reply = await gateway.handleMessageReply({ channel: "telegram", externalId: "7", chatId: "chat-7", text: "/agent" });
    expect(reply?.buttons?.flat().map(b => b.text)).toEqual(["🐙 Polpo", "backend ✓", "growth"]);
  });

  it("a picker button switches agent, and the Polpo button goes back", async () => {
    const { gateway, send, runner } = setup();
    const msg = { channel: "telegram" as const, externalId: "7", chatId: "chat-7" };

    expect(await gateway.handleMenuCallback("agent", "growth", msg)).toContain("now talking to growth");
    await send("hello");
    expect(runner!.mock.calls[0][0].agent).toBe("growth");

    expect(await gateway.handleMenuCallback("agent", "__polpo__", msg)).toContain("Polpo (orchestrator)");
  });

  it("ignores picker buttons from unauthorized peers", async () => {
    const { gateway } = setup({ allowed: false });
    expect(await gateway.handleMenuCallback("agent", "backend", { channel: "telegram", externalId: "7", chatId: "chat-7" })).toBeUndefined();
  });

  it("exposes the full menu on the main bot and a short one on dedicated bots", () => {
    const main = setup().gateway.menuCommands().map(c => c.command);
    expect(main).toEqual(["agent", "polpo", "new", "status", "tasks", "missions", "agents", "approve", "help"]);
    expect(setup({ gatewayConfig: { enableInbound: true, dmPolicy: "pairing", agent: "backend" } }).gateway.menuCommands().map(c => c.command)).toEqual(["new", "help"]);
    for (const c of setup().gateway.menuCommands()) expect(c.description.length).toBeGreaterThan(0);
  });

  it("the Telegram adapter forwards replies with buttons and picker callbacks", async () => {
    const { gateway } = setup();
    const adapter = new TelegramGatewayAdapter(gateway);
    expect((await adapter.handleInboundMessage("7", "chat-7", "/agent"))?.buttons?.length).toBeGreaterThan(0);
    expect(await adapter.handleMenuCallback("agent", "backend", "chat-7", "7")).toContain("now talking to backend");
  });
});
