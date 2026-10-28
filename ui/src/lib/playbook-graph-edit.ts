// Pure editing operations for the playbook graph editor.
//
// The editor works on a GraphDraft (the tasks, checkpoints and delays of a
// mission body). Every edge drawn on the canvas maps onto a field of the
// mission JSON:
//   task → task         target.dependsOn
//   task → checkpoint   checkpoint.afterTasks   (same for delays)
//   checkpoint → task   checkpoint.blocksTasks  (same for delays)
// so the draft can be saved back as a regular playbook without a separate
// graph format.

import type {
  MissionCheckpointDef,
  MissionDelayDef,
  MissionTaskDef,
} from "@/lib/mission-data";

export interface GraphDraft {
  tasks: MissionTaskDef[];
  checkpoints: MissionCheckpointDef[];
  delays: MissionDelayDef[];
}

export type GraphNodeKind = "task" | "checkpoint" | "delay";

export interface GraphNodeRef {
  kind: GraphNodeKind;
  index: number;
}

/** Result of an edit: the new draft, or an error explaining why it was refused. */
export type EditResult = { draft: GraphDraft; error?: undefined } | { draft?: undefined; error: string };

/** Parse a node id produced by buildGraphLayout ("task-3", "checkpoint-0", "delay-1"). */
export function parseNodeId(id: string): GraphNodeRef | null {
  const match = id.match(/^(task|checkpoint|delay)-(\d+)$/);
  if (!match) return null;
  return { kind: match[1] as GraphNodeKind, index: Number(match[2]) };
}

/** Stable key for a node, used to remember its position across edits. */
export function nodeKey(draft: GraphDraft, ref: GraphNodeRef): string | null {
  const name = nodeName(draft, ref);
  return name == null ? null : `${ref.kind}:${name}`;
}

function nodeName(draft: GraphDraft, ref: GraphNodeRef): string | undefined {
  if (ref.kind === "task") return draft.tasks[ref.index]?.title;
  if (ref.kind === "checkpoint") return draft.checkpoints[ref.index]?.name;
  return draft.delays[ref.index]?.name;
}

function gateList(draft: GraphDraft, kind: "checkpoint" | "delay"): (MissionCheckpointDef | MissionDelayDef)[] {
  return kind === "checkpoint" ? draft.checkpoints : draft.delays;
}

function cloneDraft(draft: GraphDraft): GraphDraft {
  return {
    tasks: draft.tasks.map((t) => ({ ...t, dependsOn: t.dependsOn ? [...t.dependsOn] : undefined })),
    checkpoints: draft.checkpoints.map((c) => ({ ...c, afterTasks: [...c.afterTasks], blocksTasks: [...c.blocksTasks] })),
    delays: draft.delays.map((d) => ({ ...d, afterTasks: [...d.afterTasks], blocksTasks: [...d.blocksTasks] })),
  };
}

// ── Cycle detection ──

/** Adjacency over "kind:name" keys, following execution order. */
function buildAdjacency(draft: GraphDraft): Map<string, string[]> {
  const adj = new Map<string, string[]>();
  const add = (from: string, to: string) => {
    const list = adj.get(from);
    if (list) list.push(to);
    else adj.set(from, [to]);
  };
  for (const t of draft.tasks) {
    for (const dep of t.dependsOn ?? []) add(`task:${dep}`, `task:${t.title}`);
  }
  for (const [kind, gates] of [["checkpoint", draft.checkpoints], ["delay", draft.delays]] as const) {
    for (const g of gates) {
      for (const a of g.afterTasks) add(`task:${a}`, `${kind}:${g.name}`);
      for (const b of g.blocksTasks) add(`${kind}:${g.name}`, `task:${b}`);
    }
  }
  return adj;
}

function reaches(adj: Map<string, string[]>, from: string, to: string): boolean {
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (cur === to) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    stack.push(...(adj.get(cur) ?? []));
  }
  return false;
}

// ── Connect / disconnect ──

/** Draw an edge from `source` to `target`, updating the mission fields it stands for. */
export function connect(draft: GraphDraft, source: GraphNodeRef, target: GraphNodeRef): EditResult {
  const sourceKey = nodeKey(draft, source);
  const targetKey = nodeKey(draft, target);
  if (!sourceKey || !targetKey) return { error: "Unknown node." };
  if (sourceKey === targetKey) return { error: "A node cannot depend on itself." };
  if (source.kind !== "task" && target.kind !== "task") {
    return { error: "Checkpoints and delays can only be connected to tasks." };
  }
  if (reaches(buildAdjacency(draft), targetKey, sourceKey)) {
    return { error: "This connection would create a cycle." };
  }

  const next = cloneDraft(draft);
  if (source.kind === "task" && target.kind === "task") {
    const t = next.tasks[target.index];
    const dep = next.tasks[source.index].title;
    const deps = t.dependsOn ?? [];
    if (deps.includes(dep)) return { error: "These tasks are already connected." };
    t.dependsOn = [...deps, dep];
  } else if (source.kind === "task") {
    const gate = gateList(next, target.kind as "checkpoint" | "delay")[target.index];
    const title = next.tasks[source.index].title;
    if (gate.afterTasks.includes(title)) return { error: "Already connected." };
    gate.afterTasks.push(title);
  } else {
    const gate = gateList(next, source.kind)[source.index];
    const title = next.tasks[target.index].title;
    if (gate.blocksTasks.includes(title)) return { error: "Already connected." };
    gate.blocksTasks.push(title);
  }
  return { draft: next };
}

/** Remove the edge from `source` to `target`. */
export function disconnect(draft: GraphDraft, source: GraphNodeRef, target: GraphNodeRef): GraphDraft {
  const next = cloneDraft(draft);
  if (source.kind === "task" && target.kind === "task") {
    const t = next.tasks[target.index];
    const dep = next.tasks[source.index]?.title;
    if (t && t.dependsOn) t.dependsOn = t.dependsOn.filter((d) => d !== dep);
  } else if (source.kind === "task" && target.kind !== "task") {
    const gate = gateList(next, target.kind)[target.index];
    const title = next.tasks[source.index]?.title;
    if (gate) gate.afterTasks = gate.afterTasks.filter((a) => a !== title);
  } else if (source.kind !== "task" && target.kind === "task") {
    const gate = gateList(next, source.kind)[source.index];
    const title = next.tasks[target.index]?.title;
    if (gate) gate.blocksTasks = gate.blocksTasks.filter((b) => b !== title);
  }
  return next;
}

/**
 * Move a connection: drop the old one and add the new one in a single edit, refused as a whole
 * (the old connection stays) when the new one is not allowed, e.g. it would create a cycle.
 */
export function reconnect(draft: GraphDraft, old: { source: GraphNodeRef; target: GraphNodeRef }, source: GraphNodeRef, target: GraphNodeRef): EditResult {
  return connect(disconnect(draft, old.source, old.target), source, target);
}

// ── Add / remove nodes ──

function uniqueName(base: string, taken: Iterable<string>): string {
  const set = new Set(taken);
  if (!set.has(base)) return base;
  let i = 2;
  while (set.has(`${base} ${i}`)) i++;
  return `${base} ${i}`;
}

function uniqueSlug(base: string, taken: Iterable<string>): string {
  const set = new Set(taken);
  if (!set.has(base)) return base;
  let i = 2;
  while (set.has(`${base}-${i}`)) i++;
  return `${base}-${i}`;
}

/** Append a node of the given kind with a unique default name. Returns the draft and the new node's ref. */
export function addNode(draft: GraphDraft, kind: GraphNodeKind): { draft: GraphDraft; ref: GraphNodeRef } {
  const next = cloneDraft(draft);
  if (kind === "task") {
    const title = uniqueName("New task", next.tasks.map((t) => t.title));
    next.tasks.push({ title, description: "" });
    return { draft: next, ref: { kind, index: next.tasks.length - 1 } };
  }
  if (kind === "checkpoint") {
    const name = uniqueSlug("review", next.checkpoints.map((c) => c.name));
    next.checkpoints.push({ name, afterTasks: [], blocksTasks: [] });
    return { draft: next, ref: { kind, index: next.checkpoints.length - 1 } };
  }
  const name = uniqueSlug("wait", next.delays.map((d) => d.name));
  next.delays.push({ name, afterTasks: [], blocksTasks: [], duration: "PT1H" });
  return { draft: next, ref: { kind, index: next.delays.length - 1 } };
}

/** Remove nodes and every reference to them. */
export function removeNodes(draft: GraphDraft, refs: GraphNodeRef[]): GraphDraft {
  const names = (kind: GraphNodeKind) =>
    new Set(refs.filter((r) => r.kind === kind).map((r) => nodeName(draft, r)).filter((n): n is string => n != null));
  const tasks = names("task");
  const cps = names("checkpoint");
  const dls = names("delay");

  const next = cloneDraft(draft);
  next.tasks = next.tasks
    .filter((t) => !tasks.has(t.title))
    .map((t) => (t.dependsOn ? { ...t, dependsOn: t.dependsOn.filter((d) => !tasks.has(d)) } : t));
  const stripGate = <G extends MissionCheckpointDef | MissionDelayDef>(g: G): G => ({
    ...g,
    afterTasks: g.afterTasks.filter((a) => !tasks.has(a)),
    blocksTasks: g.blocksTasks.filter((b) => !tasks.has(b)),
  });
  next.checkpoints = next.checkpoints.filter((c) => !cps.has(c.name)).map(stripGate);
  next.delays = next.delays.filter((d) => !dls.has(d.name)).map(stripGate);
  return next;
}

// ── Update / rename ──

/** Replace a task's fields. A title change is propagated to every reference. */
export function updateTask(draft: GraphDraft, index: number, patch: Partial<MissionTaskDef>): EditResult {
  const current = draft.tasks[index];
  if (!current) return { error: "Unknown task." };
  const next = cloneDraft(draft);

  if (patch.title !== undefined && patch.title !== current.title) {
    const title = patch.title.trim();
    if (!title) return { error: "Task title cannot be empty." };
    if (draft.tasks.some((t, i) => i !== index && t.title === title)) {
      return { error: `A task named "${title}" already exists.` };
    }
    const rename = (s: string) => (s === current.title ? title : s);
    next.tasks = next.tasks.map((t) => (t.dependsOn ? { ...t, dependsOn: t.dependsOn.map(rename) } : t));
    for (const g of [...next.checkpoints, ...next.delays]) {
      g.afterTasks = g.afterTasks.map(rename);
      g.blocksTasks = g.blocksTasks.map(rename);
    }
    patch = { ...patch, title };
  }
  next.tasks[index] = { ...next.tasks[index], ...patch };
  return { draft: next };
}

/** Replace a checkpoint's or delay's fields. Names must stay unique within their kind. */
export function updateGate(
  draft: GraphDraft,
  kind: "checkpoint" | "delay",
  index: number,
  patch: Partial<MissionCheckpointDef> & Partial<Pick<MissionDelayDef, "duration">>,
): EditResult {
  const list = gateList(draft, kind);
  if (!list[index]) return { error: `Unknown ${kind}.` };
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!name) return { error: "Name cannot be empty." };
    if (list.some((g, i) => i !== index && g.name === name)) {
      return { error: `A ${kind} named "${name}" already exists.` };
    }
    patch = { ...patch, name };
  }
  const next = cloneDraft(draft);
  const target = gateList(next, kind);
  target[index] = { ...target[index], ...patch } as MissionCheckpointDef & MissionDelayDef;
  return { draft: next };
}

// ── Conversion ──

/** Read the editable parts of a mission body. */
export function draftFromMission(mission: Record<string, unknown>): GraphDraft {
  const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
  return cloneDraft({
    tasks: arr<MissionTaskDef>(mission.tasks),
    checkpoints: arr<MissionCheckpointDef>(mission.checkpoints),
    delays: arr<MissionDelayDef>(mission.delays),
  });
}

/** Write the draft back into a mission body, keeping every other field (team, name, …) untouched. */
export function missionFromDraft(base: Record<string, unknown>, draft: GraphDraft): Record<string, unknown> {
  // A task blocked by a checkpoint or delay must also depend on the gate's afterTasks: missions
  // refuse it otherwise ("is in blocksTasks but missing dependsOn"). Drawing task → gate → task
  // only records the gate, so add those dependencies here.
  const required = new Map<string, Set<string>>();
  for (const gate of [...draft.checkpoints, ...draft.delays]) {
    for (const blocked of gate.blocksTasks) {
      const set = required.get(blocked) ?? new Set<string>();
      for (const after of gate.afterTasks) if (after !== blocked) set.add(after);
      required.set(blocked, set);
    }
  }
  const tasks = draft.tasks.map((t) => {
    const extra = required.get(t.title);
    if (!extra || extra.size === 0) return t;
    return { ...t, dependsOn: [...new Set([...(t.dependsOn ?? []), ...extra])] };
  });
  const mission: Record<string, unknown> = { ...base, tasks: tasks.map(cleanTask) };
  if (draft.checkpoints.length > 0) mission.checkpoints = draft.checkpoints;
  else delete mission.checkpoints;
  if (draft.delays.length > 0) mission.delays = draft.delays;
  else delete mission.delays;
  return mission;
}

function cleanTask(task: MissionTaskDef): MissionTaskDef {
  const out = { ...task };
  if (out.dependsOn && out.dependsOn.length === 0) delete out.dependsOn;
  if (!out.assignTo) delete out.assignTo;
  return out;
}

/** Problems that do not block saving but will matter when the playbook runs. */
export function draftWarnings(draft: GraphDraft): string[] {
  const warnings: string[] = [];
  for (const t of draft.tasks) {
    if (!t.assignTo) warnings.push(`"${t.title}" has no agent assigned.`);
    if (!t.description?.trim()) warnings.push(`"${t.title}" has no description.`);
  }
  for (const [kind, gates] of [["Checkpoint", draft.checkpoints], ["Delay", draft.delays]] as const) {
    for (const g of gates) {
      if (g.afterTasks.length === 0 || g.blocksTasks.length === 0) {
        warnings.push(`${kind} "${g.name}" needs at least one incoming and one outgoing task.`);
      }
    }
  }
  return warnings;
}
