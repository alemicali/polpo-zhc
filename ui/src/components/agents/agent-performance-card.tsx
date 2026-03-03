/**
 * AgentPerformanceCard — task performance stats + progress bar.
 * Reads data from AgentDetailContext.
 */

import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Star } from "lucide-react";
import { cn } from "@/lib/utils";
import { SectionHeader } from "@/components/shared/section-header";
import { useAgentDetail } from "./agent-detail-provider";

export function AgentPerformanceCard() {
  const { state: { taskStats } } = useAgentDetail();

  if (taskStats.total === 0) return null;

  return (
    <Card className="bg-card/80 backdrop-blur-sm border-border/40 py-0 gap-0">
      <CardContent className="pt-4 pb-4 space-y-3">
        <SectionHeader title="Performance" icon={Star} />
        <div className="flex items-center justify-between gap-2">
          <div className="text-center flex-1">
            <p className="text-lg font-bold font-mono">{taskStats.total}</p>
            <p className="text-[10px] text-muted-foreground">Total</p>
          </div>
          {taskStats.successRate != null && (
            <div className="text-center flex-1">
              <p className={cn("text-lg font-bold font-mono", taskStats.successRate >= 70 ? "text-emerald-400" : "text-amber-400")}>
                {taskStats.successRate}%
              </p>
              <p className="text-[10px] text-muted-foreground">Success</p>
            </div>
          )}
          {taskStats.avgScore != null && (
            <div className="text-center flex-1">
              <p className="text-lg font-bold font-mono">{taskStats.avgScore.toFixed(1)}<span className="text-xs text-muted-foreground font-normal">/5</span></p>
              <p className="text-[10px] text-muted-foreground">Avg</p>
            </div>
          )}
          <div className="text-center flex-1">
            <p className="text-lg font-bold font-mono text-emerald-400">{taskStats.done}</p>
            <p className="text-[10px] text-muted-foreground">Done</p>
          </div>
          {taskStats.failed > 0 && (
            <div className="text-center flex-1">
              <p className="text-lg font-bold font-mono text-red-400">{taskStats.failed}</p>
              <p className="text-[10px] text-muted-foreground">Failed</p>
            </div>
          )}
        </div>
        {taskStats.done + taskStats.failed > 0 && (
          <Progress value={taskStats.successRate ?? 0} className="h-1.5" />
        )}
      </CardContent>
    </Card>
  );
}
