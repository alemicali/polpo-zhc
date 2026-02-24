import { useState } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  ArrowLeft,
  CheckCircle2,
  Clock,
  AlertTriangle,
  Loader2,
  RotateCcw,
  XCircle,
  RefreshCw,
  ChevronDown,
  Eye,
  Star,
  Bot,
  GitBranch,
  FileText,
  Wrench,
  HelpCircle,
  Hammer,
  Timer,
  ArrowUpCircle,
  Terminal,
  Activity,
  FileEdit,
  Zap,
  Hash,
  Map,
  Copy,
  Check,
  FileCode,
  Scale,
  Package,
  Image,
  FileAudio,
  Link2,
  FileJson,
  File,
} from "lucide-react";
import { MessageResponse } from "@/components/ai-elements/message";
import { useTask, useTasks, useProcesses, useTaskActivity } from "@openpolpo/react-sdk";
import type { TaskStatus, DimensionScore, CheckResult, EvalDimension, AssessmentResult, AssessmentTrigger, AgentProcess, RunActivityEntry } from "@openpolpo/react-sdk";
import { toast } from "sonner";
import { formatDistanceToNow, format } from "date-fns";
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

const triggerLabels: Record<AssessmentTrigger, { label: string; color: string }> = {
  initial: { label: "Initial", color: "text-blue-400" },
  reassess: { label: "Re-assessed", color: "text-amber-400" },
  fix: { label: "After Fix", color: "text-orange-400" },
  retry: { label: "After Retry", color: "text-violet-400" },
  "auto-correct": { label: "Auto-corrected", color: "text-emerald-400" },
  judge: { label: "Judge Review", color: "text-sky-400" },
};

function TriggerBadge({ trigger }: { trigger?: AssessmentTrigger }) {
  if (!trigger) return null;
  const cfg = triggerLabels[trigger];
  return (
    <Badge variant="outline" className={cn("text-[9px]", cfg.color)}>
      {cfg.label}
    </Badge>
  );
}

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

function ScoreBar({ score, label }: { score: number; label: string }) {
  const pct = Math.round(score * 100);
  const color = pct >= 80 ? "bg-emerald-500" : pct >= 60 ? "bg-amber-500" : "bg-red-500";
  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] text-muted-foreground w-24 truncate capitalize">{label}</span>
      <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
        <div className={cn("h-full rounded-full transition-all", color)} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-[10px] font-mono w-8 text-right">{pct}%</span>
    </div>
  );
}

function DimensionScores({ scores }: { scores: DimensionScore[] }) {
  return (
    <div className="space-y-2">
      {scores.map((s) => (
        <div key={s.dimension}>
          <div className="flex items-center gap-2">
            <ScoreBar score={s.score / 5} label={s.dimension} />
            <span className="text-[9px] text-muted-foreground shrink-0">
              <Scale className="h-2.5 w-2.5 inline mr-0.5" />w:{s.weight}
            </span>
          </div>
          {s.reasoning && (
            <p className="text-[11px] text-muted-foreground ml-[104px] mt-0.5">
              {s.reasoning}
            </p>
          )}
          {s.evidence && s.evidence.length > 0 && (
            <div className="ml-[104px] mt-1 space-y-0.5">
              {s.evidence.map((e, i) => (
                <div key={i} className="flex items-center gap-2 text-[10px]">
                  <FileCode className="h-3 w-3 text-muted-foreground shrink-0" />
                  <code className="font-mono text-muted-foreground">{e.file}:{e.line}</code>
                  <span className="text-muted-foreground truncate">{e.note}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ── Live activity strip ──

function LiveActivityStrip({ process }: { process: AgentProcess }) {
  const { activity } = process;
  if (!activity.lastTool && !activity.lastFile && !activity.summary) {
    return (
      <div className="flex items-center gap-2 px-4 py-2 bg-blue-500/5 rounded-lg border border-blue-500/10">
        <div className="h-1.5 w-1.5 rounded-full bg-blue-400 animate-pulse" />
        <span className="text-xs text-blue-400">Running...</span>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-3 px-4 py-2 bg-blue-500/5 rounded-lg border border-blue-500/10">
      <div className="h-1.5 w-1.5 rounded-full bg-blue-400 animate-pulse shrink-0" />
      {activity.lastTool && (
        <Badge variant="outline" className="text-[10px] font-mono px-1.5 py-0 text-blue-400 border-blue-400/30">
          <Wrench className="h-2.5 w-2.5 mr-0.5" />
          {activity.lastTool}
        </Badge>
      )}
      {activity.lastFile && (
        <span className="text-[11px] font-mono text-muted-foreground truncate">
          {activity.lastFile.split("/").pop()}
        </span>
      )}
      {activity.summary && !activity.lastTool && (
        <span className="text-xs text-muted-foreground truncate">{activity.summary}</span>
      )}
      <div className="flex items-center gap-3 ml-auto shrink-0">
        {activity.toolCalls > 0 && (
          <span className="text-[11px] text-muted-foreground flex items-center gap-1">
            <Zap className="h-3 w-3" /> {activity.toolCalls} calls
          </span>
        )}
        {(activity.filesCreated.length + activity.filesEdited.length) > 0 && (
          <span className="text-[11px] text-muted-foreground flex items-center gap-1">
            <FileEdit className="h-3 w-3" /> {activity.filesCreated.length + activity.filesEdited.length} files
          </span>
        )}
        {(activity.totalTokens ?? 0) > 0 && (
          <span className="text-[11px] text-muted-foreground flex items-center gap-1">
            {((activity.totalTokens ?? 0) / 1000).toFixed(1)}k tokens
          </span>
        )}
      </div>
    </div>
  );
}

// ── Activity entry ──

function ActivityEntry({ entry }: { entry: RunActivityEntry }) {
  const [open, setOpen] = useState(false);
  if (entry._run) return null;

  // Determine what to show in the collapsed row and in the expanded body
  const isToolUse = entry.type === "tool_use";
  const isToolResult = entry.type === "tool_result";
  const isAssistant = entry.type === "assistant";

  const eventLabel = entry.event ?? entry.type ?? "unknown";

  // Build expandable content depending on entry type
  let expandContent: string | undefined;
  if (isToolUse && entry.input) {
    expandContent = JSON.stringify(entry.input, null, 2);
  } else if (isToolResult) {
    expandContent = entry.content ?? entry.text;
  } else if (isAssistant) {
    expandContent = entry.text;
  } else if (entry.data != null) {
    expandContent = JSON.stringify(entry.data, null, 2);
  } else if (entry.text) {
    expandContent = entry.text;
  } else if (entry.content) {
    expandContent = entry.content;
  }

  const hasPayload = expandContent != null && expandContent.length > 0;

  const getStyle = () => {
    if (entry.event === "activity") return { icon: Activity, color: "text-blue-400", dot: "bg-blue-500" };
    if (entry.event === "spawning" || entry.event === "spawned") return { icon: Loader2, color: "text-emerald-400", dot: "bg-emerald-500" };
    if (entry.event === "done") return { icon: CheckCircle2, color: "text-zinc-400", dot: "bg-zinc-500" };
    if (entry.event === "error") return { icon: XCircle, color: "text-red-400", dot: "bg-red-500" };
    if (entry.event === "sigterm") return { icon: XCircle, color: "text-amber-400", dot: "bg-amber-500" };
    if (entry.type === "stdout") return { icon: Terminal, color: "text-emerald-400", dot: "bg-emerald-500" };
    if (isToolUse) return { icon: Wrench, color: "text-violet-400", dot: "bg-violet-500" };
    if (isToolResult && entry.isError) return { icon: XCircle, color: "text-red-400", dot: "bg-red-500" };
    if (isToolResult) return { icon: CheckCircle2, color: "text-emerald-400", dot: "bg-emerald-500" };
    if (isAssistant) return { icon: Bot, color: "text-sky-400", dot: "bg-sky-500" };
    return { icon: FileText, color: "text-zinc-400", dot: "bg-zinc-500" };
  };

  const style = getStyle();
  const Icon = style.icon;

  // Inline summary for the collapsed row
  let inlineSummary: string | undefined;
  if (isToolUse && entry.tool) {
    // Show tool name + short arg hint
    const args = entry.input;
    const hint = args
      ? Object.entries(args)
          .filter(([, v]) => typeof v === "string" && (v as string).length < 80)
          .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
          .slice(0, 2)
          .join(", ")
      : "";
    inlineSummary = hint ? `${hint}` : undefined;
  } else if (isToolResult && entry.tool) {
    const preview = (entry.content ?? entry.text ?? "").slice(0, 80).replace(/\n/g, " ");
    inlineSummary = preview || undefined;
  } else if (isAssistant && entry.text) {
    inlineSummary = entry.text.slice(0, 100).replace(/\n/g, " ");
  }

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <div className={cn(
          "flex items-center gap-2.5 px-3 py-2.5 rounded-md cursor-pointer transition-colors",
          open ? "bg-muted/40" : "hover:bg-muted/20"
        )}>
          <div className={cn("h-2 w-2 rounded-full shrink-0", style.dot)} />
          <Icon className={cn("h-4 w-4 shrink-0", style.color)} />
          <Badge variant="outline" className="text-xs font-mono px-2 py-0.5 shrink-0">
            {eventLabel}
          </Badge>
          {/* Tool name badge for tool_use / tool_result */}
          {entry.tool && (
            <Badge variant="secondary" className={cn(
              "text-[10px] font-mono px-1.5 py-0 shrink-0",
              isToolResult && entry.isError && "text-red-400 border-red-400/30"
            )}>
              {entry.tool}
            </Badge>
          )}
          {/* Inline summary */}
          {inlineSummary && (
            <span className="text-xs text-muted-foreground truncate min-w-0">
              {inlineSummary}
            </span>
          )}
          <span className="text-sm text-muted-foreground ml-auto shrink-0">
            {entry.ts ? new Date(entry.ts).toLocaleTimeString() : ""}
          </span>
          {hasPayload && (
            <ChevronDown className={cn("h-3.5 w-3.5 text-muted-foreground transition-transform shrink-0", open && "rotate-180")} />
          )}
        </div>
      </CollapsibleTrigger>
      {hasPayload && (
        <CollapsibleContent>
          <div className="ml-7 mr-2 mb-0.5">
            <pre className={cn(
              "text-sm rounded px-3 py-2 whitespace-pre-wrap font-mono overflow-x-auto max-h-56 overflow-y-auto leading-normal",
              isToolResult && entry.isError
                ? "bg-red-500/5 text-red-400/80"
                : "bg-muted/30 text-muted-foreground"
            )}>
              {expandContent}
            </pre>
          </div>
        </CollapsibleContent>
      )}
    </Collapsible>
  );
}

type ActivityFilter = "all" | "conversation" | "tools" | "lifecycle";

function ActivityPanel({ taskId, isActive }: { taskId: string; isActive?: boolean }) {
  const [filter, setFilter] = useState<ActivityFilter>("all");
  const { entries, isLoading, error, refetch } = useTaskActivity(taskId, {
    pollIntervalMs: isActive ? 1000 : 0,
  });

  const stats = entries.reduce((acc, e) => {
    if (e.event === "activity") acc.snapshots++;
    if (e.type === "assistant") acc.assistant++;
    if (e.type === "tool_use") acc.tools++;
    if (e.type === "tool_result") acc.results++;
    if (e.event === "error" || e.type === "error") acc.errors++;
    if (e.event === "spawning" || e.event === "spawned" || e.event === "done" || e.event === "sigterm") acc.lifecycle++;
    return acc;
  }, { snapshots: 0, assistant: 0, tools: 0, results: 0, errors: 0, lifecycle: 0 });

  // Filter entries based on the active filter
  // Activity snapshots (event: "activity") are always hidden — they're internal telemetry
  // already visible in the Overview tab (filesCreated, toolCalls, totalTokens, etc.)
  const filteredEntries = entries.filter((e) => {
    if (e._run) return false; // always hide header
    if (e.event === "activity") return false; // always hide activity snapshots
    if (filter === "all") return true;
    if (filter === "conversation") {
      return e.type === "assistant" || e.type === "tool_use" || e.type === "tool_result"
        || e.type === "error" || e.type === "result" || e.event === "error";
    }
    if (filter === "tools") {
      return e.type === "tool_use" || e.type === "tool_result";
    }
    if (filter === "lifecycle") {
      return e.event === "spawning" || e.event === "spawned" || e.event === "done"
        || e.event === "sigterm" || e.event === "error";
    }
    return true;
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error || entries.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
        <Activity className="h-8 w-8 mb-2 opacity-40" />
        <p className="text-sm">{error ? "Failed to load activity" : "No activity history yet"}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-3">
      {/* Filter bar + stats */}
      <div className="flex items-center justify-between shrink-0">
        <div className="flex items-center gap-1.5">
          {(
            [
              { key: "all", label: "All", icon: Hash, count: entries.filter(e => !e._run && e.event !== "activity").length },
              { key: "conversation", label: "Conversation", icon: Bot, count: stats.assistant + stats.tools + stats.results },
              { key: "tools", label: "Tools", icon: Wrench, count: stats.tools },
              { key: "lifecycle", label: "Lifecycle", icon: Activity, count: stats.lifecycle },
            ] as const
          ).map(({ key, label, icon: FIcon, count }) => (
            <Button
              key={key}
              variant={filter === key ? "secondary" : "ghost"}
              size="sm"
              className={cn("text-xs h-7 px-2.5 gap-1.5", filter === key && "font-medium")}
              onClick={() => setFilter(key)}
            >
              <FIcon className="h-3 w-3" />
              {label}
              <span className="text-[10px] text-muted-foreground">{count}</span>
            </Button>
          ))}
          {stats.errors > 0 && (
            <span className="text-xs text-red-400 flex items-center gap-1 ml-2">
              <XCircle className="h-3.5 w-3.5" /> {stats.errors} errors
            </span>
          )}
        </div>
        <Button variant="ghost" size="sm" onClick={refetch}>
          <RefreshCw className="h-3.5 w-3.5" />
        </Button>
      </div>
      <ScrollArea className="h-[calc(100vh-16rem)]">
        <div className="space-y-0.5 pr-2">
          {[...filteredEntries].reverse().map((entry, i) => (
            <ActivityEntry key={`${entry.ts}-${entry.type ?? entry.event}-${i}`} entry={entry} />
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}

// ── Assessment history row (compact, collapsible) ──

function AssessmentHistoryRow({ assessment, index }: { assessment: AssessmentResult; index: number }) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <div className={cn(
          "flex items-center gap-2 px-3 py-2 rounded-md cursor-pointer transition-colors",
          open ? "bg-muted/40" : "hover:bg-muted/20"
        )}>
          <span className="text-[10px] text-muted-foreground w-5 text-center shrink-0">#{index + 1}</span>
          {assessment.passed ? (
            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
          ) : (
            <XCircle className="h-3.5 w-3.5 text-red-500 shrink-0" />
          )}
          <TriggerBadge trigger={assessment.trigger} />
          {assessment.globalScore != null && (
            <span className="text-xs font-mono">{Math.round(assessment.globalScore * 100)}%</span>
          )}
          <span className="text-[11px] text-muted-foreground ml-auto shrink-0">
            {assessment.timestamp ? formatDistanceToNow(new Date(assessment.timestamp), { addSuffix: true }) : ""}
          </span>
          <ChevronDown className={cn("h-3 w-3 text-muted-foreground transition-transform shrink-0", open && "rotate-180")} />
        </div>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="ml-8 mr-2 mb-2 space-y-3 pt-1">
          {assessment.checks.length > 0 && (
            <div className="space-y-1.5">
              {assessment.checks.map((c: CheckResult, i: number) => (
                <div key={i} className="space-y-1">
                  <div className="flex items-center gap-2 text-xs">
                    {c.passed ? (
                      <CheckCircle2 className="h-3 w-3 text-emerald-500 shrink-0" />
                    ) : (
                      <XCircle className="h-3 w-3 text-red-500 shrink-0" />
                    )}
                    <Badge variant="outline" className="text-[8px] font-mono px-1 py-0">{c.type}</Badge>
                    <span className="text-muted-foreground">{c.message}</span>
                    {c.globalScore != null && (
                      <span className="text-[10px] font-mono text-muted-foreground ml-auto">{c.globalScore.toFixed(2)}/5</span>
                    )}
                  </div>
                  {c.details && <p className="text-[10px] text-muted-foreground ml-5">{c.details}</p>}
                  {c.scores && c.scores.length > 0 && (
                    <div className="ml-5">
                      <DimensionScores scores={c.scores} />
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
          {assessment.scores && assessment.scores.length > 0 && (
            <DimensionScores scores={assessment.scores} />
          )}
          {assessment.llmReview && (
            <p className="text-xs text-muted-foreground line-clamp-4">{assessment.llmReview.slice(0, 300)}</p>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

// ── Main page ──

export function TaskDetailPage() {
  const { taskId } = useParams<{ taskId: string }>();
  const navigate = useNavigate();
  const { task, isLoading, error, retryTask, killTask, reassessTask, queueTask } = useTask(taskId ?? "");
  const { tasks: allTasks } = useTasks();
  const { processes } = useProcesses();

  // Resolve dependsOn IDs to task titles
  const depTitleMap: Record<string, string> = {};
  if (task?.dependsOn) {
    for (const depId of task.dependsOn) {
      const dep = allTasks.find(t => t.id === depId);
      if (dep) depTitleMap[depId] = dep.title;
    }
  }
  const process = task ? processes.find(p => p.taskId === task.id) : undefined;

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

  if (error || !task) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-muted-foreground">
        <AlertTriangle className="h-10 w-10 opacity-40" />
        <p className="text-sm">Task not found</p>
        <Button variant="outline" size="sm" onClick={() => navigate("/tasks")}>
          <ArrowLeft className="h-3.5 w-3.5 mr-1.5" />
          Back to Tasks
        </Button>
      </div>
    );
  }

  const cfg = statusConfig[task.status];
  const StatusIcon = cfg.icon;
  const assessment = task.result?.assessment;
  const phase = task.phase && task.phase !== "execution" ? phaseConfig[task.phase] : null;

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-4">
      {/* Back + title bar */}
      <div className="flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <Button variant="ghost" size="sm" onClick={() => navigate("/tasks")} className="shrink-0">
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-lg", cfg.bg)}>
            <StatusIcon className={cn("h-4 w-4", cfg.color, task.status === "in_progress" && "animate-spin")} />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-semibold truncate">{task.title}</h1>
              <Badge variant="outline" className={cn("text-xs shrink-0", cfg.color)}>{cfg.label}</Badge>
              {phase && (
                <Badge variant="outline" className={cn("text-xs gap-1 shrink-0", phase.color)}>
                  <phase.icon className="h-3 w-3" />
                  {phase.label}
                </Badge>
              )}
            </div>
            <div className="flex items-center gap-3 mt-0.5 text-xs text-muted-foreground">
              <CopyableId id={task.id} label="Task ID" />
              <span className="flex items-center gap-1">
                <Bot className="h-3 w-3" /> {task.assignTo}
              </span>
              {task.group && (
                <Link to={`/plans`} className="flex items-center gap-1 hover:text-foreground transition-colors">
                  <Map className="h-3 w-3" /> {task.group}
                </Link>
              )}
              {task.sessionId && (
                <span className="flex items-center gap-1 font-mono text-[10px]">
                  session: {task.sessionId.slice(0, 8)}
                </span>
              )}
              <span>Created {format(new Date(task.createdAt), "MMM d, HH:mm")}</span>
              <span>Updated {formatDistanceToNow(new Date(task.updatedAt), { addSuffix: true })}</span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {task.status === "draft" && (
            <Button variant="outline" size="sm" onClick={() => handleAction(queueTask, "Queued")}>
              <Zap className="h-3.5 w-3.5 mr-1.5" /> Queue
            </Button>
          )}
          {task.status === "failed" && (
            <Button variant="outline" size="sm" onClick={() => handleAction(retryTask, "Retried")}>
              <RotateCcw className="h-3.5 w-3.5 mr-1.5" /> Retry
            </Button>
          )}
          {(task.status === "in_progress" || task.status === "assigned") && (
            <Button variant="outline" size="sm" className="text-red-400 hover:text-red-500" onClick={() => handleAction(killTask, "Killed")}>
              <XCircle className="h-3.5 w-3.5 mr-1.5" /> Kill
            </Button>
          )}
          {(task.status === "failed" || (task.status === "done" && assessment?.globalScore != null && assessment.globalScore < 0.8)) && (
            <Button variant="outline" size="sm" onClick={() => handleAction(reassessTask, "Re-assessed")}>
              <RefreshCw className="h-3.5 w-3.5 mr-1.5" /> Re-assess
            </Button>
          )}
        </div>
      </div>

      {/* Live activity for running tasks */}
      {process && <LiveActivityStrip process={process} />}

      {/* Tabs */}
      <Tabs defaultValue="overview" className="flex flex-col flex-1 min-h-0">
        <TabsList className="shrink-0">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="assessment">
            Assessment
            {assessment && (
              <Badge variant={assessment.passed ? "default" : "destructive"} className="ml-1.5 text-[9px]">
                {assessment.passed ? "Pass" : "Fail"}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="activity">Activity</TabsTrigger>
          <TabsTrigger value="output">Output</TabsTrigger>
        </TabsList>

        {/* Overview tab */}
        <TabsContent value="overview" className="mt-4 flex-1 min-h-0">
          <ScrollArea className="h-full">
            <div className="space-y-6 pr-4 max-w-3xl">
              {/* Description */}
              <Card>
                <CardContent className="pt-4 space-y-4">
                  <div>
                    <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-2 flex items-center gap-1">
                      <FileText className="h-3 w-3" /> Description
                    </p>
                    <div className="rounded-md bg-muted/30 px-4 py-3 text-sm">
                      <MessageResponse>{task.description}</MessageResponse>
                    </div>
                  </div>
                  {task.originalDescription && task.originalDescription !== task.description && (
                    <div>
                      <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-2">
                        Original Description
                      </p>
                      <div className="rounded-md bg-muted/20 px-4 py-3 text-sm opacity-70">
                        <MessageResponse>{task.originalDescription}</MessageResponse>
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Expectations */}
              {task.expectations.length > 0 && (
                <Card>
                  <CardContent className="pt-4">
                    <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-3 flex items-center gap-1">
                      <Wrench className="h-3 w-3" /> Expectations ({task.expectations.length})
                    </p>
                    <div className="space-y-2">
                      {task.expectations.map((exp, i) => (
                        <div key={i} className="rounded-md border border-border p-3 space-y-2">
                          <div className="flex items-center gap-2">
                            <Badge variant="outline" className="text-[10px]">{exp.type}</Badge>
                            {exp.confidence && (
                              <Badge variant="secondary" className="text-[9px]">{exp.confidence}</Badge>
                            )}
                            {exp.threshold != null && (
                              <span className="text-[11px] text-muted-foreground ml-auto">
                                Threshold: {exp.threshold}
                              </span>
                            )}
                          </div>
                          {exp.command && (
                            <code className="block text-[11px] bg-muted/40 rounded px-2 py-1 font-mono text-muted-foreground">
                              {exp.command}
                            </code>
                          )}
                          {exp.paths && exp.paths.length > 0 && (
                            <div className="flex flex-wrap gap-1">
                              {exp.paths.map((p, j) => (
                                <code key={j} className="text-[11px] bg-muted/40 rounded px-2 py-0.5 font-mono text-muted-foreground">{p}</code>
                              ))}
                            </div>
                          )}
                          {exp.criteria && (
                            <p className="text-xs text-muted-foreground">{exp.criteria}</p>
                          )}
                          {exp.dimensions && exp.dimensions.length > 0 && (
                            <div className="space-y-2 mt-1">
                              <p className="text-[10px] text-muted-foreground font-medium">Dimensions:</p>
                              {exp.dimensions.map((d: EvalDimension, k: number) => (
                                <div key={k} className="pl-2 space-y-1">
                                  <div className="flex items-center gap-2 text-xs">
                                    <span className="font-medium capitalize">{d.name}</span>
                                    <span className="text-muted-foreground">(w: {d.weight})</span>
                                    <span className="text-muted-foreground truncate">{d.description}</span>
                                  </div>
                                  {d.rubric && Object.keys(d.rubric).length > 0 && (
                                    <div className="ml-4 space-y-0.5">
                                      {Object.entries(d.rubric)
                                        .sort(([a], [b]) => Number(a) - Number(b))
                                        .map(([level, desc]) => (
                                          <div key={level} className="flex items-start gap-2 text-[10px]">
                                            <Badge variant="outline" className="text-[8px] px-1 py-0 shrink-0">{level}</Badge>
                                            <span className="text-muted-foreground">{String(desc)}</span>
                                          </div>
                                        ))}
                                    </div>
                                  )}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              )}

              {/* Outcomes (produced artifacts) */}
              {(task.outcomes?.length ?? 0) > 0 && (
                <Card>
                  <CardContent className="pt-4">
                    <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-3 flex items-center gap-1">
                      <Package className="h-3 w-3" /> Outcomes ({task.outcomes!.length})
                    </p>
                    <div className="space-y-2">
                      {task.outcomes!.map((o) => {
                        const OutcomeIcon = o.type === "media"
                          ? (o.mimeType?.startsWith("image/") ? Image : o.mimeType?.startsWith("audio/") ? FileAudio : File)
                          : o.type === "url" ? Link2
                          : o.type === "json" ? FileJson
                          : o.type === "text" ? FileText
                          : File;
                        return (
                          <div key={o.id} className="rounded-md border border-border p-3 space-y-1.5">
                            <div className="flex items-center gap-2">
                              <OutcomeIcon className="h-4 w-4 text-muted-foreground shrink-0" />
                              <span className="text-sm font-medium">{o.label}</span>
                              <Badge variant="outline" className="text-[9px]">{o.type}</Badge>
                              {o.mimeType && (
                                <span className="text-[10px] text-muted-foreground font-mono">{o.mimeType}</span>
                              )}
                              {o.size != null && (
                                <span className="text-[10px] text-muted-foreground ml-auto">
                                  {o.size > 1024 * 1024
                                    ? `${(o.size / 1024 / 1024).toFixed(1)} MB`
                                    : `${(o.size / 1024).toFixed(1)} KB`}
                                </span>
                              )}
                            </div>
                            {o.path && (
                              <button
                                onClick={() => {
                                  navigator.clipboard.writeText(o.path!);
                                  toast.success("Path copied to clipboard");
                                }}
                                className="flex items-center gap-1.5 text-[11px] bg-muted/40 rounded px-2 py-1.5 font-mono text-blue-400 hover:text-blue-300 hover:bg-muted/60 transition-colors cursor-pointer w-full text-left group"
                                title={`Click to copy: ${o.path}`}
                              >
                                <Copy className="h-3 w-3 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
                                <span className="truncate">{o.path}</span>
                              </button>
                            )}
                            {o.url && (
                              <a href={o.url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1.5 text-xs text-blue-400 hover:underline truncate">
                                <Link2 className="h-3 w-3 shrink-0" />
                                {o.url}
                              </a>
                            )}
                            {o.text && (
                              <p className="text-xs text-muted-foreground line-clamp-3">{o.text}</p>
                            )}
                            {o.producedBy && (
                              <span className="text-[10px] text-muted-foreground">
                                via <code className="font-mono">{o.producedBy}</code>
                                {o.producedAt && <> at {new Date(o.producedAt).toLocaleTimeString()}</>}
                              </span>
                            )}
                            {o.tags && o.tags.length > 0 && (
                              <div className="flex gap-1">
                                {o.tags.map(t => (
                                  <Badge key={t} variant="secondary" className="text-[8px]">{t}</Badge>
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </CardContent>
                </Card>
              )}

              {/* Expected Outcomes (declared, not yet produced) */}
              {(task.expectedOutcomes?.length ?? 0) > 0 && !(task.outcomes?.length) && (
                <Card>
                  <CardContent className="pt-4">
                    <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-3 flex items-center gap-1">
                      <Package className="h-3 w-3" /> Expected Outcomes ({task.expectedOutcomes!.length})
                    </p>
                    <div className="space-y-2">
                      {task.expectedOutcomes!.map((o, i) => (
                        <div key={i} className="flex items-center gap-2 rounded-md border border-dashed border-border/50 p-2.5">
                          <Badge variant="outline" className="text-[9px]">{o.type}</Badge>
                          <span className="text-xs font-medium">{o.label}</span>
                          {o.required && <Badge variant="secondary" className="text-[8px]">required</Badge>}
                          {o.description && <span className="text-[10px] text-muted-foreground truncate">{o.description}</span>}
                          {o.path && <code className="text-[10px] font-mono text-muted-foreground ml-auto">{o.path}</code>}
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              )}

              {/* Metrics */}
              {task.metrics.length > 0 && (
                <Card>
                  <CardContent className="pt-4">
                    <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-3">
                      Metrics ({task.metrics.length})
                    </p>
                    <div className="space-y-2">
                      {task.metrics.map((m, i) => (
                        <div key={i} className="flex items-center gap-3 text-sm rounded-md bg-muted/30 px-3 py-2">
                          <span className="font-medium">{m.name}</span>
                          <code className="text-xs text-muted-foreground font-mono truncate">{m.command}</code>
                          <span className="text-xs text-muted-foreground shrink-0 ml-auto">threshold: {m.threshold}</span>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              )}

              {/* Metadata card */}
              <Card>
                <CardContent className="pt-4">
                  <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-3">
                    Details
                  </p>
                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <div>
                      <span className="text-xs text-muted-foreground block">Retries</span>
                      <span>{task.retries} / {task.maxRetries}</span>
                    </div>
                    {task.maxDuration != null && task.maxDuration > 0 && (
                      <div>
                        <span className="text-xs text-muted-foreground block">Timeout</span>
                        <span className="flex items-center gap-1">
                          <Timer className="h-3 w-3" /> {Math.round(task.maxDuration / 1000)}s
                        </span>
                      </div>
                    )}
                    {task.fixAttempts != null && task.fixAttempts > 0 && (
                      <div>
                        <span className="text-xs text-muted-foreground block">Fix Attempts</span>
                        <span>{task.fixAttempts}</span>
                      </div>
                    )}
                    {task.questionRounds != null && task.questionRounds > 0 && (
                      <div>
                        <span className="text-xs text-muted-foreground block">Question Rounds</span>
                        <span>{task.questionRounds}</span>
                      </div>
                    )}
                    {task.resolutionAttempts != null && task.resolutionAttempts > 0 && (
                      <div>
                        <span className="text-xs text-muted-foreground block">Deadlock Resolutions</span>
                        <span>{task.resolutionAttempts}</span>
                      </div>
                    )}
                    {task.dependsOn.length > 0 && (
                      <div className="col-span-2">
                        <span className="text-xs text-muted-foreground flex items-center gap-1 mb-1">
                          <GitBranch className="h-3 w-3" /> Dependencies ({task.dependsOn.length})
                        </span>
                        <div className="flex flex-col gap-1">
                          {task.dependsOn.map((dep) => {
                            const depTitle = depTitleMap[dep];
                            const depTask = allTasks.find(t => t.id === dep);
                            return (
                              <button
                                key={dep}
                                onClick={() => navigate(`/tasks/${dep}`)}
                                className="flex items-center gap-2 text-left text-xs hover:bg-muted/50 rounded px-2 py-1 transition-colors"
                              >
                                <GitBranch className="h-3 w-3 text-muted-foreground shrink-0" />
                                <span className="truncate">{depTitle || dep}</span>
                                {depTask && (
                                  <Badge variant="outline" className="text-[9px] px-1 py-0 shrink-0">
                                    {depTask.status}
                                  </Badge>
                                )}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}
                    {task.retryPolicy && (
                      <div className="col-span-2">
                        <span className="text-xs text-muted-foreground flex items-center gap-1 mb-1">
                          <ArrowUpCircle className="h-3 w-3" /> Retry Policy
                        </span>
                        <div className="flex items-center gap-3 text-xs">
                          {task.retryPolicy.escalateAfter != null && <span>Escalate after {task.retryPolicy.escalateAfter} failures</span>}
                          {task.retryPolicy.fallbackAgent && <span>Fallback: <code className="font-mono">{task.retryPolicy.fallbackAgent}</code></span>}
                          {task.retryPolicy.escalateModel && <span>Model: <code className="font-mono">{task.retryPolicy.escalateModel}</code></span>}
                        </div>
                      </div>
                    )}
                    {task.result && (
                      <>
                        <div>
                          <span className="text-xs text-muted-foreground block">Duration</span>
                          <span>{Math.round(task.result.duration / 1000)}s</span>
                        </div>
                        <div>
                          <span className="text-xs text-muted-foreground block">Exit Code</span>
                          <span className={task.result.exitCode !== 0 ? "text-red-400" : ""}>{task.result.exitCode}</span>
                        </div>
                      </>
                    )}
                  </div>
                </CardContent>
              </Card>
            </div>
          </ScrollArea>
        </TabsContent>

        {/* Assessment tab */}
        <TabsContent value="assessment" className="mt-4 flex-1 min-h-0">
          <ScrollArea className="h-full">
            <div className="space-y-6 pr-4 max-w-3xl">
              {assessment ? (
                <>
                  {/* Current assessment */}
                  <Card>
                    <CardContent className="pt-4 space-y-4">
                      <div className="flex items-center gap-3">
                        <Badge variant={assessment.passed ? "default" : "destructive"} className="text-sm px-3 py-1">
                          {assessment.passed ? "PASSED" : "FAILED"}
                        </Badge>
                        <TriggerBadge trigger={assessment.trigger} />
                        {assessment.globalScore != null && (
                          <div className="flex items-center gap-2 ml-2">
                            <Progress value={assessment.globalScore * 100} className="h-2 w-40" />
                            <span className="text-lg font-bold">{Math.round(assessment.globalScore * 100)}%</span>
                          </div>
                        )}
                        {assessment.timestamp && (
                          <span className="text-xs text-muted-foreground ml-auto">
                            {formatDistanceToNow(new Date(assessment.timestamp), { addSuffix: true })}
                          </span>
                        )}
                      </div>

                      {/* Dimension scores */}
                      {assessment.scores && assessment.scores.length > 0 && (
                        <div>
                          <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-2">
                            Dimension Scores
                          </p>
                          <DimensionScores scores={assessment.scores} />
                        </div>
                      )}

                      {/* Check results */}
                      {assessment.checks.length > 0 && (
                        <div>
                          <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-2">
                            Checks
                          </p>
                          <div className="space-y-3">
                            {assessment.checks.map((c: CheckResult, i: number) => (
                              <div key={i} className="rounded-md border border-border/50 p-3 space-y-2">
                                <div className="flex items-center gap-2">
                                  {c.passed ? (
                                    <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0" />
                                  ) : (
                                    <XCircle className="h-4 w-4 text-red-500 shrink-0" />
                                  )}
                                  <Badge variant="outline" className="text-[9px] font-mono">{c.type}</Badge>
                                  <span className="text-sm font-medium">{c.message}</span>
                                  {c.globalScore != null && (
                                    <span className="text-xs font-mono text-muted-foreground ml-auto shrink-0">
                                      {c.globalScore.toFixed(2)}/5
                                    </span>
                                  )}
                                </div>
                                {c.details && <p className="text-muted-foreground text-xs ml-6">{c.details}</p>}
                                {c.scores && c.scores.length > 0 && (
                                  <div className="ml-6">
                                    <DimensionScores scores={c.scores} />
                                  </div>
                                )}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Metric results */}
                      {assessment.metrics && assessment.metrics.length > 0 && (
                        <div>
                          <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-2">
                            Metrics
                          </p>
                          <div className="space-y-2">
                            {assessment.metrics.map((m, i) => (
                              <div key={i} className="flex items-center gap-2 text-sm">
                                {m.passed ? (
                                  <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0" />
                                ) : (
                                  <XCircle className="h-4 w-4 text-red-500 shrink-0" />
                                )}
                                <span className="font-medium">{m.name}</span>
                                <span className="text-muted-foreground">{m.value} / {m.threshold}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* LLM review */}
                      {assessment.llmReview && (
                        <div>
                          <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-2">
                            LLM Review
                          </p>
                          <div className="rounded-md bg-muted/30 px-4 py-3 text-sm">
                            <MessageResponse>{assessment.llmReview}</MessageResponse>
                          </div>
                        </div>
                      )}
                    </CardContent>
                  </Card>

                  {/* Assessment history */}
                  {task.result?.assessmentHistory && task.result.assessmentHistory.length > 0 && (
                    <Card>
                      <CardContent className="pt-4">
                        <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-3 flex items-center gap-1">
                          <Clock className="h-3 w-3" /> Previous Assessments ({task.result.assessmentHistory.length})
                        </p>
                        <div className="rounded-lg border border-border/50 divide-y divide-border/30">
                          {task.result.assessmentHistory.map((a, i) => (
                            <AssessmentHistoryRow key={i} assessment={a} index={i} />
                          ))}
                        </div>
                      </CardContent>
                    </Card>
                  )}
                </>
              ) : (
                <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
                  <Star className="h-10 w-10 mb-3 opacity-40" />
                  <p className="text-sm">No assessment yet</p>
                  <p className="text-xs mt-1">Assessment runs when the task completes</p>
                </div>
              )}
            </div>
          </ScrollArea>
        </TabsContent>

        {/* Activity tab */}
        <TabsContent value="activity" className="mt-4 flex-1 min-h-0">
          <ActivityPanel taskId={task.id} isActive={task.status === "in_progress" || task.status === "assigned"} />
        </TabsContent>

        {/* Output tab */}
        <TabsContent value="output" className="mt-4 flex-1 min-h-0">
          <ScrollArea className="h-full">
            <div className="space-y-4 pr-4 max-w-3xl">
              {task.result ? (
                <>
                  {task.result.stdout && (
                    <Card>
                      <CardContent className="pt-4">
                        <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-2 flex items-center gap-1">
                          <Terminal className="h-3 w-3" /> stdout
                        </p>
                        <ScrollArea className="max-h-80">
                          <pre className="text-xs bg-muted/30 rounded px-4 py-3 whitespace-pre-wrap font-mono text-muted-foreground">
                            {task.result.stdout}
                          </pre>
                        </ScrollArea>
                      </CardContent>
                    </Card>
                  )}
                  {task.result.stderr && (
                    <Card>
                      <CardContent className="pt-4">
                        <p className="text-[10px] font-medium text-red-400 uppercase tracking-wider mb-2 flex items-center gap-1">
                          <Terminal className="h-3 w-3" /> stderr
                        </p>
                        <ScrollArea className="max-h-80">
                          <pre className="text-xs bg-red-500/5 rounded px-4 py-3 whitespace-pre-wrap font-mono text-red-400/80">
                            {task.result.stderr}
                          </pre>
                        </ScrollArea>
                      </CardContent>
                    </Card>
                  )}
                  {!task.result.stdout && !task.result.stderr && (
                    <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
                      <Terminal className="h-10 w-10 mb-3 opacity-40" />
                      <p className="text-sm">No output captured</p>
                    </div>
                  )}
                </>
              ) : (
                <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
                  <Terminal className="h-10 w-10 mb-3 opacity-40" />
                  <p className="text-sm">Task hasn't run yet</p>
                </div>
              )}
            </div>
          </ScrollArea>
        </TabsContent>
      </Tabs>
    </div>
  );
}
