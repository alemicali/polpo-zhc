import { useState, useMemo } from "react";
import { Link } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Bot,
  Loader2,
  Wrench,
  RefreshCw,
  ChevronDown,
  Search,
  Zap,
  Sparkles,
  Users,
  ChevronRight,
} from "lucide-react";
import { useAgents, useProcesses, useSkills } from "@lumea-labs/polpo-react";
import type { AgentConfig, AgentProcess, SkillInfo } from "@lumea-labs/polpo-react";
import { cn } from "@/lib/utils";



// ── Skills pool (project-level, collapsible) ──

function SkillsPool({
  skills,
  agents,
}: {
  skills: SkillInfo[];
  agents: AgentConfig[];
}) {
  const [open, setOpen] = useState(false);

  // Build usage map: skill name → agent names using it
  const usageMap = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const skill of skills) map.set(skill.name, []);
    for (const agent of agents) {
      for (const s of agent.skills ?? []) {
        const list = map.get(s);
        if (list) list.push(agent.name);
        else map.set(s, [agent.name]);
      }
    }
    return map;
  }, [skills, agents]);

  if (skills.length === 0) return null;

  const assignedCount = [...usageMap.values()].filter(v => v.length > 0).length;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <button className="w-full flex items-center gap-2 rounded-lg border border-border/40 bg-card/80 backdrop-blur-sm px-3 py-2 hover:bg-muted/30 transition-colors cursor-pointer text-left">
          <Sparkles className="h-3.5 w-3.5 text-violet-400 shrink-0" />
          <span className="text-xs font-medium">Skills</span>
          <Badge variant="secondary" className="text-[9px]">{skills.length}</Badge>
          {assignedCount > 0 && (
            <span className="text-[10px] text-muted-foreground">
              {assignedCount} assigned
            </span>
          )}
          <ChevronDown className={cn("h-3.5 w-3.5 text-muted-foreground ml-auto transition-transform", open && "rotate-180")} />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 pt-2">
          {skills.map((skill) => {
            const users = usageMap.get(skill.name) ?? [];
            return (
              <div
                key={skill.name}
                className="rounded-md border border-border/30 bg-card/60 px-3 py-2 space-y-1"
              >
                <div className="flex items-center gap-2">
                  <Sparkles className="h-3 w-3 text-violet-400 shrink-0" />
                  <span className="text-xs font-medium truncate">{skill.name}</span>
                  {users.length > 0 ? (
                    <Badge variant="secondary" className="text-[9px] ml-auto shrink-0">
                      {users.length} agent{users.length !== 1 ? "s" : ""}
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="text-[9px] ml-auto shrink-0 text-muted-foreground">
                      unused
                    </Badge>
                  )}
                </div>
                {skill.description && (
                  <p className="text-[10px] text-muted-foreground line-clamp-2">{skill.description}</p>
                )}
                <div className="flex items-center gap-2 text-[9px] text-muted-foreground">
                  <Badge variant="outline" className="text-[8px] px-1 py-0">{skill.source}</Badge>
                  <span className="font-mono truncate" title={skill.path}>{skill.path}</span>
                </div>
                {users.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {users.map(u => (
                      <span key={u} className="text-[9px] font-mono text-muted-foreground">{u}</span>
                    ))}
                  </div>
                )}
                {Array.isArray(skill.allowedTools) && skill.allowedTools.length > 0 && (
                  <div className="flex items-center gap-1 pt-0.5">
                    <Wrench className="h-2.5 w-2.5 text-muted-foreground" />
                    {skill.allowedTools.slice(0, 4).map(t => (
                      <Badge key={t} variant="outline" className="text-[8px] py-0 px-1 font-mono">{String(t)}</Badge>
                    ))}
                    {skill.allowedTools.length > 4 && (
                      <span className="text-[8px] text-muted-foreground">+{skill.allowedTools.length - 4}</span>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

// ── Base team header (compact bar) ──

function BaseTeamHeader({
  teamName,
  teamDescription,
  agents,
  processes,
  volatileGroupCount,
}: {
  teamName: string;
  teamDescription?: string;
  agents: AgentConfig[]; // permanent only
  processes: AgentProcess[];
  volatileGroupCount: number;
}) {
  const activeCount = processes.filter(p => agents.some(a => a.name === p.agentName)).length;
  const utilization = agents.length > 0 ? Math.round((activeCount / agents.length) * 100) : 0;

  return (
    <div className="flex items-center gap-3 rounded-lg border border-border/40 bg-card/80 backdrop-blur-sm px-3 py-2">
      {/* Team name */}
      <div className="flex items-center gap-2 shrink-0">
        <Users className="h-3.5 w-3.5 text-primary" />
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="text-sm font-semibold cursor-default">{teamName}</span>
          </TooltipTrigger>
          {teamDescription && (
            <TooltipContent className="text-xs max-w-60">{teamDescription}</TooltipContent>
          )}
        </Tooltip>
      </div>

      <div className="h-4 w-px bg-border" />

      {/* Agent counts */}
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-1.5">
          <div className={cn("h-1.5 w-1.5 rounded-full", activeCount > 0 ? "bg-primary animate-pulse" : "bg-zinc-600")} />
          <span className="text-[11px] text-muted-foreground">Active</span>
          <span className="text-[11px] font-bold">{activeCount}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
          <span className="text-[11px] text-muted-foreground">Total</span>
          <span className="text-[11px] font-bold">{agents.length}</span>
        </div>
      </div>

      {/* Volatile teams */}
      {volatileGroupCount > 0 && (
        <>
          <div className="h-4 w-px bg-border" />
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex items-center gap-1 cursor-help">
                <Zap className="h-3 w-3 text-amber-400" />
                <span className="text-[11px] font-bold">{volatileGroupCount}</span>
                <span className="text-[10px] text-muted-foreground">plan team{volatileGroupCount !== 1 ? "s" : ""}</span>
              </div>
            </TooltipTrigger>
            <TooltipContent className="text-xs max-w-60">
              Volatile teams created by plans. Auto-cleaned when the plan completes.
            </TooltipContent>
          </Tooltip>
        </>
      )}

      {/* Utilization bar */}
      <div className="flex items-center gap-2 ml-auto shrink-0">
        <Progress value={utilization} className="h-1.5 w-20" />
        <span className="text-[10px] font-mono text-muted-foreground w-7 text-right">{utilization}%</span>
      </div>
    </div>
  );
}

// ── Volatile team section header ──

function VolatileTeamHeader({
  planGroup,
  agents,
  processes,
}: {
  planGroup: string;
  agents: AgentConfig[];
  processes: AgentProcess[];
}) {
  const activeCount = processes.filter(p => agents.some(a => a.name === p.agentName)).length;

  return (
    <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 backdrop-blur-sm px-4 py-3">
      <div className="flex items-center gap-3">
        <div className="flex h-7 w-7 items-center justify-center rounded-md bg-amber-500/10">
          <Zap className="h-3.5 w-3.5 text-amber-400" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h4 className="text-sm font-medium">Plan Team</h4>
            <Badge variant="outline" className="text-[9px] text-amber-400 border-amber-500/30">
              {planGroup}
            </Badge>
            <Badge variant="secondary" className="text-[9px]">
              {agents.length} agent{agents.length !== 1 ? "s" : ""}
            </Badge>
            {activeCount > 0 && (
              <Badge variant="outline" className="text-[9px] text-primary border-primary/30">
                {activeCount} active
              </Badge>
            )}
          </div>
          <p className="text-[10px] text-muted-foreground mt-0.5">
            Volatile agents created for this plan &mdash; auto-removed on plan completion
          </p>
        </div>
      </div>
    </div>
  );
}



// ── Live activity panel (inside agent card) ──

// ── Agent card (navigates to detail page on click) ──

function AgentCard({
  agent,
  process,
}: {
  agent: AgentConfig;
  process?: AgentProcess;
}) {
  const capabilityCount =
    (agent.allowedTools?.length ?? 0) +
    (agent.skills?.length ?? 0) +
    (agent.mcpServers ? Object.keys(agent.mcpServers).length : 0);

  return (
    <Link
      to={`/agents/${encodeURIComponent(agent.name)}`}
      className="block group"
    >
      <div className={cn(
        "rounded-lg border transition-all bg-card/80 backdrop-blur-sm hover:bg-accent/5",
        process
          ? "border-primary/30 shadow-[0_0_20px_oklch(0.7_0.15_200_/_8%)]"
          : "border-border/40 hover:border-primary/20"
      )}>
        <div className="flex items-center gap-3 p-4">
          {/* Agent icon */}
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10">
            <Bot className="h-5 w-5 text-primary" />
          </div>

          {/* Name + meta */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium truncate group-hover:text-primary transition-colors">
                {agent.identity?.displayName ?? agent.name}
              </span>
              {agent.identity?.displayName && agent.identity.displayName !== agent.name && (
                <span className="text-[10px] font-mono text-muted-foreground">@{agent.name}</span>
              )}
              {agent.volatile && (
                <Badge variant="outline" className="text-[10px] text-amber-400 border-amber-500/30">
                  <Zap className="h-2.5 w-2.5 mr-0.5" /> volatile
                </Badge>
              )}
            </div>
            <div className="flex items-center gap-2 mt-0.5">
              {agent.identity?.title && (
                <span className="text-[10px] text-muted-foreground truncate max-w-[200px]">
                  {agent.identity.title}
                </span>
              )}
              {agent.model && (
                <span className="text-[10px] text-muted-foreground font-mono truncate max-w-[200px]">
                  {agent.identity?.title ? <>&middot; </> : ""}{agent.model}
                </span>
              )}
              {agent.role && !agent.identity?.title && (
                <span className="text-[10px] text-muted-foreground truncate max-w-[200px] hidden lg:inline">
                  &middot; {agent.role}
                </span>
              )}
            </div>
          </div>

          {/* Right side: status + badges */}
          <div className="flex items-center gap-2 shrink-0">
            {process && (
              <div className="flex items-center gap-1.5">
                <div className="h-2 w-2 rounded-full bg-primary animate-pulse" />
                <span className="text-[10px] text-primary font-medium">Working</span>
              </div>
            )}
            {capabilityCount > 0 && (
              <Badge variant="secondary" className="text-[10px] hidden sm:flex">
                {capabilityCount} cap.
              </Badge>
            )}
            <ChevronRight className="h-4 w-4 text-muted-foreground group-hover:text-primary transition-colors" />
          </div>
        </div>

        {/* Live activity strip for running agents */}
        {process && (
          <div className="flex items-center gap-3 px-4 py-1.5 bg-primary/5 border-t border-primary/10">
            <div className="h-1.5 w-1.5 rounded-full bg-primary animate-pulse shrink-0" />
            {process.activity.lastTool && (
              <Badge variant="outline" className="text-[9px] font-mono px-1.5 py-0 text-primary border-primary/30 shrink-0">
                <Wrench className="h-2 w-2 mr-0.5" />
                {process.activity.lastTool}
              </Badge>
            )}
            {process.activity.lastFile && (
              <span className="text-[10px] font-mono text-muted-foreground truncate">
                {process.activity.lastFile.split("/").pop()}
              </span>
            )}
            {process.activity.summary && !process.activity.lastTool && (
              <span className="text-[10px] text-muted-foreground truncate">{process.activity.summary}</span>
            )}
            <span className="text-[10px] text-muted-foreground ml-auto shrink-0">
              {process.activity.toolCalls} calls
            </span>
          </div>
        )}
      </div>
    </Link>
  );
}

// ── Main page ──

type AgentTab = "permanent" | "volatile";

export function AgentsPage() {
  const { agents, team, isLoading: loading, refetch } = useAgents();
  const { processes } = useProcesses();
  const { skills, refetch: refetchSkills } = useSkills();
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState<AgentTab>("permanent");

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  // Filter by tab (permanent vs volatile) then by search
  const tabAgents = agents.filter(a => tab === "permanent" ? !a.volatile : !!a.volatile);
  const filtered = tabAgents.filter((a) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      a.name.toLowerCase().includes(q) ||
      (a.role ?? "").toLowerCase().includes(q) ||
      (a.model ?? "").toLowerCase().includes(q) ||
      (a.skills ?? []).some(s => s.toLowerCase().includes(q)) ||
      (a.planGroup ?? "").toLowerCase().includes(q)
    );
  });

  // Group volatile by planGroup (only relevant for volatile tab)
  const volatileGroups = filtered.reduce<Record<string, AgentConfig[]>>((acc, a) => {
    if (!a.planGroup) return acc;
    if (!acc[a.planGroup]) acc[a.planGroup] = [];
    acc[a.planGroup].push(a);
    return acc;
  }, {});
  const volatileGroupNames = Object.keys(volatileGroups).sort();

  // Total volatile groups (unfiltered) for the header badge
  const allVolatileGroups = new Set(agents.filter(a => a.volatile && a.planGroup).map(a => a.planGroup!));

  const handleRefresh = async () => {
    await Promise.all([refetch(), refetchSkills()]);
  };

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-4">
      {/* Base team header */}
      <BaseTeamHeader
        teamName={team?.name ?? "Team"}
        teamDescription={team?.description}
        agents={agents.filter(a => !a.volatile)}
        processes={processes}
        volatileGroupCount={allVolatileGroups.size}
      />

      {/* Skills pool */}
      <SkillsPool skills={skills} agents={agents} />

      {/* Toolbar */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          {/* Permanent / Volatile tabs */}
          <div className="flex items-center rounded-lg border border-border/40 bg-muted/20 p-0.5">
            <button
              className={cn(
                "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                tab === "permanent"
                  ? "bg-card text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              )}
              onClick={() => setTab("permanent")}
            >
              <Users className="h-3 w-3" />
              Permanent
              <Badge variant="secondary" className="text-[9px] ml-0.5">{agents.filter(a => !a.volatile).length}</Badge>
            </button>
            <button
              className={cn(
                "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                tab === "volatile"
                  ? "bg-card text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              )}
              onClick={() => setTab("volatile")}
            >
              <Zap className="h-3 w-3" />
              Volatile
              <Badge variant="secondary" className="text-[9px] ml-0.5">{agents.filter(a => a.volatile).length}</Badge>
            </button>
          </div>

          {/* Search */}
          <div className="relative w-64">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search agents..."
              className="pl-9 h-8 bg-input/50 border-border/40"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={handleRefresh}>
          <RefreshCw className="h-3.5 w-3.5" />
        </Button>
      </div>

      {/* Agent list */}
      <ScrollArea className="flex-1 min-h-0 -mx-1">
        <div className="space-y-5 px-1 pr-5 pb-2">
          {filtered.length === 0 ? (
            <Card className="bg-card/60 backdrop-blur-sm">
              <CardContent className="flex flex-col items-center justify-center py-16 text-muted-foreground">
                <Bot className="h-12 w-12 mb-4 opacity-40" />
                <p className="text-sm font-medium">
                  {search ? "No agents match your search" : tab === "volatile" ? "No volatile agents" : "No agents configured"}
                </p>
                <p className="text-xs mt-1 text-center max-w-xs">
                  {search
                    ? "Try a different search term"
                    : tab === "volatile"
                    ? "Volatile agents are created dynamically by plans and auto-removed on completion."
                    : "Agents are configured in the team section of .polpo/polpo.json."}
                </p>
              </CardContent>
            </Card>
          ) : tab === "permanent" ? (
            <div className="space-y-2">
              {filtered.map((agent) => (
                <AgentCard
                  key={agent.name}
                  agent={agent}
                  process={processes.find((p) => p.agentName === agent.name)}
                  
                />
              ))}
            </div>
          ) : (
            <>
              {volatileGroupNames.map(group => (
                <section key={group} className="space-y-2">
                  <VolatileTeamHeader
                    planGroup={group}
                    agents={volatileGroups[group]}
                    processes={processes}
                  />
                  <div className="space-y-2 pl-2 border-l-2 border-amber-500/20 ml-3">
                    {volatileGroups[group].map((agent) => (
                      <AgentCard
                        key={agent.name}
                        agent={agent}
                        process={processes.find((p) => p.agentName === agent.name)}
                        
                      />
                    ))}
                  </div>
                </section>
              ))}
              {/* Ungrouped volatile agents (no planGroup) */}
              {filtered.filter(a => !a.planGroup).length > 0 && (
                <div className="space-y-2">
                  {filtered.filter(a => !a.planGroup).map((agent) => (
                    <AgentCard
                      key={agent.name}
                      agent={agent}
                      process={processes.find((p) => p.agentName === agent.name)}
                      
                    />
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
