import { useSyncExternalStore, useCallback, useEffect, useState } from "react";
import { usePolpoContext } from "../provider/polpo-context.js";
import type { AgentConfig, Team, AddAgentRequest } from "../client/types.js";

export interface UseAgentsReturn {
  agents: AgentConfig[];
  team: Team | null;
  isLoading: boolean;
  error: Error | null;
  addAgent: (req: AddAgentRequest) => Promise<void>;
  removeAgent: (name: string) => Promise<void>;
  renameTeam: (name: string) => Promise<Team>;
  refetch: () => Promise<void>;
}

export function useAgents(): UseAgentsReturn {
  const { client, store } = usePolpoContext();

  const agents = useSyncExternalStore(
    store.subscribe,
    () => store.getSnapshot().agents,
    () => store.getServerSnapshot().agents,
  );

  const [team, setTeam] = useState<Team | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const fetchAll = useCallback(async () => {
    try {
      const [a, t] = await Promise.all([client.getAgents(), client.getTeam()]);
      store.setAgents(a);
      setTeam(t);
    } catch (err) {
      setError(err as Error);
    }
  }, [client, store]);

  useEffect(() => {
    setIsLoading(true);
    fetchAll().finally(() => setIsLoading(false));
  }, [fetchAll]);

  const addAgent = useCallback(async (req: AddAgentRequest) => {
    await client.addAgent(req);
    await fetchAll();
  }, [client, fetchAll]);

  const removeAgent = useCallback(async (name: string) => {
    await client.removeAgent(name);
    await fetchAll();
  }, [client, fetchAll]);

  const renameTeam = useCallback(async (name: string) => {
    const t = await client.renameTeam(name);
    setTeam(t);
    return t;
  }, [client]);

  return { agents, team, isLoading, error, addAgent, removeAgent, renameTeam, refetch: fetchAll };
}
