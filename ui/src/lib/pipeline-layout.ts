// Lays out an agent pipeline as a top-down flow for React Flow.
//
//   start → step → step → … → end
//   switch:   decision node, one column per case (+ default), merge dot
//   parallel: fork node, one column per branch, join dot
//
// Edges that sit in a step list carry an insertion slot ({ listPath, index }),
// rendered as a "+" button: inserting there adds a step at that position.

import { MarkerType, type Edge, type Node } from "@xyflow/react";
import type { Pipeline, PipelineStep } from "@polpo-ai/react";
import { ROOT_LIST, pathKey, stepKind, type Path } from "@/lib/pipeline-edit";

export const SIZES = {
  step: { w: 220, h: 64 },
  decision: { w: 220, h: 56 },
  fork: { w: 220, h: 48 },
  merge: { w: 14, h: 14 },
  empty: { w: 140, h: 30 },
  terminal: { w: 140, h: 34 },
} as const;

const V_GAP = 56;
const H_GAP = 36;
/** Switch columns are at least this wide, to fit the case label above each one. */
const SWITCH_COL_MIN = 200;

export interface InsertSlot {
  listPath: Path;
  index: number;
}

export interface PipelineNodeData {
  path?: Path;
  step?: PipelineStep;
  /** Problems reported for this step. */
  problems?: string[];
  label?: string;
  [key: string]: unknown;
}

export interface PipelineEdgeData {
  slot?: InsertSlot;
  label?: string;
  [key: string]: unknown;
}

interface Block {
  nodes: Node<PipelineNodeData>[];
  edges: Edge<PipelineEdgeData>[];
  width: number;
  height: number;
  /** Node ids where the block is entered / left; undefined for an empty sequence. */
  entry?: string;
  exit?: string;
}

const edgeStyle = { stroke: "oklch(0.55 0 0 / 0.45)", strokeWidth: 1.5 };

function edge(source: string, target: string, data: PipelineEdgeData = {}): Edge<PipelineEdgeData> {
  return {
    id: `e:${source}->${target}`,
    source,
    target,
    type: "pipeline",
    data,
    markerEnd: { type: MarkerType.ArrowClosed, width: 12, height: 12 },
    style: edgeStyle,
    deletable: false,
  };
}

function shift(block: Block, dx: number, dy: number): void {
  for (const n of block.nodes) n.position = { x: n.position.x + dx, y: n.position.y + dy };
}

function single(id: string, type: string, size: { w: number; h: number }, data: PipelineNodeData): Block {
  return {
    nodes: [{ id, type, position: { x: 0, y: 0 }, data, width: size.w, height: size.h, deletable: false }],
    edges: [],
    width: size.w,
    height: size.h,
    entry: id,
    exit: id,
  };
}

/** Lay blocks out side by side under a header node and above a merge node. */
function columns(
  head: Node<PipelineNodeData>,
  headSize: { w: number; h: number },
  mergeId: string,
  cols: Array<{ block: Block; inSlot?: InsertSlot; outSlot?: InsertSlot; label?: string }>,
  minColWidth = 0,
): Block {
  // Columns get at least minColWidth so labels on neighbouring edges do not overlap.
  const colWidth = (b: Block) => Math.max(b.width, minColWidth);
  const colsWidth = cols.reduce((sum, c) => sum + colWidth(c.block), 0) + H_GAP * Math.max(0, cols.length - 1);
  const width = Math.max(headSize.w, colsWidth);
  const colsTop = headSize.h + V_GAP;
  const colsHeight = Math.max(0, ...cols.map((c) => c.block.height));
  const mergeY = colsTop + colsHeight + V_GAP;

  const nodes: Node<PipelineNodeData>[] = [{ ...head, position: { x: (width - headSize.w) / 2, y: 0 } }];
  const edges: Edge<PipelineEdgeData>[] = [];
  const merge: Node<PipelineNodeData> = {
    id: mergeId,
    type: "pMerge",
    position: { x: (width - SIZES.merge.w) / 2, y: mergeY },
    data: {},
    width: SIZES.merge.w,
    height: SIZES.merge.h,
    deletable: false,
  };

  let x = (width - colsWidth) / 2;
  for (const col of cols) {
    shift(col.block, x + (colWidth(col.block) - col.block.width) / 2, colsTop);
    nodes.push(...col.block.nodes);
    edges.push(...col.block.edges);
    edges.push(edge(head.id, col.block.entry!, { slot: col.inSlot, label: col.label }));
    edges.push(edge(col.block.exit!, mergeId, { slot: col.outSlot }));
    x += colWidth(col.block) + H_GAP;
  }
  nodes.push(merge);
  return { nodes, edges, width, height: mergeY + SIZES.merge.h, entry: head.id, exit: mergeId };
}

/** A step list laid out vertically; inner edges carry insertion slots. */
function sequence(list: PipelineStep[], listPath: Path, problems: Map<string, string[]>): Block {
  const blocks = list.map((step, i) => stepBlock(step, [...listPath, i], problems));
  if (blocks.length === 0) return { nodes: [], edges: [], width: 0, height: 0 };
  const width = Math.max(...blocks.map((b) => b.width));
  const nodes: Node<PipelineNodeData>[] = [];
  const edges: Edge<PipelineEdgeData>[] = [];
  let y = 0;
  blocks.forEach((b, i) => {
    shift(b, (width - b.width) / 2, y);
    nodes.push(...b.nodes);
    edges.push(...b.edges);
    if (i > 0) edges.push(edge(blocks[i - 1].exit!, b.entry!, { slot: { listPath, index: i } }));
    y += b.height + V_GAP;
  });
  return { nodes, edges, width, height: y - V_GAP, entry: blocks[0].entry, exit: blocks[blocks.length - 1].exit };
}

/** A sequence that always has a node: empty lists show a placeholder. */
function column(list: PipelineStep[], listPath: Path, problems: Map<string, string[]>, emptyLabel: string): Block {
  const block = sequence(list, listPath, problems);
  if (block.entry) return block;
  return single(`empty:${pathKey(listPath)}`, "pEmpty", SIZES.empty, { label: emptyLabel, path: listPath });
}

function stepBlock(step: PipelineStep, path: Path, problems: Map<string, string[]>): Block {
  const key = pathKey(path);
  const data: PipelineNodeData = { path, step, problems: problems.get(key) };
  const kind = stepKind(step);

  if (kind === "loop" || kind === "human") return single(`step:${key}`, "pStep", SIZES.step, data);

  if ("parallel" in step) {
    const head: Node<PipelineNodeData> = { id: `step:${key}`, type: "pParallel", position: { x: 0, y: 0 }, data, width: SIZES.fork.w, height: SIZES.fork.h, deletable: false };
    const branchList = [...path, "parallel"];
    const cols = step.parallel.length > 0
      ? step.parallel.map((branch, i) => ({ block: stepBlock(branch, [...branchList, i], problems) }))
      : [{ block: single(`empty:${pathKey(branchList)}`, "pEmpty", SIZES.empty, { label: "No branches yet", path: branchList }) }];
    return columns(head, SIZES.fork, `merge:${key}`, cols);
  }

  const sw = (step as Extract<PipelineStep, { switch: unknown }>).switch;
  const head: Node<PipelineNodeData> = { id: `step:${key}`, type: "pSwitch", position: { x: 0, y: 0 }, data, width: SIZES.decision.w, height: SIZES.decision.h, deletable: false };
  const cols = sw.cases.map((c, i) => {
    const listPath = [...path, "switch", "cases", i, "steps"];
    return {
      block: column(c.steps, listPath, problems, "Empty case"),
      inSlot: { listPath, index: 0 },
      outSlot: c.steps.length > 0 ? { listPath, index: c.steps.length } : undefined,
      label: c.when.trim() || `case ${i + 1}`,
    };
  });
  if (sw.default) {
    const listPath = [...path, "switch", "default", "steps"];
    cols.push({
      block: column(sw.default.steps, listPath, problems, "Empty default"),
      inSlot: { listPath, index: 0 },
      outSlot: sw.default.steps.length > 0 ? { listPath, index: sw.default.steps.length } : undefined,
      label: "default",
    });
  }
  return columns(head, SIZES.decision, `merge:${key}`, cols, SWITCH_COL_MIN);
}

/** Full layout: start → pipeline → end, centered on x = 0. */
export function layoutPipeline(
  pipeline: Pipeline,
  problemsByPath: Map<string, string[]> = new Map(),
): { nodes: Node<PipelineNodeData>[]; edges: Edge<PipelineEdgeData>[] } {
  const body = sequence(pipeline.steps, ROOT_LIST, problemsByPath);
  const start = single("start", "pTerminal", SIZES.terminal, { label: pipeline.mode === "parallel" ? "Task starts (all steps in parallel)" : "Task starts" });
  const end = single("end", "pTerminal", SIZES.terminal, { label: "Task done" });

  const width = Math.max(SIZES.terminal.w, body.width);
  const nodes: Node<PipelineNodeData>[] = [];
  const edges: Edge<PipelineEdgeData>[] = [];

  shift(start, (width - SIZES.terminal.w) / 2, 0);
  nodes.push(...start.nodes);
  let y = SIZES.terminal.h + V_GAP;

  if (body.entry) {
    shift(body, (width - body.width) / 2, y);
    nodes.push(...body.nodes);
    edges.push(...body.edges);
    edges.push(edge("start", body.entry, { slot: { listPath: ROOT_LIST, index: 0 } }));
    y += body.height + V_GAP;
    shift(end, (width - SIZES.terminal.w) / 2, y);
    edges.push(edge(body.exit!, "end", { slot: { listPath: ROOT_LIST, index: pipeline.steps.length } }));
  } else {
    shift(end, (width - SIZES.terminal.w) / 2, y);
    edges.push(edge("start", "end", { slot: { listPath: ROOT_LIST, index: 0 } }));
  }
  nodes.push(...end.nodes);

  // Center on x = 0 so fitView behaves the same for any width.
  for (const n of nodes) n.position = { x: n.position.x - width / 2, y: n.position.y };
  return { nodes, edges };
}
