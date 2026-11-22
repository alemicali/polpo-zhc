/**
 * AgentTasksTab — task list with stats bar.
 * Reads data from AgentDetailContext.
 */

import { Link } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Star, ListChecks } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatDistanceToNow } from "date-fns";
import { useAgentDetail } from "./agent-detail-context";
import { taskStatusConfig } from "@/lib/agent-meta";
import type { Task } from "@polpo-ai/react";

// ── Task row ──

function TaskRow({ task }: { task: Task }) {
  const cfg = taskStatusConfig[task.status];
  const StatusIcon = cfg.icon;
  const score = task.result?.assessment?.globalScore;

  return (
    <Link
      to={`/tasks/${task.id}`}
      className="flex items-center gap-3 px-3 py-2.5 rounded-md hover:bg-accent/10 transition-colors group"
    >
      <StatusIcon className={cn("h-3.5 w-3.5 shrink-0", cfg.color, task.status === "in_progress" && "animate-spin")} />
      <div className="flex-1 min-w-0">
        <p className="text-xs font-medium truncate">{task.title}</p>
        <p className="text-micro text-muted-foreground truncate mt-0.5">
          {task.group && <span className="mr-2">{task.group}</span>}
          {formatDistanceToNow(new Date(task.updatedAt), { addSuffix: true })}
        </p>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {score != null && (
          <Badge variant={score >= 0.7 ? "default" : "destructive"} className="text-micro">
            <Star className="h-2.5 w-2.5 mr-0.5" />
            {Math.round(score * 100)}%
          </Badge>
        )}
        <Badge variant="outline" className={cn("text-micro", cfg.color)}>{cfg.label}</Badge>
        {task.result?.duration != null && (
          <span className="text-micro text-muted-foreground">{Math.round(task.result.duration / 1000)}s</span>
        )}
      </div>
    </Link>
  );
}

// ── Tab content ──

export function AgentTasksTab() {
  const { state: { sortedTasks, taskStats } } = useAgentDetail();

  return (
    <ScrollArea className="h-full">
      <div className="space-y-4 pr-4 pb-bottom-nav lg:pb-4">
        {/* Task stats bar */}
        {taskStats.total > 0 && (
          <div className="flex items-center gap-4 flex-wrap">
            <div className="flex items-center gap-1.5 text-xs">
              <div className="h-2 w-2 rounded-full bg-info" />
              <span className="text-muted-foreground">Active</span>
              <span className="font-mono font-bold">{taskStats.active}</span>
            </div>
            <div className="flex items-center gap-1.5 text-xs">
              <div className="h-2 w-2 rounded-full bg-muted-foreground" />
              <span className="text-muted-foreground">Pending</span>
              <span className="font-mono font-bold">{taskStats.pending}</span>
            </div>
            <div className="flex items-center gap-1.5 text-xs">
              <div className="h-2 w-2 rounded-full bg-success" />
              <span className="text-muted-foreground">Done</span>
              <span className="font-mono font-bold">{taskStats.done}</span>
            </div>
            <div className="flex items-center gap-1.5 text-xs">
              <div className="h-2 w-2 rounded-full bg-destructive" />
              <span className="text-muted-foreground">Failed</span>
              <span className="font-mono font-bold">{taskStats.failed}</span>
            </div>
            {taskStats.successRate != null && (
              <div className="flex items-center gap-1.5 text-xs ml-auto">
                <span className="text-muted-foreground">Success rate:</span>
                <span className={cn("font-mono font-bold", taskStats.successRate >= 70 ? "text-success" : "text-warning")}>
                  {taskStats.successRate}%
                </span>
              </div>
            )}
          </div>
        )}

        {/* Task list */}
        {sortedTasks.length > 0 ? (
          <Card className="py-0 gap-0">
            <CardContent className="pt-2 pb-2 divide-y divide-border/20">
              {sortedTasks.map((task) => (
                <TaskRow key={task.id} task={task} />
              ))}
            </CardContent>
          </Card>
        ) : (
          <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
            <ListChecks className="h-10 w-10 mb-3 opacity-40" />
            <p className="text-sm">No tasks assigned to this agent yet</p>
          </div>
        )}
      </div>
    </ScrollArea>
  );
}
