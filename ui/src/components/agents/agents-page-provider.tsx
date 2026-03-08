/**
 * AgentsPageProvider — context + data fetching for the Agents listing page.
 *
 * Follows the Vercel composition pattern: the provider is the ONLY place
 * that knows how state is managed. UI components consume the context
 * interface (state, actions, meta) — they don't know which hooks produce
 * the data.
 */

import { createContext, use, useState, useMemo, useCallback } from "react";
import { useAgents, useProcesses } from "@lumea-technologies/polpo-react";
import type { AgentConfig, AgentProcess, Team } from "@lumea-technologies/polpo-react";
import { useAsyncAction } from "@/hooks/use-polpo";

// ── View types ──

export type ViewMode = "list" | "chart";

// ── Context interface ──

export interface AgentsPageState {
  teams: Team[];
  agents: AgentConfig[];
  processes: AgentProcess[];
  search: string;
  view: ViewMode;
  isLoading: boolean;
  isRefreshing: boolean;
}

export interface AgentsPageActions {
  setSearch: (q: string) => void;
  setView: (v: ViewMode) => void;
  addAgent: (req: { name: string; role?: string; model?: string }, teamName?: string) => Promise<void>;
  removeAgent: (name: string) => Promise<void>;
  addTeam: (req: { name: string; description?: string }) => Promise<void>;
  removeTeam: (name: string) => Promise<void>;
  renameTeam: (oldName: string, newName: string) => Promise<void>;
  refetch: () => void;
  handleRefresh: () => void;
}

export interface AgentsPageMeta {
  /** Agents filtered by the current search query */
  filteredAgents: AgentConfig[];
}

export interface AgentsPageContextValue {
  state: AgentsPageState;
  actions: AgentsPageActions;
  meta: AgentsPageMeta;
}

// ── Context ──

export const AgentsPageContext = createContext<AgentsPageContextValue | null>(null);

/**
 * Hook to consume the AgentsPage context.
 * Must be used within an AgentsPageProvider.
 */
export function useAgentsPage(): AgentsPageContextValue {
  const ctx = use(AgentsPageContext);
  if (!ctx) throw new Error("useAgentsPage must be used within an AgentsPageProvider");
  return ctx;
}

// ── Provider ──

export function AgentsPageProvider({ children }: { children: React.ReactNode }) {
  const {
    agents,
    teams,
    isLoading,
    refetch,
    addAgent,
    removeAgent,
    addTeam,
    removeTeam,
    renameTeam,
  } = useAgents();
  const { processes } = useProcesses();

  const [search, setSearch] = useState("");
  const [view, setView] = useState<ViewMode>("list");

  const [handleRefresh, isRefreshing] = useAsyncAction(async () => {
    await refetch();
  });

  const handleAddAgent = useCallback(
    async (req: { name: string; role?: string; model?: string }, teamName?: string) => {
      await addAgent(req, teamName);
    },
    [addAgent],
  );

  const handleRemoveAgent = useCallback(
    async (name: string) => {
      await removeAgent(name);
    },
    [removeAgent],
  );

  const handleAddTeam = useCallback(
    async (req: { name: string; description?: string }) => {
      await addTeam(req);
    },
    [addTeam],
  );

  const handleRemoveTeam = useCallback(
    async (name: string) => {
      await removeTeam(name);
    },
    [removeTeam],
  );

  const handleRenameTeam = useCallback(
    async (oldName: string, newName: string) => {
      await renameTeam(oldName, newName);
    },
    [renameTeam],
  );

  // Filtered agents
  const filteredAgents = useMemo(() => {
    if (!search) return agents;
    const q = search.toLowerCase();
    return agents.filter(
      (a) =>
        a.name.toLowerCase().includes(q) ||
        (a.role ?? "").toLowerCase().includes(q) ||
        (a.model ?? "").toLowerCase().includes(q) ||
        (a.identity?.displayName ?? "").toLowerCase().includes(q) ||
        (a.missionGroup ?? "").toLowerCase().includes(q),
    );
  }, [agents, search]);

  const contextValue = useMemo<AgentsPageContextValue>(
    () => ({
      state: {
        teams,
        agents,
        processes,
        search,
        view,
        isLoading,
        isRefreshing,
      },
      actions: {
        setSearch,
        setView,
        addAgent: handleAddAgent,
        removeAgent: handleRemoveAgent,
        addTeam: handleAddTeam,
        removeTeam: handleRemoveTeam,
        renameTeam: handleRenameTeam,
        refetch,
        handleRefresh,
      },
      meta: {
        filteredAgents,
      },
    }),
    [
      teams, agents, processes, search, view, isLoading, isRefreshing,
      handleAddAgent, handleRemoveAgent, handleAddTeam, handleRemoveTeam,
      handleRenameTeam, refetch, handleRefresh, filteredAgents,
      setSearch, setView,
    ],
  );

  return (
    <AgentsPageContext value={contextValue}>
      {children}
    </AgentsPageContext>
  );
}
