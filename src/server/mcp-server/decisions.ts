/**
 * Decisions: typed judgments with probabilities from the decision model (decide()), the decision
 * log, and missions' decision nodes waiting for a person.
 *
 * Scopes: polpo_decide and polpo_decision_resolve need work (a model call that costs money; a
 * mission goes on); polpo_decisions (the log, a decision, the nodes) needs read. The card
 * (polpo_decision_show, decision-cards.ts) draws the answers with probability bars.
 */
import { z } from "zod";
import { describeDecisionAnswer, type DecisionAnswer } from "@polpo-ai/core";
import { READ, WRITE, apiError, apiGet, apiSend, dashboardLink, enc, fail, looseObject, ok, qs, type McpDeps, type Register } from "./kit.js";

type Answer = DecisionAnswer;
type Result = { id: string; answers: Answer[]; model: string; costUsd: number; calibrated: boolean; latencyMs: number; uncertain: boolean };
type Summary = Result & { at: string; status: "ok" | "error"; error?: string; caller: { kind: string; id?: string; label?: string; by?: string }; questions: Array<{ name: string; type: string }> };
type NodeRow = { group: string; missionId?: string; node: string; status: string; branch?: string | null; suggested?: string | null; reason?: string; answer?: Answer; decisionId?: string; startedAt: string; decidedBy?: string };

const at = (iso?: string) => (iso ? iso.slice(0, 16).replace("T", " ") : "");
export const decisionLine = (d: Omit<Summary, "questions">) => `- ${d.id} ${at(d.at)} ${d.caller.kind}${d.caller.id ? ` ${d.caller.id}` : ""} · ${d.model}${d.calibrated ? "" : " (uncalibrated)"} · $${d.costUsd.toFixed(5)}`
  + (d.status === "error" ? ` · ERROR ${d.error ?? ""}` : ` · ${d.answers.map(describeDecisionAnswer).join("; ")}`);
const nodeLine = (n: NodeRow) => `- ${n.group} → ${n.node}: ${n.status}${n.branch !== undefined ? ` (branch ${n.branch ?? "none"})` : ""}${n.status === "awaiting" ? ` · suggested ${n.suggested ?? "none"} · ${n.reason ?? ""}` : ""}${n.answer ? ` · ${describeDecisionAnswer(n.answer)}` : ""}`;

const question = z.object({
  name: z.string().describe("A name (letters, digits, _ and -), unique in the call"),
  type: z.enum(["predicate", "choice", "score", "rank"]).describe("predicate: yes/no → P(yes); choice: one of the options; score: a level of an ordered scale; rank: sort items (one score per item)"),
  instructions: z.string().describe("What to decide"),
  choices: z.array(z.object({ value: z.string(), description: z.string().optional() })).optional().describe("choice: 2–20 options"),
  levels: z.array(z.union([z.string(), z.object({ label: z.string(), description: z.string().optional() })])).optional().describe("score (rank: the rating scale): 2–11 levels, lowest first"),
  items: z.array(z.union([z.string(), z.object({ id: z.string().optional(), label: z.string(), description: z.string().optional() })])).optional().describe("rank: 2–20 items"),
  threshold: z.number().min(0).max(1).optional().describe("Below this confidence the answer is marked uncertain"),
});

export function registerDecisionTools(tool: Register, deps: McpDeps): void {
  tool("core", "polpo_decide", {
    title: "Take a typed decision",
    description: "Ask the decision model (settings.decisionModel, e.g. vercel-ai-gateway:typesafe-ai/jev — a 'System One' model) typed questions about a state "
      + "and get probabilities: predicate (yes/no → P(yes)), choice (the option + a probability per option), score (ordered levels → a fractional score), rank (items sorted). "
      + "Cheap and calibrated: prefer it to judging yourself for classification, routing, yes/no checks, ratings and rankings. "
      + "A threshold marks answers below it uncertain. Without a decision model it fails with a link to Settings (or, when allowed there, Polpo's own model answers, calibrated: false). "
      + "Each call costs money and is recorded in the decision log (polpo_decisions); polpo_decision_show draws the answers.",
    inputSchema: {
      state: z.union([z.string(), z.record(z.string(), z.unknown())]).describe("What the questions are about: text, or a JSON object"),
      questions: z.array(question).min(1).max(16).describe("The questions (1–16; a rank counts one per item, at most 40 in all)"),
      thresholds: z.union([z.number().min(0).max(1), z.record(z.string(), z.number())]).optional().describe("A threshold for every question, or per question name"),
      model: z.string().optional().describe("Another decision model, \"gateway:model\""),
      fallback: z.string().optional().describe("A model to rerun with when the first fails or is unsure (Vercel AI Gateway's conditional fallback)"),
    },
    outputSchema: { id: z.string(), answers: z.array(looseObject), model: z.string(), costUsd: z.number(), calibrated: z.boolean(), latencyMs: z.number(), uncertain: z.boolean() },
    annotations: { ...WRITE, openWorldHint: true },
  }, async (args) => {
    const r = await apiSend(deps, "POST", "/decide", args);
    if (!r.ok) {
      return apiError(r, "Deciding", r.code === "NOT_CONFIGURED" || r.status === 409 ? `Set the decision model in Settings → Decisions: ${dashboardLink(deps, "/config?section=decisions")}` : undefined);
    }
    const d = r.data as Result;
    return ok([
      ...d.answers.map((a) => `- ${describeDecisionAnswer(a)}`),
      `(${d.model}${d.calibrated ? "" : ", uncalibrated: Polpo's own model answered, no decision model is configured"} · $${d.costUsd.toFixed(5)} · ${d.latencyMs} ms · decision ${d.id})`,
    ].join("\n"), d as unknown as Record<string, unknown>);
  });

  tool("core", "polpo_decisions", {
    title: "The decision log",
    description: "The decision log (every decide() call: who called it — the API, MCP, Polpo's chat, an agent, a mission's decision node, a suite — the answers, the model, the cost), newest first; "
      + "with id, one decision with its questions and state; with nodes, missions' decision nodes (deciding, decided, or waiting for a person to choose a branch: polpo_decision_resolve).",
    inputSchema: {
      id: z.string().optional().describe("One decision (dec_…)"),
      nodes: z.boolean().optional().describe("Missions' decision nodes instead of the log"),
      caller: z.enum(["api", "mcp", "chat", "agent", "mission", "suite", "playground"]).optional().describe("Only decisions asked by this kind of caller"),
      caller_id: z.string().optional().describe("An agent's name, a mission id…"),
      uncertain: z.boolean().optional().describe("Only uncertain (true) or certain (false) ones"),
      status: z.enum(["ok", "error"]).optional().describe("Only decisions that succeeded (ok) or failed (error)"),
      limit: z.number().int().min(1).max(100).optional().describe("Default 20"),
      cursor: z.string().optional().describe("next_cursor of the previous page"),
    },
    outputSchema: { decisions: z.array(looseObject).optional(), decision: looseObject.optional(), nodes: z.array(looseObject).optional(), next_cursor: z.string().nullable().optional(), total: z.number().optional() },
    annotations: READ,
  }, async ({ id, nodes, caller, caller_id, uncertain, status, limit, cursor }) => {
    if (nodes) {
      const r = await apiGet(deps, "/decisions/nodes");
      if (!r.ok) return apiError(r, "Listing decision nodes");
      const list = r.data as NodeRow[];
      return ok(list.map(nodeLine).join("\n") || "No mission decision node is running.", { nodes: list });
    }
    if (id) {
      const r = await apiGet(deps, `/decisions/${enc(id)}`);
      if (!r.ok) return apiError(r, "Reading the decision");
      const d = r.data as Omit<Summary, "questions"> & { state?: string; questions: Array<{ name: string; type: string; instructions: string }> };
      return ok([
        decisionLine(d).slice(2),
        ...d.questions.map((q) => `question ${q.name} (${q.type}): ${q.instructions}`),
        d.state ? `state: ${d.state.slice(0, 2000)}` : "state: not kept (hash only)",
      ].join("\n"), { decision: d as unknown as Record<string, unknown> });
    }
    const r = await apiGet(deps, `/decisions${qs({ limit: limit ?? 20, cursor, caller, callerId: caller_id, uncertain, status })}`);
    if (!r.ok) return apiError(r, "Listing decisions");
    const p = r.data as { decisions: Summary[]; nextCursor?: string; total: number };
    return ok(`${p.decisions.map(decisionLine).join("\n") || "No decisions yet (polpo_decide)."}${p.nextCursor ? `\n(more: cursor ${p.nextCursor})` : ""}`,
      { decisions: p.decisions as unknown as Record<string, unknown>[], next_cursor: p.nextCursor ?? null, total: p.total });
  });

  tool("core", "polpo_decision_resolve", {
    title: "Choose a decision node's branch",
    description: "A mission's decision node whose answer was uncertain (or failed) waits for a person: choose its branch (null: none of its tasks run). The mission resumes. polpo_decisions with nodes lists them.",
    inputSchema: {
      group: z.string().describe("The mission run (group) the node is in"),
      node: z.string().describe("The decision node's name"),
      branch: z.string().nullable().describe("The branch to take, or null for none"),
    },
    outputSchema: { node: looseObject },
    annotations: WRITE,
  }, async ({ group, node, branch }) => {
    const r = await apiSend(deps, "POST", "/decisions/nodes/resolve", { group, node, branch });
    if (!r.ok) return r.status === 400 ? fail(r.error) : apiError(r, "Choosing the branch");
    const n = r.data as NodeRow;
    return ok(`${n.group} → ${n.node}: branch ${n.branch ?? "none"} (chosen by ${n.decidedBy ?? "you"}); the mission goes on.`, { node: n as unknown as Record<string, unknown> });
  });
}
