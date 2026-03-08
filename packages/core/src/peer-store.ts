/**
 * Peer identity store interface.
 * Pure contract — implementation (FilePeerStore) lives in the shell layer.
 */

import type {
  PeerIdentity,
  PairingRequest,
  ChannelType,
  ChannelGatewayConfig,
  PresenceEntry,
} from "./types.js";

export interface PeerStore {
  // Peer identity
  getPeer(peerId: string): PeerIdentity | undefined;
  upsertPeer(peer: Omit<PeerIdentity, "id" | "firstSeenAt"> & { id?: string }): PeerIdentity;
  listPeers(channel?: ChannelType): PeerIdentity[];

  // Authorization
  isAllowed(peerId: string, channelConfig?: ChannelGatewayConfig): boolean;
  addToAllowlist(peerId: string): void;
  removeFromAllowlist(peerId: string): void;
  getAllowlist(): string[];

  // Pairing
  createPairingRequest(channel: ChannelType, externalId: string, displayName?: string): PairingRequest;
  resolvePairing(code: string): PairingRequest | undefined;
  getPendingPairing(peerId: string): PairingRequest | undefined;
  cleanExpiredPairings(): number;

  // Session mapping (peerId → sessionId)
  getSessionId(peerId: string): string | undefined;
  setSessionId(peerId: string, sessionId: string): void;
  clearSession(peerId: string): void;

  // Identity linking
  linkPeers(peerId: string, linkedTo: string): void;
  resolveCanonicalId(peerId: string): string;

  // Presence (in-memory, ephemeral)
  updatePresence(peerId: string, activity: PresenceEntry["activity"]): void;
  getPresence(): PresenceEntry[];
  prunePresence(ttlMs?: number): number;
}
