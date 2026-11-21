/**
 * Computers for the Computers page and the agent's Sandbox tab: the list with live status, kept
 * fresh by `computer:changed` over the app's single SSE stream (status changes come from the
 * cached state, without asking the providers again).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useEvents } from "@polpo-ai/react";
import { computersApi, type Computer } from "@/lib/computers-api";

const COMPUTER_EVENTS = ["computer:changed"];

export interface UseComputersReturn {
  computers: Computer[];
  loading: boolean;
  error: string | null;
  /** live: ask the providers (slower); otherwise the last known status. */
  refresh: (live?: boolean) => Promise<void>;
  /** Put a computer returned by a mutation in the list right away. */
  upsert: (computer: Computer) => void;
  drop: (id: string) => void;
}

export function useComputers({ live = true }: { live?: boolean } = {}): UseComputersReturn {
  const [computers, setComputers] = useState<Computer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const refresh = useCallback(async (live = true) => {
    try {
      const list = await computersApi.list(live);
      if (!mounted.current) return;
      setComputers(list);
      setError(null);
    } catch (reason) {
      if (mounted.current) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(live); }, [refresh, live]);

  // Live: a computer:changed after mount refreshes the list from the cached state.
  const { events } = useEvents(COMPUTER_EVENTS, 20);
  const latest = events.at(-1);
  const handled = useRef(latest?.id);
  useEffect(() => {
    if (!latest || handled.current === latest.id) return;
    handled.current = latest.id;
    void refresh(false);
  }, [latest, refresh]);

  const upsert = useCallback((computer: Computer) => {
    setComputers((list) => {
      const i = list.findIndex((c) => c.id === computer.id);
      if (i < 0) return [...list, computer];
      const next = [...list];
      next[i] = computer;
      return next;
    });
  }, []);

  const drop = useCallback((id: string) => setComputers((list) => list.filter((c) => c.id !== id)), []);

  return { computers, loading, error, refresh, upsert, drop };
}
