// React Flow node and edge components for pipeline graphs (see
// lib/pipeline-layout.ts). Used by the editor on the agent page and by the
// run view on the task page; in the run view nodes also carry the step's
// live state (`data.run`), and nodes that never ran are dimmed (`data.dimmed`).

import {
  BaseEdge,
  EdgeLabelRenderer,
  Handle,
  Position,
  getSmoothStepPath,
  type EdgeProps,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { AlertTriangle, Plus } from "lucide-react";
import type { PipelineStep, PipelineStepState } from "@polpo-ai/react";
import { cn } from "@/lib/utils";
import { stepKind } from "@/lib/pipeline-edit";
import type { InsertSlot, PipelineEdgeData, PipelineNodeData } from "@/lib/pipeline-layout";
import { KIND_META, STATUS_META } from "@/lib/pipeline-meta";

type GraphNodeData = PipelineNodeData & { run?: PipelineStepState; dimmed?: boolean };

const handleClass = "!bg-muted-foreground/50 !border-none !w-1.5 !h-1.5";

function nodeFrame(selected: boolean | undefined, data: GraphNodeData): string {
  const status = data.run ? STATUS_META[data.run.status] : undefined;
  if (selected) return "border-primary ring-2 ring-primary/30";
  if (status) return cn(status.border, status.bg, data.run!.status === "running" && "animate-pulse");
  if ((data.problems?.length ?? 0) > 0) return "border-amber-500/70";
  return "border-border";
}

function RunBadge({ run }: { run: PipelineStepState }) {
  const status = STATUS_META[run.status];
  return (
    <span className={cn("ml-auto shrink-0 text-[9px] font-medium", status.text)}>
      {status.label}{run.attempt && run.attempt > 1 ? ` · try ${run.attempt}` : ""}
    </span>
  );
}

export function PipelineStepNode({ data, selected }: NodeProps<Node<GraphNodeData>>) {
  const step = data.step!;
  const kind = stepKind(step);
  const meta = KIND_META[kind];
  const title = "loop" in step ? (step.loop || "(no loop)") : "human" in step ? (step.human || "(unnamed)") : meta.label;
  const hasProblems = !data.run && (data.problems?.length ?? 0) > 0;
  return (
    <>
      <Handle type="target" position={Position.Top} isConnectable={false} className={handleClass} />
      <div
        className={cn(
          "flex h-full w-full flex-col justify-center gap-1 rounded-xl border-2 bg-card/90 px-3 shadow-sm",
          nodeFrame(selected, data),
          data.dimmed && "opacity-40",
        )}
        title={data.run?.error ?? (hasProblems ? data.problems!.join("\n") : undefined)}
      >
        <div className="flex items-center gap-1.5">
          <meta.icon className={cn("h-3.5 w-3.5 shrink-0", meta.color)} />
          <span className="text-[9px] font-medium uppercase tracking-wider text-muted-foreground">{meta.label}</span>
          {data.run ? <RunBadge run={data.run} /> : hasProblems && <AlertTriangle className="ml-auto h-3 w-3 text-amber-500" />}
        </div>
        <div className="truncate text-xs font-semibold">{title}</div>
        {data.run?.error
          ? <div className="truncate text-[9px] text-red-500">{data.run.error}</div>
          : step.when && <div className="truncate font-mono text-[9px] text-muted-foreground">when {step.when}</div>}
      </div>
      <Handle type="source" position={Position.Bottom} isConnectable={false} className={handleClass} />
    </>
  );
}

export function PipelineBranchNode({ data, selected }: NodeProps<Node<GraphNodeData>>) {
  const step = data.step!;
  const kind = stepKind(step);
  const meta = KIND_META[kind];
  const hasProblems = !data.run && (data.problems?.length ?? 0) > 0;
  const detail = "parallel" in step
    ? `join: ${step.join ?? "all"}`
    : `${(step as Extract<PipelineStep, { switch: unknown }>).switch.cases.length} case(s)`;
  return (
    <>
      <Handle type="target" position={Position.Top} isConnectable={false} className={handleClass} />
      <div
        className={cn(
          "flex h-full w-full items-center gap-2 border-2 border-dashed bg-card/80 px-3",
          kind === "switch" ? "rounded-[20px]" : "rounded-md",
          nodeFrame(selected, data),
          data.dimmed && "opacity-40",
        )}
        title={data.run?.error ?? (hasProblems ? data.problems!.join("\n") : undefined)}
      >
        <meta.icon className={cn("h-4 w-4 shrink-0", meta.color)} />
        <div className="min-w-0">
          <div className="text-xs font-semibold">{meta.label}</div>
          <div className="truncate text-[9px] text-muted-foreground">{detail}{step.when ? ` · when ${step.when}` : ""}</div>
        </div>
        {data.run ? <RunBadge run={data.run} /> : hasProblems && <AlertTriangle className="ml-auto h-3 w-3 shrink-0 text-amber-500" />}
      </div>
      <Handle type="source" position={Position.Bottom} isConnectable={false} className={handleClass} />
    </>
  );
}

export function PipelineMergeNode() {
  return (
    <>
      <Handle type="target" position={Position.Top} isConnectable={false} className="!opacity-0" />
      <div className="h-full w-full rounded-full border-2 border-muted-foreground/40 bg-background" />
      <Handle type="source" position={Position.Bottom} isConnectable={false} className="!opacity-0" />
    </>
  );
}

export function PipelineEmptyNode({ data }: NodeProps<Node<GraphNodeData>>) {
  return (
    <>
      <Handle type="target" position={Position.Top} isConnectable={false} className="!opacity-0" />
      <div className={cn("flex h-full w-full items-center justify-center rounded-md border border-dashed border-muted-foreground/40 text-[10px] text-muted-foreground", data.dimmed && "opacity-40")}>
        {data.label}
      </div>
      <Handle type="source" position={Position.Bottom} isConnectable={false} className="!opacity-0" />
    </>
  );
}

export function PipelineTerminalNode({ data }: NodeProps<Node<GraphNodeData>>) {
  return (
    <>
      <Handle type="target" position={Position.Top} isConnectable={false} className="!opacity-0" />
      <div className={cn("flex h-full w-full items-center justify-center rounded-full bg-muted px-3 text-[10px] font-medium text-muted-foreground", data.run && STATUS_META[data.run.status].text)}>
        {data.label}
      </div>
      <Handle type="source" position={Position.Bottom} isConnectable={false} className="!opacity-0" />
    </>
  );
}

/** Edge with an optional case label and, when `data.onInsert` is set, a "+" insertion button. */
export function PipelineEdge(props: EdgeProps & { data?: PipelineEdgeData }) {
  const { sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, style, data } = props;
  const [path, labelX, labelY] = getSmoothStepPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, borderRadius: 10 });
  const onInsert = (data as { onInsert?: (slot: InsertSlot) => void } | undefined)?.onInsert;
  const slot = data?.slot;
  return (
    <>
      <BaseEdge path={path} markerEnd={markerEnd} style={style} />
      <EdgeLabelRenderer>
        {data?.label && (
          <div
            className="nodrag nopan pointer-events-none absolute max-w-[180px] truncate rounded bg-background px-1.5 py-0.5 font-mono text-[9px] text-violet-500 shadow-sm"
            style={{ transform: `translate(-50%, -100%) translate(${targetX}px, ${targetY - 8}px)` }}
          >
            {data.label}
          </div>
        )}
        {slot && onInsert && (
          <button
            type="button"
            className="nodrag nopan pointer-events-auto absolute flex h-5 w-5 items-center justify-center rounded-full border border-border bg-background text-muted-foreground shadow-sm transition-colors hover:border-primary hover:text-primary"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
            onClick={(e) => { e.stopPropagation(); onInsert(slot); }}
            title="Add a step here"
            aria-label="Add a step here"
          >
            <Plus className="h-3 w-3" />
          </button>
        )}
      </EdgeLabelRenderer>
    </>
  );
}
