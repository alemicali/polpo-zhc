import { useMemo, useState, useCallback, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import Markdown from "react-markdown";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Card, CardContent } from "@/components/ui/card";

import {
  ArrowLeft,
  Scale,
  Play,
  RotateCcw,
  XCircle,
  X,
  Loader2,
  AlertTriangle,
  CheckCircle2,
  Clock,
  ListChecks,
  GitBranch,
  Quote,
  FileJson,
  Wrench,
  Star,
  Eye,
  Copy,
  Check,
  BarChart3,
  FileEdit,
  FilePlus,
  Timer,
  Workflow,
  ChevronDown,
  ChevronRight,
  PauseCircle,
  PlayCircle,
  ShieldCheck,
} from "lucide-react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  Panel,
  Handle,
  Position,
  MarkerType,
  useNodesState,
  useEdgesState,
  useReactFlow,
  type Node,
  type Edge,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useMission, useTasks, useSchedules, useActiveDelays, useDecisionNodes } from "@polpo-ai/react";
import type { MissionReport, TaskStatus, Task, ActiveDelay, Mission, ScheduleEntry } from "@polpo-ai/react";
import { toast } from "sonner";
import { formatDistanceToNow, format } from "date-fns";
import { cn } from "@/lib/utils";
import { cronToHuman } from "@/lib/cron";
import { missionStatusStyles, taskStatusStyles, taskPhaseStyles } from "@/lib/status-tokens";
import { JsonBlock } from "@/components/json-block";
import { Calendar, Repeat, Bell, FlaskRound } from "lucide-react";
import { TargetSuitesPanel } from "@/components/suites/target-suites-panel";
import { useConfig } from "@/hooks/use-polpo";
import { AppliedRulesPanel } from "@/components/shared/applied-rules-panel";
import type { AnyRule, ScopedRules } from "@/lib/applied-rules";
import { useLocalState } from "./coding/use-local-state";
import {
  parseMissionData,
  type MissionCheckpointDef,
  type MissionDecisionDef,
  type MissionDelayDef,
  type MissionTaskDef,
} from "@/lib/mission-data";
import { withMeasured } from "@/lib/graph-nodes";
import { TaskCostBadge, TaskEngineBadge } from "@/components/shared/run-context";
import { taskCostSummaryOf } from "@/lib/task-cost";
import { MissionBudgetBanner, MissionCostButton } from "@/components/missions/mission-cost";
import { useMissionCost } from "@/hooks/use-mission-cost";
import { AgentAvatar } from "@/components/shared/agent-avatar";

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
      className="inline-flex items-center gap-1 text-micro font-mono text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
      title={`Copy ${label ?? "ID"}: ${id}`}
    >
      {copied ? <Check className="h-2.5 w-2.5 text-success" /> : <Copy className="h-2.5 w-2.5" />}
      {id.slice(0, 12)}...
    </button>
  );
}

// ── Copy button ──

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
      onClick={() => {
        navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? <Check className="h-3 w-3 mr-1 text-success" /> : <Copy className="h-3 w-3 mr-1" />}
      {copied ? "Copied" : "Copy"}
    </Button>
  );
}

function filesLinkForPath(filePath: string): string | null {
  const normalized = filePath
    .replace(/\\/g, "/")
    .trim();
  if (!normalized) return null;
  const parts = normalized.split("/");
  const dir = parts.length > 1 ? (parts.slice(0, -1).join("/") || "/") : ".";
  const params = new URLSearchParams({ path: dir, highlight: normalized });
  return `/files?${params.toString()}`;
}




type TaskNodeStatusStyle = { icon: React.ElementType; color: string; label: string; nodeColor: string };

function nodeStatus(status: TaskStatus, strong = false, icon?: React.ElementType): TaskNodeStatusStyle {
  const v = taskStatusStyles[status];
  // Settled / active states get a stronger node border than idle ones.
  return { icon: icon ?? v.icon, color: v.color, label: v.short, nodeColor: strong ? v.border.replace("/40", "/60") : v.border };
}

const taskStatusConfig: Record<TaskStatus, TaskNodeStatusStyle> = {
  draft: nodeStatus("draft", false, Clock),
  pending: nodeStatus("pending"),
  awaiting_approval: nodeStatus("awaiting_approval"),
  assigned: nodeStatus("assigned"),
  in_progress: nodeStatus("in_progress", true),
  review: nodeStatus("review", true),
  done: nodeStatus("done", true),
  failed: nodeStatus("failed", true),
};

const phaseIcons: Record<string, { icon: React.ElementType; color: string; label: string }> = {
  fix: { icon: taskPhaseStyles.fix.icon, color: taskPhaseStyles.fix.color, label: taskPhaseStyles.fix.short },
  clarification: { icon: taskPhaseStyles.clarification.icon, color: taskPhaseStyles.clarification.color, label: taskPhaseStyles.clarification.short },
  review: { icon: taskPhaseStyles.review.icon, color: taskPhaseStyles.review.color, label: taskPhaseStyles.review.short },
};

// Graph edge strokes (React Flow inline styles) — from the status tokens.
const EDGE = {
  failed: taskStatusStyles.failed.css,
  done: taskStatusStyles.done.css,
  checkpoint: "var(--warning)",
  delay: "var(--info)",
  idle: "color-mix(in oklch, var(--muted-foreground) 30%, transparent)",
};

// ── Graph node data ──

interface TaskNodeData {
  taskDef: MissionTaskDef;
  liveTask?: Task;
  index: number;
  expanded?: boolean;
  [key: string]: unknown;
}

interface CheckpointNodeData {
  checkpoint: MissionCheckpointDef;
  /** Whether this checkpoint is currently active (blocking) — from live API data */
  isActive?: boolean;
  /** Whether this checkpoint has been resumed */
  isResumed?: boolean;
  [key: string]: unknown;
}

interface DelayNodeData {
  delay: MissionDelayDef;
  /** Whether this delay timer is currently active (started but not expired) */
  isActive?: boolean;
  /** Whether this delay has expired */
  isExpired?: boolean;
  /** ISO timestamp when the delay timer started */
  startedAt?: string;
  /** ISO timestamp when the delay will expire */
  expiresAt?: string;
  [key: string]: unknown;
}

// ── Task node component for ReactFlow ──

function TaskNodeComponent({ data, selected }: NodeProps<Node<TaskNodeData>>) {
  const navigate = useNavigate();
  const { taskDef, liveTask, index, expanded } = data;
  const statusCfg = liveTask ? taskStatusConfig[liveTask.status] : null;
  const StatusIcon = statusCfg?.icon ?? Clock;
  const phase = liveTask?.phase && liveTask.phase !== "execution" ? phaseIcons[liveTask.phase] : null;
  const score = liveTask?.result?.assessment?.globalScore;
  const passedChecks = liveTask?.result?.assessment?.checks?.filter(c => c.passed).length ?? 0;
  const totalChecks = taskDef.expectations?.length ?? 0;

  const bgColor = liveTask
    ? liveTask.status === "done"
      ? "bg-success/5"
      : liveTask.status === "failed"
        ? "bg-destructive/5"
        : liveTask.status === "in_progress"
          ? "bg-info/5"
          : liveTask.status === "review"
            ? "bg-warning/5"
            : "bg-card/90"
    : "bg-card/90";

  const borderColor = statusCfg?.nodeColor ?? "border-border";

  return (
    <>
      <Handle type="target" position={Position.Top} className="!bg-muted-foreground/50 !border-none !w-2 !h-2" />
      <div
        className={cn(
          "rounded-xl border-2 px-4 py-3 shadow-card backdrop-blur-surface transition-all cursor-pointer overflow-hidden",
          expanded ? "min-w-[320px] max-w-[420px]" : "min-w-[200px] max-w-[280px]",
          selected
            ? "border-primary ring-2 ring-primary/30 shadow-glow"
            : borderColor,
          bgColor,
        )}
      >
        {/* Header row */}
        <div className="flex items-center gap-2 mb-1.5">
          <span className="text-micro font-mono text-muted-foreground shrink-0">#{index + 1}</span>
          <StatusIcon
            className={cn(
              "h-3.5 w-3.5 shrink-0",
              statusCfg?.color ?? "text-muted-foreground",
              liveTask?.status === "in_progress" && "animate-spin",
            )}
          />
          {statusCfg && (
            <Badge variant="outline" className={cn("text-micro px-1 py-0", statusCfg.color)}>
              {statusCfg.label}
            </Badge>
          )}
          {phase && (
            <Badge variant="outline" className={cn("text-micro px-1 py-0 gap-0.5", phase.color)}>
              <phase.icon className="h-2 w-2" />
              {phase.label}
            </Badge>
          )}
          {score != null && (
            <Badge
              variant={score >= 3.5 ? "default" : "destructive"}
              className="text-micro px-1 py-0 ml-auto"
            >
              <Star className="h-2 w-2 mr-0.5" />
              {score.toFixed(1)}/5
            </Badge>
          )}
          {expanded && liveTask && (
            <button
              type="button"
              className="ml-auto inline-flex h-6 items-center gap-0.5 px-1.5 text-micro font-medium text-primary hover:bg-primary/10"
              onClick={(event) => { event.stopPropagation(); navigate(`/tasks/${liveTask.id}`); }}
              title="View task detail"
            >
              Open
              <ChevronRight className="h-3 w-3" />
            </button>
          )}
        </div>

        {/* Title */}
        <p className={cn("text-xs font-semibold leading-tight mb-1.5", !expanded && "line-clamp-2")}>{taskDef.title}</p>

        {/* Description — collapsed: 2-line clamp, expanded: full markdown */}
        {taskDef.description && (
          expanded ? (
            <div className="prose prose-xs prose-invert max-w-none [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 text-micro text-muted-foreground leading-snug mb-2 overflow-hidden break-words [&_pre]:overflow-x-auto [&_pre]:max-w-full [&_pre]:text-micro [&_code]:break-all [&_code]:text-micro [&_ul]:pl-3 [&_ol]:pl-3 [&_p]:my-1">
              <Markdown>{taskDef.description}</Markdown>
            </div>
          ) : (
            <p className="text-micro text-muted-foreground leading-snug mb-2 line-clamp-2">{taskDef.description}</p>
          )
        )}

        {/* Compact footer (always visible) */}
        <div className="flex items-center gap-1.5 flex-wrap">
          {taskDef.assignTo && (
            <Badge variant="outline" className="text-micro px-1 py-0 gap-0.5">
              <AgentAvatar name={taskDef.assignTo} size="xs" />
              {taskDef.assignTo}
            </Badge>
          )}
          {liveTask && <TaskEngineBadge task={liveTask} size={12} />}
          {liveTask && <TaskCostBadge cost={taskCostSummaryOf(liveTask)} />}
          {taskDef.dependsOn && taskDef.dependsOn.length > 0 && (
            <Badge variant="secondary" className="text-micro px-1 py-0 gap-0.5">
              <GitBranch className="h-2 w-2" />
              {taskDef.dependsOn.length}
            </Badge>
          )}
          {totalChecks > 0 && !expanded && (
            <Badge variant="secondary" className="text-micro px-1 py-0 gap-0.5">
              <Wrench className="h-2 w-2" />
              {totalChecks}
            </Badge>
          )}
          {liveTask?.result?.duration != null && (
            <span className="text-micro text-muted-foreground ml-auto">
              {Math.round(liveTask.result.duration / 1000)}s
            </span>
          )}
        </div>

        {/* ── Expanded details ── */}
        {expanded && (
          <div className="mt-3 pt-3 border-t border-border/40 space-y-3">
            {/* Dependencies */}
            {taskDef.dependsOn && taskDef.dependsOn.length > 0 && (
              <div>
                <p className="text-label text-muted-foreground mb-1.5">Dependencies</p>
                <div className="flex flex-wrap gap-1">
                  {taskDef.dependsOn.map((d, i) => (
                    <Badge key={i} variant="secondary" className="text-micro font-mono">{d}</Badge>
                  ))}
                </div>
              </div>
            )}

            {/* Expectations checklist */}
            {taskDef.expectations && taskDef.expectations.length > 0 && (
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <p className="text-label text-muted-foreground">Expectations</p>
                  {liveTask && totalChecks > 0 && (
                    <span className={cn(
                      "text-micro font-medium",
                      passedChecks === totalChecks ? "text-success" : "text-muted-foreground",
                    )}>
                      {passedChecks}/{totalChecks}
                    </span>
                  )}
                </div>
                <div className="space-y-1">
                  {taskDef.expectations.map((exp, i) => {
                    const check = liveTask?.result?.assessment?.checks?.[i];
                    const passed = check?.passed;
                    return (
                      <div
                        key={i}
                        className={cn(
                          "flex items-start gap-1.5 text-micro rounded-xs px-1.5 py-1",
                          passed === true && "bg-success/8",
                          passed === false && "bg-destructive/8",
                        )}
                      >
                        {check != null ? (
                          passed ? (
                            <CheckCircle2 className="h-3 w-3 text-success shrink-0 mt-px" />
                          ) : (
                            <XCircle className="h-3 w-3 text-destructive shrink-0 mt-px" />
                          )
                        ) : (
                          <div className="h-3 w-3 rounded-pill border border-border/60 shrink-0 mt-px" />
                        )}
                        <div className="min-w-0">
                          <div className="flex items-center gap-1">
                            <Badge variant="outline" className="text-micro px-1 py-0 shrink-0">{exp.type}</Badge>
                            {exp.threshold != null && (
                              <span className="text-micro text-muted-foreground">thr: {exp.threshold}</span>
                            )}
                          </div>
                          {exp.type === "file_exists" && exp.paths && exp.paths.length > 0 ? (
                            <div className="flex flex-wrap gap-1 mt-0.5">
                              {exp.paths.map((path, j) => {
                                const fileTarget = filesLinkForPath(path);
                                return (
                                  <button
                                    key={j}
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      if (fileTarget) navigate(fileTarget);
                                    }}
                                    className="rounded-xs bg-muted/40 px-1.5 py-0.5 font-mono text-micro text-primary/90 hover:bg-muted/70 hover:text-primary transition-colors"
                                    title="Open in file editor"
                                  >
                                    {path}
                                  </button>
                                );
                              })}
                            </div>
                          ) : (
                            <p className="text-muted-foreground leading-snug mt-0.5">
                              {exp.criteria ?? exp.command ?? exp.paths?.join(", ") ?? "LLM review"}
                            </p>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Metrics */}
            {taskDef.metrics && taskDef.metrics.length > 0 && (
              <div>
                <p className="text-label text-muted-foreground mb-1.5">Metrics</p>
                <div className="space-y-1">
                  {taskDef.metrics.map((m, i) => (
                    <div key={i} className="flex items-center gap-2 text-micro">
                      <span className="font-medium">{m.name}</span>
                      <code className="text-micro font-mono text-muted-foreground bg-muted/40 px-1 rounded-xs">{m.command}</code>
                      <span className="text-muted-foreground ml-auto shrink-0">thr: {m.threshold}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Retry config */}
            {(taskDef.maxRetries != null || taskDef.maxDuration != null) && (
              <div className="flex items-center gap-3 text-micro text-muted-foreground">
                {taskDef.maxRetries != null && <span>Max retries: {taskDef.maxRetries}</span>}
                {taskDef.maxDuration != null && <span>Timeout: {Math.round(taskDef.maxDuration / 1000)}s</span>}
              </div>
            )}

          </div>
        )}
      </div>
      <Handle type="source" position={Position.Bottom} className="!bg-muted-foreground/50 !border-none !w-2 !h-2" />
    </>
  );
}

// ── Checkpoint node component for ReactFlow ──

const CHECKPOINT_WIDTH = 200;
const CHECKPOINT_HEIGHT = 72;

function CheckpointNodeComponent({ data, selected }: NodeProps<Node<CheckpointNodeData>>) {
  const { checkpoint, isActive, isResumed } = data;

  const borderColor = isResumed
    ? "border-success/60"
    : isActive
      ? "border-warning/80"
      : "border-warning/40";

  const bgColor = isResumed
    ? "bg-success/5"
    : isActive
      ? "bg-warning/8"
      : "bg-card/60";

  const StatusIcon = isResumed ? PlayCircle : PauseCircle;
  const statusLabel = isResumed ? "Resumed" : isActive ? "Waiting" : "Checkpoint";
  const statusColor = isResumed ? "text-success" : isActive ? "text-warning" : "text-warning/70";

  return (
    <>
      <Handle type="target" position={Position.Top} className="!bg-warning/50 !border-none !w-2 !h-2" />
      <div
        className={cn(
          "rounded-lg border-2 border-dashed backdrop-blur-surface transition-all duration-200",
          borderColor,
          bgColor,
          selected && "ring-2 ring-warning/30 shadow-glow glow-warning",
        )}
        style={{ minWidth: CHECKPOINT_WIDTH, maxWidth: CHECKPOINT_WIDTH }}
      >
        <div className="px-3 py-2.5 flex flex-col gap-1">
          {/* Header */}
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-3.5 w-3.5 text-warning/70 shrink-0" />
            <span className="text-caption font-semibold text-foreground/90 truncate">{checkpoint.name}</span>
            <span className={cn("ml-auto text-micro font-medium uppercase tracking-wider", statusColor)}>
              {statusLabel}
            </span>
          </div>
          {/* Message */}
          {checkpoint.message && (
            <p className="text-micro text-muted-foreground leading-tight line-clamp-2 mt-0.5">
              {checkpoint.message}
            </p>
          )}
          {/* Flow info */}
          <div className="flex items-center gap-1.5 mt-0.5">
            <StatusIcon className={cn("h-3 w-3", statusColor)} />
            <span className="text-micro text-muted-foreground">
              {checkpoint.afterTasks.length} trigger{checkpoint.afterTasks.length !== 1 ? "s" : ""}
              {" → "}
              {checkpoint.blocksTasks.length} blocked
            </span>
          </div>
        </div>
      </div>
      <Handle type="source" position={Position.Bottom} className="!bg-warning/50 !border-none !w-2 !h-2" />
    </>
  );
}

// ── Decision node component for ReactFlow ──

const DECISION_WIDTH = 220;
const DECISION_HEIGHT = 84;

/** A decision node's live state in the mission run (from GET /decisions/nodes). */
export interface DecisionNodeView { status: "deciding" | "decided" | "awaiting"; branch?: string | null; suggested?: string | null }

interface DecisionNodeData {
  decision: MissionDecisionDef;
  live?: DecisionNodeView;
  [key: string]: unknown;
}

const QUESTION_KIND: Record<string, string> = { predicate: "Yes / no", choice: "Choice", score: "Score", rank: "Rank" };

function DecisionNodeComponent({ data, selected }: NodeProps<Node<DecisionNodeData>>) {
  const { decision, live } = data;
  const status = live?.status === "decided" ? `Branch: ${live.branch ?? "none"}` : live?.status === "awaiting" ? "Waiting for you" : live?.status === "deciding" ? "Deciding" : "Decision";
  const tone = live?.status === "decided" ? "text-success" : live?.status === "awaiting" ? "text-warning" : "text-info";
  return (
    <>
      <Handle type="target" position={Position.Top} className="!bg-info/50 !border-none !w-2 !h-2" />
      <div
        data-testid="decision-node"
        className={cn(
          "rounded-lg border-2 backdrop-blur-surface transition-all duration-200 bg-card/60",
          live?.status === "awaiting" ? "border-warning/70" : live?.status === "decided" ? "border-success/50" : "border-info/50",
          selected && "ring-2 ring-info/30",
        )}
        style={{ minWidth: DECISION_WIDTH, maxWidth: DECISION_WIDTH }}
      >
        <div className="px-3 py-2.5 flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <Scale className="h-3.5 w-3.5 text-info shrink-0" />
            <span className="text-caption font-semibold text-foreground/90 truncate">{decision.name}</span>
            <span className={cn("ml-auto text-micro font-medium uppercase tracking-wider", tone)}>{QUESTION_KIND[decision.question.type] ?? decision.question.type}</span>
          </div>
          <p className="text-micro text-muted-foreground leading-tight line-clamp-2">{decision.question.instructions}</p>
          <span className={cn("text-micro font-medium", tone)}>{status}</span>
        </div>
      </div>
      <Handle type="source" position={Position.Bottom} className="!bg-info/50 !border-none !w-2 !h-2" />
    </>
  );
}

// ── Delay node component for ReactFlow ──

const DELAY_SIZE = 140;
const DELAY_WIDTH = DELAY_SIZE;
const DELAY_HEIGHT = DELAY_SIZE;

/** Parse an ISO 8601 duration string (e.g. "PT2H30M", "P1D", "PT45S") into a human-readable label. */
function formatIsoDuration(iso: string): string {
  const match = iso.match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!match) return iso;
  const days = parseInt(match[1] || "0", 10);
  const hours = parseInt(match[2] || "0", 10);
  const minutes = parseInt(match[3] || "0", 10);
  const seconds = parseInt(match[4] || "0", 10);
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0 && days === 0 && hours === 0) parts.push(`${seconds}s`);
  return parts.join(" ") || "0s";
}

/** Format a remaining-milliseconds value as a human-friendly countdown string. */
function formatCountdown(ms: number): string {
  if (ms <= 0) return "now";
  const totalSec = Math.ceil(ms / 1000);
  const d = Math.floor(totalSec / 86400);
  const h = Math.floor((totalSec % 86400) / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function DelayNodeComponent({ data, selected }: NodeProps<Node<DelayNodeData>>) {
  const { delay, isActive, isExpired, startedAt, expiresAt } = data;

  // Live countdown: re-render every second while active
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!isActive || !expiresAt) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [isActive, expiresAt]);

  const remaining = expiresAt ? new Date(expiresAt).getTime() - now : 0;
  const startedAgo = startedAt ? formatDistanceToNow(new Date(startedAt), { addSuffix: true }) : null;

  const borderColor = isExpired
    ? "border-success/60"
    : isActive
      ? "border-info/80"
      : "border-info/40";

  const bgColor = isExpired
    ? "bg-success/5"
    : isActive
      ? "bg-info/8"
      : "bg-card/60";

  const statusLabel = isExpired ? "Expired" : isActive ? "Waiting" : "Delay";
  const statusColor = isExpired ? "text-success" : isActive ? "text-info" : "text-info/70";

  return (
    <>
      <Handle type="target" position={Position.Top} className="!bg-info/50 !border-none !w-2 !h-2" />
      <div
        className={cn(
          "rounded-pill border-2 border-dashed backdrop-blur-surface transition-all duration-200",
          "flex items-center justify-center relative",
          borderColor,
          bgColor,
          isActive && "animate-pulse",
          selected && "ring-2 ring-info/30 shadow-glow glow-info",
        )}
        style={{ width: DELAY_SIZE, height: DELAY_SIZE }}
      >
        <div className="flex flex-col items-center gap-0.5 px-3 max-w-[120px]">
          <Timer className={cn("h-4 w-4 shrink-0", statusColor)} />
          <span className="text-micro font-semibold text-foreground/90 truncate max-w-full text-center">{delay.name}</span>
          <span className={cn("text-micro font-medium uppercase tracking-wider", statusColor)}>
            {statusLabel}
          </span>
          {isActive && remaining > 0 ? (
            <>
              <span className="text-micro font-mono font-bold text-info tabular-nums">
                {formatCountdown(remaining)}
              </span>
              {startedAgo && (
                <span className="text-micro text-muted-foreground/70">
                  {startedAgo}
                </span>
              )}
            </>
          ) : (
            <>
              <span className="text-micro font-mono font-semibold text-foreground/70">
                {formatIsoDuration(delay.duration)}
              </span>
              <span className="text-micro text-muted-foreground text-center leading-tight">
                {delay.afterTasks.length} trigger{delay.afterTasks.length !== 1 ? "s" : ""}
                {" \u2192 "}
                {delay.blocksTasks.length} blocked
              </span>
            </>
          )}
        </div>
      </div>
      <Handle type="source" position={Position.Bottom} className="!bg-info/50 !border-none !w-2 !h-2" />
    </>
  );
}

const nodeTypes = { taskNode: TaskNodeComponent, checkpointNode: CheckpointNodeComponent, delayNode: DelayNodeComponent, decisionNode: DecisionNodeComponent };

// ── Graph layout computation ──

const NODE_WIDTH = 240;
const NODE_HEIGHT = 140;
const H_GAP = 60;
const V_GAP = 80;

function buildGraphLayout(
  taskDefs: MissionTaskDef[],
  findLive: (title: string) => Task | undefined,
  checkpoints?: MissionCheckpointDef[],
  activeCheckpoints?: Set<string>,
  resumedCheckpoints?: Set<string>,
  delays?: MissionDelayDef[],
  activeDelayMap?: Map<string, ActiveDelay>,
  expiredDelays?: Set<string>,
  decisions?: MissionDecisionDef[],
  decisionStates?: Map<string, DecisionNodeView>,
): { nodes: Node[]; edges: Edge[] } {
  // Build dependency graph for layering (topological sort into levels)
  const titleIndex = new Map<string, number>();
  taskDefs.forEach((t, i) => titleIndex.set(t.title, i));

  // Compute layers via longest-path layering
  const layers: number[] = new Array(taskDefs.length).fill(0);
  const visited = new Set<number>();

  function computeLayer(idx: number): number {
    if (visited.has(idx)) return layers[idx];
    visited.add(idx);
    const deps = taskDefs[idx].dependsOn ?? [];
    let maxParent = -1;
    for (const dep of deps) {
      const di = titleIndex.get(dep);
      if (di != null) {
        maxParent = Math.max(maxParent, computeLayer(di));
      }
    }
    layers[idx] = maxParent + 1;
    return layers[idx];
  }

  for (let i = 0; i < taskDefs.length; i++) computeLayer(i);

  // ── Checkpoint layer computation ──
  // Each checkpoint sits between its afterTasks and blocksTasks.
  // Its "visual layer" = max(layer of afterTasks) + 1, and blocksTasks are pushed down if needed.
  const cpDefs = checkpoints ?? [];
  // Map: checkpoint index → visual layer
  const cpLayers: number[] = [];
  // Build a set of edges that checkpoints intercept (afterTask → blocksTask)
  // so we can reroute them through the checkpoint node
  const interceptedEdges = new Set<string>(); // "sourceTaskIdx-targetTaskIdx"

  for (let ci = 0; ci < cpDefs.length; ci++) {
    const cp = cpDefs[ci];
    // Find the max layer among afterTasks
    let maxAfterLayer = 0;
    for (const title of cp.afterTasks) {
      const idx = titleIndex.get(title);
      if (idx != null) maxAfterLayer = Math.max(maxAfterLayer, layers[idx]);
    }
    const cpLayer = maxAfterLayer + 1;
    cpLayers.push(cpLayer);

    // Push blocksTasks down so they sit below the checkpoint
    for (const title of cp.blocksTasks) {
      const idx = titleIndex.get(title);
      if (idx != null && layers[idx] <= cpLayer) {
        const shift = cpLayer + 1 - layers[idx];
        shiftTaskAndDependents(idx, shift, taskDefs, titleIndex, layers);
      }
    }

    // Mark intercepted edges: any edge from afterTask → blocksTask
    for (const after of cp.afterTasks) {
      const ai = titleIndex.get(after);
      if (ai == null) continue;
      for (const blocked of cp.blocksTasks) {
        const bi = titleIndex.get(blocked);
        if (bi == null) continue;
        // Check if blocksTask actually depends on afterTask
        const deps = taskDefs[bi].dependsOn ?? [];
        if (deps.includes(after)) {
          interceptedEdges.add(`${ai}-${bi}`);
        }
      }
    }
  }

  // ── Delay layer computation (same pattern as checkpoints) ──
  const dlDefs = delays ?? [];
  const dlLayers: number[] = [];

  for (let di = 0; di < dlDefs.length; di++) {
    const dl = dlDefs[di];
    let maxAfterLayer = 0;
    for (const title of dl.afterTasks) {
      const idx = titleIndex.get(title);
      if (idx != null) maxAfterLayer = Math.max(maxAfterLayer, layers[idx]);
    }
    const dlLayer = maxAfterLayer + 1;
    dlLayers.push(dlLayer);

    // Push blocksTasks down so they sit below the delay
    for (const title of dl.blocksTasks) {
      const idx = titleIndex.get(title);
      if (idx != null && layers[idx] <= dlLayer) {
        const shift = dlLayer + 1 - layers[idx];
        shiftTaskAndDependents(idx, shift, taskDefs, titleIndex, layers);
      }
    }

    // Mark intercepted edges
    for (const after of dl.afterTasks) {
      const ai = titleIndex.get(after);
      if (ai == null) continue;
      for (const blocked of dl.blocksTasks) {
        const bi = titleIndex.get(blocked);
        if (bi == null) continue;
        const deps = taskDefs[bi].dependsOn ?? [];
        if (deps.includes(after)) {
          interceptedEdges.add(`${ai}-${bi}`);
        }
      }
    }
  }

  // ── Decision layer computation (same pattern: between the after tasks and the branch tasks) ──
  const dcDefs = decisions ?? [];
  const dcLayers: number[] = [];
  const branchOf = (d: MissionDecisionDef, title: string) => Object.entries(d.branches).filter(([, list]) => list.includes(title)).map(([k]) => k);
  for (const d of dcDefs) {
    let maxAfterLayer = 0;
    for (const title of d.afterTasks) {
      const idx = titleIndex.get(title);
      if (idx != null) maxAfterLayer = Math.max(maxAfterLayer, layers[idx]);
    }
    const dcLayer = maxAfterLayer + 1;
    dcLayers.push(dcLayer);
    for (const title of Object.values(d.branches).flat()) {
      const idx = titleIndex.get(title);
      if (idx != null && layers[idx] <= dcLayer) shiftTaskAndDependents(idx, dcLayer + 1 - layers[idx], taskDefs, titleIndex, layers);
      if (idx == null) continue;
      for (const after of d.afterTasks) {
        const ai = titleIndex.get(after);
        if (ai != null && (taskDefs[idx].dependsOn ?? []).includes(after)) interceptedEdges.add(`${ai}-${idx}`);
      }
    }
  }

  // Recompute max layer after checkpoint, delay and decision pushes
  const maxLayer = Math.max(...layers, ...cpLayers, ...dlLayers, ...dcLayers, 0);

  // Group task nodes by layer
  const layerGroups: number[][] = Array.from({ length: maxLayer + 1 }, () => []);
  layers.forEach((l, i) => layerGroups[l].push(i));

  // ── Position task nodes ──
  const nodes: Node[] = [];
  for (let layer = 0; layer <= maxLayer; layer++) {
    const group = layerGroups[layer];
    if (group.length === 0) continue;
    const totalWidth = group.length * NODE_WIDTH + (group.length - 1) * H_GAP;
    const startX = -totalWidth / 2;

    group.forEach((idx, pos) => {
      nodes.push({
        id: `task-${idx}`,
        type: "taskNode",
        position: {
          x: startX + pos * (NODE_WIDTH + H_GAP),
          y: layer * (NODE_HEIGHT + V_GAP),
        },
        data: {
          taskDef: taskDefs[idx],
          liveTask: findLive(taskDefs[idx].title),
          index: idx,
        } as TaskNodeData,
      });
    });
  }

  // ── Position checkpoint nodes ──
  for (let ci = 0; ci < cpDefs.length; ci++) {
    const cp = cpDefs[ci];
    const cpLayer = cpLayers[ci];
    // Center the checkpoint horizontally — if multiple checkpoints share a layer, offset them
    const cpsInSameLayer = cpLayers.filter(l => l === cpLayer).length;
    const cpPosInLayer = cpLayers.slice(0, ci).filter(l => l === cpLayer).length;
    const totalCpWidth = cpsInSameLayer * CHECKPOINT_WIDTH + (cpsInSameLayer - 1) * H_GAP;
    const cpStartX = -totalCpWidth / 2;

    nodes.push({
      id: `checkpoint-${ci}`,
      type: "checkpointNode",
      position: {
        x: cpStartX + cpPosInLayer * (CHECKPOINT_WIDTH + H_GAP),
        y: cpLayer * (NODE_HEIGHT + V_GAP) + (NODE_HEIGHT - CHECKPOINT_HEIGHT) / 2,
      },
      data: {
        checkpoint: cp,
        isActive: activeCheckpoints?.has(cp.name) ?? false,
        isResumed: resumedCheckpoints?.has(cp.name) ?? false,
      } as CheckpointNodeData,
    });
  }

  // ── Position delay nodes ──
  for (let di = 0; di < dlDefs.length; di++) {
    const dl = dlDefs[di];
    const dlLayer = dlLayers[di];
    const dlsInSameLayer = dlLayers.filter(l => l === dlLayer).length;
    const dlPosInLayer = dlLayers.slice(0, di).filter(l => l === dlLayer).length;
    const totalDlWidth = dlsInSameLayer * DELAY_WIDTH + (dlsInSameLayer - 1) * H_GAP;
    const dlStartX = -totalDlWidth / 2;

    nodes.push({
      id: `delay-${di}`,
      type: "delayNode",
      position: {
        x: dlStartX + dlPosInLayer * (DELAY_WIDTH + H_GAP),
        y: dlLayer * (NODE_HEIGHT + V_GAP) + (NODE_HEIGHT - DELAY_HEIGHT) / 2,
      },
      data: {
        delay: dl,
        isActive: activeDelayMap?.has(dl.name) ?? false,
        isExpired: expiredDelays?.has(dl.name) ?? false,
        startedAt: activeDelayMap?.get(dl.name)?.startedAt,
        expiresAt: activeDelayMap?.get(dl.name)?.expiresAt,
      } as DelayNodeData,
    });
  }

  // ── Build edges ──
  const edges: Edge[] = [];

  // Task → Task edges (skipping intercepted ones)
  taskDefs.forEach((t, idx) => {
    for (const dep of t.dependsOn ?? []) {
      const di = titleIndex.get(dep);
      if (di != null) {
        // Skip if this edge is intercepted by a checkpoint
        if (interceptedEdges.has(`${di}-${idx}`)) continue;

        const sourceLive = findLive(taskDefs[di].title);
        const isDone = sourceLive?.status === "done";
        const isFailed = sourceLive?.status === "failed";
        edges.push({
          id: `e-${di}-${idx}`,
          source: `task-${di}`,
          target: `task-${idx}`,
          markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
          style: {
            stroke: isFailed
              ? EDGE.failed
              : isDone
                ? EDGE.done
                : EDGE.idle,
            strokeWidth: isDone || isFailed ? 2 : 1.5,
          },
          animated: sourceLive?.status === "in_progress",
        });
      }
    }
  });

  // Checkpoint edges: afterTasks → checkpoint → blocksTasks
  for (let ci = 0; ci < cpDefs.length; ci++) {
    const cp = cpDefs[ci];
    const cpId = `checkpoint-${ci}`;
    const isActive = activeCheckpoints?.has(cp.name) ?? false;
    const isResumedCp = resumedCheckpoints?.has(cp.name) ?? false;

    // afterTasks → checkpoint
    for (const title of cp.afterTasks) {
      const ai = titleIndex.get(title);
      if (ai == null) continue;
      const sourceLive = findLive(title);
      const isDone = sourceLive?.status === "done";
      edges.push({
        id: `e-task${ai}-cp${ci}`,
        source: `task-${ai}`,
        target: cpId,
        markerEnd: { type: MarkerType.ArrowClosed, width: 12, height: 12 },
        style: {
          stroke: isDone
            ? EDGE.checkpoint
            : EDGE.idle,
          strokeWidth: isDone ? 2 : 1.5,
          strokeDasharray: "6 3",
        },
      });
    }

    // checkpoint → blocksTasks
    for (const title of cp.blocksTasks) {
      const bi = titleIndex.get(title);
      if (bi == null) continue;
      edges.push({
        id: `e-cp${ci}-task${bi}`,
        source: cpId,
        target: `task-${bi}`,
        markerEnd: { type: MarkerType.ArrowClosed, width: 12, height: 12 },
        style: {
          stroke: isResumedCp
            ? EDGE.done   // resumed
            : isActive
              ? EDGE.checkpoint // waiting
              : EDGE.idle,
          strokeWidth: isActive || isResumedCp ? 2 : 1.5,
          strokeDasharray: "6 3",
        },
        animated: isActive,
      });
    }
  }

  // Delay edges: afterTasks → delay → blocksTasks
  for (let di = 0; di < dlDefs.length; di++) {
    const dl = dlDefs[di];
    const dlId = `delay-${di}`;
    const isActiveDl = activeDelayMap?.has(dl.name) ?? false;
    const isExpiredDl = expiredDelays?.has(dl.name) ?? false;

    // afterTasks → delay
    for (const title of dl.afterTasks) {
      const ai = titleIndex.get(title);
      if (ai == null) continue;
      const sourceLive = findLive(title);
      const isDone = sourceLive?.status === "done";
      edges.push({
        id: `e-task${ai}-dl${di}`,
        source: `task-${ai}`,
        target: dlId,
        markerEnd: { type: MarkerType.ArrowClosed, width: 12, height: 12 },
        style: {
          stroke: isDone
            ? EDGE.delay
            : EDGE.idle,
          strokeWidth: isDone ? 2 : 1.5,
          strokeDasharray: "6 3",
        },
      });
    }

    // delay → blocksTasks
    for (const title of dl.blocksTasks) {
      const bi = titleIndex.get(title);
      if (bi == null) continue;
      edges.push({
        id: `e-dl${di}-task${bi}`,
        source: dlId,
        target: `task-${bi}`,
        markerEnd: { type: MarkerType.ArrowClosed, width: 12, height: 12 },
        style: {
          stroke: isExpiredDl
            ? EDGE.done   // expired
            : isActiveDl
              ? EDGE.delay // waiting
              : EDGE.idle,
          strokeWidth: isActiveDl || isExpiredDl ? 2 : 1.5,
          strokeDasharray: "6 3",
        },
        animated: isActiveDl,
      });
    }
  }

  // ── Decision nodes and edges: afterTasks → decision → each branch's tasks (labelled with the answer) ──
  for (let i = 0; i < dcDefs.length; i++) {
    const d = dcDefs[i];
    const id = `decision-${i}`;
    const live = decisionStates?.get(d.name);
    const sameLayer = dcLayers.filter((l) => l === dcLayers[i]).length;
    const posInLayer = dcLayers.slice(0, i).filter((l) => l === dcLayers[i]).length;
    const startX = -(sameLayer * DECISION_WIDTH + (sameLayer - 1) * H_GAP) / 2;
    nodes.push({
      id, type: "decisionNode",
      position: { x: startX + posInLayer * (DECISION_WIDTH + H_GAP), y: dcLayers[i] * (NODE_HEIGHT + V_GAP) + (NODE_HEIGHT - DECISION_HEIGHT) / 2 },
      data: { decision: d, ...(live ? { live } : {}) } as DecisionNodeData,
    });
    for (const title of d.afterTasks) {
      const ai = titleIndex.get(title);
      if (ai == null) continue;
      const isDone = findLive(title)?.status === "done";
      edges.push({
        id: `e-task${ai}-dc${i}`, source: `task-${ai}`, target: id,
        markerEnd: { type: MarkerType.ArrowClosed, width: 12, height: 12 },
        style: { stroke: isDone ? EDGE.delay : EDGE.idle, strokeWidth: isDone ? 2 : 1.5 },
      });
    }
    for (const title of [...new Set(Object.values(d.branches).flat())]) {
      const bi = titleIndex.get(title);
      if (bi == null) continue;
      const keys = branchOf(d, title);
      const taken = live?.status === "decided" && !!live.branch && keys.includes(live.branch);
      const skipped = live?.status === "decided" && !taken;
      edges.push({
        id: `e-dc${i}-task${bi}`, source: id, target: `task-${bi}`, label: keys.join(" / "),
        markerEnd: { type: MarkerType.ArrowClosed, width: 12, height: 12 },
        style: { stroke: taken ? EDGE.done : skipped ? EDGE.idle : EDGE.delay, strokeWidth: taken ? 2 : 1.5, ...(skipped ? { strokeDasharray: "4 4" } : {}) },
        animated: live?.status === "deciding",
      });
    }
  }

  return { nodes, edges };
}

/** Recursively shift a task and all tasks that depend on it to lower layers. */
function shiftTaskAndDependents(
  idx: number,
  shift: number,
  taskDefs: MissionTaskDef[],
  titleIndex: Map<string, number>,
  layers: number[],
): void {
  layers[idx] += shift;
  const taskTitle = taskDefs[idx].title;
  // Find all tasks that depend on this one and push them down too
  for (let i = 0; i < taskDefs.length; i++) {
    if (i === idx) continue;
    const deps = taskDefs[i].dependsOn ?? [];
    if (deps.includes(taskTitle) && layers[i] <= layers[idx]) {
      shiftTaskAndDependents(i, layers[idx] + 1 - layers[i], taskDefs, titleIndex, layers);
    }
  }
}

// ── Graph inner (needs ReactFlow context) ──

export function MissionGraphInner({
  taskDefs,
  findLiveTask,
  checkpoints,
  activeCheckpoints,
  resumedCheckpoints,
  delays,
  activeDelayMap,
  expiredDelays,
  decisions,
  decisionStates,
}: {
  taskDefs: MissionTaskDef[];
  findLiveTask: (title: string) => Task | undefined;
  checkpoints?: MissionCheckpointDef[];
  activeCheckpoints?: Set<string>;
  resumedCheckpoints?: Set<string>;
  delays?: MissionDelayDef[];
  activeDelayMap?: Map<string, ActiveDelay>;
  expiredDelays?: Set<string>;
  decisions?: MissionDecisionDef[];
  decisionStates?: Map<string, DecisionNodeView>;
}) {
  const { fitView } = useReactFlow();
  const { nodes: initial, edges: initialEdges } = useMemo(
    () => buildGraphLayout(taskDefs, findLiveTask, checkpoints, activeCheckpoints, resumedCheckpoints, delays, activeDelayMap, expiredDelays, decisions, decisionStates),
    [taskDefs, findLiveTask, checkpoints, activeCheckpoints, resumedCheckpoints, delays, activeDelayMap, expiredDelays, decisions, decisionStates],
  );

  const [nodes, setNodes, onNodesChange] = useNodesState(initial);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);
  const [previewNodeId, setPreviewNodeId] = useState<string | null>(null);
  const [previewMode, setPreviewMode] = useLocalState<"floating" | "inline">("polpo:missionGraphPreviewMode", "floating");

  // Sync when live task status changes
  useEffect(() => {
    const { nodes: n, edges: e } = buildGraphLayout(taskDefs, findLiveTask, checkpoints, activeCheckpoints, resumedCheckpoints, delays, activeDelayMap, expiredDelays, decisions, decisionStates);
    setNodes((previous: Node[]) => n.map((node: Node) => {
      const existing = previous.find((candidate) => candidate.id === node.id);
      // Keep the size React Flow measured: a rebuilt node without it is hidden until measured
      // again, which happens only if its size changes (e.g. at a checkpoint the whole graph vanished).
      const kept = withMeasured(node, existing);
      return existing?.data.expanded ? { ...kept, data: { ...kept.data, expanded: true } } : kept;
    }));
    setEdges(e);
  }, [taskDefs, findLiveTask, checkpoints, activeCheckpoints, resumedCheckpoints, delays, activeDelayMap, expiredDelays, decisions, decisionStates, setNodes, setEdges]);

  useEffect(() => {
    const t = setTimeout(() => fitView({ padding: 0.2 }), 50);
    return () => clearTimeout(t);
  }, [fitView, nodes.length]);

  const previewNode = previewMode === "floating" && previewNodeId
    ? nodes.find((node) => node.id === previewNodeId && node.type === "taskNode") as Node<TaskNodeData> | undefined
    : undefined;

  // Keep the graph geometry stable and show task details in a fixed panel.
  const handleNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      if (node.type !== "taskNode") return;
      if (previewMode === "floating") {
        setPreviewNodeId((current) => current === node.id ? null : node.id);
        setNodes((current: Node[]) => current.map((candidate) => candidate.data.expanded
          ? { ...candidate, data: { ...candidate.data, expanded: false } }
          : candidate));
        return;
      }
      setPreviewNodeId(null);
      setNodes((current: Node[]) => current.map((candidate) => candidate.id === node.id
        ? { ...candidate, data: { ...candidate.data, expanded: !candidate.data.expanded } }
        : candidate.data.expanded
          ? { ...candidate, data: { ...candidate.data, expanded: false } }
          : candidate));
    },
    [previewMode, setNodes],
  );

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onNodeClick={handleNodeClick}
      onPaneClick={() => {
        setPreviewNodeId(null);
        if (previewMode === "inline") {
          setNodes((current: Node[]) => current.map((node) => node.data.expanded
            ? { ...node, data: { ...node.data, expanded: false } }
            : node));
        }
      }}
      nodeTypes={nodeTypes}
      fitView
      fitViewOptions={{ padding: 0.2 }}
      minZoom={0.3}
      maxZoom={1.5}
      proOptions={{ hideAttribution: true }}
      nodesDraggable
      nodesConnectable={false}
      className="rounded-lg"
    >
      <Background gap={20} size={1} className="!bg-background" />
      <Controls showInteractive={false} className="!bg-card !border-border !shadow-raised [&>button]:!bg-card [&>button]:!border-border [&>button]:!text-foreground [&>button:hover]:!bg-accent" />
      <Panel position="top-left" className="m-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 gap-1.5 bg-background px-2 text-micro shadow-card"
          onClick={() => {
            setPreviewNodeId(null);
            setNodes((current: Node[]) => current.map((node) => node.data.expanded
              ? { ...node, data: { ...node.data, expanded: false } }
              : node));
            setPreviewMode((current) => current === "floating" ? "inline" : "floating");
          }}
          title="Switch task detail presentation"
        >
          <Eye className="h-3.5 w-3.5" />
          {previewMode === "floating" ? "Floating details" : "Inline details"}
        </Button>
      </Panel>
      {previewNode && (
        <Panel position="top-right" className="!bottom-3 !right-3 !top-3 !m-0">
          <GraphTaskPreview node={previewNode} onClose={() => setPreviewNodeId(null)} />
        </Panel>
      )}
    </ReactFlow>
  );
}

function GraphTaskPreview({ node, onClose }: { node: Node<TaskNodeData>; onClose: () => void }) {
  const navigate = useNavigate();
  const { taskDef, liveTask, index } = node.data;
  const status = liveTask ? taskStatusConfig[liveTask.status] : undefined;
  const StatusIcon = status?.icon ?? Clock;

  return (
    <aside className="nodrag nopan nowheel flex h-full w-[min(360px,calc(100vw-32px))] flex-col overflow-hidden border border-border bg-background shadow-raised">
      <div className="flex shrink-0 items-start gap-2 border-b border-border px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-micro text-muted-foreground">
            <span className="font-mono">#{index + 1}</span>
            <StatusIcon className={cn("h-3 w-3", status?.color, liveTask?.status === "in_progress" && "animate-spin")} />
            <span>{status?.label ?? "Task definition"}</span>
          </div>
          <h3 className="mt-1 text-sm font-semibold leading-snug">{taskDef.title}</h3>
        </div>
        <Button type="button" variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={onClose} aria-label="Close task preview">
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-3 p-3">
          {taskDef.description && (
            <div className="prose prose-sm max-w-none break-words text-xs leading-relaxed text-muted-foreground [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_pre]:overflow-x-auto [&_pre]:whitespace-pre-wrap">
              <Markdown>{taskDef.description}</Markdown>
            </div>
          )}
          <div className="flex flex-wrap gap-1.5">
            {taskDef.assignTo && <Badge variant="outline" className="gap-1 text-micro"><AgentAvatar name={taskDef.assignTo} size="xs" />{taskDef.assignTo}</Badge>}
            {(taskDef.dependsOn?.length ?? 0) > 0 && <Badge variant="secondary" className="gap-1 text-micro"><GitBranch className="h-2.5 w-2.5" />{taskDef.dependsOn!.length} dependencies</Badge>}
            {(taskDef.expectations?.length ?? 0) > 0 && <Badge variant="secondary" className="gap-1 text-micro"><Wrench className="h-2.5 w-2.5" />{taskDef.expectations!.length} checks</Badge>}
          </div>
          {(taskDef.expectations?.length ?? 0) > 0 && (
            <div className="space-y-1.5 border-t border-border pt-3">
              <p className="text-micro font-semibold uppercase text-muted-foreground">Expectations</p>
              {taskDef.expectations!.map((expectation, expectationIndex) => {
                const check = liveTask?.result?.assessment?.checks?.[expectationIndex];
                return (
                  <div key={expectationIndex} className="flex items-start gap-2 text-caption leading-relaxed text-muted-foreground">
                    {check?.passed === true
                      ? <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0 text-success" />
                      : check?.passed === false
                        ? <XCircle className="mt-0.5 h-3 w-3 shrink-0 text-destructive" />
                        : <span className="mt-1 h-2.5 w-2.5 shrink-0 rounded-pill border border-border" />}
                    <span>{expectation.criteria ?? expectation.command ?? expectation.paths?.join(", ") ?? expectation.type}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </ScrollArea>
      {liveTask && (
        <div className="relative z-10 shrink-0 border-t border-border bg-background p-2">
          <Button type="button" variant="outline" size="sm" className="h-8 w-full text-xs" onClick={() => navigate(`/tasks/${liveTask.id}`)}>
            View task detail
          </Button>
        </div>
      )}
    </aside>
  );
}

// ── Task step card (collapsible, markdown description) ──

export function TaskStepCard({
  taskDef,
  index,
  isLast,
  liveTask,
  navigate,
}: {
  taskDef: MissionTaskDef;
  index: number;
  isLast: boolean;
  liveTask?: Task;
  navigate: (path: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const statusCfg = liveTask ? taskStatusConfig[liveTask.status] : null;
  const isDone = liveTask?.status === "done";
  const isFailed = liveTask?.status === "failed";
  const isRunning = liveTask?.status === "in_progress";
  const isReview = liveTask?.status === "review";
  const phaseInfo = liveTask?.phase && liveTask.phase !== "execution" ? phaseIcons[liveTask.phase] : null;
  const score = liveTask?.result?.assessment?.globalScore;
  const passedChecks = liveTask?.result?.assessment?.checks?.filter(c => c.passed).length ?? 0;
  const totalChecks = taskDef.expectations?.length ?? 0;

  return (
    <div className="relative flex gap-4">
      {/* Timeline rail */}
      <div className="flex flex-col items-center shrink-0 w-8">
        <div
          className={cn(
            "relative z-10 flex h-8 w-8 items-center justify-center rounded-pill border-2 text-xs font-bold transition-all",
            isDone && "border-success bg-success/15 text-success",
            isFailed && "border-destructive bg-destructive/15 text-destructive",
            isRunning && "border-info bg-info/15 text-info",
            isReview && "border-warning bg-warning/15 text-warning",
            !liveTask && "border-border bg-muted/50 text-muted-foreground",
            liveTask && !isDone && !isFailed && !isRunning && !isReview && "border-border bg-muted-foreground/10 text-muted-foreground",
          )}
        >
          {isDone ? (
            <CheckCircle2 className="h-4 w-4" />
          ) : isFailed ? (
            <XCircle className="h-4 w-4" />
          ) : isRunning ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <span>{index + 1}</span>
          )}
          {isRunning && (
            <span className="absolute inset-0 rounded-pill border-2 border-info animate-ping opacity-20" />
          )}
        </div>
        {!isLast && (
          <div
            className={cn(
              "w-0.5 flex-1 min-h-6 transition-colors",
              isDone ? "bg-success/40" : "bg-border/60",
            )}
          />
        )}
      </div>

      {/* Card */}
      <div className={cn("flex-1 min-w-0", isLast ? "pb-0" : "pb-6")}>
        <div
          className={cn(
            "rounded-lg border transition-all",
            "hover:shadow-glow hover:border-primary/20",
            isDone && "border-success/20 bg-success/[0.03]",
            isFailed && "border-destructive/20 bg-destructive/[0.03]",
            isRunning && "border-info/25 bg-info/[0.03]",
            isReview && "border-warning/20 bg-warning/[0.03]",
            !liveTask && "border-border/60 bg-card/40",
            liveTask && !isDone && !isFailed && !isRunning && !isReview && "border-border/60 bg-card/60",
          )}
        >
          {/* Header — always visible, clickable to expand */}
          <button
            className="w-full text-left p-4 cursor-pointer"
            onClick={() => setExpanded((v) => !v)}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-semibold leading-snug">{taskDef.title}</span>
                  {statusCfg && (
                    <Badge variant="outline" className={cn("text-micro shrink-0", statusCfg.color)}>
                      {statusCfg.label}
                    </Badge>
                  )}
                  {phaseInfo && (
                    <Badge variant="outline" className={cn("text-micro gap-0.5 shrink-0", phaseInfo.color)}>
                      <phaseInfo.icon className="h-2.5 w-2.5" />
                      {phaseInfo.label}
                    </Badge>
                  )}
                </div>
                {/* Collapsed preview */}
                {!expanded && taskDef.description && (
                  <p className="text-xs text-muted-foreground mt-1 leading-relaxed line-clamp-2">{taskDef.description}</p>
                )}
              </div>

              <div className="flex items-center gap-2 shrink-0">
                {/* Score ring (0-5 scale) */}
                {score != null && (
                  <div className={cn(
                    "flex flex-col items-center justify-center h-10 w-10 rounded-pill border-2",
                    score >= 3.5 ? "border-success/50 text-success" : "border-destructive/50 text-destructive",
                  )}>
                    <span className="text-xs font-bold leading-none tabular-nums">{score.toFixed(1)}</span>
                    <span className="text-micro text-muted-foreground leading-none">/ 5</span>
                  </div>
                )}
                <ChevronDown className={cn("h-4 w-4 text-muted-foreground transition-transform", expanded && "rotate-180")} />
              </div>
            </div>

            {/* Metadata row — always visible */}
            <div className="flex items-center gap-3 mt-2 text-caption text-muted-foreground">
              {taskDef.assignTo && (
                <span className="flex items-center gap-1">
                  <AgentAvatar name={taskDef.assignTo} size="xs" />
                  {taskDef.assignTo}
                </span>
              )}
              {liveTask && <TaskEngineBadge task={liveTask} size={13} />}
              {liveTask && <TaskCostBadge cost={taskCostSummaryOf(liveTask)} />}
              {taskDef.dependsOn && taskDef.dependsOn.length > 0 && (
                <span className="flex items-center gap-1">
                  <GitBranch className="h-3 w-3" />
                  {taskDef.dependsOn.length} dep{taskDef.dependsOn.length > 1 ? "s" : ""}
                </span>
              )}
              {totalChecks > 0 && (
                <span className="flex items-center gap-1">
                  <Wrench className="h-3 w-3" />
                  {liveTask ? `${passedChecks}/${totalChecks}` : totalChecks} check{totalChecks > 1 ? "s" : ""}
                </span>
              )}
              {taskDef.maxRetries != null && (
                <span className="flex items-center gap-1">
                  <RotateCcw className="h-3 w-3" />
                  {taskDef.maxRetries}
                </span>
              )}
              {liveTask?.result?.duration != null && (
                <span className="flex items-center gap-1 ml-auto">
                  <Timer className="h-3 w-3" />
                  {Math.round(liveTask.result.duration / 1000)}s
                </span>
              )}
            </div>
          </button>

          {/* Expanded body */}
          {expanded && (
            <div className="px-4 pb-4 space-y-4">
              <div className="border-t border-border/40" />

              {/* Description as markdown */}
              {taskDef.description && (
                <div className="prose prose-sm prose-invert max-w-none [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 text-sm text-muted-foreground leading-relaxed">
                  <Markdown>{taskDef.description}</Markdown>
                </div>
              )}

              {/* Dependencies */}
              {taskDef.dependsOn && taskDef.dependsOn.length > 0 && (
                <div>
                  <p className="text-label text-muted-foreground mb-2">Dependencies</p>
                  <div className="flex flex-wrap gap-1.5">
                    {taskDef.dependsOn.map((d, i) => (
                      <Badge key={i} variant="secondary" className="text-micro font-mono">{d}</Badge>
                    ))}
                  </div>
                </div>
              )}

              {/* Expectations */}
              {taskDef.expectations && taskDef.expectations.length > 0 && (
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-label text-muted-foreground">Expectations</p>
                    {liveTask && totalChecks > 0 && (
                      <span className={cn(
                        "text-micro font-medium",
                        passedChecks === totalChecks ? "text-success" : "text-muted-foreground",
                      )}>
                        {passedChecks}/{totalChecks} passed
                      </span>
                    )}
                  </div>
                  <div className="space-y-1.5">
                    {taskDef.expectations.map((exp, i) => {
                      const check = liveTask?.result?.assessment?.checks?.[i];
                      const passed = check?.passed;
                      return (
                        <div
                          key={i}
                          className={cn(
                            "flex items-start gap-2 rounded-md px-2.5 py-1.5 text-xs",
                            passed === true && "bg-success/5",
                            passed === false && "bg-destructive/5",
                            passed == null && "bg-muted/30",
                          )}
                        >
                          {check != null ? (
                            passed ? (
                              <CheckCircle2 className="h-3.5 w-3.5 text-success shrink-0 mt-0.5" />
                            ) : (
                              <XCircle className="h-3.5 w-3.5 text-destructive shrink-0 mt-0.5" />
                            )
                          ) : (
                            <div className="h-3.5 w-3.5 rounded-pill border border-border/60 shrink-0 mt-0.5" />
                          )}
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5 mb-0.5">
                              <Badge variant="outline" className="text-micro px-1 py-0">{exp.type}</Badge>
                              {exp.confidence && <span className="text-micro text-muted-foreground">{exp.confidence}</span>}
                              {exp.threshold != null && (
                                <span className="text-micro text-muted-foreground ml-auto">threshold: {exp.threshold}</span>
                              )}
                            </div>
                            {exp.type === "file_exists" && exp.paths && exp.paths.length > 0 ? (
                              <div className="mt-0.5 flex flex-wrap gap-1">
                                {exp.paths.map((path, j) => {
                                  const fileTarget = filesLinkForPath(path);
                                  return (
                                    <button
                                      key={j}
                                      type="button"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        if (fileTarget) navigate(fileTarget);
                                      }}
                                      className="rounded-xs bg-muted/50 px-1.5 py-0.5 font-mono text-caption text-primary/90 hover:bg-muted/70 hover:text-primary transition-colors"
                                      title="Open in file editor"
                                    >
                                      {path}
                                    </button>
                                  );
                                })}
                              </div>
                            ) : (
                              <p className="text-muted-foreground leading-relaxed">
                                {exp.criteria ?? exp.command ?? exp.paths?.join(", ") ?? "LLM review"}
                              </p>
                            )}
                            {exp.dimensions && exp.dimensions.length > 0 && (
                              <div className="mt-1.5 space-y-0.5">
                                {exp.dimensions.map((d, k) => (
                                  <div key={k} className="flex items-center gap-2 text-micro text-muted-foreground">
                                    <span className="font-medium capitalize">{d.name}</span>
                                    <span className="opacity-60">(w:{d.weight})</span>
                                    <span className="opacity-60 truncate">{d.description}</span>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Metrics */}
              {taskDef.metrics && taskDef.metrics.length > 0 && (
                <div>
                  <p className="text-label text-muted-foreground mb-2">Metrics</p>
                  <div className="space-y-1">
                    {taskDef.metrics.map((m, i) => (
                      <div key={i} className="flex items-center gap-2 text-xs">
                        <span className="font-medium">{m.name}</span>
                        <code className="text-micro font-mono text-muted-foreground bg-muted/40 px-1.5 rounded-xs">{m.command}</code>
                        <span className="text-muted-foreground ml-auto">thr: {m.threshold}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Retry / duration config */}
              {(taskDef.maxRetries != null || taskDef.maxDuration != null || taskDef.retryPolicy) && (
                <div className="flex items-center gap-4 text-caption text-muted-foreground">
                  {taskDef.maxRetries != null && <span>Max retries: {taskDef.maxRetries}</span>}
                  {taskDef.maxDuration != null && <span>Timeout: {Math.round(taskDef.maxDuration / 1000)}s</span>}
                  {taskDef.retryPolicy?.escalateAfter != null && <span>Escalate after: {taskDef.retryPolicy.escalateAfter}</span>}
                  {taskDef.retryPolicy?.fallbackAgent && <span>Fallback: {taskDef.retryPolicy.fallbackAgent}</span>}
                </div>
              )}

              {/* Navigate to live task */}
              {liveTask && (
                <Button
                  variant="outline"
                  size="sm"
                  className="text-xs"
                  onClick={() => navigate(`/tasks/${liveTask.id}`)}
                >
                  View task detail
                </Button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Runs timeline (recurring missions) ──

interface RunBatch {
  runIndex: number;
  startedAt: string;
  tasks: Task[];
  allDone: boolean;
  allFailed: boolean;
  doneCount: number;
  failedCount: number;
}

function groupTasksIntoRuns(tasks: Task[], playbookTaskCount: number): RunBatch[] {
  if (tasks.length === 0 || playbookTaskCount === 0) return [];
  // Sort by creation time ascending
  const sorted = [...tasks].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  // Group into batches of playbookTaskCount (each execution creates exactly N tasks)
  const runs: RunBatch[] = [];
  for (let i = 0; i < sorted.length; i += playbookTaskCount) {
    const batch = sorted.slice(i, i + playbookTaskCount);
    const doneCount = batch.filter(t => t.status === "done").length;
    const failedCount = batch.filter(t => t.status === "failed").length;
    const allTerminal = batch.every(t => t.status === "done" || t.status === "failed");
    runs.push({
      runIndex: runs.length + 1,
      startedAt: batch[0].createdAt,
      tasks: batch,
      allDone: allTerminal && failedCount === 0,
      allFailed: allTerminal && doneCount === 0,
      doneCount,
      failedCount,
    });
  }
  // Most recent first
  return runs.reverse();
}

function RunsTimeline({
  tasks,
  parsed,
  navigate,
}: {
  tasks: Task[];
  parsed: ReturnType<typeof parseMissionData> | null;
  navigate: (path: string) => void;
}) {
  const playbookTaskCount = parsed?.tasks.length ?? 0;
  const runs = useMemo(() => groupTasksIntoRuns(tasks, playbookTaskCount), [tasks, playbookTaskCount]);
  const [expandedRun, setExpandedRun] = useState<number | null>(runs.length > 0 ? runs[0].runIndex : null);

  if (runs.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
        <Repeat className="h-10 w-10 mb-3 opacity-40" />
        <p className="text-sm">No execution runs yet</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="text-xs text-muted-foreground mb-2">
        <span className="font-mono">{runs.length}</span> execution{runs.length !== 1 ? "s" : ""} recorded
      </div>
      {runs.map((run) => {
        const isExpanded = expandedRun === run.runIndex;
        const isActive = run.tasks.some(t => t.status === "in_progress" || t.status === "review" || t.status === "assigned");
        const allTerminal = run.tasks.every(t => t.status === "done" || t.status === "failed");
        return (
          <div
            key={run.runIndex}
            className={cn(
              "rounded-lg border border-border bg-card shadow-card overflow-hidden",
              isActive && "border-l-2 border-l-primary/60",
            )}
          >
            {/* Run header */}
            <button
              className="flex items-center gap-3 w-full p-3 text-left hover:bg-muted/30 transition-colors"
              onClick={() => setExpandedRun(isExpanded ? null : run.runIndex)}
            >
              {isExpanded ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />}
              <span className="text-sm font-medium">Run #{run.runIndex}</span>
              <span className="text-xs text-muted-foreground">
                {format(new Date(run.startedAt), "MMM d, HH:mm")}
              </span>
              <div className="flex-1" />
              <div className="flex items-center gap-1.5">
                {isActive && (
                  <Badge variant="default" className="text-micro">
                    <Loader2 className="h-2.5 w-2.5 animate-spin mr-0.5" />Running
                  </Badge>
                )}
                {allTerminal && run.allDone && (
                  <Badge variant="secondary" className="text-micro text-success">
                    <CheckCircle2 className="h-2.5 w-2.5 mr-0.5" />Passed
                  </Badge>
                )}
                {allTerminal && !run.allDone && (
                  <Badge variant="secondary" className="text-micro text-destructive">
                    <AlertTriangle className="h-2.5 w-2.5 mr-0.5" />
                    {run.failedCount} failed
                  </Badge>
                )}
                {!allTerminal && !isActive && (
                  <Badge variant="secondary" className="text-micro">
                    {run.doneCount}/{run.tasks.length}
                  </Badge>
                )}
              </div>
            </button>

            {/* Expanded task list */}
            {isExpanded && (
              <div className="border-t border-border/40 px-3 py-2 space-y-1.5">
                {run.tasks.map((task) => {
                  const cfg = taskStatusConfig[task.status as TaskStatus];
                  const TaskIcon = cfg?.icon ?? Clock;
                  return (
                    <div
                      key={task.id}
                      className="flex items-center gap-2 py-1.5 px-2 rounded-xs hover:bg-muted/30 cursor-pointer transition-colors"
                      onClick={() => navigate(`/tasks/${task.id}`)}
                    >
                      <TaskIcon className={cn("h-3.5 w-3.5 shrink-0", cfg?.color ?? "text-muted-foreground", task.status === "in_progress" && "animate-spin")} />
                      <span className="text-sm truncate flex-1">{task.title}</span>
                      <TaskEngineBadge task={task} size={12} />
                      <TaskCostBadge cost={taskCostSummaryOf(task)} />
                      <span className="text-micro text-muted-foreground">{task.assignTo}</span>
                      <Badge variant="outline" className={cn("text-micro", cfg?.color ?? "")}>
                        {cfg?.label ?? task.status}
                      </Badge>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Main page ──

/**
 * Pure mission detail view — used by both the standalone page and the
 * preview dialog (when intercepting a mission from chat). All API
 * fetching is done by the caller; this component only renders.
 *
 * variant="page": back button + Execute/Resume/Abort actions
 * variant="dialog": no back button, no API actions (Dialog has its own X
 *   and the parent card carries Execute/Refine/Cancel)
 */
export interface MissionDetailViewProps {
  mission: Mission;
  report?: MissionReport;
  groupTasks: Task[];
  liveDelays: ActiveDelay[];
  scheduleEntry?: ScheduleEntry;
  variant?: "page" | "dialog";
  navigate: (path: string) => void;
  onBack?: () => void;
  onExecute?: () => Promise<unknown>;
  onResume?: () => Promise<unknown>;
  onAbort?: () => Promise<unknown>;
}

export function MissionDetailView({
  mission,
  report,
  groupTasks,
  liveDelays,
  scheduleEntry,
  variant = "page",
  navigate,
  onBack,
  onExecute,
  onResume,
  onAbort,
}: MissionDetailViewProps) {
  const parsed = useMemo(() => parseMissionData(mission.data), [mission.data]);

  const findLiveTask = useCallback(
    (title: string) => groupTasks.find(t => t.title === title),
    [groupTasks],
  );

  const doneCount = groupTasks.filter(t => t.status === "done").length;
  const failedCount = groupTasks.filter(t => t.status === "failed").length;
  const runningCount = groupTasks.filter(t => t.status === "in_progress" || t.status === "review").length;
  const totalCount = parsed?.tasks.length ?? 0;
  const progress = totalCount > 0 ? Math.round((doneCount / totalCount) * 100) : 0;

  const isRecurring = mission.status === "recurring";
  const isScheduled = mission.status === "scheduled";
  /** Blueprint mode: scheduled/recurring missions show task definitions as templates, not live instances */
  const isBlueprint = isRecurring || isScheduled;

  const findBlueprintTask = useCallback(() => undefined, []);

  const activeDelayMap = useMemo(() => {
    const map = new Map<string, ActiveDelay>();
    for (const d of liveDelays) {
      if (d.group === mission.name) map.set(d.delayName, d);
    }
    return map;
  }, [liveDelays, mission.name]);

  // decision nodes of this run: deciding, the branch taken, or waiting for a person
  const { nodes: liveDecisionNodes } = useDecisionNodes({ enabled: !!parsed?.decisions?.length });
  const decisionStates = useMemo(() => {
    const map = new Map<string, DecisionNodeView>();
    for (const n of liveDecisionNodes) {
      if (n.missionId ? n.missionId === mission.id : n.group === mission.name) map.set(n.node, { status: n.status, branch: n.branch, suggested: n.suggested });
    }
    return map;
  }, [liveDecisionNodes, mission.id, mission.name]);

  const expiredDelays = useMemo(() => {
    const set = new Set<string>();
    if (!parsed?.delays) return set;
    for (const dl of parsed.delays) {
      if (activeDelayMap.has(dl.name)) continue;
      const allAfterDone = dl.afterTasks.every(t => {
        const live = groupTasks.find(gt => gt.title === t);
        return live && (live.status === "done" || live.status === "failed");
      });
      if (allAfterDone) set.add(dl.name);
    }
    return set;
  }, [parsed?.delays, activeDelayMap, groupTasks]);

  const hasScheduleInfo = !!(mission.schedule || mission.deadline || mission.endDate || mission.qualityThreshold != null || scheduleEntry);

  // What the mission cost so far (every run of its tasks) and its budget: fetched again as its
  // tasks report cost or the mission changes
  const costKey = useMemo(
    () => `${mission.updatedAt}|${mission.budgetUsd ?? ""}|${mission.status}|${groupTasks.map(t => `${t.id}:${t.updatedAt}`).join(",")}`,
    [mission.updatedAt, mission.budgetUsd, mission.status, groupTasks],
  );
  const { cost, loading: costLoading, saveBudget } = useMissionCost(mission.id, costKey);
  const pausedByBudget = mission.status === "paused" && mission.pauseReason === "budget";

  const [actionPending, setActionPending] = useState<string | null>(null);
  const handleAction = async (action: () => Promise<unknown>, label: string) => {
    if (actionPending) return;
    setActionPending(label);
    try {
      await action();
      toast.success(label);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setActionPending(null);
    }
  };

  const style = missionStatusStyles[mission.status];
  const StatusIcon = style.icon;
  const isPage = variant === "page";

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-4">
      {/* Back + title bar */}
      <div className="flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          {isPage && onBack && (
            <Button variant="ghost" size="sm" onClick={onBack} className="shrink-0">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          )}
          <div className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-lg", style.bg)}>
            <StatusIcon className={cn("h-4 w-4", style.color, mission.status === "active" && "animate-spin")} />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="font-heading text-h2 truncate">{mission.name}</h1>
              <Badge variant="outline" className={cn("text-xs shrink-0 capitalize", style.color)}>
                {style.label}
              </Badge>
            </div>
            <div className="flex items-center gap-3 mt-0.5 text-xs text-muted-foreground">
              <CopyableId id={mission.id} label="Mission ID" />
              <span>{totalCount} task{totalCount !== 1 ? "s" : ""}</span>
              <span>Created {format(new Date(mission.createdAt), "MMM d, HH:mm")}</span>
              <span>Updated {formatDistanceToNow(new Date(mission.updatedAt), { addSuffix: true })}</span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <MissionCostButton
            cost={cost}
            budgetUsd={mission.budgetUsd}
            loading={costLoading}
            onSaveBudget={async (budgetUsd) => {
              await saveBudget(budgetUsd);
              toast.success(budgetUsd === null ? "Budget cleared" : `Budget set to $${budgetUsd}`);
            }}
          />
          {mission.status === "active" && totalCount > 0 && (
            <div className="flex items-center gap-2 mr-3">
              <Progress value={progress} className="h-2 w-28" />
              <span className="text-sm font-mono text-muted-foreground">{doneCount}/{totalCount}</span>
              {runningCount > 0 && (
                <Badge variant="secondary" className="text-micro">{runningCount} running</Badge>
              )}
              {failedCount > 0 && (
                <Badge variant="destructive" className="text-micro">{failedCount} failed</Badge>
              )}
            </div>
          )}
          {mission.status === "draft" && onExecute && (
            <Button size="sm" disabled={!!actionPending} onClick={() => handleAction(onExecute, "Mission executed")}>
              {actionPending === "Mission executed" ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Play className="h-3.5 w-3.5 mr-1.5" />} Execute
            </Button>
          )}
          {(mission.status === "active" || mission.status === "failed") && onResume && (
            <Button variant="outline" size="sm" disabled={!!actionPending} onClick={() => handleAction(onResume, "Mission resumed")}>
              {actionPending === "Mission resumed" ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5 mr-1.5" />} Resume
            </Button>
          )}
          {mission.status === "active" && onAbort && (
            <Button variant="outline" size="sm" className="text-destructive hover:text-destructive" disabled={!!actionPending} onClick={() => handleAction(onAbort, "Mission aborted")}>
              {actionPending === "Mission aborted" ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <XCircle className="h-3.5 w-3.5 mr-1.5" />} Abort
            </Button>
          )}
        </div>
      </div>

      {pausedByBudget && <MissionBudgetBanner cost={cost} budgetUsd={mission.budgetUsd} />}

      {/* Scheduling info strip */}
      {hasScheduleInfo && (
        <div className="flex items-center gap-4 flex-wrap shrink-0 rounded-lg border border-border bg-card shadow-card px-4 py-2.5">
          {mission.schedule && (
            <div className="flex items-center gap-1.5 text-xs">
              <Calendar className="h-3.5 w-3.5 text-info" />
              <span className="text-muted-foreground">Schedule:</span>
              <span className="font-medium">{cronToHuman(mission.schedule)}</span>
              {isRecurring ? (
                <Badge variant="outline" className="text-micro gap-0.5 text-chart-5 ml-1">
                  <Repeat className="h-2 w-2" />Recurring
                </Badge>
              ) : (
                <Badge variant="outline" className="text-micro text-muted-foreground ml-1">One-shot</Badge>
              )}
            </div>
          )}
          {scheduleEntry?.nextRunAt && (
            <div className="flex items-center gap-1.5 text-xs">
              <Clock className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-muted-foreground">Next:</span>
              <span className={cn("font-medium", new Date(scheduleEntry.nextRunAt).getTime() < Date.now() && "text-destructive")}>
                {new Date(scheduleEntry.nextRunAt).getTime() < Date.now()
                  ? "overdue"
                  : formatDistanceToNow(new Date(scheduleEntry.nextRunAt), { addSuffix: true })}
              </span>
            </div>
          )}
          {scheduleEntry?.lastRunAt && (
            <div className="flex items-center gap-1.5 text-xs">
              <Clock className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-muted-foreground">Last run:</span>
              <span className="font-medium">{formatDistanceToNow(new Date(scheduleEntry.lastRunAt), { addSuffix: true })}</span>
            </div>
          )}
          {scheduleEntry && (
            <div className="flex items-center gap-1.5 text-xs">
              <span className={cn("h-2 w-2 rounded-pill", scheduleEntry.enabled ? "bg-success" : "bg-muted-foreground")} />
              <span className="text-muted-foreground">{scheduleEntry.enabled ? "Enabled" : scheduleEntry.nextRunAt ? "Paused" : "Done"}</span>
            </div>
          )}
          {scheduleEntry?.lastOutcome && (
            <div className="flex items-center gap-1.5 text-xs" title={scheduleEntry.lastError}>
              <span className="text-muted-foreground">Last outcome:</span>
              <span className={cn("font-medium", scheduleEntry.lastOutcome === "failed" && "text-destructive",
                (scheduleEntry.lastOutcome === "missed" || scheduleEntry.lastOutcome === "skipped") && "text-warning")}>
                {scheduleEntry.lastOutcome}{scheduleEntry.lastError ? ` — ${scheduleEntry.lastError}` : ""}
              </span>
            </div>
          )}
          {(scheduleEntry?.missedRuns ?? 0) > 0 && (
            <div className="flex items-center gap-1.5 text-xs">
              <span className="text-muted-foreground">Missed:</span>
              <span className="font-medium text-warning">{scheduleEntry!.missedRuns} while the server was down</span>
            </div>
          )}
          {mission.endDate && (() => {
            const ed = new Date(mission.endDate);
            const isExpired = ed.getTime() < Date.now();
            return (
              <div className="flex items-center gap-1.5 text-xs">
                <Calendar className={cn("h-3.5 w-3.5", isExpired ? "text-muted-foreground" : "text-muted-foreground")} />
                <span className="text-muted-foreground">Ends:</span>
                <span className={cn("font-medium", isExpired && "text-muted-foreground line-through")}>
                  {format(ed, "MMM d, yyyy")}
                </span>
                {isExpired && <span className="text-micro text-muted-foreground">(expired)</span>}
              </div>
            );
          })()}
          {mission.deadline && (() => {
            const dl = new Date(mission.deadline);
            const isOverdue = dl.getTime() < Date.now();
            return (
              <div className="flex items-center gap-1.5 text-xs">
                <Timer className={cn("h-3.5 w-3.5", isOverdue ? "text-destructive" : "text-warning")} />
                <span className="text-muted-foreground">Deadline:</span>
                <span className={cn("font-medium", isOverdue && "text-destructive")}>
                  {isOverdue ? "Overdue" : `due ${formatDistanceToNow(dl, { addSuffix: true })}`}
                </span>
              </div>
            );
          })()}
          {mission.qualityThreshold != null && (
            <div className="flex items-center gap-1.5 text-xs">
              <Star className="h-3.5 w-3.5 text-warning" />
              <span className="text-muted-foreground">Quality:</span>
              <span className="font-medium">{mission.qualityThreshold}</span>
            </div>
          )}
        </div>
      )}

      {/* Tabs */}
      <Tabs defaultValue="graph" className="flex flex-col flex-1 min-h-0">
        <TabsList className="shrink-0">
          <TabsTrigger value="graph">
            <Workflow className="h-3.5 w-3.5 mr-1.5" />
            Graph
          </TabsTrigger>
          <TabsTrigger value="tasks">
            Tasks
            {groupTasks.length > 0 && (
              <Badge variant="secondary" className="ml-1.5 text-micro">{groupTasks.length}</Badge>
            )}
          </TabsTrigger>
          {isBlueprint && groupTasks.length > 0 && (
            <TabsTrigger value="runs">
              <Repeat className="h-3.5 w-3.5 mr-1.5" />
              Runs
            </TabsTrigger>
          )}
          <TabsTrigger value="notifications">
            <Bell className="h-3.5 w-3.5 mr-1.5" />
            Rules
          </TabsTrigger>
          <TabsTrigger value="suites" data-testid="mission-suites-tab">
            <FlaskRound className="h-3.5 w-3.5 mr-1.5" />
            Suites
          </TabsTrigger>
          <TabsTrigger value="raw">Raw JSON</TabsTrigger>
          {report && (
            <TabsTrigger value="report">
              Report
              <Badge variant="secondary" className="ml-1.5 text-micro">
                <BarChart3 className="h-2.5 w-2.5" />
              </Badge>
            </TabsTrigger>
          )}
        </TabsList>

        {/* Graph tab — visual node-based mission view */}
        <TabsContent value="graph" className="mt-4 flex-1 min-h-0">
          {parsed && parsed.tasks.length > 0 ? (
            <div className="h-full w-full rounded-lg border border-border/40">
              {isBlueprint && (
                <div className="px-4 py-2 border-b border-border/40 bg-muted/30">
                  <span className="text-caption text-muted-foreground">
                    Blueprint view — task definitions are templates. See the <span className="font-medium">Runs</span> tab for execution history.
                  </span>
                </div>
              )}
              <ReactFlowProvider>
                <MissionGraphInner
                  taskDefs={parsed.tasks}
                  findLiveTask={isBlueprint ? findBlueprintTask : findLiveTask}
                  checkpoints={parsed.checkpoints}
                  delays={parsed.delays}
                  activeDelayMap={isBlueprint ? undefined : activeDelayMap}
                  expiredDelays={isBlueprint ? undefined : expiredDelays}
                  decisions={parsed.decisions}
                  decisionStates={isBlueprint ? undefined : decisionStates}
                />
              </ReactFlowProvider>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
              <Workflow className="h-10 w-10 mb-3 opacity-40" />
              <p className="text-sm">No tasks defined in this mission</p>
            </div>
          )}
        </TabsContent>

        {/* Tasks tab — vertical stepper timeline */}
        <TabsContent value="tasks" className="mt-4 flex-1 min-h-0">
          <ScrollArea className="h-full">
            <div className="pr-4">
              {/* Blueprint banner */}
              {isBlueprint && (
                <div className="rounded-lg bg-muted/30 border border-border/40 px-4 py-2.5 mb-4">
                  <span className="text-caption text-muted-foreground">
                    Blueprint view — these are task templates, not live instances. See the <span className="font-medium">Runs</span> tab for execution history.
                  </span>
                </div>
              )}

              {/* Prompt */}
              {mission.prompt && (
                <div className="flex items-start gap-3 rounded-lg bg-muted/40 p-3.5 mb-6">
                  <Quote className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
                  <div>
                    <p className="text-label text-muted-foreground mb-1">
                      Original Request
                    </p>
                    <p className="text-sm leading-relaxed">{mission.prompt}</p>
                  </div>
                </div>
              )}

              {/* Stepper timeline */}
              {parsed && parsed.tasks.length > 0 ? (
                <div className="relative">
                  {parsed.tasks.map((taskDef, idx) => (
                    <TaskStepCard
                      key={idx}
                      taskDef={taskDef}
                      index={idx}
                      isLast={idx === parsed.tasks.length - 1}
                      liveTask={isBlueprint ? undefined : findLiveTask(taskDef.title)}
                      navigate={navigate}
                    />
                  ))}
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
                  <ListChecks className="h-10 w-10 mb-3 opacity-40" />
                  <p className="text-sm">No tasks defined in this mission</p>
                </div>
              )}
            </div>
          </ScrollArea>
        </TabsContent>

        {/* Runs tab — execution history for recurring missions */}
        {isRecurring && groupTasks.length > 0 && (
          <TabsContent value="runs" className="mt-4 flex-1 min-h-0">
            <ScrollArea className="h-full">
              <div className="space-y-4 pr-4">
                <RunsTimeline tasks={groupTasks} parsed={parsed} navigate={navigate} />
              </div>
            </ScrollArea>
          </TabsContent>
        )}

        {/* Notifications tab — applied rule preview */}
        <TabsContent value="notifications" className="mt-4 flex-1 min-h-0">
          <ScrollArea className="h-full">
            <div className="pr-4 space-y-3 max-w-3xl">
              <p className="text-xs text-muted-foreground leading-relaxed">
                These are the notification rules that would fire for this mission, resolved by scope.
                Mission-scoped rules replace global rules unless <code className="font-mono text-caption">inherit: true</code> is set.
              </p>
              <MissionAppliedRules mission={mission} />
            </div>
          </ScrollArea>
        </TabsContent>

        {/* Raw JSON tab — full width code block with copy */}
        <TabsContent value="suites" className="mt-4 flex-1 min-h-0">
          <TargetSuitesPanel kind="mission" id={mission.id} />
        </TabsContent>

        <TabsContent value="raw" className="mt-4 flex-1 min-h-0">
          <ScrollArea className="h-full">
            <div className="pr-4">
              <div className="rounded-lg border border-border/40 overflow-hidden">
                {/* Code block header */}
                <div className="flex items-center justify-between px-4 py-2 bg-muted/40 border-b border-border/40">
                  <div className="flex items-center gap-2">
                    <FileJson className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="text-xs font-medium text-muted-foreground">mission.json</span>
                  </div>
                  <CopyButton text={(() => { try { return JSON.stringify(JSON.parse(mission.data), null, 2); } catch { return mission.data; } })()} />
                </div>
                {/* Code block body */}
                <JsonBlock
                  data={(() => { try { return JSON.parse(mission.data); } catch { return mission.data; } })()}
                  className="text-xs leading-relaxed font-mono px-4 py-3 whitespace-pre-wrap overflow-auto"
                />
              </div>
            </div>
          </ScrollArea>
        </TabsContent>

        {/* Report tab — MissionReport from mission:completed SSE event */}
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
                          <Star className="h-4 w-4 text-warning" />
                          <span className="font-heading text-h2 tabular-nums">{report.avgScore.toFixed(2)}</span>
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
                            <span className="text-label text-muted-foreground flex items-center gap-1 mb-1">
                              <FilePlus className="h-3 w-3" /> Files Created ({report.filesCreated.length})
                            </span>
                            <div className="flex flex-wrap gap-1">
                              {report.filesCreated.map((f: string, i: number) => (
                                <code key={i} className="text-micro bg-success/10 text-success rounded-xs px-1.5 py-0.5 font-mono">{f}</code>
                              ))}
                            </div>
                          </div>
                        )}
                        {report.filesEdited.length > 0 && (
                          <div>
                            <span className="text-label text-muted-foreground flex items-center gap-1 mb-1">
                              <FileEdit className="h-3 w-3" /> Files Edited ({report.filesEdited.length})
                            </span>
                            <div className="flex flex-wrap gap-1">
                              {report.filesEdited.map((f: string, i: number) => (
                                <code key={i} className="text-micro bg-info/10 text-info rounded-xs px-1.5 py-0.5 font-mono">{f}</code>
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
                    <p className="text-label text-muted-foreground mb-3">
                      Per-Task Results
                    </p>
                    <div className="space-y-2">
                      {report.tasks.map((t: MissionReport["tasks"][number], i: number) => (
                        <div key={i} className="rounded-md border border-border p-3">
                          <div className="flex items-center gap-2">
                            {t.status === "done" ? (
                              <CheckCircle2 className="h-3.5 w-3.5 text-success shrink-0" />
                            ) : (
                              <XCircle className="h-3.5 w-3.5 text-destructive shrink-0" />
                            )}
                            <span className="text-sm font-medium truncate">{t.title}</span>
                            {t.score != null && (
                              <Badge variant="outline" className="text-micro ml-auto shrink-0">
                                <Star className="h-2.5 w-2.5 mr-0.5" />
                                {t.score.toFixed(1)}
                              </Badge>
                            )}
                            <span className="text-micro text-muted-foreground shrink-0">
                              {Math.round(t.duration / 1000)}s
                            </span>
                          </div>
                          {(t.filesCreated.length > 0 || t.filesEdited.length > 0) && (
                            <div className="flex flex-wrap gap-1 mt-2 ml-5">
                              {t.filesCreated.map((f: string, j: number) => (
                                <code key={`c-${j}`} className="text-micro bg-success/10 text-success rounded-xs px-1 py-0 font-mono">+{f.split("/").pop()}</code>
                              ))}
                              {t.filesEdited.map((f: string, j: number) => (
                                <code key={`e-${j}`} className="text-micro bg-info/10 text-info rounded-xs px-1 py-0 font-mono">~{f.split("/").pop()}</code>
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

/**
 * Render applied notification rules for a mission. Lives outside
 * MissionDetailView so the view stays a pure presentation component
 * (no data-fetching coupling for an optional tab).
 */
function MissionAppliedRules({ mission }: { mission: Mission }) {
  const { config } = useConfig();
  const globalRules = ((config?.settings?.notifications as { rules?: AnyRule[] } | undefined)?.rules) ?? [];
  const missionScoped: ScopedRules | undefined = (mission as Mission & { notifications?: ScopedRules }).notifications;
  return (
    <AppliedRulesPanel
      variant="mission"
      missionScoped={missionScoped}
      globalRules={globalRules}
    />
  );
}

/**
 * Standalone page wrapper — fetches mission state via API and renders
 * the shared MissionDetailView with full action handlers.
 */
export function MissionDetailPage() {
  const { missionId } = useParams<{ missionId: string }>();
  const navigate = useNavigate();
  const { mission, report, isLoading, error, executeMission, resumeMission, abortMission } = useMission(missionId ?? "");
  const { tasks: allTasks } = useTasks();
  const { schedules } = useSchedules();
  const { activeDelays: liveDelays } = useActiveDelays();

  // Only this mission's tasks: missions created before names were unique can share a group.
  const groupTasks = useMemo(
    () => mission ? allTasks.filter(t => t.group === mission.name && (!t.missionId || t.missionId === mission.id)) : [],
    [allTasks, mission],
  );

  const scheduleEntry = useMemo(
    () => missionId ? schedules.find((s: ScheduleEntry) => s.missionId === missionId) : undefined,
    [schedules, missionId],
  );

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error || !mission) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-muted-foreground">
        <AlertTriangle className="h-10 w-10 opacity-40" />
        <p className="text-sm">Mission not found</p>
        <Button variant="outline" size="sm" onClick={() => navigate("/missions")}>
          <ArrowLeft className="h-3.5 w-3.5 mr-1.5" />
          Back to Missions
        </Button>
      </div>
    );
  }

  return (
    <MissionDetailView
      mission={mission}
      report={report}
      groupTasks={groupTasks}
      liveDelays={liveDelays}
      scheduleEntry={scheduleEntry}
      variant="page"
      navigate={navigate}
      onBack={() => navigate("/missions")}
      onExecute={executeMission}
      onResume={() => resumeMission()}
      onAbort={abortMission}
    />
  );
}
