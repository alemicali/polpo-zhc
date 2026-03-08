/**
 * ListView — grouped-by-team list with AgentCard and TeamNameEditor.
 * Consumes AgentsPageContext for all state and actions.
 */

import { useState } from "react";
import { Link } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Loader2,
  Wrench,
  Zap,
  ChevronRight,
  Trash2,
  Pencil,
  Check,
  X,
} from "lucide-react";
import type { AgentConfig, AgentProcess } from "@lumea-technologies/polpo-react";
import { AgentAvatar } from "@/components/shared/agent-avatar";
import { useAsyncAction } from "@/hooks/use-polpo";
import { RemoveAgentDialog } from "./agents-dialogs";
import { useAgentsPage } from "./agents-page-provider";
import { cn } from "@/lib/utils";
import { getTeamColor } from "./agents-team-colors";

// ─── Inline Team Name Editor ─────────────────────────────

function TeamNameEditor({
  teamName,
  teamDescription,
}: {
  teamName: string;
  teamDescription?: string;
}) {
  const { actions } = useAgentsPage();

  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(teamName);
  const [handleSave, isSaving] = useAsyncAction(async () => {
    if (!value.trim() || value.trim() === teamName) { setEditing(false); return; }
    await actions.renameTeam(teamName, value.trim());
    setEditing(false);
  });

  if (editing) {
    return (
      <form className="flex items-center gap-1.5" onSubmit={(e) => { e.preventDefault(); handleSave(); }}>
        <Input
          value={value} onChange={(e) => setValue(e.target.value)}
          className="h-6 text-sm font-semibold w-40 px-1.5" autoFocus
          onKeyDown={(e) => { if (e.key === "Escape") { setValue(teamName); setEditing(false); } }}
        />
        <button type="submit" disabled={isSaving || !value.trim()} className="p-0.5 rounded text-primary hover:bg-primary/10 transition-colors disabled:opacity-50">
          {isSaving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
        </button>
        <button type="button" onClick={() => { setValue(teamName); setEditing(false); }} className="p-0.5 rounded text-muted-foreground hover:bg-muted/30 transition-colors">
          <X className="h-3 w-3" />
        </button>
      </form>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button className="flex items-center gap-1.5 group/name cursor-pointer" onClick={() => { setValue(teamName); setEditing(true); }}>
          <span className="text-sm font-semibold">{teamName}</span>
          <Pencil className="h-2.5 w-2.5 text-muted-foreground opacity-0 group-hover/name:opacity-100 transition-opacity" />
        </button>
      </TooltipTrigger>
      <TooltipContent className="text-xs max-w-60">{teamDescription ?? "Click to rename team"}</TooltipContent>
    </Tooltip>
  );
}

// ─── Agent Card (list view) ──────────────────────────────

function AgentCard({
  agent,
  process,
  showRemove,
  teamColor,
}: {
  agent: AgentConfig;
  process?: AgentProcess;
  showRemove: boolean;
  teamColor?: ReturnType<typeof getTeamColor>;
}) {
  const capabilityCount =
    (agent.allowedTools?.length ?? 0) + (agent.skills?.length ?? 0) + (agent.mcpServers ? Object.keys(agent.mcpServers).length : 0);

  return (
    <Link to={`/agents/${encodeURIComponent(agent.name)}`} className="block group">
      <div className={cn(
        "rounded-lg border transition-all bg-card/80 backdrop-blur-sm hover:bg-accent/5",
        process ? "border-primary/30 shadow-[0_0_20px_oklch(0.7_0.15_200_/_8%)]" : "border-border/40 hover:border-primary/20",
      )}>
        <div className="flex items-center gap-3 p-4">
          <div className={cn("flex h-10 w-10 shrink-0 items-center justify-center rounded-lg", teamColor?.bg ?? "bg-primary/10")}>
            <AgentAvatar avatar={agent.identity?.avatar} name={agent.name} size="lg" iconClassName={teamColor?.text ?? "text-primary"} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium truncate group-hover:text-primary transition-colors">
                {agent.identity?.displayName ?? agent.name}
              </span>
              {agent.identity?.displayName && agent.identity.displayName !== agent.name && (
                <span className="text-[10px] font-mono text-muted-foreground">@{agent.name}</span>
              )}
              {!!agent.volatile && (
                <Badge variant="outline" className="text-[10px] text-amber-400 border-amber-500/30">
                  <Zap className="h-2.5 w-2.5 mr-0.5" /> mission
                </Badge>
              )}
            </div>
            <div className="flex items-center gap-2 mt-0.5">
              {agent.identity?.title && <span className="text-[10px] text-muted-foreground truncate max-w-[200px]">{agent.identity.title}</span>}
              {agent.model && (
                <span className="text-[10px] text-muted-foreground font-mono truncate max-w-[200px]">
                  {agent.identity?.title ? <>&middot; </> : ""}{agent.model}
                </span>
              )}
              {agent.role && !agent.identity?.title && (
                <span className="text-[10px] text-muted-foreground truncate max-w-[200px] hidden lg:inline">&middot; {agent.role}</span>
              )}
              {agent.reportsTo && (
                <span className="text-[10px] text-muted-foreground hidden md:inline">&middot; reports to <span className="font-mono">{agent.reportsTo}</span></span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {process && (
              <div className="flex items-center gap-1.5">
                <div className="h-2 w-2 rounded-full bg-primary animate-pulse" />
                <span className="text-[10px] text-primary font-medium">Working</span>
              </div>
            )}
            {capabilityCount > 0 && <Badge variant="secondary" className="text-[10px] hidden sm:flex">{capabilityCount} cap.</Badge>}
            {showRemove && <RemoveAgentDialog agentName={agent.name} />}
            <ChevronRight className="h-4 w-4 text-muted-foreground group-hover:text-primary transition-colors" />
          </div>
        </div>
        {process && (
          <div className="flex items-center gap-3 px-4 py-1.5 bg-primary/5 border-t border-primary/10">
            <div className="h-1.5 w-1.5 rounded-full bg-primary animate-pulse shrink-0" />
            {process.activity.lastTool && (
              <Badge variant="outline" className="text-[9px] font-mono px-1.5 py-0 text-primary border-primary/30 shrink-0">
                <Wrench className="h-2 w-2 mr-0.5" />{process.activity.lastTool}
              </Badge>
            )}
            {process.activity.lastFile && <span className="text-[10px] font-mono text-muted-foreground truncate">{process.activity.lastFile.split("/").pop()}</span>}
            {process.activity.summary && !process.activity.lastTool && <span className="text-[10px] text-muted-foreground truncate">{process.activity.summary}</span>}
            <span className="text-[10px] text-muted-foreground ml-auto shrink-0">{process.activity.toolCalls} calls</span>
          </div>
        )}
      </div>
    </Link>
  );
}

// ─── List View (grouped by team) ─────────────────────────

export function ListView() {
  const { state, actions } = useAgentsPage();
  const { teams, processes, search } = state;

  const [handleRemoveTeam, isRemovingTeam] = useAsyncAction(async (name: string) => {
    await actions.removeTeam(name);
  });

  return (
    <ScrollArea className="flex-1 min-h-0 -mx-1">
      <div className="space-y-6 px-1 pr-5 pb-2">
        {teams.map((team, teamIdx) => {
          const tc = getTeamColor(teamIdx);
          const teamAgents = team.agents.filter(a => {
            if (!search) return true;
            const q = search.toLowerCase();
            return a.name.toLowerCase().includes(q) || (a.role ?? "").toLowerCase().includes(q) ||
              (a.model ?? "").toLowerCase().includes(q) || (a.identity?.displayName ?? "").toLowerCase().includes(q);
          });

          return (
            <section key={team.name} className="space-y-2">
              {/* Team section header */}
              <div className={cn("flex items-center gap-3 rounded-lg border px-3 py-2", tc.border, tc.bg)}>
                <div className={cn("h-2 w-2 rounded-full", tc.dot)} />
                <TeamNameEditor teamName={team.name} teamDescription={team.description} />
                <Badge variant="secondary" className="text-[9px]">{team.agents.length} agent{team.agents.length !== 1 ? "s" : ""}</Badge>
                {team.description && <span className="text-[10px] text-muted-foreground truncate hidden md:inline">{team.description}</span>}
                <div className="ml-auto flex items-center gap-1">
                  {teams.length > 1 && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          className="p-1 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                          onClick={() => handleRemoveTeam(team.name)}
                          disabled={isRemovingTeam}
                        >
                          {isRemovingTeam ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
                        </button>
                      </TooltipTrigger>
                      <TooltipContent className="text-xs">Remove team and all its agents</TooltipContent>
                    </Tooltip>
                  )}
                </div>
              </div>

              {/* Agents in this team — rendered with hierarchy indentation */}
              {teamAgents.length > 0 ? (
                <div className="space-y-2 pl-3 border-l-2 ml-1" style={{ borderColor: `oklch(0.7 0.12 ${[250, 280, 160, 80, 0, 200][teamIdx % 6]} / 30%)` }}>
                  {(() => {
                    // Build hierarchy from reportsTo
                    const nameSet = new Set(teamAgents.map(a => a.name));
                    const childrenOf = new Map<string, AgentConfig[]>();
                    for (const a of teamAgents) {
                      if (a.reportsTo && nameSet.has(a.reportsTo)) {
                        const siblings = childrenOf.get(a.reportsTo) ?? [];
                        siblings.push(a);
                        childrenOf.set(a.reportsTo, siblings);
                      }
                    }
                    const roots = teamAgents.filter(a => !a.reportsTo || !nameSet.has(a.reportsTo));

                    // Recursive renderer with depth-based indentation
                    const renderAgent = (agent: AgentConfig, depth: number): React.ReactNode[] => {
                      const children = (childrenOf.get(agent.name) ?? []).sort((a, b) => a.name.localeCompare(b.name));
                      return [
                        <div key={agent.name} style={{ marginLeft: depth * 20 }}>
                          <AgentCard
                            agent={agent}
                            process={processes.find(p => p.agentName === agent.name)}
                            showRemove={!agent.volatile}
                            teamColor={tc}
                          />
                        </div>,
                        ...children.flatMap(child => renderAgent(child, depth + 1)),
                      ];
                    };

                    return roots.sort((a, b) => a.name.localeCompare(b.name)).flatMap(r => renderAgent(r, 0));
                  })()}
                </div>
              ) : (
                <div className="pl-3 border-l-2 border-border/20 ml-1 py-4">
                  <p className="text-xs text-muted-foreground">
                    {search ? "No agents match your search in this team." : "No agents in this team yet."}
                  </p>
                </div>
              )}
            </section>
          );
        })}
      </div>
    </ScrollArea>
  );
}
