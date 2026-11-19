/**
 * State of the Agent conversations page: the pairs' conversations and the recent exchanges,
 * kept live from `agent:message` events on the app's single SSE connection (useEvents — no
 * second EventSource). A status update reuses the exchange id, so events merge by id.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useEvents } from "@polpo-ai/react";
import {
  agentTalkApi,
  isAgentExchange,
  mergeExchanges,
  mergePairs,
  type AgentExchange,
  type AgentPair,
} from "@/lib/agent-talk-api";

type SSEEvent = ReturnType<typeof useEvents>["events"][number];

const AGENT_TALK_EVENTS = ["agent:message"];

export interface AgentTalkState {
  pairs: AgentPair[];
  recent: AgentExchange[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  /** Per pair session: bumped when an exchange in it is answered or fails (refresh the transcript). */
  settled: Record<string, number>;
}

export function useAgentTalk(): AgentTalkState {
  const [pairs, setPairs] = useState<AgentPair[]>([]);
  const [recent, setRecent] = useState<AgentExchange[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [settled, setSettled] = useState<Record<string, number>>({});

  const refresh = useCallback(async () => {
    try {
      const data = await agentTalkApi.overview();
      // Live copies received meanwhile are at least as new as the fetched ones.
      setRecent((current) => mergeExchanges(data.recent, current));
      setPairs((current) => {
        const known = new Set(data.conversations.map((p) => p.sessionId));
        return [...data.conversations, ...current.filter((p) => !known.has(p.sessionId))];
      });
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  // Only events that arrive after mount: the fetch covers the backlog.
  const { events } = useEvents(AGENT_TALK_EVENTS, 200);
  const lastRef = useRef<SSEEvent | undefined>(events.at(-1));
  useEffect(() => {
    const latest = events.at(-1);
    if (!latest || latest === lastRef.current) return;
    const previous = lastRef.current ? events.indexOf(lastRef.current) : -1;
    const added = events.slice(previous + 1);
    lastRef.current = latest;
    const exchanges = added.map((e) => e.data).filter(isAgentExchange);
    if (exchanges.length === 0) return;
    setRecent((current) => mergeExchanges(current, exchanges));
    setPairs((current) => exchanges.reduce(mergePairs, current));
    const done = exchanges.filter((x) => x.dmSessionId && x.status !== "working");
    if (done.length > 0) {
      setSettled((current) => {
        const next = { ...current };
        for (const x of done) next[x.dmSessionId!] = (next[x.dmSessionId!] ?? 0) + 1;
        return next;
      });
    }
  }, [events]);

  return { pairs, recent, loading, error, refresh, settled };
}
