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
  Map,
  Check,
} from "lucide-react";
import { useTasks, usePolpo, useProcesses, usePlans } from "@openpolpo/react-sdk";
import type { Task, TaskStatus, AgentProcess } from "@openpolpo/react-sdk";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";
import { cn } from "@/lib/utils";

// ── Status config ──

const statusConfig: Record<
  TaskStatus,
  { icon: React.ElementType; color: string; bg: string; label: string }
> = {
  pending: { icon: Clock, color: "text-zinc-400", bg: "bg-zinc-500/10", label: "Queued" },
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

const kanbanColumns: { status: TaskStatus | "queued"; label: string; filter: (t: Task) => boolean }[] = [
  { status: "queued", label: "Queued", filter: (t) => t.status === "pending" || t.status === "assigned" },
  { status: "in_progress", label: "Running", filter: (t) => t.status === "in_progress" },
  { status: "review", label: "Review", filter: (t) => t.status === "review" },
  { status: "done", label: "Done", filter: (t) => t.status === "done" },
  { status: "failed", label: "Failed", filter: (t) => t.status === "failed" },
];

// ── Plan filter popover ──

function PlanFilter({
  plans,
  selected,
  onToggle,
}: {
  plans: { id: string; name: string }[];
  selected: Set<string>;
  onToggle: (name: string) => void;
}) {
  const hasFilter = selected.size > 0;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant={hasFilter ? "default" : "outline"} size="sm" className="gap-1.5">
          <Filter className="h-3.5 w-3.5" />
          Plans
          {hasFilter && (
            <Badge variant="secondary" className="text-[9px] ml-1">{selected.size}</Badge>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-2" align="start">
        <div className="space-y-1 max-h-64 overflow-y-auto">
          {plans.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-3">No plans</p>
          ) : (
            plans.map((p) => (
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
                <Map className="h-3 w-3 text-muted-foreground shrink-0" />
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
            onClick={() => plans.forEach(p => { if (selected.has(p.name)) onToggle(p.name); })}
          >
            Clear all
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
  onRetry,
  onKill,
  onClick,
}: {
  task: Task;
  process?: AgentProcess;
  compact?: boolean;
  onRetry: () => void;
  onKill: () => void;
  onClick: () => void;
}) {
  const cfg = statusConfig[task.status];
  const Icon = cfg.icon;
  const assessment = task.result?.assessment;
  const phase = task.phase && task.phase !== "execution" ? phaseConfig[task.phase] : null;

  return (
    <div
      className={cn(
        "group rounded-lg border border-border bg-card transition-all cursor-pointer",
        "hover:border-border/80 hover:shadow-sm",
        compact && "p-2.5",
        !compact && "p-3",
      )}
      onClick={onClick}
    >
      <div className="flex items-start gap-2.5">
        <div className={cn("flex shrink-0 items-center justify-center rounded-md mt-0.5", compact ? "h-6 w-6" : "h-7 w-7", cfg.bg)}>
          <Icon className={cn(compact ? "h-3 w-3" : "h-3.5 w-3.5", cfg.color, task.status === "in_progress" && "animate-spin")} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 min-w-0">
            <span className={cn("font-medium", compact ? "text-xs line-clamp-2" : "text-sm line-clamp-2")}>{task.title}</span>
            {phase && (
              <Badge variant="outline" className={cn("text-[8px] gap-0.5 px-1 py-0 shrink-0", phase.color)}>
                <phase.icon className="h-2 w-2" />
                {phase.label}
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-1.5 mt-1 flex-wrap">
            <span className="text-[10px] text-muted-foreground flex items-center gap-0.5">
              <Bot className="h-2.5 w-2.5" />
              {task.assignTo}
            </span>
            {task.group && (
              <Badge variant="secondary" className="text-[8px] px-1 py-0">{task.group}</Badge>
            )}
            <span className="text-[10px] text-muted-foreground">
              {formatDistanceToNow(new Date(task.updatedAt), { addSuffix: true })}
            </span>
          </div>
        </div>

        {/* Right side indicators */}
        <div className="flex items-center gap-1 shrink-0">
          {assessment?.globalScore != null && (
            <Tooltip>
              <TooltipTrigger asChild>
                <div className={cn(
                  "flex items-center gap-0.5 rounded px-1.5 py-0.5",
                  assessment.passed ? "bg-emerald-500/10" : "bg-red-500/10"
                )}>
                  <Star className={cn("h-2.5 w-2.5", assessment.passed ? "text-emerald-500" : "text-red-500")} />
                  <span className={cn("text-[10px] font-bold", assessment.passed ? "text-emerald-500" : "text-red-500")}>
                    {Math.round(assessment.globalScore * 100)}
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
                <Badge variant="outline" className="text-[9px] px-1 py-0 cursor-help">
                  <GitBranch className="h-2 w-2 mr-0.5" />{task.dependsOn.length}
                </Badge>
              </TooltipTrigger>
              <TooltipContent className="text-xs">
                Depends on: {task.dependsOn.join(", ")}
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

      {/* Live activity strip for running tasks */}
      {process && (
        <div className="flex items-center gap-2 mt-2 pt-2 border-t border-blue-500/10">
          <div className="h-1.5 w-1.5 rounded-full bg-blue-400 animate-pulse shrink-0" />
          {process.activity.lastTool && (
            <Badge variant="outline" className="text-[8px] font-mono px-1 py-0 text-blue-400 border-blue-400/30">
              <Wrench className="h-2 w-2 mr-0.5" />{process.activity.lastTool}
            </Badge>
          )}
          {process.activity.lastFile && (
            <span className="text-[10px] font-mono text-muted-foreground truncate">
              {process.activity.lastFile.split("/").pop()}
            </span>
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
      )}

      {/* Inline actions — only on hover, stop propagation */}
      <div className="flex items-center gap-1 mt-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
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

// ── Kanban board ──

function KanbanBoard({
  tasks,
  processes,
  onRetry,
  onKill,
  onClick,
}: {
  tasks: Task[];
  processes: AgentProcess[];
  onRetry: (id: string) => void;
  onKill: (id: string) => void;
  onClick: (id: string) => void;
}) {
  return (
    <div className="flex gap-3 flex-1 min-h-0 overflow-x-auto pb-2">
      {kanbanColumns.map((col) => {
        const colTasks = tasks.filter(col.filter).sort(
          (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
        );
        const colCfg = col.status === "queued" ? statusConfig.pending : statusConfig[col.status as TaskStatus];

        return (
          <div key={col.status} className="flex flex-col min-w-[260px] w-[260px] shrink-0">
            {/* Column header */}
            <div className="flex items-center gap-2 px-2 pb-2 shrink-0">
              <div className={cn("h-2 w-2 rounded-full", colCfg.bg.replace("bg-", "bg-").replace("/10", ""))} style={{
                backgroundColor: `hsl(var(--${colCfg.color.replace("text-", "").replace("-400", "")}))`,
              }} />
              <span className="text-xs font-medium">{col.label}</span>
              <Badge variant="secondary" className="text-[9px] ml-auto">{colTasks.length}</Badge>
            </div>

            {/* Column body */}
            <ScrollArea className="flex-1 min-h-0">
              <div className="space-y-1.5 px-1 pr-3">
                {colTasks.length === 0 ? (
                  <div className="flex items-center justify-center py-8 text-muted-foreground">
                    <p className="text-[10px]">No tasks</p>
                  </div>
                ) : (
                  colTasks.map((task) => (
                    <TaskCard
                      key={task.id}
                      task={task}
                      process={processes.find(p => p.taskId === task.id)}
                      compact
                      onRetry={() => onRetry(task.id)}
                      onKill={() => onKill(task.id)}
                      onClick={() => onClick(task.id)}
                    />
                  ))
                )}
              </div>
            </ScrollArea>
          </div>
        );
      })}
    </div>
  );
}

// ── List view with status tabs ──

function ListView({
  tasks,
  processes,
  onRetry,
  onKill,
  onClick,
}: {
  tasks: Task[];
  processes: AgentProcess[];
  onRetry: (id: string) => void;
  onKill: (id: string) => void;
  onClick: (id: string) => void;
}) {
  const [tab, setTab] = useState("all");

  const filtered = tasks
    .filter((t) => {
      if (tab === "pending") return t.status === "pending" || t.status === "assigned";
      if (tab !== "all" && t.status !== tab) return false;
      return true;
    })
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

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
      <div className="flex items-center gap-1 shrink-0 overflow-x-auto">
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
      <ScrollArea className="flex-1 min-h-0">
        <div className="space-y-1.5 pr-4">
          {filtered.length === 0 ? (
            <Card>
              <CardContent className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                <ListChecks className="h-10 w-10 mb-3 opacity-40" />
                <p className="text-sm font-medium">
                  {tab !== "all" ? "No tasks in this category" : "No tasks yet"}
                </p>
                {tab === "all" && (
                  <p className="text-xs mt-1 text-center max-w-xs">
                    Tasks are created when a plan is executed. Use the TUI or Chat to create and run a plan.
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
                onRetry={() => onRetry(task.id)}
                onKill={() => onKill(task.id)}
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
  const { plans } = usePlans();
  const [search, setSearch] = useState("");
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    return (localStorage.getItem("polpo-tasks-view") as ViewMode) ?? "list";
  });
  const [selectedPlans, setSelectedPlans] = useState<Set<string>>(new Set());

  const setView = (mode: ViewMode) => {
    setViewMode(mode);
    localStorage.setItem("polpo-tasks-view", mode);
  };

  const togglePlan = (name: string) => {
    setSelectedPlans(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const killTask = async (id: string) => { await client.killTask(id); refetch(); };

  const handleAction = async (action: (id: string) => Promise<void>, id: string, label: string) => {
    try {
      await action(id);
      toast.success(`Task ${label}`);
      refetch();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  // Filtered tasks by search + plan filter
  const filtered = useMemo(() => {
    return tasks.filter(t => {
      // Plan filter
      if (selectedPlans.size > 0 && !selectedPlans.has(t.group ?? "")) {
        return false;
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
  }, [tasks, search, selectedPlans]);

  // Unique plan names for the filter
  const planOptions = useMemo((): { name: string; id: string }[] => {
    const names: Record<string, string> = {};
    for (const p of plans) names[p.name] = p.id;
    // Also include groups from tasks that may not match a plan name
    for (const t of tasks) {
      if (t.group && !(t.group in names)) names[t.group] = "";
    }
    return Object.entries(names).map(([name, id]) => ({ name, id }));
  }, [plans, tasks]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-3">
      {/* Toolbar */}
      <div className="flex items-center gap-3 shrink-0">
        {/* Search */}
        <div className="relative w-64">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            placeholder="Search tasks..."
            className="pl-8 h-8 text-sm"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        {/* Plan filter */}
        <PlanFilter
          plans={planOptions}
          selected={selectedPlans}
          onToggle={togglePlan}
        />

        {/* Spacer */}
        <div className="flex-1" />

        {/* View toggle */}
        <div className="flex items-center rounded-md border border-border">
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
        <Button variant="outline" size="sm" className="h-7" onClick={refetch}>
          <RefreshCw className="h-3.5 w-3.5" />
        </Button>
      </div>

      {/* Active filter indicators */}
      {selectedPlans.size > 0 && (
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-[10px] text-muted-foreground">Filtering by:</span>
          {Array.from(selectedPlans).map((name) => (
            <Badge
              key={name}
              variant="secondary"
              className="text-[10px] gap-1 cursor-pointer hover:bg-destructive/20"
              onClick={() => togglePlan(name)}
            >
              <Map className="h-2.5 w-2.5" />
              {name}
              <XCircle className="h-2.5 w-2.5" />
            </Badge>
          ))}
          <Button
            variant="ghost"
            size="sm"
            className="h-5 px-1.5 text-[10px] text-muted-foreground"
            onClick={() => setSelectedPlans(new Set())}
          >
            Clear all
          </Button>
        </div>
      )}

      {/* Task count */}
      <div className="flex items-center gap-2 shrink-0">
        <span className="text-xs text-muted-foreground">
          {filtered.length} task{filtered.length !== 1 ? "s" : ""}
          {selectedPlans.size > 0 && ` (filtered from ${tasks.length})`}
        </span>
      </div>

      {/* Content */}
      {tasks.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16 text-muted-foreground">
            <ListChecks className="h-12 w-12 mb-4 opacity-40" />
            <p className="text-sm font-medium">No tasks yet</p>
            <p className="text-xs mt-1 text-center max-w-xs">
              Tasks are created when a plan is executed. Use the TUI or Chat to create and run a plan.
            </p>
            <kbd className="mt-3 rounded border border-border bg-muted px-2 py-1 font-mono text-[10px]">
              polpo plan &lt;prompt&gt;
            </kbd>
          </CardContent>
        </Card>
      ) : viewMode === "kanban" ? (
        <KanbanBoard
          tasks={filtered}
          processes={processes}
          onRetry={(id) => handleAction(retryTask, id, "retried")}
          onKill={(id) => handleAction(killTask, id, "killed")}
          onClick={(id) => navigate(`/tasks/${id}`)}
        />
      ) : (
        <ListView
          tasks={filtered}
          processes={processes}
          onRetry={(id) => handleAction(retryTask, id, "retried")}
          onKill={(id) => handleAction(killTask, id, "killed")}
          onClick={(id) => navigate(`/tasks/${id}`)}
        />
      )}
    </div>
  );
}
