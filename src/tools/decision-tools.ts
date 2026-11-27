/**
 * The agents' `decide` tool: a cheap typed judgment with probabilities from the instance's decision
 * model (decide(), src/decisions/service.ts) instead of reasoning it out in the chat — "is this
 * email a complaint?", "which team owns this ticket?", "how urgent is it (1–5)?", "rank these
 * leads". Given with `decide` in the agent's allowedTools; every call is in the decision log with
 * the agent as caller.
 *
 * Where the decision service lives: in the server process (chats, agent tests) the instance's
 * service is used directly; a task run (runner.ts, a separate process, any engine) asks the server
 * over the notification socket (core/decision-bridge.ts), which takes the agent, task and run from
 * the run record.
 */
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { describeDecisionAnswer } from "@polpo-ai/core";
import { decisionServiceFor, type DecideResult } from "../decisions/service.js";

/** How the decide tool reaches the decision service. */
export interface DecisionAccess {
  decide(input: { state: unknown; questions: Array<Record<string, unknown>> }): Promise<{ ok: true; result: DecideResult } | { ok: false; error: string }>;
}

/** The agent has the decide tool (allowedTools "decide"). */
export function agentHasDecideTool(agent: { allowedTools?: string[] }): boolean {
  return !!agent.allowedTools?.some((t) => t === "decide");
}

export const DECISION_TOOL_NAMES = ["decide"] as const;

const Question = Type.Object({
  name: Type.String({ description: "A name for the question (letters, digits, _ and -), unique in the call" }),
  type: Type.Union([Type.Literal("predicate"), Type.Literal("choice"), Type.Literal("score"), Type.Literal("rank")], {
    description: "predicate: yes/no → P(yes); choice: one of the options; score: a level on an ordered scale; rank: sort items",
  }),
  instructions: Type.String({ description: "What to decide, e.g. \"Is the customer asking for a refund?\"" }),
  choices: Type.Optional(Type.Array(Type.Object({ value: Type.String(), description: Type.Optional(Type.String()) }), { description: "choice: 2–20 options" })),
  levels: Type.Optional(Type.Array(Type.String(), { description: "score (rank: the rating scale): 2–11 levels, lowest first" })),
  items: Type.Optional(Type.Array(Type.String(), { description: "rank: 2–20 items to sort" })),
  threshold: Type.Optional(Type.Number({ minimum: 0, maximum: 1, description: "Below this confidence the answer is marked uncertain" })),
});

/**
 * The decide tool when the agent has it (allowedTools "decide"). `access`: a task run's way to the
 * server's service (over the socket); without it, the service of this process.
 */
export function createDecisionTools(
  polpoDir: string, agent: string, allowedTools: string[] | undefined,
  context: { taskId?: string; missionId?: string; runId?: string } = {}, access?: DecisionAccess,
): AgentTool<any>[] {
  if (!agentHasDecideTool({ allowedTools })) return [];
  const tool: AgentTool<any> = {
    name: "decide",
    label: "Decide",
    description: "Ask the decision model typed questions about a state (text or JSON) and get calibrated probabilities: cheaper and more reliable than judging it yourself. "
      + "Use it for classifications, yes/no checks, ratings and rankings. Answers below a threshold are marked uncertain: then ask a person or look closer.",
    parameters: Type.Object({
      state: Type.Union([Type.String(), Type.Record(Type.String(), Type.Any())], { description: "What the questions are about: the text, or a JSON object" }),
      questions: Type.Array(Question, { minItems: 1, maxItems: 16 }),
    }),
    async execute(_id: string, params: { state: unknown; questions: Array<Record<string, unknown>> }) {
      let r: DecideResult;
      try {
        if (access) {
          const reply = await access.decide(params);
          if (!reply.ok) return { content: [{ type: "text" as const, text: `Error: ${reply.error}` }], details: { error: true } };
          r = reply.result;
        } else {
          const service = decisionServiceFor(polpoDir);
          if (!service) return { content: [{ type: "text" as const, text: "Error: decisions are not available on this server" }], details: { error: true } };
          r = await service.decide(params, {
            kind: "agent", id: agent,
            ...(context.taskId ? { label: `task ${context.taskId}`, taskId: context.taskId } : {}), ...(context.runId ? { runId: context.runId } : {}),
          });
        }
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], details: { error: true } };
      }
      const lines = r.answers.map((a) => `- ${describeDecisionAnswer(a)}`);
      const text = [
        ...lines,
        `(${r.model}${r.calibrated ? "" : ", uncalibrated: no decision model is configured, Polpo's model answered"} · $${r.costUsd.toFixed(5)} · decision ${r.id})`,
        "",
        JSON.stringify(r.answers),
      ].join("\n");
      return { content: [{ type: "text" as const, text }], details: { decisionId: r.id, uncertain: r.uncertain, calibrated: r.calibrated } };
    },
  };
  return [tool];
}
