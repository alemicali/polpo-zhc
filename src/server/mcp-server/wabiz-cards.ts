/**
 * The WhatsApp Business card: an MCP App (interactive UI in Claude, ChatGPT…; text elsewhere)
 * shown by polpo_wabiz_show — the channel's status, recent conversations with thumbnails, one
 * conversation's transcript (media, interactive and template messages, reactions, ticks) and the
 * templates waiting for approval. Its UI calls the same tool to switch conversation and refresh,
 * and polpo_wabiz_approval to approve or reject (the click is the person's decision).
 */
import { z } from "zod";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { buildWabizCard, wabizCardText, type WabizCard, type WabizMessageShape } from "../mcp-wabiz-card.js";
import { WABIZ_CARD_HTML } from "../mcp-widgets.generated.js";
import { cardAppearance } from "./card-appearance.js";
import { READ, dashboardLink, enc, fail, looseObject, unwrap, type AppRegister, type McpDeps } from "./kit.js";

export const WABIZ_CARD_URI = "ui://polpo/wabiz-card.html";
let seq = 0;
const key = () => ({ createdAt: Date.now(), seq: ++seq });

/** Thumbnails: images and stickers kept with a message, at most this size, as data URIs. */
const THUMB_MAX_BYTES = 200 * 1024;

type Loaded = { ok: true; card: WabizCard } | { ok: false; error: string };

async function thumbOf(deps: McpDeps, channel: string, m: WabizMessageShape | undefined): Promise<string | undefined> {
  if (!m?.media?.stored || (m.media.kind !== "image" && m.media.kind !== "sticker")) return undefined;
  if (m.media.size !== undefined && m.media.size > THUMB_MAX_BYTES) return undefined;
  const res = await deps.api("GET", `/api/v1/whatsapp-business/${enc(channel)}/media/${enc(m.id)}`).catch(() => undefined);
  if (!res || res.status !== 200 || !res.bytes || res.bytes.length > THUMB_MAX_BYTES) return undefined;
  const type = (res.headers.get("content-type") ?? "image/jpeg").split(";")[0]!.trim();
  if (!/^image\/(jpeg|png|webp)$/.test(type)) return undefined;
  return `data:${type};base64,${Buffer.from(res.bytes).toString("base64")}`;
}

export async function loadWabizCard(deps: McpDeps, args: { channel?: string; to?: string; limit?: number }): Promise<Loaded> {
  const list = unwrap(await deps.api("GET", "/api/v1/whatsapp-business"));
  if (!list.ok) return { ok: false, error: list.error };
  const all = ((list.data as { channels?: Array<Record<string, any>> }).channels ?? []);
  if (!all.length) return { ok: false, error: "No WhatsApp Business channel: create one with polpo_channel_save (type whatsapp-business)." };
  const status = args.channel ? all.find((c) => c.channel === args.channel) : all[0];
  if (!status) return { ok: false, error: `No WhatsApp Business channel "${args.channel}" (${all.map((c) => c.channel).join(", ")}).` };
  const channel = String(status.channel);
  const base = `/api/v1/whatsapp-business/${enc(channel)}`;
  const [contactsR, pendingR] = await Promise.all([deps.api("GET", `${base}/contacts?limit=8`), deps.api("GET", `${base}/pending`)]);
  const contacts = (() => { const r = unwrap(contactsR); return r.ok ? ((r.data as { contacts: Array<Record<string, any>> }).contacts ?? []) : []; })();
  const pending = (() => { const r = unwrap(pendingR); return r.ok ? ((r.data as { pending: WabizMessageShape[] }).pending ?? []) : []; })();
  const lastMessages: Record<string, WabizMessageShape | undefined> = {};
  const thumbs: Record<string, string> = {};
  let conversation: Parameters<typeof buildWabizCard>[0]["conversation"];
  if (args.to) {
    const r = unwrap(await deps.api("GET", `${base}/contacts/${enc(args.to)}?limit=${args.limit ?? 30}`));
    if (!r.ok) return { ok: false, error: r.error };
    conversation = r.data as NonNullable<typeof conversation>;
    // the newest photos of the conversation, as thumbnails
    for (const m of conversation.messages.filter((x) => x.media?.stored).slice(0, 8)) {
      const t = await thumbOf(deps, channel, m);
      if (t) thumbs[m.id] = t;
    }
  } else {
    await Promise.all(contacts.map(async (c) => {
      const r = unwrap(await deps.api("GET", `${base}/contacts/${enc(String(c.waId))}?limit=1`));
      const m = r.ok ? (r.data as { messages: WabizMessageShape[] }).messages[0] : undefined;
      lastMessages[String(c.waId)] = m;
      const t = await thumbOf(deps, channel, m);
      if (t && m) thumbs[m.id] = t;
    }));
  }
  const card = buildWabizCard({
    channel, channels: all.map((c) => String(c.channel)), status, contacts, lastMessages, thumbs, ...(conversation ? { conversation } : {}), pending, key: key(),
    link: dashboardLink(deps, `/config?section=channels&channel=${enc(channel)}`),
  });
  const appearance = await cardAppearance(deps);
  return { ok: true, card: appearance ? { ...card, appearance } : card };
}

const output = z.object({
  kind: z.literal("wabiz").optional(),
  key: z.object({ createdAt: z.number(), seq: z.number() }).passthrough().optional(),
  generatedAt: z.string().optional(),
  channel: z.string().optional().describe("The channel shown"),
  channels: z.array(z.string()).optional().describe("Every WhatsApp Business channel"),
  status: looseObject.optional().describe("State, number, quality rating, messaging tier, templates sent today against the cap, approvals waiting, the last account update"),
  conversations: z.array(looseObject).optional().describe("Recent conversations: window, opt-out, blocked, the last message (with a photo thumbnail)"),
  transcript: looseObject.optional().describe("With to: the conversation, oldest first — media, buttons, lists, links, flows, products, orders, reactions, ticks"),
  pending: z.array(looseObject).optional().describe("Templates waiting for an operator's approval"),
}).passthrough();

export function registerWabizCards(app: AppRegister, deps: McpDeps): void {
  const card = app.gate("whatsapp-business", READ, ["polpo_wabiz_show"]);

  registerAppResource(card, "WhatsApp Business card", WABIZ_CARD_URI, {
    description: "A WhatsApp Business channel: status, recent conversations, a conversation's transcript and the templates waiting for approval.",
  }, async () => ({
    contents: [{
      uri: WABIZ_CARD_URI,
      mimeType: RESOURCE_MIME_TYPE,
      text: WABIZ_CARD_HTML,
      _meta: { ui: { prefersBorder: false, csp: { resourceDomains: ["https://assets.claude.ai"] } } },
    }],
  }));

  registerAppTool(card, "polpo_wabiz_show", {
    title: "Show WhatsApp Business",
    description: "Show a WhatsApp Business channel as a card: its status (receiving / configured, number, quality rating, messaging tier, templates "
      + "today against the cap, the last account update), the recent conversations (window open or closed, opted out, blocked, the last message with "
      + "a photo thumbnail) and the templates waiting for approval, which the person can approve or reject from the card; with to, that "
      + "conversation's transcript as it looks in WhatsApp (photos, voice notes, documents, buttons, lists, links, flows, products, orders, "
      + "reactions, delivery ticks). Use it when the person asks how the WhatsApp number is doing, what a customer wrote, or what waits for approval.",
    inputSchema: {
      channel: z.string().optional().describe("The WhatsApp Business channel (default: the first)"),
      to: z.string().optional().describe("A contact (phone number or wa_id): their conversation"),
      limit: z.number().int().min(1).max(100).optional().describe("Messages in the transcript (default 30)"),
    },
    annotations: { title: "Show WhatsApp Business", ...READ },
    outputSchema: output,
    _meta: { ui: { resourceUri: WABIZ_CARD_URI } },
  }, async (args) => {
    const r = await loadWabizCard(deps, args);
    return r.ok ? { content: [{ type: "text" as const, text: wabizCardText(r.card) }], structuredContent: r.card as unknown as Record<string, unknown> } : fail(r.error);
  });
}
