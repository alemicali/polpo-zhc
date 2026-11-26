/**
 * The trigger card: an MCP App (interactive UI in Claude, ChatGPT…; text elsewhere) shown by
 * polpo_trigger_show — the triggers (endpoint, auth, counts, actions, last delivery) or one trigger
 * with its actions, its recent deliveries (each action's run and what it created) and the mapped values. Its UI calls the same tool to refresh
 * and to switch view.
 */
import { z } from "zod";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { buildTriggerDetailCard, buildTriggerListCard, triggerCardText, type TriggerCard, type TriggerShape } from "../mcp-trigger-card.js";
import { TRIGGER_CARD_HTML } from "../mcp-widgets.generated.js";
import { cardAppearance } from "./card-appearance.js";
import { READ, dashboardLink, enc, fail, looseObject, unwrap, type AppRegister, type McpDeps } from "./kit.js";

export const TRIGGER_CARD_URI = "ui://polpo/trigger-card.html";
let seq = 0;
const key = () => ({ createdAt: Date.now(), seq: ++seq });

type Loaded = { ok: true; card: TriggerCard } | { ok: false; error: string };

export async function loadTriggerCard(deps: McpDeps, args: { id?: string; status?: string[]; limit?: number }): Promise<Loaded> {
  let card: TriggerCard;
  if (args.id) {
    const t = unwrap(await deps.api("GET", `/api/v1/triggers/${enc(args.id)}`));
    if (!t.ok) return { ok: false, error: t.status === 404 ? `There is no trigger "${args.id}" (polpo_triggers_list).` : t.error };
    const q = new URLSearchParams({ limit: String(args.limit ?? 15), ...(args.status?.length ? { status: args.status.join(",") } : {}) });
    const d = unwrap(await deps.api("GET", `/api/v1/triggers/${enc(args.id)}/deliveries?${q.toString()}`));
    const deliveries = d.ok ? (d.data as { deliveries: Parameters<typeof buildTriggerDetailCard>[0]["deliveries"] }).deliveries : [];
    const accepted = deliveries.find((x) => x.status === "accepted");
    let lastMapped: Record<string, unknown> | undefined;
    if (accepted) {
      const one = unwrap(await deps.api("GET", `/api/v1/triggers/${enc(args.id)}/deliveries/${enc(accepted.id)}`));
      if (one.ok) lastMapped = (one.data as { mapped?: Record<string, unknown> }).mapped;
    }
    card = buildTriggerDetailCard({ trigger: t.data as TriggerShape, deliveries, ...(lastMapped ? { lastMapped } : {}), key: key(), link: dashboardLink(deps, `/triggers?trigger=${enc(args.id)}`) });
  } else {
    const r = unwrap(await deps.api("GET", "/api/v1/triggers"));
    if (!r.ok) return { ok: false, error: r.error };
    card = buildTriggerListCard({ triggers: r.data as TriggerShape[], key: key(), link: dashboardLink(deps, "/triggers") });
  }
  const appearance = await cardAppearance(deps);
  return { ok: true, card: appearance ? { ...card, appearance } : card };
}

const output = z.object({
  kind: z.enum(["triggers", "trigger"]).optional(),
  key: z.object({ createdAt: z.number(), seq: z.number() }).passthrough().optional(),
  generatedAt: z.string().optional(),
  triggers: z.array(looseObject).optional().describe("triggers view: each with its endpoint, auth, contract version, counts per status and last delivery"),
  trigger: looseObject.optional().describe("trigger view: the definition in words (auth, filter, dedupe, mapping, actions) and its counts"),
  deliveries: z.array(looseObject).optional().describe("trigger view: the recent deliveries (status, HTTP answer, reasons, each action's run and what it created)"),
  lastMapped: looseObject.optional().describe("trigger view: the newest accepted delivery's mapped values — what the actions receive"),
}).passthrough();

export function registerTriggerCards(app: AppRegister, deps: McpDeps): void {
  const card = app.gate("automation", READ, ["polpo_trigger_show"]);

  registerAppResource(card, "Trigger card", TRIGGER_CARD_URI, {
    description: "The triggers (public endpoints receiving forms and webhooks) or one trigger with its recent deliveries.",
  }, async () => ({
    contents: [{
      uri: TRIGGER_CARD_URI,
      mimeType: RESOURCE_MIME_TYPE,
      text: TRIGGER_CARD_HTML,
      _meta: { ui: { prefersBorder: false, csp: { resourceDomains: ["https://assets.claude.ai"] } } },
    }],
  }));

  registerAppTool(card, "polpo_trigger_show", {
    title: "Show triggers",
    description: "Show triggers as a card: every trigger with its endpoint, auth, contract version, delivery counts, actions and last delivery; with id, that trigger "
      + "with its actions, its recent deliveries (status, HTTP answer, reasons, contract errors, each action's run: done / failed / skipped and what it created) "
      + "and the newest accepted delivery's mapped values. Use it when the person asks what a form or webhook sent, whether deliveries arrive, or what their actions did.",
    inputSchema: {
      id: z.string().optional().describe("A trigger id (polpo_triggers_list): its deliveries"),
      status: z.array(z.enum(["accepted", "rejected", "filtered", "duplicate", "rate_limited"])).optional().describe("Only these delivery statuses"),
      limit: z.number().int().min(1).max(50).optional().describe("Deliveries shown (default 15)"),
    },
    annotations: { title: "Show triggers", ...READ },
    outputSchema: output,
    _meta: { ui: { resourceUri: TRIGGER_CARD_URI } },
  }, async (args) => {
    const r = await loadTriggerCard(deps, args);
    return r.ok ? { content: [{ type: "text" as const, text: triggerCardText(r.card) }], structuredContent: r.card as unknown as Record<string, unknown> } : fail(r.error);
  });
}
