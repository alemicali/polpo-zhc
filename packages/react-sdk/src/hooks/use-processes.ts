import { useSyncExternalStore, useCallback, useEffect, useState } from "react";
import { usePolpoContext } from "../provider/polpo-context.js";
import { selectProcesses } from "@polpo-ai/sdk";
import type { AgentProcess } from "@polpo-ai/sdk";

export interface UseProcessesReturn {
  processes: AgentProcess[];
  isLoading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

export function useProcesses(): UseProcessesReturn {
  const { client, store } = usePolpoContext();

  const processes = useSyncExternalStore(
    store.subscribe,
    () => selectProcesses(store.getSnapshot()),
    () => selectProcesses(store.getServerSnapshot()),
  );

  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const refetch = useCallback(async () => {
    try {
      const p = await client.getProcesses();
      store.setProcesses(p);
    } catch (err) {
      setError(err as Error);
    }
  }, [client, store]);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    refetch().finally(() => {
      if (!cancelled) setIsLoading(false);
    });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { processes, isLoading, error, refetch };
}
