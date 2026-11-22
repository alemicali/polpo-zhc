/**
 * AgentHeroCard — left column identity card.
 * Reads all data from AgentDetailContext (no props needed).
 */

import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Zap,
  Building2,
  Mail,
  MapPin,
  Brain,
  Cake,
  RefreshCw,
} from "lucide-react";
import { AgentAvatar } from "@/components/shared/agent-avatar";
import { cn } from "@/lib/utils";
import { useAgentDetail } from "./agent-detail-context";
import { reasoningMeta, formatAgentAge } from "@/lib/agent-meta";
import { getTeamColor } from "./agents-team-colors";
import { EngineBadge } from "@/components/shared/run-context";
import { agentEngineId } from "@/lib/run-context";

export function AgentHeroCard() {
  const { state: { agent, process, teamColorIndex, isRefreshing }, actions: { refetch } } = useAgentDetail();
  const identity = agent.identity;
  const tc = getTeamColor(teamColorIndex);

  return (
    <Card className="gap-0 overflow-hidden py-0">
      {/* Gradient header bar — colored by team */}
      <div className={cn("h-10 bg-gradient-to-r to-transparent", tc.gradientFrom, tc.gradientVia)} />
      <CardContent className="pt-0 -mt-5 pb-4 space-y-3">
        {/* Avatar + name */}
        <div className="flex items-center gap-3">
          <div className={cn("relative flex h-14 w-14 shrink-0 items-center justify-center rounded-xl bg-card border-2 shadow-raised z-10", tc.border)}>
            <AgentAvatar avatar={identity?.avatar} name={agent.name} size="xl" iconClassName={tc.text} />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="font-heading text-h2 truncate">
                {identity?.displayName ?? agent.name}
              </h1>
              {process && (
                <div className="h-2 w-2 rounded-full bg-primary animate-pulse" />
              )}
            </div>
            {identity?.displayName && identity.displayName !== agent.name && (
              <p className="text-micro font-mono text-muted-foreground">@{agent.name}</p>
            )}
            <EngineBadge engine={agentEngineId((agent as { engine?: unknown }).engine)} model={((agent as { engine?: { model?: string } }).engine?.model)} withLabel size={14} className="mt-0.5 text-caption" />
          </div>
        </div>

        {/* Badges row */}
        {(agent.volatile || agent.missionGroup) && (
          <div className="flex flex-wrap gap-1.5">
            {agent.volatile && (
              <Badge variant="outline" className="text-micro text-warning border-warning/30">
                <Zap className="h-2.5 w-2.5 mr-0.5" /> Volatile
              </Badge>
            )}
            {agent.missionGroup && (
              <Badge variant="outline" className="text-micro text-warning border-warning/30">
                mission: {agent.missionGroup}
              </Badge>
            )}
          </div>
        )}

        {/* Identity fields */}
        <div className="divide-y divide-border/60 text-small">
          <div className="flex items-center gap-2 py-1.5">
            <Building2 className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <span className="text-muted-foreground shrink-0">Title</span>
            <span className={cn("ml-auto truncate", identity?.title ? "text-foreground" : "text-muted-foreground/60 italic")}>{identity?.title || "not set"}</span>
          </div>
          <div className="flex items-center gap-2 py-1.5">
            <Building2 className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <span className="text-muted-foreground shrink-0">Company</span>
            <span className={cn("ml-auto truncate", identity?.company ? "text-foreground" : "text-muted-foreground/60 italic")}>{identity?.company || "not set"}</span>
          </div>
          <div className="flex items-center gap-2 py-1.5">
            <Mail className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <span className="text-muted-foreground shrink-0">Email</span>
            <span className={cn("ml-auto truncate font-mono", identity?.email ? "text-foreground" : "text-muted-foreground/60 italic")}>{identity?.email || "not set"}</span>
          </div>
          <div className="flex items-center gap-2 py-1.5">
            <MapPin className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <span className="text-muted-foreground shrink-0">Timezone</span>
            <span className={cn("ml-auto", identity?.timezone ? "text-foreground" : "text-muted-foreground/60 italic")}>{identity?.timezone || "not set"}</span>
          </div>
          <div className="flex items-center gap-2 py-1.5">
            <Zap className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <span className="text-muted-foreground shrink-0">Model</span>
            <span className={cn("ml-auto truncate font-mono", agent.model ? "text-foreground" : "text-muted-foreground/60 italic")}>{agent.model || "not set"}</span>
          </div>
          <div className="flex items-center gap-2 py-1.5">
            <Brain className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <span className="text-muted-foreground shrink-0">Reasoning</span>
            {agent.reasoning && agent.reasoning !== "off" ? (
              <Badge variant="outline" className={cn("text-micro ml-auto", reasoningMeta[agent.reasoning]?.color)}>
                {reasoningMeta[agent.reasoning]?.label ?? agent.reasoning}
              </Badge>
            ) : (
              <span className="ml-auto text-muted-foreground/60 italic">off</span>
            )}
          </div>
          {agent.createdAt && (
            <div className="flex items-center gap-2 py-1.5">
              <Cake className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <span className="text-muted-foreground shrink-0">Age</span>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="ml-auto text-foreground cursor-help">
                    {formatAgentAge(agent.createdAt)}
                  </span>
                </TooltipTrigger>
                <TooltipContent className="text-xs">
                  Created {new Date(agent.createdAt).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}
                </TooltipContent>
              </Tooltip>
            </div>
          )}
        </div>

        {/* Refresh */}
        <div className="pt-1">
          <Button variant="outline" size="sm" className="w-full" onClick={refetch} disabled={isRefreshing}>
            <RefreshCw className={cn("h-4 w-4", isRefreshing && "animate-spin")} />
            {isRefreshing ? "Refreshing" : "Refresh"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
