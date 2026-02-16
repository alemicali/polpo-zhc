import { useMemo, useState } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  ArrowLeft,
  Play,
  RotateCcw,
  XCircle,
  Loader2,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Bot,
  ListChecks,
  GitBranch,
  Quote,
  FileJson,
  Wrench,
  Star,
  Eye,
  Hammer,
  HelpCircle,
  Copy,
  Check,
  BarChart3,
  FileEdit,
  FilePlus,
  Timer,
} from "lucide-react";
import { usePlan, useTasks } from "@openpolpo/react-sdk";
import type { PlanStatus, PlanReport, TaskStatus } from "@openpolpo/react-sdk";
import { toast } from "sonner";
import { formatDistanceToNow, format } from "date-fns";
import { cn } from "@/lib/utils";

// ── Copyable ID ──

function CopyableId({ id, label }: { id: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        navigator.clipboard.writeText(id);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="inline-flex items-center gap-1 text-[10px] font-mono text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
      title={`Copy ${label ?? "ID"}: ${id}`}
    >
      {copied ? <Check className="h-2.5 w-2.5 text-emerald-500" /> : <Copy className="h-2.5 w-2.5" />}
      {id.slice(0, 12)}...
    </button>
  );
}

// ── Parsed plan shape ──

interface PlanTaskDef {
  title: string;
  description?: string;
  assignTo?: string;
  dependsOn?: string[];
  group?: string;
  expectations?: {
    type: string;
    command?: string;
    criteria?: string;
    paths?: string[];
    threshold?: number;
    confidence?: string;
    dimensions?: { name: string; description: string; weight: number }[];
  }[];
  metrics?: { name: string; command: string; threshold: number }[];
  maxRetries?: number;
  maxDuration?: number;
  retryPolicy?: { escalateAfter?: number; fallbackAgent?: string; escalateModel?: string };
}

interface PlanTeamDef {
  name: string;
  adapter?: string;
  role?: string;
  model?: string;
  skills?: string[];
  systemPrompt?: string;
  allowedTools?: string[];
  maxTurns?: number;
}

interface ParsedPlan {
  name?: string;
  tasks: PlanTaskDef[];
  team?: PlanTeamDef[];
}

function parsePlanData(data: string): ParsedPlan | null {
  try {
    const parsed = JSON.parse(data);
    return {
      name: parsed.name,
      tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
      team: Array.isArray(parsed.team) ? parsed.team : undefined,
    };
  } catch {
    return null;
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

const taskStatusConfig: Record<TaskStatus, { icon: React.ElementType; color: string; label: string }> = {
  pending: { icon: Clock, color: "text-zinc-400", label: "Queued" },
  awaiting_approval: { icon: Clock, color: "text-amber-400", label: "Awaiting Approval" },
  assigned: { icon: Clock, color: "text-violet-400", label: "Assigned" },
  in_progress: { icon: Loader2, color: "text-blue-400", label: "Running" },
  review: { icon: Eye, color: "text-amber-400", label: "Review" },
  done: { icon: CheckCircle2, color: "text-emerald-400", label: "Done" },
  failed: { icon: AlertTriangle, color: "text-red-400", label: "Failed" },
};

const phaseIcons: Record<string, { icon: React.ElementType; color: string; label: string }> = {
  fix: { icon: Hammer, color: "text-orange-400", label: "Fix" },
  clarification: { icon: HelpCircle, color: "text-purple-400", label: "Clarifying" },
  review: { icon: Eye, color: "text-amber-400", label: "Review" },
};

// ── Main page ──

export function PlanDetailPage() {
  const { planId } = useParams<{ planId: string }>();
  const navigate = useNavigate();
  const { plan, report, isLoading, error, executePlan, resumePlan, abortPlan } = usePlan(planId ?? "");
  const { tasks: allTasks } = useTasks();

  const parsed = useMemo(() => plan ? parsePlanData(plan.data) : null, [plan?.data]);

  // Match live tasks to this plan's group
  const planGroup = plan?.name;
  const groupTasks = useMemo(
    () => planGroup ? allTasks.filter(t => t.group === planGroup) : [],
    [allTasks, planGroup]
  );

  const findLiveTask = (title: string) => groupTasks.find(t => t.title === title);

  const doneCount = groupTasks.filter(t => t.status === "done").length;
  const failedCount = groupTasks.filter(t => t.status === "failed").length;
  const runningCount = groupTasks.filter(t => t.status === "in_progress" || t.status === "review").length;
  const totalCount = parsed?.tasks.length ?? 0;
  const progress = totalCount > 0 ? Math.round((doneCount / totalCount) * 100) : 0;

  const handleAction = async (action: () => Promise<unknown>, label: string) => {
    try {
      await action();
      toast.success(label);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error || !plan) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-muted-foreground">
        <AlertTriangle className="h-10 w-10 opacity-40" />
        <p className="text-sm">Plan not found</p>
        <Button variant="outline" size="sm" onClick={() => navigate("/plans")}>
          <ArrowLeft className="h-3.5 w-3.5 mr-1.5" />
          Back to Plans
        </Button>
      </div>
    );
  }

  const style = statusStyles[plan.status];
  const StatusIcon = style.icon;

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-4">
      {/* Back + title bar */}
      <div className="flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <Button variant="ghost" size="sm" onClick={() => navigate("/plans")} className="shrink-0">
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-lg", style.bg)}>
            <StatusIcon className={cn("h-4 w-4", style.color, plan.status === "active" && "animate-spin")} />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-semibold truncate">{plan.name}</h1>
              <Badge variant="outline" className={cn("text-xs shrink-0 capitalize", style.color)}>
                {style.label}
              </Badge>
            </div>
            <div className="flex items-center gap-3 mt-0.5 text-xs text-muted-foreground">
              <CopyableId id={plan.id} label="Plan ID" />
              <span>{totalCount} task{totalCount !== 1 ? "s" : ""}</span>
              {parsed?.team && <span>{parsed.team.length} agent{parsed.team.length !== 1 ? "s" : ""}</span>}
              <span>Created {format(new Date(plan.createdAt), "MMM d, HH:mm")}</span>
              <span>Updated {formatDistanceToNow(new Date(plan.updatedAt), { addSuffix: true })}</span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {plan.status === "active" && totalCount > 0 && (
            <div className="flex items-center gap-2 mr-3">
              <Progress value={progress} className="h-2 w-28" />
              <span className="text-sm font-mono text-muted-foreground">{doneCount}/{totalCount}</span>
              {runningCount > 0 && (
                <Badge variant="secondary" className="text-[10px]">{runningCount} running</Badge>
              )}
              {failedCount > 0 && (
                <Badge variant="destructive" className="text-[10px]">{failedCount} failed</Badge>
              )}
            </div>
          )}
          {plan.status === "draft" && (
            <Button size="sm" onClick={() => handleAction(executePlan, "Plan executed")}>
              <Play className="h-3.5 w-3.5 mr-1.5" /> Execute
            </Button>
          )}
          {(plan.status === "active" || plan.status === "failed") && (
            <Button variant="outline" size="sm" onClick={() => handleAction(() => resumePlan(), "Plan resumed")}>
              <RotateCcw className="h-3.5 w-3.5 mr-1.5" /> Resume
            </Button>
          )}
          {plan.status === "active" && (
            <Button variant="outline" size="sm" className="text-red-400 hover:text-red-500" onClick={() => handleAction(abortPlan, "Plan aborted")}>
              <XCircle className="h-3.5 w-3.5 mr-1.5" /> Abort
            </Button>
          )}
        </div>
      </div>

      {/* Tabs */}
      <Tabs defaultValue="tasks" className="flex flex-col flex-1 min-h-0">
        <TabsList className="shrink-0">
          <TabsTrigger value="tasks">
            Tasks
            {groupTasks.length > 0 && (
              <Badge variant="secondary" className="ml-1.5 text-[9px]">{groupTasks.length}</Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="definition">Plan Definition</TabsTrigger>
          <TabsTrigger value="team">
            Team
            {parsed?.team && (
              <Badge variant="secondary" className="ml-1.5 text-[9px]">{parsed.team.length}</Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="raw">Raw JSON</TabsTrigger>
          {report && (
            <TabsTrigger value="report">
              Report
              <Badge variant="secondary" className="ml-1.5 text-[9px]">
                <BarChart3 className="h-2.5 w-2.5" />
              </Badge>
            </TabsTrigger>
          )}
        </TabsList>

        {/* Tasks tab — live tasks linked to detail */}
        <TabsContent value="tasks" className="mt-4 flex-1 min-h-0">
          <ScrollArea className="h-full">
            <div className="space-y-2 pr-4">
              {/* Prompt */}
              {plan.prompt && (
                <div className="flex items-start gap-2 rounded-lg bg-muted/40 p-3 mb-4">
                  <Quote className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
                  <div>
                    <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-1">
                      Original Request
                    </p>
                    <p className="text-sm leading-relaxed">{plan.prompt}</p>
                  </div>
                </div>
              )}

              {parsed?.tasks.map((taskDef, idx) => {
                const live = findLiveTask(taskDef.title);
                const statusCfg = live ? taskStatusConfig[live.status] : null;
                const TaskIcon = statusCfg?.icon ?? Clock;
                const phaseInfo = live?.phase && live.phase !== "execution" ? phaseIcons[live.phase] : null;

                return (
                  <div
                    key={idx}
                    className={cn(
                      "group rounded-lg border border-border p-4 transition-colors",
                      live?.status === "done" && "border-emerald-500/20 bg-emerald-500/5",
                      live?.status === "failed" && "border-red-500/20 bg-red-500/5",
                      live?.status === "in_progress" && "border-blue-500/20 bg-blue-500/5",
                      live?.status === "review" && "border-amber-500/20 bg-amber-500/5",
                    )}
                  >
                    <div className="flex items-start gap-3">
                      <div className="mt-0.5 shrink-0">
                        <TaskIcon className={cn("h-4 w-4", statusCfg?.color ?? "text-muted-foreground", live?.status === "in_progress" && "animate-spin")} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          {live ? (
                            <Link
                              to={`/tasks/${live.id}`}
                              className="text-sm font-medium hover:underline underline-offset-2"
                            >
                              {taskDef.title}
                            </Link>
                          ) : (
                            <span className="text-sm font-medium">{taskDef.title}</span>
                          )}
                          {statusCfg && (
                            <Badge variant="outline" className={cn("text-[9px]", statusCfg.color)}>
                              {statusCfg.label}
                            </Badge>
                          )}
                          {phaseInfo && (
                            <Badge variant="outline" className={cn("text-[9px] gap-0.5", phaseInfo.color)}>
                              <phaseInfo.icon className="h-2.5 w-2.5" />
                              {phaseInfo.label}
                            </Badge>
                          )}
                          {live?.result?.assessment?.globalScore != null && (
                            <Badge
                              variant={live.result.assessment.globalScore >= 0.7 ? "default" : "destructive"}
                              className="text-[9px]"
                            >
                              <Star className="h-2.5 w-2.5 mr-0.5" />
                              {Math.round(live.result.assessment.globalScore * 100)}%
                            </Badge>
                          )}
                        </div>
                        {taskDef.description && (
                          <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{taskDef.description}</p>
                        )}
                        <div className="flex items-center gap-2 mt-2 flex-wrap">
                          {taskDef.assignTo && (
                            <Badge variant="outline" className="text-[9px]">
                              <Bot className="h-2.5 w-2.5 mr-0.5" />
                              {taskDef.assignTo}
                            </Badge>
                          )}
                          {taskDef.dependsOn && taskDef.dependsOn.length > 0 && (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Badge variant="secondary" className="text-[9px] cursor-help">
                                  <GitBranch className="h-2.5 w-2.5 mr-0.5" />
                                  {taskDef.dependsOn.length} dep{taskDef.dependsOn.length > 1 ? "s" : ""}
                                </Badge>
                              </TooltipTrigger>
                              <TooltipContent className="text-xs">
                                Depends on: {taskDef.dependsOn.join(", ")}
                              </TooltipContent>
                            </Tooltip>
                          )}
                          {taskDef.expectations && taskDef.expectations.length > 0 && (
                            <Badge variant="secondary" className="text-[9px]">
                              <Wrench className="h-2.5 w-2.5 mr-0.5" />
                              {taskDef.expectations.length} check{taskDef.expectations.length > 1 ? "s" : ""}
                            </Badge>
                          )}
                          {taskDef.metrics && taskDef.metrics.length > 0 && (
                            <Badge variant="secondary" className="text-[9px]">
                              {taskDef.metrics.length} metric{taskDef.metrics.length > 1 ? "s" : ""}
                            </Badge>
                          )}
                          {taskDef.maxRetries != null && (
                            <span className="text-[10px] text-muted-foreground">max {taskDef.maxRetries} retries</span>
                          )}
                          {live?.result?.duration != null && (
                            <span className="text-[10px] text-muted-foreground ml-auto">
                              {Math.round(live.result.duration / 1000)}s
                            </span>
                          )}
                        </div>
                      </div>
                      {live && (
                        <Link
                          to={`/tasks/${live.id}`}
                          className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
                        >
                          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs">
                            View
                          </Button>
                        </Link>
                      )}
                    </div>

                    {/* Expectations inline */}
                    {taskDef.expectations && taskDef.expectations.length > 0 && (
                      <div className="mt-3 ml-7 space-y-1">
                        {taskDef.expectations.map((exp, i) => (
                          <div key={i} className="flex items-center gap-2 text-[11px]">
                            {live?.result?.assessment?.checks?.[i] != null ? (
                              live.result.assessment.checks[i].passed ? (
                                <CheckCircle2 className="h-3 w-3 text-emerald-500 shrink-0" />
                              ) : (
                                <XCircle className="h-3 w-3 text-red-500 shrink-0" />
                              )
                            ) : (
                              <div className="h-3 w-3 rounded-full border border-border shrink-0" />
                            )}
                            <Badge variant="outline" className="text-[8px] px-1 py-0">{exp.type}</Badge>
                            <span className="text-muted-foreground truncate">
                              {exp.command ?? exp.criteria ?? exp.paths?.join(", ") ?? "LLM review"}
                            </span>
                            {exp.threshold != null && (
                              <span className="text-muted-foreground shrink-0">thr: {exp.threshold}</span>
                            )}
                            {exp.confidence && (
                              <span className="text-muted-foreground shrink-0">{exp.confidence}</span>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}

              {(!parsed || parsed.tasks.length === 0) && (
                <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
                  <ListChecks className="h-10 w-10 mb-3 opacity-40" />
                  <p className="text-sm">No tasks defined in this plan</p>
                </div>
              )}
            </div>
          </ScrollArea>
        </TabsContent>

        {/* Plan Definition tab — full structured view of the plan data */}
        <TabsContent value="definition" className="mt-4 flex-1 min-h-0">
          <ScrollArea className="h-full">
            <div className="space-y-4 pr-4 max-w-3xl">
              {plan.prompt && (
                <Card>
                  <CardContent className="pt-4">
                    <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-2 flex items-center gap-1">
                      <Quote className="h-3 w-3" /> Original Prompt
                    </p>
                    <p className="text-sm leading-relaxed">{plan.prompt}</p>
                  </CardContent>
                </Card>
              )}

              {parsed?.tasks.map((taskDef, idx) => (
                <Card key={idx}>
                  <CardContent className="pt-4 space-y-3">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-mono text-muted-foreground w-6 shrink-0">#{idx + 1}</span>
                      <h3 className="text-sm font-semibold">{taskDef.title}</h3>
                      {taskDef.assignTo && (
                        <Badge variant="outline" className="text-[10px] ml-auto">
                          <Bot className="h-2.5 w-2.5 mr-0.5" /> {taskDef.assignTo}
                        </Badge>
                      )}
                    </div>

                    {taskDef.description && (
                      <p className="text-sm text-muted-foreground leading-relaxed">{taskDef.description}</p>
                    )}

                    {/* Dependencies */}
                    {taskDef.dependsOn && taskDef.dependsOn.length > 0 && (
                      <div className="flex items-center gap-2">
                        <GitBranch className="h-3 w-3 text-muted-foreground shrink-0" />
                        <span className="text-xs text-muted-foreground">Depends on:</span>
                        <div className="flex flex-wrap gap-1">
                          {taskDef.dependsOn.map((d, i) => (
                            <Badge key={i} variant="secondary" className="text-[10px] font-mono">{d}</Badge>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Expectations detail */}
                    {taskDef.expectations && taskDef.expectations.length > 0 && (
                      <div>
                        <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-2">
                          Expectations ({taskDef.expectations.length})
                        </p>
                        <div className="space-y-2">
                          {taskDef.expectations.map((exp, i) => (
                            <div key={i} className="rounded-md border border-border/50 p-2.5 space-y-1.5">
                              <div className="flex items-center gap-2">
                                <Badge variant="outline" className="text-[9px]">{exp.type}</Badge>
                                {exp.confidence && <Badge variant="secondary" className="text-[8px]">{exp.confidence}</Badge>}
                                {exp.threshold != null && (
                                  <span className="text-[10px] text-muted-foreground ml-auto">threshold: {exp.threshold}</span>
                                )}
                              </div>
                              {exp.command && (
                                <code className="block text-[11px] bg-muted/40 rounded px-2 py-1 font-mono">{exp.command}</code>
                              )}
                              {exp.paths && exp.paths.length > 0 && (
                                <div className="flex flex-wrap gap-1">
                                  {exp.paths.map((p, j) => (
                                    <code key={j} className="text-[10px] bg-muted/40 rounded px-1.5 py-0.5 font-mono">{p}</code>
                                  ))}
                                </div>
                              )}
                              {exp.criteria && <p className="text-xs text-muted-foreground">{exp.criteria}</p>}
                              {exp.dimensions && exp.dimensions.length > 0 && (
                                <div className="space-y-0.5 mt-1">
                                  <p className="text-[9px] text-muted-foreground font-medium">Evaluation dimensions:</p>
                                  {exp.dimensions.map((d, k) => (
                                    <div key={k} className="flex items-center gap-2 text-[11px] pl-2">
                                      <span className="font-medium capitalize w-24 shrink-0">{d.name}</span>
                                      <span className="text-muted-foreground">(w: {d.weight})</span>
                                      <span className="text-muted-foreground truncate">{d.description}</span>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Metrics */}
                    {taskDef.metrics && taskDef.metrics.length > 0 && (
                      <div>
                        <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-1">
                          Metrics
                        </p>
                        {taskDef.metrics.map((m, i) => (
                          <div key={i} className="flex items-center gap-2 text-xs">
                            <span className="font-medium">{m.name}</span>
                            <code className="text-[10px] font-mono text-muted-foreground">{m.command}</code>
                            <span className="text-muted-foreground ml-auto shrink-0">thr: {m.threshold}</span>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Retry / duration config */}
                    <div className="flex items-center gap-4 text-[11px] text-muted-foreground">
                      {taskDef.maxRetries != null && <span>Max retries: {taskDef.maxRetries}</span>}
                      {taskDef.maxDuration != null && <span>Timeout: {Math.round(taskDef.maxDuration / 1000)}s</span>}
                      {taskDef.retryPolicy && (
                        <>
                          {taskDef.retryPolicy.escalateAfter != null && <span>Escalate after: {taskDef.retryPolicy.escalateAfter}</span>}
                          {taskDef.retryPolicy.fallbackAgent && <span>Fallback: {taskDef.retryPolicy.fallbackAgent}</span>}
                        </>
                      )}
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </ScrollArea>
        </TabsContent>

        {/* Team tab */}
        <TabsContent value="team" className="mt-4 flex-1 min-h-0">
          <ScrollArea className="h-full">
            <div className="space-y-3 pr-4 max-w-3xl">
              {parsed?.team && parsed.team.length > 0 ? (
                parsed.team.map((agent) => (
                  <Card key={agent.name}>
                    <CardContent className="pt-4 space-y-3">
                      <div className="flex items-center gap-3">
                        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted">
                          <Bot className="h-4 w-4 text-muted-foreground" />
                        </div>
                        <div>
                          <h3 className="text-sm font-semibold">{agent.name}</h3>
                          {agent.role && <p className="text-xs text-muted-foreground">{agent.role}</p>}
                        </div>
                        <div className="flex items-center gap-2 ml-auto">
                          {agent.adapter && (
                            <Badge variant="secondary" className="text-[10px]">{agent.adapter}</Badge>
                          )}
                          {agent.model && (
                            <Badge variant="outline" className="text-[10px] font-mono">{agent.model}</Badge>
                          )}
                        </div>
                      </div>

                      {agent.systemPrompt && (
                        <div>
                          <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-1">
                            System Prompt
                          </p>
                          <p className="text-xs text-muted-foreground bg-muted/30 rounded px-3 py-2 whitespace-pre-wrap">
                            {agent.systemPrompt}
                          </p>
                        </div>
                      )}

                      <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                        {agent.skills && agent.skills.length > 0 && (
                          <div className="flex items-center gap-1">
                            <span>Skills:</span>
                            {agent.skills.map((s) => (
                              <Badge key={s} variant="outline" className="text-[9px]">{s}</Badge>
                            ))}
                          </div>
                        )}
                        {agent.allowedTools && agent.allowedTools.length > 0 && (
                          <div className="flex items-center gap-1">
                            <span>Tools:</span>
                            {agent.allowedTools.map((t) => (
                              <Badge key={t} variant="outline" className="text-[9px] font-mono">{t}</Badge>
                            ))}
                          </div>
                        )}
                        {agent.maxTurns != null && <span>Max turns: {agent.maxTurns}</span>}
                      </div>
                    </CardContent>
                  </Card>
                ))
              ) : (
                <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
                  <Bot className="h-10 w-10 mb-3 opacity-40" />
                  <p className="text-sm">No volatile team defined</p>
                  <p className="text-xs mt-1">This plan uses the project's base team</p>
                </div>
              )}
            </div>
          </ScrollArea>
        </TabsContent>

        {/* Raw JSON tab */}
        <TabsContent value="raw" className="mt-4 flex-1 min-h-0">
          <ScrollArea className="h-full">
            <div className="pr-4 max-w-3xl">
              <div className="flex items-center gap-2 mb-3">
                <FileJson className="h-4 w-4 text-muted-foreground" />
                <span className="text-xs text-muted-foreground">Raw plan data</span>
              </div>
              <pre className="text-xs bg-muted/30 rounded-lg p-4 whitespace-pre-wrap font-mono text-muted-foreground">
                {(() => {
                  try {
                    return JSON.stringify(JSON.parse(plan.data), null, 2);
                  } catch {
                    return plan.data;
                  }
                })()}
              </pre>
            </div>
          </ScrollArea>
        </TabsContent>

        {/* Report tab — PlanReport from plan:completed SSE event */}
        {report && (
          <TabsContent value="report" className="mt-4 flex-1 min-h-0">
            <ScrollArea className="h-full">
              <div className="space-y-4 pr-4 max-w-3xl">
                {/* Summary card */}
                <Card>
                  <CardContent className="pt-4 space-y-4">
                    <div className="flex items-center gap-3">
                      <Badge variant={report.allPassed ? "default" : "destructive"} className="text-sm px-3 py-1">
                        {report.allPassed ? "ALL PASSED" : "SOME FAILED"}
                      </Badge>
                      {report.avgScore != null && (
                        <div className="flex items-center gap-2">
                          <Star className="h-4 w-4 text-amber-400" />
                          <span className="text-lg font-bold">{report.avgScore.toFixed(2)}</span>
                          <span className="text-xs text-muted-foreground">/ 5 avg</span>
                        </div>
                      )}
                      <div className="flex items-center gap-1 ml-auto text-xs text-muted-foreground">
                        <Timer className="h-3 w-3" />
                        {Math.round(report.totalDuration / 1000)}s total
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-4 text-sm">
                      <div>
                        <span className="text-xs text-muted-foreground block mb-1">Group</span>
                        <code className="text-xs font-mono">{report.group}</code>
                      </div>
                      <div>
                        <span className="text-xs text-muted-foreground block mb-1">Tasks</span>
                        <span>{report.tasks.length} total</span>
                      </div>
                    </div>

                    {/* Aggregated file changes */}
                    {(report.filesCreated.length > 0 || report.filesEdited.length > 0) && (
                      <div className="space-y-2">
                        {report.filesCreated.length > 0 && (
                          <div>
                            <span className="text-[10px] text-muted-foreground font-medium uppercase tracking-wider flex items-center gap-1 mb-1">
                              <FilePlus className="h-3 w-3" /> Files Created ({report.filesCreated.length})
                            </span>
                            <div className="flex flex-wrap gap-1">
                              {report.filesCreated.map((f: string, i: number) => (
                                <code key={i} className="text-[10px] bg-emerald-500/10 text-emerald-400 rounded px-1.5 py-0.5 font-mono">{f}</code>
                              ))}
                            </div>
                          </div>
                        )}
                        {report.filesEdited.length > 0 && (
                          <div>
                            <span className="text-[10px] text-muted-foreground font-medium uppercase tracking-wider flex items-center gap-1 mb-1">
                              <FileEdit className="h-3 w-3" /> Files Edited ({report.filesEdited.length})
                            </span>
                            <div className="flex flex-wrap gap-1">
                              {report.filesEdited.map((f: string, i: number) => (
                                <code key={i} className="text-[10px] bg-blue-500/10 text-blue-400 rounded px-1.5 py-0.5 font-mono">{f}</code>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </CardContent>
                </Card>

                {/* Per-task breakdown */}
                <Card>
                  <CardContent className="pt-4">
                    <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-3">
                      Per-Task Results
                    </p>
                    <div className="space-y-2">
                      {report.tasks.map((t: PlanReport["tasks"][number], i: number) => (
                        <div key={i} className="rounded-md border border-border p-3">
                          <div className="flex items-center gap-2">
                            {t.status === "done" ? (
                              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
                            ) : (
                              <XCircle className="h-3.5 w-3.5 text-red-500 shrink-0" />
                            )}
                            <span className="text-sm font-medium truncate">{t.title}</span>
                            {t.score != null && (
                              <Badge variant="outline" className="text-[9px] ml-auto shrink-0">
                                <Star className="h-2.5 w-2.5 mr-0.5" />
                                {t.score.toFixed(1)}
                              </Badge>
                            )}
                            <span className="text-[10px] text-muted-foreground shrink-0">
                              {Math.round(t.duration / 1000)}s
                            </span>
                          </div>
                          {(t.filesCreated.length > 0 || t.filesEdited.length > 0) && (
                            <div className="flex flex-wrap gap-1 mt-2 ml-5">
                              {t.filesCreated.map((f: string, j: number) => (
                                <code key={`c-${j}`} className="text-[9px] bg-emerald-500/10 text-emerald-400 rounded px-1 py-0 font-mono">+{f.split("/").pop()}</code>
                              ))}
                              {t.filesEdited.map((f: string, j: number) => (
                                <code key={`e-${j}`} className="text-[9px] bg-blue-500/10 text-blue-400 rounded px-1 py-0 font-mono">~{f.split("/").pop()}</code>
                              ))}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              </div>
            </ScrollArea>
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}
