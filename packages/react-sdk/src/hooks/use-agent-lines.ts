import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { usePolpoContext } from "../provider/polpo-context.js";
import type { AgentLinesChart } from "@polpo-ai/sdk";

export interface UseAgentLinesReturn {
  /** Every agent's communication lines and the edges between agents (undefined while loading). */
  chart: AgentLinesChart | undefined;
  isLoading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

/**
 * The org chart's communication lines (GET /agents/lines): who may talk to whom. Fetched again
 * whenever the team changes (an agent's lines, manager or membership).
 */
export function useAgentLines(): UseAgentLinesReturn {
  const { client, store } = usePolpoContext();
  const agents = useSyncExternalStore(store.subscribe, () => store.getSnapshot().agents, () => store.getSnapshot().agents);
  const [state, setState] = useState<{ chart?: AgentLinesChart; error: Error | null; loaded: boolean }>({ error: null, loaded: false });

  const fetchLines = useCallback(async () => {
    try {
      setState({ chart: await client.getAgentLines(), error: null, loaded: true });
    } catch (err) {
      setState((prev) => ({ ...prev, error: err as Error, loaded: true }));
    }
  }, [client]);

  useEffect(() => { void fetchLines(); }, [fetchLines, agents]);

  return { chart: state.chart, isLoading: !state.loaded, error: state.error, refetch: fetchLines };
}
