import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import {
  Card,
  CardContent,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
  Pause,
  MoreVertical,
  Loader2,
  Target,
  RotateCcw,
  XCircle,
  RefreshCw,
  ListChecks,
  CheckCircle2,
  AlertTriangle,
  Clock,
  ArrowRight,
} from "lucide-react";
import { useMissions, useTasks } from "@lumea-labs/polpo-react";
import type { Mission, MissionStatus } from "@lumea-labs/polpo-react";
import { useAsyncAction } from "@/hooks/use-polpo";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";
import { cn } from "@/lib/utils";

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

// ── Status styles ──

const statusStyles: Record<MissionStatus, { color: string; bg: string; label: string; icon: React.ElementType }> = {
  draft: { color: "text-zinc-400", bg: "bg-zinc-500/10", label: "Draft", icon: Clock },
  active: { color: "text-primary", bg: "bg-primary/10", label: "Running", icon: Loader2 },
  paused: { color: "text-amber-400", bg: "bg-amber-500/10", label: "Paused", icon: Pause },
  completed: { color: "text-emerald-400", bg: "bg-emerald-500/10", label: "Completed", icon: CheckCircle2 },
  failed: { color: "text-red-400", bg: "bg-red-500/10", label: "Failed", icon: AlertTriangle },
  cancelled: { color: "text-zinc-500", bg: "bg-zinc-500/10", label: "Cancelled", icon: XCircle },
};

// ── Mission row ──

function MissionRow({
  mission,
  doneCount,
  failedCount,
  runningCount,
  totalCount,
  onExecute,
  onResume,
  onAbort,
  onClick,
}: {
  mission: Mission;
  doneCount: number;
  failedCount: number;
  runningCount: number;
  totalCount: number;
  onExecute: () => void;
  onResume: () => void;
  onAbort: () => void;
  onClick: () => void;
}) {
  const style = statusStyles[mission.status];
  const StatusIcon = style.icon;
  const progress = totalCount > 0 ? Math.round((doneCount / totalCount) * 100) : 0;
  const counts = useMemo(() => parseMissionCounts(mission.data), [mission.data]);

  const isActive = mission.status === "active";
  const hasActions = mission.status === "draft" || mission.status === "active" || mission.status === "failed" || mission.status === "paused";

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
        <StatusIcon className={cn("h-4 w-4", style.color, mission.status === "active" && "animate-spin")} />
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
      </div>

      {/* Progress for active missions */}
      {mission.status === "active" && totalCount > 0 && (
        <div className="flex items-center gap-2 shrink-0">
          <Progress value={progress} className="h-1.5 w-20 [&>div]:bg-primary" />
          <span className="text-[10px] text-muted-foreground font-mono">{doneCount}/{totalCount}</span>
        </div>
      )}

      {/* Status badges */}
      <div className="flex items-center gap-1.5 shrink-0">
        {runningCount > 0 && (
          <Badge variant="secondary" className="text-[10px]">{runningCount} running</Badge>
        )}
        {failedCount > 0 && (
          <Badge variant="destructive" className="text-[10px]">{failedCount} failed</Badge>
        )}
        {mission.status === "completed" && doneCount > 0 && (
          <Badge variant="secondary" className="text-[10px]">{doneCount} done</Badge>
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

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-8 w-8 animate-spin text-primary glow-cyan" />
      </div>
    );
  }

  const active = missions.filter(p => p.status === "active" || p.status === "paused");
  const drafts = missions.filter(p => p.status === "draft");
  const completed = missions.filter(p => p.status === "completed" || p.status === "failed" || p.status === "cancelled");

  const sections = [
    { label: "Active", missions: active, defaultOpen: true },
    { label: "Drafts", missions: drafts, defaultOpen: true },
    { label: "Completed", missions: completed, defaultOpen: false },
  ].filter(s => s.missions.length > 0);

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-4">
      {/* Toolbar */}
      <div className="flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3">
          <h3 className="text-sm font-medium text-muted-foreground">
            <span className="font-mono">{missions.length}</span> mission{missions.length !== 1 ? "s" : ""}
          </h3>
          {active.length > 0 && (
            <Badge variant="default" className="text-[10px] font-mono">
              {active.length} running
            </Badge>
          )}
        </div>
        <Button variant="outline" size="sm" onClick={handleRefresh} disabled={isRefreshing} className="hover:bg-accent/50">
          <RefreshCw className={cn("h-3.5 w-3.5", isRefreshing && "animate-spin")} />
        </Button>
      </div>

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
                  {sectionMissions.map((mission) => {
                    const stats = missionStats[mission.id] ?? { done: 0, failed: 0, running: 0, total: 0 };
                    return (
                      <MissionRow
                        key={mission.id}
                        mission={mission}
                        doneCount={stats.done}
                        failedCount={stats.failed}
                        runningCount={stats.running}
                        totalCount={stats.total}
                        onExecute={() => handleAction(() => executeMission(mission.id), "Mission executed")}
                        onResume={() => handleAction(() => resumeMission(mission.id), "Mission resumed")}
                        onAbort={() => handleAction(() => abortMission(mission.id), "Mission aborted")}
                        onClick={() => navigate(`/missions/${mission.id}`)}
                      />
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        </ScrollArea>
      )}
    </div>
  );
}
