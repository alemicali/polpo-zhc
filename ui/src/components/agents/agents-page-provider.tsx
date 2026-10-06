/**
 * AgentsPageProvider — context + data fetching for the Agents listing page.
 *
 * Follows the Vercel composition pattern: the provider is the ONLY place
 * that knows how state is managed. UI components consume the context
 * interface (state, actions, meta) — they don't know which hooks produce
 * the data.
 */

import { useState, useMemo, useCallback } from "react";
import { useAgents, useProcesses } from "@polpo-ai/react";
import { useAsyncAction } from "@/hooks/use-polpo";
import { AgentsPageContext } from "./agents-page-context";
import type { AgentsPageContextValue, ViewMode } from "./agents-page-context";

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
