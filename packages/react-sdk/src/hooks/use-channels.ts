import { useCallback, useEffect, useState } from "react";
import { usePolpoContext } from "../provider/polpo-context.js";
import type { ChannelPeer, PeerPresence, SlackSecretKind, SlackStatus } from "@polpo-ai/sdk";

export interface UseSlackStatusReturn {
  /** Every Slack channel (or only `channel`). */
  channels: SlackStatus[];
  status: SlackStatus | undefined;
  isLoading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
  /** Store the app's tokens in the vault (only the ones given change); the connection restarts. */
  setSecrets: (secrets: Partial<Record<SlackSecretKind, string>>, channel?: string) => Promise<void>;
  removeSecret: (kind: SlackSecretKind, channel?: string) => Promise<void>;
  /** auth.test with the bot token. */
  test: (channel?: string) => Promise<boolean>;
}

/**
 * Slack channels' inbound connection (Socket Mode): which tokens are set (never their values), the
 * state, the bot and the workspace. Polled every `pollMs` (default 10 s) while mounted.
 */
export function useSlackStatus(channel?: string, pollMs = 10_000): UseSlackStatusReturn {
  const { client } = usePolpoContext();
  const [channels, setChannels] = useState<SlackStatus[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const refetch = useCallback(async () => {
    try {
      setChannels(channel ? [await client.getSlackStatus(channel)] : await client.getSlackChannels());
      setError(null);
    } catch (err) {
      setError(err as Error);
    }
  }, [client, channel]);
  useEffect(() => {
    setIsLoading(true);
    refetch().finally(() => setIsLoading(false));
    if (!pollMs) return;
    const timer = setInterval(() => { void refetch(); }, pollMs);
    return () => clearInterval(timer);
  }, [refetch, pollMs]);
  const target = (c?: string) => {
    const name = c ?? channel;
    if (!name) throw new Error("Say which Slack channel");
    return name;
  };
  const setSecrets = useCallback(async (secrets: Partial<Record<SlackSecretKind, string>>, c?: string) => {
    await client.setSlackSecrets(target(c), secrets);
    await refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, channel, refetch]);
  const removeSecret = useCallback(async (kind: SlackSecretKind, c?: string) => {
    await client.removeSlackSecret(target(c), kind);
    await refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, channel, refetch]);
  const test = useCallback(async (c?: string) => {
    const r = await client.testSlack(target(c));
    await refetch();
    return r.ok;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, channel, refetch]);
  return { channels, status: channels[0], isLoading, error, refetch, setSecrets, removeSecret, test };
}

export interface UsePeersReturn {
  peers: ChannelPeer[];
  /** Who is active on the channels right now (by peer id). */
  presence: Record<string, PeerPresence>;
  isLoading: boolean;
  /** The channel gateway is not running (no channel takes messages). */
  unavailable: boolean;
  refetch: () => Promise<void>;
  /** Link a peer to another identity of the same person (shared sessions); null unlinks. */
  link: (peerId: string, linkedTo: string | null) => Promise<void>;
}

/** The people the channels know (optionally of one channel type), their presence, and linking identities. Polled every `pollMs`. */
export function usePeers(channel?: string, pollMs = 15_000): UsePeersReturn {
  const { client } = usePolpoContext();
  const [peers, setPeers] = useState<ChannelPeer[]>([]);
  const [presence, setPresence] = useState<Record<string, PeerPresence>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const refetch = useCallback(async () => {
    try {
      const [list, active] = await Promise.all([client.getPeers(channel), client.getPeerPresence()]);
      setPeers(list);
      setPresence(Object.fromEntries(active.map((p) => [p.peerId, p])));
      setUnavailable(false);
    } catch {
      setUnavailable(true);
    }
  }, [client, channel]);
  useEffect(() => {
    setIsLoading(true);
    refetch().finally(() => setIsLoading(false));
    if (!pollMs) return;
    const timer = setInterval(() => { void refetch(); }, pollMs);
    return () => clearInterval(timer);
  }, [refetch, pollMs]);
  const link = useCallback(async (peerId: string, linkedTo: string | null) => {
    await client.linkPeers(peerId, linkedTo);
    await refetch();
  }, [client, refetch]);
  return { peers, presence, isLoading, unavailable, refetch, link };
}
