/**
 * AgentsPage context — types, context object and consumer hook.
 * Kept separate from the provider component so Fast Refresh works.
 */

import { createContext, use } from "react";
import type { AgentConfig, AgentProcess, Team } from "@polpo-ai/react";

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
