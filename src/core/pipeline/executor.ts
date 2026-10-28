/**
 * Deterministic pipeline execution for agents that declare `loops` and a
 * `pipeline` (see docs/loops.md).
 *
 * The executor only decides *what* runs and in which order; running a loop
 * (an LLM session) and asking a human are injected, so this module has no
 * I/O and is fully testable.
 *
 * Shared context bag:
 *   - Loops write keys into it (the adapter turns the agent's `context`
 *     outcomes into a patch that is deep-merged here).
 *   - A loop's structured output is stored at `context.outputs.<loop>`.
 *   - A human step's decision is stored at `context.human.<name>`
 *     as `{ approved, note }`.
 *   - `when` guards and `stopWhen` conditions read from it.
 *
 * Step paths match the pipeline object (and the editor): "steps.0",
 * "steps.1.parallel.0", "steps.2.switch.cases.0.steps.1",
 * "steps.2.switch.default.steps.0".
 *
 * Loop iterations: a loop runs once; if its output does not match
 * `output.schema` or its `stopWhen` condition is still false, it runs again
 * with feedback explaining why, up to `maxLoopAttempts` times in total.
 */

import type {
  HumanStep,
  LoopConfig,
  LoopStep,
  ParallelStep,
  Pipeline,
  PipelineStep,
  SwitchStep,
} from "../types.js";
import { evaluateCondition } from "./expression.js";
import { validateSchema } from "./schema.js";

export type PipelineContext = Record<string, unknown>;

export interface LoopRunRequest {
  loopName: string;
  loop: LoopConfig;
  /** Snapshot of the shared context when the attempt starts. */
  context: PipelineContext;
  /** 1-based attempt number. */
  attempt: number;
  /** Why the previous attempt was not accepted (schema errors, unmet stop condition). */
  feedback?: string;
  signal: AbortSignal;
}

export interface LoopRunResult {
  /** False when the LLM session itself failed (crash, max turns, killed). */
  ok: boolean;
  /** Keys the loop wrote into the shared context. */
  contextPatch?: Record<string, unknown>;
  /** Structured output registered by the loop. */
  output?: unknown;
  error?: string;
}

export interface HumanRequest {
  name: string;
  step: HumanStep;
  /** Path of the human step. */
  path: string;
  context: PipelineContext;
  signal: AbortSignal;
  /** Called once the approval request exists, with its id. */
  onRequested?(approvalId: string): void;
}

export interface HumanDecision {
  approved: boolean;
  note?: string;
}

export type PipelineEvent =
  | { type: "step:start"; path: string; kind: StepKind; name?: string }
  | { type: "step:skip"; path: string; kind: StepKind; name?: string }
  | { type: "step:end"; path: string; kind: StepKind; name?: string; ok: boolean; error?: string }
  /** The step was stopped before finishing: the run was cancelled or a parallel join was already decided. */
  | { type: "step:cancel"; path: string; kind: StepKind; name?: string }
  | { type: "human:requested"; path: string; name: string; approvalId: string }
  | { type: "loop:attempt"; path: string; loop: string; attempt: number; feedback?: string };

export type StepKind = "loop" | "parallel" | "switch" | "human";

export interface PipelineDeps {
  runLoop(req: LoopRunRequest): Promise<LoopRunResult>;
  requestHuman(req: HumanRequest): Promise<HumanDecision>;
  onEvent?(event: PipelineEvent): void;
  /** Total attempts per loop when output or stop condition is not satisfied. Default 3. */
  maxLoopAttempts?: number;
}

export interface PipelineResult {
  ok: boolean;
  context: PipelineContext;
  error?: string;
}

class StepFailure extends Error {}
class Cancelled extends Error {}

export const DEFAULT_MAX_LOOP_ATTEMPTS = 3;

// ── Context helpers ──

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Deep-merge `patch` into `target` in place: objects merge, everything else replaces. */
export function mergeContext(target: Record<string, unknown>, patch: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(patch)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
    const existing = target[key];
    if (isPlainObject(existing) && isPlainObject(value)) mergeContext(existing, value);
    else target[key] = isPlainObject(value) ? structuredClone(value) : value;
  }
}

function setIn(context: PipelineContext, bucket: string, key: string, value: unknown): void {
  const container = isPlainObject(context[bucket]) ? (context[bucket] as Record<string, unknown>) : {};
  container[key] = value;
  context[bucket] = container;
}

function stepKind(step: PipelineStep): StepKind {
  if ("loop" in step) return "loop";
  if ("parallel" in step) return "parallel";
  if ("switch" in step) return "switch";
  return "human";
}

function stepName(step: PipelineStep): string | undefined {
  if ("loop" in step) return step.loop;
  if ("human" in step) return step.human;
  return undefined;
}

function condition(expression: string, context: PipelineContext): boolean {
  try {
    return evaluateCondition(expression, context);
  } catch (err) {
    throw new StepFailure(err instanceof Error ? err.message : String(err));
  }
}

// ── Executor ──

/**
 * Run a pipeline to completion. Never throws: failures and cancellation are
 * reported in the result.
 */
export async function executePipeline(
  pipeline: Pipeline,
  loops: Record<string, LoopConfig>,
  deps: PipelineDeps,
  options: { context?: PipelineContext; signal?: AbortSignal } = {},
): Promise<PipelineResult> {
  const context: PipelineContext = options.context ?? {};
  const signal = options.signal ?? new AbortController().signal;
  const maxAttempts = Math.max(1, deps.maxLoopAttempts ?? DEFAULT_MAX_LOOP_ATTEMPTS);

  const checkCancelled = (s: AbortSignal) => {
    if (s.aborted) throw new Cancelled("Pipeline cancelled");
  };

  async function runSteps(steps: PipelineStep[], path: string, s: AbortSignal): Promise<void> {
    for (let i = 0; i < steps.length; i++) {
      checkCancelled(s);
      await runStep(steps[i], `${path}.${i}`, s);
    }
  }

  async function runStep(step: PipelineStep, path: string, s: AbortSignal): Promise<void> {
    const kind = stepKind(step);
    const name = stepName(step);
    if (step.when !== undefined && !condition(step.when, context)) {
      deps.onEvent?.({ type: "step:skip", path, kind, name });
      return;
    }
    deps.onEvent?.({ type: "step:start", path, kind, name });
    try {
      if ("loop" in step) await runLoopStep(step, path, s);
      else if ("parallel" in step) await runBranches(step.parallel, (i) => `${path}.parallel.${i}`, step.join, s);
      else if ("switch" in step) await runSwitch(step, path, s);
      else await runHuman(step, path, s);
      deps.onEvent?.({ type: "step:end", path, kind, name, ok: true });
    } catch (err) {
      if (err instanceof Cancelled) deps.onEvent?.({ type: "step:cancel", path, kind, name });
      else deps.onEvent?.({ type: "step:end", path, kind, name, ok: false, error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  }

  async function runLoopStep(step: LoopStep, path: string, s: AbortSignal): Promise<void> {
    const loop = loops[step.loop];
    if (!loop) throw new StepFailure(`Unknown loop "${step.loop}"`);

    let feedback: string | undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      checkCancelled(s);
      deps.onEvent?.({ type: "loop:attempt", path, loop: step.loop, attempt, feedback });
      const result = await deps.runLoop({
        loopName: step.loop,
        loop,
        context: structuredClone(context),
        attempt,
        feedback,
        signal: s,
      });
      checkCancelled(s);
      if (!result.ok) throw new StepFailure(`Loop "${step.loop}" failed: ${result.error ?? "unknown error"}`);

      if (result.contextPatch) mergeContext(context, result.contextPatch);

      const problems: string[] = [];
      if (loop.output?.schema !== undefined) {
        if (result.output === undefined) {
          problems.push("No structured output was registered.");
        } else {
          const errors = validateSchema(result.output, loop.output.schema);
          if (errors.length > 0) problems.push(`The output does not match the schema: ${errors.join("; ")}.`);
        }
      }
      if (result.output !== undefined) setIn(context, "outputs", step.loop, result.output);
      if (loop.stopWhen?.expression && problems.length === 0 && !condition(loop.stopWhen.expression, context)) {
        problems.push(`The stop condition \`${loop.stopWhen.expression}\` is not met yet.`);
      }

      if (problems.length === 0) return;
      feedback = problems.join(" ");
    }
    throw new StepFailure(`Loop "${step.loop}" did not finish after ${maxAttempts} attempts: ${feedback}`);
  }

  async function runBranches(branches: PipelineStep[], pathOf: (i: number) => string, join: ParallelStep["join"], s: AbortSignal): Promise<void> {
    const total = branches.length;
    const needed = join === undefined || join === "all" ? total
      : join === "any" ? 1
      : Math.min(join, total);

    // Each branch gets its own controller so the losers can be stopped once
    // the join is satisfied (or can no longer be).
    const controllers = branches.map(() => new AbortController());
    const onParentAbort = () => controllers.forEach((c) => c.abort());
    s.addEventListener("abort", onParentAbort, { once: true });

    let succeeded = 0;
    let failed = 0;
    const errors: string[] = [];

    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (fn: () => void) => {
          if (settled) return;
          settled = true;
          controllers.forEach((c) => c.abort());
          fn();
        };
        branches.forEach((branch, i) => {
          runStep(branch, pathOf(i), controllers[i].signal).then(
            () => {
              succeeded++;
              if (succeeded >= needed) finish(resolve);
              else if (succeeded + failed === total) finish(() => reject(new StepFailure(errors.join("; "))));
            },
            (err) => {
              if (err instanceof Cancelled && settled) return;
              if (err instanceof Cancelled) { finish(() => reject(err)); return; }
              failed++;
              errors.push(err instanceof Error ? err.message : String(err));
              if (total - failed < needed) {
                finish(() => reject(new StepFailure(`Parallel step needs ${needed} of ${total} branches: ${errors.join("; ")}`)));
              }
            },
          );
        });
      });
    } finally {
      s.removeEventListener("abort", onParentAbort);
    }
  }

  async function runSwitch(step: SwitchStep, path: string, s: AbortSignal): Promise<void> {
    const cases = step.switch.cases;
    for (let i = 0; i < cases.length; i++) {
      if (condition(cases[i].when, context)) {
        await runSteps(cases[i].steps, `${path}.switch.cases.${i}.steps`, s);
        return;
      }
    }
    if (step.switch.default) await runSteps(step.switch.default.steps, `${path}.switch.default.steps`, s);
  }

  async function runHuman(step: HumanStep, path: string, s: AbortSignal): Promise<void> {
    const decision = await deps.requestHuman({
      name: step.human,
      step,
      path,
      context: structuredClone(context),
      signal: s,
      onRequested: (approvalId) => deps.onEvent?.({ type: "human:requested", path, name: step.human, approvalId }),
    });
    checkCancelled(s);
    setIn(context, "human", step.human, { approved: decision.approved, note: decision.note });
    if (!decision.approved) {
      throw new StepFailure(`Human step "${step.human}" was rejected${decision.note ? `: ${decision.note}` : ""}`);
    }
  }

  try {
    if (pipeline.mode === "parallel") await runBranches(pipeline.steps, (i) => `steps.${i}`, "all", signal);
    else await runSteps(pipeline.steps, "steps", signal);
    return { ok: true, context };
  } catch (err) {
    return { ok: false, context, error: err instanceof Error ? err.message : String(err) };
  }
}
