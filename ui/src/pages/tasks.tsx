import { useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import {
  Card,
  CardContent,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,

  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  CheckCircle2,
  Clock,
  AlertTriangle,
  Loader2,
  RotateCcw,
  XCircle,
  Search,
  RefreshCw,
  Eye,
  Star,
  ListChecks,
  Bot,
  GitBranch,
  Wrench,
  HelpCircle,
  Hammer,
  Zap,
  FileEdit,
  Filter,
  LayoutList,
  Columns3,
  Target,
  Users,
  Check,
  ArrowUpDown,
  Layers,
  ChevronRight,
  ChevronDown,
  Calendar,
} from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { useTasks, usePolpo, useProcesses, useMissions, useAgents } from "@lumea-labs/polpo-react";
import type { Task, TaskStatus, AgentProcess } from "@lumea-labs/polpo-react";
import { Skeleton } from "@/components/ui/skeleton";
import { useAsyncAction } from "@/hooks/use-polpo";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";
import { cn } from "@/lib/utils";

// ── Status config ──

const statusConfig: Record<
  TaskStatus,
  { icon: React.ElementType; color: string; bg: string; label: string }
> = {
  draft: { icon: FileEdit, color: "text-zinc-500", bg: "bg-zinc-500/10", label: "Draft" },
  pending: { icon: Clock, color: "text-zinc-400", bg: "bg-zinc-500/10", label: "Queued" },
  awaiting_approval: { icon: Clock, color: "text-amber-400", bg: "bg-amber-500/10", label: "Awaiting Approval" },
  assigned: { icon: Clock, color: "text-violet-400", bg: "bg-violet-500/10", label: "Assigned" },
  in_progress: { icon: Loader2, color: "text-blue-400", bg: "bg-blue-500/10", label: "Running" },
  review: { icon: Eye, color: "text-amber-400", bg: "bg-amber-500/10", label: "Review" },
  done: { icon: CheckCircle2, color: "text-emerald-400", bg: "bg-emerald-500/10", label: "Done" },
  failed: { icon: AlertTriangle, color: "text-red-400", bg: "bg-red-500/10", label: "Failed" },
};

const phaseConfig: Record<string, { icon: React.ElementType; label: string; color: string }> = {
  execution: { icon: Loader2, label: "Executing", color: "text-blue-400" },
  review: { icon: Eye, label: "Reviewing", color: "text-amber-400" },
  fix: { icon: Hammer, label: "Fixing", color: "text-orange-400" },
  clarification: { icon: HelpCircle, label: "Clarifying", color: "text-purple-400" },
};

// ── Kanban columns (ordering) ──

const statusKanbanColumns: { key: string; label: string; filter: (t: Task) => boolean }[] = [
  { key: "draft", label: "Draft", filter: (t) => t.status === "draft" },
  { key: "queued", label: "Queued", filter: (t) => t.status === "pending" || t.status === "assigned" },
  { key: "in_progress", label: "Running", filter: (t) => t.status === "in_progress" },
  { key: "review", label: "Review", filter: (t) => t.status === "review" },
  { key: "done", label: "Done", filter: (t) => t.status === "done" },
  { key: "failed", label: "Failed", filter: (t) => t.status === "failed" },
];

// ── Column-by modes for Kanban ──

type ColumnByKey = "status" | "mission" | "team" | "agent";

const columnByOptions: { value: ColumnByKey; label: string; icon: React.ElementType }[] = [
  { value: "status", label: "Status", icon: Columns3 },
  { value: "mission", label: "Mission", icon: Target },
  { value: "team", label: "Team", icon: Users },
  { value: "agent", label: "Agent", icon: Bot },
];

interface DynamicColumn {
  key: string;
  label: string;
  filter: (t: Task) => boolean;
}

function buildDynamicColumns(
  mode: ColumnByKey,
  tasks: Task[],
  agentTeamMap: Record<string, string>,
): DynamicColumn[] {
  switch (mode) {
    case "status":
      return statusKanbanColumns;
    case "mission": {
      const groups = new Set<string>();
      let hasUngrouped = false;
      for (const t of tasks) {
        if (t.group) groups.add(t.group);
        else hasUngrouped = true;
      }
      const cols: DynamicColumn[] = Array.from(groups)
        .sort((a, b) => a.localeCompare(b))
        .map((g) => ({ key: `mission:${g}`, label: g, filter: (t: Task) => t.group === g }));
      if (hasUngrouped) {
        cols.push({ key: "mission:__none__", label: "No mission", filter: (t: Task) => !t.group });
      }
      return cols.length > 0 ? cols : [{ key: "mission:__all__", label: "All tasks", filter: () => true }];
    }
    case "team": {
      const teamNames = new Set<string>();
      let hasUnmapped = false;
      for (const t of tasks) {
        const team = agentTeamMap[t.assignTo];
        if (team) teamNames.add(team);
        else hasUnmapped = true;
      }
      const cols: DynamicColumn[] = Array.from(teamNames)
        .sort((a, b) => a.localeCompare(b))
        .map((name) => ({ key: `team:${name}`, label: name, filter: (t: Task) => agentTeamMap[t.assignTo] === name }));
      if (hasUnmapped) {
        cols.push({ key: "team:__none__", label: "No team", filter: (t: Task) => !agentTeamMap[t.assignTo] });
      }
      return cols.length > 0 ? cols : [{ key: "team:__all__", label: "All tasks", filter: () => true }];
    }
    case "agent": {
      const agents = new Set<string>();
      for (const t of tasks) agents.add(t.assignTo);
      const cols: DynamicColumn[] = Array.from(agents)
        .sort((a, b) => a.localeCompare(b))
        .map((name) => ({ key: `agent:${name}`, label: name, filter: (t: Task) => t.assignTo === name }));
      return cols.length > 0 ? cols : [{ key: "agent:__all__", label: "All tasks", filter: () => true }];
    }
    default:
      return statusKanbanColumns;
  }
}

// ── Sort options ──

type SortKey = "updated" | "created" | "name" | "status" | "priority" | "score";

const sortOptions: { value: SortKey; label: string }[] = [
  { value: "updated", label: "Last updated" },
  { value: "created", label: "Created" },
  { value: "name", label: "Name" },
  { value: "status", label: "Status" },
  { value: "priority", label: "Priority" },
  { value: "score", label: "Score" },
];

const statusOrder: Record<TaskStatus, number> = {
  in_progress: 0,
  review: 1,
  awaiting_approval: 2,
  assigned: 3,
  pending: 4,
  draft: 5,
  failed: 6,
  done: 7,
};

function sortTasks(tasks: Task[], key: SortKey): Task[] {
  const sorted = [...tasks];
  switch (key) {
    case "updated":
      return sorted.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    case "created":
      return sorted.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    case "name":
      return sorted.sort((a, b) => a.title.localeCompare(b.title));
    case "status":
      return sorted.sort((a, b) => (statusOrder[a.status] ?? 99) - (statusOrder[b.status] ?? 99));
    case "priority":
      return sorted.sort((a, b) => (b.priority ?? 1) - (a.priority ?? 1)); // higher first
    case "score": {
      return sorted.sort((a, b) => {
        const sa = a.result?.assessment?.globalScore ?? -1;
        const sb = b.result?.assessment?.globalScore ?? -1;
        return sb - sa; // higher first
      });
    }
    default:
      return sorted;
  }
}

// ── Mission filter popover ──

function MissionFilter({
  missions,
  selected,
  onToggle,
}: {
  missions: { id: string; name: string }[];
  selected: Set<string>;
  onToggle: (name: string) => void;
}) {
  const hasFilter = selected.size > 0;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant={hasFilter ? "default" : "outline"} size="sm" className="gap-1.5">
          <Filter className="h-3.5 w-3.5" />
          Missions
          {hasFilter && (
            <Badge variant="secondary" className="text-[9px] ml-1">{selected.size}</Badge>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-2" align="start">
        <div className="space-y-1 max-h-64 overflow-y-auto">
          {missions.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-3">No missions</p>
          ) : (
            missions.map((p) => (
              <button
                key={p.name}
                className={cn(
                  "flex items-center gap-2 w-full rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                  selected.has(p.name) ? "bg-accent text-accent-foreground" : "hover:bg-muted"
                )}
                onClick={() => onToggle(p.name)}
              >
                <div className={cn(
                  "flex h-4 w-4 shrink-0 items-center justify-center rounded border",
                  selected.has(p.name) ? "bg-primary border-primary" : "border-muted-foreground/30"
                )}>
                  {selected.has(p.name) && <Check className="h-3 w-3 text-primary-foreground" />}
                </div>
                <Target className="h-3 w-3 text-muted-foreground shrink-0" />
                <span className="truncate">{p.name}</span>
              </button>
            ))
          )}
        </div>
        {hasFilter && (
          <Button
            variant="ghost"
            size="sm"
            className="w-full mt-1 text-xs"
            onClick={() => missions.forEach(p => { if (selected.has(p.name)) onToggle(p.name); })}
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
  teams,
  selected,
  onToggle,
  isLoading,
}: {
  teams: { name: string }[];
  selected: Set<string>;
  onToggle: (name: string) => void;
  isLoading?: boolean;
}) {
  const hasFilter = selected.size > 0;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant={hasFilter ? "default" : "outline"} size="sm" className="gap-1.5">
          <Users className="h-3.5 w-3.5" />
          Teams
          {hasFilter && (
            <Badge variant="secondary" className="text-[9px] ml-1">{selected.size}</Badge>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-2" align="start">
        <div className="space-y-1 max-h-64 overflow-y-auto">
          {isLoading ? (
            <div className="space-y-2 py-1">
              <Skeleton className="h-7 w-full rounded-md" />
              <Skeleton className="h-7 w-full rounded-md" />
              <Skeleton className="h-7 w-3/4 rounded-md" />
            </div>
          ) : teams.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-3">No teams</p>
          ) : (
            teams.map((t) => (
              <button
                key={t.name}
                className={cn(
                  "flex items-center gap-2 w-full rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                  selected.has(t.name) ? "bg-accent text-accent-foreground" : "hover:bg-muted"
                )}
                onClick={() => onToggle(t.name)}
              >
                <div className={cn(
                  "flex h-4 w-4 shrink-0 items-center justify-center rounded border",
                  selected.has(t.name) ? "bg-primary border-primary" : "border-muted-foreground/30"
                )}>
                  {selected.has(t.name) && <Check className="h-3 w-3 text-primary-foreground" />}
                </div>
                <Users className="h-3 w-3 text-muted-foreground shrink-0" />
                <span className="truncate">{t.name}</span>
              </button>
            ))
          )}
        </div>
        {hasFilter && (
          <Button
            variant="ghost"
            size="sm"
            className="w-full mt-1 text-xs"
            onClick={() => teams.forEach(t => { if (selected.has(t.name)) onToggle(t.name); })}
          >
            Clear all
          </Button>
        )}
      </PopoverContent>
    </Popover>
  );
}

// ── Time filter ──

type TimeField = "createdAt" | "updatedAt";

const timeFieldOptions: { value: TimeField; label: string }[] = [
  { value: "createdAt", label: "Created" },
  { value: "updatedAt", label: "Updated" },
];

type TimeRange = "1h" | "6h" | "24h" | "7d" | "30d" | "custom";

const timeRangePresets: { value: TimeRange; label: string; ms: number }[] = [
  { value: "1h", label: "Last hour", ms: 60 * 60 * 1000 },
  { value: "6h", label: "Last 6 hours", ms: 6 * 60 * 60 * 1000 },
  { value: "24h", label: "Last 24 hours", ms: 24 * 60 * 60 * 1000 },
  { value: "7d", label: "Last 7 days", ms: 7 * 24 * 60 * 60 * 1000 },
  { value: "30d", label: "Last 30 days", ms: 30 * 24 * 60 * 60 * 1000 },
];

interface TimeFilterState {
  field: TimeField;
  range: TimeRange;
  /** Epoch ms — resolved from preset or custom input */
  after: number;
}

function TimeFilter({
  value,
  onChange,
  onClear,
}: {
  value: TimeFilterState | null;
  onChange: (v: TimeFilterState) => void;
  onClear: () => void;
}) {
  const hasFilter = value !== null;
  const [field, setField] = useState<TimeField>(value?.field ?? "updatedAt");

  const applyPreset = (preset: (typeof timeRangePresets)[number]) => {
    onChange({ field, range: preset.value, after: Date.now() - preset.ms });
  };

  const activePresetLabel = value
    ? timeRangePresets.find(p => p.value === value.range)?.label ?? value.range
    : null;
  const activeFieldLabel = value
    ? timeFieldOptions.find(f => f.value === value.field)?.label ?? value.field
    : null;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant={hasFilter ? "default" : "outline"} size="sm" className="gap-1.5">
          <Calendar className="h-3.5 w-3.5" />
          {hasFilter ? `${activeFieldLabel}: ${activePresetLabel}` : "Time"}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-2" align="start">
        {/* Field selector */}
        <div className="flex items-center gap-1 mb-2">
          {timeFieldOptions.map((opt) => (
            <Button
              key={opt.value}
              variant={field === opt.value ? "default" : "ghost"}
              size="sm"
              className="h-6 text-[10px] flex-1"
              onClick={() => setField(opt.value)}
            >
              {opt.label}
            </Button>
          ))}
        </div>

        {/* Range presets */}
        <div className="space-y-0.5">
          {timeRangePresets.map((preset) => (
            <button
              key={preset.value}
              className={cn(
                "flex items-center gap-2 w-full rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                value?.range === preset.value && value?.field === field
                  ? "bg-accent text-accent-foreground"
                  : "hover:bg-muted",
              )}
              onClick={() => applyPreset(preset)}
            >
              <div className={cn(
                "flex h-4 w-4 shrink-0 items-center justify-center rounded-full border",
                value?.range === preset.value && value?.field === field
                  ? "bg-primary border-primary"
                  : "border-muted-foreground/30",
              )}>
                {value?.range === preset.value && value?.field === field && (
                  <Check className="h-2.5 w-2.5 text-primary-foreground" />
                )}
              </div>
              <span>{preset.label}</span>
            </button>
          ))}
        </div>

        {hasFilter && (
          <Button variant="ghost" size="sm" className="w-full mt-1 text-xs" onClick={onClear}>
            Clear
          </Button>
        )}
      </PopoverContent>
    </Popover>
  );
}

// ── Compact task card (used in both list and kanban) ──

function TaskCard({
  task,
  process,
  compact,
  allTasks,
  onRetry,
  onKill,
  onQueue,
  onClick,
}: {
  task: Task;
  process?: AgentProcess;
  compact?: boolean;
  allTasks?: Task[];
  onRetry: () => void;
  onKill: () => void;
  onQueue?: () => void;
  onClick: () => void;
}) {
  const cfg = statusConfig[task.status];
  const Icon = cfg.icon;
  const assessment = task.result?.assessment;
  const phase = task.phase && task.phase !== "execution" ? phaseConfig[task.phase] : null;

  // Check if task is blocked by unresolved dependencies
  const unresolvedDeps = task.dependsOn.filter((depId) => {
    const dep = allTasks?.find(t => t.id === depId);
    return !dep || dep.status !== "done";
  });
  const isBlocked = unresolvedDeps.length > 0 && (task.status === "pending" || task.status === "assigned");

   return (
    <div
      className={cn(
        "group rounded-lg border border-border/40 bg-card/80 backdrop-blur-sm transition-all cursor-pointer",
        "hover:border-primary/20 hover:shadow-[0_0_15px_oklch(0.7_0.15_200_/_8%)]",
        "w-full max-w-full overflow-hidden box-border",
        compact && "p-2.5",
        !compact && "p-3",
      )}
      onClick={onClick}
    >
      <div className="flex items-start gap-2 w-full min-w-0">
        <div className={cn("flex shrink-0 items-center justify-center rounded-md mt-0.5", compact ? "h-6 w-6" : "h-7 w-7", cfg.bg)}>
          <Icon className={cn(compact ? "h-3 w-3" : "h-3.5 w-3.5", cfg.color, task.status === "in_progress" && "animate-spin")} />
        </div>
        <div className="min-w-0 flex-1">
          <p className={cn("font-medium leading-snug", compact ? "text-xs" : "text-sm")} style={{ overflowWrap: "anywhere", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{task.title}</p>
          {phase && (
            <Badge variant="outline" className={cn("text-[8px] gap-0.5 px-1 py-0 mt-0.5 inline-flex", phase.color)}>
              <phase.icon className="h-2 w-2" />
              {phase.label}
            </Badge>
          )}
          <div className="flex items-center gap-1.5 mt-1 flex-wrap min-w-0">
            <span className="text-[10px] text-muted-foreground inline-flex items-center gap-0.5 max-w-full min-w-0">
              <Bot className="h-2.5 w-2.5 shrink-0" />
              <span className="truncate">{task.assignTo}</span>
            </span>
            {task.group && (
              <Badge variant="secondary" className="text-[8px] px-1 py-0 max-w-full truncate">{task.group}</Badge>
            )}
            <span className="text-[10px] text-muted-foreground whitespace-nowrap">
              {formatDistanceToNow(new Date(task.updatedAt), { addSuffix: true })}
            </span>
          </div>
          {/* Indicators row */}
          <div className="flex items-center gap-1 mt-1 flex-wrap">
            {assessment?.globalScore != null && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className={cn(
                    "flex items-center gap-0.5 rounded px-1.5 py-0.5",
                    assessment.passed ? "bg-emerald-500/10" : "bg-red-500/10"
                  )}>
                    <Star className={cn("h-2.5 w-2.5", assessment.passed ? "text-emerald-500" : "text-red-500")} />
                    <span className={cn("text-[10px] font-bold", assessment.passed ? "text-emerald-500" : "text-red-500")}>
                      {assessment.globalScore.toFixed(1)}
                    </span>
                  </div>
                </TooltipTrigger>
                <TooltipContent className="text-xs">
                  {assessment.passed ? "Passed" : "Failed"} — {assessment.checks.length} check{assessment.checks.length !== 1 ? "s" : ""}
                </TooltipContent>
              </Tooltip>
            )}
            {task.retries > 0 && (
              <Badge variant="secondary" className="text-[9px] px-1 py-0">
                <RotateCcw className="h-2 w-2 mr-0.5" />{task.retries}
              </Badge>
            )}
            {task.dependsOn.length > 0 && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Badge
                    variant={isBlocked ? "destructive" : "outline"}
                    className={cn("text-[9px] px-1 py-0 cursor-help", isBlocked && "bg-amber-500/15 text-amber-500 border-amber-500/30 hover:bg-amber-500/20")}
                  >
                    <GitBranch className="h-2 w-2 mr-0.5" />
                    {isBlocked ? `Blocked (${unresolvedDeps.length})` : task.dependsOn.length}
                  </Badge>
                </TooltipTrigger>
                <TooltipContent className="text-xs max-w-xs">
                  <p className="font-medium mb-1">{isBlocked ? "Waiting for:" : "Depends on:"}</p>
                  {task.dependsOn.map((depId) => {
                    const dep = allTasks?.find(t => t.id === depId);
                    const done = dep?.status === "done";
                    return (
                      <p key={depId} className={done ? "text-muted-foreground line-through" : ""}>
                        {done ? "✓" : "○"} {dep ? dep.title : depId}
                      </p>
                    );
                  })}
                </TooltipContent>
              </Tooltip>
            )}
            {task.expectations.length > 0 && !assessment && (
              <Badge variant="outline" className="text-[9px] px-1 py-0">
                <Wrench className="h-2 w-2 mr-0.5" />{task.expectations.length}
              </Badge>
            )}
          </div>
        </div>
      </div>

      {/* Live activity strip for running tasks */}
      {process && (
        <div className="mt-2 pt-2 border-t border-primary/10 space-y-1 min-w-0 overflow-hidden">
          <div className="flex items-center gap-2 min-w-0">
            <div className="h-1.5 w-1.5 rounded-full bg-primary animate-pulse shrink-0" />
            {process.activity.lastTool && (
              <Badge variant="outline" className="text-[8px] font-mono px-1 py-0 text-primary border-primary/30 min-w-0 truncate">
                <Wrench className="h-2 w-2 mr-0.5 shrink-0" /><span className="truncate">{process.activity.lastTool}</span>
              </Badge>
            )}
            <div className="flex items-center gap-2 ml-auto shrink-0">
              {process.activity.toolCalls > 0 && (
                <span className="text-[10px] text-muted-foreground flex items-center gap-0.5">
                  <Zap className="h-2.5 w-2.5" />{process.activity.toolCalls}
                </span>
              )}
              {(process.activity.filesCreated.length + process.activity.filesEdited.length) > 0 && (
                <span className="text-[10px] text-muted-foreground flex items-center gap-0.5">
                  <FileEdit className="h-2.5 w-2.5" />{process.activity.filesCreated.length + process.activity.filesEdited.length}
                </span>
              )}
            </div>
          </div>
          {process.activity.lastFile && (
            <p className="text-[10px] font-mono text-muted-foreground truncate pl-3.5">
              {process.activity.lastFile}
            </p>
          )}
        </div>
      )}

      {/* Inline actions — only on hover, stop propagation */}
      <div className="flex items-center gap-1 mt-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
        {task.status === "draft" && onQueue && (
          <Button variant="ghost" size="sm" className="h-5 px-1.5 text-[10px] text-muted-foreground hover:text-blue-400" onClick={(e) => { e.stopPropagation(); onQueue(); }}>
            <Zap className="h-2.5 w-2.5 mr-0.5" /> Queue
          </Button>
        )}
        {task.status === "failed" && (
          <Button variant="ghost" size="sm" className="h-5 px-1.5 text-[10px] text-muted-foreground hover:text-amber-400" onClick={(e) => { e.stopPropagation(); onRetry(); }}>
            <RotateCcw className="h-2.5 w-2.5 mr-0.5" /> Retry
          </Button>
        )}
        {(task.status === "in_progress" || task.status === "assigned") && (
          <Button variant="ghost" size="sm" className="h-5 px-1.5 text-[10px] text-muted-foreground hover:text-red-400" onClick={(e) => { e.stopPropagation(); onKill(); }}>
            <XCircle className="h-2.5 w-2.5 mr-0.5" /> Kill
          </Button>
        )}
      </div>
    </div>
  );
}

// ── Group-by logic ──

type GroupByKey = "none" | "status" | "mission" | "team" | "agent";

const groupByOptions: { value: GroupByKey; label: string; icon: React.ElementType }[] = [
  { value: "none", label: "None", icon: Layers },
  { value: "status", label: "Status", icon: Columns3 },
  { value: "mission", label: "Mission", icon: Target },
  { value: "team", label: "Team", icon: Users },
  { value: "agent", label: "Agent", icon: Bot },
];

const groupByIcons: Record<string, React.ElementType> = {
  status: Columns3,
  mission: Target,
  team: Users,
  agent: Bot,
};

function groupTasksBy(
  tasks: Task[],
  mode: GroupByKey,
  agentTeamMap: Record<string, string>,
): Record<string, Task[]> | null {
  if (mode === "none") return null;
  const groups: Record<string, Task[]> = {};
  for (const task of tasks) {
    let key: string;
    switch (mode) {
      case "status":
        key = task.status;
        break;
      case "mission":
        key = task.group || "__ungrouped__";
        break;
      case "team":
        key = agentTeamMap[task.assignTo] || "__ungrouped__";
        break;
      case "agent":
        key = task.assignTo;
        break;
      default:
        key = "__ungrouped__";
    }
    if (!groups[key]) groups[key] = [];
    groups[key].push(task);
  }
  return groups;
}

function getGroupLabel(mode: GroupByKey, key: string): string {
  if (key === "__ungrouped__") {
    switch (mode) {
      case "mission": return "No mission";
      case "team": return "No team";
      default: return "Ungrouped";
    }
  }
  if (mode === "status") {
    return statusConfig[key as TaskStatus]?.label ?? key;
  }
  return key;
}

// ── Collapsible group block (generic) ──

function GroupBlock({
  label,
  icon: GroupIcon,
  tasks,
  processes,
  allTasks,
  onRetry,
  onKill,
  onQueue,
  onClick,
}: {
  label: string;
  icon: React.ElementType;
  tasks: Task[];
  processes: AgentProcess[];
  allTasks: Task[];
  onRetry: (id: string) => void;
  onKill: (id: string) => void;
  onQueue: (id: string) => void;
  onClick: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);

  const running = tasks.filter(t => t.status === "in_progress").length;
  const done = tasks.filter(t => t.status === "done").length;
  const failed = tasks.filter(t => t.status === "failed").length;

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="w-full max-w-full overflow-hidden">
      <CollapsibleTrigger asChild>
        <button
          className={cn(
            "w-full max-w-full rounded-lg border border-border/40 bg-card/80 backdrop-blur-sm transition-all cursor-pointer overflow-hidden box-border",
            "hover:border-primary/20 hover:shadow-[0_0_15px_oklch(0.7_0.15_200_/_8%)]",
            "p-2.5 text-left",
          )}
        >
          <div className="flex items-center gap-2 min-w-0">
            {open ? (
              <ChevronDown className="h-3 w-3 text-muted-foreground shrink-0" />
            ) : (
              <ChevronRight className="h-3 w-3 text-muted-foreground shrink-0" />
            )}
            <GroupIcon className="h-3 w-3 text-primary/70 shrink-0" />
            <span className="text-xs font-medium truncate min-w-0 flex-1">{label}</span>
            <Badge variant="secondary" className="text-[9px] shrink-0">{tasks.length}</Badge>
          </div>
          {/* Mini status summary */}
          <div className="flex items-center gap-2 mt-1 pl-5">
            {running > 0 && (
              <span className="text-[9px] text-blue-400 flex items-center gap-0.5">
                <Loader2 className="h-2 w-2 animate-spin" />{running}
              </span>
            )}
            {done > 0 && (
              <span className="text-[9px] text-emerald-400 flex items-center gap-0.5">
                <CheckCircle2 className="h-2 w-2" />{done}
              </span>
            )}
            {failed > 0 && (
              <span className="text-[9px] text-red-400 flex items-center gap-0.5">
                <AlertTriangle className="h-2 w-2" />{failed}
              </span>
            )}
          </div>
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent className="overflow-hidden">
        <div className="space-y-1.5 pt-1.5 pl-2 overflow-hidden">
          {tasks.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              process={processes.find(p => p.taskId === task.id)}
              compact
              allTasks={allTasks}
              onRetry={() => onRetry(task.id)}
              onKill={() => onKill(task.id)}
              onQueue={() => onQueue(task.id)}
              onClick={() => onClick(task.id)}
            />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

// ── Kanban board ──

function KanbanColumn({
  col,
  tasks,
  allTasks,
  processes,
  groupBy,
  columnBy,
  agentTeamMap,
  onRetry,
  onKill,
  onQueue,
  onClick,
}: {
  col: DynamicColumn;
  tasks: Task[];
  allTasks: Task[];
  processes: AgentProcess[];
  groupBy: GroupByKey;
  columnBy: ColumnByKey;
  agentTeamMap: Record<string, string>;
  onRetry: (id: string) => void;
  onKill: (id: string) => void;
  onQueue: (id: string) => void;
  onClick: (id: string) => void;
}) {
  const colTasks = useMemo(() => tasks.filter(col.filter), [tasks, col]);

  // Status dot color — resolve from statusConfig when column-by is status
  const statusKey = col.key === "queued" ? "pending" : col.key;
  const colCfg = columnBy === "status" && statusKey in statusConfig
    ? statusConfig[statusKey as TaskStatus]
    : null;

  // Effective groupBy: skip if same dimension as columns (redundant)
  const effectiveGroupBy = groupBy === columnBy ? "none" : groupBy;

  const groups = useMemo(
    () => groupTasksBy(colTasks, effectiveGroupBy, agentTeamMap),
    [colTasks, effectiveGroupBy, agentTeamMap],
  );

  const GroupIcon = effectiveGroupBy !== "none" ? (groupByIcons[effectiveGroupBy] ?? Layers) : Layers;

  return (
    <div className="flex flex-col w-[260px] min-w-[260px] max-w-[260px] shrink-0 overflow-hidden">
      {/* Column header */}
      <div className="flex items-center gap-2 px-2 pb-2 shrink-0 border-t-2 border-border/30 pt-2 min-w-0">
        {colCfg ? (
          <div className={cn("h-2 w-2 rounded-full shrink-0", colCfg.bg.replace("bg-", "bg-").replace("/10", ""))} style={{
            backgroundColor: `hsl(var(--${colCfg.color.replace("text-", "").replace("-400", "")}))`,
          }} />
        ) : (
          <div className="h-2 w-2 rounded-full bg-muted-foreground/40 shrink-0" />
        )}
        <span className="text-xs font-medium truncate">{col.label}</span>
        <Badge variant="secondary" className="text-[9px] ml-auto shrink-0">{colTasks.length}</Badge>
      </div>

      {/* Column body — [&>div>div]:!block overrides Radix ScrollArea viewport's display:table that causes width overflow */}
      <ScrollArea className="flex-1 min-h-0 [&>div>div]:!block">
        <div className="space-y-1.5 px-1 pb-1">
          {colTasks.length === 0 ? (
            <div className="flex items-center justify-center py-8 text-muted-foreground/60">
              <p className="text-[10px]">No tasks</p>
            </div>
          ) : groups ? (
            Object.entries(groups).map(([groupName, groupTasks]) => (
              <GroupBlock
                key={groupName}
                label={getGroupLabel(effectiveGroupBy, groupName)}
                icon={GroupIcon}
                tasks={groupTasks}
                processes={processes}
                allTasks={allTasks}
                onRetry={onRetry}
                onKill={onKill}
                onQueue={onQueue}
                onClick={onClick}
              />
            ))
          ) : (
            colTasks.map((task) => (
              <TaskCard
                key={task.id}
                task={task}
                process={processes.find(p => p.taskId === task.id)}
                compact
                allTasks={allTasks}
                onRetry={() => onRetry(task.id)}
                onKill={() => onKill(task.id)}
                onQueue={() => onQueue(task.id)}
                onClick={() => onClick(task.id)}
              />
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

function KanbanBoard({
  tasks,
  processes,
  groupBy,
  columnBy,
  agentTeamMap,
  onRetry,
  onKill,
  onQueue,
  onClick,
}: {
  tasks: Task[];
  processes: AgentProcess[];
  groupBy: GroupByKey;
  columnBy: ColumnByKey;
  agentTeamMap: Record<string, string>;
  onRetry: (id: string) => void;
  onKill: (id: string) => void;
  onQueue: (id: string) => void;
  onClick: (id: string) => void;
}) {
  const columns = useMemo(
    () => buildDynamicColumns(columnBy, tasks, agentTeamMap),
    [columnBy, tasks, agentTeamMap],
  );

  return (
    <div className="flex gap-3 flex-1 min-h-0 overflow-x-auto pb-2">
      {columns.map((col) => (
        <KanbanColumn
          key={col.key}
          col={col}
          tasks={tasks}
          allTasks={tasks}
          processes={processes}
          groupBy={groupBy}
          columnBy={columnBy}
          agentTeamMap={agentTeamMap}
          onRetry={onRetry}
          onKill={onKill}
          onQueue={onQueue}
          onClick={onClick}
        />
      ))}
    </div>
  );
}

// ── List view with status tabs ──

function ListView({
  tasks,
  processes,
  onRetry,
  onKill,
  onQueue,
  onClick,
}: {
  tasks: Task[];
  processes: AgentProcess[];
  onRetry: (id: string) => void;
  onKill: (id: string) => void;
  onQueue: (id: string) => void;
  onClick: (id: string) => void;
}) {
  const [tab, setTab] = useState("all");

  const filtered = tasks
    .filter((t) => {
      if (tab === "pending") return t.status === "pending" || t.status === "assigned";
      if (tab !== "all" && t.status !== tab) return false;
      return true;
    });

  const counts = {
    all: tasks.length,
    pending: tasks.filter(t => t.status === "pending" || t.status === "assigned").length,
    in_progress: tasks.filter(t => t.status === "in_progress").length,
    review: tasks.filter(t => t.status === "review").length,
    done: tasks.filter(t => t.status === "done").length,
    failed: tasks.filter(t => t.status === "failed").length,
  };

  const tabs = [
    { value: "all", label: "All", count: counts.all },
    { value: "in_progress", label: "Running", count: counts.in_progress },
    { value: "review", label: "Review", count: counts.review },
    { value: "done", label: "Done", count: counts.done },
    { value: "failed", label: "Failed", count: counts.failed },
    { value: "pending", label: "Queued", count: counts.pending },
  ];

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-3">
      {/* Tab bar */}
      <div className="flex items-center gap-1 shrink-0 overflow-x-auto scrollbar-none pb-1">
        {tabs.map((t) => (
          <Button
            key={t.value}
            variant={tab === t.value ? "default" : "ghost"}
            size="sm"
            className="h-7 text-xs gap-1.5 shrink-0"
            onClick={() => setTab(t.value)}
          >
            {t.label}
            <Badge variant="secondary" className="text-[9px]">{t.count}</Badge>
          </Button>
        ))}
      </div>

      {/* Task list */}
      <ScrollArea className="flex-1 min-h-0 -mx-1">
        <div className="space-y-1.5 px-1 pr-5 pb-1">
          {filtered.length === 0 ? (
            <Card className="bg-card/60 backdrop-blur-sm">
              <CardContent className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                <ListChecks className="h-10 w-10 mb-3 opacity-40" />
                <p className="text-sm font-medium">
                  {tab !== "all" ? "No tasks in this category" : "No tasks yet"}
                </p>
                {tab === "all" && (
                  <p className="text-xs mt-1 text-center max-w-xs">
                    Tasks are created when a mission is executed. Use the TUI or Chat to create and run a mission.
                  </p>
                )}
              </CardContent>
            </Card>
          ) : (
            filtered.map((task) => (
              <TaskCard
                key={task.id}
                task={task}
                process={processes.find(p => p.taskId === task.id)}
                allTasks={tasks}
                onRetry={() => onRetry(task.id)}
                onKill={() => onKill(task.id)}
                onQueue={() => onQueue(task.id)}
                onClick={() => onClick(task.id)}
              />
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

// ── Main page ──

type ViewMode = "list" | "kanban";

export function TasksPage() {
  const navigate = useNavigate();
  const { tasks, isLoading: loading, refetch, retryTask } = useTasks();
  const { processes } = useProcesses();
  const { client } = usePolpo();
  const { missions } = useMissions();
  const { teams, isLoading: teamsLoading } = useAgents();
  const [search, setSearch] = useState("");
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    return (localStorage.getItem("polpo-tasks-view") as ViewMode) ?? "list";
  });
  const [selectedMissions, setSelectedMissions] = useState<Set<string>>(new Set());
  const [selectedTeams, setSelectedTeams] = useState<Set<string>>(new Set());
  const [sortKey, setSortKey] = useState<SortKey>(() => {
    return (localStorage.getItem("polpo-tasks-sort") as SortKey) ?? "updated";
  });
  const [groupBy, setGroupBy] = useState<GroupByKey>(() => {
    // Migrate old boolean setting
    const legacy = localStorage.getItem("polpo-tasks-group-mission");
    if (legacy !== null) {
      localStorage.removeItem("polpo-tasks-group-mission");
      const val = legacy === "true" ? "mission" : "none";
      localStorage.setItem("polpo-tasks-group-by", val);
      return val as GroupByKey;
    }
    return (localStorage.getItem("polpo-tasks-group-by") as GroupByKey) ?? "mission";
  });
  const [columnBy, setColumnBy] = useState<ColumnByKey>(() => {
    return (localStorage.getItem("polpo-tasks-column-by") as ColumnByKey) ?? "status";
  });
  const [timeFilter, setTimeFilter] = useState<TimeFilterState | null>(null);

  const setView = (mode: ViewMode) => {
    setViewMode(mode);
    localStorage.setItem("polpo-tasks-view", mode);
  };

  const toggleMission = (name: string) => {
    setSelectedMissions(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const toggleTeam = (name: string) => {
    setSelectedTeams(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  // Map agent name → team name for team filtering
  const agentTeamMap = useMemo(() => {
    const m: Record<string, string> = {};
    for (const team of teams) {
      for (const agent of team.agents) {
        m[agent.name] = team.name;
      }
    }
    return m;
  }, [teams]);

  const killTask = async (id: string) => { await client.killTask(id); refetch(); };
  const queueTask = async (id: string) => { await client.queueTask(id); refetch(); };

  const [handleRefresh, isRefreshing] = useAsyncAction(async () => {
    await refetch();
  });

  const handleAction = async (action: (id: string) => Promise<void>, id: string, label: string) => {
    try {
      await action(id);
      toast.success(`Task ${label}`);
      refetch();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const setSort = (key: SortKey) => {
    setSortKey(key);
    localStorage.setItem("polpo-tasks-sort", key);
  };

  const changeGroupBy = (key: GroupByKey) => {
    setGroupBy(key);
    localStorage.setItem("polpo-tasks-group-by", key);
  };

  const changeColumnBy = (key: ColumnByKey) => {
    setColumnBy(key);
    localStorage.setItem("polpo-tasks-column-by", key);
  };

  // Filtered + sorted tasks by search + mission filter + team filter + time filter
  const filtered = useMemo(() => {
    const result = tasks.filter(t => {
      // Mission filter
      if (selectedMissions.size > 0 && !selectedMissions.has(t.group ?? "")) {
        return false;
      }
      // Team filter
      if (selectedTeams.size > 0) {
        const agentTeam = agentTeamMap[t.assignTo];
        if (!agentTeam || !selectedTeams.has(agentTeam)) return false;
      }
      // Time filter
      if (timeFilter) {
        const ts = new Date(t[timeFilter.field]).getTime();
        if (ts < timeFilter.after) return false;
      }
      // Search filter
      if (search) {
        const q = search.toLowerCase();
        return (
          t.title.toLowerCase().includes(q) ||
          t.assignTo.toLowerCase().includes(q) ||
          (t.group ?? "").toLowerCase().includes(q)
        );
      }
      return true;
    });
    return sortTasks(result, sortKey);
  }, [tasks, search, selectedMissions, selectedTeams, agentTeamMap, sortKey, timeFilter]);

  // Unique mission names for the filter
  const missionOptions = useMemo((): { name: string; id: string }[] => {
    const names: Record<string, string> = {};
    for (const p of missions) names[p.name] = p.id;
    // Also include groups from tasks that may not match a mission name
    for (const t of tasks) {
      if (t.group && !(t.group in names)) names[t.group] = "";
    }
    return Object.entries(names).map(([name, id]) => ({ name, id }));
  }, [missions, tasks]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-3">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 lg:gap-3 shrink-0">
        {/* Search */}
        <div className="relative w-full sm:w-64">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            placeholder="Search tasks..."
            className="pl-8 h-8 text-sm bg-input/50 backdrop-blur-sm border-border/40 focus:border-primary/50"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        {/* Mission filter */}
        <MissionFilter
          missions={missionOptions}
          selected={selectedMissions}
          onToggle={toggleMission}
        />

        {/* Team filter */}
        <TeamFilter
          teams={teams}
          selected={selectedTeams}
          onToggle={toggleTeam}
          isLoading={teamsLoading}
        />

        {/* Time filter */}
        <TimeFilter
          value={timeFilter}
          onChange={setTimeFilter}
          onClear={() => setTimeFilter(null)}
        />

        {/* Spacer */}
        <div className="flex-1" />

        {/* Sort */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="h-7 gap-1.5 text-xs">
              <ArrowUpDown className="h-3 w-3" />
              {sortOptions.find(o => o.value === sortKey)?.label ?? "Sort"}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {sortOptions.map((opt) => (
              <DropdownMenuItem
                key={opt.value}
                className={cn("text-xs gap-2", sortKey === opt.value && "font-medium")}
                onClick={() => setSort(opt.value)}
              >
                {sortKey === opt.value && <Check className="h-3 w-3" />}
                {sortKey !== opt.value && <span className="w-3" />}
                {opt.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Kanban-only controls: Columns by + Group by Mission */}
        {viewMode === "kanban" && (
          <>
            {/* Columns by dropdown */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="h-7 gap-1.5 text-xs">
                  <Columns3 className="h-3 w-3" />
                  Columns: {columnByOptions.find(o => o.value === columnBy)?.label ?? "Status"}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {columnByOptions.map((opt) => {
                  const OptIcon = opt.icon;
                  return (
                    <DropdownMenuItem
                      key={opt.value}
                      className={cn("text-xs gap-2", columnBy === opt.value && "font-medium")}
                      onClick={() => changeColumnBy(opt.value)}
                    >
                      {columnBy === opt.value ? <Check className="h-3 w-3" /> : <span className="w-3" />}
                      <OptIcon className="h-3 w-3" />
                      {opt.label}
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuContent>
            </DropdownMenu>

            {/* Group by dropdown */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant={groupBy !== "none" ? "default" : "outline"} size="sm" className="h-7 gap-1.5 text-xs">
                  <Layers className="h-3 w-3" />
                  {groupBy === "none" ? "Group" : `Group: ${groupByOptions.find(o => o.value === groupBy)?.label}`}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {groupByOptions.map((opt) => {
                  const OptIcon = opt.icon;
                  // Skip the option that matches current columnBy (redundant grouping)
                  const isRedundant = opt.value === columnBy;
                  if (isRedundant) return null;
                  return (
                    <DropdownMenuItem
                      key={opt.value}
                      className={cn("text-xs gap-2", groupBy === opt.value && "font-medium")}
                      onClick={() => changeGroupBy(opt.value)}
                    >
                      {groupBy === opt.value ? <Check className="h-3 w-3" /> : <span className="w-3" />}
                      <OptIcon className="h-3 w-3" />
                      {opt.label}
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        )}

        {/* View toggle */}
        <div className="flex items-center rounded-md border border-border/50">
          <Button
            variant={viewMode === "list" ? "default" : "ghost"}
            size="sm"
            className="h-7 px-2 rounded-r-none"
            onClick={() => setView("list")}
          >
            <LayoutList className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant={viewMode === "kanban" ? "default" : "ghost"}
            size="sm"
            className="h-7 px-2 rounded-l-none"
            onClick={() => setView("kanban")}
          >
            <Columns3 className="h-3.5 w-3.5" />
          </Button>
        </div>

        {/* Refresh */}
        <Button variant="outline" size="sm" className="h-7" onClick={handleRefresh} disabled={isRefreshing}>
          <RefreshCw className={cn("h-3.5 w-3.5", isRefreshing && "animate-spin")} />
        </Button>
      </div>

      {/* Active filter indicators */}
      {(selectedMissions.size > 0 || selectedTeams.size > 0 || timeFilter) && (
        <div className="flex items-center gap-2 shrink-0 flex-wrap">
          <span className="text-[10px] text-muted-foreground">Filtering by:</span>
          {Array.from(selectedMissions).map((name) => (
            <Badge
              key={`mission-${name}`}
              variant="secondary"
              className="text-[10px] gap-1 cursor-pointer bg-primary/10 text-primary hover:bg-destructive/20"
              onClick={() => toggleMission(name)}
            >
              <Target className="h-2.5 w-2.5" />
              {name}
              <XCircle className="h-2.5 w-2.5" />
            </Badge>
          ))}
          {Array.from(selectedTeams).map((name) => (
            <Badge
              key={`team-${name}`}
              variant="secondary"
              className="text-[10px] gap-1 cursor-pointer bg-violet-500/10 text-violet-400 hover:bg-destructive/20"
              onClick={() => toggleTeam(name)}
            >
              <Users className="h-2.5 w-2.5" />
              {name}
              <XCircle className="h-2.5 w-2.5" />
            </Badge>
          ))}
          {timeFilter && (
            <Badge
              variant="secondary"
              className="text-[10px] gap-1 cursor-pointer bg-blue-500/10 text-blue-400 hover:bg-destructive/20"
              onClick={() => setTimeFilter(null)}
            >
              <Calendar className="h-2.5 w-2.5" />
              {timeFieldOptions.find(f => f.value === timeFilter.field)?.label}:{" "}
              {timeRangePresets.find(p => p.value === timeFilter.range)?.label ?? timeFilter.range}
              <XCircle className="h-2.5 w-2.5" />
            </Badge>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="h-5 px-1.5 text-[10px] text-muted-foreground"
            onClick={() => { setSelectedMissions(new Set()); setSelectedTeams(new Set()); setTimeFilter(null); }}
          >
            Clear all
          </Button>
        </div>
      )}

      {/* Task count */}
      <div className="flex items-center gap-2 shrink-0">
        <span className="text-xs text-muted-foreground">
          {filtered.length} task{filtered.length !== 1 ? "s" : ""}
          {(selectedMissions.size > 0 || selectedTeams.size > 0 || timeFilter) && ` (filtered from ${tasks.length})`}
        </span>
      </div>

      {/* Content */}
      {tasks.length === 0 ? (
        <Card className="bg-card/60 backdrop-blur-sm">
          <CardContent className="flex flex-col items-center justify-center py-16 text-muted-foreground">
            <ListChecks className="h-12 w-12 mb-4 opacity-40" />
            <p className="text-sm font-medium">No tasks yet</p>
            <p className="text-xs mt-1 text-center max-w-xs">
              Tasks are created when a mission is executed. Use the TUI or Chat to create and run a mission.
            </p>
            <kbd className="mt-3 rounded border border-border bg-muted px-2 py-1 font-mono text-[10px]">
              polpo mission &lt;prompt&gt;
            </kbd>
          </CardContent>
        </Card>
      ) : viewMode === "kanban" ? (
        <KanbanBoard
          tasks={filtered}
          processes={processes}
          groupBy={groupBy}
          columnBy={columnBy}
          agentTeamMap={agentTeamMap}
          onRetry={(id) => handleAction(retryTask, id, "retried")}
          onKill={(id) => handleAction(killTask, id, "killed")}
          onQueue={(id) => handleAction(queueTask, id, "queued")}
          onClick={(id) => navigate(`/tasks/${id}`)}
        />
      ) : (
        <ListView
          tasks={filtered}
          processes={processes}
          onRetry={(id) => handleAction(retryTask, id, "retried")}
          onKill={(id) => handleAction(killTask, id, "killed")}
          onQueue={(id) => handleAction(queueTask, id, "queued")}
          onClick={(id) => navigate(`/tasks/${id}`)}
        />
      )}
    </div>
  );
}
