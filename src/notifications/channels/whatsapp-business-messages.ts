/**
 * WhatsApp Business (Cloud API) message payloads: every type a business can send inside the
 * 24-hour window (text, media, location, contacts, reactions, interactive buttons / lists / CTA URL
 * / location request / flows / products / catalog / voice call / call permission / address / order
 * details and status) and templates with all their components, checked against Meta's limits and
 * the template's own definition before anything is sent.
 *
 * Shapes (POST /{phone-number-id}/messages, Cloud API reference):
 *   { type: "image" | "audio" | "video" | "document" | "sticker", <kind>: { id | link, caption?, filename? } }
 *   { type: "location", location: { latitude, longitude, name?, address? } }
 *   { type: "contacts", contacts: [{ name: { formatted_name, … }, phones: [{ phone, type, wa_id }], … }] }
 *   { type: "reaction", reaction: { message_id, emoji } }            (emoji "" removes it)
 *   { type: "interactive", interactive: { type: "button" | "list" | "cta_url" | "location_request_message" | "flow"
 *       | "product" | "product_list" | "catalog_message" | "voice_call" | "call_permission_request" | "address_message"
 *       | "order_details" | "order_status", header?, body?, footer?, action } }
 *   { type: "template", template: { name, language: { code }, components: [header, body, button…, carousel] } }
 *   context: { message_id } quotes a message.
 */
import {
  WABIZ_TEXT_MAX, mediaProblem,
  type WaBizInteractiveHeader, type WaBizOutbound, type WaBizSharedContact, type WaBizTemplateInput,
} from "@polpo-ai/core/whatsapp-business";

/** A template as synced from Meta (GET /{waba-id}/message_templates). */
export interface WaTemplateButton {
  type?: string;
  text?: string;
  url?: string;
  phone_number?: string;
  otp_type?: string;
  flow_id?: string;
  example?: unknown;
}

export interface WaTemplateComponent {
  type: string;
  format?: string;
  text?: string;
  buttons?: WaTemplateButton[];
  /** CAROUSEL: each card's components (header, body, buttons). */
  cards?: Array<{ components: WaTemplateComponent[] }>;
  example?: unknown;
  /** LIMITED_TIME_OFFER */
  limited_time_offer?: { text?: string; has_expiration?: boolean };
  add_security_recommendation?: boolean;
  code_expiration_minutes?: number;
}

export interface WaTemplate {
  id?: string;
  name: string;
  language: string;
  status: string;
  category: string;
  parameterFormat?: "POSITIONAL" | "NAMED";
  components: WaTemplateComponent[];
  /** Meta's quality score (GREEN, YELLOW, RED, UNKNOWN). */
  quality?: string;
  rejectedReason?: string;
}

const LIMIT = {
  bodyInteractive: 1024, bodyList: 4096, header: 60, footer: 60, buttonTitle: 20, buttonId: 256, buttons: 3,
  listButton: 20, sections: 10, rows: 10, sectionTitle: 24, rowTitle: 24, rowDescription: 72, rowId: 200,
  ctaText: 20, flowCta: 30, products: 30, productSections: 10, caption: 1024, callButton: 20, callPayload: 512,
} as const;

export class WaPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WaPayloadError";
  }
}

const fail = (m: string): never => { throw new WaPayloadError(m); };
const str = (v: unknown) => (typeof v === "string" ? v : "");
function need(v: unknown, what: string, max?: number): string {
  const s = str(v).trim();
  if (!s) fail(`${what} is required`);
  if (max && s.length > max) fail(`${what}: at most ${max} characters (got ${s.length})`);
  return s;
}
function opt(v: unknown, what: string, max: number): string | undefined {
  const s = str(v).trim();
  if (!s) return undefined;
  if (s.length > max) fail(`${what}: at most ${max} characters (got ${s.length})`);
  return s;
}

function mediaRef(o: { link?: string; mediaId?: string; filename?: string; caption?: string }, what: string): Record<string, string> {
  if (!o.mediaId && !o.link) fail(`${what}: a media id or a public https link`);
  if (o.link) {
    let ok = false;
    try { ok = new URL(o.link).protocol === "https:"; } catch { ok = false; }
    if (!ok) fail(`${what}: the link must be a public https URL`);
  }
  return {
    ...(o.mediaId ? { id: o.mediaId } : { link: o.link! }),
    ...(o.filename ? { filename: o.filename } : {}),
    ...(o.caption ? { caption: o.caption } : {}),
  };
}

function header(h: WaBizInteractiveHeader | undefined): Record<string, unknown> | undefined {
  if (!h) return undefined;
  if (h.type === "text") return { type: "text", text: need(h.text, "header", LIMIT.header) };
  if (h.type !== "image" && h.type !== "video" && h.type !== "document") fail(`header type ${String((h as { type?: unknown }).type)}: text, image, video or document`);
  return { type: h.type, [h.type]: mediaRef(h, `${h.type} header`) };
}

function contactCard(c: WaBizSharedContact): Record<string, unknown> {
  const name = need(c.name, "contact name", 200);
  const parts = name.split(/\s+/);
  if (!c.phones?.length && !c.emails?.length) fail(`contact ${name}: at least a phone number or an email`);
  const last = c.lastName ?? (parts.length > 1 ? parts.slice(1).join(" ") : undefined);
  return {
    name: { formatted_name: name, first_name: c.firstName ?? parts[0], ...(last ? { last_name: last } : {}) },
    ...(c.phones?.length ? { phones: c.phones.map((p) => ({ phone: need(p.phone, "phone", 40), ...(p.type ? { type: p.type } : {}), ...(p.waId ? { wa_id: p.waId } : {}) })) } : {}),
    ...(c.emails?.length ? { emails: c.emails.map((e) => ({ email: need(e.email, "email", 200), ...(e.type ? { type: e.type } : {}) })) } : {}),
    ...(c.company || c.title ? { org: { ...(c.company ? { company: c.company } : {}), ...(c.title ? { title: c.title } : {}) } } : {}),
    ...(c.urls?.length ? { urls: c.urls.map((u) => ({ url: need(u.url, "url", 500), ...(u.type ? { type: u.type } : {}) })) } : {}),
  };
}

const money = (amount: number) => ({ value: Math.round(amount * 100), offset: 100 });

/** Meta's message body (without messaging_product and the recipient), checked against the limits. */
export function outboundPayload(o: WaBizOutbound, defaults: { catalogId?: string; payments?: { market: "IN" | "BR"; configurationName?: string } } = {}): Record<string, unknown> {
  const context = o.replyTo ? { context: { message_id: o.replyTo } } : {};
  const interactive = (body: Record<string, unknown>) => ({ ...context, type: "interactive", interactive: body });
  switch (o.type) {
    case "text": {
      const text = need(o.text, "text", WABIZ_TEXT_MAX);
      return { ...context, type: "text", text: { body: text, preview_url: o.previewUrl === true } };
    }
    case "media": {
      if (o.kind === "audio" || o.kind === "sticker") {
        if (o.caption) fail(`A WhatsApp ${o.kind} has no caption`);
      }
      if (o.filename && o.kind !== "document") fail("Only a document has a file name");
      const caption = opt(o.caption, "caption", LIMIT.caption);
      return { ...context, type: o.kind, [o.kind]: mediaRef({ ...o, ...(caption ? { caption } : { caption: undefined }) }, o.kind) };
    }
    case "location": {
      if (!Number.isFinite(o.latitude) || Math.abs(o.latitude) > 90) fail("latitude: -90 to 90");
      if (!Number.isFinite(o.longitude) || Math.abs(o.longitude) > 180) fail("longitude: -180 to 180");
      return { ...context, type: "location", location: { latitude: o.latitude, longitude: o.longitude, ...(o.name ? { name: o.name } : {}), ...(o.address ? { address: o.address } : {}) } };
    }
    case "contacts": {
      if (!o.contacts?.length) fail("contacts: at least one");
      return { ...context, type: "contacts", contacts: o.contacts.map(contactCard) };
    }
    case "reaction":
      // an empty emoji removes the reaction
      return { type: "reaction", reaction: { message_id: need(o.messageId, "the message to react to"), emoji: str(o.emoji) } };
    case "buttons": {
      if (!o.buttons?.length || o.buttons.length > LIMIT.buttons) fail(`buttons: 1 to ${LIMIT.buttons} (got ${o.buttons?.length ?? 0})`);
      const ids = new Set<string>();
      const buttons = o.buttons.map((b) => {
        const id = need(b.id, "button id", LIMIT.buttonId);
        if (ids.has(id)) fail(`button ids must be unique ("${id}")`);
        ids.add(id);
        return { type: "reply", reply: { id, title: need(b.title, "button title", LIMIT.buttonTitle) } };
      });
      const h = header(o.header);
      const footer = opt(o.footer, "footer", LIMIT.footer);
      return interactive({ type: "button", ...(h ? { header: h } : {}), body: { text: need(o.body, "body", LIMIT.bodyInteractive) }, ...(footer ? { footer: { text: footer } } : {}), action: { buttons } });
    }
    case "list": {
      if (!o.sections?.length || o.sections.length > LIMIT.sections) fail(`sections: 1 to ${LIMIT.sections}`);
      const rows = o.sections.reduce((n, s) => n + (s.rows?.length ?? 0), 0);
      if (rows < 1 || rows > LIMIT.rows) fail(`rows: 1 to ${LIMIT.rows} across all sections (got ${rows})`);
      if (o.sections.length > 1 && o.sections.some((s) => !str(s.title).trim())) fail("with several sections each needs a title");
      const ids = new Set<string>();
      const sections = o.sections.map((s) => ({
        ...(s.title ? { title: need(s.title, "section title", LIMIT.sectionTitle) } : {}),
        rows: (s.rows ?? []).map((r) => {
          const id = need(r.id, "row id", LIMIT.rowId);
          if (ids.has(id)) fail(`row ids must be unique ("${id}")`);
          ids.add(id);
          const description = opt(r.description, "row description", LIMIT.rowDescription);
          return { id, title: need(r.title, "row title", LIMIT.rowTitle), ...(description ? { description } : {}) };
        }),
      }));
      const head = opt(o.header, "header", LIMIT.header);
      const footer = opt(o.footer, "footer", LIMIT.footer);
      return interactive({
        type: "list", ...(head ? { header: { type: "text", text: head } } : {}), body: { text: need(o.body, "body", LIMIT.bodyList) },
        ...(footer ? { footer: { text: footer } } : {}), action: { button: need(o.button, "list button", LIMIT.listButton), sections },
      });
    }
    case "cta_url": {
      let ok = false;
      try { ok = ["https:", "http:"].includes(new URL(o.url).protocol); } catch { ok = false; }
      if (!ok) fail("url: a web address (https)");
      const h = header(o.header);
      const footer = opt(o.footer, "footer", LIMIT.footer);
      return interactive({
        type: "cta_url", ...(h ? { header: h } : {}), body: { text: need(o.body, "body", LIMIT.bodyInteractive) }, ...(footer ? { footer: { text: footer } } : {}),
        action: { name: "cta_url", parameters: { display_text: need(o.displayText, "button text", LIMIT.ctaText), url: o.url } },
      });
    }
    case "location_request":
      return interactive({ type: "location_request_message", body: { text: need(o.body, "body", LIMIT.bodyInteractive) }, action: { name: "send_location" } });
    case "flow": {
      if (!o.flowId && !o.flowName) fail("flow: the published flow's id (or its name)");
      const h = header(o.header);
      const footer = opt(o.footer, "footer", LIMIT.footer);
      const action = o.action ?? "navigate";
      if (action === "navigate" && o.data && !o.screen) fail("flow: data needs the screen it opens on");
      return interactive({
        type: "flow", ...(h ? { header: h } : {}), body: { text: need(o.body, "body", LIMIT.bodyInteractive) }, ...(footer ? { footer: { text: footer } } : {}),
        action: {
          name: "flow",
          parameters: {
            flow_message_version: "3",
            ...(o.flowId ? { flow_id: o.flowId } : { flow_name: o.flowName }),
            flow_cta: need(o.cta, "flow button text", LIMIT.flowCta),
            flow_token: o.flowToken || "unused",
            mode: o.mode ?? "published",
            flow_action: action,
            ...(action === "navigate" && o.screen ? { flow_action_payload: { screen: o.screen, ...(o.data ? { data: o.data } : {}) } } : {}),
          },
        },
      });
    }
    case "product": {
      const catalog = o.catalogId || defaults.catalogId || fail("product: the catalog id (business.catalogId or catalogId)");
      const body = opt(o.body, "body", LIMIT.bodyInteractive);
      const footer = opt(o.footer, "footer", LIMIT.footer);
      return interactive({
        type: "product", ...(body ? { body: { text: body } } : {}), ...(footer ? { footer: { text: footer } } : {}),
        action: { catalog_id: catalog, product_retailer_id: need(o.productRetailerId, "product (retailer id)") },
      });
    }
    case "product_list": {
      const catalog = o.catalogId || defaults.catalogId || fail("product_list: the catalog id (business.catalogId or catalogId)");
      if (!o.sections?.length || o.sections.length > LIMIT.productSections) fail(`sections: 1 to ${LIMIT.productSections}`);
      const total = o.sections.reduce((n, s) => n + (s.productRetailerIds?.length ?? 0), 0);
      if (total < 1 || total > LIMIT.products) fail(`products: 1 to ${LIMIT.products} (got ${total})`);
      const footer = opt(o.footer, "footer", LIMIT.footer);
      return interactive({
        type: "product_list", header: { type: "text", text: need(o.header, "header", LIMIT.header) }, body: { text: need(o.body, "body", LIMIT.bodyInteractive) },
        ...(footer ? { footer: { text: footer } } : {}),
        action: {
          catalog_id: catalog,
          sections: o.sections.map((s) => ({ title: need(s.title, "section title", LIMIT.sectionTitle), product_items: s.productRetailerIds.map((id) => ({ product_retailer_id: need(id, "product (retailer id)") })) })),
        },
      });
    }
    case "catalog": {
      const footer = opt(o.footer, "footer", LIMIT.footer);
      return interactive({
        type: "catalog_message", body: { text: need(o.body, "body", LIMIT.bodyInteractive) }, ...(footer ? { footer: { text: footer } } : {}),
        action: { name: "catalog_message", ...(o.thumbnailProductRetailerId ? { parameters: { thumbnail_product_retailer_id: o.thumbnailProductRetailerId } } : {}) },
      });
    }
    case "voice_call": {
      if (o.ttlMinutes !== undefined && (!Number.isInteger(o.ttlMinutes) || o.ttlMinutes < 1 || o.ttlMinutes > 43_200)) fail("ttlMinutes: 1 to 43200");
      const display = opt(o.displayText, "button text", LIMIT.callButton);
      const payload = opt(o.payload, "payload", LIMIT.callPayload);
      return interactive({
        type: "voice_call", body: { text: need(o.body, "body", LIMIT.bodyInteractive) },
        action: { name: "voice_call", parameters: { ...(display ? { display_text: display } : {}), ...(o.ttlMinutes ? { ttl_minutes: o.ttlMinutes } : {}), ...(payload ? { payload } : {}) } },
      });
    }
    case "call_permission_request": {
      const body = opt(o.body, "body", LIMIT.bodyInteractive);
      return interactive({ type: "call_permission_request", ...(body ? { body: { text: body } } : {}), action: { name: "call_permission_request" } });
    }
    case "address": {
      if (o.country !== "IN") fail("Address messages are available only in India (country IN)");
      return interactive({
        type: "address_message", body: { text: need(o.body, "body", LIMIT.bodyInteractive) },
        action: { name: "address_message", parameters: {
          country: "IN", ...(o.values ? { values: o.values } : {}), ...(o.savedAddresses?.length ? { saved_addresses: o.savedAddresses } : {}),
          ...(o.validationErrors ? { validation_errors: o.validationErrors } : {}),
        } },
      });
    }
    case "order_details": {
      const pay = defaults.payments ?? fail("Payments are off for this channel: set business.payments.market (IN or BR, where Meta offers them)");
      if (!o.items?.length) fail("order: at least one item");
      for (const it of o.items) {
        need(it.name, "item name", 60);
        if (!(it.amount >= 0) || !Number.isInteger(it.quantity) || it.quantity < 1) fail(`item ${it.name}: amount ≥ 0 and a whole quantity ≥ 1`);
      }
      const subtotal = o.items.reduce((n, it) => n + it.amount * it.quantity, 0);
      const total = subtotal + (o.tax ?? 0) + (o.shipping ?? 0) - (o.discount ?? 0);
      if (total <= 0) fail("order: the total must be above zero");
      const currency = pay.market === "IN" ? "INR" : "BRL";
      if (pay.market === "BR" && !o.paymentSettings?.length) fail("Brazil: paymentSettings (pix_dynamic_code, boleto or payment_link) are required");
      if (pay.market === "IN" && !o.paymentSettings?.length && !pay.configurationName) fail("India: set business.payments.configurationName or give paymentSettings");
      const h = header(o.header);
      const footer = opt(o.footer, "footer", LIMIT.footer);
      return interactive({
        type: "order_details", ...(h ? { header: h } : {}), body: { text: need(o.body, "body", LIMIT.bodyInteractive) }, ...(footer ? { footer: { text: footer } } : {}),
        action: {
          name: "review_and_pay",
          parameters: {
            reference_id: need(o.referenceId, "referenceId", 35),
            type: o.goods ?? "digital-goods",
            ...(pay.market === "BR" ? { payment_type: "br", payment_settings: o.paymentSettings } : o.paymentSettings?.length
              ? { payment_settings: o.paymentSettings }
              : { payment_type: "upi", payment_configuration: pay.configurationName }),
            currency,
            total_amount: money(total),
            order: {
              status: "pending",
              ...(o.catalogId ? { catalog_id: o.catalogId } : {}),
              ...(o.expiresAt ? { expiration: { timestamp: String(Math.floor(Date.parse(o.expiresAt) / 1000)), description: o.expirationText ?? "Order expires" } } : {}),
              items: o.items.map((it) => ({
                ...(it.retailerId ? { retailer_id: it.retailerId } : {}), name: it.name, amount: money(it.amount), quantity: it.quantity,
                ...(it.saleAmount !== undefined ? { sale_amount: money(it.saleAmount) } : {}),
              })),
              subtotal: money(subtotal),
              ...(o.tax !== undefined ? { tax: money(o.tax) } : {}),
              ...(o.shipping !== undefined ? { shipping: money(o.shipping) } : {}),
              ...(o.discount !== undefined ? { discount: money(o.discount) } : {}),
            },
          },
        },
      });
    }
    case "order_status": {
      if (!defaults.payments) fail("Payments are off for this channel: set business.payments.market (IN or BR)");
      const description = opt(o.description, "description", 120);
      return interactive({
        type: "order_status", body: { text: need(o.body, "body", LIMIT.bodyInteractive) },
        action: { name: "review_order", parameters: {
          reference_id: need(o.referenceId, "referenceId", 35),
          order: { status: o.status, ...(description ? { description } : {}) },
          ...(o.payment ? { payment: o.payment } : {}),
        } },
      });
    }
    default:
      return fail(`Unknown message type ${String((o as { type?: unknown }).type)}`);
  }
}

/** A line for the conversation log and the agent's history (no secrets, the visible text). */
export function outboundSummary(o: WaBizOutbound): string {
  switch (o.type) {
    case "text": return o.text;
    case "media": return `[${o.kind}${o.filename ? ` ${o.filename}` : ""}]${o.caption ? ` ${o.caption}` : ""}`;
    case "location": return `[location ${o.latitude},${o.longitude}${o.name ? ` ${o.name}` : ""}]`;
    case "contacts": return `[contacts: ${o.contacts.map((c) => c.name).join(", ")}]`;
    case "reaction": return o.emoji ? `[reaction ${o.emoji}]` : "[reaction removed]";
    case "buttons": return `${o.body}\n[buttons: ${o.buttons.map((b) => b.title).join(" | ")}]`;
    case "list": return `${o.body}\n[list "${o.button}": ${o.sections.flatMap((s) => s.rows.map((r) => r.title)).join(" | ")}]`;
    case "cta_url": return `${o.body}\n[${o.displayText} → ${o.url}]`;
    case "location_request": return `${o.body}\n[send location]`;
    case "flow": return `${o.body}\n[flow ${o.flowId ?? o.flowName}: ${o.cta}]`;
    case "product": return `${o.body ?? ""}\n[product ${o.productRetailerId}]`.trim();
    case "product_list": return `${o.body}\n[products: ${o.sections.flatMap((s) => s.productRetailerIds).join(", ")}]`;
    case "catalog": return `${o.body}\n[catalog]`;
    case "voice_call": return `${o.body}\n[call button${o.displayText ? `: ${o.displayText}` : ""}]`;
    case "call_permission_request": return `${o.body ?? ""}\n[call permission request]`.trim();
    case "address": return `${o.body}\n[address request]`;
    case "order_details": return `${o.body}\n[order ${o.referenceId}: ${o.items.map((i) => `${i.quantity}× ${i.name}`).join(", ")}]`;
    case "order_status": return `${o.body}\n[order ${o.referenceId}: ${o.status}]`;
    default: return "";
  }
}

/** The media a payload sends by id or link, checked against Meta's types and sizes when known. */
export function checkMediaFile(kind: Parameters<typeof mediaProblem>[0], mimeType: string, bytes: number): void {
  const p = mediaProblem(kind, mimeType, bytes);
  if (p) fail(p);
}

// ── Templates ────────────────────────────────────────────────────────

const VAR = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;
const vars = (text: string | undefined) => {
  const seen: string[] = [];
  for (const m of (text ?? "").matchAll(VAR)) if (!seen.includes(m[1]!)) seen.push(m[1]!);
  return seen;
};
const comp = (components: WaTemplateComponent[], type: string) => components.find((c) => c.type.toUpperCase() === type);

/** The body's placeholders, in order of first appearance: ["1", "2"] or ["name", "order"]. */
export function templateBodyParams(t: Pick<WaTemplate, "components">): string[] {
  return vars(comp(t.components, "BODY")?.text);
}

/** What a template needs to be sent: header, body variables, buttons that take a value, carousel cards. */
export interface TemplateNeeds {
  header?: { format: string; variable?: boolean };
  body: string[];
  named: boolean;
  buttons: Array<{ index: number; type: string; text?: string; needs?: "text" | "coupon_code" | "otp"; optional?: "payload" | "flow" | "action" }>;
  cards?: Array<{ header?: string; body: string[]; buttons: TemplateNeeds["buttons"] }>;
  authentication: boolean;
  limitedTimeOffer: boolean;
}

function buttonNeeds(buttons: WaTemplateButton[] | undefined): TemplateNeeds["buttons"] {
  return (buttons ?? []).map((b, index) => {
    const type = String(b.type ?? "").toUpperCase();
    const text = b.text;
    if (type === "URL" && b.url && /\{\{/.test(b.url)) return { index, type, ...(text ? { text } : {}), needs: "text" as const };
    if (type === "COPY_CODE") return { index, type, ...(text ? { text } : {}), needs: "coupon_code" as const };
    if (type === "OTP") return { index, type, ...(text ? { text } : {}), needs: "otp" as const };
    if (type === "QUICK_REPLY") return { index, type, ...(text ? { text } : {}), optional: "payload" as const };
    if (type === "FLOW") return { index, type, ...(text ? { text } : {}), optional: "flow" as const };
    if (type === "CATALOG" || type === "MPM") return { index, type, ...(text ? { text } : {}), optional: "action" as const };
    return { index, type, ...(text ? { text } : {}) };
  });
}

export function templateNeeds(t: Pick<WaTemplate, "components" | "parameterFormat" | "category">): TemplateNeeds {
  const h = comp(t.components, "HEADER");
  const body = templateBodyParams(t);
  const carousel = comp(t.components, "CAROUSEL");
  return {
    ...(h ? { header: { format: (h.format ?? "TEXT").toUpperCase(), ...(vars(h.text).length ? { variable: true } : {}) } } : {}),
    body,
    named: t.parameterFormat === "NAMED" || body.some((n) => !/^\d+$/.test(n)),
    buttons: buttonNeeds(comp(t.components, "BUTTONS")?.buttons),
    ...(carousel?.cards?.length ? {
      cards: carousel.cards.map((card) => {
        const ch = comp(card.components ?? [], "HEADER");
        return { ...(ch ? { header: (ch.format ?? "IMAGE").toUpperCase() } : {}), body: vars(comp(card.components ?? [], "BODY")?.text), buttons: buttonNeeds(comp(card.components ?? [], "BUTTONS")?.buttons) };
      }),
    } : {}),
    authentication: String(t.category).toUpperCase() === "AUTHENTICATION",
    limitedTimeOffer: !!comp(t.components, "LIMITED_TIME_OFFER"),
  };
}

function checkParam(p: string, what: string): void {
  if (typeof p !== "string" || !p.trim()) fail(`${what} cannot be empty`);
  if (/[\n\t]|\s{5,}/.test(p)) fail(`${what} cannot contain new lines, tabs or more than 4 spaces in a row (Meta refuses them)`);
}

function bodyParameters(names: string[], named: boolean, given: string[] | Record<string, string> | undefined, where: string): Array<Record<string, string>> {
  if (!names.length) {
    const n = Array.isArray(given) ? given.length : Object.keys(given ?? {}).length;
    if (n) fail(`${where} takes no parameters (got ${n})`);
    return [];
  }
  let values: string[];
  if (Array.isArray(given) || given === undefined) {
    values = given ?? [];
    if (values.length !== names.length) fail(`${where} needs ${names.length} parameter${names.length === 1 ? "" : "s"} (${names.map((n) => `{{${n}}}`).join(", ")}), got ${values.length}`);
  } else {
    if (!named) fail(`${where} has positional parameters: give them as a list, in order`);
    const extra = Object.keys(given).filter((k) => !names.includes(k));
    if (extra.length) fail(`${where} has no parameter ${extra.map((k) => `{{${k}}}`).join(", ")} (it has ${names.map((n) => `{{${n}}}`).join(", ")})`);
    const missing = names.filter((n) => given[n] === undefined);
    if (missing.length) fail(`${where} needs ${missing.map((n) => `{{${n}}}`).join(", ")}`);
    values = names.map((n) => given[n]!);
  }
  values.forEach((v, i) => checkParam(v, `${where} parameter {{${names[i]}}}`));
  return values.map((text, i) => ({ type: "text", text, ...(named ? { parameter_name: names[i]! } : {}) }));
}

function mediaParam(format: string, h: { type?: string; link?: string; mediaId?: string; filename?: string } | undefined, where: string): Record<string, unknown> {
  const kind = format.toLowerCase();
  if (!h || h.type !== kind) fail(`${where} is a ${kind} header: give header { type: "${kind}", link | mediaId }`);
  return { type: kind, [kind]: mediaRef({ ...(h!.link ? { link: h!.link } : {}), ...(h!.mediaId ? { mediaId: h!.mediaId } : {}), ...(kind === "document" && h!.filename ? { filename: h!.filename } : {}) }, `${where} ${kind}`) };
}

function buttonParameters(needs: TemplateNeeds["buttons"], given: WaBizTemplateInput["buttons"], otp: string | undefined, where: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const g of given ?? []) {
    if (!needs.some((b) => b.index === g.index)) fail(`${where} has no button ${g.index} (it has ${needs.length})`);
  }
  for (const b of needs) {
    const g = given?.find((x) => x.index === b.index);
    const label = `${where} button ${b.index}${b.text ? ` "${b.text}"` : ""}`;
    if (b.needs === "text") {
      const text = g?.text ?? fail(`${label} has a URL with a variable: give buttons [{ index: ${b.index}, text: "<the URL's suffix>" }]`);
      checkParam(text, label);
      out.push({ type: "button", sub_type: "url", index: String(b.index), parameters: [{ type: "text", text }] });
    } else if (b.needs === "coupon_code") {
      const code = g?.couponCode ?? fail(`${label} copies a code: give buttons [{ index: ${b.index}, couponCode }]`);
      if (code.length > 15) fail(`${label}: the coupon code is at most 15 characters`);
      out.push({ type: "button", sub_type: "copy_code", index: String(b.index), parameters: [{ type: "coupon_code", coupon_code: code }] });
    } else if (b.needs === "otp") {
      const code = g?.text ?? otp ?? fail(`${label} is the one-time code's button: give otp`);
      if (code.length > 15) fail(`${label}: the code is at most 15 characters`);
      out.push({ type: "button", sub_type: "url", index: String(b.index), parameters: [{ type: "text", text: code }] });
    } else if (b.optional === "payload" && g?.payload) {
      out.push({ type: "button", sub_type: "quick_reply", index: String(b.index), parameters: [{ type: "payload", payload: g.payload }] });
    } else if (b.optional === "flow" && (g?.flowToken || g?.flowActionData)) {
      out.push({ type: "button", sub_type: "flow", index: String(b.index), parameters: [{ type: "action", action: { ...(g.flowToken ? { flow_token: g.flowToken } : {}), ...(g.flowActionData ? { flow_action_data: g.flowActionData } : {}) } }] });
    } else if (b.optional === "action" && g?.action) {
      out.push({ type: "button", sub_type: b.type.toLowerCase(), index: String(b.index), parameters: [{ type: "action", action: g.action }] });
    } else if (g && (g.text || g.payload || g.couponCode) && !b.needs && !b.optional) {
      fail(`${label} (${b.type.toLowerCase()}) takes no value`);
    }
  }
  return out;
}

/** Why a template cannot be sent (not approved), else undefined; the parameters are checked by templateComponents. */
export function templateStatusProblem(t: WaTemplate): string | undefined {
  if (t.status.toUpperCase() !== "APPROVED") return `Template ${t.name} (${t.language}) is ${t.status}, not APPROVED`;
  return undefined;
}

/**
 * The components to send, from the template's definition and the values given: every variable
 * filled, nothing extra, media headers by id or link, buttons by index, carousel cards in order.
 */
export function templateComponents(t: WaTemplate, input: WaBizTemplateInput = {}):Array<Record<string, unknown>> {
  const needs = templateNeeds(t);
  const where = `Template ${t.name}`;
  const out: Array<Record<string, unknown>> = [];
  if (needs.header) {
    const h = input.header;
    if (needs.header.format === "TEXT") {
      if (needs.header.variable) {
        if (!h || h.type !== "text") fail(`${where} has a header variable: give header { type: "text", text }`);
        const text = (h as { text: string }).text;
        checkParam(text, `${where} header`);
        if (text.length > 60) fail(`${where} header: at most 60 characters`);
        out.push({ type: "header", parameters: [{ type: "text", text }] });
      } else if (h) fail(`${where}'s header has no variable`);
    } else if (needs.header.format === "LOCATION") {
      if (!h || h.type !== "location") fail(`${where} has a location header: give header { type: "location", latitude, longitude, name?, address? }`);
      const l = h as { latitude: number; longitude: number; name?: string; address?: string };
      out.push({ type: "header", parameters: [{ type: "location", location: { latitude: String(l.latitude), longitude: String(l.longitude), ...(l.name ? { name: l.name } : {}), ...(l.address ? { address: l.address } : {}) } }] });
    } else {
      out.push({ type: "header", parameters: [mediaParam(needs.header.format, h as never, where)] });
    }
  } else if (input.header) fail(`${where} has no header`);

  let body = input.body;
  if (needs.authentication && input.otp && body === undefined) body = needs.body.map(() => input.otp!);
  const bodyParams = bodyParameters(needs.body, needs.named, body, `${where} body`);
  if (bodyParams.length) out.push({ type: "body", parameters: bodyParams });

  if (needs.limitedTimeOffer && input.offerExpiresAt) {
    const ms = Date.parse(input.offerExpiresAt);
    if (!Number.isFinite(ms)) fail(`${where}: offerExpiresAt is not a date`);
    out.push({ type: "limited_time_offer", parameters: [{ type: "limited_time_offer", limited_time_offer: { expiration_time_ms: ms } }] });
  }

  out.push(...buttonParameters(needs.buttons, input.buttons, input.otp, where));

  if (needs.cards) {
    const cards = input.carousel ?? [];
    if (cards.length !== needs.cards.length) fail(`${where} is a carousel of ${needs.cards.length} cards: give carousel with ${needs.cards.length} entries (got ${cards.length})`);
    out.push({
      type: "carousel",
      cards: needs.cards.map((need_, i) => {
        const c = cards[i]!;
        const cw = `${where} card ${i}`;
        const components: Array<Record<string, unknown>> = [];
        if (need_.header) components.push({ type: "header", parameters: [mediaParam(need_.header, c.header, cw)] });
        const bp = bodyParameters(need_.body, needs.named, c.body, `${cw} body`);
        if (bp.length) components.push({ type: "body", parameters: bp });
        components.push(...buttonParameters(need_.buttons, c.buttons, undefined, cw));
        return { card_index: i, components };
      }),
    });
  } else if (input.carousel?.length) fail(`${where} is not a carousel`);
  return out;
}

/** The text a template shows, with its variables filled (for the conversation log). */
export function templatePreview(t: WaTemplate, input: WaBizTemplateInput = {}): string {
  const body = comp(t.components, "BODY")?.text ?? "";
  const names = templateBodyParams(t);
  let values: Record<string, string> = {};
  if (Array.isArray(input.body)) names.forEach((n, i) => { if (input.body && (input.body as string[])[i] !== undefined) values[n] = (input.body as string[])[i]!; });
  else if (input.body) values = input.body;
  else if (input.otp) names.forEach((n) => { values[n] = input.otp!; });
  return body.replace(VAR, (m, n: string) => values[n] ?? m);
}

/** Why a template cannot be sent with these parameters, or undefined (status and every component). */
export function templateProblem(t: WaTemplate, params: string[] | WaBizTemplateInput): string | undefined {
  const status = templateStatusProblem(t);
  if (status) return status;
  try {
    templateComponents(t, Array.isArray(params) ? { body: params } : params);
    return undefined;
  } catch (err) {
    return (err as Error).message;
  }
}

export { header as interactiveHeaderPayload };
