/**
 * decide from a task run (runner.ts, any engine: Polpo's, a harness, a CLI): the runner is a
 * separate process without the instance's decision service, so the tool asks the orchestrator over
 * the notification socket. The server takes the agent, the task and the run from the run record
 * (never from the request), checks the agent has `decide`, and decides with its own service: same
 * validation, thresholds and uncertain answers, recorded in the decision log with the agent as
 * caller and the task and run as its origin.
 */
import type { AgentConfig, Task } from "@polpo-ai/core";
import type { RunRecord } from "./run-store.js";
import { requestOverSocket } from "./notification.js";
import type { DecideResult, DecisionService } from "../decisions/service.js";
import { agentHasDecideTool, type DecisionAccess } from "../tools/decision-tools.js";

/** A gateway call waits up to 60 s (DecisionService), plus the uncalibrated fallback's follow-up. */
const DECIDE_TIMEOUT_MS = 150_000;

export interface DecideWireRequest {
  type: "decide";
  runId: string;
  state: unknown;
  questions: Array<Record<string, unknown>>;
}

export type DecideWireReply = { ok: true; result: DecideResult } | { ok: false; error: string };

/** Runner side: the decide tool's access, over the notification socket. */
export function socketDecide(socketPath: string, runId: string): DecisionAccess {
  return {
    decide: (input) => requestOverSocket(socketPath, { type: "decide", runId, state: input.state, questions: input.questions }, DECIDE_TIMEOUT_MS),
  };
}

/** Server side: one decision of a task run, as the run's agent. */
export async function handleDecideWire(
  msg: DecideWireRequest,
  deps: {
    service: Pick<DecisionService, "decide"> | undefined;
    run(runId: string): Promise<Pick<RunRecord, "agentName" | "taskId" | "status" | "config"> | undefined>;
    task(taskId: string): Promise<Task | undefined>;
    /** The agent config the run uses (its version and the task's tool scope). */
    agentFor(run: Pick<RunRecord, "agentName" | "config">, task: Task | undefined): Promise<AgentConfig | undefined>;
  },
): Promise<DecideWireReply> {
  if (!deps.service) return { ok: false, error: "decisions are not available on this server" };
  const run = typeof msg.runId === "string" ? await deps.run(msg.runId) : undefined;
  if (!run || run.status !== "running") return { ok: false, error: "this run is not running" };
  const task = await deps.task(run.taskId).catch(() => undefined);
  const agent = await deps.agentFor(run, task);
  if (!agent || agent.name !== run.agentName) return { ok: false, error: `agent "${run.agentName}" not found` };
  if (!agentHasDecideTool(agent)) return { ok: false, error: "decide is not among this agent's tools" };
  try {
    const result = await deps.service.decide({ state: msg.state, questions: msg.questions }, {
      kind: "agent", id: run.agentName, label: `task ${run.taskId}`, taskId: run.taskId, runId: msg.runId,
    });
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
