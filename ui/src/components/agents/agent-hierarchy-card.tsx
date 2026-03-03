/**
 * AgentHierarchyCard — reporting hierarchy (manager + direct reports).
 * Reads data from AgentDetailContext.
 */

import { Link } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import {
  Bot,
  Users,
  ArrowUpRight,
  ChevronRight,
} from "lucide-react";
import { AgentAvatar } from "@/components/shared/agent-avatar";
import { SectionHeader } from "@/components/shared/section-header";
import { useAgentDetail } from "./agent-detail-provider";

export function AgentHierarchyCard() {
  const { state: { agent, manager, subordinates } } = useAgentDetail();

  if (!agent.reportsTo && subordinates.length === 0) return null;

  return (
    <Card className="bg-card/80 backdrop-blur-sm border-border/40 py-0 gap-0">
      <CardContent className="pt-4 pb-4 space-y-3">
        <SectionHeader title="Hierarchy" icon={Users} />

        {/* Manager */}
        {manager && (
          <div>
            <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1.5">
              <ArrowUpRight className="h-2.5 w-2.5 inline mr-1" />
              Manager
            </p>
            <Link
              to={`/agents/${manager.name}`}
              className="flex items-center gap-2 rounded-md border border-border/30 bg-muted/10 px-3 py-2 hover:bg-accent/10 transition-colors"
            >
              <AgentAvatar avatar={manager.identity?.avatar} name={manager.name} size="sm" iconClassName="text-primary" />
              <div className="min-w-0">
                <p className="text-xs font-medium">{manager.identity?.displayName ?? manager.name}</p>
                {manager.identity?.title && (
                  <p className="text-[10px] text-muted-foreground truncate">{manager.identity.title}</p>
                )}
              </div>
              <ChevronRight className="h-3 w-3 text-muted-foreground ml-auto shrink-0" />
            </Link>
          </div>
        )}
        {agent.reportsTo && !manager && (
          <div>
            <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1.5">
              <ArrowUpRight className="h-2.5 w-2.5 inline mr-1" />
              Manager
            </p>
            <div className="flex items-center gap-2 rounded-md border border-border/30 bg-muted/10 px-3 py-2 text-xs text-muted-foreground">
              <Bot className="h-4 w-4 shrink-0" />
              <span className="font-mono">{agent.reportsTo}</span>
            </div>
          </div>
        )}

        {/* Direct reports */}
        {subordinates.length > 0 && (
          <div>
            <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1.5">
              <Users className="h-2.5 w-2.5 inline mr-1" />
              Direct reports ({subordinates.length})
            </p>
            <div className="space-y-1">
              {subordinates.map((sub) => (
                <Link
                  key={sub.name}
                  to={`/agents/${sub.name}`}
                  className="flex items-center gap-2 rounded-md border border-border/30 bg-muted/10 px-3 py-2 hover:bg-accent/10 transition-colors"
                >
                  <AgentAvatar avatar={sub.identity?.avatar} name={sub.name} size="sm" iconClassName="text-muted-foreground" />
                  <div className="min-w-0">
                    <p className="text-xs font-medium">{sub.identity?.displayName ?? sub.name}</p>
                    {sub.identity?.title && (
                      <p className="text-[10px] text-muted-foreground truncate">{sub.identity.title}</p>
                    )}
                  </div>
                  <ChevronRight className="h-3 w-3 text-muted-foreground ml-auto shrink-0" />
                </Link>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
