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
