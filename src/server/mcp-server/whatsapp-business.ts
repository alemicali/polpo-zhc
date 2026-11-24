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
      outcome: z.array(z.enum(["accepted", "ignored", "rejected", "error"])).optional(),
      limit: z.number().int().min(1).max(100).optional(), cursor: z.string().optional(), id: z.string().optional(),
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
    inputSchema: { channel: channelParam, refresh: z.boolean().optional() },
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
    inputSchema: { channel: channelParam, to: toParam.optional(), limit: z.number().int().min(1).max(100).optional() },
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
    inputSchema: { channel: channelParam, to: toParam, text: z.string().min(1).max(20_000), confirm: confirmParam("send it (after the person saw it and agreed)") },
    outputSchema: { sent: z.boolean(), ids: z.array(z.string()).optional() },
    annotations: SEND,
    scope: "polpo:messages",
  }, async ({ channel, to, text, confirm }) => {
    const p = await pickChannel(deps, channel);
    if (!p.ok) return p.res;
    if (confirm !== true) return fail(`Sending to ${to} on ${p.name} is real: show the person the message, then call again with confirm: true.`);
    const r = await apiSend(deps, "POST", `/whatsapp-business/${enc(p.name)}/send`, { to, text, by: isPolpo() ? "polpo" : (deps.principal?.actor ?? "mcp") });
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
      confirm: confirmParam("send it (after the person saw it and agreed)"),
    },
    outputSchema: { status: z.enum(["sent", "pending_approval"]), ids: z.array(z.string()).optional(), id: z.string().optional() },
    annotations: SEND,
    scope: "polpo:messages",
  }, async ({ channel, to, template, language, params, reason, confirm }) => {
    const p = await pickChannel(deps, channel);
    if (!p.ok) return p.res;
    if (confirm !== true) return fail(`Sending template ${template} to ${to} is real and costs money: show the person, then call again with confirm: true.`);
    const r = await apiSend(deps, "POST", `/whatsapp-business/${enc(p.name)}/send-template`, {
      to, template, ...(language ? { language } : {}), params: params ?? [], ...(reason ? { reason } : {}),
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
      channel: channelParam, action: z.enum(["list", "approve", "reject"]).optional(), id: z.string().optional().describe("The queued send (pending_…)"),
      reason: z.string().max(500).optional(), confirm: confirmParam("approve or reject it (the person decided)"),
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

}
