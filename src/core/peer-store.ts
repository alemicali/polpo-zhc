/**
 * Peer identity store — manages channel peers, allowlists, pairing, and session mapping.
 *
 * Interface re-exported from @polpo/core.
 * FilePeerStore implementation lives here in the shell layer.
 */

export type { PeerStore } from "@polpo/core/peer-store";

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nanoid } from "nanoid";
import type {
  PeerIdentity,
  PairingRequest,
  ChannelType,
  ChannelGatewayConfig,
  PresenceEntry,
  DmPolicy,
} from "./types.js";
import type { PeerStore } from "@polpo/core/peer-store";

// ── File-backed Implementation ──────────────────────────────────────────

const PRESENCE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const PAIRING_EXPIRY_MS = 60 * 60 * 1000; // 1 hour
const MAX_PENDING_PER_CHANNEL = 3;

export class FilePeerStore implements PeerStore {
  private readonly dir: string;
  private peers = new Map<string, PeerIdentity>();
  private allowlist = new Set<string>();
  private pairings = new Map<string, PairingRequest>(); // code → request
  private sessionMap = new Map<string, string>(); // peerId → sessionId
  private presence = new Map<string, PresenceEntry>();

  constructor(polpoDir: string) {
    this.dir = join(polpoDir, "peers");
    this.load();
  }

  // ── Peer Identity ──────────────────────────────────────────────

  getPeer(peerId: string): PeerIdentity | undefined {
    return this.peers.get(peerId);
  }

  upsertPeer(input: Omit<PeerIdentity, "id" | "firstSeenAt"> & { id?: string }): PeerIdentity {
    const peerId = input.id ?? `${input.channel}:${input.externalId}`;
    const existing = this.peers.get(peerId);
    const now = new Date().toISOString();

    const peer: PeerIdentity = {
      id: peerId,
      channel: input.channel,
      externalId: input.externalId,
      displayName: input.displayName ?? existing?.displayName,
      firstSeenAt: existing?.firstSeenAt ?? now,
      lastSeenAt: now,
      linkedTo: input.linkedTo ?? existing?.linkedTo,
    };

    this.peers.set(peerId, peer);
    this.savePeers();
    return peer;
  }

  listPeers(channel?: ChannelType): PeerIdentity[] {
    const all = [...this.peers.values()];
    return channel ? all.filter(p => p.channel === channel) : all;
  }

  // ── Authorization ──────────────────────────────────────────────

  isAllowed(peerId: string, channelConfig?: ChannelGatewayConfig): boolean {
    const policy: DmPolicy = channelConfig?.dmPolicy ?? "allowlist";

    switch (policy) {
      case "disabled":
        return false;
      case "open":
        return true;
      case "allowlist":
        return this.allowlist.has(peerId) || this.isInConfigAllowlist(peerId, channelConfig);
      case "pairing":
        return this.allowlist.has(peerId) || this.isInConfigAllowlist(peerId, channelConfig);
      default:
        return false;
    }
  }

  private isInConfigAllowlist(peerId: string, config?: ChannelGatewayConfig): boolean {
    if (!config?.allowFrom) return false;
    if (config.allowFrom.includes("*")) return true;
    // Check both full peerId ("telegram:123") and raw externalId ("123")
    const peer = this.peers.get(peerId);
    const externalId = peer?.externalId ?? peerId.split(":")[1];
    return config.allowFrom.includes(peerId) || (externalId ? config.allowFrom.includes(externalId) : false);
  }

  addToAllowlist(peerId: string): void {
    this.allowlist.add(peerId);
    this.saveAllowlist();
  }

  removeFromAllowlist(peerId: string): void {
    this.allowlist.delete(peerId);
    this.saveAllowlist();
  }

  getAllowlist(): string[] {
    return [...this.allowlist];
  }

  // ── Pairing ────────────────────────────────────────────────────

  createPairingRequest(channel: ChannelType, externalId: string, displayName?: string): PairingRequest {
    const peerId = `${channel}:${externalId}`;

    // Clean expired first
    this.cleanExpiredPairings();

    // Check max pending per channel
    const pending = [...this.pairings.values()].filter(
      p => p.channel === channel && !p.resolved,
    );
    if (pending.length >= MAX_PENDING_PER_CHANNEL) {
      // Remove oldest
      const oldest = pending.sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
      this.pairings.delete(oldest.code);
    }

    // Check if this peer already has a pending request
    const existing = [...this.pairings.values()].find(
      p => p.peerId === peerId && !p.resolved,
    );
    if (existing) return existing;

    const now = new Date();
    const code = nanoid(6).toUpperCase();
    const request: PairingRequest = {
      id: nanoid(10),
      peerId,
      channel,
      externalId,
      displayName,
      code,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + PAIRING_EXPIRY_MS).toISOString(),
      resolved: false,
    };

    this.pairings.set(code, request);
    this.savePairings();
    return request;
  }

  resolvePairing(code: string): PairingRequest | undefined {
    const request = this.pairings.get(code.toUpperCase());
    if (!request || request.resolved) return undefined;

    const now = Date.now();
    if (now > new Date(request.expiresAt).getTime()) {
      // Expired
      request.resolved = true;
      this.savePairings();
      return undefined;
    }

    // Approve the peer
    request.resolved = true;
    this.addToAllowlist(request.peerId);
    this.savePairings();
    return request;
  }

  getPendingPairing(peerId: string): PairingRequest | undefined {
    return [...this.pairings.values()].find(
      p => p.peerId === peerId && !p.resolved && Date.now() < new Date(p.expiresAt).getTime(),
    );
  }

  cleanExpiredPairings(): number {
    const now = Date.now();
    let cleaned = 0;
    for (const [code, req] of this.pairings) {
      if (!req.resolved && now > new Date(req.expiresAt).getTime()) {
        req.resolved = true;
        cleaned++;
      }
    }
    if (cleaned > 0) this.savePairings();
    return cleaned;
  }

  // ── Session Mapping ────────────────────────────────────────────

  getSessionId(peerId: string): string | undefined {
    const canonicalId = this.resolveCanonicalId(peerId);
    return this.sessionMap.get(canonicalId);
  }

  setSessionId(peerId: string, sessionId: string): void {
    const canonicalId = this.resolveCanonicalId(peerId);
    this.sessionMap.set(canonicalId, sessionId);
    this.saveSessions();
  }

  clearSession(peerId: string): void {
    const canonicalId = this.resolveCanonicalId(peerId);
    this.sessionMap.delete(canonicalId);
    this.saveSessions();
  }

  // ── Identity Linking ───────────────────────────────────────────

  linkPeers(peerId: string, linkedTo: string): void {
    const peer = this.peers.get(peerId);
    if (peer) {
      peer.linkedTo = linkedTo;
      this.savePeers();
    }
  }

  resolveCanonicalId(peerId: string): string {
    const peer = this.peers.get(peerId);
    if (peer?.linkedTo) {
      // One level of indirection max (avoid cycles)
      return peer.linkedTo;
    }
    return peerId;
  }

  // ── Presence (in-memory only) ──────────────────────────────────

  updatePresence(peerId: string, activity: PresenceEntry["activity"]): void {
    const peer = this.peers.get(peerId);
    this.presence.set(peerId, {
      peerId,
      displayName: peer?.displayName,
      channel: peer?.channel ?? (peerId.split(":")[0] as ChannelType),
      lastActivityAt: new Date().toISOString(),
      activity,
    });
  }

  getPresence(): PresenceEntry[] {
    this.prunePresence();
    return [...this.presence.values()];
  }

  prunePresence(ttlMs = PRESENCE_TTL_MS): number {
    const cutoff = Date.now() - ttlMs;
    let pruned = 0;
    for (const [id, entry] of this.presence) {
      if (new Date(entry.lastActivityAt).getTime() < cutoff) {
        this.presence.delete(id);
        pruned++;
      }
    }
    return pruned;
  }

  // ── Persistence ────────────────────────────────────────────────

  private load(): void {
    if (!existsSync(this.dir)) return;
    this.loadJson("peers.json", (data: PeerIdentity[]) => {
      for (const p of data) this.peers.set(p.id, p);
    });
    this.loadJson("allowlist.json", (data: string[]) => {
      for (const id of data) this.allowlist.add(id);
    });
    this.loadJson("pairing.json", (data: PairingRequest[]) => {
      for (const r of data) this.pairings.set(r.code, r);
    });
    this.loadJson("sessions.json", (data: Record<string, string>) => {
      for (const [k, v] of Object.entries(data)) this.sessionMap.set(k, v);
    });
  }

  private loadJson<T>(filename: string, apply: (data: T) => void): void {
    const file = join(this.dir, filename);
    if (!existsSync(file)) return;
    try {
      const raw = readFileSync(file, "utf-8");
      apply(JSON.parse(raw) as T);
    } catch { /* corrupt file — start fresh */ }
  }

  private ensureDir(): void {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
  }

  private savePeers(): void {
    this.ensureDir();
    writeFileSync(join(this.dir, "peers.json"), JSON.stringify([...this.peers.values()], null, 2));
  }

  private saveAllowlist(): void {
    this.ensureDir();
    writeFileSync(join(this.dir, "allowlist.json"), JSON.stringify([...this.allowlist], null, 2));
  }

  private savePairings(): void {
    this.ensureDir();
    writeFileSync(join(this.dir, "pairing.json"), JSON.stringify([...this.pairings.values()], null, 2));
  }

  private saveSessions(): void {
    this.ensureDir();
    const obj: Record<string, string> = {};
    for (const [k, v] of this.sessionMap) obj[k] = v;
    writeFileSync(join(this.dir, "sessions.json"), JSON.stringify(obj, null, 2));
  }
}
