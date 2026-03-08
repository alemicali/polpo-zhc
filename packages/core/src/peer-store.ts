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
  getPeer(peerId: string): Promise<PeerIdentity | undefined>;
  upsertPeer(peer: Omit<PeerIdentity, "id" | "firstSeenAt"> & { id?: string }): Promise<PeerIdentity>;
  listPeers(channel?: ChannelType): Promise<PeerIdentity[]>;

  // Authorization
  isAllowed(peerId: string, channelConfig?: ChannelGatewayConfig): Promise<boolean>;
  addToAllowlist(peerId: string): Promise<void>;
  removeFromAllowlist(peerId: string): Promise<void>;
  getAllowlist(): Promise<string[]>;

  // Pairing
  createPairingRequest(channel: ChannelType, externalId: string, displayName?: string): Promise<PairingRequest>;
  resolvePairing(code: string): Promise<PairingRequest | undefined>;
  getPendingPairing(peerId: string): Promise<PairingRequest | undefined>;
  cleanExpiredPairings(): Promise<number>;

  // Session mapping (peerId → sessionId)
  getSessionId(peerId: string): Promise<string | undefined>;
  setSessionId(peerId: string, sessionId: string): Promise<void>;
  clearSession(peerId: string): Promise<void>;

  // Identity linking
  linkPeers(peerId: string, linkedTo: string): Promise<void>;
  resolveCanonicalId(peerId: string): Promise<string>;

  // Presence (in-memory, ephemeral)
  updatePresence(peerId: string, activity: PresenceEntry["activity"]): Promise<void>;
  getPresence(): Promise<PresenceEntry[]>;
  prunePresence(ttlMs?: number): Promise<number>;
}
