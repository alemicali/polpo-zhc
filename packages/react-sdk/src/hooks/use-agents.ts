import { useSyncExternalStore, useCallback, useEffect, useState } from "react";
import { usePolpoContext } from "../provider/polpo-context.js";
import { useMutation } from "./use-mutation.js";
import type { AgentConfig, Team, AddAgentRequest, UpdateAgentRequest, AddTeamRequest } from "@polpo-ai/sdk";

export interface UseAgentsReturn {
  agents: AgentConfig[];
  teams: Team[];
  isLoading: boolean;
  error: Error | null;
  addAgent: (req: AddAgentRequest, teamName?: string) => Promise<void>;
  isAddingAgent: boolean;
  updateAgent: (name: string, req: UpdateAgentRequest) => Promise<AgentConfig>;
  isUpdatingAgent: boolean;
  removeAgent: (name: string) => Promise<void>;
  isRemovingAgent: boolean;
  addTeam: (req: AddTeamRequest) => Promise<void>;
  isAddingTeam: boolean;
  removeTeam: (name: string) => Promise<void>;
  isRemovingTeam: boolean;
  renameTeam: (oldName: string, newName: string) => Promise<Team>;
  isRenamingTeam: boolean;
  refetch: () => Promise<void>;
  invalidate: () => Promise<void>;
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

  const { mutate: addAgent, isPending: isAddingAgent } = useMutation(
    useCallback(
      async (req: AddAgentRequest, teamName?: string) => {
        await client.addAgent(req, teamName);
        await fetchAll();
      },
      [client, fetchAll],
    ),
  );

  const { mutate: updateAgent, isPending: isUpdatingAgent } = useMutation(
    useCallback(
      async (name: string, req: UpdateAgentRequest) => {
        const updated = await client.updateAgent(name, req);
        await fetchAll();
        return updated;
      },
      [client, fetchAll],
    ),
  );

  const { mutate: removeAgent, isPending: isRemovingAgent } = useMutation(
    useCallback(
      async (name: string) => {
        await client.removeAgent(name);
        await fetchAll();
      },
      [client, fetchAll],
    ),
  );

  const { mutate: addTeam, isPending: isAddingTeam } = useMutation(
    useCallback(
      async (req: AddTeamRequest) => {
        await client.addTeam(req);
        await fetchAll();
      },
      [client, fetchAll],
    ),
  );

  const { mutate: removeTeam, isPending: isRemovingTeam } = useMutation(
    useCallback(
      async (name: string) => {
        await client.removeTeam(name);
        await fetchAll();
      },
      [client, fetchAll],
    ),
  );

  const { mutate: renameTeam, isPending: isRenamingTeam } = useMutation(
    useCallback(
      async (oldName: string, newName: string) => {
        const t = await client.renameTeam(oldName, newName);
        await fetchAll();
        return t;
      },
      [client, fetchAll],
    ),
  );

  return {
    agents,
    teams,
    isLoading,
    error,
    addAgent,
    isAddingAgent,
    updateAgent,
    isUpdatingAgent,
    removeAgent,
    isRemovingAgent,
    addTeam,
    isAddingTeam,
    removeTeam,
    isRemovingTeam,
    renameTeam,
    isRenamingTeam,
    refetch: fetchAll,
    invalidate: fetchAll,
  };
}
