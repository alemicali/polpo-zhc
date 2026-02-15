import { useSyncExternalStore, useCallback, useEffect, useState } from "react";
import { usePolpoContext } from "../provider/polpo-context.js";

export interface UseMemoryReturn {
  memory: { exists: boolean; content: string } | null;
  isLoading: boolean;
  error: Error | null;
  saveMemory: (content: string) => Promise<void>;
  refetch: () => Promise<void>;
}

export function useMemory(): UseMemoryReturn {
  const { client, store } = usePolpoContext();

  const memory = useSyncExternalStore(
    store.subscribe,
    () => store.getSnapshot().memory,
    () => null,
  );

  const [isLoading, setIsLoading] = useState(!memory);
  const [error, setError] = useState<Error | null>(null);

  const refetch = useCallback(async () => {
    try {
      const m = await client.getMemory();
      store.setMemory(m);
    } catch (err) {
      setError(err as Error);
    }
  }, [client, store]);

  useEffect(() => {
    if (memory) { setIsLoading(false); return; }
    setIsLoading(true);
    refetch().finally(() => setIsLoading(false));
  }, [refetch, !!memory]);

  const saveMemory = useCallback(async (content: string) => {
    await client.saveMemory(content);
    store.setMemory({ exists: true, content });
  }, [client, store]);

  return { memory, isLoading, error, saveMemory, refetch };
}
