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
  MoreVertical,
  Loader2,
  Map,
  RotateCcw,
  XCircle,
  RefreshCw,
  Bot,
  ListChecks,
  CheckCircle2,
  AlertTriangle,
  Clock,
  ArrowRight,
} from "lucide-react";
import { usePlans, useTasks } from "@openpolpo/react-sdk";
import type { Plan, PlanStatus } from "@openpolpo/react-sdk";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";
import { cn } from "@/lib/utils";

// ── Parse plan data (lightweight — only extract counts) ──

function parsePlanCounts(data: string): { taskCount: number; agentCount: number } {
  try {
    const parsed = JSON.parse(data);
    return {
      taskCount: Array.isArray(parsed.tasks) ? parsed.tasks.length : 0,
      agentCount: Array.isArray(parsed.team) ? parsed.team.length : 0,
    };
  } catch {
    return { taskCount: 0, agentCount: 0 };
  }
}

// ── Status styles ──

const statusStyles: Record<PlanStatus, { color: string; bg: string; label: string; icon: React.ElementType }> = {
  draft: { color: "text-zinc-400", bg: "bg-zinc-500/10", label: "Draft", icon: Clock },
  active: { color: "text-blue-400", bg: "bg-blue-500/10", label: "Running", icon: Loader2 },
  completed: { color: "text-emerald-400", bg: "bg-emerald-500/10", label: "Completed", icon: CheckCircle2 },
  failed: { color: "text-red-400", bg: "bg-red-500/10", label: "Failed", icon: AlertTriangle },
  cancelled: { color: "text-zinc-500", bg: "bg-zinc-500/10", label: "Cancelled", icon: XCircle },
};

// ── Plan row ──

function PlanRow({
  plan,
  doneCount,
  failedCount,
  runningCount,
  totalCount,
  onExecute,
  onResume,
  onAbort,
  onClick,
}: {
  plan: Plan;
  doneCount: number;
  failedCount: number;
  runningCount: number;
  totalCount: number;
  onExecute: () => void;
  onResume: () => void;
  onAbort: () => void;
  onClick: () => void;
}) {
  const style = statusStyles[plan.status];
  const StatusIcon = style.icon;
  const progress = totalCount > 0 ? Math.round((doneCount / totalCount) * 100) : 0;
  const counts = useMemo(() => parsePlanCounts(plan.data), [plan.data]);

  const hasActions = plan.status === "draft" || plan.status === "active" || plan.status === "failed";

  return (
    <div
      className="group flex items-center gap-4 p-4 rounded-lg border border-border bg-card transition-colors hover:border-border/80 cursor-pointer"
      onClick={onClick}
    >
      {/* Status icon */}
      <div className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-lg", style.bg)}>
        <StatusIcon className={cn("h-4 w-4", style.color, plan.status === "active" && "animate-spin")} />
      </div>

      {/* Name + meta */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium truncate">{plan.name}</span>
          <Badge variant="outline" className={cn("text-[10px] capitalize shrink-0", style.color)}>
            {style.label}
          </Badge>
        </div>
        <div className="flex items-center gap-3 mt-0.5 text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <ListChecks className="h-3 w-3" /> {counts.taskCount} task{counts.taskCount !== 1 ? "s" : ""}
          </span>
          {counts.agentCount > 0 && (
            <span className="flex items-center gap-1">
              <Bot className="h-3 w-3" /> {counts.agentCount} agent{counts.agentCount !== 1 ? "s" : ""}
            </span>
          )}
          <span>created {formatDistanceToNow(new Date(plan.createdAt), { addSuffix: true })}</span>
          <span>updated {formatDistanceToNow(new Date(plan.updatedAt), { addSuffix: true })}</span>
        </div>
      </div>

      {/* Progress for active plans */}
      {plan.status === "active" && totalCount > 0 && (
        <div className="flex items-center gap-2 shrink-0">
          <Progress value={progress} className="h-1.5 w-20" />
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
        {plan.status === "completed" && doneCount > 0 && (
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
            {plan.status === "draft" && (
              <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onExecute(); }}>
                <Play className="h-3.5 w-3.5 mr-2" /> Execute
              </DropdownMenuItem>
            )}
            {(plan.status === "active" || plan.status === "failed") && (
              <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onResume(); }}>
                <RotateCcw className="h-3.5 w-3.5 mr-2" /> Resume
              </DropdownMenuItem>
            )}
            {plan.status === "active" && (
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

export function PlansPage() {
  const navigate = useNavigate();
  const {
    plans,
    isLoading: loading,
    refetch,
    executePlan,
    resumePlan,
    abortPlan,
  } = usePlans();

  const { tasks } = useTasks();

  const handleAction = async (action: () => Promise<unknown>, label: string) => {
    try {
      await action();
      toast.success(label);
      refetch();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  // Compute task stats per plan group
  const planStats = useMemo(() => {
    const map: Record<string, { done: number; failed: number; running: number; total: number }> = {};
    for (const plan of plans) {
      const group = plan.name;
      const groupTasks = tasks.filter(t => t.group === group);
      map[plan.id] = {
        done: groupTasks.filter(t => t.status === "done").length,
        failed: groupTasks.filter(t => t.status === "failed").length,
        running: groupTasks.filter(t => t.status === "in_progress" || t.status === "review").length,
        total: groupTasks.length || (() => { try { return JSON.parse(plan.data)?.tasks?.length ?? 0; } catch { return 0; } })(),
      };
    }
    return map;
  }, [plans, tasks]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const active = plans.filter(p => p.status === "active");
  const drafts = plans.filter(p => p.status === "draft");
  const completed = plans.filter(p => p.status === "completed" || p.status === "failed" || p.status === "cancelled");

  const sections = [
    { label: "Active", plans: active, defaultOpen: true },
    { label: "Drafts", plans: drafts, defaultOpen: true },
    { label: "Completed", plans: completed, defaultOpen: false },
  ].filter(s => s.plans.length > 0);

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-4">
      {/* Toolbar */}
      <div className="flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3">
          <h3 className="text-sm font-medium text-muted-foreground">
            {plans.length} plan{plans.length !== 1 ? "s" : ""}
          </h3>
          {active.length > 0 && (
            <Badge variant="default" className="text-[10px]">
              {active.length} running
            </Badge>
          )}
        </div>
        <Button variant="outline" size="sm" onClick={refetch}>
          <RefreshCw className="h-3.5 w-3.5" />
        </Button>
      </div>

      {plans.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16 text-muted-foreground">
            <Map className="h-12 w-12 mb-4 opacity-40" />
            <p className="text-sm font-medium">No plans yet</p>
            <p className="text-xs mt-1 text-center max-w-xs">
              Plans are created when you give the orchestrator a prompt via the TUI or Chat.
            </p>
            <kbd className="mt-3 rounded border border-border bg-muted px-2 py-1 font-mono text-[10px]">
              polpo plan &lt;prompt&gt;
            </kbd>
          </CardContent>
        </Card>
      ) : (
        <ScrollArea className="flex-1 min-h-0">
          <div className="space-y-6 pr-4">
            {sections.map(({ label, plans: sectionPlans }) => (
              <section key={label}>
                <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3">
                  {label} ({sectionPlans.length})
                </h3>
                <div className="space-y-2">
                  {sectionPlans.map((plan) => {
                    const stats = planStats[plan.id] ?? { done: 0, failed: 0, running: 0, total: 0 };
                    return (
                      <PlanRow
                        key={plan.id}
                        plan={plan}
                        doneCount={stats.done}
                        failedCount={stats.failed}
                        runningCount={stats.running}
                        totalCount={stats.total}
                        onExecute={() => handleAction(() => executePlan(plan.id), "Plan executed")}
                        onResume={() => handleAction(() => resumePlan(plan.id), "Plan resumed")}
                        onAbort={() => handleAction(() => abortPlan(plan.id), "Plan aborted")}
                        onClick={() => navigate(`/plans/${plan.id}`)}
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
