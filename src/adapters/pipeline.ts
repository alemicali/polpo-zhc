/**
 * Pipeline adapter: runs an agent's deterministic `pipeline` (see
 * docs/loops.md) for a task, presenting the whole run to the runner as a
 * single AgentHandle.
 *
 * Each loop attempt is a fresh engine session of the same agent, with the
 * loop's own system prompt, tools, model, reasoning and turn limit. The loop
 * talks to the pipeline through two kinds of `register_outcome` calls:
 *   - label "context" (type json): keys merged into the shared context bag
 *   - label "output"  (type json): the loop's structured output
 * Every other outcome is a regular task outcome.
 */

import { nanoid } from "nanoid";
import type { AgentActivity, AgentConfig, LoopConfig, PipelineRunState, PipelineStep, Task, TaskOutcome, TaskResult } from "../core/types.js";
import type { AgentHandle, SpawnContext } from "../core/adapter.js";
import { spawnEngine, createActivity } from "./engine.js";
import {
  executePipeline,
  mergeContext,
  type HumanDecision,
  type HumanRequest,
  type LoopRunRequest,
  type LoopRunResult,
  type PipelineContext,
  type PipelineEvent,
} from "../core/pipeline/executor.js";

export const CONTEXT_OUTCOME_LABEL = "context";
export const OUTPUT_OUTCOME_LABEL = "output";

/** Above this size the live context is left out of the activity snapshots (it is still in the final outcome). */
const MAX_LIVE_CONTEXT_CHARS = 16_000;

/** Apply one executor event to the run state shown in the UI. */
export function applyPipelineEvent(state: PipelineRunState, e: PipelineEvent, now = new Date().toISOString()): void {
  const prev = state.steps[e.path];
  switch (e.type) {
    case "step:start":
      state.steps[e.path] = { kind: e.kind, name: e.name, status: e.kind === "human" ? "waiting" : "running", startedAt: now };
      break;
    case "step:skip":
      state.steps[e.path] = { kind: e.kind, name: e.name, status: "skipped", endedAt: now };
      break;
    case "step:end":
      state.steps[e.path] = { ...prev, kind: e.kind, name: e.name, status: e.ok ? "done" : "failed", error: e.error, endedAt: now };
      break;
    case "step:cancel":
      state.steps[e.path] = { ...prev, kind: e.kind, name: e.name, status: "cancelled", endedAt: now };
      break;
    case "loop:attempt":
      if (prev) state.steps[e.path] = { ...prev, attempt: e.attempt, feedback: e.feedback };
      break;
    case "human:requested":
      if (prev) state.steps[e.path] = { ...prev, approvalId: e.approvalId };
      break;
  }
}

export interface PipelineSpawnOptions {
  /** Asks a human to approve a `human` step; resolves with the decision. */
  requestHuman: (req: HumanRequest) => Promise<HumanDecision>;
  /** Engine factory — overridable in tests. */
  spawn?: typeof spawnEngine;
  maxLoopAttempts?: number;
}

/** Whether this agent's tasks should run through its pipeline instead of a single session. */
export function hasPipeline(agent: AgentConfig): boolean {
  return !!agent.pipeline && Array.isArray(agent.pipeline.steps) && agent.pipeline.steps.length > 0;
}

/**
 * Whether any step of the pipeline runs the agent (a loop step, at any depth). Without one the
 * task ends as done after the human steps alone, with no work done: allowed, but worth a warning.
 */
export function pipelineRunsAgent(steps: PipelineStep[]): boolean {
  return steps.some((step) => {
    if ("loop" in step) return true;
    if ("parallel" in step) return pipelineRunsAgent(step.parallel);
    if ("switch" in step) {
      return step.switch.cases.some((c) => pipelineRunsAgent(c.steps)) || pipelineRunsAgent(step.switch.default?.steps ?? []);
    }
    return false;
  });
}

export const NO_LOOP_WARNING = "Warning: no step of this pipeline runs the agent, so the task ends after the approvals alone, without any work done.";

/** Agent config for one loop: the loop's settings override the agent's. */
export function agentForLoop(agent: AgentConfig, loopName: string, loop: LoopConfig): AgentConfig {
  const systemPrompt = [agent.systemPrompt, loop.systemPrompt].filter(Boolean).join("\n\n");
  return {
    ...agent,
    systemPrompt: systemPrompt || undefined,
    allowedTools: loop.tools ?? agent.allowedTools,
    model: loop.model ?? agent.model,
    reasoning: (loop.reasoning ?? agent.reasoning) as AgentConfig["reasoning"],
    maxTurns: loop.maxTurns ?? agent.maxTurns,
    // A loop session runs a single step: it must not start another pipeline.
    loops: undefined,
    pipeline: undefined,
    runtime: undefined,
    name: agent.name,
    role: agent.role ? `${agent.role} — loop "${loop.name ?? loopName}"` : agent.role,
  };
}

/** Task description for one loop attempt: the task plus the pipeline contract. */
export function taskForLoop(task: Task, req: Pick<LoopRunRequest, "loopName" | "loop" | "context" | "attempt" | "feedback">): Task {
  const lines = [
    task.description,
    "",
    "---",
    `## Pipeline step: loop "${req.loop.name ?? req.loopName}"${req.attempt > 1 ? ` (attempt ${req.attempt})` : ""}`,
    "",
    "You are running one step of a deterministic pipeline. Do only this step's work.",
    "",
    "Shared context (written by earlier steps):",
    "```json",
    JSON.stringify(req.context, null, 2),
    "```",
    "",
    "To write values into the shared context for later steps, call:",
    `  register_outcome({type: 'json', label: '${CONTEXT_OUTCOME_LABEL}', data: { ...keys to set... }})`,
    "Objects are merged into the existing context; other values replace it.",
  ];
  if (req.loop.output?.schema !== undefined) {
    lines.push(
      "",
      "This step must produce structured output. Register it with:",
      `  register_outcome({type: 'json', label: '${OUTPUT_OUTCOME_LABEL}', data: <your output>})`,
      "The output must match this JSON schema:",
      "```json",
      JSON.stringify(req.loop.output.schema, null, 2),
      "```",
    );
  }
  if (req.loop.stopWhen?.expression) {
    lines.push("", `This step is complete only when this condition holds on the shared context: \`${req.loop.stopWhen.expression}\``);
  }
  if (req.feedback) {
    lines.push("", `Your previous attempt was not accepted: ${req.feedback}`, "Fix this in this attempt.");
  }
  return { ...task, description: lines.join("\n") };
}

/** Split a loop session's outcomes into pipeline data and regular task outcomes. */
export function splitOutcomes(outcomes: TaskOutcome[] | undefined): {
  contextPatch?: Record<string, unknown>;
  output?: unknown;
  taskOutcomes: TaskOutcome[];
} {
  let contextPatch: Record<string, unknown> | undefined;
  let output: unknown;
  const taskOutcomes: TaskOutcome[] = [];
  for (const o of outcomes ?? []) {
    if (o.type === "json" && o.label === CONTEXT_OUTCOME_LABEL) {
      if (o.data && typeof o.data === "object" && !Array.isArray(o.data)) {
        contextPatch ??= {};
        mergeContext(contextPatch, o.data as Record<string, unknown>);
      }
    } else if (o.type === "json" && o.label === OUTPUT_OUTCOME_LABEL) {
      output = o.data;
    } else {
      taskOutcomes.push(o);
    }
  }
  return { contextPatch, output, taskOutcomes };
}

function addActivity(total: AgentActivity, part: AgentActivity): void {
  total.toolCalls += part.toolCalls;
  total.totalTokens += part.totalTokens;
  for (const f of part.filesCreated) if (!total.filesCreated.includes(f)) total.filesCreated.push(f);
  for (const f of part.filesEdited) if (!total.filesEdited.includes(f)) total.filesEdited.push(f);
  if (part.lastTool) total.lastTool = part.lastTool;
  if (part.lastFile) total.lastFile = part.lastFile;
  if (part.summary) total.summary = part.summary;
  if (part.compactions) total.compactions = (total.compactions ?? 0) + part.compactions;
}

function describeEvent(e: PipelineEvent): string {
  switch (e.type) {
    case "step:start": return `▶ ${e.kind}${e.name ? ` "${e.name}"` : ""} (${e.path})`;
    case "step:skip": return `⏭ ${e.kind}${e.name ? ` "${e.name}"` : ""} skipped — guard is false (${e.path})`;
    case "step:end": return `${e.ok ? "✔" : "✖"} ${e.kind}${e.name ? ` "${e.name}"` : ""}${e.error ? `: ${e.error}` : ""}`;
    case "loop:attempt": return `↻ loop "${e.loop}" attempt ${e.attempt}${e.feedback ? ` — ${e.feedback}` : ""}`;
    case "step:cancel": return `■ ${e.kind}${e.name ? ` "${e.name}"` : ""} stopped (${e.path})`;
    case "human:requested": return `⏸ waiting for approval "${e.name}" (${e.approvalId})`;
  }
}

/**
 * Run the agent's pipeline for `task`. Returns a handle the runner drives
 * exactly like a single engine session.
 */
export function spawnPipeline(
  agent: AgentConfig,
  task: Task,
  cwd: string,
  ctx: SpawnContext | undefined,
  options: PipelineSpawnOptions,
): AgentHandle {
  const spawn = options.spawn ?? spawnEngine;
  const start = Date.now();
  const abort = new AbortController();
  const finished = createActivity();
  const running = new Set<AgentHandle>();
  const outcomes: TaskOutcome[] = [];
  const log: string[] = [];
  let alive = true;
  // Shared with the executor, which mutates it in place: read live for the UI.
  const context: PipelineContext = {};
  const runState: PipelineRunState = {
    status: "running",
    pipeline: structuredClone(agent.pipeline!),
    steps: {},
    startedAt: new Date(start).toISOString(),
  };
  const snapshotState = (): PipelineRunState => {
    const json = JSON.stringify(context);
    const snapshot: PipelineRunState = { ...runState, steps: structuredClone(runState.steps) };
    if (json.length <= MAX_LIVE_CONTEXT_CHARS) snapshot.context = JSON.parse(json);
    else snapshot.contextTruncated = true;
    return snapshot;
  };

  // Loop sessions start fresh: a saved conversation belongs to a single session.
  const loopCtx: SpawnContext | undefined = ctx ? { ...ctx, resumeMessages: undefined, continuation: undefined } : undefined;

  const handle: AgentHandle = {
    agentName: agent.name,
    taskId: task.id,
    startedAt: new Date(start).toISOString(),
    pid: 0,
    // Live activity: finished loops plus the ones running now.
    get activity(): AgentActivity {
      const total: AgentActivity = { ...finished, filesCreated: [...finished.filesCreated], filesEdited: [...finished.filesEdited] };
      for (const h of running) addActivity(total, h.activity);
      total.lastUpdate = new Date().toISOString();
      total.pipeline = snapshotState();
      return total;
    },
    done: Promise.resolve() as unknown as Promise<TaskResult>,
    outcomes,
    isAlive: () => alive,
    kill: () => {
      abort.abort();
      for (const h of running) h.kill();
    },
    steer: (message, directionId) => {
      for (const h of running) h.steer?.(message, directionId);
    },
    followUp: (message, directionId) => {
      for (const h of running) h.followUp?.(message, directionId);
    },
  };

  const note = (line: string) => {
    log.push(line);
    handle.onTranscript?.({ type: "pipeline", text: line });
  };

  const runLoop = async (req: LoopRunRequest): Promise<LoopRunResult> => {
    let child: AgentHandle;
    try {
      child = spawn(agentForLoop(agent, req.loopName, req.loop), taskForLoop(task, req), cwd, loopCtx);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    running.add(child);
    child.onTranscript = (entry) => handle.onTranscript?.({ ...entry, pipelineLoop: req.loopName, pipelineAttempt: req.attempt });
    const onAbort = () => child.kill();
    req.signal.addEventListener("abort", onAbort, { once: true });
    try {
      const result = await child.done;
      const split = splitOutcomes(child.outcomes);
      outcomes.push(...split.taskOutcomes);
      if (result.exitCode !== 0) {
        return { ok: false, error: (result.stderr || "").trim().split("\n").slice(-3).join(" ") || `exit code ${result.exitCode}` };
      }
      return { ok: true, contextPatch: split.contextPatch, output: split.output };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      req.signal.removeEventListener("abort", onAbort);
      running.delete(child);
      addActivity(finished, child.activity);
      if (child.sessionId) finished.sessionId = child.sessionId;
    }
  };

  handle.done = (async (): Promise<TaskResult> => {
    // Let the runner attach onTranscript before the first event.
    await Promise.resolve();
    note(`Pipeline started for agent "${agent.name}"`);
    if (!pipelineRunsAgent(agent.pipeline!.steps)) note(`⚠ ${NO_LOOP_WARNING}`);
    const result = await executePipeline(agent.pipeline!, agent.loops ?? {}, {
      runLoop,
      requestHuman: options.requestHuman,
      onEvent: (e) => { applyPipelineEvent(runState, e); note(describeEvent(e)); },
      maxLoopAttempts: options.maxLoopAttempts,
    }, { signal: abort.signal, context });
    runState.status = result.ok ? "completed" : "failed";
    runState.error = result.error;
    runState.endedAt = new Date().toISOString();
    alive = false;
    note(result.ok ? "Pipeline completed" : `Pipeline failed: ${result.error}`);
    outcomes.push({
      id: nanoid(),
      type: "json",
      label: "Pipeline context",
      data: result.context,
      producedBy: "pipeline",
      producedAt: new Date().toISOString(),
    });

    const contextJson = JSON.stringify(result.context, null, 2);
    return {
      exitCode: result.ok ? 0 : 1,
      stdout: [...log, "", "Final context:", contextJson].join("\n"),
      stderr: result.ok ? "" : (result.error ?? "Pipeline failed"),
      duration: Date.now() - start,
    };
  })();

  return handle;
}
