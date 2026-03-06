import { useSyncExternalStore, useCallback, useEffect, useState } from "react";
import { usePolpoContext } from "../provider/polpo-context.js";
import { selectProcesses } from "@lumea-labs/polpo-client";
import type { AgentProcess } from "@lumea-labs/polpo-client";

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
    setIsLoading(true);
    refetch().finally(() => setIsLoading(false));
  }, [refetch]);

  return { processes, isLoading, error, refetch };
}
