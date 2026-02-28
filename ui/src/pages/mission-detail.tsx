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
  Workflow,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
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
import { useMission, useTasks, useSchedules } from "@lumea-labs/polpo-react";
import type { MissionStatus, MissionReport, TaskStatus, Task } from "@lumea-labs/polpo-react";
import { toast } from "sonner";
import { formatDistanceToNow, format } from "date-fns";
import { cn } from "@/lib/utils";
import { cronToHuman } from "@/lib/cron";
import { JsonBlock } from "@/components/json-block";
import { Calendar, Repeat } from "lucide-react";

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
      {copied ? <Check className="h-3 w-3 mr-1 text-emerald-500" /> : <Copy className="h-3 w-3 mr-1" />}
      {copied ? "Copied" : "Copy"}
    </Button>
  );
}

// ── Parsed mission shape ──

interface MissionTaskDef {
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

interface ParsedMission {
  name?: string;
  tasks: MissionTaskDef[];
}

function parseMissionData(data: string): ParsedMission | null {
  try {
    const parsed = JSON.parse(data);
    return {
      name: parsed.name,
      tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
    };
  } catch {
    return null;
  }
}

// ── Status styles ──

const statusStyles: Record<MissionStatus, { color: string; bg: string; label: string; icon: React.ElementType }> = {
  draft: { color: "text-zinc-400", bg: "bg-zinc-500/10", label: "Draft", icon: Clock },
  active: { color: "text-blue-400", bg: "bg-blue-500/10", label: "Running", icon: Loader2 },
  paused: { color: "text-amber-400", bg: "bg-amber-500/10", label: "Paused", icon: Clock },
  completed: { color: "text-emerald-400", bg: "bg-emerald-500/10", label: "Completed", icon: CheckCircle2 },
  failed: { color: "text-red-400", bg: "bg-red-500/10", label: "Failed", icon: AlertTriangle },
  cancelled: { color: "text-zinc-500", bg: "bg-zinc-500/10", label: "Cancelled", icon: XCircle },
};

const taskStatusConfig: Record<TaskStatus, { icon: React.ElementType; color: string; label: string; nodeColor: string }> = {
  draft: { icon: Clock, color: "text-zinc-500", label: "Draft", nodeColor: "border-zinc-500/40" },
  pending: { icon: Clock, color: "text-zinc-400", label: "Queued", nodeColor: "border-zinc-400/40" },
  awaiting_approval: { icon: Clock, color: "text-amber-400", label: "Awaiting", nodeColor: "border-amber-400/40" },
  assigned: { icon: Clock, color: "text-violet-400", label: "Assigned", nodeColor: "border-violet-400/40" },
  in_progress: { icon: Loader2, color: "text-blue-400", label: "Running", nodeColor: "border-blue-400/60" },
  review: { icon: Eye, color: "text-amber-400", label: "Review", nodeColor: "border-amber-400/60" },
  done: { icon: CheckCircle2, color: "text-emerald-400", label: "Done", nodeColor: "border-emerald-400/60" },
  failed: { icon: AlertTriangle, color: "text-red-400", label: "Failed", nodeColor: "border-red-400/60" },
};

const phaseIcons: Record<string, { icon: React.ElementType; color: string; label: string }> = {
  fix: { icon: Hammer, color: "text-orange-400", label: "Fix" },
  clarification: { icon: HelpCircle, color: "text-purple-400", label: "Clarifying" },
  review: { icon: Eye, color: "text-amber-400", label: "Review" },
};

// ── Graph node data ──

interface TaskNodeData {
  taskDef: MissionTaskDef;
  liveTask?: Task;
  index: number;
  expanded?: boolean;
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
      ? "bg-emerald-500/5"
      : liveTask.status === "failed"
        ? "bg-red-500/5"
        : liveTask.status === "in_progress"
          ? "bg-blue-500/5"
          : liveTask.status === "review"
            ? "bg-amber-500/5"
            : "bg-card/90"
    : "bg-card/90";

  const borderColor = statusCfg?.nodeColor ?? "border-border";

  return (
    <>
      <Handle type="target" position={Position.Top} className="!bg-muted-foreground/50 !border-none !w-2 !h-2" />
      <div
        className={cn(
          "rounded-xl border-2 px-4 py-3 shadow-sm backdrop-blur-sm transition-all cursor-pointer overflow-hidden",
          expanded ? "min-w-[320px] max-w-[420px]" : "min-w-[200px] max-w-[280px]",
          selected
            ? "border-primary ring-2 ring-primary/30 shadow-[0_0_24px_oklch(0.7_0.15_200_/_18%)]"
            : borderColor,
          bgColor,
        )}
      >
        {/* Header row */}
        <div className="flex items-center gap-2 mb-1.5">
          <span className="text-[10px] font-mono text-muted-foreground shrink-0">#{index + 1}</span>
          <StatusIcon
            className={cn(
              "h-3.5 w-3.5 shrink-0",
              statusCfg?.color ?? "text-muted-foreground",
              liveTask?.status === "in_progress" && "animate-spin",
            )}
          />
          {statusCfg && (
            <Badge variant="outline" className={cn("text-[8px] px-1 py-0", statusCfg.color)}>
              {statusCfg.label}
            </Badge>
          )}
          {phase && (
            <Badge variant="outline" className={cn("text-[8px] px-1 py-0 gap-0.5", phase.color)}>
              <phase.icon className="h-2 w-2" />
              {phase.label}
            </Badge>
          )}
          {score != null && (
            <Badge
              variant={score >= 0.7 ? "default" : "destructive"}
              className="text-[8px] px-1 py-0 ml-auto"
            >
              <Star className="h-2 w-2 mr-0.5" />
              {Math.round(score * 100)}%
            </Badge>
          )}
        </div>

        {/* Title */}
        <p className={cn("text-xs font-semibold leading-tight mb-1.5", !expanded && "line-clamp-2")}>{taskDef.title}</p>

        {/* Description — collapsed: 2-line clamp, expanded: full markdown */}
        {taskDef.description && (
          expanded ? (
            <div className="prose prose-xs prose-invert max-w-none [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 text-[10px] text-muted-foreground leading-snug mb-2 overflow-hidden break-words [&_pre]:overflow-x-auto [&_pre]:max-w-full [&_pre]:text-[9px] [&_code]:break-all [&_code]:text-[9px] [&_ul]:pl-3 [&_ol]:pl-3 [&_p]:my-1">
              <Markdown>{taskDef.description}</Markdown>
            </div>
          ) : (
            <p className="text-[10px] text-muted-foreground leading-snug mb-2 line-clamp-2">{taskDef.description}</p>
          )
        )}

        {/* Compact footer (always visible) */}
        <div className="flex items-center gap-1.5 flex-wrap">
          {taskDef.assignTo && (
            <Badge variant="outline" className="text-[8px] px-1 py-0 gap-0.5">
              <Bot className="h-2 w-2" />
              {taskDef.assignTo}
            </Badge>
          )}
          {taskDef.dependsOn && taskDef.dependsOn.length > 0 && (
            <Badge variant="secondary" className="text-[8px] px-1 py-0 gap-0.5">
              <GitBranch className="h-2 w-2" />
              {taskDef.dependsOn.length}
            </Badge>
          )}
          {totalChecks > 0 && !expanded && (
            <Badge variant="secondary" className="text-[8px] px-1 py-0 gap-0.5">
              <Wrench className="h-2 w-2" />
              {totalChecks}
            </Badge>
          )}
          {liveTask?.result?.duration != null && (
            <span className="text-[9px] text-muted-foreground ml-auto">
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
                <p className="text-[9px] font-medium text-muted-foreground uppercase tracking-wider mb-1.5">Dependencies</p>
                <div className="flex flex-wrap gap-1">
                  {taskDef.dependsOn.map((d, i) => (
                    <Badge key={i} variant="secondary" className="text-[9px] font-mono">{d}</Badge>
                  ))}
                </div>
              </div>
            )}

            {/* Expectations checklist */}
            {taskDef.expectations && taskDef.expectations.length > 0 && (
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <p className="text-[9px] font-medium text-muted-foreground uppercase tracking-wider">Expectations</p>
                  {liveTask && totalChecks > 0 && (
                    <span className={cn(
                      "text-[9px] font-medium",
                      passedChecks === totalChecks ? "text-emerald-400" : "text-muted-foreground",
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
                          "flex items-start gap-1.5 text-[10px] rounded px-1.5 py-1",
                          passed === true && "bg-emerald-500/8",
                          passed === false && "bg-red-500/8",
                        )}
                      >
                        {check != null ? (
                          passed ? (
                            <CheckCircle2 className="h-3 w-3 text-emerald-500 shrink-0 mt-px" />
                          ) : (
                            <XCircle className="h-3 w-3 text-red-500 shrink-0 mt-px" />
                          )
                        ) : (
                          <div className="h-3 w-3 rounded-full border border-border/60 shrink-0 mt-px" />
                        )}
                        <div className="min-w-0">
                          <div className="flex items-center gap-1">
                            <Badge variant="outline" className="text-[7px] px-1 py-0 shrink-0">{exp.type}</Badge>
                            {exp.threshold != null && (
                              <span className="text-[8px] text-muted-foreground">thr: {exp.threshold}</span>
                            )}
                          </div>
                          <p className="text-muted-foreground leading-snug mt-0.5">
                            {exp.criteria ?? exp.command ?? exp.paths?.join(", ") ?? "LLM review"}
                          </p>
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
                <p className="text-[9px] font-medium text-muted-foreground uppercase tracking-wider mb-1.5">Metrics</p>
                <div className="space-y-1">
                  {taskDef.metrics.map((m, i) => (
                    <div key={i} className="flex items-center gap-2 text-[10px]">
                      <span className="font-medium">{m.name}</span>
                      <code className="text-[9px] font-mono text-muted-foreground bg-muted/40 px-1 rounded">{m.command}</code>
                      <span className="text-muted-foreground ml-auto shrink-0">thr: {m.threshold}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Retry config */}
            {(taskDef.maxRetries != null || taskDef.maxDuration != null) && (
              <div className="flex items-center gap-3 text-[9px] text-muted-foreground">
                {taskDef.maxRetries != null && <span>Max retries: {taskDef.maxRetries}</span>}
                {taskDef.maxDuration != null && <span>Timeout: {Math.round(taskDef.maxDuration / 1000)}s</span>}
              </div>
            )}

            {/* View task detail — only when selected and a live task exists */}
            {selected && liveTask && (
              <div className="pt-2 border-t border-border/30">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 w-full text-[11px] font-medium gap-1 text-primary"
                  onClick={(e) => { e.stopPropagation(); navigate(`/tasks/${liveTask.id}`); }}
                >
                  View task detail
                  <ChevronRight className="h-3 w-3" />
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
      <Handle type="source" position={Position.Bottom} className="!bg-muted-foreground/50 !border-none !w-2 !h-2" />
    </>
  );
}

const nodeTypes = { taskNode: TaskNodeComponent };

// ── Graph layout computation ──

const NODE_WIDTH = 240;
const NODE_HEIGHT = 140;
const H_GAP = 60;
const V_GAP = 80;

function buildGraphLayout(
  taskDefs: MissionTaskDef[],
  findLive: (title: string) => Task | undefined,
): { nodes: Node<TaskNodeData>[]; edges: Edge[] } {
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

  // Group by layer
  const maxLayer = Math.max(...layers, 0);
  const layerGroups: number[][] = Array.from({ length: maxLayer + 1 }, () => []);
  layers.forEach((l, i) => layerGroups[l].push(i));

  // Position nodes: center each layer horizontally
  const nodes: Node<TaskNodeData>[] = [];
  for (let layer = 0; layer <= maxLayer; layer++) {
    const group = layerGroups[layer];
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
        },
      });
    });
  }

  // Build edges from dependencies
  const edges: Edge[] = [];
  taskDefs.forEach((t, idx) => {
    for (const dep of t.dependsOn ?? []) {
      const di = titleIndex.get(dep);
      if (di != null) {
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
              ? "oklch(0.63 0.2 25)"    // red
              : isDone
                ? "oklch(0.72 0.17 155)" // green
                : "oklch(0.55 0 0 / 0.3)", // muted
            strokeWidth: isDone || isFailed ? 2 : 1.5,
          },
          animated: sourceLive?.status === "in_progress",
        });
      }
    }
  });

  return { nodes, edges };
}

// ── Graph inner (needs ReactFlow context) ──

function MissionGraphInner({
  taskDefs,
  findLiveTask,
}: {
  taskDefs: MissionTaskDef[];
  findLiveTask: (title: string) => Task | undefined;
}) {
  const { fitView } = useReactFlow();
  const { nodes: initial, edges: initialEdges } = useMemo(
    () => buildGraphLayout(taskDefs, findLiveTask),
    [taskDefs, findLiveTask],
  );

  const [nodes, setNodes, onNodesChange] = useNodesState(initial);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

  // Sync when live task status changes
  useEffect(() => {
    const { nodes: n, edges: e } = buildGraphLayout(taskDefs, findLiveTask);
    // Preserve expanded state across syncs
    setNodes((prev) =>
      n.map((node) => {
        const existing = prev.find((p) => p.id === node.id);
        if (existing?.data.expanded) {
          return { ...node, data: { ...node.data, expanded: true } };
        }
        return node;
      }),
    );
    setEdges(e);
  }, [taskDefs, findLiveTask, setNodes, setEdges]);

  useEffect(() => {
    const t = setTimeout(() => fitView({ padding: 0.2 }), 50);
    return () => clearTimeout(t);
  }, [fitView, nodes.length]);

  // Toggle expanded on node click
  const handleNodeClick = useCallback(
    (_: React.MouseEvent, node: Node<TaskNodeData>) => {
      setNodes((prev) =>
        prev.map((n) =>
          n.id === node.id
            ? { ...n, data: { ...n.data, expanded: !n.data.expanded } }
            : n.data.expanded
              ? { ...n, data: { ...n.data, expanded: false } }
              : n,
        ),
      );
    },
    [setNodes],
  );

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onNodeClick={handleNodeClick}
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
      <Controls showInteractive={false} className="!bg-card !border-border !shadow-md [&>button]:!bg-card [&>button]:!border-border [&>button]:!text-foreground [&>button:hover]:!bg-accent" />
    </ReactFlow>
  );
}

// ── Task step card (collapsible, markdown description) ──

function TaskStepCard({
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
            "relative z-10 flex h-8 w-8 items-center justify-center rounded-full border-2 text-xs font-bold transition-all",
            isDone && "border-emerald-500 bg-emerald-500/15 text-emerald-400",
            isFailed && "border-red-500 bg-red-500/15 text-red-400",
            isRunning && "border-blue-500 bg-blue-500/15 text-blue-400",
            isReview && "border-amber-500 bg-amber-500/15 text-amber-400",
            !liveTask && "border-border bg-muted/50 text-muted-foreground",
            liveTask && !isDone && !isFailed && !isRunning && !isReview && "border-zinc-500 bg-zinc-500/10 text-zinc-400",
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
            <span className="absolute inset-0 rounded-full border-2 border-blue-400 animate-ping opacity-20" />
          )}
        </div>
        {!isLast && (
          <div
            className={cn(
              "w-0.5 flex-1 min-h-6 transition-colors",
              isDone ? "bg-emerald-500/40" : "bg-border/60",
            )}
          />
        )}
      </div>

      {/* Card */}
      <div className={cn("flex-1 min-w-0", isLast ? "pb-0" : "pb-6")}>
        <div
          className={cn(
            "rounded-lg border transition-all",
            "hover:shadow-[0_0_20px_oklch(0.7_0.15_200_/_6%)] hover:border-primary/20",
            isDone && "border-emerald-500/20 bg-emerald-500/[0.03]",
            isFailed && "border-red-500/20 bg-red-500/[0.03]",
            isRunning && "border-blue-500/25 bg-blue-500/[0.03]",
            isReview && "border-amber-500/20 bg-amber-500/[0.03]",
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
                    <Badge variant="outline" className={cn("text-[9px] shrink-0", statusCfg.color)}>
                      {statusCfg.label}
                    </Badge>
                  )}
                  {phaseInfo && (
                    <Badge variant="outline" className={cn("text-[9px] gap-0.5 shrink-0", phaseInfo.color)}>
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
                {/* Score ring */}
                {score != null && (
                  <div className={cn(
                    "flex flex-col items-center justify-center h-10 w-10 rounded-full border-2",
                    score >= 0.7 ? "border-emerald-500/50 text-emerald-400" : "border-red-500/50 text-red-400",
                  )}>
                    <span className="text-xs font-bold leading-none">{Math.round(score * 100)}</span>
                    <span className="text-[7px] text-muted-foreground leading-none">%</span>
                  </div>
                )}
                <ChevronDown className={cn("h-4 w-4 text-muted-foreground transition-transform", expanded && "rotate-180")} />
              </div>
            </div>

            {/* Metadata row — always visible */}
            <div className="flex items-center gap-3 mt-2 text-[11px] text-muted-foreground">
              {taskDef.assignTo && (
                <span className="flex items-center gap-1">
                  <Bot className="h-3 w-3" />
                  {taskDef.assignTo}
                </span>
              )}
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
                  <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-2">Dependencies</p>
                  <div className="flex flex-wrap gap-1.5">
                    {taskDef.dependsOn.map((d, i) => (
                      <Badge key={i} variant="secondary" className="text-[10px] font-mono">{d}</Badge>
                    ))}
                  </div>
                </div>
              )}

              {/* Expectations */}
              {taskDef.expectations && taskDef.expectations.length > 0 && (
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Expectations</p>
                    {liveTask && totalChecks > 0 && (
                      <span className={cn(
                        "text-[10px] font-medium",
                        passedChecks === totalChecks ? "text-emerald-400" : "text-muted-foreground",
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
                            passed === true && "bg-emerald-500/5",
                            passed === false && "bg-red-500/5",
                            passed == null && "bg-muted/30",
                          )}
                        >
                          {check != null ? (
                            passed ? (
                              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 shrink-0 mt-0.5" />
                            ) : (
                              <XCircle className="h-3.5 w-3.5 text-red-500 shrink-0 mt-0.5" />
                            )
                          ) : (
                            <div className="h-3.5 w-3.5 rounded-full border border-border/60 shrink-0 mt-0.5" />
                          )}
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5 mb-0.5">
                              <Badge variant="outline" className="text-[8px] px-1 py-0">{exp.type}</Badge>
                              {exp.confidence && <span className="text-[9px] text-muted-foreground">{exp.confidence}</span>}
                              {exp.threshold != null && (
                                <span className="text-[9px] text-muted-foreground ml-auto">threshold: {exp.threshold}</span>
                              )}
                            </div>
                            <p className="text-muted-foreground leading-relaxed">
                              {exp.criteria ?? exp.command ?? exp.paths?.join(", ") ?? "LLM review"}
                            </p>
                            {exp.dimensions && exp.dimensions.length > 0 && (
                              <div className="mt-1.5 space-y-0.5">
                                {exp.dimensions.map((d, k) => (
                                  <div key={k} className="flex items-center gap-2 text-[10px] text-muted-foreground">
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
                  <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-2">Metrics</p>
                  <div className="space-y-1">
                    {taskDef.metrics.map((m, i) => (
                      <div key={i} className="flex items-center gap-2 text-xs">
                        <span className="font-medium">{m.name}</span>
                        <code className="text-[10px] font-mono text-muted-foreground bg-muted/40 px-1.5 rounded">{m.command}</code>
                        <span className="text-muted-foreground ml-auto">thr: {m.threshold}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Retry / duration config */}
              {(taskDef.maxRetries != null || taskDef.maxDuration != null || taskDef.retryPolicy) && (
                <div className="flex items-center gap-4 text-[11px] text-muted-foreground">
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

// ── Main page ──

export function MissionDetailPage() {
  const { missionId } = useParams<{ missionId: string }>();
  const navigate = useNavigate();
  const { mission, report, isLoading, error, executeMission, resumeMission, abortMission } = useMission(missionId ?? "");
  const { tasks: allTasks } = useTasks();
  const { schedules } = useSchedules();

  const parsed = useMemo(() => mission ? parseMissionData(mission.data) : null, [mission]);

  // Match live tasks to this mission's group
  const missionGroup = mission?.name;
  const groupTasks = useMemo(
    () => missionGroup ? allTasks.filter(t => t.group === missionGroup) : [],
    [allTasks, missionGroup]
  );

  const findLiveTask = useCallback(
    (title: string) => groupTasks.find(t => t.title === title),
    [groupTasks],
  );

  const doneCount = groupTasks.filter(t => t.status === "done").length;
  const failedCount = groupTasks.filter(t => t.status === "failed").length;
  const runningCount = groupTasks.filter(t => t.status === "in_progress" || t.status === "review").length;
  const totalCount = parsed?.tasks.length ?? 0;
  const progress = totalCount > 0 ? Math.round((doneCount / totalCount) * 100) : 0;

  const scheduleEntry = useMemo(
    () => missionId ? schedules.find(s => s.missionId === missionId) : undefined,
    [schedules, missionId],
  );

  const hasScheduleInfo = !!(mission?.schedule || mission?.deadline || mission?.qualityThreshold != null);

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

  const style = statusStyles[mission.status];
  const StatusIcon = style.icon;

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-4">
      {/* Back + title bar */}
      <div className="flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <Button variant="ghost" size="sm" onClick={() => navigate("/missions")} className="shrink-0">
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-lg", style.bg)}>
            <StatusIcon className={cn("h-4 w-4", style.color, mission.status === "active" && "animate-spin")} />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-semibold truncate">{mission.name}</h1>
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
          {mission.status === "active" && totalCount > 0 && (
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
          {mission.status === "draft" && (
            <Button size="sm" disabled={!!actionPending} onClick={() => handleAction(executeMission, "Mission executed")}>
              {actionPending === "Mission executed" ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Play className="h-3.5 w-3.5 mr-1.5" />} Execute
            </Button>
          )}
          {(mission.status === "active" || mission.status === "failed") && (
            <Button variant="outline" size="sm" disabled={!!actionPending} onClick={() => handleAction(() => resumeMission(), "Mission resumed")}>
              {actionPending === "Mission resumed" ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5 mr-1.5" />} Resume
            </Button>
          )}
          {mission.status === "active" && (
            <Button variant="outline" size="sm" className="text-red-400 hover:text-red-500" disabled={!!actionPending} onClick={() => handleAction(abortMission, "Mission aborted")}>
              {actionPending === "Mission aborted" ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <XCircle className="h-3.5 w-3.5 mr-1.5" />} Abort
            </Button>
          )}
        </div>
      </div>

      {/* Scheduling info strip */}
      {hasScheduleInfo && (
        <div className="flex items-center gap-4 flex-wrap shrink-0 rounded-lg border border-border/40 bg-card/60 backdrop-blur-sm px-4 py-2.5">
          {mission.schedule && (
            <div className="flex items-center gap-1.5 text-xs">
              <Calendar className="h-3.5 w-3.5 text-blue-400" />
              <span className="text-muted-foreground">Schedule:</span>
              <span className="font-medium">{cronToHuman(mission.schedule)}</span>
              {mission.recurring ? (
                <Badge variant="outline" className="text-[9px] gap-0.5 text-violet-400 ml-1">
                  <Repeat className="h-2 w-2" />Recurring
                </Badge>
              ) : (
                <Badge variant="outline" className="text-[9px] text-muted-foreground ml-1">One-shot</Badge>
              )}
            </div>
          )}
          {mission.deadline && (() => {
            const dl = new Date(mission.deadline);
            const isOverdue = dl.getTime() < Date.now();
            return (
              <div className="flex items-center gap-1.5 text-xs">
                <Timer className={cn("h-3.5 w-3.5", isOverdue ? "text-red-400" : "text-amber-400")} />
                <span className="text-muted-foreground">Deadline:</span>
                <span className={cn("font-medium", isOverdue && "text-red-400")}>
                  {isOverdue ? "Overdue" : `due ${formatDistanceToNow(dl, { addSuffix: true })}`}
                </span>
              </div>
            );
          })()}
          {mission.qualityThreshold != null && (
            <div className="flex items-center gap-1.5 text-xs">
              <Star className="h-3.5 w-3.5 text-amber-400" />
              <span className="text-muted-foreground">Quality:</span>
              <span className="font-medium">{mission.qualityThreshold}</span>
            </div>
          )}
          {scheduleEntry?.nextRunAt && (
            <div className="flex items-center gap-1.5 text-xs">
              <Clock className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-muted-foreground">Next run:</span>
              <span className="font-medium">{formatDistanceToNow(new Date(scheduleEntry.nextRunAt), { addSuffix: true })}</span>
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
              <span className={cn("h-2 w-2 rounded-full", scheduleEntry.enabled ? "bg-emerald-500" : "bg-zinc-500")} />
              <span className="text-muted-foreground">{scheduleEntry.enabled ? "Enabled" : "Disabled"}</span>
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
              <Badge variant="secondary" className="ml-1.5 text-[9px]">{groupTasks.length}</Badge>
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

        {/* Graph tab — visual node-based mission view */}
        <TabsContent value="graph" className="mt-4 flex-1 min-h-0">
          {parsed && parsed.tasks.length > 0 ? (
            <div className="h-full w-full rounded-lg border border-border/40">
              <ReactFlowProvider>
                <MissionGraphInner taskDefs={parsed.tasks} findLiveTask={findLiveTask} />
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
              {/* Prompt */}
              {mission.prompt && (
                <div className="flex items-start gap-3 rounded-lg bg-muted/40 p-3.5 mb-6">
                  <Quote className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
                  <div>
                    <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-1">
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
                      liveTask={findLiveTask(taskDef.title)}
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

        {/* Raw JSON tab — full width code block with copy */}
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
                      {report.tasks.map((t: MissionReport["tasks"][number], i: number) => (
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
