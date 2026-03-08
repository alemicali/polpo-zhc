/**
 * AgentDetailProvider — context + data fetching + derived state.
 *
 * Follows the Vercel composition pattern: the provider is the ONLY place
 * that knows how state is managed. UI components consume the context
 * interface (state, actions, meta) — they don't know which hooks produce
 * the data.
 */

import { createContext, use, useMemo } from "react";
import { useParams } from "react-router-dom";
import {
  useAgent,
  useAgents,
  useProcesses,
  useSkills,
  useTasks,
  useVaultEntries,
} from "@lumea-technologies/polpo-react";
import type {
  AgentConfig,
  AgentProcess,
  SkillInfo,
  Task,
  VaultEntryMeta,
} from "@lumea-technologies/polpo-react";
import { taskStatusOrder } from "@/lib/agent-meta";
import { toolCategories } from "@/lib/agent-meta";

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
  refetch: () => void;
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

// ── Provider ──

export function AgentDetailProvider({ children }: { children: React.ReactNode }) {
  const { name } = useParams<{ name: string }>();
  const agentName = name ?? "";

  const { agent, isLoading, error, refetch } = useAgent(agentName);
  const { agents, teams } = useAgents();
  const { processes } = useProcesses();
  const { skills: allSkills } = useSkills();
  const { entries: vaultEntries } = useVaultEntries(agentName);
  const { tasks: agentTasks } = useTasks({ assignTo: agentName });

  // Skill pool map
  const skillPool = useMemo(() => {
    const map = new Map<string, SkillInfo>();
    for (const s of allSkills) map.set(s.name, s);
    return map;
  }, [allSkills]);

  // Active process
  const process = processes.find((p: AgentProcess) => p.agentName === agentName);

  // Subordinates
  const subordinates = useMemo(
    () => agents.filter((a: AgentConfig) => a.reportsTo === agentName),
    [agents, agentName],
  );

  // Manager
  const manager = useMemo(
    () => agent?.reportsTo ? agents.find((a: AgentConfig) => a.name === agent.reportsTo) ?? null : null,
    [agents, agent],
  );

  // Task stats
  const taskStats = useMemo<TaskStats>(() => {
    const done = agentTasks.filter((t: Task) => t.status === "done").length;
    const failed = agentTasks.filter((t: Task) => t.status === "failed").length;
    const active = agentTasks.filter((t: Task) => t.status === "in_progress" || t.status === "review" || t.status === "assigned").length;
    const pending = agentTasks.filter((t: Task) => t.status === "pending" || t.status === "awaiting_approval" || t.status === "draft").length;
    const total = agentTasks.length;
    const successRate = done + failed > 0 ? Math.round((done / (done + failed)) * 100) : null;
    const avgScoreAcc = agentTasks
      .filter((t: Task) => t.result?.assessment?.globalScore != null)
      .reduce((acc: { sum: number; count: number }, t: Task) => ({
        sum: acc.sum + (t.result!.assessment!.globalScore ?? 0),
        count: acc.count + 1,
      }), { sum: 0, count: 0 });
    return {
      done,
      failed,
      active,
      pending,
      total,
      successRate,
      avgScore: avgScoreAcc.count > 0 ? avgScoreAcc.sum / avgScoreAcc.count : null,
    };
  }, [agentTasks]);

  // Sorted tasks
  const sortedTasks = useMemo(() =>
    [...agentTasks].sort((a, b) => {
      const oa = taskStatusOrder[a.status] ?? 10;
      const ob = taskStatusOrder[b.status] ?? 10;
      if (oa !== ob) return oa - ob;
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    }),
    [agentTasks],
  );

  // Team membership
  const teamInfo = useMemo(() => {
    for (let i = 0; i < teams.length; i++) {
      if (teams[i].agents.some((a: AgentConfig) => a.name === agentName)) {
        return { teamName: teams[i].name, teamColorIndex: i };
      }
    }
    return { teamName: null as string | null, teamColorIndex: 0 };
  }, [teams, agentName]);

  // MCP entries
  const mcpEntries = agent?.mcpServers ? Object.entries(agent.mcpServers) : [];

  // Allowed tools
  const agentAllowedTools: string[] = (agent as unknown as Record<string, unknown>)?.allowedTools as string[] ?? [];
  const enabledCategories = toolCategories.filter(c => agentAllowedTools.some(t => t.toLowerCase().startsWith(c.prefix)));

  const contextValue = useMemo<AgentDetailContextValue>(() => ({
    state: {
      agent: agent!,
      isLoading,
      error: error ?? null,
      process,
      subordinates,
      manager,
      taskStats,
      sortedTasks,
      skillPool,
      vaultEntries,
      mcpEntries,
      agentAllowedTools,
      enabledCategories,
      teamName: teamInfo.teamName,
      teamColorIndex: teamInfo.teamColorIndex,
    },
    actions: { refetch },
    meta: { agentName },
  }), [
    agent, isLoading, error, process, subordinates, manager,
    taskStats, sortedTasks, skillPool, vaultEntries, mcpEntries,
    agentAllowedTools, enabledCategories, teamInfo, refetch, agentName,
  ]);

  return (
    <AgentDetailContext value={contextValue}>
      {children}
    </AgentDetailContext>
  );
}
