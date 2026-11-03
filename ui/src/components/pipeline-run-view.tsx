// Read-only view of a pipeline run: the pipeline graph colored by each step's
// state, plus details of the selected step and the shared context.
//
// Live runs read the state from the agent process (updated over SSE); finished
// runs read the last activity snapshot of the task's run log.

import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Background, Controls, ReactFlow, ReactFlowProvider, type Node } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { formatDistanceToNow } from "date-fns";
import { CheckCircle2, ExternalLink, Loader2, Workflow, XCircle } from "lucide-react";
import { useTaskActivity } from "@polpo-ai/react";
import type { AgentProcess, PipelineRunState, PipelineStepState } from "@polpo-ai/react";
import { Badge } from "@/components/ui/badge";
import { JsonBlock } from "@/components/json-block";
import { cn } from "@/lib/utils";
import { getAt, pathKey, stepKind } from "@/lib/pipeline-edit";
import { layoutPipeline, type PipelineNodeData } from "@/lib/pipeline-layout";
import { KIND_META, STATUS_META } from "@/lib/pipeline-meta";
import {
  PipelineBranchNode,
  PipelineEdge,
  PipelineEmptyNode,
  PipelineMergeNode,
  PipelineStepNode,
  PipelineTerminalNode,
} from "@/components/pipeline-graph";

const nodeTypes = {
  pStep: PipelineStepNode,
  pSwitch: PipelineBranchNode,
  pParallel: PipelineBranchNode,
  pMerge: PipelineMergeNode,
  pEmpty: PipelineEmptyNode,
  pTerminal: PipelineTerminalNode,
};

const edgeTypes = { pipeline: PipelineEdge };

const RUN_STATUS = {
  running: { label: "Running", icon: Loader2, className: "text-blue-400", spin: true },
  completed: { label: "Completed", icon: CheckCircle2, className: "text-emerald-500", spin: false },
  failed: { label: "Failed", icon: XCircle, className: "text-red-500", spin: false },
} as const;

/** Latest pipeline state of a task: the live process first, then the run log. */
export function TaskPipelineTab({ taskId, process }: { taskId: string; process?: AgentProcess }) {
  const live = process?.activity.pipeline;
  const { entries, isLoading } = useTaskActivity(live ? null : taskId);
  const fromLog = useMemo(() => {
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      const state = e.event === "activity" ? (e.data as { pipeline?: PipelineRunState } | undefined)?.pipeline : undefined;
      if (state) return state;
    }
    return undefined;
  }, [entries]);

  const state = live ?? fromLog;
  if (!state) {
    return (
      <div className="flex h-full min-h-[320px] flex-col items-center justify-center gap-2 rounded-lg border border-border/40 text-muted-foreground">
        {isLoading ? <Loader2 className="h-5 w-5 animate-spin" /> : <Workflow className="h-8 w-8 opacity-40" />}
        <p className="text-sm">{isLoading ? "Loading pipeline run…" : "The pipeline has not started for this task yet."}</p>
      </div>
    );
  }
  return (
    <ReactFlowProvider>
      <PipelineRunView state={state} live={!!live} />
    </ReactFlowProvider>
  );
}

export function PipelineRunView({ state, live }: { state: PipelineRunState; live: boolean }) {
  const [selected, setSelected] = useState<string | null>(null);
  const run = RUN_STATUS[state.status];

  const { nodes, edges } = useMemo(() => {
    const layout = layoutPipeline(state.pipeline);
    const nodes = layout.nodes.map((n): Node<PipelineNodeData> => {
      const data = n.data as PipelineNodeData;
      if (n.id === "end" && state.status !== "running") {
        return { ...n, data: { ...data, run: { kind: "loop", status: state.status === "completed" ? "done" : "failed" } } };
      }
      if (!data.path || !n.id.startsWith("step:")) {
        return { ...n, data: { ...data, dimmed: n.id.startsWith("empty:") } };
      }
      const key = pathKey(data.path);
      const stepRun = state.steps[key];
      return { ...n, selected: key === selected, data: { ...data, run: stepRun, dimmed: !stepRun } };
    });
    return { nodes, edges: layout.edges };
  }, [state, selected]);

  const active = Object.entries(state.steps).filter(([, s]) => s.status === "running" || s.status === "waiting");
  const selectedStep = selected ? state.steps[selected] : undefined;
  const selectedDef = selected ? getAt(state.pipeline, selected.split(".").map((s) => (/^\d+$/.test(s) ? Number(s) : s))) : undefined;

  return (
    <div className="flex h-full min-h-[480px] flex-col overflow-hidden rounded-lg border border-border/40">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border/40 px-3 py-2">
        <run.icon className={cn("h-4 w-4", run.className, run.spin && "animate-spin")} />
        <span className={cn("text-xs font-semibold", run.className)}>{run.label}</span>
        <span className="text-[11px] text-muted-foreground">
          started {formatDistanceToNow(new Date(state.startedAt), { addSuffix: true })}
          {state.endedAt && ` · finished ${formatDistanceToNow(new Date(state.endedAt), { addSuffix: true })}`}
        </span>
        {live && <Badge variant="outline" className="text-[10px] text-blue-400">live</Badge>}
        {active.length > 0 && (
          <span className="ml-auto truncate text-[11px] text-muted-foreground">
            Now: {active.map(([, s]) => `${KIND_META[s.kind].label}${s.name ? ` "${s.name}"` : ""}`).join(", ")}
          </span>
        )}
      </div>
      {state.error && (
        <div className="shrink-0 border-b border-red-500/30 bg-red-500/5 px-3 py-2 text-[11px] text-red-500">{state.error}</div>
      )}

      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            nodesDraggable={false}
            nodesConnectable={false}
            deleteKeyCode={null}
            onNodeClick={(_, node) => {
              const path = (node.data as PipelineNodeData).path;
              if (node.id.startsWith("step:") && path) setSelected(pathKey(path));
            }}
            onPaneClick={() => setSelected(null)}
            fitView
            fitViewOptions={{ padding: 0.15, maxZoom: 1 }}
            minZoom={0.2}
            maxZoom={1.5}
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={20} size={1} className="!bg-background" />
            <Controls showInteractive={false} className="!bg-card !border-border !shadow-md [&>button]:!bg-card [&>button]:!border-border [&>button]:!text-foreground [&>button:hover]:!bg-accent" />
          </ReactFlow>
        </div>

        <aside className="flex h-full w-[min(340px,45%)] shrink-0 flex-col overflow-y-auto border-l border-border bg-background p-3">
          {selected && selectedDef ? (
            <StepDetails step={selectedStep} title={describeDef(selectedDef)} />
          ) : (
            <p className="mb-3 text-[11px] text-muted-foreground">Select a step to see its state.</p>
          )}
          <div className="mt-4 space-y-1.5">
            <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Shared context</span>
            {state.contextTruncated ? (
              <p className="text-[11px] text-muted-foreground">Too large to show live; the full context is attached to the task as the &quot;Pipeline context&quot; outcome.</p>
            ) : (
              <JsonBlock
                data={state.context ?? {}}
                className="max-h-[50vh] overflow-auto whitespace-pre-wrap rounded-lg border border-border/20 bg-muted/30 p-2 font-mono text-[10px] leading-relaxed"
              />
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

function describeDef(def: unknown): string {
  const step = def as Parameters<typeof stepKind>[0];
  const kind = stepKind(step);
  const name = "loop" in step ? step.loop : "human" in step ? step.human : undefined;
  return `${KIND_META[kind].label}${name ? ` "${name}"` : ""}`;
}

function StepDetails({ step, title }: { step?: PipelineStepState; title: string }) {
  if (!step) {
    return (
      <div className="space-y-1">
        <p className="text-xs font-semibold">{title}</p>
        <p className="text-[11px] text-muted-foreground">Not reached in this run.</p>
      </div>
    );
  }
  const status = STATUS_META[step.status];
  return (
    <div className="space-y-2">
      <p className="text-xs font-semibold">{title}</p>
      <p className={cn("text-[11px] font-medium", status.text)}>
        {status.label}{step.attempt ? ` · attempt ${step.attempt}` : ""}
      </p>
      {step.startedAt && (
        <p className="text-[11px] text-muted-foreground">
          Started {formatDistanceToNow(new Date(step.startedAt), { addSuffix: true })}
          {step.endedAt && `, ended ${formatDistanceToNow(new Date(step.endedAt), { addSuffix: true })}`}
        </p>
      )}
      {step.feedback && (
        <p className="rounded-md border border-amber-500/40 bg-amber-500/5 p-2 text-[11px] text-amber-600 dark:text-amber-400">
          Retried because: {step.feedback}
        </p>
      )}
      {step.error && (
        <p className="rounded-md border border-red-500/40 bg-red-500/5 p-2 text-[11px] text-red-500">{step.error}</p>
      )}
      {step.status === "waiting" && (
        <Link to="/approvals" className="inline-flex items-center gap-1 text-[11px] font-medium text-primary hover:underline">
          Approve or reject on the Approvals page <ExternalLink className="h-3 w-3" />
        </Link>
      )}
    </div>
  );
}
