/**
 * The decision card: an MCP App (interactive UI in Claude, ChatGPT…; text elsewhere) shown by
 * polpo_decision_show — one decision's answers with probability bars, or the latest decisions.
 * Its UI calls the same tool to refresh and to open a decision.
 */
import { z } from "zod";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { buildDecisionDetailCard, buildDecisionListCard, decisionCardText, type DecisionCard, type DecisionShape } from "../mcp-decision-card.js";
import { DECISION_CARD_HTML } from "../mcp-widgets.generated.js";
import { cardAppearance } from "./card-appearance.js";
import { READ, dashboardLink, enc, fail, looseObject, unwrap, type AppRegister, type McpDeps } from "./kit.js";

export const DECISION_CARD_URI = "ui://polpo/decision-card.html";
let seq = 0;
const key = () => ({ createdAt: Date.now(), seq: ++seq });

type Loaded = { ok: true; card: DecisionCard } | { ok: false; error: string };

export async function loadDecisionCard(deps: McpDeps, args: { id?: string; limit?: number; uncertain?: boolean }): Promise<Loaded> {
  let card: DecisionCard;
  if (args.id) {
    const r = unwrap(await deps.api("GET", `/api/v1/decisions/${enc(args.id)}`));
    if (!r.ok) return { ok: false, error: r.status === 404 ? `There is no decision "${args.id}" (polpo_decisions).` : r.error };
    card = buildDecisionDetailCard({ decision: r.data as DecisionShape, key: key(), link: dashboardLink(deps, `/decisions?decision=${enc(args.id)}`) });
  } else {
    const q = new URLSearchParams({ limit: String(args.limit ?? 10), ...(args.uncertain !== undefined ? { uncertain: String(args.uncertain) } : {}) });
    const r = unwrap(await deps.api("GET", `/api/v1/decisions?${q.toString()}`));
    if (!r.ok) return { ok: false, error: r.error };
    const p = r.data as { decisions: DecisionShape[]; total: number };
    card = buildDecisionListCard({ decisions: p.decisions, total: p.total, key: key(), link: dashboardLink(deps, "/decisions") });
  }
  const appearance = await cardAppearance(deps);
  return { ok: true, card: appearance ? { ...card, appearance } : card };
}

const output = z.object({
  kind: z.enum(["decisions", "decision"]).optional(),
  key: z.object({ createdAt: z.number(), seq: z.number() }).passthrough().optional(),
  generatedAt: z.string().optional(),
  decision: looseObject.optional().describe("decision view: its answers (headline, probability bars, confidence, uncertain), model, cost, caller"),
  decisions: z.array(looseObject).optional().describe("decisions view: the latest decisions with their answers"),
  total: z.number().optional(),
}).passthrough();

export function registerDecisionCards(app: AppRegister, deps: McpDeps): void {
  const card = app.gate("core", READ, ["polpo_decision_show"]);

  registerAppResource(card, "Decision card", DECISION_CARD_URI, {
    description: "A decision's answers with probability bars, or the latest decisions.",
  }, async () => ({
    contents: [{
      uri: DECISION_CARD_URI,
      mimeType: RESOURCE_MIME_TYPE,
      text: DECISION_CARD_HTML,
      _meta: { ui: { prefersBorder: false, csp: { resourceDomains: ["https://assets.claude.ai"] } } },
    }],
  }));

  registerAppTool(card, "polpo_decision_show", {
    title: "Show decisions",
    description: "Show a decision as a card: each answer with probability bars (yes / no, every option, every level, the ranked items), its confidence and whether it is uncertain, "
      + "the model, the cost and whether it is calibrated; without id, the latest decisions. Use it right after polpo_decide (pass its id) or when the person asks what was decided.",
    inputSchema: {
      id: z.string().optional().describe("A decision id (dec_…, from polpo_decide or polpo_decisions)"),
      limit: z.number().int().min(1).max(30).optional().describe("Latest decisions shown (default 10)"),
      uncertain: z.boolean().optional().describe("Only uncertain ones"),
    },
    annotations: { title: "Show decisions", ...READ },
    outputSchema: output,
    _meta: { ui: { resourceUri: DECISION_CARD_URI } },
  }, async (args) => {
    const r = await loadDecisionCard(deps, args);
    return r.ok ? { content: [{ type: "text" as const, text: decisionCardText(r.card) }], structuredContent: r.card as unknown as Record<string, unknown> } : fail(r.error);
  });
}
