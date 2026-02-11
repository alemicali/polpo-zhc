"use client";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useProcesses, useTasks } from "@orchestra/react";
import { formatTimeAgo } from "@/lib/orchestra";
import { Shimmer } from "@/components/ai-elements/shimmer";

export function ActiveAgents() {
  const { processes } = useProcesses();
  const { tasks } = useTasks();

  const alive = processes.filter((p) => p.alive);

  if (alive.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Active Agents</CardTitle>
          <CardDescription>No agents running</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Active Agents</CardTitle>
        <CardDescription>{alive.length} agent{alive.length !== 1 ? "s" : ""} working</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {alive.map((proc) => {
          const task = tasks.find((t) => t.id === proc.taskId);
          const hasRecentActivity =
            proc.activity?.lastUpdate &&
            Date.now() - new Date(proc.activity.lastUpdate).getTime() < 10_000;

          return (
            <div
              key={`${proc.agentName}-${proc.taskId}`}
              className="flex items-center gap-3 rounded-lg border bg-card p-3"
            >
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-xs font-bold text-primary">
                {proc.agentName.slice(0, 2).toUpperCase()}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium truncate">
                    {proc.agentName}
                  </span>
                  {hasRecentActivity && (
                    <Shimmer className="w-12 h-3">
                      {" "}
                    </Shimmer>
                  )}
                </div>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="truncate">
                    {task?.title ?? proc.taskId}
                  </span>
                  {proc.activity?.lastTool && (
                    <Badge variant="outline" className="text-[10px] h-4 px-1">
                      {proc.activity.lastTool}
                    </Badge>
                  )}
                </div>
              </div>
              <span className="text-[10px] text-muted-foreground shrink-0">
                {formatTimeAgo(proc.startedAt)}
              </span>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
