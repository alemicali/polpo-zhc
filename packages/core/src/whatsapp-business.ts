/**
 * WhatsApp Business (Meta Cloud API) channel: settings, the rules Meta imposes (the 24-hour
 * customer-service window, opt-out, templates for anything business-initiated), and the store of
 * contacts, messages and processed webhook ids.
 *
 * - The channel is `type: "whatsapp-business"` in settings.notifications.channels (separate from the
 *   QR-paired "whatsapp" one). A contact is identified by its wa_id (or, when Meta sends no phone
 *   number, its business-scoped user id); a chat id is `<phoneNumberId>:<wa_id>`.
 * - Secrets (access token, app secret, verify token) are never in the configuration: it keeps vault
 *   references under the reserved owner "$channels", written from the dashboard only.
 * - Free-form messages may go out only inside the 24-hour window that opens when the contact
 *   writes; outside it only approved templates, in the allowed categories, within the daily caps,
 *   never to a contact who opted out.
 */

export const WABIZ_CHANNEL_TYPE = "whatsapp-business";
export const WABIZ_DEFAULT_GRAPH_VERSION = "v23.0";
/** Where the channel's secrets live (a reserved owner: never an agent). */
export const WABIZ_VAULT_OWNER = "$channels";
/** The customer-service window Meta opens at each inbound message. */
export const WABIZ_WINDOW_MS = 24 * 3_600_000;
/** Meta's limit on a text message body. */
export const WABIZ_TEXT_MAX = 4096;
/** Processed webhook ids are remembered this long (Meta retries for up to 7 days). */
export const WABIZ_PROCESSED_TTL_MS = 7 * 24 * 3_600_000;

export type WaBizSecretKind = "accessToken" | "appSecret" | "verifyToken";
export const WABIZ_SECRET_KINDS: readonly WaBizSecretKind[] = ["accessToken", "appSecret", "verifyToken"];
/** The configuration field holding each secret's vault reference. */
export const WABIZ_SECRET_REF_FIELD: Record<WaBizSecretKind, "accessTokenRef" | "appSecretRef" | "verifyTokenRef"> = {
  accessToken: "accessTokenRef", appSecret: "appSecretRef", verifyToken: "verifyTokenRef",
};

/** The vault entry of a channel's secret (owner "$channels"; the value under the key "secret"). */
export function wabizVaultService(channel: string, kind: WaBizSecretKind): string {
  return `whatsapp-business:${channel}:${kind}`;
}

export function wabizVaultRef(channel: string, kind: WaBizSecretKind): { owner: string; service: string } {
  return { owner: WABIZ_VAULT_OWNER, service: wabizVaultService(channel, kind) };
}

export type WaBizAudience = "customers" | "operators";
export type WaBizTemplateCategory = "UTILITY" | "MARKETING" | "AUTHENTICATION";

export interface WaBizNotificationTemplate {
  name: string;
  /** Language code, e.g. "it" or "en_US". */
  language: string;
  /**
   * Body parameters, in order. Placeholders: {title}, {body}, {severity}, {event} (the notification's).
   */
  bodyParams?: string[];
}

export interface WaBusinessSettings {
  /** "customers" (default): people who write to the business, answered by gateway.agent only; "operators": the team. */
  audience?: WaBizAudience;
  /** wa_ids of the operators: they may use commands, and notifications go to them. */
  operators?: string[];
  /** Mark inbound messages read. Default true. */
  markRead?: boolean;
  /** Show the typing indicator while the agent works. Default true. */
  typing?: boolean;
  /** A notification for a contact outside the 24-hour window: "template" (notificationTemplate) or "fail" (default). */
  outsideWindow?: "template" | "fail";
  notificationTemplate?: WaBizNotificationTemplate;
  /** Template categories agents may send. Default ["UTILITY"]. */
  allowedCategories?: WaBizTemplateCategory[];
  /** Templates (business-initiated messages) sent by agents or Polpo wait for an operator's approval. Default true. */
  approveTemplates?: boolean;
  limits?: {
    /** Business-initiated (template) messages a day, for the whole channel. Default 50. */
    businessInitiatedPerDay?: number;
    /** Per agent, by name. */
    perAgentPerDay?: Record<string, number>;
  };
  /** Contacts' messages are kept this many days. Default 90. */
  retentionDays?: number;
  /** Inbound media (images, documents, audio, voice notes, video, stickers): downloaded and kept with the message. */
  media?: {
    /** Download inbound media (default true); off: the message keeps only its type, size and caption. */
    download?: boolean;
    /** The largest inbound file kept, in bytes (default 16 MB; Meta's own limits per type apply too). */
    maxBytes?: number;
  };
  /** The Commerce catalog connected to the WhatsApp Business Account (product and multi-product messages). */
  catalogId?: string;
  /**
   * Payments inside WhatsApp (order_details messages): only where Meta offers them — India (a
   * payment configuration: payment gateway or UPI) and Brazil (Pix, boleto, payment links).
   */
  payments?: {
    market: "IN" | "BR";
    /** India: the payment configuration's name (WhatsApp Manager → Payment configurations). */
    configurationName?: string;
  };
  /** Marketing templates go out through the Marketing Messages API (POST /{phone}/marketing_messages); the account must be onboarded to it. */
  marketingMessagesApi?: boolean;
  /** The Meta app's id: needed to upload the business profile photo (Resumable Upload API). */
  appId?: string;
  /**
   * One Meta app shared by several instances: deliveries for another phone number of the app are
   * forwarded (raw body and signature, unchanged) to the instance that owns it: phone_number_id →
   * that instance's webhook URL (https). Per-number callback overrides at Meta make it unneeded.
   */
  sharedApp?: { routes?: Record<string, string> };
}

export interface ResolvedWaBusinessSettings {
  audience: WaBizAudience;
  operators: string[];
  markRead: boolean;
  typing: boolean;
  outsideWindow: "template" | "fail";
  notificationTemplate?: WaBizNotificationTemplate;
  allowedCategories: WaBizTemplateCategory[];
  approveTemplates: boolean;
  limits: { businessInitiatedPerDay: number; perAgentPerDay: Record<string, number> };
  retentionDays: number;
  media: { download: boolean; maxBytes: number };
  catalogId?: string;
  payments?: { market: "IN" | "BR"; configurationName?: string };
  marketingMessagesApi: boolean;
  appId?: string;
  sharedRoutes: Record<string, string>;
}

export function resolveWaBusinessSettings(b: WaBusinessSettings | undefined): ResolvedWaBusinessSettings {
  return {
    audience: b?.audience === "operators" ? "operators" : "customers",
    operators: (b?.operators ?? []).map(normalizeWaId).filter(Boolean),
    markRead: b?.markRead !== false,
    typing: b?.typing !== false,
    outsideWindow: b?.outsideWindow === "template" ? "template" : "fail",
    ...(b?.notificationTemplate ? { notificationTemplate: b.notificationTemplate } : {}),
    allowedCategories: b?.allowedCategories?.length ? b.allowedCategories : ["UTILITY"],
    approveTemplates: b?.approveTemplates !== false,
    limits: {
      businessInitiatedPerDay: b?.limits?.businessInitiatedPerDay ?? 50,
      perAgentPerDay: b?.limits?.perAgentPerDay ?? {},
    },
    retentionDays: b?.retentionDays ?? 90,
    media: { download: b?.media?.download !== false, maxBytes: b?.media?.maxBytes ?? WABIZ_DEFAULT_MEDIA_MAX },
    ...(b?.catalogId ? { catalogId: String(b.catalogId) } : {}),
    ...(b?.payments?.market === "IN" || b?.payments?.market === "BR" ? { payments: b.payments } : {}),
    marketingMessagesApi: b?.marketingMessagesApi === true,
    ...(b?.appId ? { appId: String(b.appId) } : {}),
    sharedRoutes: { ...(b?.sharedApp?.routes ?? {}) },
  };
}

// ── Media ────────────────────────────────────────────────────────────

/** The largest inbound file kept by default (Meta's own limit for audio and video). */
export const WABIZ_DEFAULT_MEDIA_MAX = 16 * 1024 * 1024;

export type WaBizMediaKind = "image" | "audio" | "video" | "document" | "sticker";
export const WABIZ_MEDIA_KINDS: readonly WaBizMediaKind[] = ["image", "audio", "video", "document", "sticker"];

/** Meta's supported types and size limits per media kind (Cloud API, media reference). */
export const WABIZ_MEDIA_LIMITS: Record<WaBizMediaKind, { maxBytes: number; mimeTypes: readonly string[] }> = {
  image: { maxBytes: 5 * 1024 * 1024, mimeTypes: ["image/jpeg", "image/png", "image/webp"] },
  audio: { maxBytes: 16 * 1024 * 1024, mimeTypes: ["audio/aac", "audio/amr", "audio/mpeg", "audio/mp4", "audio/ogg"] },
  video: { maxBytes: 16 * 1024 * 1024, mimeTypes: ["video/mp4", "video/3gpp"] },
  // any type (PDF, Office documents, text…) up to 100 MB
  document: { maxBytes: 100 * 1024 * 1024, mimeTypes: [] },
  // animated stickers up to 500 KB (static ones up to 100 KB)
  sticker: { maxBytes: 500 * 1024, mimeTypes: ["image/webp"] },
};

const sizeLabel = (bytes: number) => (bytes >= 1024 * 1024 ? `${Math.round(bytes / 1024 / 1024)} MB` : `${Math.round(bytes / 1024)} KB`);

/** Why a file cannot be sent as this kind (Meta's types and limits), or undefined. */
export function mediaProblem(kind: WaBizMediaKind, mimeType: string, bytes: number): string | undefined {
  const l = WABIZ_MEDIA_LIMITS[kind];
  if (!l) return `Unknown media kind ${kind}`;
  const mime = String(mimeType ?? "").split(";")[0]!.trim().toLowerCase();
  if (l.mimeTypes.length && !l.mimeTypes.includes(mime)) return `A WhatsApp ${kind} must be ${l.mimeTypes.join(", ")} (got ${mime || "an unknown type"})`;
  if (bytes > l.maxBytes) return `A WhatsApp ${kind} can be at most ${sizeLabel(l.maxBytes)} (this one is ${sizeLabel(bytes)})`;
  return undefined;
}

/** The kind a file goes out as, from its type (images, audio, video; anything else as a document). */
export function mediaKindFor(mimeType: string): WaBizMediaKind {
  const m = String(mimeType ?? "").split(";")[0]!.trim().toLowerCase();
  if (WABIZ_MEDIA_LIMITS.image.mimeTypes.includes(m)) return "image";
  if (WABIZ_MEDIA_LIMITS.audio.mimeTypes.includes(m)) return "audio";
  if (WABIZ_MEDIA_LIMITS.video.mimeTypes.includes(m)) return "video";
  return "document";
}

/** A phone number as Meta's wa_id: digits only ("+39 333-123" → "39333123"); anything else (a BSUID) kept as is. */
export function normalizeWaId(id: string): string {
  const v = String(id ?? "").trim();
  if (/^\+?[\d\s().-]+$/.test(v)) return v.replace(/\D/g, "");
  return v;
}

/** True when the id is a phone number (wa_id), not a business-scoped user id. */
export function isPhoneWaId(id: string): boolean {
  return /^\d{6,20}$/.test(id);
}

/** A phone number for logs and the event log: "393331234567" → "39•••••••567". */
export function maskPhone(id: string | undefined): string | undefined {
  if (!id) return id;
  if (!isPhoneWaId(id)) return id.length > 8 ? `${id.slice(0, 4)}…${id.slice(-3)}` : "•••";
  return `${id.slice(0, 2)}${"•".repeat(Math.max(3, id.length - 5))}${id.slice(-3)}`;
}

export function wabizChatId(phoneNumberId: string, waId: string): string {
  return `${phoneNumberId}:${waId}`;
}

/** The contact of a chat id (`<phoneNumberId>:<wa_id>`) or a bare wa_id / phone number. */
export function waIdFromChat(chatOrWaId: string): string {
  const v = String(chatOrWaId ?? "").trim();
  const i = v.indexOf(":");
  return normalizeWaId(i >= 0 ? v.slice(i + 1) : v);
}

// ── Opt-out ──────────────────────────────────────────────────────────

/** Messages that stop business-initiated messages to the contact (the whole message, any case). */
export const WABIZ_OPT_OUT_KEYWORDS = [
  "STOP", "STOP ALL", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT", "OPT OUT", "OPTOUT",
  "ANNULLA", "DISISCRIVIMI", "CANCELLAMI", "BASTA", "BASTA MESSAGGI", "NON SCRIVERMI PIÙ", "NON SCRIVERMI PIU",
  "ALTO", "BAJA", "DARSE DE BAJA", "ARRÊT", "ARRET", "DÉSABONNER",
] as const;

/** The keyword when the whole message is an opt-out request, else undefined. */
export function optOutKeyword(text: string): string | undefined {
  const t = String(text ?? "").trim().replace(/[.!\s]+$/u, "").replace(/\s+/g, " ").toUpperCase();
  if (!t || t.length > 40) return undefined;
  return (WABIZ_OPT_OUT_KEYWORDS as readonly string[]).find((k) => k === t);
}

/** Messages that undo an opt-out. */
export const WABIZ_OPT_IN_KEYWORDS = ["START", "UNSTOP", "ISCRIVIMI", "RIATTIVA"] as const;

export function optInKeyword(text: string): string | undefined {
  const t = String(text ?? "").trim().replace(/[.!\s]+$/u, "").toUpperCase();
  return (WABIZ_OPT_IN_KEYWORDS as readonly string[]).find((k) => k === t);
}

// ── Outbound messages ────────────────────────────────────────────────

/** A header of an interactive message (buttons, CTA URL, flow; lists take text only). */
export type WaBizInteractiveHeader =
  | { type: "text"; text: string }
  | { type: "image" | "video" | "document"; link?: string; mediaId?: string; filename?: string };

/** A contact card shared in a message. */
export interface WaBizSharedContact {
  /** The full name as shown. */
  name: string;
  firstName?: string;
  lastName?: string;
  phones?: Array<{ phone: string; type?: string; waId?: string }>;
  emails?: Array<{ email: string; type?: string }>;
  company?: string;
  title?: string;
  urls?: Array<{ url: string; type?: string }>;
}

/** A line of an order (order_details): amounts in the currency's units (12.5 = 12.50). */
export interface WaBizOrderItem {
  retailerId?: string;
  name: string;
  amount: number;
  quantity: number;
  saleAmount?: number;
}

/**
 * Everything a business can send inside the 24-hour window, besides templates (Cloud API
 * messages endpoint). `replyTo` quotes a message (context.message_id). Media go by Meta media id,
 * by a public link, or (service level) a file that is uploaded first.
 */
export type WaBizOutbound = { replyTo?: string } & (
  | { type: "text"; text: string; previewUrl?: boolean }
  | { type: "media"; kind: WaBizMediaKind; link?: string; mediaId?: string; caption?: string; filename?: string }
  | { type: "location"; latitude: number; longitude: number; name?: string; address?: string }
  | { type: "contacts"; contacts: WaBizSharedContact[] }
  | { type: "reaction"; messageId: string; emoji: string }
  | { type: "buttons"; body: string; header?: WaBizInteractiveHeader; footer?: string; buttons: Array<{ id: string; title: string }> }
  | { type: "list"; body: string; header?: string; footer?: string; button: string; sections: Array<{ title?: string; rows: Array<{ id: string; title: string; description?: string }> }> }
  | { type: "cta_url"; body: string; header?: WaBizInteractiveHeader; footer?: string; displayText: string; url: string }
  | { type: "location_request"; body: string }
  | {
    type: "flow"; body: string; header?: WaBizInteractiveHeader; footer?: string; flowId?: string; flowName?: string; cta: string;
    flowToken?: string; mode?: "published" | "draft"; action?: "navigate" | "data_exchange"; screen?: string; data?: Record<string, unknown>;
  }
  | { type: "product"; catalogId?: string; productRetailerId: string; body?: string; footer?: string }
  | { type: "product_list"; catalogId?: string; header: string; body: string; footer?: string; sections: Array<{ title: string; productRetailerIds: string[] }> }
  | { type: "catalog"; body: string; footer?: string; thumbnailProductRetailerId?: string }
  | { type: "voice_call"; body: string; displayText?: string; ttlMinutes?: number; payload?: string }
  | { type: "call_permission_request"; body?: string }
  | { type: "address"; body: string; country: "IN"; values?: Record<string, string>; savedAddresses?: Array<Record<string, unknown>>; validationErrors?: Record<string, string> }
  | {
    type: "order_details"; body: string; header?: WaBizInteractiveHeader; footer?: string; referenceId: string;
    goods?: "digital-goods" | "physical-goods"; items: WaBizOrderItem[]; tax?: number; shipping?: number; discount?: number;
    catalogId?: string; expiresAt?: string; expirationText?: string;
    /** Meta's payment_settings as given (Brazil: pix_dynamic_code, boleto, payment_link; India: payment_gateway). */
    paymentSettings?: Array<Record<string, unknown>>;
  }
  | { type: "order_status"; body: string; referenceId: string; status: "pending" | "processing" | "partially-shipped" | "shipped" | "completed" | "canceled"; description?: string; payment?: { status: string; timestamp?: number } }
);

export type WaBizOutboundType = WaBizOutbound["type"];

/** The interactive types the 24-hour window governs like text (every outbound type does). */
export const WABIZ_OUTBOUND_TYPES: readonly WaBizOutboundType[] = [
  "text", "media", "location", "contacts", "reaction", "buttons", "list", "cta_url", "location_request", "flow", "product",
  "product_list", "catalog", "voice_call", "call_permission_request", "address", "order_details", "order_status",
];

/**
 * A template's parameters for every component: the header (text, media or location), the body
 * (positional in order, or named), the buttons by their index in the template (quick reply payload,
 * the URL's variable suffix, a coupon code, a flow token), the cards of a carousel, the one-time
 * code of an authentication template.
 */
export interface WaBizTemplateInput {
  header?:
    | { type: "text"; text: string }
    | { type: "image" | "video" | "document"; link?: string; mediaId?: string; filename?: string }
    | { type: "location"; latitude: number; longitude: number; name?: string; address?: string };
  body?: string[] | Record<string, string>;
  buttons?: Array<{
    index: number; payload?: string; text?: string; couponCode?: string; flowToken?: string; flowActionData?: Record<string, unknown>;
    /** Catalog and multi-product buttons: Meta's action object (thumbnail_product_retailer_id, sections). */
    action?: Record<string, unknown>;
  }>;
  /** Limited-time offer templates: when the offer ends (ISO time). */
  offerExpiresAt?: string;
  carousel?: Array<{
    header?: { type: "image" | "video"; link?: string; mediaId?: string };
    body?: string[] | Record<string, string>;
    buttons?: Array<{ index: number; payload?: string; text?: string }>;
  }>;
  /** Authentication templates: the one-time code (body and copy-code / one-tap button). */
  otp?: string;
}

// ── Store ────────────────────────────────────────────────────────────

export interface WaBizContact {
  channel: string;
  /** wa_id (phone number, digits) or a business-scoped user id. */
  waId: string;
  /** Meta's business-scoped user id, when it sent one. */
  userId?: string;
  name?: string;
  /** The last message the contact wrote (opens the 24-hour window). */
  lastInboundAt?: string;
  lastInboundWamid?: string;
  optIn: { at: string; source: string } | null;
  optOut: { at: string; keyword: string } | null;
  /** The contact stopped (or resumed) marketing messages from WhatsApp itself (user_preferences webhook). */
  marketing?: { value: "stop" | "resume"; at: string };
  /** Blocked by the business (block_users): it can no longer write to the number. */
  blocked?: { at: string; by: string } | null;
  /** The contact's answer to a call permission request (Calling API). */
  callPermission?: { response: "accept" | "reject"; permanent?: boolean; expiresAt?: string; at: string };
  createdAt: string;
  updatedAt: string;
}

/** A message's media: what Meta described, and the file kept locally (inbound) or sent. */
export interface WaBizMedia {
  kind: WaBizMediaKind;
  /** Meta's media id (inbound: valid 7 days; uploaded: 30 days). */
  mediaId?: string;
  /** Sent by link instead of an upload. */
  link?: string;
  mimeType?: string;
  sha256?: string;
  size?: number;
  filename?: string;
  caption?: string;
  /** A voice note (audio recorded in WhatsApp). */
  voice?: boolean;
  /** An animated sticker. */
  animated?: boolean;
  /** The file kept with the message (under .polpo/whatsapp-business/media/), when it was downloaded. */
  stored?: string;
  /** Why it was not downloaded (too large, a type not accepted, Meta refused). */
  skipped?: string;
}

/** What a message quoted, and how it was forwarded (inbound context). */
export interface WaBizContext {
  /** The quoted message (wamid). */
  id?: string;
  forwarded?: boolean;
  frequentlyForwarded?: boolean;
  /** "Message business" on a product: the product asked about. */
  referredProduct?: { catalogId?: string; productRetailerId?: string };
}

export type WaBizMessageStatus =
  | "received" | "pending_approval" | "rejected" | "accepted" | "sent" | "delivered" | "read" | "failed" | "deleted";

export interface WaBizMessage {
  /** The wamid (Meta's message id); a queued send has a local id ("pending_…") until it is sent. */
  id: string;
  channel: string;
  waId: string;
  direction: "in" | "out";
  /** text, template, interactive, image… */
  type: string;
  /** Outbound: a reply inside the window, or business-initiated (a template). */
  initiated?: "reply" | "business";
  /** Who sent it (an agent's name, "polpo", "notification", "operator"). */
  sentBy?: string;
  template?: { name: string; language: string; category?: string };
  /** The text's length (inbound bodies are not kept in the event log; here only for the conversation). */
  bodyLength?: number;
  /** The text (inbound and outbound), kept for the conversation within retentionDays. */
  text?: string;
  status: WaBizMessageStatus;
  statuses: Array<{ status: string; at: string; error?: string }>;
  /** Meta's pricing for the message (status webhooks): category and type, billable or not. */
  pricing?: { category?: string; type?: string; billable?: boolean; model?: string };
  error?: { code?: number; title?: string; detail?: string };
  /** A queued template waiting for approval: everything needed to send it. */
  pending?: {
    template: string; language: string; params: string[]; requestedBy: string; requestedAt: string; reason?: string;
    /** Every component's parameters (header, named body parameters, buttons, carousel cards). */
    components?: WaBizTemplateInput;
  };
  /** Image, audio, voice note, video, document or sticker. */
  media?: WaBizMedia;
  /**
   * The structured content of the other types: a location, shared contacts, an interactive message
   * sent (buttons, list, CTA, flow, products, order details…) or a reply to one (button, list,
   * flow completion, address, call permission), an order, a template's components.
   */
  content?: Record<string, unknown>;
  context?: WaBizContext;
  /** Reactions on this message (the contact's and the business's; the latest per side). */
  reactions?: Array<{ emoji: string; by: "contact" | "business"; at: string }>;
  /** The contact edited it (Coexistence numbers): the text is the edited one. */
  edited?: { at: string };
  /** The contact deleted it for everyone (Coexistence numbers): its text and media are dropped. */
  revoked?: { at: string };
  /** Ads that click to WhatsApp: where the conversation came from. */
  referral?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface WaBizMessageQuery {
  waId?: string;
  status?: WaBizMessageStatus;
  direction?: "in" | "out";
  limit?: number;
  /** Older than this ISO time. */
  before?: string;
}

export interface WaBusinessStore {
  getContact(channel: string, waId: string): Promise<WaBizContact | undefined>;
  saveContact(contact: WaBizContact): Promise<void>;
  /** Newest activity first. */
  listContacts(channel: string, o?: { limit?: number }): Promise<WaBizContact[]>;
  /** The contact and its messages (GDPR erasure); true when it existed. */
  deleteContact(channel: string, waId: string): Promise<boolean>;
  getMessage(id: string): Promise<WaBizMessage | undefined>;
  saveMessage(message: WaBizMessage): Promise<void>;
  deleteMessage(id: string): Promise<void>;
  /** Newest first. */
  listMessages(channel: string, q?: WaBizMessageQuery): Promise<WaBizMessage[]>;
  /** Business-initiated messages sent (not queued, not rejected) since a time, optionally by one sender. */
  countBusinessInitiated(channel: string, sinceIso: string, sentBy?: string): Promise<number>;
  /** Remember a processed webhook key; false when it was already there (a duplicate). */
  markProcessed(key: string, atIso?: string): Promise<boolean>;
  isProcessed(key: string): Promise<boolean>;
  /** Drop messages (and contacts with no activity) older than the time; processed keys older than processedBefore. */
  purge(channel: string, beforeIso: string): Promise<{ messages: number; contacts: number }>;
  purgeProcessed(beforeIso: string): Promise<number>;
}

const nowIso = () => new Date().toISOString();

/** True while the contact's 24-hour window is open (it wrote in the last 24 hours). */
export function canSendFreeForm(contact: Pick<WaBizContact, "lastInboundAt"> | undefined, now = Date.now()): boolean {
  if (!contact?.lastInboundAt) return false;
  const at = Date.parse(contact.lastInboundAt);
  return Number.isFinite(at) && now - at < WABIZ_WINDOW_MS;
}

/** When the window closes (undefined when closed). */
export function windowClosesAt(contact: Pick<WaBizContact, "lastInboundAt"> | undefined, now = Date.now()): string | undefined {
  if (!canSendFreeForm(contact, now)) return undefined;
  return new Date(Date.parse(contact!.lastInboundAt!) + WABIZ_WINDOW_MS).toISOString();
}

/** The start of the current day (UTC) for the daily caps. */
export function dayStartIso(now = Date.now()): string {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
}

export function newContact(channel: string, waId: string, at = nowIso()): WaBizContact {
  return { channel, waId, optIn: null, optOut: null, createdAt: at, updatedAt: at };
}

/** In memory (tests and the file store's base). */
export class InMemoryWaBusinessStore implements WaBusinessStore {
  protected contacts = new Map<string, WaBizContact>();
  protected messages = new Map<string, WaBizMessage>();
  protected processed = new Map<string, string>();

  protected changed(): void { /* the file store persists here */ }

  private key(channel: string, waId: string) { return `${channel}\u0000${waId}`; }

  async getContact(channel: string, waId: string) {
    const c = this.contacts.get(this.key(channel, waId));
    return c ? structuredClone(c) : undefined;
  }
  async saveContact(contact: WaBizContact) {
    this.contacts.set(this.key(contact.channel, contact.waId), structuredClone(contact));
    this.changed();
  }
  async listContacts(channel: string, o: { limit?: number } = {}) {
    return [...this.contacts.values()].filter((c) => c.channel === channel)
      .sort((a, b) => (b.lastInboundAt ?? b.updatedAt).localeCompare(a.lastInboundAt ?? a.updatedAt))
      .slice(0, o.limit ?? 100).map((c) => structuredClone(c));
  }
  async deleteContact(channel: string, waId: string) {
    const had = this.contacts.delete(this.key(channel, waId));
    let any = had;
    for (const [id, m] of this.messages) if (m.channel === channel && m.waId === waId) { this.messages.delete(id); any = true; }
    if (any) this.changed();
    return any;
  }
  async getMessage(id: string) {
    const m = this.messages.get(id);
    return m ? structuredClone(m) : undefined;
  }
  async saveMessage(message: WaBizMessage) {
    this.messages.set(message.id, structuredClone(message));
    this.changed();
  }
  async deleteMessage(id: string) {
    if (this.messages.delete(id)) this.changed();
  }
  async listMessages(channel: string, q: WaBizMessageQuery = {}) {
    return [...this.messages.values()]
      .filter((m) => m.channel === channel && (!q.waId || m.waId === q.waId) && (!q.status || m.status === q.status)
        && (!q.direction || m.direction === q.direction) && (!q.before || m.createdAt < q.before))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, q.limit ?? 50).map((m) => structuredClone(m));
  }
  async countBusinessInitiated(channel: string, sinceIso: string, sentBy?: string) {
    let n = 0;
    for (const m of this.messages.values()) {
      if (m.channel !== channel || m.direction !== "out" || m.initiated !== "business" || m.createdAt < sinceIso) continue;
      if (m.status === "pending_approval" || m.status === "rejected") continue;
      if (sentBy && m.sentBy !== sentBy) continue;
      n++;
    }
    return n;
  }
  async markProcessed(key: string, atIso = nowIso()) {
    if (this.processed.has(key)) return false;
    this.processed.set(key, atIso);
    this.changed();
    return true;
  }
  async isProcessed(key: string) { return this.processed.has(key); }
  async purge(channel: string, beforeIso: string) {
    let messages = 0;
    let contacts = 0;
    for (const [id, m] of this.messages) {
      if (m.channel === channel && m.createdAt < beforeIso && m.status !== "pending_approval") { this.messages.delete(id); messages++; }
    }
    for (const [k, c] of this.contacts) {
      // an opt-out is kept (it must keep blocking), whatever its age
      if (c.channel === channel && (c.lastInboundAt ?? c.updatedAt) < beforeIso && !c.optOut) { this.contacts.delete(k); contacts++; }
    }
    if (messages || contacts) this.changed();
    return { messages, contacts };
  }
  async purgeProcessed(beforeIso: string) {
    let n = 0;
    for (const [k, at] of this.processed) if (at < beforeIso) { this.processed.delete(k); n++; }
    if (n) this.changed();
    return n;
  }
}

// ── Validation ───────────────────────────────────────────────────────

const ID = /^\d{5,30}$/;
const VERSION = /^v\d{1,3}\.\d{1,2}$/;

/**
 * Problems of a whatsapp-business channel's configuration (empty when valid): ids, the Graph
 * version, secret references (owner "$channels", the channel's own entries only), the business
 * settings, and the gateway (customers need a dedicated agent).
 */
export function validateWaBusinessChannel(name: string, c: Record<string, unknown>): string[] {
  const errors: string[] = [];
  const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  if (!ID.test(s(c.phoneNumberId))) errors.push("phoneNumberId: the phone number's id (digits) is required");
  if (!ID.test(s(c.wabaId))) errors.push("wabaId: the WhatsApp Business Account id (digits) is required");
  if (c.graphApiVersion !== undefined && !VERSION.test(s(c.graphApiVersion))) errors.push(`graphApiVersion: like "${WABIZ_DEFAULT_GRAPH_VERSION}"`);
  for (const kind of WABIZ_SECRET_KINDS) {
    const field = WABIZ_SECRET_REF_FIELD[kind];
    const ref = c[field] as { owner?: unknown; service?: unknown } | undefined;
    if (ref === undefined || ref === null) continue;
    const expected = wabizVaultRef(name, kind);
    if (typeof ref !== "object" || ref.owner !== expected.owner || ref.service !== expected.service) {
      errors.push(`${field}: must be { owner: "${expected.owner}", service: "${expected.service}" } (set from the dashboard)`);
    }
  }
  for (const secret of ["accessToken", "appSecret", "verifyToken", "apiKey", "botToken"]) {
    if (c[secret] !== undefined) errors.push(`${secret}: secrets are not kept in the configuration (enter them in the dashboard)`);
  }
  const b = (c.business ?? {}) as WaBusinessSettings;
  if (b.audience !== undefined && b.audience !== "customers" && b.audience !== "operators") errors.push("business.audience: customers or operators");
  if (b.operators !== undefined && (!Array.isArray(b.operators) || b.operators.some((o) => !isPhoneWaId(normalizeWaId(String(o)))))) {
    errors.push("business.operators: phone numbers (wa_id, digits with country code)");
  }
  if (b.outsideWindow !== undefined && b.outsideWindow !== "template" && b.outsideWindow !== "fail") errors.push("business.outsideWindow: template or fail");
  if (b.outsideWindow === "template" && !b.notificationTemplate?.name) errors.push("business.notificationTemplate: needed when outsideWindow is template");
  if (b.notificationTemplate && (!s(b.notificationTemplate.name) || !s(b.notificationTemplate.language))) errors.push("business.notificationTemplate: name and language");
  if (b.allowedCategories !== undefined && (!Array.isArray(b.allowedCategories) || b.allowedCategories.some((x) => !["UTILITY", "MARKETING", "AUTHENTICATION"].includes(x)))) {
    errors.push("business.allowedCategories: UTILITY, MARKETING, AUTHENTICATION");
  }
  const lim = b.limits;
  if (lim?.businessInitiatedPerDay !== undefined && (!Number.isInteger(lim.businessInitiatedPerDay) || lim.businessInitiatedPerDay < 0)) {
    errors.push("business.limits.businessInitiatedPerDay: a whole number ≥ 0");
  }
  for (const [agent, n] of Object.entries(lim?.perAgentPerDay ?? {})) {
    if (!Number.isInteger(n) || n < 0) errors.push(`business.limits.perAgentPerDay.${agent}: a whole number ≥ 0`);
  }
  if (b.retentionDays !== undefined && (!Number.isInteger(b.retentionDays) || b.retentionDays < 1 || b.retentionDays > 3650)) {
    errors.push("business.retentionDays: 1–3650");
  }
  if (b.media?.maxBytes !== undefined && (!Number.isInteger(b.media.maxBytes) || b.media.maxBytes < 1024 || b.media.maxBytes > 100 * 1024 * 1024)) {
    errors.push("business.media.maxBytes: 1 KB – 100 MB");
  }
  if (b.catalogId !== undefined && !ID.test(s(b.catalogId))) errors.push("business.catalogId: the catalog's id (digits)");
  if (b.appId !== undefined && !ID.test(s(b.appId))) errors.push("business.appId: the Meta app's id (digits)");
  if (b.payments !== undefined && b.payments.market !== "IN" && b.payments.market !== "BR") {
    errors.push("business.payments.market: IN (India) or BR (Brazil) — payments are not available elsewhere");
  }
  for (const [phone, url] of Object.entries(b.sharedApp?.routes ?? {})) {
    if (!ID.test(phone)) errors.push(`business.sharedApp.routes: "${phone}" is not a phone number id (digits)`);
    if (phone === s(c.phoneNumberId)) errors.push(`business.sharedApp.routes.${phone}: that is this channel's own number`);
    let ok = false;
    try { ok = new URL(String(url)).protocol === "https:"; } catch { ok = false; }
    if (!ok) errors.push(`business.sharedApp.routes.${phone}: the owning instance's webhook URL (https)`);
  }
  const g = (c.gateway ?? {}) as { agent?: unknown; enableInbound?: unknown };
  const audience = b.audience ?? "customers";
  if (audience === "customers" && g.enableInbound && !s(g.agent)) {
    errors.push("gateway.agent: a channel facing customers needs the agent that answers them (customers never reach Polpo)");
  }
  return errors;
}
