/**
 * AgentDetailProvider — context + data fetching + derived state.
 *
 * Follows the Vercel composition pattern: the provider is the ONLY place
 * that knows how state is managed. UI components consume the context
 * interface (state, actions, meta) — they don't know which hooks produce
 * the data.
 */

import { useMemo } from "react";
import { useParams } from "react-router-dom";
import {
  useAgent,
  useAgents,
  useProcesses,
  useSkills,
  useTasks,
  useVaultEntries,
} from "@polpo-ai/react";
import type {
  AgentConfig,
  AgentProcess,
  SkillInfo,
  Task,
} from "@polpo-ai/react";
import { taskStatusOrder } from "@/lib/agent-meta";
import { toolCategories } from "@/lib/agent-meta";
import { useAsyncAction } from "@/hooks/use-polpo";
import { AgentDetailContext } from "./agent-detail-context";
import type { AgentDetailContextValue, TaskStats } from "./agent-detail-context";

// ── Provider ──

export function AgentDetailProvider({ children }: { children: React.ReactNode }) {
  const { name } = useParams<{ name: string }>();
  const agentName = name ?? "";

  const { agent, isLoading, error, refetch: refetchAgent } = useAgent(agentName);
  const { agents, teams, refetch: refetchAgents } = useAgents();
  const { processes, refetch: refetchProcesses } = useProcesses();
  const { skills: allSkills, refetch: refetchSkills } = useSkills();
  const { entries: vaultEntries, refetch: refetchVault } = useVaultEntries(agentName);
  const { tasks: agentTasks, refetch: refetchTasks } = useTasks({ assignTo: agentName });

  const [refetch, isRefreshing] = useAsyncAction(async () => {
    await Promise.all([
      refetchAgent(),
      refetchAgents(),
      refetchProcesses(),
      refetchSkills(),
      refetchVault(),
      refetchTasks(),
    ]);
  });

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
    const idx = teams.findIndex((t) => t.agents.some((a: AgentConfig) => a.name === agentName));
    const teamName: string | null = idx >= 0 ? teams[idx].name : null;
    return { teamName, teamColorIndex: idx >= 0 ? idx : 0 };
  }, [teams, agentName]);

  // MCP entries
  const mcpEntries = useMemo<[string, unknown][]>(
    () => (agent?.mcpServers ? Object.entries(agent.mcpServers) : []),
    [agent],
  );

  // Allowed tools
  const agentAllowedTools = useMemo<string[]>(
    () => ((agent as unknown as Record<string, unknown> | undefined)?.allowedTools as string[] | undefined) ?? [],
    [agent],
  );
  const enabledCategories = useMemo(
    () => toolCategories.filter(c => agentAllowedTools.some(t => t.toLowerCase().startsWith(c.prefix))),
    [agentAllowedTools],
  );

  const contextValue = useMemo<AgentDetailContextValue>(() => ({
    state: {
      agent: agent!,
      isLoading,
      isRefreshing,
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
    actions: { refetch, refetchVault },
    meta: { agentName },
  }), [
    agent, isLoading, isRefreshing, error, process, subordinates, manager,
    taskStats, sortedTasks, skillPool, vaultEntries, mcpEntries,
    agentAllowedTools, enabledCategories, teamInfo, refetch, refetchVault, agentName,
  ]);

  return (
    <AgentDetailContext value={contextValue}>
      {children}
    </AgentDetailContext>
  );
}
