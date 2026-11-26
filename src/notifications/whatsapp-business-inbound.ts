/**
 * WhatsApp Business inbound messages (the messages webhook), normalized: what the agent reads (a
 * text, with media as attachments), what the conversation keeps (structured content), and a
 * structured event for triggers (a flow completed, an order, an address, a call permission…).
 *
 * Types (Cloud API webhooks reference): text, image, audio (voice: true for voice notes), video,
 * document, sticker (animated), location, contacts, interactive (button_reply, list_reply,
 * nfm_reply — flows and address messages —, call_permission_reply, product), button (a template's
 * quick reply), order, reaction, system, request_welcome, unsupported, and on Coexistence numbers
 * edit and revoke. Every message may carry context (a quoted message, forwarded flags, a referred
 * product) and referral (click-to-WhatsApp ads).
 */
import type { WaBizContext, WaBizMedia, WaBizMediaKind } from "@polpo-ai/core/whatsapp-business";

export interface WaBizInboundEvent {
  kind: "button" | "list" | "flow" | "address" | "call_permission" | "order" | "location" | "contacts" | "product_enquiry" | "welcome" | "media";
  data: Record<string, unknown>;
}

export interface WaBizParsedInbound {
  /** The webhook's type, with the interactive reply's: text, image…, interactive.button_reply, interactive.nfm_reply… */
  type: string;
  /** What the agent reads (media come as attachments; their caption is the text). */
  text: string;
  media?: WaBizMedia;
  content?: Record<string, unknown>;
  context?: WaBizContext;
  referral?: Record<string, unknown>;
  /** Whether the channel's agent answers it (reactions, edits, revokes, system notices are not messages to answer). */
  route: boolean;
  reaction?: { messageId: string; emoji: string };
  edit?: { originalId: string; text: string };
  revoke?: { originalId: string };
  event?: WaBizInboundEvent;
}

const MEDIA_KINDS: readonly WaBizMediaKind[] = ["image", "audio", "video", "document", "sticker"];

function parseJson(v: unknown): unknown {
  if (typeof v !== "string") return v;
  try { return JSON.parse(v); } catch { return v; }
}

const s = (v: unknown) => (typeof v === "string" ? v : v === undefined || v === null ? "" : String(v));

function context(m: any): WaBizContext | undefined {
  const c = m?.context;
  if (!c || typeof c !== "object") return undefined;
  const out: WaBizContext = {
    ...(c.id ? { id: s(c.id) } : {}),
    ...(c.forwarded ? { forwarded: true } : {}),
    ...(c.frequently_forwarded ? { frequentlyForwarded: true } : {}),
    ...(c.referred_product ? { referredProduct: { ...(c.referred_product.catalog_id ? { catalogId: s(c.referred_product.catalog_id) } : {}), ...(c.referred_product.product_retailer_id ? { productRetailerId: s(c.referred_product.product_retailer_id) } : {}) } } : {}),
  };
  return Object.keys(out).length ? out : undefined;
}

function contactLine(c: any): string {
  const name = s(c?.name?.formatted_name) || [s(c?.name?.first_name), s(c?.name?.last_name)].filter(Boolean).join(" ") || "(no name)";
  const phones = (Array.isArray(c?.phones) ? c.phones : []).map((p: any) => s(p?.phone)).filter(Boolean);
  const emails = (Array.isArray(c?.emails) ? c.emails : []).map((e: any) => s(e?.email)).filter(Boolean);
  return [name, ...phones, ...emails].join(", ");
}

/** Normalize one webhook message. */
export function parseInbound(m: any): WaBizParsedInbound {
  const type = s(m?.type) || "unknown";
  const ctx = context(m);
  const referral = m?.referral && typeof m.referral === "object" ? (m.referral as Record<string, unknown>) : undefined;
  const base = { ...(ctx ? { context: ctx } : {}), ...(referral ? { referral } : {}) };
  const prefix = [
    ctx?.forwarded ? (ctx.frequentlyForwarded ? "[forwarded many times]" : "[forwarded]") : "",
    ctx?.referredProduct?.productRetailerId ? `[about product ${ctx.referredProduct.productRetailerId}]` : "",
    referral ? `[came from an ad${referral.headline ? `: ${s(referral.headline)}` : ""}]` : "",
  ].filter(Boolean).join(" ");
  const withPrefix = (t: string) => (prefix ? `${prefix} ${t}` : t);

  if (type === "text") return { ...base, type, text: withPrefix(s(m.text?.body)), route: true };

  if ((MEDIA_KINDS as readonly string[]).includes(type)) {
    const v = m[type] ?? {};
    const kind = type as WaBizMediaKind;
    const media: WaBizMedia = {
      kind,
      ...(v.id ? { mediaId: s(v.id) } : {}), ...(v.mime_type ? { mimeType: s(v.mime_type) } : {}), ...(v.sha256 ? { sha256: s(v.sha256) } : {}),
      ...(typeof v.file_size === "number" ? { size: v.file_size } : {}),
      ...(v.filename ? { filename: s(v.filename) } : {}), ...(v.caption ? { caption: s(v.caption) } : {}),
      ...(kind === "audio" && v.voice ? { voice: true } : {}), ...(kind === "sticker" && v.animated ? { animated: true } : {}),
    };
    const caption = media.caption ?? "";
    return { ...base, type: kind === "audio" && media.voice ? "voice" : kind, text: withPrefix(caption), media, route: true, event: { kind: "media", data: { kind: media.voice ? "voice" : kind, mimeType: media.mimeType, filename: media.filename } } };
  }

  if (type === "location") {
    const l = m.location ?? {};
    const content = { latitude: Number(l.latitude), longitude: Number(l.longitude), ...(l.name ? { name: s(l.name) } : {}), ...(l.address ? { address: s(l.address) } : {}), ...(l.url ? { url: s(l.url) } : {}) };
    const where = [content.name, content.address].filter(Boolean).join(", ");
    return { ...base, type, text: withPrefix(`[location: ${content.latitude}, ${content.longitude}${where ? ` — ${where}` : ""}]`), content, route: true, event: { kind: "location", data: content } };
  }

  if (type === "contacts") {
    const list = Array.isArray(m.contacts) ? m.contacts : [];
    return { ...base, type, text: withPrefix(`[shared contact${list.length === 1 ? "" : "s"}: ${list.map(contactLine).join("; ")}]`), content: { contacts: list }, route: true, event: { kind: "contacts", data: { contacts: list } } };
  }

  if (type === "interactive") {
    const i = m.interactive ?? {};
    const sub = s(i.type);
    if (sub === "button_reply") {
      const r = i.button_reply ?? {};
      const content = { reply: "button", id: s(r.id), title: s(r.title), ...(ctx?.id ? { to: ctx.id } : {}) };
      return { ...base, type: `interactive.${sub}`, text: `${s(r.title)}\n[button reply: id "${s(r.id)}"]`, content, route: true, event: { kind: "button", data: content } };
    }
    if (sub === "list_reply") {
      const r = i.list_reply ?? {};
      const content = { reply: "list", id: s(r.id), title: s(r.title), ...(r.description ? { description: s(r.description) } : {}), ...(ctx?.id ? { to: ctx.id } : {}) };
      return { ...base, type: `interactive.${sub}`, text: `${[s(r.title), s(r.description)].filter(Boolean).join(" — ")}\n[list reply: id "${s(r.id)}"]`, content, route: true, event: { kind: "list", data: content } };
    }
    if (sub === "nfm_reply") {
      const r = i.nfm_reply ?? {};
      const response = parseJson(r.response_json);
      const name = s(r.name) || "flow";
      if (name === "address_message") {
        const content = { reply: "address", address: response, ...(ctx?.id ? { to: ctx.id } : {}) };
        return { ...base, type: `interactive.${sub}`, text: `[address sent: ${JSON.stringify(response)}]`, content, route: true, event: { kind: "address", data: content } };
      }
      const flowToken = response && typeof response === "object" ? (response as { flow_token?: unknown }).flow_token : undefined;
      const content = { reply: "flow", name, ...(r.body ? { body: s(r.body) } : {}), response, ...(flowToken ? { flowToken: s(flowToken) } : {}), ...(ctx?.id ? { to: ctx.id } : {}) };
      return { ...base, type: `interactive.${sub}`, text: `[flow completed${flowToken ? ` (token ${s(flowToken)})` : ""}: ${JSON.stringify(response)}]`, content, route: true, event: { kind: "flow", data: content } };
    }
    if (sub === "call_permission_reply") {
      const r = i.call_permission_reply ?? {};
      const content = {
        reply: "call_permission", response: s(r.response) === "accept" ? "accept" : "reject", ...(typeof r.is_permanent === "boolean" ? { permanent: r.is_permanent } : {}),
        ...(r.expiration_timestamp ? { expiresAt: new Date(Number(r.expiration_timestamp) * 1000).toISOString() } : {}), ...(r.response_source ? { source: s(r.response_source) } : {}),
      };
      return { ...base, type: `interactive.${sub}`, text: `[call permission: ${content.response}${content.permanent ? " (permanent)" : content.expiresAt ? ` until ${content.expiresAt}` : ""}]`, content, route: false, event: { kind: "call_permission", data: content } };
    }
    if (sub === "product") {
      const p = i.product ?? {};
      return { ...base, type: `interactive.${sub}`, text: withPrefix(`[asked about product ${s(p.retailer_id)}${p.title ? `: ${s(p.title)}` : ""}]`), content: { product: p }, route: true, event: { kind: "product_enquiry", data: { product: p } } };
    }
    return { ...base, type: `interactive.${sub || "unknown"}`, text: "[interactive reply]", content: { interactive: i }, route: true };
  }

  if (type === "button") {
    const b = m.button ?? {};
    const content = { reply: "template_button", text: s(b.text), ...(b.payload ? { payload: s(b.payload) } : {}), ...(ctx?.id ? { to: ctx.id } : {}) };
    return { ...base, type, text: `${s(b.text) || s(b.payload)}${b.payload ? `\n[template button: payload "${s(b.payload)}"]` : ""}`, content, route: true, event: { kind: "button", data: content } };
  }

  if (type === "order") {
    const o = m.order ?? {};
    const items = (Array.isArray(o.product_items) ? o.product_items : []).map((it: any) => ({
      productRetailerId: s(it.product_retailer_id), quantity: Number(it.quantity), itemPrice: Number(it.item_price), currency: s(it.currency),
    }));
    const total = items.reduce((n: number, it: { quantity: number; itemPrice: number }) => n + (Number.isFinite(it.quantity * it.itemPrice) ? it.quantity * it.itemPrice : 0), 0);
    const currency = items[0]?.currency ?? "";
    const content = { order: { catalogId: s(o.catalog_id), ...(o.text ? { text: s(o.text) } : {}), items, total, currency } };
    const lines = items.map((it: { quantity: number; productRetailerId: string; itemPrice: number; currency: string }) => `${it.quantity}× ${it.productRetailerId} at ${it.itemPrice} ${it.currency}`).join(", ");
    return { ...base, type, text: `${o.text ? `${s(o.text)}\n` : ""}[order from catalog ${s(o.catalog_id)}: ${lines}; total ${total} ${currency}]`, content, route: true, event: { kind: "order", data: content.order } };
  }

  if (type === "reaction") {
    const r = m.reaction ?? {};
    return { ...base, type, text: "", route: false, reaction: { messageId: s(r.message_id), emoji: s(r.emoji) } };
  }

  if (type === "edit") {
    const e = m.edit ?? {};
    const inner = e.message ?? {};
    const text = s(inner.text?.body ?? inner[s(inner.type)]?.caption);
    return { ...base, type, text, route: false, edit: { originalId: s(e.original_message_id), text } };
  }

  if (type === "revoke") return { ...base, type, text: "", route: false, revoke: { originalId: s(m.revoke?.original_message_id) } };

  if (type === "request_welcome") {
    return { ...base, type, text: "[The person opened the chat with this business for the first time: greet them and say how you can help]", route: true, event: { kind: "welcome", data: {} } };
  }

  if (type === "system") {
    const sy = m.system ?? {};
    return { ...base, type, text: `[system: ${s(sy.body) || s(sy.type)}]`, content: { system: sy }, route: false };
  }

  // unsupported (a poll, a deleted message…) and anything new
  const err = Array.isArray(m?.errors) ? m.errors[0] : undefined;
  return { ...base, type, text: `[a message WhatsApp does not pass to businesses${err?.title ? `: ${s(err.title)}` : ""}]`, ...(err ? { content: { error: err } } : {}), route: false };
}
