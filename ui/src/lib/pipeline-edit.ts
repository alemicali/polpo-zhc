// Pure editing operations for agent pipelines (docs/loops.md).
//
// A pipeline is a tree: lists of steps, nested inside `parallel` branches and
// `switch` cases. Steps and lists are addressed by paths into the pipeline
// object, e.g.
//   ["steps", 2]                                   a top-level step
//   ["steps", 2, "parallel"]                       the branch list of that parallel step
//   ["steps", 1, "switch", "cases", 0, "steps"]    the steps of a switch case
//   ["steps", 1, "switch", "default", "steps"]     the default steps of a switch
// Every operation returns new objects and never mutates its input.

import type { LoopConfig, Pipeline, PipelineStep } from "@polpo-ai/react";

export type PathSeg = string | number;
export type Path = PathSeg[];

export type StepKind = "loop" | "human" | "parallel" | "switch";

type SwitchStep = Extract<PipelineStep, { switch: unknown }>;
type ParallelStep = Extract<PipelineStep, { parallel: unknown }>;

export const ROOT_LIST: Path = ["steps"];

export function stepKind(step: PipelineStep): StepKind {
  if ("loop" in step) return "loop";
  if ("human" in step) return "human";
  if ("parallel" in step) return "parallel";
  return "switch";
}

export function pathKey(path: Path): string {
  return path.join(".");
}

export function parsePathKey(key: string): Path {
  return key.split(".").map((seg) => (/^\d+$/.test(seg) ? Number(seg) : seg));
}

export function getAt<T = unknown>(root: unknown, path: Path): T | undefined {
  let cur: unknown = root;
  for (const seg of path) {
    if (cur === null || cur === undefined || typeof cur !== "object") return undefined;
    cur = (cur as Record<PathSeg, unknown>)[seg];
  }
  return cur as T | undefined;
}

/** Copy the pipeline and return a mutable reference to the container at `path`. */
function withMutation(pipeline: Pipeline, mutate: (copy: Pipeline) => void): Pipeline {
  const copy = structuredClone(pipeline);
  mutate(copy);
  return copy;
}

function listAt(pipeline: Pipeline, listPath: Path): PipelineStep[] {
  const list = getAt<PipelineStep[]>(pipeline, listPath);
  if (!Array.isArray(list)) throw new Error(`No step list at ${pathKey(listPath)}`);
  return list;
}

// ── Steps ──

export function insertStep(pipeline: Pipeline, listPath: Path, index: number, step: PipelineStep): Pipeline {
  return withMutation(pipeline, (copy) => {
    const list = listAt(copy, listPath);
    list.splice(Math.max(0, Math.min(index, list.length)), 0, step);
  });
}

export function removeStep(pipeline: Pipeline, stepPath: Path): Pipeline {
  return withMutation(pipeline, (copy) => {
    listAt(copy, stepPath.slice(0, -1)).splice(stepPath[stepPath.length - 1] as number, 1);
  });
}

/** Move a step within its list by `delta` positions. */
export function moveStep(pipeline: Pipeline, stepPath: Path, delta: number): Pipeline {
  return withMutation(pipeline, (copy) => {
    const list = listAt(copy, stepPath.slice(0, -1));
    const from = stepPath[stepPath.length - 1] as number;
    const to = from + delta;
    if (to < 0 || to >= list.length) return;
    const [step] = list.splice(from, 1);
    list.splice(to, 0, step);
  });
}

/** Merge fields into a step; `undefined` values delete the field. */
export function updateStep(pipeline: Pipeline, stepPath: Path, patch: Record<string, unknown>): Pipeline {
  return withMutation(pipeline, (copy) => {
    const step = getAt<Record<string, unknown>>(copy, stepPath);
    if (!step) throw new Error(`No step at ${pathKey(stepPath)}`);
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete step[key];
      else step[key] = value;
    }
  });
}

/** A new step of the given kind; human steps get a name not used yet in `pipeline`. */
export function newStep(kind: StepKind, loops: Record<string, LoopConfig>, pipeline?: Pipeline): PipelineStep {
  switch (kind) {
    case "loop": return { loop: Object.keys(loops)[0] ?? "" };
    case "human": {
      const taken = new Set<string>();
      if (pipeline) forEachStep(pipeline, (step) => { if ("human" in step) taken.add(step.human); });
      let name = "approval";
      for (let i = 2; taken.has(name); i++) name = `approval-${i}`;
      return { human: name };
    }
    case "parallel": return { parallel: [], join: "all" };
    case "switch": return { switch: { cases: [{ when: "", steps: [] }] } };
  }
}

// ── Switch cases ──

export function addCase(pipeline: Pipeline, switchPath: Path): Pipeline {
  return withMutation(pipeline, (copy) => {
    getAt<SwitchStep>(copy, switchPath)!.switch.cases.push({ when: "", steps: [] });
  });
}

export function removeCase(pipeline: Pipeline, switchPath: Path, index: number): Pipeline {
  return withMutation(pipeline, (copy) => {
    getAt<SwitchStep>(copy, switchPath)!.switch.cases.splice(index, 1);
  });
}

export function updateCaseWhen(pipeline: Pipeline, switchPath: Path, index: number, when: string): Pipeline {
  return withMutation(pipeline, (copy) => {
    getAt<SwitchStep>(copy, switchPath)!.switch.cases[index].when = when;
  });
}

export function setDefaultBranch(pipeline: Pipeline, switchPath: Path, enabled: boolean): Pipeline {
  return withMutation(pipeline, (copy) => {
    const sw = getAt<SwitchStep>(copy, switchPath)!.switch;
    if (enabled) sw.default ??= { steps: [] };
    else delete sw.default;
  });
}

// ── Loops ──

export function uniqueLoopName(loops: Record<string, LoopConfig>, base = "loop"): string {
  if (!(base in loops)) return base;
  let i = 2;
  while (`${base}-${i}` in loops) i++;
  return `${base}-${i}`;
}

/** Visit every step of the pipeline with its path. */
export function forEachStep(pipeline: Pipeline, visit: (step: PipelineStep, path: Path) => void): void {
  const walk = (list: PipelineStep[], listPath: Path) => {
    list.forEach((step, i) => {
      const path = [...listPath, i];
      visit(step, path);
      if ("parallel" in step) walk(step.parallel, [...path, "parallel"]);
      if ("switch" in step) {
        step.switch.cases.forEach((c, ci) => walk(c.steps, [...path, "switch", "cases", ci, "steps"]));
        if (step.switch.default) walk(step.switch.default.steps, [...path, "switch", "default", "steps"]);
      }
    });
  };
  walk(pipeline.steps, ROOT_LIST);
}

export function loopUsages(pipeline: Pipeline | undefined, name: string): number {
  if (!pipeline) return 0;
  let n = 0;
  forEachStep(pipeline, (step) => { if ("loop" in step && step.loop === name) n++; });
  return n;
}

export type LoopEdit =
  | { loops: Record<string, LoopConfig>; pipeline: Pipeline | undefined; error?: undefined }
  | { error: string; loops?: undefined; pipeline?: undefined };

/** Rename a loop and every `loop` step that uses it. */
export function renameLoop(loops: Record<string, LoopConfig>, pipeline: Pipeline | undefined, from: string, to: string): LoopEdit {
  const name = to.trim();
  if (!name) return { error: "Loop name cannot be empty." };
  if (name === from) return { loops, pipeline };
  if (name in loops) return { error: `A loop named "${name}" already exists.` };
  // Keep key order: the first loop is the default for new loop steps.
  const nextLoops = Object.fromEntries(Object.entries(loops).map(([k, v]) => [k === from ? name : k, v]));
  let nextPipeline = pipeline;
  if (pipeline) {
    nextPipeline = structuredClone(pipeline);
    forEachStep(nextPipeline, (step) => { if ("loop" in step && step.loop === from) step.loop = name; });
  }
  return { loops: nextLoops, pipeline: nextPipeline };
}

/** Delete a loop; refused while a step still uses it. */
export function deleteLoop(loops: Record<string, LoopConfig>, pipeline: Pipeline | undefined, name: string): LoopEdit {
  const used = loopUsages(pipeline, name);
  if (used > 0) return { error: `Loop "${name}" is used by ${used} step${used === 1 ? "" : "s"}. Remove those steps first.` };
  const { [name]: _removed, ...rest } = loops;
  return { loops: rest, pipeline };
}

// ── Validation ──

export interface PipelineProblem {
  /** Path of the step (or list) the problem belongs to; empty for global problems. */
  path: Path;
  message: string;
}

/** Problems that would make the server or the runtime reject the pipeline. */
export function validatePipeline(pipeline: Pipeline, loops: Record<string, LoopConfig>): PipelineProblem[] {
  const problems: PipelineProblem[] = [];
  if (pipeline.steps.length === 0) problems.push({ path: ROOT_LIST, message: "The pipeline has no steps." });

  // Human decisions are stored at context.human.<name>: names must not collide.
  const humanNames = new Map<string, number>();
  forEachStep(pipeline, (step) => {
    if ("human" in step && step.human.trim()) humanNames.set(step.human, (humanNames.get(step.human) ?? 0) + 1);
  });

  forEachStep(pipeline, (step, path) => {
    if (step.when !== undefined && !step.when.trim()) problems.push({ path, message: "The guard (when) is empty." });
    if ("loop" in step) {
      if (!step.loop) problems.push({ path, message: "Choose a loop for this step." });
      else if (!(step.loop in loops)) problems.push({ path, message: `Unknown loop "${step.loop}".` });
    } else if ("human" in step) {
      if (!step.human.trim()) problems.push({ path, message: "The human step needs a name." });
      else if ((humanNames.get(step.human) ?? 0) > 1) problems.push({ path, message: `Another human step is also named "${step.human}".` });
      if (step.notify?.some((n) => !n.trim())) problems.push({ path, message: "Notify channels cannot be empty." });
    } else if ("parallel" in step) {
      const p = step as ParallelStep;
      if (p.parallel.length === 0) problems.push({ path, message: "Add at least one branch." });
      if (typeof p.join === "number" && (!Number.isInteger(p.join) || p.join < 1)) {
        problems.push({ path, message: "Join must be a positive whole number." });
      } else if (typeof p.join === "number" && p.join > p.parallel.length) {
        problems.push({ path, message: `Join waits for ${p.join} branches but there are ${p.parallel.length}.` });
      }
    } else {
      const s = (step as SwitchStep).switch;
      if (s.cases.length === 0) problems.push({ path, message: "Add at least one case." });
      s.cases.forEach((c, i) => {
        if (!c.when.trim()) problems.push({ path, message: `Case ${i + 1} has no condition.` });
        if (c.steps.length === 0) problems.push({ path, message: `Case ${i + 1} has no steps.` });
      });
      if (s.default && s.default.steps.length === 0) problems.push({ path, message: "The default branch has no steps." });
    }
  });

  for (const [name, loop] of Object.entries(loops)) {
    if (loop.maxTurns !== undefined && (!Number.isInteger(loop.maxTurns) || loop.maxTurns < 1)) {
      problems.push({ path: [], message: `Loop "${name}": max turns must be a positive whole number.` });
    }
    if (loop.tools?.some((t) => !t.trim())) problems.push({ path: [], message: `Loop "${name}": tool names cannot be empty.` });
  }
  return problems;
}
