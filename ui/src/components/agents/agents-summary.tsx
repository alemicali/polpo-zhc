/**
 * SummaryHeader — team/agent counts and utilization bar.
 * Consumes AgentsPageContext.
 */

import { Users, Bot } from "lucide-react";
import { Progress } from "@/components/ui/progress";
import { useAgentsPage } from "./agents-page-provider";

export function SummaryHeader() {
  const { state } = useAgentsPage();
  const { teams, agents, processes } = state;

  const activeCount = processes.filter(p => agents.some(a => a.name === p.agentName)).length;
  const utilization = agents.length > 0 ? Math.round((activeCount / agents.length) * 100) : 0;

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2 rounded-lg border border-border/40 bg-card/80 px-3 py-2 backdrop-blur-sm sm:gap-3">
      <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1">
        <div className="flex items-center gap-1.5">
          <Users className="h-3.5 w-3.5 text-primary" />
          <span className="text-[11px] text-muted-foreground">Teams</span>
          <span className="text-[11px] font-bold">{teams.length}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <Bot className="h-3.5 w-3.5 text-primary/70" />
          <span className="text-[11px] text-muted-foreground">Agents</span>
          <span className="text-[11px] font-bold">{agents.length}</span>
        </div>
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-2">
        <Progress value={utilization} className="h-1.5 w-14 sm:w-20" />
        <span className="text-[10px] font-mono text-muted-foreground w-7 text-right">{utilization}%</span>
      </div>
    </div>
  );
}
