import { useSyncExternalStore, useCallback, useEffect, useState } from "react";
import { usePolpoContext } from "../provider/polpo-context.js";
import type { AgentConfig, Team, AddAgentRequest, AddTeamRequest } from "../client/types.js";

export interface UseAgentsReturn {
  agents: AgentConfig[];
  teams: Team[];
  isLoading: boolean;
  error: Error | null;
  addAgent: (req: AddAgentRequest, teamName?: string) => Promise<void>;
  removeAgent: (name: string) => Promise<void>;
  addTeam: (req: AddTeamRequest) => Promise<void>;
  removeTeam: (name: string) => Promise<void>;
  renameTeam: (oldName: string, newName: string) => Promise<Team>;
  refetch: () => Promise<void>;
}

export function useAgents(): UseAgentsReturn {
  const { client, store } = usePolpoContext();

  const agents = useSyncExternalStore(
    store.subscribe,
    () => store.getSnapshot().agents,
    () => store.getServerSnapshot().agents,
  );

  const [teams, setTeams] = useState<Team[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const fetchAll = useCallback(async () => {
    try {
      const [a, t] = await Promise.all([client.getAgents(), client.getTeams()]);
      store.setAgents(a);
      setTeams(t);
    } catch (err) {
      setError(err as Error);
    }
  }, [client, store]);

  useEffect(() => {
    setIsLoading(true);
    fetchAll().finally(() => setIsLoading(false));
  }, [fetchAll]);

  const addAgent = useCallback(async (req: AddAgentRequest, teamName?: string) => {
    await client.addAgent(req, teamName);
    await fetchAll();
  }, [client, fetchAll]);

  const removeAgent = useCallback(async (name: string) => {
    await client.removeAgent(name);
    await fetchAll();
  }, [client, fetchAll]);

  const addTeam = useCallback(async (req: AddTeamRequest) => {
    await client.addTeam(req);
    await fetchAll();
  }, [client, fetchAll]);

  const removeTeam = useCallback(async (name: string) => {
    await client.removeTeam(name);
    await fetchAll();
  }, [client, fetchAll]);

  const renameTeam = useCallback(async (oldName: string, newName: string) => {
    const t = await client.renameTeam(oldName, newName);
    await fetchAll();
    return t;
  }, [client, fetchAll]);

  return { agents, teams, isLoading, error, addAgent, removeAgent, addTeam, removeTeam, renameTeam, refetch: fetchAll };
}
