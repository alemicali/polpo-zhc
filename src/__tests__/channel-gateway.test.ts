import { describe, it, expect, vi, beforeEach } from "vitest";
import { ChannelGateway } from "../notifications/channel-gateway.js";
import { TelegramGatewayAdapter } from "../notifications/telegram-gateway-adapter.js";
import type { PeerStore } from "../core/peer-store.js";
import type { SessionStore, Session, Message } from "../core/session-store.js";
import type { Orchestrator } from "../core/orchestrator.js";
import type { ApprovalCallbackResolver } from "../notifications/channels/telegram.js";
import type { NotificationChannelConfig, ChannelGatewayConfig, PeerIdentity, PairingRequest, PresenceEntry, ChannelType } from "../core/types.js";

// ── Mock PeerStore ──────────────────────────────────────

function createMockPeerStore(overrides: Partial<PeerStore> = {}): PeerStore {
  return {
    getPeer: vi.fn().mockReturnValue(undefined),
    upsertPeer: vi.fn().mockImplementation((input) => ({
      id: input.id ?? `${input.channel}:${input.externalId}`,
      channel: input.channel,
      externalId: input.externalId,
      displayName: input.displayName,
      firstSeenAt: new Date().toISOString(),
      lastSeenAt: input.lastSeenAt ?? new Date().toISOString(),
    })),
    listPeers: vi.fn().mockReturnValue([]),
    isAllowed: vi.fn().mockReturnValue(true),
    addToAllowlist: vi.fn(),
    removeFromAllowlist: vi.fn(),
    getAllowlist: vi.fn().mockReturnValue([]),
    createPairingRequest: vi.fn().mockReturnValue({
      id: "pair-1",
      peerId: "telegram:123",
      channel: "telegram" as ChannelType,
      externalId: "123",
      code: "ABC123",
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      resolved: false,
    }),
    resolvePairing: vi.fn().mockReturnValue(undefined),
    getPendingPairing: vi.fn().mockReturnValue(undefined),
    cleanExpiredPairings: vi.fn().mockReturnValue(0),
    getSessionId: vi.fn().mockReturnValue(undefined),
    setSessionId: vi.fn(),
    clearSession: vi.fn(),
    linkPeers: vi.fn(),
    resolveCanonicalId: vi.fn().mockImplementation((id: string) => id),
    updatePresence: vi.fn(),
    getPresence: vi.fn().mockReturnValue([]),
    prunePresence: vi.fn().mockReturnValue(0),
    ...overrides,
  };
}

// ── Mock SessionStore ───────────────────────────────────

function createMockSessionStore(): SessionStore {
  const messages: Message[] = [];
  return {
    create: vi.fn().mockReturnValue("session-1"),
    addMessage: vi.fn().mockImplementation((_sid, role, content) => {
      const msg = { id: "m1", role, content, ts: new Date().toISOString() };
      messages.push(msg);
      return msg;
    }),
    getMessages: vi.fn().mockReturnValue([]),
    getRecentMessages: vi.fn().mockReturnValue([]),
    listSessions: vi.fn().mockReturnValue([]),
    getSession: vi.fn().mockReturnValue({ id: "session-1", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), messageCount: 0 }),
    getLatestSession: vi.fn().mockReturnValue(undefined),
    deleteSession: vi.fn().mockReturnValue(false),
    prune: vi.fn().mockReturnValue(0),
    close: vi.fn(),
  };
}

// ── Mock Orchestrator ───────────────────────────────────

function createMockOrchestrator(): Orchestrator {
  return {
    getStore: vi.fn().mockReturnValue({
      getAllTasks: vi.fn().mockReturnValue([]),
      getState: vi.fn().mockReturnValue({ processes: [] }),
    }),
    getAgents: vi.fn().mockReturnValue([]),
    getAllPlans: vi.fn().mockReturnValue([]),
    getConfig: vi.fn().mockReturnValue({ project: "test-project", settings: {} }),
    getApprovalRequest: vi.fn().mockReturnValue(undefined),
  } as unknown as Orchestrator;
}

// ── Mock ApprovalResolver ───────────────────────────────

function createMockApprovalResolver(): ApprovalCallbackResolver {
  return {
    approve: vi.fn().mockResolvedValue({ ok: true }),
    reject: vi.fn().mockResolvedValue({ ok: true }),
  };
}

// ── Factory ─────────────────────────────────────────────

function createGateway(opts: {
  gatewayConfig?: ChannelGatewayConfig;
  peerStore?: PeerStore;
  sessionStore?: SessionStore;
  orchestrator?: Orchestrator;
  approvalResolver?: ApprovalCallbackResolver;
} = {}) {
  const peerStore = opts.peerStore ?? createMockPeerStore();
  const sessionStore = opts.sessionStore ?? createMockSessionStore();
  const orchestrator = opts.orchestrator ?? createMockOrchestrator();
  const channelConfig: NotificationChannelConfig = {
    type: "telegram",
    botToken: "fake-token",
    chatId: "123",
    gateway: opts.gatewayConfig ?? { enableInbound: true, dmPolicy: "open" },
  };

  const gateway = new ChannelGateway({
    orchestrator,
    peerStore,
    sessionStore,
    channelConfig,
    approvalResolver: opts.approvalResolver,
  });

  return { gateway, peerStore, sessionStore, orchestrator };
}

// ── Tests ───────────────────────────────────────────────

describe("ChannelGateway — message routing", () => {
  it("returns undefined when enableInbound is false", async () => {
    const { gateway } = createGateway({ gatewayConfig: { enableInbound: false } });
    const result = await gateway.handleMessage({
      channel: "telegram",
      externalId: "123",
      chatId: "chat-1",
      text: "hello",
    });
    expect(result).toBeUndefined();
  });

  it("upserts peer identity on every message", async () => {
    const peerStore = createMockPeerStore();
    const { gateway } = createGateway({ peerStore });

    await gateway.handleMessage({
      channel: "telegram",
      externalId: "42",
      chatId: "chat-1",
      displayName: "Alice",
      text: "/help",
    });

    expect(peerStore.upsertPeer).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "telegram",
        externalId: "42",
        displayName: "Alice",
      }),
    );
  });

  it("updates presence on every message", async () => {
    const peerStore = createMockPeerStore();
    const { gateway } = createGateway({ peerStore });

    await gateway.handleMessage({
      channel: "telegram",
      externalId: "42",
      chatId: "chat-1",
      text: "/help",
    });

    expect(peerStore.updatePresence).toHaveBeenCalledWith("telegram:42", "chatting");
  });
});

// ── DM Policy enforcement ────────────────────────────────

describe("ChannelGateway — DM Policy", () => {
  it("blocks unauthorized peers with pairing policy", async () => {
    const peerStore = createMockPeerStore({
      isAllowed: vi.fn().mockReturnValue(false),
    });
    const { gateway } = createGateway({
      peerStore,
      gatewayConfig: { enableInbound: true, dmPolicy: "pairing" },
    });

    const result = await gateway.handleMessage({
      channel: "telegram",
      externalId: "123",
      chatId: "chat-1",
      displayName: "Unknown",
      text: "hello",
    });

    expect(result).toContain("pairing code");
    expect(peerStore.createPairingRequest).toHaveBeenCalled();
  });

  it("returns existing pairing code if already pending", async () => {
    const peerStore = createMockPeerStore({
      isAllowed: vi.fn().mockReturnValue(false),
      getPendingPairing: vi.fn().mockReturnValue({
        id: "pair-1",
        peerId: "telegram:123",
        code: "XYZ789",
        resolved: false,
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      }),
    });
    const { gateway } = createGateway({
      peerStore,
      gatewayConfig: { enableInbound: true, dmPolicy: "pairing" },
    });

    const result = await gateway.handleMessage({
      channel: "telegram",
      externalId: "123",
      chatId: "chat-1",
      text: "hello",
    });

    expect(result).toContain("XYZ789");
    expect(peerStore.createPairingRequest).not.toHaveBeenCalled();
  });

  it("silent block for allowlist policy when not authorized", async () => {
    const peerStore = createMockPeerStore({
      isAllowed: vi.fn().mockReturnValue(false),
    });
    const { gateway } = createGateway({
      peerStore,
      gatewayConfig: { enableInbound: true, dmPolicy: "allowlist" },
    });

    const result = await gateway.handleMessage({
      channel: "telegram",
      externalId: "123",
      chatId: "chat-1",
      text: "hello",
    });

    expect(result).toBeUndefined();
  });

  it("silent block for disabled policy", async () => {
    const peerStore = createMockPeerStore({
      isAllowed: vi.fn().mockReturnValue(false),
    });
    const { gateway } = createGateway({
      peerStore,
      gatewayConfig: { enableInbound: true, dmPolicy: "disabled" },
    });

    const result = await gateway.handleMessage({
      channel: "telegram",
      externalId: "123",
      chatId: "chat-1",
      text: "hello",
    });

    expect(result).toBeUndefined();
  });
});

// ── Slash Commands ───────────────────────────────────────

describe("ChannelGateway — Slash Commands", () => {
  it("/help returns list of commands", async () => {
    const { gateway } = createGateway();
    const result = await gateway.handleMessage({
      channel: "telegram",
      externalId: "42",
      chatId: "chat-1",
      text: "/help",
    });

    expect(result).toContain("/help");
    expect(result).toContain("/status");
    expect(result).toContain("/tasks");
    expect(result).toContain("/plans");
    expect(result).toContain("/agents");
    expect(result).toContain("/approve");
    expect(result).toContain("/reject");
    expect(result).toContain("/new");
    expect(result).toContain("/pair");
  });

  it("/status returns project info and task counts", async () => {
    const orchestrator = createMockOrchestrator();
    (orchestrator.getStore as any).mockReturnValue({
      getAllTasks: vi.fn().mockReturnValue([
        { status: "pending" },
        { status: "pending" },
        { status: "in_progress" },
        { status: "done" },
        { status: "failed" },
      ]),
      getState: vi.fn().mockReturnValue({ processes: [] }),
    });

    const { gateway } = createGateway({ orchestrator });
    const result = await gateway.handleMessage({
      channel: "telegram",
      externalId: "42",
      chatId: "chat-1",
      text: "/status",
    });

    expect(result).toContain("test-project");
    expect(result).toContain("2 pending");
    expect(result).toContain("1 running");
    expect(result).toContain("1 done");
    expect(result).toContain("1 failed");
  });

  it("/tasks returns task list", async () => {
    const orchestrator = createMockOrchestrator();
    (orchestrator.getStore as any).mockReturnValue({
      getAllTasks: vi.fn().mockReturnValue([
        { title: "Build API", status: "done" },
        { title: "Write tests", status: "in_progress" },
      ]),
      getState: vi.fn().mockReturnValue({ processes: [] }),
    });

    const { gateway } = createGateway({ orchestrator });
    const result = await gateway.handleMessage({
      channel: "telegram",
      externalId: "42",
      chatId: "chat-1",
      text: "/tasks",
    });

    expect(result).toContain("Build API");
    expect(result).toContain("Write tests");
  });

  it("/tasks returns 'No tasks' when empty", async () => {
    const { gateway } = createGateway();
    const result = await gateway.handleMessage({
      channel: "telegram",
      externalId: "42",
      chatId: "chat-1",
      text: "/tasks",
    });

    expect(result).toContain("No tasks");
  });

  it("/plans returns plan list", async () => {
    const orchestrator = createMockOrchestrator();
    (orchestrator.getAllPlans as any).mockReturnValue([
      { name: "Deploy v2", status: "active" },
      { name: "Refactor", status: "completed" },
    ]);

    const { gateway } = createGateway({ orchestrator });
    const result = await gateway.handleMessage({
      channel: "telegram",
      externalId: "42",
      chatId: "chat-1",
      text: "/plans",
    });

    expect(result).toContain("Deploy v2");
    expect(result).toContain("Refactor");
  });

  it("/agents returns agent list", async () => {
    const orchestrator = createMockOrchestrator();
    (orchestrator.getAgents as any).mockReturnValue([
      { name: "claude", role: "senior" },
      { name: "codex", role: "junior" },
    ]);

    const { gateway } = createGateway({ orchestrator });
    const result = await gateway.handleMessage({
      channel: "telegram",
      externalId: "42",
      chatId: "chat-1",
      text: "/agents",
    });

    expect(result).toContain("claude");
    expect(result).toContain("codex");
  });

  it("/new clears session", async () => {
    const peerStore = createMockPeerStore();
    const { gateway } = createGateway({ peerStore });
    const result = await gateway.handleMessage({
      channel: "telegram",
      externalId: "42",
      chatId: "chat-1",
      text: "/new",
    });

    expect(result).toContain("Session reset");
    expect(peerStore.clearSession).toHaveBeenCalledWith("telegram:42");
  });
});

// ── Approval Commands ────────────────────────────────────

describe("ChannelGateway — Approval Commands", () => {
  it("/approve with no args lists pending approvals", async () => {
    const orchestrator = createMockOrchestrator();
    (orchestrator.getStore as any).mockReturnValue({
      getAllTasks: vi.fn().mockReturnValue([]),
      getState: vi.fn().mockReturnValue({ processes: [] }),
    });

    const resolver = createMockApprovalResolver();
    const { gateway } = createGateway({ orchestrator, approvalResolver: resolver });
    const result = await gateway.handleMessage({
      channel: "telegram",
      externalId: "42",
      chatId: "chat-1",
      text: "/approve",
    });

    expect(result).toContain("No pending approvals");
  });

  it("/approve REQUEST_ID approves the request", async () => {
    const resolver = createMockApprovalResolver();
    const { gateway } = createGateway({ approvalResolver: resolver });
    const result = await gateway.handleMessage({
      channel: "telegram",
      externalId: "42",
      chatId: "chat-1",
      text: "/approve req-123",
    });

    expect(resolver.approve).toHaveBeenCalledWith("req-123", "telegram:42");
    expect(result).toContain("Approved");
  });

  it("/reject without approval resolver returns error", async () => {
    const { gateway } = createGateway();
    const result = await gateway.handleMessage({
      channel: "telegram",
      externalId: "42",
      chatId: "chat-1",
      text: "/reject req-123 bad code",
    });

    expect(result).toContain("not configured");
  });

  it("/reject with feedback rejects directly", async () => {
    const resolver = createMockApprovalResolver();
    const { gateway } = createGateway({ approvalResolver: resolver });
    const result = await gateway.handleMessage({
      channel: "telegram",
      externalId: "42",
      chatId: "chat-1",
      text: "/reject req-123 needs better error handling",
    });

    expect(resolver.reject).toHaveBeenCalledWith("req-123", "needs better error handling", "telegram:42");
    expect(result).toContain("Rejected");
  });

  it("/reject without feedback prompts for reply", async () => {
    const resolver = createMockApprovalResolver();
    const { gateway } = createGateway({ approvalResolver: resolver });
    const result = await gateway.handleMessage({
      channel: "telegram",
      externalId: "42",
      chatId: "chat-1",
      text: "/reject req-123",
    });

    expect(result).toContain("reply with your feedback");
  });
});

// ── Approval Callbacks ───────────────────────────────────

describe("ChannelGateway — handleApprovalCallback", () => {
  it("approve action calls resolver", async () => {
    const resolver = createMockApprovalResolver();
    const { gateway } = createGateway({ approvalResolver: resolver });

    const result = await gateway.handleApprovalCallback("approve", "req-1", "chat-1", "Alice (telegram:42)");
    expect(result).toContain("Approved");
    expect(resolver.approve).toHaveBeenCalledWith("req-1", "Alice (telegram:42)");
  });

  it("reject action sets pending revise state", async () => {
    const resolver = createMockApprovalResolver();
    const { gateway } = createGateway({ approvalResolver: resolver });

    const result = await gateway.handleApprovalCallback("reject", "req-1", "chat-1", "user");
    expect(result).toContain("Reply with your feedback");
  });

  it("subsequent message after reject is treated as feedback", async () => {
    const resolver = createMockApprovalResolver();
    const peerStore = createMockPeerStore();
    const { gateway } = createGateway({ approvalResolver: resolver, peerStore });

    // First: reject button
    await gateway.handleApprovalCallback("reject", "req-1", "chat-1", "user");

    // Then: user sends feedback text
    const result = await gateway.handleMessage({
      channel: "telegram",
      externalId: "42",
      chatId: "chat-1",
      text: "The code doesn't handle edge cases",
    });

    expect(resolver.reject).toHaveBeenCalledWith("req-1", "The code doesn't handle edge cases", "telegram:42");
    expect(result).toContain("Rejected");
  });

  it("returns error when no resolver configured", async () => {
    const { gateway } = createGateway();
    const result = await gateway.handleApprovalCallback("approve", "req-1", "chat-1", "user");
    expect(result).toContain("No approval resolver");
  });
});

// ── Pair Command ─────────────────────────────────────────

describe("ChannelGateway — /pair Command", () => {
  it("/pair without args shows usage", async () => {
    const { gateway } = createGateway();
    const result = await gateway.handleMessage({
      channel: "telegram",
      externalId: "42",
      chatId: "chat-1",
      text: "/pair",
    });

    expect(result).toContain("Usage:");
  });

  it("/pair CODE resolves pairing for authorized peer", async () => {
    const peerStore = createMockPeerStore({
      resolvePairing: vi.fn().mockReturnValue({
        id: "pair-1",
        peerId: "telegram:999",
        channel: "telegram",
        externalId: "999",
        displayName: "NewUser",
        code: "ABC123",
        resolved: true,
      }),
    });
    const { gateway } = createGateway({ peerStore });

    const result = await gateway.handleMessage({
      channel: "telegram",
      externalId: "42",
      chatId: "chat-1",
      text: "/pair ABC123",
    });

    expect(result).toContain("Approved");
    expect(result).toContain("NewUser");
  });

  it("/pair fails for unauthorized peer", async () => {
    const peerStore = createMockPeerStore({
      isAllowed: vi.fn().mockImplementation((peerId: string) => {
        // Allowed for the first call (DM policy check), not for /pair admin check
        return peerId !== "telegram:42";
      }),
    });
    // Need gateway to allow the message through but block /pair
    // Since isAllowed returns false for our user, the message will be blocked at DM policy level
    // Let's test differently: isAllowed returns true (user passes DM policy) but
    // for /pair specifically the same check returns false
    let callCount = 0;
    const peerStore2 = createMockPeerStore({
      isAllowed: vi.fn().mockImplementation(() => {
        callCount++;
        // First call is DM policy check (allow), second is /pair admin check (deny)
        return callCount <= 1;
      }),
    });
    const { gateway } = createGateway({ peerStore: peerStore2 });

    const result = await gateway.handleMessage({
      channel: "telegram",
      externalId: "42",
      chatId: "chat-1",
      text: "/pair ABC123",
    });

    expect(result).toContain("authorized peer");
  });

  it("/pair with invalid code", async () => {
    const peerStore = createMockPeerStore({
      resolvePairing: vi.fn().mockReturnValue(undefined),
    });
    const { gateway } = createGateway({ peerStore });

    const result = await gateway.handleMessage({
      channel: "telegram",
      externalId: "42",
      chatId: "chat-1",
      text: "/pair BADCODE",
    });

    expect(result).toContain("Invalid or expired");
  });
});

// ── TelegramGatewayAdapter ──────────────────────────────

describe("TelegramGatewayAdapter", () => {
  it("handleInboundMessage delegates to gateway", async () => {
    const { gateway, peerStore } = createGateway();
    const adapter = new TelegramGatewayAdapter(gateway);

    const result = await adapter.handleInboundMessage("42", "chat-1", "/help", "Alice", "msg-1");
    expect(result).toContain("/help");
    expect(peerStore.upsertPeer).toHaveBeenCalled();
  });

  it("handleApprovalCallback delegates to gateway", async () => {
    const resolver = createMockApprovalResolver();
    const { gateway } = createGateway({ approvalResolver: resolver });
    const adapter = new TelegramGatewayAdapter(gateway);

    const result = await adapter.handleApprovalCallback("approve", "req-1", "chat-1", "42", "Alice");
    expect(result).toContain("Approved");
    expect(resolver.approve).toHaveBeenCalledWith("req-1", "Alice (telegram:42)");
  });

  it("handleApprovalCallback uses peerId when no name", async () => {
    const resolver = createMockApprovalResolver();
    const { gateway } = createGateway({ approvalResolver: resolver });
    const adapter = new TelegramGatewayAdapter(gateway);

    await adapter.handleApprovalCallback("approve", "req-1", "chat-1", "42");
    expect(resolver.approve).toHaveBeenCalledWith("req-1", "telegram:42");
  });
});
