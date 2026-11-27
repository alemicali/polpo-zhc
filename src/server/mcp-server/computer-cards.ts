/**
 * The computer card: an MCP App (interactive UI in Claude, ChatGPT…; text elsewhere) shown by
 * polpo_computer_show — a remote computer's live view, who holds its desktop and its agents'
 * requests for a person, with Take control / Give back (polpo_computer_takeover / _release) and a
 * link to the live view in the dashboard (the person types there, never in the chat). Its UI calls
 * the same tool to refresh.
 */
import { z } from "zod";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { buildComputerCard, computerCardText, type ComputerCard, type ComputerCardRequest } from "../mcp-computer-card.js";
import { COMPUTER_CARD_HTML } from "../mcp-widgets.generated.js";
import { cardAppearance } from "./card-appearance.js";
import { READ, dashboardLink, enc, fail, looseObject, unwrap, type AppRegister, type McpDeps } from "./kit.js";

export const COMPUTER_CARD_URI = "ui://polpo/computer-card.html";
let seq = 0;
const key = () => ({ createdAt: Date.now(), seq: ++seq });

type Loaded = { ok: true; card: ComputerCard } | { ok: false; error: string };

export async function loadComputerCard(deps: McpDeps, args: { id: string }): Promise<Loaded> {
  const c = unwrap(await deps.api("GET", `/api/v1/computers/${enc(args.id)}?live=0`));
  if (!c.ok) return { ok: false, error: c.status === 404 ? `There is no computer "${args.id}" (polpo_computers_list).` : c.error };
  const d = unwrap(await deps.api("GET", `/api/v1/computers/${enc(args.id)}/desktop`));
  if (!d.ok) return { ok: false, error: d.error };
  const computer = c.data as { id: string; name?: string; kind: string; status: string };
  const view = d.data as { desktop: ComputerCard["desktop"]; control: ComputerCard["control"] & { requests?: ComputerCardRequest[] } };
  const card = buildComputerCard({ computer, desktop: view.desktop, control: view.control, key: key(), link: dashboardLink(deps, `/computers/${enc(args.id)}?live=1`) });
  const appearance = await cardAppearance(deps);
  return { ok: true, card: appearance ? { ...card, appearance } : card };
}

const output = z.object({
  kind: z.literal("computer").optional(),
  key: z.object({ createdAt: z.number(), seq: z.number() }).passthrough().optional(),
  generatedAt: z.string().optional(),
  computer: looseObject.optional().describe("id, name, kind, status"),
  desktop: looseObject.optional().describe("the live view: running, stopped or machine-off"),
  control: looseObject.optional().describe("who holds the desktop: the agent, or a person since when; the last note a person left"),
  requests: z.array(looseObject).optional().describe("agents' takeover requests, open first"),
  link: z.string().optional().describe("the computer's live view in the dashboard"),
}).passthrough();

export function registerComputerCards(app: AppRegister, deps: McpDeps): void {
  const card = app.gate("computers", READ, ["polpo_computer_show"]);

  registerAppResource(card, "Computer card", COMPUTER_CARD_URI, {
    description: "A remote computer's live view, who holds its desktop, and its agents' requests for a person to take control.",
  }, async () => ({
    contents: [{
      uri: COMPUTER_CARD_URI,
      mimeType: RESOURCE_MIME_TYPE,
      text: COMPUTER_CARD_HTML,
      _meta: { ui: { prefersBorder: false, csp: { resourceDomains: ["https://assets.claude.ai"] } } },
    }],
  }));

  registerAppTool(card, "polpo_computer_show", {
    title: "Show a computer's live view",
    description: "Show a remote computer as a card: whether its live view runs, who holds its desktop (the agent, or a person since when), its agents' "
      + "requests for a person (a login, 2FA, a CAPTCHA: reason, page, what to do, until when the agent waits) with Take control / Give back, and a link "
      + "to the live view in the dashboard, where the person does it. Use it when an agent is waiting for a person, or the person asks what an agent's computer is doing.",
    inputSchema: { id: z.string().min(1).describe("The computer's id (polpo_computers_list)") },
    annotations: { title: "Show a computer's live view", ...READ },
    outputSchema: output,
    _meta: { ui: { resourceUri: COMPUTER_CARD_URI } },
  }, async (args) => {
    const r = await loadComputerCard(deps, args);
    return r.ok ? { content: [{ type: "text" as const, text: computerCardText(r.card) }], structuredContent: r.card as unknown as Record<string, unknown> } : fail(r.error);
  });
}
