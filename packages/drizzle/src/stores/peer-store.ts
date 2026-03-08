import { eq, and, lt } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { PeerStore } from "@polpo-ai/core/peer-store";
import type {
  PeerIdentity, PairingRequest, ChannelType,
  ChannelGatewayConfig, PresenceEntry,
} from "@polpo-ai/core/types";

type AnyTable = any;

export class DrizzlePeerStore implements PeerStore {
  private presence: Map<string, PresenceEntry> = new Map();

  constructor(
    private db: any,
    private schema: {
      peers: AnyTable;
      peerAllowlist: AnyTable;
      pairingRequests: AnyTable;
      peerSessions: AnyTable;
    },
  ) {}

  // ── Peer identity ───────────────────────────────────────────────────

  async getPeer(peerId: string): Promise<PeerIdentity | undefined> {
    const rows: any[] = await this.db.select().from(this.schema.peers)
      .where(eq(this.schema.peers.id, peerId));
    return rows.length > 0 ? this.rowToPeer(rows[0]) : undefined;
  }

  async upsertPeer(peer: Omit<PeerIdentity, "id" | "firstSeenAt"> & { id?: string }): Promise<PeerIdentity> {
    const now = new Date().toISOString();
    const id = peer.id ?? nanoid();
    const values = {
      id,
      channel: peer.channel,
      externalId: peer.externalId,
      displayName: peer.displayName ?? null,
      firstSeenAt: now,
      lastSeenAt: peer.lastSeenAt,
      linkedTo: peer.linkedTo ?? null,
    };
    await this.db.insert(this.schema.peers).values(values)
      .onConflictDoUpdate({
        target: this.schema.peers.id,
        set: {
          displayName: values.displayName,
          lastSeenAt: values.lastSeenAt,
          linkedTo: values.linkedTo,
        },
      });
    const result = await this.getPeer(id);
    return result!;
  }

  async listPeers(channel?: ChannelType): Promise<PeerIdentity[]> {
    let q = this.db.select().from(this.schema.peers);
    if (channel) q = q.where(eq(this.schema.peers.channel, channel));
    const rows: any[] = await q;
    return rows.map((r) => this.rowToPeer(r));
  }

  // ── Authorization ───────────────────────────────────────────────────

  async isAllowed(peerId: string, channelConfig?: ChannelGatewayConfig): Promise<boolean> {
    if (channelConfig?.dmPolicy === "open") return true;
    const rows: any[] = await this.db.select().from(this.schema.peerAllowlist)
      .where(eq(this.schema.peerAllowlist.peerId, peerId));
    return rows.length > 0;
  }

  async addToAllowlist(peerId: string): Promise<void> {
    await this.db.insert(this.schema.peerAllowlist).values({ peerId })
      .onConflictDoNothing();
  }

  async removeFromAllowlist(peerId: string): Promise<void> {
    await this.db.delete(this.schema.peerAllowlist)
      .where(eq(this.schema.peerAllowlist.peerId, peerId));
  }

  async getAllowlist(): Promise<string[]> {
    const rows: any[] = await this.db.select().from(this.schema.peerAllowlist);
    return rows.map((r) => r.peerId);
  }

  // ── Pairing ─────────────────────────────────────────────────────────

  async createPairingRequest(channel: ChannelType, externalId: string, displayName?: string): Promise<PairingRequest> {
    const id = nanoid();
    const code = nanoid(6).toUpperCase();
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 min

    // Find or create peer
    let peer = await this.findPeerByExternal(channel, externalId);
    if (!peer) {
      peer = await this.upsertPeer({ channel, externalId, displayName, lastSeenAt: now });
    }

    await this.db.insert(this.schema.pairingRequests).values({
      id,
      peerId: peer.id,
      channel,
      externalId,
      displayName: displayName ?? null,
      code,
      createdAt: now,
      expiresAt,
      resolved: 0,
    });

    return { id, peerId: peer.id, channel, externalId, displayName, code, createdAt: now, expiresAt, resolved: false };
  }

  async resolvePairing(code: string): Promise<PairingRequest | undefined> {
    const rows: any[] = await this.db.select().from(this.schema.pairingRequests)
      .where(and(eq(this.schema.pairingRequests.code, code), eq(this.schema.pairingRequests.resolved, 0)));
    if (rows.length === 0) return undefined;

    const row = rows[0];
    const now = new Date().toISOString();
    if (row.expiresAt < now) return undefined;

    await this.db.update(this.schema.pairingRequests)
      .set({ resolved: 1 })
      .where(eq(this.schema.pairingRequests.id, row.id));

    // Add to allowlist
    await this.addToAllowlist(row.peerId);

    return this.rowToPairing({ ...row, resolved: 1 });
  }

  async getPendingPairing(peerId: string): Promise<PairingRequest | undefined> {
    const rows: any[] = await this.db.select().from(this.schema.pairingRequests)
      .where(and(eq(this.schema.pairingRequests.peerId, peerId), eq(this.schema.pairingRequests.resolved, 0)));
    if (rows.length === 0) return undefined;
    const now = new Date().toISOString();
    const valid = rows.find((r) => r.expiresAt >= now);
    return valid ? this.rowToPairing(valid) : undefined;
  }

  async cleanExpiredPairings(): Promise<number> {
    const now = new Date().toISOString();
    const result = await this.db.delete(this.schema.pairingRequests)
      .where(and(eq(this.schema.pairingRequests.resolved, 0), lt(this.schema.pairingRequests.expiresAt, now)));
    return result?.rowCount ?? result?.changes ?? 0;
  }

  // ── Session mapping ─────────────────────────────────────────────────

  async getSessionId(peerId: string): Promise<string | undefined> {
    const rows: any[] = await this.db.select().from(this.schema.peerSessions)
      .where(eq(this.schema.peerSessions.peerId, peerId));
    return rows.length > 0 ? rows[0].sessionId : undefined;
  }

  async setSessionId(peerId: string, sessionId: string): Promise<void> {
    await this.db.insert(this.schema.peerSessions).values({ peerId, sessionId })
      .onConflictDoUpdate({ target: this.schema.peerSessions.peerId, set: { sessionId } });
  }

  async clearSession(peerId: string): Promise<void> {
    await this.db.delete(this.schema.peerSessions)
      .where(eq(this.schema.peerSessions.peerId, peerId));
  }

  // ── Identity linking ────────────────────────────────────────────────

  async linkPeers(peerId: string, linkedTo: string): Promise<void> {
    await this.db.update(this.schema.peers)
      .set({ linkedTo })
      .where(eq(this.schema.peers.id, peerId));
  }

  async resolveCanonicalId(peerId: string): Promise<string> {
    const peer = await this.getPeer(peerId);
    return peer?.linkedTo ?? peerId;
  }

  // ── Presence (in-memory, ephemeral) ─────────────────────────────────

  async updatePresence(peerId: string, activity: PresenceEntry["activity"]): Promise<void> {
    const peer = await this.getPeer(peerId);
    this.presence.set(peerId, {
      peerId,
      displayName: peer?.displayName,
      channel: peer?.channel ?? "webchat",
      lastActivityAt: new Date().toISOString(),
      activity,
    });
  }

  async getPresence(): Promise<PresenceEntry[]> {
    return Array.from(this.presence.values());
  }

  async prunePresence(ttlMs?: number): Promise<number> {
    const cutoff = Date.now() - (ttlMs ?? 5 * 60 * 1000);
    let pruned = 0;
    for (const [id, entry] of this.presence) {
      if (new Date(entry.lastActivityAt).getTime() < cutoff) {
        this.presence.delete(id);
        pruned++;
      }
    }
    return pruned;
  }

  // ── Private helpers ─────────────────────────────────────────────────

  private rowToPeer(row: any): PeerIdentity {
    return {
      id: row.id,
      channel: row.channel,
      externalId: row.externalId,
      displayName: row.displayName ?? undefined,
      firstSeenAt: row.firstSeenAt,
      lastSeenAt: row.lastSeenAt,
      linkedTo: row.linkedTo ?? undefined,
    };
  }

  private rowToPairing(row: any): PairingRequest {
    return {
      id: row.id,
      peerId: row.peerId,
      channel: row.channel,
      externalId: row.externalId,
      displayName: row.displayName ?? undefined,
      code: row.code,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      resolved: Boolean(row.resolved),
    };
  }

  private async findPeerByExternal(channel: ChannelType, externalId: string): Promise<PeerIdentity | undefined> {
    const rows: any[] = await this.db.select().from(this.schema.peers)
      .where(and(eq(this.schema.peers.channel, channel), eq(this.schema.peers.externalId, externalId)));
    return rows.length > 0 ? this.rowToPeer(rows[0]) : undefined;
  }
}
