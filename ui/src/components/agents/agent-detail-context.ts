/**
 * AgentDetail context — types, context object and consumer hook.
 * Kept separate from the provider component so Fast Refresh works.
 */

import { createContext, use } from "react";
import type {
  AgentConfig,
  AgentProcess,
  SkillInfo,
  Task,
  VaultEntryMeta,
} from "@polpo-ai/react";
import type { toolCategories } from "@/lib/agent-meta";

// ── Context interface ──

export interface TaskStats {
  done: number;
  failed: number;
  active: number;
  pending: number;
  total: number;
  successRate: number | null;
  avgScore: number | null;
}

export interface AgentDetailState {
  agent: AgentConfig;
  isLoading: boolean;
  isRefreshing: boolean;
  error: Error | null;
  /** Active process for this agent (if any) */
  process: AgentProcess | undefined;
  /** Agents that report to this one */
  subordinates: AgentConfig[];
  /** Manager agent (who this agent reports to) */
  manager: AgentConfig | null;
  /** Computed task statistics */
  taskStats: TaskStats;
  /** All tasks assigned to this agent, sorted (active first) */
  sortedTasks: Task[];
  /** Skill pool map (name -> info) */
  skillPool: Map<string, SkillInfo>;
  /** Vault entries for this agent */
  vaultEntries: VaultEntryMeta[];
  /** MCP server entries from agent config */
  mcpEntries: [string, unknown][];
  /** Flat list of allowed tool names */
  agentAllowedTools: string[];
  /** Tool categories that are enabled based on allowedTools */
  enabledCategories: typeof toolCategories;
  /** Team name this agent belongs to */
  teamName: string | null;
  /** Team color index (position in the teams array, for consistent colors) */
  teamColorIndex: number;
}

export interface AgentDetailActions {
  refetch: () => Promise<void>;
  refetchVault: () => Promise<void>;
}

export interface AgentDetailMeta {
  agentName: string;
}

export interface AgentDetailContextValue {
  state: AgentDetailState;
  actions: AgentDetailActions;
  meta: AgentDetailMeta;
}

// ── Context ──

export const AgentDetailContext = createContext<AgentDetailContextValue | null>(null);

/**
 * Hook to consume the AgentDetail context.
 * Must be used within an AgentDetailProvider.
 */
export function useAgentDetail(): AgentDetailContextValue {
  const ctx = use(AgentDetailContext);
  if (!ctx) throw new Error("useAgentDetail must be used within an AgentDetailProvider");
  return ctx;
}
