/**
 * WhatsApp Business (Meta Cloud API) from an MCP client (and Polpo's chat, bridged): the channel's
 * status (configured / receiving, secrets set, callback URL, Funnel command), its webhook event
 * log, templates, a contact's conversation and window, sends and the approval of queued templates.
 *
 * Secrets never pass through here: the access token, app secret and verify token are entered in
 * the dashboard (setup_url / polpo_setup_wait with setup ids `wabiz:<channel>:<kind>`). Sends are
 * real and cost money: they need confirm: true after the person saw them. Polpo (in its chat) only
 * queues templates for an operator's approval when the channel asks for it.
 */
import { z } from "zod";
import {
  READ, apiError, apiGet, apiSend, confirmParam, enc, fail, looseObject, ok, qs, short,
  type McpDeps, type Register,
} from "./kit.js";
import { setupHandoffs } from "./setup.js";

const SEND = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } as const;
const channelParam = z.string().min(1).optional().describe("The WhatsApp Business channel's name (default: the only one)");
const toParam = z.string().min(1).describe("The contact: phone number with country code (+39…) or wa_id");

interface ChannelStatus {
  channel: string; state: string; secrets: Record<string, boolean>; missing: string[]; callbackUrl?: string; funnelCommand: string;
  audience: string; agent?: string; inbound: boolean; counts: Record<string, number>; pendingApprovals: number; sentToday: number;
  limits: { businessInitiatedPerDay: number }; lastEventAt?: string; lastError?: string;
  phone?: { qualityRating?: string; messagingLimitTier?: string; displayPhoneNumber?: string };
}

async function pickChannel(deps: McpDeps, channel: string | undefined): Promise<{ ok: true; name: string; all: ChannelStatus[] } | { ok: false; res: ReturnType<typeof fail> }> {
  const r = await apiGet(deps, "/whatsapp-business");
  if (!r.ok) return { ok: false, res: apiError(r, "Reading the WhatsApp Business channels") };
  const all = ((r.data as { channels?: ChannelStatus[] })?.channels ?? []);
  if (channel) {
    if (!all.some((c) => c.channel === channel)) return { ok: false, res: fail(`No WhatsApp Business channel "${channel}" (${all.map((c) => c.channel).join(", ") || "none: create one with polpo_channel_save type whatsapp-business"}).`) };
    return { ok: true, name: channel, all };
  }
  if (all.length === 1) return { ok: true, name: all[0]!.channel, all };
  return { ok: false, res: fail(all.length ? `Say which channel: ${all.map((c) => c.channel).join(", ")}.` : "No WhatsApp Business channel: create one with polpo_channel_save (type whatsapp-business).") };
}

const SECRET_WHAT: Record<string, string> = {
  accessToken: "access token (a system user's, with whatsapp_business_messaging and whatsapp_business_management)",
  appSecret: "app secret (Meta app → Settings → Basic)",
  verifyToken: "verify token (or generate one in the dashboard)",
};

export function registerWaBusinessTools(tool: Register, deps: McpDeps): void {
  const isPolpo = () => deps.principal?.actor === "polpo";

  tool("channels", "polpo_wabiz_contact", {
    title: "Record a contact's opt-in or opt-out",
    description: "Record that a WhatsApp Business contact opted in to business-initiated messages (marketing templates need it) or opted out (nothing "
      + "is sent to them any more, templates included, until they opt in again). source: where it was given (a form, a call…). Needs the admin scope.",
    inputSchema: {
      channel: channelParam,
      contact: toParam,
      opt_in: z.boolean().describe("true: opted in; false: opted out"),
      source: z.string().max(200).optional().describe("Where it was given (default: operator)"),
    },
    outputSchema: { channel: z.string(), contact: looseObject },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ channel, contact, opt_in, source }) => {
    const p = await pickChannel(deps, channel);
    if (!p.ok) return p.res;
    const waId = contact.trim();
    const r = await apiSend(deps, "PUT", `/whatsapp-business/${enc(p.name)}/contacts/${enc(waId)}/opt-in`, { optIn: opt_in, ...(source ? { source } : {}) });
    if (!r.ok) return apiError(r, `Recording ${waId}'s ${opt_in ? "opt-in" : "opt-out"}`);
    return ok(opt_in ? `${waId} opted in on ${p.name}.` : `${waId} opted out on ${p.name}: nothing will be sent to them.`, { channel: p.name, contact: r.data as Record<string, unknown> });
  });

  tool("channels", "polpo_wabiz_contact_erase", {
    title: "Erase a contact (GDPR)",
    description: "Erase a WhatsApp Business contact and every message kept for them (a GDPR erasure request). It cannot be undone. Needs confirm: true "
      + "after the person agreed, and the admin scope.",
    inputSchema: { channel: channelParam, contact: toParam, confirm: confirmParam("erase the contact and its messages") },
    outputSchema: { channel: z.string(), contact: z.string(), erased: z.boolean() },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ channel, contact, confirm }) => {
    const p = await pickChannel(deps, channel);
    if (!p.ok) return p.res;
    const waId = contact.trim();
    if (confirm !== true) return fail(`Erasing ${waId} deletes the contact and every message kept for them on ${p.name}, for good: ask the person, then call again with confirm: true.`);
    const r = await apiSend(deps, "DELETE", `/whatsapp-business/${enc(p.name)}/contacts/${enc(waId)}`);
    if (!r.ok) return r.status === 404 ? fail(`No contact ${waId} on ${p.name}.`) : apiError(r, `Erasing ${waId}`);
    return ok(`Erased ${waId} and their messages from ${p.name}.`, { channel: p.name, contact: waId, erased: true });
  });

  tool("channels", "polpo_wabiz_status", {
    title: "WhatsApp Business status",
    description: "A WhatsApp Business (Meta Cloud API) channel: configured / receiving / not configured, what is missing (ids, secrets — only whether they "
      + "are set, never their values — gateway.agent), the callback URL Meta must call and the Tailscale Funnel command that exposes it, who it talks to "
      + "(customers → its agent, or operators), webhook counts, sends waiting for approval, business-initiated messages sent today against the cap, and "
      + "(after a test) the number's quality rating and messaging tier. test: true checks the token and the number at Meta.",
    inputSchema: { channel: channelParam, test: z.boolean().optional().describe("Check the access token and the phone number at Meta now") },
    outputSchema: { channel: z.string(), status: looseObject, test: looseObject.optional(), setup_url: z.string().optional(), setup_ids: z.array(z.string()).optional(), next_step: z.string().optional() },
    annotations: READ,
  }, async ({ channel, test }) => {
    const p = await pickChannel(deps, channel);
    if (!p.ok) return p.res;
    const r = await apiGet(deps, `/whatsapp-business/${enc(p.name)}/status`);
    if (!r.ok) return apiError(r, `Reading ${p.name}`);
    const s = r.data as ChannelStatus;
    let tested: Record<string, unknown> | undefined;
    if (test) {
      const t = await apiSend(deps, "POST", `/whatsapp-business/${enc(p.name)}/test`);
      tested = t.ok ? { ok: true, ...(t.data as object) } : { ok: false, error: t.error };
    }
    const secretsMissing = Object.entries(s.secrets).filter(([, set]) => !set).map(([k]) => k);
    const handoff = secretsMissing.length
      ? setupHandoffs(deps, secretsMissing.map((k) => ({ target: { kind: "wabiz" as const, item: p.name, field: k }, what: SECRET_WHAT[k] ?? k })))
      : {};
    const lines = [
      `${p.name}: ${s.state}${s.missing.length ? ` (missing: ${s.missing.join(", ")})` : ""}`,
      `audience: ${s.audience}${s.agent ? ` → ${s.agent}` : ""}; inbound ${s.inbound ? "on" : "off"}`,
      `callback URL: ${s.callbackUrl ?? "POLPO_PUBLIC_URL is not set"}; expose it with: ${s.funnelCommand}`,
      `webhooks: ${Object.entries(s.counts).map(([k, v]) => `${k} ${v}`).join(", ")}${s.lastEventAt ? `; last ${s.lastEventAt}` : ""}${s.lastError ? `; last problem: ${s.lastError}` : ""}`,
      `waiting for approval: ${s.pendingApprovals}; business-initiated today: ${s.sentToday}/${s.limits.businessInitiatedPerDay}`,
      ...(s.phone ? [`number: ${s.phone.displayPhoneNumber ?? "?"} quality ${s.phone.qualityRating ?? "?"} tier ${s.phone.messagingLimitTier ?? "?"}`] : []),
      ...(tested ? [`test: ${tested.ok ? "ok" : `failed: ${String(tested.error)}`}`] : []),
      ...(secretsMissing.length ? [(handoff as { next_step: string }).next_step] : []),
    ];
    return ok(lines.join("\n"), { channel: p.name, status: s as unknown as Record<string, unknown>, ...(tested ? { test: tested } : {}), ...handoff });
  });

  tool("channels", "polpo_wabiz_events", {
    title: "WhatsApp Business webhook events",
    description: "A WhatsApp Business channel's webhook deliveries, newest first: accepted, ignored (another number, nothing to do), rejected (signature, "
      + "size, rate, not configured) or error, with the reason. Never message text: types, lengths and masked contacts only. id: one delivery in full.",
    inputSchema: {
      channel: channelParam,
      outcome: z.array(z.enum(["accepted", "ignored", "rejected", "error"])).optional().describe("Only these outcomes"),
      limit: z.number().int().min(1).max(100).optional().describe("How many (default 20)"),
      cursor: z.string().optional().describe("next_cursor of the previous page"),
      id: z.string().optional().describe("One delivery in full"),
    },
    outputSchema: { channel: z.string(), events: z.array(looseObject).optional(), event: looseObject.optional(), next_cursor: z.string().nullable().optional(), counts: looseObject.optional() },
    annotations: READ,
  }, async ({ channel, outcome, limit, cursor, id }) => {
    const p = await pickChannel(deps, channel);
    if (!p.ok) return p.res;
    if (id) {
      const r = await apiGet(deps, `/whatsapp-business/${enc(p.name)}/events/${enc(id)}`);
      if (!r.ok) return apiError(r, `Reading delivery ${id}`);
      return ok(JSON.stringify(r.data, null, 1), { channel: p.name, event: r.data as Record<string, unknown> });
    }
    const r = await apiGet(deps, `/whatsapp-business/${enc(p.name)}/events${qs({ limit: limit ?? 20, cursor, outcome: outcome?.join(",") })}`);
    if (!r.ok) return apiError(r, `Reading ${p.name}'s events`);
    const d = r.data as { events: Array<Record<string, unknown>>; nextCursor?: string; counts: Record<string, number> };
    const lines = d.events.map((e) => `- ${String(e.receivedAt)} ${String(e.outcome)} ${String(e.httpStatus)} ${String(e.eventType ?? "")} ${short(e.reason ?? e.action ?? "", 140)} (${String(e.id)})`);
    return ok(`${p.name}: ${Object.entries(d.counts).map(([k, v]) => `${k} ${v}`).join(", ")}\n${lines.join("\n") || "no deliveries yet"}`,
      { channel: p.name, events: d.events, next_cursor: d.nextCursor ?? null, counts: d.counts });
  });

  tool("channels", "polpo_wabiz_templates", {
    title: "WhatsApp Business templates",
    description: "The account's message templates (name, language, status: only APPROVED can be sent, category, body with its {{parameters}}), and which "
      + "categories this channel allows. refresh: sync from Meta first.",
    inputSchema: { channel: channelParam, refresh: z.boolean().optional().describe("Sync from Meta first") },
    outputSchema: { channel: z.string(), templates: z.array(looseObject), synced_at: z.string().optional() },
    annotations: READ,
  }, async ({ channel, refresh }) => {
    const p = await pickChannel(deps, channel);
    if (!p.ok) return p.res;
    const r = await apiGet(deps, `/whatsapp-business/${enc(p.name)}/templates${qs({ refresh: refresh ? "true" : undefined })}`);
    if (!r.ok) return apiError(r, `Reading ${p.name}'s templates`);
    const d = r.data as { templates: Array<{ name: string; language: string; status: string; category: string; components: Array<{ type: string; text?: string }> }>; syncedAt?: string };
    const lines = d.templates.map((t) => `- ${t.name} (${t.language}) ${t.status} ${t.category}: ${short(t.components.find((c) => c.type.toUpperCase() === "BODY")?.text ?? "", 160)}`);
    return ok(lines.join("\n") || "No templates: create them in Meta's WhatsApp Manager, then refresh.",
      { channel: p.name, templates: d.templates as unknown as Array<Record<string, unknown>>, ...(d.syncedAt ? { synced_at: d.syncedAt } : {}) });
  });

  tool("channels", "polpo_wabiz_conversation", {
    title: "A WhatsApp Business conversation",
    description: "A contact's conversation on a WhatsApp Business channel: recent messages, whether the 24-hour window is open (free-form messages) or "
      + "closed (templates only), opt-in and opt-out. Without `to`: the contacts, newest first.",
    inputSchema: { channel: channelParam, to: toParam.optional(), limit: z.number().int().min(1).max(100).optional().describe("How many messages (or contacts)") },
    outputSchema: { channel: z.string(), conversation: looseObject.optional(), contacts: z.array(looseObject).optional() },
    annotations: READ,
  }, async ({ channel, to, limit }) => {
    const p = await pickChannel(deps, channel);
    if (!p.ok) return p.res;
    if (!to) {
      const r = await apiGet(deps, `/whatsapp-business/${enc(p.name)}/contacts${qs({ limit: limit ?? 50 })}`);
      if (!r.ok) return apiError(r, `Reading ${p.name}'s contacts`);
      const contacts = (r.data as { contacts: Array<Record<string, any>> }).contacts;
      return ok(contacts.map((c) => `- ${c.name ?? ""} ${c.waId} window ${c.window?.open ? "open" : "closed"}${c.optOut ? " opted out" : ""}`).join("\n") || "No contacts yet.",
        { channel: p.name, contacts });
    }
    const r = await apiGet(deps, `/whatsapp-business/${enc(p.name)}/contacts/${enc(to)}${qs({ limit: limit ?? 20 })}`);
    if (!r.ok) return apiError(r, `Reading the conversation with ${to}`);
    const c = r.data as { contact: Record<string, any>; window: { open: boolean; closesAt?: string }; optedOut: boolean; messages: Array<Record<string, any>> };
    const lines = c.messages.map((m) => `- ${m.createdAt} ${m.direction === "in" ? "←" : "→"} [${m.status}] ${short(m.text ?? `(${m.type})`, 300)}`);
    return ok(`window: ${c.window.open ? `open until ${c.window.closesAt}` : "closed (templates only)"}; opted out: ${c.optedOut ? "yes" : "no"}\n${lines.join("\n") || "no messages"}`,
      { channel: p.name, conversation: c as unknown as Record<string, unknown> });
  });

  tool("channels", "polpo_wabiz_send", {
    title: "Send a WhatsApp Business message",
    description: "Send a free-form message to a contact of a WhatsApp Business channel: only inside the 24-hour window (the contact wrote in the last "
      + "24 hours); outside it use polpo_wabiz_send_template. Real and cannot be undone: show the person the message, then call with confirm: true.",
    inputSchema: {
      channel: channelParam, to: toParam, text: z.string().min(1).max(20_000).describe("The message (Markdown becomes WhatsApp formatting)"),
      reply_to: z.string().optional().describe("Quote this message (its wamid, from polpo_wabiz_conversation)"),
      confirm: confirmParam("send it (after the person saw it and agreed)"),
    },
    outputSchema: { sent: z.boolean(), ids: z.array(z.string()).optional() },
    annotations: SEND,
    scope: "polpo:messages",
  }, async ({ channel, to, text, reply_to, confirm }) => {
    const p = await pickChannel(deps, channel);
    if (!p.ok) return p.res;
    if (confirm !== true) return fail(`Sending to ${to} on ${p.name} is real: show the person the message, then call again with confirm: true.`);
    const r = await apiSend(deps, "POST", `/whatsapp-business/${enc(p.name)}/send`, { to, text, ...(reply_to ? { replyTo: reply_to } : {}), by: isPolpo() ? "polpo" : (deps.principal?.actor ?? "mcp") });
    if (!r.ok) return apiError(r, `Sending to ${to}`, r.status === 400 ? "Outside the window send an approved template (polpo_wabiz_send_template)." : undefined);
    const ids = (r.data as { ids?: string[] }).ids ?? [];
    return ok(`Sent to ${to} (${ids.join(", ")}).`, { sent: true, ids });
  });

  tool("channels", "polpo_wabiz_send_template", {
    title: "Send a WhatsApp Business template",
    description: "Send an approved template (a business-initiated message, also outside the 24-hour window): checked against the template (APPROVED, "
      + "body parameters), the allowed categories, the contact's opt-out and the daily caps. Costs money per message. From Polpo's chat it waits for "
      + "an operator's approval when the channel asks for it (business.approveTemplates). Show the person the message, then call with confirm: true.",
    inputSchema: {
      channel: channelParam, to: toParam, template: z.string().min(1).describe("The template's name (polpo_wabiz_templates)"),
      language: z.string().optional().describe("Its language code (it, en_US…)"), params: z.array(z.string()).max(30).optional().describe("Body parameters in order"),
      reason: z.string().max(500).optional().describe("Why: shown to whoever approves it"),
      components: looseObject.optional().describe("Every other component the template needs (polpo_wabiz_templates says which): { header: { type: text | image | video | document | location, "
        + "text | link | mediaId | latitude, longitude… }, body: { name: value } (named parameters), buttons: [{ index, text (a URL's suffix) | payload (quick reply) | "
        + "couponCode | flowToken }], carousel: [{ header: { type: image | video, link | mediaId }, body: [..], buttons: [..] }], otp: the one-time code (authentication) }"),
      confirm: confirmParam("send it (after the person saw it and agreed)"),
    },
    outputSchema: { status: z.enum(["sent", "pending_approval"]), ids: z.array(z.string()).optional(), id: z.string().optional() },
    annotations: SEND,
    scope: "polpo:messages",
  }, async ({ channel, to, template, language, params, reason, components, confirm }) => {
    const p = await pickChannel(deps, channel);
    if (!p.ok) return p.res;
    if (confirm !== true) return fail(`Sending template ${template} to ${to} is real and costs money: show the person, then call again with confirm: true.`);
    const r = await apiSend(deps, "POST", `/whatsapp-business/${enc(p.name)}/send-template`, {
      to, template, ...(language ? { language } : {}), params: params ?? [], ...(reason ? { reason } : {}), ...(components ? { components } : {}),
      queue: isPolpo(), by: isPolpo() ? "polpo" : (deps.principal?.actor ?? "mcp"),
    });
    if (!r.ok) return apiError(r, `Sending template ${template}`);
    const d = r.data as { status: "sent" | "pending_approval"; ids?: string[]; id?: string; note?: string };
    return ok(d.status === "sent" ? `Template ${template} sent to ${to} (${(d.ids ?? []).join(", ")}).` : `Queued for approval: ${d.note}`,
      { status: d.status, ...(d.ids ? { ids: d.ids } : {}), ...(d.id ? { id: d.id } : {}) });
  });

  tool("channels", "polpo_wabiz_approval", {
    title: "Approve or reject a queued WhatsApp Business template",
    description: "Templates agents (or Polpo) asked to send wait for an operator. action list (default): the sends waiting; approve: send it now (the rules "
      + "are checked again); reject: drop it. approve and reject need confirm: true after the person decided.",
    inputSchema: {
      channel: channelParam, action: z.enum(["list", "approve", "reject"]).optional().describe("list (default), approve or reject"),
      id: z.string().optional().describe("The queued send (pending_…)"),
      reason: z.string().max(500).optional().describe("reject: why"), confirm: confirmParam("approve or reject it (the person decided)"),
    },
    outputSchema: { channel: z.string(), pending: z.array(looseObject).optional(), result: looseObject.optional() },
    annotations: SEND,
    scope: "polpo:messages",
  }, async ({ channel, action, id, reason, confirm }) => {
    const p = await pickChannel(deps, channel);
    if (!p.ok) return p.res;
    if (!action || action === "list") {
      const r = await apiGet(deps, `/whatsapp-business/${enc(p.name)}/pending`);
      if (!r.ok) return apiError(r, "Reading the queued sends");
      const pending = (r.data as { pending: Array<Record<string, any>> }).pending;
      return ok(pending.map((m) => `- ${m.id}: ${m.pending?.template} (${m.pending?.language}) to ${m.waId} by ${m.pending?.requestedBy} ${m.pending?.requestedAt}${m.pending?.reason ? ` — ${m.pending.reason}` : ""} params ${JSON.stringify(m.pending?.params ?? [])}`).join("\n") || "Nothing waiting.",
        { channel: p.name, pending });
    }
    if (!id) return fail("Give the id of the queued send (action list shows them).");
    if (confirm !== true) return fail(`${action === "approve" ? "Approving sends the template now (real, costs money)" : "Rejecting drops it"}: ask the person, then call again with confirm: true.`);
    const by = deps.principal?.actor ?? "mcp";
    const r = await apiSend(deps, "POST", `/whatsapp-business/${enc(p.name)}/pending/${enc(id)}/${action}`, { by, ...(reason ? { reason } : {}) });
    if (!r.ok) return apiError(r, `${action === "approve" ? "Approving" : "Rejecting"} ${id}`);
    return ok(action === "approve" ? `Approved and sent (${String((r.data as { sentAs?: string }).sentAs)}).` : `Rejected ${id}.`, { channel: p.name, result: r.data as Record<string, unknown> });
  });

  registerWaBusinessRichTools(tool, deps, pickChannel);
}

type Pick_ = typeof pickChannel;

const sentOut = { sent: z.boolean(), ids: z.array(z.string()).optional() };
const replyToParam = z.string().optional().describe("Quote this message (its wamid, from polpo_wabiz_conversation)");
const fileParam = z.object({
  data: z.string().min(1).describe("The file, base64 (at most 20 MB)"),
  mime_type: z.string().min(1).describe("Its type: image/jpeg, application/pdf…"),
  filename: z.string().min(1).describe("Its name"),
}).describe("A file to upload and send (or use link / media_id)");

/**
 * Everything beyond text and templates: media, interactive messages, flows, products, orders and
 * payments, reactions and read receipts, template management, the business profile, blocked
 * users, analytics, the phone number and the shared-app webhook override.
 */
function registerWaBusinessRichTools(tool: Register, deps: McpDeps, pickChannel: Pick_): void {
  const isPolpo = () => deps.principal?.actor === "polpo";
  const by = () => (isPolpo() ? "polpo" : (deps.principal?.actor ?? "mcp"));
  const sendMessage = async (channel: string | undefined, to: string, message: Record<string, unknown>, confirm: boolean | undefined, what: string, file?: { data: string; mime_type: string; filename: string }) => {
    const p = await pickChannel(deps, channel);
    if (!p.ok) return p.res;
    if (confirm !== true) return fail(`Sending ${what} to ${to} on ${p.name} is real: show the person what goes out, then call again with confirm: true.`);
    const r = await apiSend(deps, "POST", `/whatsapp-business/${enc(p.name)}/messages`, {
      to, message, by: by(), ...(file ? { file: { data: file.data, mimeType: file.mime_type, filename: file.filename } } : {}),
    });
    if (!r.ok) return apiError(r, `Sending ${what} to ${to}`, r.status === 400 ? "Outside the window only an approved template can be sent (polpo_wabiz_send_template)." : undefined);
    const ids = (r.data as { ids?: string[] }).ids ?? [];
    return ok(`Sent ${what} to ${to} (${ids.join(", ")}).`, { sent: true, ids });
  };

  tool("whatsapp-business", "polpo_wabiz_send_media", {
    title: "Send a WhatsApp Business file",
    description: "Send an image, audio, video, document or sticker to a contact of a WhatsApp Business channel, inside the 24-hour window: a file "
      + "(base64, uploaded to Meta first), a public https link or a Meta media id, with a caption (not for audio or stickers). Meta's limits: images "
      + "JPEG/PNG/WebP ≤ 5 MB, audio and video ≤ 16 MB, documents ≤ 100 MB (≤ 20 MB through here: larger by link), stickers WebP ≤ 500 KB. Needs confirm: true.",
    inputSchema: {
      channel: channelParam, to: toParam,
      kind: z.enum(["image", "audio", "video", "document", "sticker"]).describe("What it goes out as"),
      file: fileParam.optional(),
      link: z.string().url().optional().describe("Or a public https link to the file"),
      media_id: z.string().optional().describe("Or a Meta media id already uploaded"),
      caption: z.string().max(1024).optional().describe("A caption (images, videos, documents)"),
      filename: z.string().max(240).optional().describe("The name shown for a document"),
      reply_to: replyToParam,
      confirm: confirmParam("send it (after the person saw it and agreed)"),
    },
    outputSchema: sentOut,
    annotations: SEND,
    scope: "polpo:messages",
  }, async ({ channel, to, kind, file, link, media_id, caption, filename, reply_to, confirm }) => {
    if (!file && !link && !media_id) return fail("Give file, link or media_id.");
    return sendMessage(channel, to, {
      type: "media", kind, ...(link ? { link } : {}), ...(media_id ? { mediaId: media_id } : {}), ...(caption ? { caption } : {}),
      ...(kind === "document" && (filename ?? file?.filename) ? { filename: filename ?? file?.filename } : {}), ...(reply_to ? { replyTo: reply_to } : {}),
    }, confirm, `a ${kind}`, file);
  });

  tool("whatsapp-business", "polpo_wabiz_send_interactive", {
    title: "Send WhatsApp Business buttons, a list, a link, a location…",
    description: "Send an interactive message inside the 24-hour window. message.type: buttons { body, buttons: [{ id, title ≤ 20 }] up to 3, header?, "
      + "footer? }; list { body, button ≤ 20, sections: [{ title?, rows: [{ id, title ≤ 24, description? ≤ 72 }] }] (10 rows in all) }; cta_url { body, "
      + "displayText ≤ 20, url }; location_request { body }; location { latitude, longitude, name?, address? }; contacts { contacts: [{ name, phones: "
      + "[{ phone }], emails? }] }; voice_call { body, displayText?, ttlMinutes? }; call_permission_request { body? }; address { body, country: \"IN\" } "
      + "(India only). Replies (the tapped button's or row's id) come back to the channel's agent and as channel:wabiz-event. Needs confirm: true.",
    inputSchema: {
      channel: channelParam, to: toParam,
      message: looseObject.describe("The message: { type: buttons | list | cta_url | location_request | location | contacts | voice_call | call_permission_request | address, … } as described"),
      reply_to: replyToParam,
      confirm: confirmParam("send it (after the person saw it and agreed)"),
    },
    outputSchema: sentOut,
    annotations: SEND,
    scope: "polpo:messages",
  }, async ({ channel, to, message, reply_to, confirm }) => {
    const type = String((message as { type?: unknown }).type ?? "");
    if (!["buttons", "list", "cta_url", "location_request", "location", "contacts", "voice_call", "call_permission_request", "address"].includes(type)) {
      return fail("message.type: buttons, list, cta_url, location_request, location, contacts, voice_call, call_permission_request or address.");
    }
    return sendMessage(channel, to, { ...message, ...(reply_to ? { replyTo: reply_to } : {}) }, confirm, `a ${type.replace(/_/g, " ")} message`);
  });

  tool("whatsapp-business", "polpo_wabiz_send_flow", {
    title: "Send a WhatsApp Flow",
    description: "Send a published WhatsApp Flow (a form made in WhatsApp Manager → Flows) inside the 24-hour window: its button opens it on a screen "
      + "with initial data. The answers come back as structured data (with your flow_ref) to the channel's agent and as channel:wabiz-event "
      + "kind flow, so a trigger can act on them. Needs confirm: true.",
    inputSchema: {
      channel: channelParam, to: toParam,
      flow_id: z.string().optional().describe("The published flow's id"), flow_name: z.string().optional().describe("Or its name"),
      body: z.string().min(1).describe("The message's text"), cta: z.string().min(1).max(30).describe("The button that opens it"),
      header: z.string().max(60).optional().describe("A text header"), footer: z.string().max(60).optional().describe("A footer"),
      screen: z.string().optional().describe("The screen it opens on"), data: looseObject.optional().describe("Initial data for that screen"),
      flow_ref: z.string().optional().describe("Your reference (Meta's flow_token): it comes back with the answers"),
      mode: z.enum(["published", "draft"]).optional().describe("draft: test an unpublished flow"),
      action: z.enum(["navigate", "data_exchange"]).optional().describe("navigate (default) or data_exchange (your flow endpoint answers)"),
      reply_to: replyToParam,
      confirm: confirmParam("send it (after the person saw it and agreed)"),
    },
    outputSchema: sentOut,
    annotations: SEND,
    scope: "polpo:messages",
  }, async (a) => {
    if (!a.flow_id && !a.flow_name) return fail("Give flow_id (or flow_name).");
    return sendMessage(a.channel, a.to, {
      type: "flow", body: a.body, cta: a.cta, ...(a.flow_id ? { flowId: a.flow_id } : {}), ...(a.flow_name ? { flowName: a.flow_name } : {}),
      ...(a.header ? { header: { type: "text", text: a.header } } : {}), ...(a.footer ? { footer: a.footer } : {}), ...(a.screen ? { screen: a.screen } : {}),
      ...(a.data ? { data: a.data } : {}), ...(a.flow_ref ? { flowToken: a.flow_ref } : {}), ...(a.mode ? { mode: a.mode } : {}), ...(a.action ? { action: a.action } : {}),
      ...(a.reply_to ? { replyTo: a.reply_to } : {}),
    }, a.confirm, "a flow");
  });

  tool("whatsapp-business", "polpo_wabiz_send_products", {
    title: "Send WhatsApp Business products",
    description: "Send products from the catalog connected to the WhatsApp Business account (business.catalogId, or catalog_id), inside the 24-hour "
      + "window: one product, a list of up to 30 in up to 10 sections, or the whole catalog. Orders come back as structured data (channel:wabiz-event "
      + "kind order). Needs confirm: true.",
    inputSchema: {
      channel: channelParam, to: toParam,
      kind: z.enum(["product", "product_list", "catalog"]).describe("product, product_list or catalog"),
      product: z.string().optional().describe("product: its retailer id (SKU)"),
      sections: z.array(z.object({ title: z.string().describe("The section's title"), products: z.array(z.string()).describe("Retailer ids") })).optional().describe("product_list: sections"),
      header: z.string().max(60).optional().describe("product_list: the header (required there)"),
      body: z.string().optional().describe("The message's text (required for product_list and catalog)"),
      footer: z.string().max(60).optional().describe("A footer"),
      catalog_id: z.string().optional().describe("Default: business.catalogId"),
      thumbnail: z.string().optional().describe("catalog: the product shown as thumbnail"),
      reply_to: replyToParam,
      confirm: confirmParam("send it (after the person saw it and agreed)"),
    },
    outputSchema: sentOut,
    annotations: SEND,
    scope: "polpo:messages",
  }, async (a) => sendMessage(a.channel, a.to, a.kind === "product"
    ? { type: "product", productRetailerId: a.product ?? "", ...(a.catalog_id ? { catalogId: a.catalog_id } : {}), ...(a.body ? { body: a.body } : {}), ...(a.footer ? { footer: a.footer } : {}), ...(a.reply_to ? { replyTo: a.reply_to } : {}) }
    : a.kind === "product_list"
      ? { type: "product_list", header: a.header ?? "", body: a.body ?? "", ...(a.footer ? { footer: a.footer } : {}), ...(a.catalog_id ? { catalogId: a.catalog_id } : {}), sections: (a.sections ?? []).map((x) => ({ title: x.title, productRetailerIds: x.products })), ...(a.reply_to ? { replyTo: a.reply_to } : {}) }
      : { type: "catalog", body: a.body ?? "", ...(a.footer ? { footer: a.footer } : {}), ...(a.thumbnail ? { thumbnailProductRetailerId: a.thumbnail } : {}), ...(a.reply_to ? { replyTo: a.reply_to } : {}) },
  a.confirm, a.kind === "catalog" ? "the catalog" : a.kind === "product" ? "a product" : "products"));

  tool("whatsapp-business", "polpo_wabiz_send_order", {
    title: "Send WhatsApp Business order details or status",
    description: "Payments inside WhatsApp exist only in India (payment gateway or UPI) and Brazil (Pix, boleto, payment link): the channel's "
      + "business.payments.market says which. order_details sends an order the person can pay (items, tax, shipping, discount; amounts in the "
      + "currency's units); order_status updates it (pending, processing, partially-shipped, shipped, completed, canceled). Payment results come "
      + "back as channel:wabiz-event kind payment (India). Needs confirm: true.",
    inputSchema: {
      channel: channelParam, to: toParam,
      kind: z.enum(["order_details", "order_status"]).describe("order_details or order_status"),
      reference_id: z.string().min(1).max(35).describe("Your order's reference"),
      body: z.string().min(1).describe("The message's text"),
      items: z.array(z.object({ name: z.string().describe("The item"), amount: z.number().describe("Unit price (12.5 = 12.50)"), quantity: z.number().int().describe("How many"), retailer_id: z.string().optional().describe("Its catalog id") })).optional().describe("order_details: the items"),
      tax: z.number().optional().describe("Tax"), shipping: z.number().optional().describe("Shipping"), discount: z.number().optional().describe("Discount"),
      goods: z.enum(["digital-goods", "physical-goods"]).optional().describe("What is sold"),
      payment_settings: z.array(looseObject).optional().describe("Meta's payment_settings (Brazil: pix_dynamic_code / boleto / payment_link; India: payment_gateway)"),
      status: z.enum(["pending", "processing", "partially-shipped", "shipped", "completed", "canceled"]).optional().describe("order_status: the new status"),
      description: z.string().max(120).optional().describe("order_status: why"),
      confirm: confirmParam("send it (after the person saw it and agreed)"),
    },
    outputSchema: sentOut,
    annotations: SEND,
    scope: "polpo:messages",
  }, async (a) => sendMessage(a.channel, a.to, a.kind === "order_details"
    ? {
      type: "order_details", body: a.body, referenceId: a.reference_id,
      items: (a.items ?? []).map((i) => ({ name: i.name, amount: i.amount, quantity: i.quantity, ...(i.retailer_id ? { retailerId: i.retailer_id } : {}) })),
      ...(a.tax !== undefined ? { tax: a.tax } : {}), ...(a.shipping !== undefined ? { shipping: a.shipping } : {}), ...(a.discount !== undefined ? { discount: a.discount } : {}),
      ...(a.goods ? { goods: a.goods } : {}), ...(a.payment_settings ? { paymentSettings: a.payment_settings } : {}),
    }
    : { type: "order_status", body: a.body, referenceId: a.reference_id, status: a.status ?? "processing", ...(a.description ? { description: a.description } : {}) },
  a.confirm, a.kind === "order_details" ? "order details" : "an order status"));

  tool("whatsapp-business", "polpo_wabiz_react", {
    title: "React to a WhatsApp Business message, or mark it read",
    description: "React to a message of a WhatsApp Business conversation with an emoji (an empty emoji removes the reaction), inside the 24-hour "
      + "window; or read: true marks the contact's message read (blue ticks), optionally with the typing indicator. Reactions need confirm: true.",
    inputSchema: {
      channel: channelParam, to: toParam,
      message_id: z.string().min(1).describe("The message (wamid, from polpo_wabiz_conversation)"),
      emoji: z.string().max(16).optional().describe("The emoji; empty removes the reaction"),
      read: z.boolean().optional().describe("Mark it read instead"),
      typing: z.boolean().optional().describe("read: show the typing indicator too"),
      confirm: confirmParam("react (after the person agreed)"),
    },
    outputSchema: { done: z.boolean(), ids: z.array(z.string()).optional() },
    annotations: SEND,
    scope: "polpo:messages",
  }, async ({ channel, to, message_id, emoji, read, typing, confirm }) => {
    const p = await pickChannel(deps, channel);
    if (!p.ok) return p.res;
    if (read) {
      const r = await apiSend(deps, "POST", `/whatsapp-business/${enc(p.name)}/read`, { messageId: message_id, ...(typing ? { typing: true } : {}) });
      if (!r.ok) return apiError(r, `Marking ${message_id} read`);
      return ok(`Marked ${message_id} read.`, { done: true });
    }
    if (confirm !== true) return fail(`Reacting on ${p.name} is visible to ${to}: call again with confirm: true.`);
    const r = await apiSend(deps, "POST", `/whatsapp-business/${enc(p.name)}/react`, { to, messageId: message_id, emoji: emoji ?? "", by: by() });
    if (!r.ok) return apiError(r, `Reacting to ${message_id}`);
    return ok(emoji ? `Reacted ${emoji} to ${message_id}.` : `Removed the reaction on ${message_id}.`, { done: true, ids: (r.data as { ids?: string[] }).ids ?? [] });
  });

  tool("whatsapp-business", "polpo_wabiz_template_manage", {
    title: "Create, edit or delete a WhatsApp Business template",
    description: "Manage the account's message templates. create: name (lowercase, digits, underscores), language, category (UTILITY, MARKETING, "
      + "AUTHENTICATION), components as Meta defines them (HEADER, BODY with {{1}} or {{name}} and examples, FOOTER, BUTTONS: QUICK_REPLY, URL, "
      + "PHONE_NUMBER, COPY_CODE, OTP with COPY_CODE / ONE_TAP / ZERO_TAP, FLOW, CATALOG, MPM; CAROUSEL; LIMITED_TIME_OFFER); it goes to Meta's "
      + "review and its status comes back by webhook. edit: id with new components (or category); delete: name (every language) or name and id. "
      + "Needs confirm: true and the admin scope.",
    inputSchema: {
      channel: channelParam,
      action: z.enum(["create", "edit", "delete"]).describe("create, edit or delete"),
      name: z.string().optional().describe("The template's name (create, delete)"),
      language: z.string().optional().describe("create: its language code"),
      category: z.enum(["UTILITY", "MARKETING", "AUTHENTICATION"]).optional().describe("create (or edit): its category"),
      components: z.array(looseObject).optional().describe("create / edit: Meta's components"),
      parameter_format: z.enum(["POSITIONAL", "NAMED"]).optional().describe("create: {{1}} or {{name}} variables"),
      id: z.string().optional().describe("edit: the template's id; delete: one language only"),
      confirm: confirmParam("change the templates (after the person agreed)"),
    },
    outputSchema: { channel: z.string(), result: looseObject },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, async (a) => {
    const p = await pickChannel(deps, a.channel);
    if (!p.ok) return p.res;
    if (a.confirm !== true) return fail(`${a.action === "delete" ? "Deleting a template cannot be undone" : "Templates go to Meta's review"}: ask the person, then call again with confirm: true.`);
    const base = `/whatsapp-business/${enc(p.name)}/templates`;
    let r;
    if (a.action === "create") {
      if (!a.name || !a.language || !a.category || !a.components?.length) return fail("create needs name, language, category and components.");
      r = await apiSend(deps, "POST", base, { name: a.name, language: a.language, category: a.category, components: a.components, ...(a.parameter_format ? { parameterFormat: a.parameter_format } : {}) });
    } else if (a.action === "edit") {
      if (!a.id) return fail("edit needs the template's id (polpo_wabiz_templates).");
      r = await apiSend(deps, "PATCH", `${base}/${enc(a.id)}`, { ...(a.components ? { components: a.components } : {}), ...(a.category ? { category: a.category } : {}) });
    } else {
      if (!a.name) return fail("delete needs the template's name.");
      r = await apiSend(deps, "DELETE", `${base}/${enc(a.name)}${qs({ id: a.id })}`);
    }
    if (!r.ok) return apiError(r, `${a.action} template ${a.name ?? a.id ?? ""}`);
    return ok(`Template ${a.action === "create" ? "created (in review)" : a.action === "edit" ? "edited (back in review)" : "deleted"}.`, { channel: p.name, result: r.data as Record<string, unknown> });
  });

  tool("whatsapp-business", "polpo_wabiz_profile", {
    title: "WhatsApp Business profile",
    description: "Read or update the number's business profile as customers see it: about (≤ 139), description (≤ 512), address, email, up to 2 "
      + "websites, vertical (RETAIL, RESTAURANT, PROF_SERVICES…) and the photo (JPEG/PNG ≤ 5 MB, base64; needs business.appId). Without changes it "
      + "reads. Updates need confirm: true and the admin scope.",
    inputSchema: {
      channel: channelParam,
      about: z.string().max(139).optional().describe("The short status line"), description: z.string().max(512).optional().describe("The description"),
      address: z.string().max(256).optional().describe("The address"), email: z.string().max(128).optional().describe("The email"),
      websites: z.array(z.string()).max(2).optional().describe("Up to 2 websites"), vertical: z.string().optional().describe("The industry"),
      photo: fileParam.optional(),
      confirm: confirmParam("update the profile (after the person agreed)"),
    },
    outputSchema: { channel: z.string(), profile: looseObject },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (a) => {
    const p = await pickChannel(deps, a.channel);
    if (!p.ok) return p.res;
    const changes = { ...(a.about !== undefined ? { about: a.about } : {}), ...(a.description !== undefined ? { description: a.description } : {}), ...(a.address !== undefined ? { address: a.address } : {}), ...(a.email !== undefined ? { email: a.email } : {}), ...(a.websites ? { websites: a.websites } : {}), ...(a.vertical ? { vertical: a.vertical } : {}) };
    if (!Object.keys(changes).length && !a.photo) {
      const r = await apiGet(deps, `/whatsapp-business/${enc(p.name)}/profile`);
      if (!r.ok) return apiError(r, "Reading the profile");
      const prof = r.data as Record<string, unknown>;
      return ok(Object.entries(prof).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : String(v)}`).join("\n") || "The profile is empty.", { channel: p.name, profile: prof });
    }
    if (a.confirm !== true) return fail("The profile is public: show the person the changes, then call again with confirm: true.");
    const r = await apiSend(deps, "PUT", `/whatsapp-business/${enc(p.name)}/profile`, { ...changes, ...(a.photo ? { photo: { data: a.photo.data, mimeType: a.photo.mime_type, filename: a.photo.filename } } : {}) });
    if (!r.ok) return apiError(r, "Updating the profile");
    return ok("Profile updated.", { channel: p.name, profile: r.data as Record<string, unknown> });
  });

  tool("whatsapp-business", "polpo_wabiz_block", {
    title: "Block or unblock WhatsApp Business contacts",
    description: "Block contacts (they can no longer write to the number; Meta allows it only for people who wrote in the last 24 hours) or unblock "
      + "them; list: who is blocked. Block and unblock need confirm: true and the admin scope.",
    inputSchema: {
      channel: channelParam,
      action: z.enum(["list", "block", "unblock"]).describe("list (default), block or unblock"),
      contacts: z.array(z.string()).max(1000).optional().describe("Phone numbers with country code"),
      confirm: confirmParam("block or unblock (after the person agreed)"),
    },
    outputSchema: { channel: z.string(), blocked: z.array(z.string()).optional(), result: looseObject.optional() },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  }, async ({ channel, action, contacts, confirm }) => {
    const p = await pickChannel(deps, channel);
    if (!p.ok) return p.res;
    if (!action || action === "list") {
      const r = await apiGet(deps, `/whatsapp-business/${enc(p.name)}/blocked`);
      if (!r.ok) return apiError(r, "Reading the blocked contacts");
      const blocked = (r.data as { blocked: string[] }).blocked;
      return ok(blocked.join("\n") || "Nobody is blocked.", { channel: p.name, blocked });
    }
    if (!contacts?.length) return fail("Give the contacts.");
    if (confirm !== true) return fail(`${action === "block" ? "Blocking stops them writing to the number" : "Unblocking lets them write again"}: ask the person, then call again with confirm: true.`);
    const r = await apiSend(deps, "POST", `/whatsapp-business/${enc(p.name)}/block`, { users: contacts, block: action === "block", by: by() });
    if (!r.ok) return apiError(r, `${action} ${contacts.join(", ")}`);
    const d = r.data as { done: string[]; failed: Array<{ user: string; error: string }> };
    return ok(`${action === "block" ? "Blocked" : "Unblocked"}: ${d.done.join(", ") || "none"}${d.failed.length ? `; refused: ${d.failed.map((f) => `${f.user} (${f.error})`).join(", ")}` : ""}.`, { channel: p.name, result: d as unknown as Record<string, unknown> });
  });

  tool("whatsapp-business", "polpo_wabiz_analytics", {
    title: "WhatsApp Business analytics",
    description: "Meta's analytics for the account: messages (sent and delivered per HALF_HOUR, DAY or MONTH), pricing (cost and volume per category, "
      + "DAILY / HALF_HOUR / MONTHLY, optional dimensions COUNTRY, PHONE, PRICING_CATEGORY, PRICING_TYPE, TIER), templates (sent, delivered, read, "
      + "clicked per template, daily, up to 10 template ids, last 90 days). Times are ISO dates or Unix seconds (default: the last 7 days).",
    inputSchema: {
      channel: channelParam,
      kind: z.enum(["messages", "pricing", "templates"]).describe("messages, pricing or templates"),
      start: z.string().optional().describe("From (ISO date or Unix seconds)"), end: z.string().optional().describe("To (default now)"),
      granularity: z.string().optional().describe("messages: HALF_HOUR, DAY, MONTH; pricing: DAILY, HALF_HOUR, MONTHLY"),
      template_ids: z.array(z.string()).max(10).optional().describe("templates: their ids (polpo_wabiz_templates)"),
      dimensions: z.array(z.string()).optional().describe("pricing: breakdowns"),
    },
    outputSchema: { channel: z.string(), data: z.unknown() },
    annotations: READ,
  }, async (a) => {
    const p = await pickChannel(deps, a.channel);
    if (!p.ok) return p.res;
    const secs = (v: string | undefined, def: number) => (v ? (/^\d+$/.test(v) ? Number(v) : Math.floor(Date.parse(v) / 1000)) : def);
    const now = Math.floor(Date.now() / 1000);
    const end = secs(a.end, now);
    const start = secs(a.start, end - 7 * 86_400);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return fail("start and end: ISO dates or Unix seconds.");
    const r = await apiGet(deps, `/whatsapp-business/${enc(p.name)}/analytics${qs({ kind: a.kind, start, end, granularity: a.granularity, templateIds: a.template_ids?.join(","), dimensions: a.dimensions?.join(",") })}`);
    if (!r.ok) return apiError(r, `Reading ${a.kind} analytics`);
    return ok(short(JSON.stringify(r.data), 8000), { channel: p.name, data: r.data });
  });

  tool("whatsapp-business", "polpo_wabiz_phone", {
    title: "WhatsApp Business phone number",
    description: "The phone number at Meta and its setup. status (default): name and its review, quality rating, messaging tier, mode, the account "
      + "updates Meta sent (quality, name, templates, capabilities), and the callback Meta uses for it. register (with the 6-digit two-step PIN), "
      + "deregister, set_pin, request_code (SMS or VOICE), verify_code, subscribe_app (subscribe the app to the account's webhooks), "
      + "override_webhook / clear_override (one Meta app shared by several instances: this number's deliveries go to this instance). Changes need "
      + "confirm: true and the admin scope.",
    inputSchema: {
      channel: channelParam,
      action: z.enum(["status", "register", "deregister", "set_pin", "request_code", "verify_code", "subscribe_app", "override_webhook", "clear_override"]).optional().describe("status (default) or a change"),
      pin: z.string().regex(/^\d{6}$/).optional().describe("register / set_pin: the 6-digit PIN"),
      code: z.string().regex(/^\d{4,8}$/).optional().describe("verify_code: the code received"),
      method: z.enum(["SMS", "VOICE"]).optional().describe("request_code: how"),
      language: z.string().optional().describe("request_code: the language (en_US…)"),
      confirm: confirmParam("change the number's setup (after the person agreed)"),
    },
    outputSchema: { channel: z.string(), phone: looseObject.optional(), webhook: looseObject.optional(), account_events: z.array(looseObject).optional(), done: z.string().optional() },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, async (a) => {
    const p = await pickChannel(deps, a.channel);
    if (!p.ok) return p.res;
    const base = `/whatsapp-business/${enc(p.name)}`;
    if (!a.action || a.action === "status") {
      const [t, w, e] = await Promise.all([apiSend(deps, "POST", `${base}/test`), apiGet(deps, `${base}/webhook-override`), apiGet(deps, `${base}/account-events${qs({ limit: 10 })}`)]);
      const phone = t.ok ? (t.data as Record<string, unknown>) : undefined;
      const webhook = w.ok ? (w.data as Record<string, unknown>) : undefined;
      const events = e.ok ? (e.data as { events: Array<Record<string, unknown>> }).events : [];
      const lines = [
        phone ? `number: ${String(phone.displayPhoneNumber ?? "?")} "${String(phone.verifiedName ?? "")}" name ${String(phone.nameStatus ?? "?")}, quality ${String(phone.qualityRating ?? "?")}, tier ${String(phone.messagingLimitTier ?? "?")}, mode ${String(phone.accountMode ?? "?")}` : `number: ${t.ok ? "" : t.error}`,
        webhook ? `callback here: ${String(webhook.callbackUrl ?? "POLPO_PUBLIC_URL not set")}; Meta: ${JSON.stringify(webhook.current ?? {})}` : "",
        ...events.map((x) => `- ${String(x.at)} ${String(x.field)}: ${String(x.summary)}`),
      ].filter(Boolean);
      return ok(lines.join("\n"), { channel: p.name, ...(phone ? { phone } : {}), ...(webhook ? { webhook } : {}), account_events: events });
    }
    if (a.confirm !== true) return fail(`${a.action.replace(/_/g, " ")} changes the number's setup at Meta: ask the person, then call again with confirm: true.`);
    const r = a.action === "override_webhook" || a.action === "clear_override"
      ? await apiSend(deps, "PUT", `${base}/webhook-override`, { set: a.action === "override_webhook" })
      : await apiSend(deps, "POST", `${base}/phone`, { action: a.action, ...(a.pin ? { pin: a.pin } : {}), ...(a.code ? { code: a.code } : {}), ...(a.method ? { method: a.method } : {}), ...(a.language ? { language: a.language } : {}) });
    if (!r.ok) return apiError(r, a.action.replace(/_/g, " "));
    return ok(`${a.action.replace(/_/g, " ")}: done.`, { channel: p.name, done: a.action, ...(a.action.includes("override") ? { webhook: r.data as Record<string, unknown> } : {}) });
  });
}
