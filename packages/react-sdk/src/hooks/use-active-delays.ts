import { useSyncExternalStore, useState, useEffect, useCallback } from "react";
import { usePolpoContext } from "../provider/polpo-context.js";
import type { ActiveDelay } from "@polpo-ai/client";

export interface UseActiveDelaysReturn {
  /** Active delays from SSE events (live, updated by delay:started/delay:expired). */
  activeDelays: ActiveDelay[];
  /** Active delays fetched from the server (initial load). */
  fetchedDelays: ActiveDelay[];
  /** Refetch from server. */
  refetch: () => void;
  loading: boolean;
}

/**
 * Hook for accessing active delay timers.
 *
 * Combines two sources:
 * 1. SSE events (delay:started / delay:expired) → store.activeDelays (real-time)
 * 2. Initial fetch from GET /missions/delays (catches delays that started before SSE connected)
 */
export function useActiveDelays(): UseActiveDelaysReturn {
  const { client, store } = usePolpoContext();

  // Real-time from store (fed by SSE events via event-reducer)
  const storeDelays = useSyncExternalStore(
    store.subscribe,
    () => store.getSnapshot().activeDelays,
    () => store.getServerSnapshot().activeDelays,
  );

  const [fetchedDelays, setFetchedDelays] = useState<ActiveDelay[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchCount, setFetchCount] = useState(0);

  const refetch = useCallback(() => setFetchCount(c => c + 1), []);

  useEffect(() => {
    setLoading(true);
    client.listDelays()
      .then((delays) => {
        setFetchedDelays(delays);
        // Also seed the store so SSE events can update from here
        for (const d of delays) {
          store.getSnapshot().activeDelays.set(`${d.group}:${d.delayName}`, d);
        }
      })
      .catch(() => { /* best-effort */ })
      .finally(() => setLoading(false));
  }, [client, store, fetchCount]);

  // Merge: store has real-time data, fetched fills in pre-existing delays
  const activeDelays = Array.from(storeDelays.values());

  return { activeDelays, fetchedDelays, refetch, loading };
}
