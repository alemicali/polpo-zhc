/**
 * The agents' `decide` tool: a cheap typed judgment with probabilities from the instance's decision
 * model (decide(), src/decisions/service.ts) instead of reasoning it out in the chat — "is this
 * email a complaint?", "which team owns this ticket?", "how urgent is it (1–5)?", "rank these
 * leads". Given with `decide` in the agent's allowedTools; every call is in the decision log with
 * the agent as caller.
 */
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { describeDecisionAnswer } from "@polpo-ai/core";
import { decisionServiceFor } from "../decisions/service.js";

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

/** The decide tool when the agent has it (allowedTools "decide"). */
export function createDecisionTools(polpoDir: string, agent: string, allowedTools: string[] | undefined, context: { taskId?: string; missionId?: string } = {}): AgentTool<any>[] {
  if (!allowedTools?.some((t) => t === "decide")) return [];
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
      const service = decisionServiceFor(polpoDir);
      if (!service) return { content: [{ type: "text" as const, text: "Error: decisions are not available on this server" }], details: { error: true } };
      try {
        const r = await service.decide(params, { kind: "agent", id: agent, ...(context.taskId ? { label: `task ${context.taskId}` } : {}) });
        const lines = r.answers.map((a) => `- ${describeDecisionAnswer(a)}`);
        const text = [
          ...lines,
          `(${r.model}${r.calibrated ? "" : ", uncalibrated: no decision model is configured, Polpo's model answered"} · $${r.costUsd.toFixed(5)} · decision ${r.id})`,
          "",
          JSON.stringify(r.answers),
        ].join("\n");
        return { content: [{ type: "text" as const, text }], details: { decisionId: r.id, uncertain: r.uncertain, calibrated: r.calibrated } };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], details: { error: true } };
      }
    },
  };
  return [tool];
}
