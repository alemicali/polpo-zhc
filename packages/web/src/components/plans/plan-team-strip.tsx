"use client";

import { useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import { useAgents, useProcesses, useTasks } from "@orchestra/react";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { cn } from "@/lib/utils";

export function PlanTeamStrip({ planName }: { planName: string }) {
  const { agents } = useAgents();
  const { processes } = useProcesses();
  const { tasks } = useTasks();

  const planTasks = useMemo(
    () => tasks.filter((t) => t.group === planName),
    [tasks, planName]
  );

  // Agents belonging to this plan: volatile (planGroup match) + assigned to plan tasks
  const teamAgents = useMemo(() => {
    const assignedNames = new Set(planTasks.map((t) => t.assignTo).filter(Boolean));
    return agents.filter(
      (a) => a.planGroup === planName || assignedNames.has(a.name)
    );
  }, [agents, planTasks, planName]);

  if (teamAgents.length === 0) return null;

  return (
    <div className="space-y-2">
      <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
        Team ({teamAgents.length} agent{teamAgents.length !== 1 ? "s" : ""})
      </h3>
      <div className="flex flex-wrap gap-2">
        {teamAgents.map((agent) => {
          const isVolatile = agent.planGroup === planName;
          const proc = processes.find(
            (p) =>
              p.agentName === agent.name &&
              p.alive &&
              planTasks.some((t) => t.id === p.taskId)
          );
          const activeTask = proc
            ? planTasks.find((t) => t.id === proc.taskId)
            : undefined;
          const hasRecentActivity =
            proc?.activity?.lastUpdate &&
            Date.now() - new Date(proc.activity.lastUpdate).getTime() < 10_000;

          return (
            <div
              key={agent.name}
              className={cn(
                "flex items-center gap-3 rounded-lg border bg-card px-3 py-2 min-w-[180px]",
                proc && "border-primary/30"
              )}
            >
              {/* Avatar */}
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-xs font-bold text-primary">
                {agent.name.slice(0, 2).toUpperCase()}
              </div>

              <div className="flex-1 min-w-0">
                {/* Name + volatile badge */}
                <div className="flex items-center gap-1.5">
                  <span className="text-sm font-medium truncate">
                    {agent.name}
                  </span>
                  {isVolatile && (
                    <Badge
                      variant="outline"
                      className="text-[9px] h-4 text-amber-400 border-amber-400/30 bg-amber-400/10"
                    >
                      volatile
                    </Badge>
                  )}
                </div>

                {/* Role */}
                {agent.role && (
                  <p className="text-[11px] text-muted-foreground truncate">
                    {agent.role}
                  </p>
                )}

                {/* Adapter + model */}
                <div className="flex items-center gap-1 text-[10px] text-muted-foreground/60">
                  {agent.adapter && <span>{agent.adapter}</span>}
                  {agent.model && <span>· {agent.model}</span>}
                </div>

                {/* Activity or idle */}
                {proc && activeTask ? (
                  <div className="flex items-center gap-1.5 mt-1">
                    {hasRecentActivity && (
                      <Shimmer className="w-10 h-2.5">{" "}</Shimmer>
                    )}
                    <span className="text-[10px] text-primary/80 truncate">
                      {activeTask.title}
                    </span>
                    {proc.activity?.lastTool && (
                      <Badge variant="outline" className="text-[9px] h-3.5 px-1">
                        {proc.activity.lastTool}
                      </Badge>
                    )}
                  </div>
                ) : (
                  <div className="mt-1">
                    <span className="text-[10px] text-muted-foreground/40">
                      idle
                    </span>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
