/**
 * AgentPerformanceCard — task performance stats + progress bar.
 * Reads data from AgentDetailContext.
 */

import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Star } from "lucide-react";
import { StatValue } from "@/components/shared/stat-value";
import { SectionHeader } from "@/components/shared/section-header";
import { useAgentDetail } from "./agent-detail-context";

const STAT = "flex-1 items-center text-center";

export function AgentPerformanceCard() {
  const { state: { taskStats } } = useAgentDetail();

  if (taskStats.total === 0) return null;

  return (
    <Card className="bg-card/80 backdrop-blur-sm border-border/40 py-0 gap-0">
      <CardContent className="pt-4 pb-4 space-y-3">
        <SectionHeader title="Performance" icon={Star} />
        <div className="flex items-center justify-between gap-2">
          <StatValue size="sm" className={STAT} label="Total" value={taskStats.total} />
          {taskStats.successRate != null && (
            <StatValue size="sm" className={STAT} label="Success" value={`${taskStats.successRate}%`} tone={taskStats.successRate >= 70 ? "success" : "warning"} />
          )}
          {taskStats.avgScore != null && (
            <StatValue
              size="sm" className={STAT} label="Avg"
              value={<>{taskStats.avgScore.toFixed(1)}<span className="text-xs font-normal text-muted-foreground">/5</span></>}
            />
          )}
          <StatValue size="sm" className={STAT} label="Done" value={taskStats.done} tone="success" />
          {taskStats.failed > 0 && (
            <StatValue size="sm" className={STAT} label="Failed" value={taskStats.failed} tone="destructive" />
          )}
        </div>
        {taskStats.done + taskStats.failed > 0 && (
          <Progress value={taskStats.successRate ?? 0} className="h-1.5" />
        )}
      </CardContent>
    </Card>
  );
}
