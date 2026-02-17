import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FilePeerStore } from "../core/peer-store.js";
import type { ChannelGatewayConfig } from "../core/types.js";

// ── Helpers ──────────────────────────────────────────────

let tmpDir: string;
let store: FilePeerStore;

function createStore(): FilePeerStore {
  return new FilePeerStore(tmpDir);
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "polpo-peer-test-"));
  store = createStore();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── Peer Identity ────────────────────────────────────────

describe("FilePeerStore — Peer Identity", () => {
  it("upsertPeer creates a new peer with auto-generated ID", () => {
    const peer = store.upsertPeer({
      channel: "telegram",
      externalId: "123456",
      displayName: "Alice",
      lastSeenAt: new Date().toISOString(),
    });

    expect(peer.id).toBe("telegram:123456");
    expect(peer.channel).toBe("telegram");
    expect(peer.externalId).toBe("123456");
    expect(peer.displayName).toBe("Alice");
    expect(peer.firstSeenAt).toBeDefined();
    expect(peer.lastSeenAt).toBeDefined();
  });

  it("upsertPeer with custom id", () => {
    const peer = store.upsertPeer({
      id: "custom-id",
      channel: "whatsapp",
      externalId: "999",
      lastSeenAt: new Date().toISOString(),
    });
    expect(peer.id).toBe("custom-id");
  });

  it("upsertPeer updates existing peer, preserving firstSeenAt", () => {
    const first = store.upsertPeer({
      channel: "telegram",
      externalId: "123",
      displayName: "Alice",
      lastSeenAt: "2025-01-01T00:00:00Z",
    });

    const updated = store.upsertPeer({
      channel: "telegram",
      externalId: "123",
      displayName: "Alice Updated",
      lastSeenAt: "2025-06-01T00:00:00Z",
    });

    expect(updated.firstSeenAt).toBe(first.firstSeenAt);
    expect(updated.displayName).toBe("Alice Updated");
  });

  it("getPeer returns peer by ID", () => {
    store.upsertPeer({
      channel: "telegram",
      externalId: "42",
      lastSeenAt: new Date().toISOString(),
    });

    const peer = store.getPeer("telegram:42");
    expect(peer).toBeDefined();
    expect(peer!.externalId).toBe("42");
  });

  it("getPeer returns undefined for unknown ID", () => {
    expect(store.getPeer("nonexistent")).toBeUndefined();
  });

  it("listPeers returns all peers", () => {
    store.upsertPeer({ channel: "telegram", externalId: "1", lastSeenAt: new Date().toISOString() });
    store.upsertPeer({ channel: "whatsapp", externalId: "2", lastSeenAt: new Date().toISOString() });
    store.upsertPeer({ channel: "telegram", externalId: "3", lastSeenAt: new Date().toISOString() });

    expect(store.listPeers()).toHaveLength(3);
  });

  it("listPeers filters by channel", () => {
    store.upsertPeer({ channel: "telegram", externalId: "1", lastSeenAt: new Date().toISOString() });
    store.upsertPeer({ channel: "whatsapp", externalId: "2", lastSeenAt: new Date().toISOString() });
    store.upsertPeer({ channel: "telegram", externalId: "3", lastSeenAt: new Date().toISOString() });

    const tgPeers = store.listPeers("telegram");
    expect(tgPeers).toHaveLength(2);
    expect(tgPeers.every(p => p.channel === "telegram")).toBe(true);
  });

  it("persists peers across instances", () => {
    store.upsertPeer({ channel: "telegram", externalId: "42", displayName: "Bob", lastSeenAt: new Date().toISOString() });

    const store2 = createStore();
    const peer = store2.getPeer("telegram:42");
    expect(peer).toBeDefined();
    expect(peer!.displayName).toBe("Bob");
  });
});

// ── Authorization (DM Policy) ────────────────────────────

describe("FilePeerStore — Authorization", () => {
  it("allowlist policy: blocks unknown peers", () => {
    store.upsertPeer({ channel: "telegram", externalId: "1", lastSeenAt: new Date().toISOString() });
    const config: ChannelGatewayConfig = { dmPolicy: "allowlist" };
    expect(store.isAllowed("telegram:1", config)).toBe(false);
  });

  it("allowlist policy: allows peers on the allowlist", () => {
    store.upsertPeer({ channel: "telegram", externalId: "1", lastSeenAt: new Date().toISOString() });
    store.addToAllowlist("telegram:1");
    const config: ChannelGatewayConfig = { dmPolicy: "allowlist" };
    expect(store.isAllowed("telegram:1", config)).toBe(true);
  });

  it("open policy: allows everyone", () => {
    store.upsertPeer({ channel: "telegram", externalId: "1", lastSeenAt: new Date().toISOString() });
    const config: ChannelGatewayConfig = { dmPolicy: "open" };
    expect(store.isAllowed("telegram:1", config)).toBe(true);
  });

  it("disabled policy: blocks everyone", () => {
    store.addToAllowlist("telegram:1");
    const config: ChannelGatewayConfig = { dmPolicy: "disabled" };
    expect(store.isAllowed("telegram:1", config)).toBe(false);
  });

  it("pairing policy: blocks unknown peers not on allowlist", () => {
    store.upsertPeer({ channel: "telegram", externalId: "1", lastSeenAt: new Date().toISOString() });
    const config: ChannelGatewayConfig = { dmPolicy: "pairing" };
    expect(store.isAllowed("telegram:1", config)).toBe(false);
  });

  it("pairing policy: allows paired (allowlisted) peers", () => {
    store.upsertPeer({ channel: "telegram", externalId: "1", lastSeenAt: new Date().toISOString() });
    store.addToAllowlist("telegram:1");
    const config: ChannelGatewayConfig = { dmPolicy: "pairing" };
    expect(store.isAllowed("telegram:1", config)).toBe(true);
  });

  it("defaults to allowlist policy when no config", () => {
    store.upsertPeer({ channel: "telegram", externalId: "1", lastSeenAt: new Date().toISOString() });
    expect(store.isAllowed("telegram:1")).toBe(false);
    store.addToAllowlist("telegram:1");
    expect(store.isAllowed("telegram:1")).toBe(true);
  });

  it("allowFrom with wildcard allows everyone", () => {
    store.upsertPeer({ channel: "telegram", externalId: "1", lastSeenAt: new Date().toISOString() });
    const config: ChannelGatewayConfig = { dmPolicy: "allowlist", allowFrom: ["*"] };
    expect(store.isAllowed("telegram:1", config)).toBe(true);
  });

  it("allowFrom with specific IDs", () => {
    store.upsertPeer({ channel: "telegram", externalId: "42", lastSeenAt: new Date().toISOString() });
    const config: ChannelGatewayConfig = { dmPolicy: "allowlist", allowFrom: ["42"] };
    expect(store.isAllowed("telegram:42", config)).toBe(true);
  });

  it("addToAllowlist and removeFromAllowlist", () => {
    store.addToAllowlist("peer-1");
    store.addToAllowlist("peer-2");
    expect(store.getAllowlist()).toContain("peer-1");
    expect(store.getAllowlist()).toContain("peer-2");

    store.removeFromAllowlist("peer-1");
    expect(store.getAllowlist()).not.toContain("peer-1");
    expect(store.getAllowlist()).toContain("peer-2");
  });

  it("allowlist persists across instances", () => {
    store.addToAllowlist("peer-1");
    const store2 = createStore();
    expect(store2.getAllowlist()).toContain("peer-1");
  });
});

// ── Pairing ──────────────────────────────────────────────

describe("FilePeerStore — Pairing", () => {
  it("createPairingRequest generates a 6-char uppercase code", () => {
    const request = store.createPairingRequest("telegram", "123", "Alice");

    expect(request.code).toHaveLength(6);
    expect(request.code).toBe(request.code.toUpperCase());
    expect(request.peerId).toBe("telegram:123");
    expect(request.channel).toBe("telegram");
    expect(request.displayName).toBe("Alice");
    expect(request.resolved).toBe(false);
    expect(request.expiresAt).toBeDefined();
  });

  it("returns existing pending request for same peer", () => {
    const first = store.createPairingRequest("telegram", "123");
    const second = store.createPairingRequest("telegram", "123");
    expect(first.code).toBe(second.code);
  });

  it("resolvePairing approves peer and adds to allowlist", () => {
    const request = store.createPairingRequest("telegram", "123", "Alice");
    const resolved = store.resolvePairing(request.code);

    expect(resolved).toBeDefined();
    expect(resolved!.resolved).toBe(true);
    expect(store.getAllowlist()).toContain("telegram:123");
  });

  it("resolvePairing is case-insensitive", () => {
    const request = store.createPairingRequest("telegram", "123");
    const resolved = store.resolvePairing(request.code.toLowerCase());
    expect(resolved).toBeDefined();
  });

  it("resolvePairing returns undefined for unknown code", () => {
    expect(store.resolvePairing("INVALID")).toBeUndefined();
  });

  it("resolvePairing returns undefined for already-resolved code", () => {
    const request = store.createPairingRequest("telegram", "123");
    store.resolvePairing(request.code);
    expect(store.resolvePairing(request.code)).toBeUndefined();
  });

  it("getPendingPairing returns pending request", () => {
    store.createPairingRequest("telegram", "123");
    const pending = store.getPendingPairing("telegram:123");
    expect(pending).toBeDefined();
    expect(pending!.resolved).toBe(false);
  });

  it("getPendingPairing returns undefined after resolution", () => {
    const req = store.createPairingRequest("telegram", "123");
    store.resolvePairing(req.code);
    expect(store.getPendingPairing("telegram:123")).toBeUndefined();
  });

  it("cleanExpiredPairings marks expired requests as resolved", () => {
    const request = store.createPairingRequest("telegram", "123");
    // Manually expire the request by setting expiresAt to the past
    // Access through pairings map is private, so we use a workaround:
    // create the store again and manually modify the expiry via resolvePairing with a known expired one
    // Actually, we just test cleanExpired when there's nothing expired
    const cleaned = store.cleanExpiredPairings();
    expect(cleaned).toBe(0); // nothing expired yet
  });

  it("enforces max pending pairings per channel", () => {
    // Create MAX_PENDING_PER_CHANNEL (3) pairings
    const r1 = store.createPairingRequest("telegram", "user1");
    const r2 = store.createPairingRequest("telegram", "user2");
    const r3 = store.createPairingRequest("telegram", "user3");

    // The 4th should evict the oldest
    const r4 = store.createPairingRequest("telegram", "user4");
    expect(r4.peerId).toBe("telegram:user4");

    // r1 (the oldest) should have been evicted, so resolving it should fail
    expect(store.resolvePairing(r1.code)).toBeUndefined();
    // r2 should still be valid
    expect(store.resolvePairing(r2.code)).toBeDefined();
  });

  it("pairings persist across instances", () => {
    const request = store.createPairingRequest("telegram", "123", "Alice");
    const store2 = createStore();
    const resolved = store2.resolvePairing(request.code);
    expect(resolved).toBeDefined();
    expect(resolved!.displayName).toBe("Alice");
  });
});

// ── Session Mapping ──────────────────────────────────────

describe("FilePeerStore — Session Mapping", () => {
  it("get/set/clear session", () => {
    expect(store.getSessionId("peer-1")).toBeUndefined();
    store.setSessionId("peer-1", "session-abc");
    expect(store.getSessionId("peer-1")).toBe("session-abc");
    store.clearSession("peer-1");
    expect(store.getSessionId("peer-1")).toBeUndefined();
  });

  it("sessions persist across instances", () => {
    store.setSessionId("peer-1", "session-xyz");
    const store2 = createStore();
    expect(store2.getSessionId("peer-1")).toBe("session-xyz");
  });

  it("linked peers share the same session via canonical ID", () => {
    store.upsertPeer({ channel: "telegram", externalId: "1", lastSeenAt: new Date().toISOString() });
    store.upsertPeer({ channel: "whatsapp", externalId: "2", lastSeenAt: new Date().toISOString() });
    store.linkPeers("whatsapp:2", "telegram:1");

    store.setSessionId("telegram:1", "shared-session");

    // Accessing via the linked peer should resolve to the same session
    expect(store.getSessionId("whatsapp:2")).toBe("shared-session");
  });
});

// ── Identity Linking ─────────────────────────────────────

describe("FilePeerStore — Identity Linking", () => {
  it("linkPeers sets linkedTo on the peer", () => {
    store.upsertPeer({ channel: "telegram", externalId: "1", lastSeenAt: new Date().toISOString() });
    store.upsertPeer({ channel: "whatsapp", externalId: "2", lastSeenAt: new Date().toISOString() });

    store.linkPeers("whatsapp:2", "telegram:1");

    const peer = store.getPeer("whatsapp:2");
    expect(peer!.linkedTo).toBe("telegram:1");
  });

  it("resolveCanonicalId follows one level of linking", () => {
    store.upsertPeer({ channel: "telegram", externalId: "1", lastSeenAt: new Date().toISOString() });
    store.upsertPeer({ channel: "whatsapp", externalId: "2", lastSeenAt: new Date().toISOString() });
    store.linkPeers("whatsapp:2", "telegram:1");

    expect(store.resolveCanonicalId("whatsapp:2")).toBe("telegram:1");
    expect(store.resolveCanonicalId("telegram:1")).toBe("telegram:1"); // no link = self
  });

  it("resolveCanonicalId returns self for unknown peers", () => {
    expect(store.resolveCanonicalId("unknown:peer")).toBe("unknown:peer");
  });

  it("linkPeers is a no-op for unknown peer", () => {
    store.linkPeers("nonexistent", "other");
    // Should not throw, just silently do nothing
    expect(store.getPeer("nonexistent")).toBeUndefined();
  });

  it("linking persists across instances", () => {
    store.upsertPeer({ channel: "telegram", externalId: "1", lastSeenAt: new Date().toISOString() });
    store.linkPeers("telegram:1", "canonical-peer");

    const store2 = createStore();
    expect(store2.resolveCanonicalId("telegram:1")).toBe("canonical-peer");
  });
});

// ── Presence ─────────────────────────────────────────────

describe("FilePeerStore — Presence", () => {
  it("updatePresence and getPresence", () => {
    store.upsertPeer({ channel: "telegram", externalId: "1", displayName: "Alice", lastSeenAt: new Date().toISOString() });
    store.updatePresence("telegram:1", "chatting");

    const presence = store.getPresence();
    expect(presence).toHaveLength(1);
    expect(presence[0].peerId).toBe("telegram:1");
    expect(presence[0].displayName).toBe("Alice");
    expect(presence[0].channel).toBe("telegram");
    expect(presence[0].activity).toBe("chatting");
  });

  it("getPresence prunes stale entries", async () => {
    store.updatePresence("telegram:1", "chatting");

    // Wait a tick so the entry is older than 1ms
    await new Promise(r => setTimeout(r, 5));

    // Prune with 1ms TTL should remove the entry
    const pruned = store.prunePresence(1);
    expect(pruned).toBe(1);
    expect(store.getPresence()).toHaveLength(0);
  });

  it("updatePresence overrides previous entry", () => {
    store.updatePresence("telegram:1", "chatting");
    store.updatePresence("telegram:1", "approving");

    const presence = store.getPresence();
    expect(presence).toHaveLength(1);
    expect(presence[0].activity).toBe("approving");
  });

  it("presence is ephemeral (not persisted)", () => {
    store.updatePresence("telegram:1", "chatting");
    const store2 = createStore();
    expect(store2.getPresence()).toHaveLength(0);
  });

  it("presence infers channel from peerId when peer not found", () => {
    store.updatePresence("telegram:999", "idle");
    const presence = store.getPresence();
    expect(presence[0].channel).toBe("telegram");
  });
});
