import { useState, useMemo, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sparkles,
  Search,
  Loader2,
  RefreshCw,
  Wrench,
  Users,
  Bot,
  FolderOpen,
} from "lucide-react";
import { useSkills, useAgents } from "@lumea-labs/polpo-react";
import type { SkillWithAssignment, Team } from "@lumea-labs/polpo-react";
import { cn } from "@/lib/utils";

// ── Helpers ──

/** Build a map of agentName → teamName for quick lookup. */
function buildAgentTeamMap(teams: Team[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const team of teams) {
    for (const agent of team.agents) {
      map.set(agent.name, team.name);
    }
  }
  return map;
}

/** Compute skill stats from the full list. */
function computeStats(
  skills: SkillWithAssignment[],
  agentTeamMap: Map<string, string>,
  teams: Team[],
) {
  let totalAssignments = 0;
  let unassigned = 0;
  const teamsUsingSkills = new Set<string>();

  for (const skill of skills) {
    totalAssignments += skill.assignedTo.length;
    if (skill.assignedTo.length === 0) unassigned++;
    for (const agent of skill.assignedTo) {
      const team = agentTeamMap.get(agent);
      if (team) teamsUsingSkills.add(team);
    }
  }

  return {
    total: skills.length,
    totalAssignments,
    unassigned,
    teamsUsing: teamsUsingSkills.size,
    totalTeams: teams.length,
  };
}

// ── Stat pill ──

function Stat({ label, value, accent }: { label: string; value: string | number; accent?: boolean }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border/40 bg-card/80 px-3 py-2">
      <span className={cn("text-sm font-semibold tabular-nums", accent ? "text-primary" : "text-foreground")}>
        {value}
      </span>
      <span className="text-[11px] text-muted-foreground">{label}</span>
    </div>
  );
}

// ── Skill Card ──

function SkillCard({
  skill,
  agentTeamMap,
  teams,
  onClick,
}: {
  skill: SkillWithAssignment;
  agentTeamMap: Map<string, string>;
  teams: Team[];
  onClick?: () => void;
}) {
  // Compute which teams have this skill
  const teamSet = new Set<string>();
  for (const agent of skill.assignedTo) {
    const team = agentTeamMap.get(agent);
    if (team) teamSet.add(team);
  }
  const skillTeams = [...teamSet];

  // Total possible agents
  const totalAgents = teams.reduce((s, t) => s + t.agents.length, 0);

  return (
    <div
      className={cn(
        "rounded-lg border border-border/40 bg-card/80 p-4 space-y-3",
        onClick && "cursor-pointer transition-colors hover:border-border/80 hover:bg-card",
      )}
      onClick={onClick}
    >
      {/* Header */}
      <div className="flex items-start gap-2.5">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-violet-500/10 shrink-0">
          <Sparkles className="h-4 w-4 text-violet-400" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold truncate">{skill.name}</span>
            <Badge variant="outline" className="text-[9px] shrink-0">{skill.source}</Badge>
          </div>
          {skill.description && (
            <p className="text-[11px] text-muted-foreground mt-0.5 line-clamp-2">{skill.description}</p>
          )}
        </div>
      </div>

      {/* Stats row */}
      <div className="flex items-center gap-3 flex-wrap">
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="flex items-center gap-1.5 text-xs">
              <Bot className="h-3 w-3 text-muted-foreground" />
              <span className={cn(
                "font-medium",
                skill.assignedTo.length > 0 ? "text-foreground" : "text-muted-foreground/60",
              )}>
                {skill.assignedTo.length}
              </span>
              <span className="text-muted-foreground">/ {totalAgents}</span>
            </span>
          </TooltipTrigger>
          <TooltipContent className="text-xs">
            {skill.assignedTo.length > 0
              ? `Assigned to ${skill.assignedTo.length} of ${totalAgents} agents`
              : "Not assigned to any agent"}
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <span className="flex items-center gap-1.5 text-xs">
              <Users className="h-3 w-3 text-muted-foreground" />
              <span className={cn(
                "font-medium",
                skillTeams.length > 0 ? "text-foreground" : "text-muted-foreground/60",
              )}>
                {skillTeams.length}
              </span>
              <span className="text-muted-foreground">/ {teams.length} teams</span>
            </span>
          </TooltipTrigger>
          <TooltipContent className="text-xs">
            {skillTeams.length > 0
              ? `Used in ${skillTeams.join(", ")}`
              : "Not used in any team"}
          </TooltipContent>
        </Tooltip>
      </div>

      {/* Agents */}
      {skill.assignedTo.length > 0 && (
        <div className="space-y-1.5">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Agents</span>
          <div className="flex flex-wrap gap-1">
            {skill.assignedTo.map((agent) => {
              const team = agentTeamMap.get(agent);
              return (
                <Tooltip key={agent}>
                  <TooltipTrigger asChild>
                    <span>
                      <Badge variant="secondary" className="text-[10px] gap-1">
                        <Bot className="h-2.5 w-2.5" />
                        {agent}
                      </Badge>
                    </span>
                  </TooltipTrigger>
                  {team && <TooltipContent className="text-xs">Team: {team}</TooltipContent>}
                </Tooltip>
              );
            })}
          </div>
        </div>
      )}

      {/* Teams */}
      {skillTeams.length > 0 && (
        <div className="space-y-1.5">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Teams</span>
          <div className="flex flex-wrap gap-1">
            {skillTeams.map((team) => (
              <Badge key={team} variant="outline" className="text-[10px] gap-1">
                <Users className="h-2.5 w-2.5" />
                {team}
              </Badge>
            ))}
          </div>
        </div>
      )}

      {/* Allowed Tools */}
      {Array.isArray(skill.allowedTools) && skill.allowedTools.length > 0 && (
        <div className="space-y-1.5">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Allowed Tools</span>
          <div className="flex flex-wrap gap-1">
            {skill.allowedTools.slice(0, 6).map((t) => (
              <Badge key={t} variant="outline" className="text-[9px] font-mono py-0 px-1.5">
                <Wrench className="h-2.5 w-2.5 mr-0.5" />
                {t}
              </Badge>
            ))}
            {skill.allowedTools.length > 6 && (
              <span className="text-[9px] text-muted-foreground self-center">+{skill.allowedTools.length - 6}</span>
            )}
          </div>
        </div>
      )}

      {/* Path */}
      <div className="flex items-center gap-1.5 pt-1 border-t border-border/20">
        <FolderOpen className="h-3 w-3 text-muted-foreground shrink-0" />
        <code className="text-[10px] font-mono text-muted-foreground truncate" title={skill.path}>{skill.path}</code>
      </div>
    </div>
  );
}

// ── Empty state ──

function Empty({ text }: { text: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 gap-3 text-muted-foreground">
      <Sparkles className="h-10 w-10 opacity-30" />
      <p className="text-sm">{text}</p>
    </div>
  );
}

// ── Main ──

const FILTER_ALL = "__all__";

export function SkillsPage() {
  const navigate = useNavigate();
  const { skills, isLoading, error, refetch } = useSkills();
  const { agents, teams } = useAgents();
  const [search, setSearch] = useState("");
  const [teamFilter, setTeamFilter] = useState(FILTER_ALL);
  const [agentFilter, setAgentFilter] = useState(FILTER_ALL);

  // Agent → team mapping
  const agentTeamMap = useMemo(() => buildAgentTeamMap(teams), [teams]);

  // Agents in the selected team (for cascading filter)
  const agentsInTeam = useMemo(() => {
    if (teamFilter === FILTER_ALL) return agents;
    const team = teams.find(t => t.name === teamFilter);
    return team ? team.agents : [];
  }, [teamFilter, teams, agents]);

  // Reset agent filter when team changes and agent isn't in that team
  const effectiveAgentFilter = useMemo(() => {
    if (agentFilter === FILTER_ALL) return FILTER_ALL;
    if (agentsInTeam.some(a => a.name === agentFilter)) return agentFilter;
    return FILTER_ALL;
  }, [agentFilter, agentsInTeam]);

  // Filtered skills
  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    return skills.filter((skill) => {
      // Text search
      if (q && !skill.name.toLowerCase().includes(q) && !skill.description.toLowerCase().includes(q)) {
        return false;
      }

      // Team filter: skill must be assigned to at least one agent in the team
      if (teamFilter !== FILTER_ALL) {
        const teamAgents = new Set(agentsInTeam.map(a => a.name));
        if (!skill.assignedTo.some(a => teamAgents.has(a))) return false;
      }

      // Agent filter
      if (effectiveAgentFilter !== FILTER_ALL) {
        if (!skill.assignedTo.includes(effectiveAgentFilter)) return false;
      }

      return true;
    });
  }, [skills, search, teamFilter, effectiveAgentFilter, agentsInTeam]);

  // Stats (computed on all skills, not filtered)
  const stats = useMemo(() => computeStats(skills, agentTeamMap, teams), [skills, agentTeamMap, teams]);

  const [isRefreshing, setIsRefreshing] = useState(false);
  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true);
    try { await refetch(); } finally { setIsRefreshing(false); }
  }, [refetch]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-muted-foreground">
        <Sparkles className="h-10 w-10 opacity-40" />
        <p className="text-sm">{error.message ?? "Could not load skills"}</p>
        <Button variant="outline" size="sm" onClick={handleRefresh}>
          <RefreshCw className="h-3.5 w-3.5 mr-1.5" /> Retry
        </Button>
      </div>
    );
  }

  const isFiltered = teamFilter !== FILTER_ALL || effectiveAgentFilter !== FILTER_ALL || search.trim() !== "";

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-4">
      {/* ── Stats row ── */}
      <div className="flex items-center gap-2 flex-wrap shrink-0">
        <Stat label="skills" value={stats.total} accent />
        <Stat label="assignments" value={stats.totalAssignments} />
        <Stat label="unassigned" value={stats.unassigned} />
        <Stat label={`/ ${stats.totalTeams} teams`} value={stats.teamsUsing} />

        <div className="ml-auto">
          <Button variant="outline" size="sm" className="h-8" onClick={handleRefresh} disabled={isRefreshing}>
            <RefreshCw className={cn("h-3.5 w-3.5", isRefreshing && "animate-spin")} />
          </Button>
        </div>
      </div>

      {/* ── Toolbar ── */}
      <div className="flex items-center gap-2 flex-wrap shrink-0">
        {/* Search */}
        <div className="relative flex-1 min-w-48 max-w-xs">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            placeholder="Search skills..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8 h-8 text-xs"
          />
        </div>

        {/* Team filter */}
        <Select value={teamFilter} onValueChange={(v) => { setTeamFilter(v); setAgentFilter(FILTER_ALL); }}>
          <SelectTrigger className="h-8 w-40 text-xs gap-1.5">
            <Users className="h-3 w-3 text-muted-foreground shrink-0" />
            <SelectValue placeholder="All teams" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={FILTER_ALL}>All teams</SelectItem>
            {teams.map((t) => (
              <SelectItem key={t.name} value={t.name}>{t.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* Agent filter */}
        <Select value={effectiveAgentFilter} onValueChange={setAgentFilter}>
          <SelectTrigger className="h-8 w-40 text-xs gap-1.5">
            <Bot className="h-3 w-3 text-muted-foreground shrink-0" />
            <SelectValue placeholder="All agents" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={FILTER_ALL}>All agents</SelectItem>
            {agentsInTeam.map((a) => (
              <SelectItem key={a.name} value={a.name}>{a.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* Clear filters */}
        {isFiltered && (
          <Button
            variant="ghost"
            size="sm"
            className="h-8 text-xs text-muted-foreground"
            onClick={() => { setSearch(""); setTeamFilter(FILTER_ALL); setAgentFilter(FILTER_ALL); }}
          >
            Clear
          </Button>
        )}
      </div>

      {/* ── Results ── */}
      <div className="flex-1 overflow-auto pb-bottom-nav lg:pb-2">
        {filtered.length > 0 ? (
          <>
            {isFiltered && (
              <p className="text-[11px] text-muted-foreground mb-2">
                Showing {filtered.length} of {skills.length} skills
              </p>
            )}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {filtered.map((skill) => (
                <SkillCard
                  key={skill.name}
                  skill={skill}
                  agentTeamMap={agentTeamMap}
                  teams={teams}
                  onClick={() => navigate(`/skills/${encodeURIComponent(skill.name)}`)}
                />
              ))}
            </div>
          </>
        ) : isFiltered ? (
          <Empty text="No skills match the current filters" />
        ) : (
          <Empty text="No skills discovered — install skills with polpo skills add" />
        )}
      </div>
    </div>
  );
}
