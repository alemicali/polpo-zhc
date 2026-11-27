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
  Cpu,
} from "lucide-react";
import { AgentColorPicker } from "./agent-color-picker";
import { Link } from "react-router-dom";
import { AgentAvatar } from "@/components/shared/agent-avatar";
import { cn } from "@/lib/utils";
import { useAgentDetail } from "./agent-detail-context";
import { reasoningMeta, formatAgentAge } from "@/lib/agent-meta";
import { getTeamColor } from "./agents-team-colors";
import { EngineMark } from "@/components/shared/model-with-engine";
import { agentEngineInfo } from "@/lib/engine-mark";

export function AgentHeroCard() {
  const { state: { agent, process, teamColorIndex, isRefreshing }, actions: { refetch } } = useAgentDetail();
  const identity = agent.identity;
  const tc = getTeamColor(teamColorIndex);
  const { engine, model } = agentEngineInfo(agent);

  return (
    <Card className="gap-0 overflow-hidden py-0">
      {/* Gradient header bar — colored by team */}
      <div className={cn("h-10 shrink-0 bg-gradient-to-r to-transparent", tc.gradientFrom, tc.gradientVia)} />
      <CardContent className="pt-0 -mt-5 pb-4 space-y-3">
        {/* Avatar + name */}
        <div className="flex items-center gap-3">
          <div className={cn("relative flex h-14 w-14 shrink-0 items-center justify-center rounded-xl bg-card border-2 shadow-raised z-10", tc.border)}>
            <AgentAvatar avatar={identity?.avatar} name={agent.name} color={(identity as { color?: unknown } | undefined)?.color} size="xl" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <h1 className="font-heading text-h2 truncate">
                {identity?.displayName ?? agent.name}
              </h1>
              <AgentColorPicker agent={agent} onChanged={refetch} compact />
              {process && (
                <div className="h-2 w-2 rounded-pill bg-primary animate-pulse" />
              )}
            </div>
            {/* @handle · version (opens the Versions tab); the model is in the Model row below */}
            <p className="flex min-w-0 items-center gap-1.5 text-micro font-mono text-muted-foreground" data-testid="agent-hero-handle">
              {identity?.displayName && identity.displayName !== agent.name && (
                <span className="min-w-0 truncate" title={`@${agent.name}`}>@{agent.name}</span>
              )}
              {agent.versioning?.production && (
                <>
                  {identity?.displayName && identity.displayName !== agent.name && <span aria-hidden>·</span>}
                  <Link
                    to={{ search: "?tab=versions" }}
                    className="shrink-0 rounded-sm hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    title="The version production runs: open Versions"
                    data-testid="agent-hero-version"
                  >
                    v{agent.versioning.production}
                  </Link>
                </>
              )}
              {agent.versioning?.draft.hasChanges && (
                <Link
                  to={{ search: "?tab=versions" }}
                  className="shrink-0 font-sans text-warning hover:underline"
                  title={agent.versioning.draft.warning ?? `Unpublished: ${agent.versioning.draft.changedFields.join(", ")}`}
                >
                  {agent.versioning.draft.stale ? "draft out of date" : "draft"}
                </Link>
              )}
            </p>
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
              <Badge variant="outline" className="text-micro text-warning border-warning/30 min-w-0 max-w-full shrink">
                <span className="min-w-0 truncate" title={agent.missionGroup}>mission: {agent.missionGroup}</span>
              </Badge>
            )}
          </div>
        )}

        {/* Bio — under the name, like a LinkedIn / X profile */}
        {identity?.bio && (
          <p className="whitespace-pre-line break-words text-small leading-relaxed text-foreground" data-testid="agent-hero-bio">
            {identity.bio}
          </p>
        )}

        {/* Identity fields */}
        <div className="divide-y divide-border/60 text-small">
          <div className="flex items-center gap-2 py-1.5">
            <Building2 className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <span className="text-muted-foreground shrink-0">Title</span>
            <span title={identity?.title || undefined} className={cn("ml-auto min-w-0 truncate", identity?.title ? "text-foreground" : "text-muted-foreground/60 italic")}>{identity?.title || "not set"}</span>
          </div>
          <div className="flex items-center gap-2 py-1.5">
            <Building2 className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <span className="text-muted-foreground shrink-0">Company</span>
            <span title={identity?.company || undefined} className={cn("ml-auto min-w-0 truncate", identity?.company ? "text-foreground" : "text-muted-foreground/60 italic")}>{identity?.company || "not set"}</span>
          </div>
          <div className="flex items-center gap-2 py-1.5">
            <Mail className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <span className="text-muted-foreground shrink-0">Email</span>
            <span title={identity?.email || undefined} className={cn("ml-auto min-w-0 truncate font-mono", identity?.email ? "text-foreground" : "text-muted-foreground/60 italic")}>{identity?.email || "not set"}</span>
          </div>
          <div className="flex items-center gap-2 py-1.5">
            <MapPin className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <span className="text-muted-foreground shrink-0">Timezone</span>
            <span title={identity?.timezone || undefined} className={cn("ml-auto min-w-0 truncate", identity?.timezone ? "text-foreground" : "text-muted-foreground/60 italic")}>{identity?.timezone || "not set"}</span>
          </div>
          <div className="flex items-center gap-2 py-1.5">
            <Cpu className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <span className="text-muted-foreground shrink-0">Harness</span>
            <EngineMark engine={engine} model={model} size={13} className="ml-auto text-foreground" />
          </div>
          <div className="flex items-center gap-2 py-1.5" data-testid="agent-hero-model-row" data-engine={engine.id}>
            <Zap className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <span className="text-muted-foreground shrink-0">Model</span>
            <span title={model || undefined} className={cn("ml-auto min-w-0 truncate font-mono", model ? "text-foreground" : "text-muted-foreground/60 italic")} data-testid="model-name">{model || "default"}</span>
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
