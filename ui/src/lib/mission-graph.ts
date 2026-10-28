// Graph layout for mission and playbook graphs: turns task/checkpoint/delay
// definitions into positioned ReactFlow nodes and edges.

import { MarkerType, type Node, type Edge } from "@xyflow/react";
import type { Task, ActiveDelay } from "@polpo-ai/react";
import type { MissionCheckpointDef, MissionDelayDef, MissionTaskDef } from "@/lib/mission-data";

// ── Graph node data ──

export interface TaskNodeData {
  taskDef: MissionTaskDef;
  liveTask?: Task;
  index: number;
  expanded?: boolean;
  [key: string]: unknown;
}

export interface CheckpointNodeData {
  checkpoint: MissionCheckpointDef;
  /** Whether this checkpoint is currently active (blocking) — from live API data */
  isActive?: boolean;
  /** Whether this checkpoint has been resumed */
  isResumed?: boolean;
  [key: string]: unknown;
}

export interface DelayNodeData {
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

// ── Node sizes ──

export const CHECKPOINT_WIDTH = 200;
export const CHECKPOINT_HEIGHT = 72;
export const DELAY_SIZE = 140;
export const DELAY_WIDTH = DELAY_SIZE;
export const DELAY_HEIGHT = DELAY_SIZE;

// ── Graph layout computation ──

const NODE_WIDTH = 240;
const NODE_HEIGHT = 140;
const H_GAP = 60;
const V_GAP = 80;

export function buildGraphLayout(
  taskDefs: MissionTaskDef[],
  findLive: (title: string) => Task | undefined,
  checkpoints?: MissionCheckpointDef[],
  activeCheckpoints?: Set<string>,
  resumedCheckpoints?: Set<string>,
  delays?: MissionDelayDef[],
  activeDelayMap?: Map<string, ActiveDelay>,
  expiredDelays?: Set<string>,
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

  // Recompute max layer after checkpoint and delay pushes
  const maxLayer = Math.max(...layers, ...cpLayers, ...dlLayers, 0);

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
            ? "oklch(0.72 0.15 85)"     // warm amber-green
            : "oklch(0.55 0 0 / 0.3)",
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
            ? "oklch(0.72 0.17 155)"      // green — resumed
            : isActive
              ? "oklch(0.75 0.15 85)"     // amber — waiting
              : "oklch(0.55 0 0 / 0.3)",  // muted
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
            ? "oklch(0.65 0.15 240)"     // blue
            : "oklch(0.55 0 0 / 0.3)",
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
            ? "oklch(0.72 0.17 155)"      // green — expired
            : isActiveDl
              ? "oklch(0.65 0.15 240)"    // blue — waiting
              : "oklch(0.55 0 0 / 0.3)",  // muted
          strokeWidth: isActiveDl || isExpiredDl ? 2 : 1.5,
          strokeDasharray: "6 3",
        },
        animated: isActiveDl,
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
