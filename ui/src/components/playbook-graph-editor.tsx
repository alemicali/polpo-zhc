// Editable node graph for playbooks: drag tasks, checkpoints and delays,
// connect them to define execution order, edit their fields in the side
// panel, and save the result as a regular playbook.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Panel,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
  type XYPosition,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  AlertTriangle,
  LayoutGrid,
  ListChecks,
  Loader2,
  Plus,
  RotateCcw,
  Save,
  ShieldCheck,
  Timer,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { useAgents, usePlaybooks } from "@polpo-ai/react";
import type { PlaybookDefinition } from "@polpo-ai/react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CommitInput, CommitTextarea, Field } from "@/components/editor-fields";
import { buildGraphLayout } from "@/lib/mission-graph";
import { withMeasured } from "@/lib/graph-nodes";
import {
  addNode,
  connect,
  disconnect,
  draftFromMission,
  draftWarnings,
  missionFromDraft,
  nodeKey,
  parseNodeId,
  reconnect,
  removeNodes,
  updateGate,
  updateTask,
  type EditResult,
  type GraphDraft,
  type GraphNodeKind,
  type GraphNodeRef,
} from "@/lib/playbook-graph-edit";
import {
  CheckpointNodeComponent,
  DelayNodeComponent,
  TaskNodeComponent,
} from "@/pages/mission-detail";
import { EditableEdge } from "@/components/playbook-editable-edge";

const nodeTypes = {
  taskNode: TaskNodeComponent,
  checkpointNode: CheckpointNodeComponent,
  delayNode: DelayNodeComponent,
};

const edgeTypes = { editable: EditableEdge };

const noLiveTask = () => undefined;

/** "kind:name" key of a rendered node, read from the data buildGraphLayout attached to it. */
function keyOfNode(node: Node): string | null {
  const data = node.data as { taskDef?: { title: string }; checkpoint?: { name: string }; delay?: { name: string } };
  if (data.taskDef) return `task:${data.taskDef.title}`;
  if (data.checkpoint) return `checkpoint:${data.checkpoint.name}`;
  if (data.delay) return `delay:${data.delay.name}`;
  return null;
}

export function PlaybookGraphEditor({
  playbook,
  onSaved,
}: {
  playbook: PlaybookDefinition;
  onSaved: (playbook: PlaybookDefinition) => void;
}) {
  const { savePlaybook } = usePlaybooks();
  const { agents } = useAgents();
  const { screenToFlowPosition, fitView } = useReactFlow();
  const wrapperRef = useRef<HTMLDivElement>(null);

  const initialDraft = useMemo(() => draftFromMission(playbook.mission), [playbook]);
  const [draft, setDraft] = useState<GraphDraft>(initialDraft);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [selected, setSelected] = useState<GraphNodeRef | null>(null);
  // Positions the user chose by dragging, keyed by "kind:name" so they survive edits.
  const [positions, setPositions] = useState<Record<string, XYPosition>>({});

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  const agentNames = useMemo(() => {
    const team = (playbook.mission as { team?: unknown }).team;
    const teamNames = Array.isArray(team) ? team.map((m: { name?: string }) => m.name).filter(Boolean) as string[] : [];
    return Array.from(new Set([...teamNames, ...agents.map((a) => a.name)])).sort();
  }, [playbook, agents]);

  const warnings = useMemo(() => draftWarnings(draft), [draft]);

  // Set by Auto-layout and Reset: the next rebuild ignores where nodes currently are.
  const relayoutRef = useRef(false);

  // Rebuild nodes and edges whenever the draft changes. A node keeps, in order of
  // preference: the position the user dragged it to, the position it had on screen
  // before this edit, or the automatic layout position (new nodes only). This keeps
  // the graph still while connecting nodes.
  useEffect(() => {
    const layout = buildGraphLayout(draft.tasks, noLiveTask, draft.checkpoints, undefined, undefined, draft.delays);
    const relayout = relayoutRef.current;
    relayoutRef.current = false;
    setNodes((previous) => {
      const onScreen = new Map<string, XYPosition>();
      const shown = new Map<string, Node>();
      for (const n of previous) {
        const key = keyOfNode(n);
        if (!key) continue;
        shown.set(key, n);
        if (!relayout) onScreen.set(key, n.position);
      }
      return layout.nodes.map((node) => {
        const ref = parseNodeId(node.id);
        const key = ref ? nodeKey(draft, ref) : null;
        const isSelected = !!ref && !!selected && ref.kind === selected.kind && ref.index === selected.index;
        return {
          ...withMeasured(node, key ? shown.get(key) : undefined),
          position: (key && (positions[key] ?? onScreen.get(key))) || node.position,
          selected: isSelected,
        };
      });
    });
    setEdges(layout.edges.map((e) => ({ ...e, type: "editable", deletable: true, reconnectable: true, interactionWidth: 24 })));
  }, [draft, positions, selected, setNodes, setEdges]);

  const apply = useCallback((result: EditResult) => {
    if (!result.draft) {
      toast.error(result.error);
      return false;
    }
    setDraft(result.draft);
    setDirty(true);
    return true;
  }, []);

  // ── Canvas interactions ──

  const onConnect = useCallback((c: Connection) => {
    const source = parseNodeId(c.source);
    const target = parseNodeId(c.target);
    if (!source || !target) return;
    apply(connect(draft, source, target));
  }, [draft, apply]);

  // A connection's end dragged to another node: the old dependency goes, the new one comes,
  // in one edit (refused as a whole if the new one is not allowed, e.g. a cycle).
  const onReconnect = useCallback((oldEdge: Edge, c: Connection) => {
    const oldSource = parseNodeId(oldEdge.source);
    const oldTarget = parseNodeId(oldEdge.target);
    const source = parseNodeId(c.source);
    const target = parseNodeId(c.target);
    if (!oldSource || !oldTarget || !source || !target) return;
    if (oldEdge.source === c.source && oldEdge.target === c.target) return;
    apply(reconnect(draft, { source: oldSource, target: oldTarget }, source, target));
  }, [draft, apply]);

  // One handler for nodes and edges: React Flow deletes a node's edges together
  // with it, and both must be applied to the same draft. Edges go first because
  // removing nodes shifts the indices that node ids refer to.
  const onDelete = useCallback(({ nodes: deletedNodes, edges: deletedEdges }: { nodes: Node[]; edges: Edge[] }) => {
    let next = draft;
    for (const e of deletedEdges) {
      const source = parseNodeId(e.source);
      const target = parseNodeId(e.target);
      if (source && target) next = disconnect(next, source, target);
    }
    const refs = deletedNodes.map((n) => parseNodeId(n.id)).filter((r): r is GraphNodeRef => r != null);
    if (refs.length > 0) {
      next = removeNodes(next, refs);
      setSelected(null);
    }
    apply({ draft: next });
  }, [draft, apply]);

  const onNodeDragStop = useCallback((_: React.MouseEvent, node: Node) => {
    const ref = parseNodeId(node.id);
    const key = ref ? nodeKey(draft, ref) : null;
    if (key) setPositions((p) => ({ ...p, [key]: node.position }));
  }, [draft]);

  const onNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    setSelected(parseNodeId(node.id));
  }, []);

  // ── Toolbar actions ──

  const handleAdd = (kind: GraphNodeKind) => {
    const { draft: next, ref } = addNode(draft, kind);
    // Drop the new node to the right of the existing graph so it never covers another node,
    // or in the middle of the canvas when the graph is empty.
    const key = nodeKey(next, ref);
    if (key && nodes.length > 0) {
      const right = Math.max(...nodes.map((n) => n.position.x + (n.measured?.width ?? 240)));
      const top = Math.min(...nodes.map((n) => n.position.y));
      setPositions((p) => ({ ...p, [key]: { x: right + 80, y: top } }));
    } else if (key && wrapperRef.current) {
      const rect = wrapperRef.current.getBoundingClientRect();
      const center = screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
      setPositions((p) => ({ ...p, [key]: { x: center.x - 120, y: center.y - 60 } }));
    }
    setTimeout(() => fitView({ padding: 0.2, duration: 200 }), 50);
    setDraft(next);
    setDirty(true);
    setSelected(ref);
  };

  const handleAutoLayout = () => {
    relayoutRef.current = true;
    setPositions({});
    setTimeout(() => fitView({ padding: 0.2 }), 50);
  };

  const handleReset = () => {
    relayoutRef.current = true;
    setDraft(initialDraft);
    setPositions({});
    setSelected(null);
    setDirty(false);
  };

  const handleSave = async () => {
    const definition: PlaybookDefinition = {
      ...playbook,
      mission: missionFromDraft(playbook.mission, draft),
    };
    setSaving(true);
    try {
      await savePlaybook(definition);
      toast.success(`Playbook "${playbook.name}" saved`);
      setDirty(false);
      onSaved(definition);
    } catch (e) {
      toast.error(`Save failed: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  // A rename changes the node's key: pin it where it is on screen so it does not jump.
  const applyRename = (result: EditResult, oldKey: string | null, kind: GraphNodeKind, index: number) => {
    if (!apply(result) || !result.draft || !oldKey) return;
    const newKey = nodeKey(result.draft, { kind, index });
    if (newKey && newKey !== oldKey) {
      const current = nodes.find((n) => keyOfNode(n) === oldKey)?.position;
      setPositions((p) => {
        const { [oldKey]: dragged, ...rest } = p;
        const pos = dragged ?? current;
        return pos ? { ...rest, [newKey]: pos } : rest;
      });
    }
  };

  return (
    <div className="flex h-full w-full flex-col">
      {/* Toolbar */}
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border/40 px-3 py-2">
        <Button size="sm" variant="outline" className="h-8 gap-1.5 text-[11px]" onClick={() => handleAdd("task")}>
          <Plus className="h-3.5 w-3.5" /><ListChecks className="h-3.5 w-3.5" /> Task
        </Button>
        <Button size="sm" variant="outline" className="h-8 gap-1.5 text-[11px]" onClick={() => handleAdd("checkpoint")}>
          <Plus className="h-3.5 w-3.5" /><ShieldCheck className="h-3.5 w-3.5 text-amber-500" /> Checkpoint
        </Button>
        <Button size="sm" variant="outline" className="h-8 gap-1.5 text-[11px]" onClick={() => handleAdd("delay")}>
          <Plus className="h-3.5 w-3.5" /><Timer className="h-3.5 w-3.5 text-blue-500" /> Delay
        </Button>
        <Button size="sm" variant="ghost" className="h-8 gap-1.5 text-[11px]" onClick={handleAutoLayout} title="Discard manual positions and lay out automatically">
          <LayoutGrid className="h-3.5 w-3.5" /> Auto-layout
        </Button>
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          {dirty && <Badge variant="outline" className="text-[10px] text-amber-500">Unsaved changes</Badge>}
          {warnings.length > 0 && (
            <Badge variant="outline" className="gap-1 text-[10px] text-amber-500" title={warnings.join("\n")}>
              <AlertTriangle className="h-3 w-3" />
              {warnings.length} warning{warnings.length !== 1 ? "s" : ""}
            </Badge>
          )}
          <Button size="sm" variant="ghost" className="h-8 gap-1.5 text-[11px]" disabled={!dirty || saving} onClick={handleReset}>
            <RotateCcw className="h-3.5 w-3.5" /> Reset
          </Button>
          <Button size="sm" className="h-8 gap-1.5 text-[11px]" disabled={!dirty || saving} onClick={handleSave}>
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            Save
          </Button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* Canvas */}
        {/* A connection under the pointer lights up: it is thin and easy to miss otherwise. */}
        <div ref={wrapperRef} className="min-w-0 flex-1 [&_.react-flow__edge-editable:hover_.react-flow__edge-path]:![stroke:var(--primary)] [&_.react-flow__edge-editable:hover_.react-flow__edge-path]:![stroke-width:2.5]">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onConnect={onConnect}
            onReconnect={onReconnect}
            edgeTypes={edgeTypes}
            onEdgesChange={onEdgesChange}
            onDelete={onDelete}
            onNodeDragStop={onNodeDragStop}
            onNodeClick={onNodeClick}
            onPaneClick={() => setSelected(null)}
            deleteKeyCode={["Backspace", "Delete"]}
            nodesDraggable
            nodesConnectable
            edgesFocusable
            edgesReconnectable
            fitView
            fitViewOptions={{ padding: 0.2 }}
            minZoom={0.2}
            maxZoom={1.5}
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={20} size={1} className="!bg-background" />
            <Controls showInteractive={false} className="!bg-card !border-border !shadow-md [&>button]:!bg-card [&>button]:!border-border [&>button]:!text-foreground [&>button:hover]:!bg-accent" />
            {/* Hidden while the inspector is open: the narrower canvas has no room for it. */}
            {!selected && (
              <MiniMap
                pannable
                zoomable
                bgColor="var(--card)"
                maskColor="oklch(0.5 0 0 / 0.15)"
                nodeColor="oklch(0.6 0 0 / 0.45)"
                className="!border !border-border max-lg:!hidden"
              />
            )}
            <Panel position="bottom-center" className="mb-3 rounded bg-background/80 px-2 py-1 text-[10px] text-muted-foreground max-xl:!hidden">
              Drag from a node&apos;s bottom handle to another node&apos;s top handle to connect · Click a connection: × removes it, drag its ends to move it
            </Panel>
          </ReactFlow>
        </div>

        {/* Inspector */}
        {selected && (
          <Inspector
            draft={draft}
            selected={selected}
            agentNames={agentNames}
            onClose={() => setSelected(null)}
            onDelete={() => { setSelected(null); apply({ draft: removeNodes(draft, [selected]) }); }}
            onTaskChange={(patch) => {
              const oldKey = nodeKey(draft, selected);
              applyRename(updateTask(draft, selected.index, patch), oldKey, "task", selected.index);
            }}
            onGateChange={(patch) => {
              if (selected.kind === "task") return;
              const oldKey = nodeKey(draft, selected);
              applyRename(updateGate(draft, selected.kind, selected.index, patch), oldKey, selected.kind, selected.index);
            }}
          />
        )}
      </div>
    </div>
  );
}

// ── Inspector side panel ──

function Inspector({
  draft,
  selected,
  agentNames,
  onClose,
  onDelete,
  onTaskChange,
  onGateChange,
}: {
  draft: GraphDraft;
  selected: GraphNodeRef;
  agentNames: string[];
  onClose: () => void;
  onDelete: () => void;
  onTaskChange: (patch: Parameters<typeof updateTask>[2]) => void;
  onGateChange: (patch: Parameters<typeof updateGate>[3]) => void;
}) {
  const task = selected.kind === "task" ? draft.tasks[selected.index] : undefined;
  const delay = selected.kind === "delay" ? draft.delays[selected.index] : undefined;
  const gate = selected.kind === "checkpoint" ? draft.checkpoints[selected.index] : delay;
  if (!task && !gate) return null;

  const title = selected.kind === "task" ? "Task" : selected.kind === "checkpoint" ? "Checkpoint" : "Delay";

  return (
    <aside className="flex h-full w-[min(340px,45%)] shrink-0 flex-col overflow-hidden border-l border-border bg-background">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <span className="text-xs font-semibold">{title}</span>
        <Button size="sm" variant="ghost" className="ml-auto h-7 px-2 text-red-500" onClick={onDelete} title="Delete node">
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
        <Button size="sm" variant="ghost" className="h-7 px-2" onClick={onClose} title="Close">
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto p-3">
        {task && (
          <>
            <Field label="Title">
              <CommitInput className="h-8 text-xs" value={task.title} onCommit={(v) => onTaskChange({ title: v })} />
            </Field>
            <Field label="Agent">
              <CommitInput
                className="h-8 text-xs"
                list="playbook-editor-agents"
                placeholder="agent name"
                value={task.assignTo ?? ""}
                onCommit={(v) => onTaskChange({ assignTo: v.trim() || undefined })}
              />
              <datalist id="playbook-editor-agents">
                {agentNames.map((n) => <option key={n} value={n} />)}
              </datalist>
            </Field>
            <Field label="Description (supports {{params}})">
              <CommitTextarea
                className="min-h-[140px] text-xs font-mono"
                value={task.description ?? ""}
                onCommit={(v) => onTaskChange({ description: v })}
              />
            </Field>
            <Field label="Max retries">
              <CommitInput
                className="h-8 text-xs"
                type="number"
                min={0}
                value={task.maxRetries != null ? String(task.maxRetries) : ""}
                onCommit={(v) => onTaskChange({ maxRetries: v === "" ? undefined : Math.max(0, Number(v)) })}
              />
            </Field>
            <ExpectationsField value={task.expectations} onCommit={(expectations) => onTaskChange({ expectations })} />
            {task.dependsOn && task.dependsOn.length > 0 && (
              <Field label="Depends on">
                <div className="flex flex-wrap gap-1">
                  {task.dependsOn.map((d) => <Badge key={d} variant="secondary" className="text-[10px]">{d}</Badge>)}
                </div>
              </Field>
            )}
          </>
        )}

        {gate && (
          <>
            <Field label="Name">
              <CommitInput className="h-8 text-xs" value={gate.name} onCommit={(v) => onGateChange({ name: v })} />
            </Field>
            {delay && (
              <Field label="Duration (ISO 8601, e.g. PT30M, PT2H, P1D)">
                <CommitInput
                  className="h-8 text-xs font-mono"
                  value={delay.duration}
                  onCommit={(v) => onGateChange({ duration: v.trim() })}
                />
              </Field>
            )}
            <Field label="Message">
              <CommitTextarea
                className="min-h-[80px] text-xs"
                value={gate.message ?? ""}
                onCommit={(v) => onGateChange({ message: v || undefined })}
              />
            </Field>
            <Field label="After tasks">
              <div className="flex flex-wrap gap-1">
                {gate.afterTasks.length === 0
                  ? <span className="text-[11px] text-muted-foreground">Connect a task into this node</span>
                  : gate.afterTasks.map((t) => <Badge key={t} variant="secondary" className="text-[10px]">{t}</Badge>)}
              </div>
            </Field>
            <Field label="Blocks tasks">
              <div className="flex flex-wrap gap-1">
                {gate.blocksTasks.length === 0
                  ? <span className="text-[11px] text-muted-foreground">Connect this node to a task</span>
                  : gate.blocksTasks.map((t) => <Badge key={t} variant="secondary" className="text-[10px]">{t}</Badge>)}
              </div>
            </Field>
          </>
        )}
      </div>
    </aside>
  );
}

/** Expectations are edited as JSON: they have several shapes (test, file_exists, llm_review, …). */
function ExpectationsField({
  value,
  onCommit,
}: {
  value: GraphDraft["tasks"][number]["expectations"];
  onCommit: (v: GraphDraft["tasks"][number]["expectations"]) => void;
}) {
  const text = value && value.length > 0 ? JSON.stringify(value, null, 2) : "";
  const [error, setError] = useState<string | null>(null);
  return (
    <Field label="Expectations (JSON array)">
      <CommitTextarea
        className="min-h-[100px] text-[11px] font-mono"
        placeholder='[{ "type": "llm_review", "criteria": "...", "threshold": 3.5 }]'
        value={text}
        onCommit={(v) => {
          if (!v.trim()) { setError(null); onCommit(undefined); return; }
          try {
            const parsed = JSON.parse(v);
            if (!Array.isArray(parsed)) throw new Error("Must be a JSON array");
            setError(null);
            onCommit(parsed);
          } catch (e) {
            setError((e as Error).message);
          }
        }}
      />
      {error && <span className="text-[10px] text-red-500">{error}</span>}
    </Field>
  );
}
