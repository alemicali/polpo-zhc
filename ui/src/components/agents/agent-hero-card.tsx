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
import { useAgentDetail } from "./agent-detail-provider";
import { reasoningMeta, formatAgentAge } from "@/lib/agent-meta";

export function AgentHeroCard() {
  const { state: { agent, process }, actions: { refetch } } = useAgentDetail();
  const identity = agent.identity;

  return (
    <Card className="bg-card/80 backdrop-blur-sm border-border/40 py-0 gap-0">
      {/* Gradient header bar */}
      <div className="h-10 rounded-t-xl bg-gradient-to-r from-primary/20 via-primary/10 to-transparent" />
      <CardContent className="pt-0 -mt-5 pb-4 space-y-3">
        {/* Avatar + name */}
        <div className="flex items-center gap-3">
          <div className="relative flex h-14 w-14 shrink-0 items-center justify-center rounded-xl bg-card border-2 border-background shadow-lg z-10">
            <AgentAvatar avatar={identity?.avatar} name={agent.name} size="xl" iconClassName="text-primary" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-bold tracking-tight leading-tight truncate">
                {identity?.displayName ?? agent.name}
              </h1>
              {process && (
                <div className="h-2 w-2 rounded-full bg-primary animate-pulse" />
              )}
            </div>
            {identity?.displayName && identity.displayName !== agent.name && (
              <p className="text-[10px] font-mono text-muted-foreground">@{agent.name}</p>
            )}
          </div>
        </div>

        {/* Badges row */}
        {(agent.volatile || agent.missionGroup) && (
          <div className="flex flex-wrap gap-1.5">
            {agent.volatile && (
              <Badge variant="outline" className="text-[9px] text-amber-400 border-amber-500/30">
                <Zap className="h-2.5 w-2.5 mr-0.5" /> Volatile
              </Badge>
            )}
            {agent.missionGroup && (
              <Badge variant="outline" className="text-[9px] text-amber-400 border-amber-500/30">
                mission: {agent.missionGroup}
              </Badge>
            )}
          </div>
        )}

        {/* Identity fields */}
        <div className="divide-y divide-border/20 text-[11px]">
          <div className="flex items-center gap-2 py-1.5">
            <Building2 className="h-3 w-3 text-muted-foreground shrink-0" />
            <span className="text-muted-foreground/60 shrink-0">Title</span>
            <span className={cn("ml-auto truncate", identity?.title ? "text-muted-foreground" : "text-muted-foreground/30 italic")}>{identity?.title || "not set"}</span>
          </div>
          <div className="flex items-center gap-2 py-1.5">
            <Building2 className="h-3 w-3 text-muted-foreground shrink-0" />
            <span className="text-muted-foreground/60 shrink-0">Company</span>
            <span className={cn("ml-auto truncate", identity?.company ? "text-muted-foreground" : "text-muted-foreground/30 italic")}>{identity?.company || "not set"}</span>
          </div>
          <div className="flex items-center gap-2 py-1.5">
            <Mail className="h-3 w-3 text-muted-foreground shrink-0" />
            <span className="text-muted-foreground/60 shrink-0">Email</span>
            <span className={cn("ml-auto truncate font-mono", identity?.email ? "text-muted-foreground" : "text-muted-foreground/30 italic")}>{identity?.email || "not set"}</span>
          </div>
          <div className="flex items-center gap-2 py-1.5">
            <MapPin className="h-3 w-3 text-muted-foreground shrink-0" />
            <span className="text-muted-foreground/60 shrink-0">Timezone</span>
            <span className={cn("ml-auto", identity?.timezone ? "text-muted-foreground" : "text-muted-foreground/30 italic")}>{identity?.timezone || "not set"}</span>
          </div>
          <div className="flex items-center gap-2 py-1.5">
            <Zap className="h-3 w-3 text-muted-foreground shrink-0" />
            <span className="text-muted-foreground/60 shrink-0">Model</span>
            <span className={cn("ml-auto truncate font-mono", agent.model ? "text-muted-foreground" : "text-muted-foreground/30 italic")}>{agent.model || "not set"}</span>
          </div>
          <div className="flex items-center gap-2 py-1.5">
            <Brain className="h-3 w-3 text-muted-foreground shrink-0" />
            <span className="text-muted-foreground/60 shrink-0">Reasoning</span>
            {agent.reasoning && agent.reasoning !== "off" ? (
              <Badge variant="outline" className={cn("text-[9px] ml-auto", reasoningMeta[agent.reasoning]?.color)}>
                {reasoningMeta[agent.reasoning]?.label ?? agent.reasoning}
              </Badge>
            ) : (
              <span className="ml-auto text-muted-foreground/30 italic">off</span>
            )}
          </div>
          {agent.createdAt && (
            <div className="flex items-center gap-2 py-1.5">
              <Cake className="h-3 w-3 text-muted-foreground shrink-0" />
              <span className="text-muted-foreground/60 shrink-0">Age</span>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="ml-auto text-muted-foreground cursor-help">
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
          <Button variant="outline" size="sm" className="w-full text-xs" onClick={refetch}>
            <RefreshCw className="h-3 w-3 mr-1.5" /> Refresh
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
