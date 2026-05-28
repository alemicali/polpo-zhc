import { useSyncExternalStore, useCallback, useEffect, useRef, useState } from "react";
import { usePolpoContext } from "../provider/polpo-context.js";
import { useMutation } from "./use-mutation.js";
import { readCached, writeCached } from "./use-swr-cache.js";
import type { AgentConfig, Team, AddAgentRequest, UpdateAgentRequest, AddTeamRequest } from "@polpo-ai/sdk";

export interface UseAgentsReturn {
  agents: AgentConfig[];
  teams: Team[];
  isLoading: boolean;
  isRefreshing: boolean;
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

  // SWR hydrate — agents/teams are touched by almost every page (avatars,
  // assignTo dropdowns), so a stale-paint here removes a 200-400ms gap
  // before the page can render its team-related chrome. Done BEFORE the
  // useSyncExternalStore calls so the first render already sees cached data.
  const hydratedRef = useRef(false);
  if (!hydratedRef.current) {
    const snap = store.getSnapshot();
    if (snap.agents.length === 0 && snap.teams.length === 0) {
      const cachedAgents = readCached<AgentConfig[]>("agents");
      const cachedTeams = readCached<Team[]>("teams");
      if (cachedAgents?.data && cachedAgents.data.length > 0) {
        store.setAgents(cachedAgents.data);
      }
      if (cachedTeams?.data && cachedTeams.data.length > 0) {
        store.setTeams(cachedTeams.data);
      }
    }
    hydratedRef.current = true;
  }

  const agents = useSyncExternalStore(
    store.subscribe,
    () => store.getSnapshot().agents,
    () => store.getServerSnapshot().agents,
  );

  const teams = useSyncExternalStore(
    store.subscribe,
    () => store.getSnapshot().teams,
    () => store.getServerSnapshot().teams,
  );

  const [isLoading, setIsLoading] = useState(agents.length === 0 && teams.length === 0);
  const [isRefreshing, setIsRefreshing] = useState(agents.length > 0 || teams.length > 0);
  const [error, setError] = useState<Error | null>(null);

  const fetchAll = useCallback(async () => {
    try {
      const [a, t] = await Promise.all([client.getAgents(), client.getTeams()]);
      store.setAgents(a);
      store.setTeams(t);
      writeCached("agents", a);
      writeCached("teams", t);
    } catch (err) {
      setError(err as Error);
    }
  }, [client, store]);

  useEffect(() => {
    const hasStale = agents.length > 0 || teams.length > 0;
    if (hasStale) setIsRefreshing(true);
    else setIsLoading(true);
    fetchAll().finally(() => {
      setIsLoading(false);
      setIsRefreshing(false);
    });
    // Initial-mount staleness check only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    isRefreshing,
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
