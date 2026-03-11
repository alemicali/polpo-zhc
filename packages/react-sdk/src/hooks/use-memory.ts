import { useSyncExternalStore, useCallback, useEffect, useState } from "react";
import { usePolpoContext } from "../provider/polpo-context.js";

export interface UseMemoryReturn {
  memory: { exists: boolean; content: string } | null;
  isLoading: boolean;
  error: Error | null;
  saveMemory: (content: string) => Promise<void>;
  refetch: () => Promise<void>;
}

/**
 * Hook for shared memory (no agent scope).
 */
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

export interface UseAgentMemoryReturn {
  memory: { exists: boolean; content: string } | null;
  isLoading: boolean;
  error: Error | null;
  saveMemory: (content: string) => Promise<void>;
  refetch: () => Promise<void>;
}

/**
 * Hook for agent-specific memory.
 * @param agentName The agent whose private memory to access.
 */
export function useAgentMemory(agentName: string): UseAgentMemoryReturn {
  const { client, store } = usePolpoContext();

  const memory = useSyncExternalStore(
    store.subscribe,
    () => store.getSnapshot().agentMemory.get(agentName) ?? null,
    () => null,
  );

  const [isLoading, setIsLoading] = useState(!memory);
  const [error, setError] = useState<Error | null>(null);

  const refetch = useCallback(async () => {
    try {
      const m = await client.getAgentMemory(agentName);
      store.setAgentMemory(agentName, m);
    } catch (err) {
      setError(err as Error);
    }
  }, [client, store, agentName]);

  useEffect(() => {
    if (memory) { setIsLoading(false); return; }
    setIsLoading(true);
    refetch().finally(() => setIsLoading(false));
  }, [refetch, !!memory]);

  const saveMemory = useCallback(async (content: string) => {
    await client.saveAgentMemory(agentName, content);
    store.setAgentMemory(agentName, { exists: true, content });
  }, [client, store, agentName]);

  return { memory, isLoading, error, saveMemory, refetch };
}
