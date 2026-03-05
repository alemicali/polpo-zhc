import { useState, useMemo, memo, createContext, use } from "react";
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
  EyeOff,
  Star,
  ListChecks,
  Bot,
  GitBranch,
  Wrench,
  HelpCircle,
  Hammer,
  Zap,
  FileEdit,
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
  Settings2,
} from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import type { Task, TaskStatus, AgentProcess, AgentConfig } from "@lumea-labs/polpo-react";
import { formatDistanceToNow } from "date-fns";
import { cn } from "@/lib/utils";
import { MultiSelectFilter } from "@/components/shared/multi-select-filter";
import { AgentAvatar } from "@/components/shared/agent-avatar";
import {
  useTasksPageState,
  useTaskActions,
  TaskActionsProvider,
} from "@/hooks/use-tasks-page";
import type {
  GroupByKey,
  ColumnByKey,
  SortKey,
  TimeField,
  TimeFilterState,
  TimeRange,
  CardFieldVisibility,
} from "@/hooks/use-tasks-page";

// ── Card settings context (avoids prop drilling) ──

interface CardSettingsCtx {
  fields: CardFieldVisibility;
  agentConfigMap: Record<string, AgentConfig>;
}

const CardSettingsContext = createContext<CardSettingsCtx | null>(null);

function useCardSettings(): CardSettingsCtx {
  const ctx = use(CardSettingsContext);
  if (!ctx) throw new Error("useCardSettings must be used within CardSettingsContext");
  return ctx;
}

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

const sortOptions: { value: SortKey; label: string }[] = [
  { value: "updated", label: "Last updated" },
  { value: "created", label: "Created" },
  { value: "name", label: "Name" },
  { value: "status", label: "Status" },
  { value: "priority", label: "Priority" },
  { value: "score", label: "Score" },
];

// ── Time filter ──

const timeFieldOptions: { value: TimeField; label: string }[] = [
  { value: "createdAt", label: "Created" },
  { value: "updatedAt", label: "Updated" },
];

const timeRangePresets: { value: TimeRange; label: string; ms: number }[] = [
  { value: "1h", label: "Last hour", ms: 60 * 60 * 1000 },
  { value: "6h", label: "Last 6 hours", ms: 6 * 60 * 60 * 1000 },
  { value: "24h", label: "Last 24 hours", ms: 24 * 60 * 60 * 1000 },
  { value: "7d", label: "Last 7 days", ms: 7 * 24 * 60 * 60 * 1000 },
  { value: "30d", label: "Last 30 days", ms: 30 * 24 * 60 * 60 * 1000 },
];



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

// ── Task card ──

const TaskCard = memo(function TaskCard({
  task,
  process,
  size = "default",
  allTasks,
}: {
  task: Task;
  process?: AgentProcess;
  size?: "default" | "compact";
  allTasks?: Task[];
}) {
  const { retry, kill, queue, click } = useTaskActions();
  const { fields, agentConfigMap } = useCardSettings();
  const compact = size === "compact";
  const cfg = statusConfig[task.status];
  const Icon = cfg.icon;
  const assessment = task.result?.assessment;
  const phase = task.phase && task.phase !== "execution" ? phaseConfig[task.phase] : null;
  const agent = agentConfigMap[task.assignTo];
  const identity = agent?.identity;
  const hasAvatar = !!identity?.avatar;

  // Check if task is blocked by unresolved dependencies
  const unresolvedDeps = task.dependsOn.filter((depId) => {
    const dep = allTasks?.find(t => t.id === depId);
    return !dep || dep.status !== "done";
  });
  const isBlocked = unresolvedDeps.length > 0 && (task.status === "pending" || task.status === "assigned");

  // Show the agent row? (at least one agent-related field is on)
  const showAgentRow = fields.avatar || fields.identityName || fields.agentId;

   return (
    <div
      className={cn(
        "group rounded-lg border border-border/40 bg-card/80 backdrop-blur-sm transition-all cursor-pointer",
        "hover:border-primary/20 hover:shadow-[0_0_15px_oklch(0.7_0.15_200_/_8%)]",
        "w-full max-w-full overflow-hidden box-border",
        compact ? "p-2.5" : "p-3",
      )}
      onClick={() => click(task.id)}
    >
      {/* Header: status icon + title + phase */}
      <div className="flex items-start gap-2 w-full min-w-0">
        <div className={cn("flex shrink-0 items-center justify-center rounded-md mt-0.5", compact ? "h-6 w-6" : "h-7 w-7", cfg.bg)}>
          <Icon className={cn(compact ? "h-3 w-3" : "h-3.5 w-3.5", cfg.color, task.status === "in_progress" && "animate-spin")} />
        </div>
        <div className="min-w-0 flex-1">
          <p className={cn("font-medium leading-snug", compact ? "text-xs" : "text-sm")} style={{ overflowWrap: "anywhere", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{task.title}</p>
          {fields.phase && phase && (
            <Badge variant="outline" className={cn("text-[8px] gap-0.5 px-1 py-0 mt-0.5 inline-flex", phase.color)}>
              <phase.icon className="h-2 w-2" />
              {phase.label}
            </Badge>
          )}
        </div>
      </div>

      {/* Agent row: avatar + displayName + @id */}
      {showAgentRow && (
        <div className="flex items-center gap-1.5 mt-1.5 min-w-0">
          {fields.avatar && (
            hasAvatar
              ? <AgentAvatar avatar={identity?.avatar} name={task.assignTo} size="xs" />
              : <Bot className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
          )}
          {fields.identityName && identity?.displayName && (
            <span className={cn("font-medium text-foreground/80 truncate", compact ? "text-[10px]" : "text-[11px]")}>
              {identity.displayName}
            </span>
          )}
          {fields.agentId && (
            <span className="text-[10px] text-muted-foreground/60 truncate">
              {fields.identityName && identity?.displayName ? `@${task.assignTo}` : task.assignTo}
            </span>
          )}
        </div>
      )}

      {/* Meta row: mission, time */}
      {(fields.mission || fields.time) && (
        <div className="flex items-center gap-1.5 mt-1 min-w-0 flex-wrap">
          {fields.mission && task.group && (
            <Badge variant="secondary" className="text-[8px] px-1 py-0 max-w-[140px] truncate">{task.group}</Badge>
          )}
          {fields.time && (
            <span className="text-[10px] text-muted-foreground/60 whitespace-nowrap">
              {formatDistanceToNow(new Date(task.updatedAt), { addSuffix: true })}
            </span>
          )}
        </div>
      )}

      {/* Indicators row: score, retries, deps, expectations */}
      {(fields.score || fields.retries || fields.deps || fields.expectations) && (
        <div className="flex items-center gap-1 mt-1 flex-wrap">
          {fields.score && assessment?.globalScore != null && (
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
          {fields.retries && task.retries > 0 && (
            <Badge variant="secondary" className="text-[9px] px-1 py-0">
              <RotateCcw className="h-2 w-2 mr-0.5" />{task.retries}
            </Badge>
          )}
          {fields.deps && task.dependsOn.length > 0 && (
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
                      {done ? "\u2713" : "\u25CB"} {dep ? dep.title : depId}
                    </p>
                  );
                })}
              </TooltipContent>
            </Tooltip>
          )}
          {fields.expectations && task.expectations.length > 0 && !assessment && (
            <Badge variant="outline" className="text-[9px] px-1 py-0">
              <Wrench className="h-2 w-2 mr-0.5" />{task.expectations.length}
            </Badge>
          )}
        </div>
      )}

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
        {task.status === "draft" && (
          <Button variant="ghost" size="sm" className="h-5 px-1.5 text-[10px] text-muted-foreground hover:text-blue-400" onClick={(e) => { e.stopPropagation(); queue(task.id); }}>
            <Zap className="h-2.5 w-2.5 mr-0.5" /> Queue
          </Button>
        )}
        {task.status === "failed" && (
          <Button variant="ghost" size="sm" className="h-5 px-1.5 text-[10px] text-muted-foreground hover:text-amber-400" onClick={(e) => { e.stopPropagation(); retry(task.id); }}>
            <RotateCcw className="h-2.5 w-2.5 mr-0.5" /> Retry
          </Button>
        )}
        {(task.status === "in_progress" || task.status === "assigned") && (
          <Button variant="ghost" size="sm" className="h-5 px-1.5 text-[10px] text-muted-foreground hover:text-red-400" onClick={(e) => { e.stopPropagation(); kill(task.id); }}>
            <XCircle className="h-2.5 w-2.5 mr-0.5" /> Kill
          </Button>
        )}
      </div>
    </div>
  );
});

// ── Group-by logic ──

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
}: {
  label: string;
  icon: React.ElementType;
  tasks: Task[];
  processes: AgentProcess[];
  allTasks: Task[];
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
              size="compact"
              allTasks={allTasks}
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
}: {
  col: DynamicColumn;
  tasks: Task[];
  allTasks: Task[];
  processes: AgentProcess[];
  groupBy: GroupByKey;
  columnBy: ColumnByKey;
  agentTeamMap: Record<string, string>;
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
              />
            ))
          ) : (
            colTasks.map((task) => (
              <TaskCard
                key={task.id}
                task={task}
                process={processes.find(p => p.taskId === task.id)}
                size="compact"
                allTasks={allTasks}
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
  showEmptyColumns,
  agentTeamMap,
}: {
  tasks: Task[];
  processes: AgentProcess[];
  groupBy: GroupByKey;
  columnBy: ColumnByKey;
  showEmptyColumns: boolean;
  agentTeamMap: Record<string, string>;
}) {
  const columns = useMemo(
    () => buildDynamicColumns(columnBy, tasks, agentTeamMap),
    [columnBy, tasks, agentTeamMap],
  );

  // Filter out empty columns unless showEmptyColumns is on
  const visibleColumns = useMemo(() => {
    if (showEmptyColumns) return columns;
    return columns.filter((col) => tasks.some(col.filter));
  }, [columns, tasks, showEmptyColumns]);

  return (
    <div className="flex gap-3 flex-1 min-h-0 overflow-x-auto pb-2">
      {visibleColumns.map((col) => (
        <KanbanColumn
          key={col.key}
          col={col}
          tasks={tasks}
          allTasks={tasks}
          processes={processes}
          groupBy={groupBy}
          columnBy={columnBy}
          agentTeamMap={agentTeamMap}
        />
      ))}
    </div>
  );
}

// ── List view with status tabs ──

function ListView({
  tasks,
  processes,
}: {
  tasks: Task[];
  processes: AgentProcess[];
}) {
  const [tab, setTab] = useState("all");

  const filtered = tasks
    .filter((t) => {
      if (tab === "pending") return t.status === "pending" || t.status === "assigned";
      if (tab !== "all" && t.status !== tab) return false;
      return true;
    });

  // Single-pass count reduction instead of 5 separate .filter() calls
  const counts = useMemo(() => {
    const c = { all: tasks.length, pending: 0, in_progress: 0, review: 0, done: 0, failed: 0 };
    for (const t of tasks) {
      if (t.status === "pending" || t.status === "assigned") c.pending++;
      else if (t.status === "in_progress") c.in_progress++;
      else if (t.status === "review") c.review++;
      else if (t.status === "done") c.done++;
      else if (t.status === "failed") c.failed++;
    }
    return c;
  }, [tasks]);

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
              />
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

// ── Card field settings popover ──

const CARD_FIELD_LABELS: Record<keyof CardFieldVisibility, string> = {
  avatar: "Agent avatar",
  identityName: "Identity name",
  agentId: "Agent ID",
  mission: "Mission group",
  time: "Updated time",
  score: "Assessment score",
  retries: "Retry count",
  deps: "Dependencies",
  expectations: "Expectations",
  phase: "Phase badge",
};

const CARD_FIELD_ORDER: (keyof CardFieldVisibility)[] = [
  "avatar", "identityName", "agentId", "mission", "time",
  "phase", "score", "deps", "retries", "expectations",
];

function CardFieldSettings({
  fields,
  onToggle,
}: {
  fields: CardFieldVisibility;
  onToggle: (field: keyof CardFieldVisibility) => void;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-7 gap-1.5 text-xs">
          <Settings2 className="h-3 w-3" />
          Card fields
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-52 p-2" align="end">
        <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-2 px-1">
          Visible fields
        </p>
        <div className="space-y-0.5">
          {CARD_FIELD_ORDER.map((key) => (
            <button
              key={key}
              className={cn(
                "flex items-center gap-2 w-full rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                "hover:bg-muted",
              )}
              onClick={() => onToggle(key)}
            >
              <div className={cn(
                "flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors",
                fields[key]
                  ? "bg-primary border-primary"
                  : "border-muted-foreground/30",
              )}>
                {fields[key] && (
                  <Check className="h-2.5 w-2.5 text-primary-foreground" />
                )}
              </div>
              <span className="text-xs">{CARD_FIELD_LABELS[key]}</span>
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ── Main page ──

export function TasksPage() {
  const state = useTasksPageState();
  const {
    tasks, filtered, processes, loading, teamsLoading,
    search, setSearch,
    selectedMissions, setSelectedMissions, selectedTeams, setSelectedTeams,
    timeFilter, setTimeFilter, hasActiveFilters, clearAllFilters,
    toggleMission, toggleTeam,
    missionFilterOptions, teamFilterOptions,
    viewMode, setViewMode, sortKey, setSortKey,
    groupBy, setGroupBy, columnBy, setColumnBy,
    showEmptyColumns, toggleEmptyColumns,
    cardFields, toggleCardField,
    taskActions, handleRefresh, isRefreshing,
    agentTeamMap, agentConfigMap,
  } = state;

  const cardSettingsCtx = useMemo<CardSettingsCtx>(
    () => ({ fields: cardFields, agentConfigMap }),
    [cardFields, agentConfigMap],
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <TaskActionsProvider actions={taskActions}>
      <CardSettingsContext value={cardSettingsCtx}>
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
          <MultiSelectFilter
            icon={<Target className="h-3.5 w-3.5" />}
            label="Missions"
            options={missionFilterOptions}
            selected={selectedMissions}
            onToggle={toggleMission}
            onClear={() => setSelectedMissions(new Set())}
          />

          {/* Team filter */}
          <MultiSelectFilter
            icon={<Users className="h-3.5 w-3.5" />}
            label="Teams"
            options={teamFilterOptions}
            selected={selectedTeams}
            onToggle={toggleTeam}
            onClear={() => setSelectedTeams(new Set())}
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
                  onClick={() => setSortKey(opt.value)}
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
                        onClick={() => setColumnBy(opt.value)}
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
                        onClick={() => setGroupBy(opt.value)}
                      >
                        {groupBy === opt.value ? <Check className="h-3 w-3" /> : <span className="w-3" />}
                        <OptIcon className="h-3 w-3" />
                        {opt.label}
                      </DropdownMenuItem>
                    );
                  })}
                </DropdownMenuContent>
              </DropdownMenu>
            {/* Toggle empty columns */}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 px-2"
                  onClick={toggleEmptyColumns}
                >
                  {showEmptyColumns ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                <p className="text-xs">{showEmptyColumns ? "Hide empty columns" : "Show empty columns"}</p>
              </TooltipContent>
            </Tooltip>
            </>
          )}

          {/* Card field settings */}
          <CardFieldSettings fields={cardFields} onToggle={toggleCardField} />

          {/* View toggle */}
          <div className="flex items-center rounded-md border border-border/50">
            <Button
              variant={viewMode === "list" ? "default" : "ghost"}
              size="sm"
              className="h-7 px-2 rounded-r-none"
              onClick={() => setViewMode("list")}
            >
              <LayoutList className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant={viewMode === "kanban" ? "default" : "ghost"}
              size="sm"
              className="h-7 px-2 rounded-l-none"
              onClick={() => setViewMode("kanban")}
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
        {hasActiveFilters && (
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
              onClick={clearAllFilters}
            >
              Clear all
            </Button>
          </div>
        )}

        {/* Task count */}
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-xs text-muted-foreground">
            {filtered.length} task{filtered.length !== 1 ? "s" : ""}
            {hasActiveFilters && ` (filtered from ${tasks.length})`}
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
            showEmptyColumns={showEmptyColumns}
            agentTeamMap={agentTeamMap}
          />
        ) : (
          <ListView
            tasks={filtered}
            processes={processes}
          />
        )}
      </div>
      </CardSettingsContext>
    </TaskActionsProvider>
  );
}
