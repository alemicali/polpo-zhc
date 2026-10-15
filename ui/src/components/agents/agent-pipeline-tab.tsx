// Visual editor for an agent's deterministic pipeline (docs/loops.md):
// loops, human approvals, switch and parallel steps, laid out top-down.
// Steps are inserted with the "+" buttons on the edges and edited in the
// side panel; loops (the reusable LLM sessions steps refer to) are managed
// in the same panel when no step is selected.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Background, Controls, ReactFlow, ReactFlowProvider, useReactFlow } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Bot,
  Loader2,
  Plus,
  Repeat,
  RotateCcw,
  Save,
  Trash2,
  Workflow,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { useAgents } from "@polpo-ai/react";
import type { LoopConfig, Pipeline, PipelineStep } from "@polpo-ai/react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CommitInput, CommitTextarea, Field } from "@/components/editor-fields";
import { useAgentDetail } from "@/components/agents/agent-detail-context";
import { cn } from "@/lib/utils";
import {
  addCase,
  deleteLoop,
  getAt,
  insertStep,
  moveStep,
  newStep,
  pathKey,
  removeCase,
  removeStep,
  renameLoop,
  setDefaultBranch,
  stepKind,
  uniqueLoopName,
  updateCaseWhen,
  updateStep,
  validatePipeline,
  loopUsages,
  type Path,
  type StepKind,
} from "@/lib/pipeline-edit";
import { layoutPipeline, type InsertSlot, type PipelineNodeData } from "@/lib/pipeline-layout";
import { KIND_META } from "@/lib/pipeline-meta";
import {
  PipelineBranchNode,
  PipelineEdge,
  PipelineEmptyNode,
  PipelineMergeNode,
  PipelineStepNode,
  PipelineTerminalNode,
} from "@/components/pipeline-graph";

type Selection =
  | { type: "step"; path: Path }
  | { type: "slot"; slot: InsertSlot }
  | null;

const selectClass = "h-8 w-full rounded-md border border-input bg-background px-2 text-xs";

const nodeTypes = {
  pStep: PipelineStepNode,
  pSwitch: PipelineBranchNode,
  pParallel: PipelineBranchNode,
  pMerge: PipelineMergeNode,
  pEmpty: PipelineEmptyNode,
  pTerminal: PipelineTerminalNode,
};

const edgeTypes = { pipeline: PipelineEdge };

// ── Tab ──

export function AgentPipelineTab() {
  const { state: { agent }, actions: { refetch } } = useAgentDetail();
  return (
    <ReactFlowProvider>
      <PipelineEditor
        key={agent.name}
        agentName={agent.name}
        savedLoops={agent.loops ?? {}}
        savedPipeline={agent.pipeline}
        onSaved={refetch}
      />
    </ReactFlowProvider>
  );
}

function PipelineEditor({
  agentName,
  savedLoops,
  savedPipeline,
  onSaved,
}: {
  agentName: string;
  savedLoops: Record<string, LoopConfig>;
  savedPipeline: Pipeline | undefined;
  onSaved: () => Promise<void>;
}) {
  const { updateAgent } = useAgents();
  const { fitView } = useReactFlow();
  const [baseline, setBaseline] = useState({ loops: savedLoops, pipeline: savedPipeline });
  const [loops, setLoops] = useState<Record<string, LoopConfig>>(savedLoops);
  const [pipeline, setPipeline] = useState<Pipeline | undefined>(savedPipeline);
  const [selection, setSelection] = useState<Selection>(null);
  const [saving, setSaving] = useState(false);

  const dirty = JSON.stringify({ loops, pipeline }) !== JSON.stringify(baseline);
  const problems = useMemo(() => (pipeline ? validatePipeline(pipeline, loops) : []), [pipeline, loops]);
  const problemsByPath = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const p of problems) {
      const key = pathKey(p.path);
      map.set(key, [...(map.get(key) ?? []), p.message]);
    }
    return map;
  }, [problems]);

  const insertAt = useCallback((slot: InsertSlot) => setSelection({ type: "slot", slot }), []);

  const { nodes, edges } = useMemo(() => {
    if (!pipeline) return { nodes: [], edges: [] };
    const layout = layoutPipeline(pipeline, problemsByPath);
    const selectedKey = selection?.type === "step" ? `step:${pathKey(selection.path)}` : undefined;
    return {
      nodes: layout.nodes.map((n) => ({ ...n, selected: n.id === selectedKey, draggable: false, connectable: false })),
      edges: layout.edges.map((e) => ({ ...e, data: { ...e.data, onInsert: insertAt } })),
    };
  }, [pipeline, problemsByPath, selection, insertAt]);

  // Re-fit when the shape of the graph changes.
  const shape = nodes.map((n) => n.id).join("|");
  useEffect(() => {
    const t = setTimeout(() => fitView({ padding: 0.15, maxZoom: 1, duration: 150 }), 30);
    return () => clearTimeout(t);
  }, [shape, fitView]);

  const editPipeline = (next: Pipeline) => setPipeline(next);

  const insertStepAt = (slot: InsertSlot, kind: StepKind) => {
    if (!pipeline) return;
    let nextLoops = loops;
    if (kind === "loop" && Object.keys(loops).length === 0) {
      // A loop step needs a loop: create the first one on the fly.
      nextLoops = { [uniqueLoopName(loops, "main")]: {} };
      setLoops(nextLoops);
    }
    editPipeline(insertStep(pipeline, slot.listPath, slot.index, newStep(kind, nextLoops, pipeline)));
    setSelection({ type: "step", path: [...slot.listPath, slot.index] });
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await updateAgent(agentName, { loops, pipeline: pipeline ?? null });
      setBaseline({ loops, pipeline });
      toast.success(pipeline ? "Pipeline saved" : "Pipeline removed");
      await onSaved();
    } catch (e) {
      toast.error(`Save failed: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    setLoops(baseline.loops);
    setPipeline(baseline.pipeline);
    setSelection(null);
  };

  const toolbar = (
    <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border/40 px-3 py-2">
      <Workflow className="h-4 w-4 text-primary" />
      <span className="text-xs font-semibold">Pipeline</span>
      <span className="hidden text-[11px] text-muted-foreground md:inline">
        Tasks assigned to this agent run these steps in order.
      </span>
      <div className="ml-auto flex flex-wrap items-center gap-1.5">
        {dirty && <Badge variant="outline" className="text-[10px] text-amber-500">Unsaved changes</Badge>}
        {problems.length > 0 && (
          <Badge variant="outline" className="gap-1 text-[10px] text-amber-500" title={problems.map((p) => p.message).join("\n")}>
            <AlertTriangle className="h-3 w-3" />
            {problems.length} problem{problems.length !== 1 ? "s" : ""}
          </Badge>
        )}
        <Button size="sm" variant="ghost" className="h-8 gap-1.5 text-[11px]" disabled={!dirty || saving} onClick={handleReset}>
          <RotateCcw className="h-3.5 w-3.5" /> Reset
        </Button>
        <Button
          size="sm"
          className="h-8 gap-1.5 text-[11px]"
          disabled={!dirty || saving || problems.length > 0}
          title={problems.length > 0 ? "Fix the problems before saving" : undefined}
          onClick={handleSave}
        >
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
          Save
        </Button>
      </div>
    </div>
  );

  if (!pipeline) {
    return (
      <div className="flex h-full min-h-[480px] flex-col overflow-hidden rounded-lg border border-border/40">
        {toolbar}
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
          <Workflow className="h-10 w-10 text-muted-foreground/40" />
          <div className="max-w-md space-y-1">
            <p className="text-sm font-medium">This agent runs each task as a single session</p>
            <p className="text-xs text-muted-foreground">
              A pipeline splits the work into deterministic steps: loops with their own prompt, tools and model,
              human approvals, conditional branches and parallel work.
            </p>
          </div>
          <Button size="sm" className="gap-1.5" onClick={() => { setPipeline({ steps: [] }); setSelection(null); }}>
            <Plus className="h-3.5 w-3.5" /> Create pipeline
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-[480px] flex-col overflow-hidden rounded-lg border border-border/40">
      {toolbar}
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable
            deleteKeyCode={null}
            onNodeClick={(_, node) => {
              const path = (node.data as PipelineNodeData).path;
              if (node.id.startsWith("step:") && path) setSelection({ type: "step", path });
            }}
            onPaneClick={() => setSelection(null)}
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

        <aside className="flex h-full w-[min(340px,45%)] shrink-0 flex-col overflow-hidden border-l border-border bg-background">
          {selection?.type === "slot" && (
            <AddStepPanel
              onPick={(kind) => insertStepAt(selection.slot, kind)}
              onClose={() => setSelection(null)}
            />
          )}
          {selection?.type === "step" && getAt(pipeline, selection.path) !== undefined && (
            <StepPanel
              key={pathKey(selection.path)}
              pipeline={pipeline}
              loops={loops}
              path={selection.path}
              problems={problemsByPath.get(pathKey(selection.path)) ?? []}
              onPipeline={editPipeline}
              onLoops={setLoops}
              onSelect={setSelection}
            />
          )}
          {(selection === null || (selection.type === "step" && getAt(pipeline, selection.path) === undefined)) && (
            <SettingsPanel
              pipeline={pipeline}
              loops={loops}
              globalProblems={problems.filter((p) => p.path.length === 0).map((p) => p.message)}
              onPipeline={(p) => setPipeline(p)}
              onLoops={setLoops}
            />
          )}
        </aside>
      </div>
    </div>
  );
}

// ── Side panels ──

function PanelHeader({ title, onClose, children }: { title: string; onClose?: () => void; children?: React.ReactNode }) {
  return (
    <div className="flex shrink-0 items-center gap-1 border-b border-border px-3 py-2">
      <span className="text-xs font-semibold">{title}</span>
      <div className="ml-auto flex items-center gap-0.5">
        {children}
        {onClose && (
          <Button size="sm" variant="ghost" className="h-7 px-2" onClick={onClose} title="Close">
            <X className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
    </div>
  );
}

function AddStepPanel({ onPick, onClose }: { onPick: (kind: StepKind) => void; onClose: () => void }) {
  return (
    <>
      <PanelHeader title="Add a step" onClose={onClose} />
      <div className="space-y-2 overflow-y-auto p-3">
        {(Object.keys(KIND_META) as StepKind[]).map((kind) => {
          const meta = KIND_META[kind];
          return (
            <button
              key={kind}
              type="button"
              onClick={() => onPick(kind)}
              className="flex w-full items-start gap-3 rounded-lg border border-border/60 bg-card/60 p-3 text-left transition-colors hover:border-primary/60 hover:bg-primary/5"
            >
              <meta.icon className={cn("mt-0.5 h-4 w-4 shrink-0", meta.color)} />
              <span>
                <span className="block text-xs font-semibold">{meta.label}</span>
                <span className="block text-[11px] text-muted-foreground">{meta.description}</span>
              </span>
            </button>
          );
        })}
      </div>
    </>
  );
}

function ProblemList({ problems }: { problems: string[] }) {
  if (problems.length === 0) return null;
  return (
    <div className="space-y-1 rounded-md border border-amber-500/40 bg-amber-500/5 p-2">
      {problems.map((p) => (
        <div key={p} className="flex items-start gap-1.5 text-[11px] text-amber-600 dark:text-amber-400">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
          {p}
        </div>
      ))}
    </div>
  );
}

function StepPanel({
  pipeline,
  loops,
  path,
  problems,
  onPipeline,
  onLoops,
  onSelect,
}: {
  pipeline: Pipeline;
  loops: Record<string, LoopConfig>;
  path: Path;
  problems: string[];
  onPipeline: (p: Pipeline) => void;
  onLoops: (l: Record<string, LoopConfig>) => void;
  onSelect: (s: Selection) => void;
}) {
  const step = getAt<PipelineStep>(pipeline, path)!;
  const kind = stepKind(step);
  const meta = KIND_META[kind];
  const index = path[path.length - 1] as number;
  const siblings = getAt<PipelineStep[]>(pipeline, path.slice(0, -1)) ?? [];
  const update = (patch: Record<string, unknown>) => onPipeline(updateStep(pipeline, path, patch));

  const move = (delta: number) => {
    onPipeline(moveStep(pipeline, path, delta));
    onSelect({ type: "step", path: [...path.slice(0, -1), index + delta] });
  };

  return (
    <>
      <PanelHeader title={meta.label} onClose={() => onSelect(null)}>
        <Button size="sm" variant="ghost" className="h-7 px-2" disabled={index === 0} onClick={() => move(-1)} title="Move up">
          <ArrowUp className="h-3.5 w-3.5" />
        </Button>
        <Button size="sm" variant="ghost" className="h-7 px-2" disabled={index >= siblings.length - 1} onClick={() => move(1)} title="Move down">
          <ArrowDown className="h-3.5 w-3.5" />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 px-2 text-red-500"
          onClick={() => { onPipeline(removeStep(pipeline, path)); onSelect(null); }}
          title="Delete step"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </PanelHeader>

      <div className="flex-1 space-y-3 overflow-y-auto p-3">
        <ProblemList problems={problems} />

        {"loop" in step && (
          <>
            <Field label="Loop">
              <select
                className={selectClass}
                value={step.loop}
                onChange={(e) => {
                  if (e.target.value === "__new") {
                    const name = uniqueLoopName(loops);
                    onLoops({ ...loops, [name]: {} });
                    update({ loop: name });
                  } else {
                    update({ loop: e.target.value });
                  }
                }}
              >
                {!step.loop && <option value="">Choose a loop…</option>}
                {Object.keys(loops).map((name) => <option key={name} value={name}>{name}</option>)}
                {step.loop && !(step.loop in loops) && <option value={step.loop}>{step.loop} (missing)</option>}
                <option value="__new">+ New loop</option>
              </select>
            </Field>
            {step.loop in loops && (
              <div className="space-y-3 rounded-lg border border-border/60 p-3">
                <p className="text-[10px] text-muted-foreground">
                  Loop definition — shared by every step that uses &quot;{step.loop}&quot;.
                </p>
                <LoopFields
                  name={step.loop}
                  loop={loops[step.loop]}
                  onChange={(loop) => onLoops({ ...loops, [step.loop]: loop })}
                  onRename={(to) => {
                    const r = renameLoop(loops, pipeline, step.loop, to);
                    if (r.error) { toast.error(r.error); return; }
                    onLoops(r.loops!);
                    onPipeline(r.pipeline!);
                  }}
                />
              </div>
            )}
          </>
        )}

        {"human" in step && (
          <>
            <Field label="Name">
              <CommitInput className="h-8 text-xs" value={step.human} onCommit={(v) => update({ human: v.trim() })} />
            </Field>
            <Field label="Notify channels (comma separated)">
              <CommitInput
                className="h-8 text-xs"
                placeholder="ops, telegram"
                value={(step.notify ?? []).join(", ")}
                onCommit={(v) => {
                  const list = v.split(",").map((s) => s.trim()).filter(Boolean);
                  update({ notify: list.length > 0 ? list : undefined });
                }}
              />
            </Field>
            <p className="text-[11px] text-muted-foreground">
              Approving continues the pipeline; rejecting fails it with the rejection note.
              The decision is available to later steps as <code className="text-[10px]">context.human.{step.human || "name"}</code>.
            </p>
          </>
        )}

        {"parallel" in step && (
          <>
            <Field label="Join">
              <div className="flex gap-1.5">
                <select
                  className={selectClass}
                  value={typeof step.join === "number" ? "n" : (step.join ?? "all")}
                  onChange={(e) => update({ join: e.target.value === "n" ? Math.max(1, Math.min(2, step.parallel.length)) : e.target.value })}
                >
                  <option value="all">All branches must succeed</option>
                  <option value="any">First success wins</option>
                  <option value="n">A number of successes…</option>
                </select>
                {typeof step.join === "number" && (
                  <CommitInput
                    className="h-8 w-16 text-xs"
                    type="number"
                    min={1}
                    value={String(step.join)}
                    onCommit={(v) => update({ join: Math.max(1, Math.floor(Number(v) || 1)) })}
                  />
                )}
              </div>
            </Field>
            <Field label={`Branches (${step.parallel.length})`}>
              <div className="grid grid-cols-2 gap-1.5">
                {(Object.keys(KIND_META) as StepKind[]).map((k) => {
                  const m = KIND_META[k];
                  return (
                    <Button
                      key={k}
                      size="sm"
                      variant="outline"
                      className="h-8 justify-start gap-1.5 text-[11px]"
                      onClick={() => onPipeline(insertStep(pipeline, [...path, "parallel"], step.parallel.length, newStep(k, loops, pipeline)))}
                    >
                      <Plus className="h-3 w-3" /><m.icon className={cn("h-3.5 w-3.5", m.color)} /> {m.label}
                    </Button>
                  );
                })}
              </div>
            </Field>
            <p className="text-[11px] text-muted-foreground">Each branch is a single step; use a switch or another parallel step for more structure.</p>
          </>
        )}

        {"switch" in step && (
          <>
            <Field label="Cases (first match wins)">
              <div className="space-y-2">
                {step.switch.cases.map((c, i) => (
                  <div key={i} className="flex items-center gap-1.5">
                    <span className="w-5 shrink-0 text-[10px] text-muted-foreground">{i + 1}.</span>
                    <CommitInput
                      className="h-8 font-mono text-[11px]"
                      placeholder="context.ticket.category == 'billing'"
                      value={c.when}
                      onCommit={(v) => onPipeline(updateCaseWhen(pipeline, path, i, v.trim()))}
                    />
                    <Button size="sm" variant="ghost" className="h-8 px-2 text-red-500" onClick={() => onPipeline(removeCase(pipeline, path, i))} title="Remove case">
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))}
                <Button size="sm" variant="outline" className="h-8 gap-1.5 text-[11px]" onClick={() => onPipeline(addCase(pipeline, path))}>
                  <Plus className="h-3 w-3" /> Add case
                </Button>
              </div>
            </Field>
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={!!step.switch.default}
                onChange={(e) => onPipeline(setDefaultBranch(pipeline, path, e.target.checked))}
              />
              Default branch when no case matches
            </label>
            <p className="text-[11px] text-muted-foreground">Add steps to a case with the + on its arrow in the graph.</p>
          </>
        )}

        <Field label="Run only when (optional)">
          <CommitInput
            className="h-8 font-mono text-[11px]"
            placeholder="context.priority > 2"
            value={step.when ?? ""}
            onCommit={(v) => update({ when: v.trim() || undefined })}
          />
        </Field>
        <ExpressionHelp />
      </div>
    </>
  );
}

function ExpressionHelp() {
  return (
    <p className="text-[10px] leading-relaxed text-muted-foreground">
      Conditions read the shared <code>context</code>: <code>context.a.b</code>, <code>==</code>, <code>!=</code>,{" "}
      <code>&lt;</code>, <code>&gt;</code>, <code>&amp;&amp;</code>, <code>||</code>, <code>!</code>, strings in quotes.
      A missing value is <code>null</code>.
    </p>
  );
}

function LoopFields({
  name,
  loop,
  onChange,
  onRename,
}: {
  name: string;
  loop: LoopConfig;
  onChange: (loop: LoopConfig) => void;
  onRename: (to: string) => void;
}) {
  const set = (patch: Partial<LoopConfig>) => {
    const next: Record<string, unknown> = { ...loop, ...patch };
    for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
    onChange(next as LoopConfig);
  };
  const schemaText = loop.output?.schema !== undefined ? JSON.stringify(loop.output.schema, null, 2) : "";
  const [schemaError, setSchemaError] = useState<string | null>(null);

  return (
    <>
      <Field label="Loop name">
        <CommitInput className="h-8 text-xs" value={name} onCommit={onRename} />
      </Field>
      <Field label="Instructions for this loop">
        <CommitTextarea
          className="min-h-[90px] text-xs"
          placeholder="Classify the ticket and write the category to context.ticket.category."
          value={loop.systemPrompt ?? ""}
          onCommit={(v) => set({ systemPrompt: v.trim() || undefined })}
        />
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Model (optional)">
          <CommitInput className="h-8 text-xs" placeholder="agent's model" value={loop.model ?? ""} onCommit={(v) => set({ model: v.trim() || undefined })} />
        </Field>
        <Field label="Max turns">
          <CommitInput
            className="h-8 text-xs"
            type="number"
            min={1}
            placeholder="agent's"
            value={loop.maxTurns != null ? String(loop.maxTurns) : ""}
            onCommit={(v) => set({ maxTurns: v === "" ? undefined : Math.floor(Number(v)) })}
          />
        </Field>
      </div>
      <Field label="Tools (comma separated, optional)">
        <CommitInput
          className="h-8 text-xs"
          placeholder="agent's tools, e.g. read, search_*"
          value={(loop.tools ?? []).join(", ")}
          onCommit={(v) => {
            const list = v.split(",").map((s) => s.trim()).filter(Boolean);
            set({ tools: list.length > 0 ? list : undefined });
          }}
        />
      </Field>
      <Field label="Done when (optional)">
        <CommitInput
          className="h-8 font-mono text-[11px]"
          placeholder="context.ticket.category != null"
          value={loop.stopWhen?.expression ?? ""}
          onCommit={(v) => set({ stopWhen: v.trim() ? { expression: v.trim() } : undefined })}
        />
      </Field>
      <Field label="Output JSON schema (optional)">
        <CommitTextarea
          className="min-h-[80px] font-mono text-[11px]"
          placeholder='{ "type": "object", "required": ["category"] }'
          value={schemaText}
          onCommit={(v) => {
            if (!v.trim()) { setSchemaError(null); set({ output: undefined }); return; }
            try {
              const schema = JSON.parse(v);
              setSchemaError(null);
              set({ output: { schema } });
            } catch (e) {
              setSchemaError((e as Error).message);
            }
          }}
        />
        {schemaError && <span className="text-[10px] text-red-500">{schemaError}</span>}
      </Field>
      <p className="text-[10px] text-muted-foreground">
        If the output does not match the schema, or the done condition is false, the loop runs again (3 attempts at most).
      </p>
    </>
  );
}

function SettingsPanel({
  pipeline,
  loops,
  globalProblems,
  onPipeline,
  onLoops,
}: {
  pipeline: Pipeline;
  loops: Record<string, LoopConfig>;
  globalProblems: string[];
  onPipeline: (p: Pipeline | undefined) => void;
  onLoops: (l: Record<string, LoopConfig>) => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <>
      <PanelHeader title="Pipeline settings" />
      <div className="flex-1 space-y-4 overflow-y-auto p-3">
        <ProblemList problems={globalProblems} />
        <Field label="Top-level steps run">
          <select
            className={selectClass}
            value={pipeline.mode ?? "sequential"}
            onChange={(e) => onPipeline({ ...pipeline, mode: e.target.value === "parallel" ? "parallel" : undefined })}
          >
            <option value="sequential">One after another</option>
            <option value="parallel">All at the same time</option>
          </select>
        </Field>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Loops</span>
            <Button
              size="sm"
              variant="outline"
              className="h-7 gap-1 text-[11px]"
              onClick={() => { const name = uniqueLoopName(loops); onLoops({ ...loops, [name]: {} }); setOpen(name); }}
            >
              <Plus className="h-3 w-3" /> Loop
            </Button>
          </div>
          {Object.keys(loops).length === 0 && (
            <p className="text-[11px] text-muted-foreground">No loops yet. Adding a loop step creates one.</p>
          )}
          {Object.entries(loops).map(([name, loop]) => {
            const used = loopUsages(pipeline, name);
            return (
              <div key={name} className="rounded-lg border border-border/60">
                <div className="flex items-center gap-2 px-2.5 py-2">
                  <button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => setOpen(open === name ? null : name)}>
                    <Repeat className="h-3.5 w-3.5 shrink-0 text-primary" />
                    <span className="truncate text-xs font-medium">{name}</span>
                    <span className="shrink-0 text-[10px] text-muted-foreground">{used} step{used === 1 ? "" : "s"}</span>
                  </button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 px-1.5 text-red-500"
                    title={used > 0 ? "Used by steps" : "Delete loop"}
                    onClick={() => {
                      const r = deleteLoop(loops, pipeline, name);
                      if (r.error) toast.error(r.error);
                      else onLoops(r.loops!);
                    }}
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
                {open === name && (
                  <div className="space-y-3 border-t border-border/60 p-2.5">
                    <LoopFields
                      name={name}
                      loop={loop}
                      onChange={(next) => onLoops({ ...loops, [name]: next })}
                      onRename={(to) => {
                        const r = renameLoop(loops, pipeline, name, to);
                        if (r.error) { toast.error(r.error); return; }
                        onLoops(r.loops!);
                        onPipeline(r.pipeline);
                        setOpen(to.trim());
                      }}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="space-y-1.5 border-t border-border/60 pt-3">
          <p className="text-[11px] text-muted-foreground">
            Loops talk to the pipeline with <code className="text-[10px]">register_outcome</code>:{" "}
            <code className="text-[10px]">label: &apos;context&apos;</code> writes the shared context,{" "}
            <code className="text-[10px]">label: &apos;output&apos;</code> is the loop&apos;s structured output.
          </p>
          <Button
            size="sm"
            variant="outline"
            className="h-8 gap-1.5 text-[11px] text-red-500"
            onClick={() => onPipeline(undefined)}
          >
            <Bot className="h-3.5 w-3.5" /> Remove pipeline (back to a single session)
          </Button>
        </div>
      </div>
    </>
  );
}
