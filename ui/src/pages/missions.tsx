import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Card,
  CardContent,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Play,
  MoreVertical,
  Loader2,
  Target,
  RotateCcw,
  XCircle,
  RefreshCw,
  ListChecks,
  ArrowRight,
  Search,
  Filter,
  Check,
  Calendar,
  Repeat,
  Timer,
  Star,
  Users,
} from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useMissions, useTasks, useAgents } from "@lumea-labs/polpo-react";
import type { Mission, MissionStatus } from "@lumea-labs/polpo-react";
import { useAsyncAction } from "@/hooks/use-polpo";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";
import { cn } from "@/lib/utils";
import { cronToHuman } from "@/lib/cron";
import { missionStatusStyles, missionStatusFilterOptions } from "@/lib/mission-status";

// ── Parse mission data (lightweight — only extract counts) ──

function parseMissionCounts(data: string): { taskCount: number } {
  try {
    const parsed = JSON.parse(data);
    return {
      taskCount: Array.isArray(parsed.tasks) ? parsed.tasks.length : 0,
    };
  } catch {
    return { taskCount: 0 };
  }
}

/** Extract unique agent names used by a mission (from tasks.assignTo + team[].name). */
function parseMissionAgents(data: string): string[] {
  try {
    const parsed = JSON.parse(data);
    const agents = new Set<string>();
    if (Array.isArray(parsed.tasks)) {
      for (const t of parsed.tasks) {
        if (t.assignTo) agents.add(t.assignTo);
      }
    }
    if (Array.isArray(parsed.team)) {
      for (const a of parsed.team) {
        if (a.name) agents.add(a.name);
      }
    }
    return Array.from(agents);
  } catch {
    return [];
  }
}



// ── Mission stats shape ──

export interface MissionStats {
  done: number;
  failed: number;
  running: number;
  total: number;
}

// ── Deadline badge (extracted from inline IIFE) ──

function DeadlineBadge({ deadline }: { deadline: string }) {
  const deadlineDate = new Date(deadline);
  const isOverdue = deadlineDate.getTime() < Date.now();
  return (
    <Badge variant="outline" className={cn("text-[10px] gap-1", isOverdue ? "text-red-400 border-red-500/30" : "text-amber-400")}>
      <Timer className="h-2.5 w-2.5" />
      {isOverdue ? "Overdue" : `due ${formatDistanceToNow(deadlineDate, { addSuffix: true })}`}
    </Badge>
  );
}

// ── Mission row ──

const actionableStatuses = new Set<MissionStatus>(["draft", "scheduled", "recurring", "active", "failed", "paused"]);

function MissionRow({
  mission,
  stats,
  onExecute,
  onResume,
  onAbort,
  onClick,
}: {
  mission: Mission;
  stats: MissionStats;
  onExecute: () => void;
  onResume: () => void;
  onAbort: () => void;
  onClick: () => void;
}) {
  const style = missionStatusStyles[mission.status];
  const StatusIcon = style.icon;
  const progress = stats.total > 0 ? Math.round((stats.done / stats.total) * 100) : 0;
  const counts = useMemo(() => parseMissionCounts(mission.data), [mission.data]);

  const isActive = mission.status === "active";
  const hasActions = actionableStatuses.has(mission.status);

  return (
    <div
      className={cn(
        "group relative flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-4 p-4 rounded-lg",
        "bg-card/80 backdrop-blur-sm border border-border/40",
        "transition-all duration-200 hover:border-primary/20 cursor-pointer",
        isActive && "border-l-2 border-l-primary/60 glow-cyan",
        mission.status === "paused" && "border-l-2 border-l-amber-400/60 glow-amber",
      )}
      onClick={onClick}
    >
      {/* Status icon */}
      <div className={cn("flex h-10 w-10 shrink-0 items-center justify-center rounded-xl", style.bg)}>
        <StatusIcon className={cn("h-4 w-4", style.color, isActive && "animate-spin")} />
      </div>

      {/* Name + meta */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium truncate">{mission.name}</span>
          <Badge variant="outline" className={cn("text-[10px] capitalize shrink-0", style.color)}>
            {style.label}
          </Badge>
        </div>
        <div className="flex items-center gap-3 mt-0.5 text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <ListChecks className="h-3 w-3" /> {counts.taskCount} task{counts.taskCount !== 1 ? "s" : ""}
          </span>
          <span>created {formatDistanceToNow(new Date(mission.createdAt), { addSuffix: true })}</span>
          <span>updated {formatDistanceToNow(new Date(mission.updatedAt), { addSuffix: true })}</span>
        </div>
        {/* Schedule / deadline / quality badges */}
        {(mission.schedule || mission.deadline || mission.qualityThreshold != null) && (
          <div className="flex items-center gap-2 mt-1 flex-wrap">
            {mission.schedule && (
              <Badge variant="outline" className="text-[10px] gap-1 text-blue-400">
                <Calendar className="h-2.5 w-2.5" />
                {cronToHuman(mission.schedule)}
                {mission.status === "recurring" ? (
                  <span className="flex items-center gap-0.5 ml-0.5 text-violet-400"><Repeat className="h-2 w-2" />Recurring</span>
                ) : (
                  <span className="ml-0.5 text-muted-foreground">One-shot</span>
                )}
              </Badge>
            )}
            {mission.endDate && (
              <Badge variant="outline" className="text-[10px] gap-1 text-muted-foreground">
                <Calendar className="h-2.5 w-2.5" />
                until {new Date(mission.endDate).toLocaleDateString()}
              </Badge>
            )}
            {mission.deadline && <DeadlineBadge deadline={mission.deadline} />}
            {mission.qualityThreshold != null && (
              <Badge variant="outline" className="text-[10px] gap-1 text-amber-400">
                <Star className="h-2.5 w-2.5" />
                {mission.qualityThreshold}
              </Badge>
            )}
          </div>
        )}
      </div>

      {/* Progress for active missions */}
      {isActive && stats.total > 0 && (
        <div className="flex items-center gap-2 shrink-0">
          <Progress value={progress} className="h-1.5 w-20 [&>div]:bg-primary" />
          <span className="text-[10px] text-muted-foreground font-mono">{stats.done}/{stats.total}</span>
        </div>
      )}

      {/* Status badges */}
      <div className="flex items-center gap-1.5 shrink-0">
        {stats.running > 0 && (
          <Badge variant="secondary" className="text-[10px]">{stats.running} running</Badge>
        )}
        {stats.failed > 0 && (
          <Badge variant="destructive" className="text-[10px]">{stats.failed} failed</Badge>
        )}
        {mission.status === "completed" && stats.done > 0 && (
          <Badge variant="secondary" className="text-[10px]">{stats.done} done</Badge>
        )}
      </div>

      {/* Actions dropdown */}
      {hasActions && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
              onClick={(e) => e.stopPropagation()}
            >
              <MoreVertical className="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {mission.status === "draft" && (
              <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onExecute(); }}>
                <Play className="h-3.5 w-3.5 mr-2" /> Execute
              </DropdownMenuItem>
            )}
            {(mission.status === "active" || mission.status === "failed" || mission.status === "paused") && (
              <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onResume(); }}>
                <RotateCcw className="h-3.5 w-3.5 mr-2" /> Resume
              </DropdownMenuItem>
            )}
            {mission.status === "active" && (
              <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onAbort(); }}>
                <XCircle className="h-3.5 w-3.5 mr-2" /> Abort
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      {/* Navigate arrow */}
      <ArrowRight className="h-4 w-4 text-muted-foreground shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
    </div>
  );
}

// ── Main page ──

// ── Status filter popover ──

function StatusFilter({
  selected,
  onToggle,
}: {
  selected: Set<MissionStatus>;
  onToggle: (status: MissionStatus) => void;
}) {
  const hasFilter = selected.size > 0;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant={hasFilter ? "default" : "outline"} size="sm" className="gap-1.5">
          <Filter className="h-3.5 w-3.5" />
          Status
          {hasFilter && (
            <Badge variant="secondary" className="text-[9px] ml-1">{selected.size}</Badge>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-48 p-2" align="start">
        <div className="space-y-1">
          {missionStatusFilterOptions.map((opt) => (
            <button
              key={opt.value}
              className={cn(
                "flex items-center gap-2 w-full rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                selected.has(opt.value) ? "bg-accent text-accent-foreground" : "hover:bg-muted"
              )}
              onClick={() => onToggle(opt.value)}
            >
              <div className={cn(
                "flex h-4 w-4 shrink-0 items-center justify-center rounded border",
                selected.has(opt.value) ? "bg-primary border-primary" : "border-muted-foreground/30"
              )}>
                {selected.has(opt.value) && <Check className="h-3 w-3 text-primary-foreground" />}
              </div>
              <span className={cn("truncate", opt.color)}>{opt.label}</span>
            </button>
          ))}
        </div>
        {hasFilter && (
          <Button
            variant="ghost"
            size="sm"
            className="w-full mt-1 text-xs"
            onClick={() => missionStatusFilterOptions.forEach(o => { if (selected.has(o.value)) onToggle(o.value); })}
          >
            Clear all
          </Button>
        )}
      </PopoverContent>
    </Popover>
  );
}

// ── Team filter popover ──

function TeamFilter({
  teamNames,
  selected,
  onToggle,
}: {
  teamNames: string[];
  selected: Set<string>;
  onToggle: (team: string) => void;
}) {
  const hasFilter = selected.size > 0;

  if (teamNames.length === 0) return null;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant={hasFilter ? "default" : "outline"} size="sm" className="gap-1.5">
          <Users className="h-3.5 w-3.5" />
          Team
          {hasFilter && (
            <Badge variant="secondary" className="text-[9px] ml-1">{selected.size}</Badge>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-48 p-2" align="start">
        <div className="space-y-1">
          {teamNames.map((name) => (
            <button
              key={name}
              className={cn(
                "flex items-center gap-2 w-full rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                selected.has(name) ? "bg-accent text-accent-foreground" : "hover:bg-muted"
              )}
              onClick={() => onToggle(name)}
            >
              <div className={cn(
                "flex h-4 w-4 shrink-0 items-center justify-center rounded border",
                selected.has(name) ? "bg-primary border-primary" : "border-muted-foreground/30"
              )}>
                {selected.has(name) && <Check className="h-3 w-3 text-primary-foreground" />}
              </div>
              <span className="truncate">{name}</span>
            </button>
          ))}
        </div>
        {hasFilter && (
          <Button
            variant="ghost"
            size="sm"
            className="w-full mt-1 text-xs"
            onClick={() => teamNames.forEach(n => { if (selected.has(n)) onToggle(n); })}
          >
            Clear all
          </Button>
        )}
      </PopoverContent>
    </Popover>
  );
}

// ── Main page ──

export function MissionsPage() {
  const navigate = useNavigate();
  const {
    missions,
    isLoading: loading,
    refetch,
    executeMission,
    resumeMission,
    abortMission,
  } = useMissions();

  const { tasks } = useTasks();
  const { teams } = useAgents();
  const [search, setSearch] = useState("");
  const [selectedStatuses, setSelectedStatuses] = useState<Set<MissionStatus>>(new Set());
  const [selectedTeams, setSelectedTeams] = useState<Set<string>>(new Set());

  const [handleRefresh, isRefreshing] = useAsyncAction(async () => {
    await refetch();
  });

  const handleAction = async (action: () => Promise<unknown>, label: string) => {
    try {
      await action();
      toast.success(label);
      refetch();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const toggleStatus = (status: MissionStatus) => {
    setSelectedStatuses(prev => {
      const next = new Set(prev);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      return next;
    });
  };

  const toggleTeam = (team: string) => {
    setSelectedTeams(prev => {
      const next = new Set(prev);
      if (next.has(team)) next.delete(team);
      else next.add(team);
      return next;
    });
  };

  // Build agent → team name mapping
  const agentToTeam = useMemo(() => {
    const map: Record<string, string> = {};
    for (const team of teams) {
      for (const agent of team.agents) {
        map[agent.name] = team.name;
      }
    }
    return map;
  }, [teams]);

  const teamNames = useMemo(() => teams.map(t => t.name), [teams]);

  // Compute task stats per mission group
  const missionStats = useMemo(() => {
    const map: Record<string, { done: number; failed: number; running: number; total: number }> = {};
    for (const mission of missions) {
      const group = mission.name;
      const groupTasks = tasks.filter(t => t.group === group);
      map[mission.id] = {
        done: groupTasks.filter(t => t.status === "done").length,
        failed: groupTasks.filter(t => t.status === "failed").length,
        running: groupTasks.filter(t => t.status === "in_progress" || t.status === "review").length,
        total: groupTasks.length || (() => { try { return JSON.parse(mission.data)?.tasks?.length ?? 0; } catch { return 0; } })(),
      };
    }
    return map;
  }, [missions, tasks]);

  // Filter missions by search + status + team
  const filtered = useMemo(() => {
    return missions.filter(m => {
      // Status filter
      if (selectedStatuses.size > 0 && !selectedStatuses.has(m.status)) return false;
      // Team filter
      if (selectedTeams.size > 0) {
        const missionAgents = parseMissionAgents(m.data);
        const missionTeams = new Set(missionAgents.map(a => agentToTeam[a]).filter(Boolean));
        if (!Array.from(selectedTeams).some(t => missionTeams.has(t))) return false;
      }
      // Search filter
      if (search) {
        const q = search.toLowerCase();
        return m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q) || (m.prompt ?? "").toLowerCase().includes(q);
      }
      return true;
    });
  }, [missions, search, selectedStatuses, selectedTeams, agentToTeam]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-8 w-8 animate-spin text-primary glow-cyan" />
      </div>
    );
  }

  const hasFilters = search.length > 0 || selectedStatuses.size > 0 || selectedTeams.size > 0;

  const active = filtered.filter(p => p.status === "active" || p.status === "paused");
  const scheduledOnce = filtered.filter(p => p.status === "scheduled");
  const recurring = filtered.filter(p => p.status === "recurring");
  const drafts = filtered.filter(p => p.status === "draft");
  const completed = filtered.filter(p => p.status === "completed" || p.status === "failed" || p.status === "cancelled");

  const sections = [
    { label: "Active", missions: active, defaultOpen: true },
    { label: "Scheduled", missions: scheduledOnce, defaultOpen: true },
    { label: "Recurring", missions: recurring, defaultOpen: true },
    { label: "Drafts", missions: drafts, defaultOpen: true },
    { label: "Completed", missions: completed, defaultOpen: false },
  ].filter(s => s.missions.length > 0);

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-4">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 lg:gap-3 shrink-0">
        {/* Search */}
        <div className="relative w-full sm:w-64">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            placeholder="Search missions..."
            className="pl-8 h-8 text-sm bg-input/50 backdrop-blur-sm border-border/40 focus:border-primary/50"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        {/* Status filter */}
        <StatusFilter selected={selectedStatuses} onToggle={toggleStatus} />

        {/* Team filter */}
        <TeamFilter teamNames={teamNames} selected={selectedTeams} onToggle={toggleTeam} />

        {/* Spacer */}
        <div className="flex-1" />

        {/* Count + refresh */}
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted-foreground">
            <span className="font-mono">{filtered.length}</span>{hasFilters ? ` of ${missions.length}` : ""} mission{filtered.length !== 1 ? "s" : ""}
          </span>
          {active.length > 0 && (
            <Badge variant="default" className="text-[10px] font-mono">
              {active.length} running
            </Badge>
          )}
          <Button variant="outline" size="sm" onClick={handleRefresh} disabled={isRefreshing} className="hover:bg-accent/50">
            <RefreshCw className={cn("h-3.5 w-3.5", isRefreshing && "animate-spin")} />
          </Button>
        </div>
      </div>

      {/* Active filter indicators */}
      {(selectedStatuses.size > 0 || selectedTeams.size > 0) && (
        <div className="flex items-center gap-2 shrink-0 flex-wrap">
          <span className="text-[10px] text-muted-foreground">Filtering by:</span>
          {Array.from(selectedStatuses).map((status) => {
            const opt = missionStatusFilterOptions.find(o => o.value === status);
            return (
              <Badge
                key={status}
                variant="secondary"
                className={cn("text-[10px] gap-1 cursor-pointer hover:bg-destructive/20", opt?.color)}
                onClick={() => toggleStatus(status)}
              >
                {opt?.label ?? status}
                <XCircle className="h-2.5 w-2.5" />
              </Badge>
            );
          })}
          {Array.from(selectedTeams).map((team) => (
            <Badge
              key={`team-${team}`}
              variant="secondary"
              className="text-[10px] gap-1 cursor-pointer hover:bg-destructive/20 text-blue-400"
              onClick={() => toggleTeam(team)}
            >
              <Users className="h-2.5 w-2.5" />
              {team}
              <XCircle className="h-2.5 w-2.5" />
            </Badge>
          ))}
          <Button
            variant="ghost"
            size="sm"
            className="h-5 px-1.5 text-[10px] text-muted-foreground"
            onClick={() => { setSelectedStatuses(new Set()); setSelectedTeams(new Set()); }}
          >
            Clear all
          </Button>
        </div>
      )}

      {missions.length === 0 ? (
        <Card className="bg-card/60 backdrop-blur-sm border-border/40">
          <CardContent className="flex flex-col items-center justify-center py-16 text-muted-foreground">
            <Target className="h-12 w-12 mb-4 text-primary/30" />
            <p className="text-sm font-medium">No missions yet</p>
            <p className="text-xs mt-1 text-center max-w-xs">
              Missions are created when you give the orchestrator a prompt via the TUI or Chat.
            </p>
            <kbd className="mt-3 rounded border border-border bg-muted px-2 py-1 font-mono text-[10px]">
              polpo mission &lt;prompt&gt;
            </kbd>
          </CardContent>
        </Card>
      ) : (
        <ScrollArea className="flex-1 min-h-0">
          <div className="space-y-6 pr-4">
            {sections.map(({ label, missions: sectionMissions }) => (
              <section key={label}>
                <div className="mb-3">
                  <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-widest">
                    {label} ({sectionMissions.length})
                  </h3>
                  <div className="mt-1.5 h-px bg-border/40" />
                </div>
                <div className="space-y-2">
                  {sectionMissions.map((mission) => (
                      <MissionRow
                        key={mission.id}
                        mission={mission}
                        stats={missionStats[mission.id] ?? { done: 0, failed: 0, running: 0, total: 0 }}
                        onExecute={() => handleAction(() => executeMission(mission.id), "Mission executed")}
                        onResume={() => handleAction(() => resumeMission(mission.id), "Mission resumed")}
                        onAbort={() => handleAction(() => abortMission(mission.id), "Mission aborted")}
                        onClick={() => navigate(`/missions/${mission.id}`)}
                      />
                    ))}
                </div>
              </section>
            ))}
          </div>
        </ScrollArea>
      )}
    </div>
  );
}
