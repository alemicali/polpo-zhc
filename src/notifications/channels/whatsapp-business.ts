/**
 * WhatsApp Business (Meta Cloud API): the Graph API client and the notification channel.
 *
 * The client sends every message type (whatsapp-business-messages.ts builds and checks the
 * payloads), templates with all their components (checked against the template synced from Meta),
 * uploads and downloads media (the token only ever goes to Meta's hosts), marks messages read with
 * the typing indicator, manages templates, the business profile, blocked users, the phone number
 * (registration, two-step verification PIN, verification codes, webhook override) and reads the
 * analytics. Everything else — the 24-hour window, opt-out, caps, approval — is the service's
 * (whatsapp-business-service.ts): the notification channel only hands notifications to it.
 *
 * Graph API (v23.0):
 *   POST   /{phone-number-id}/messages              every message type; { status: "read", message_id, typing_indicator }
 *   POST   /{phone-number-id}/marketing_messages    marketing templates (Marketing Messages API, onboarded accounts)
 *   POST   /{phone-number-id}/media                 multipart: messaging_product, type, file → { id }
 *   GET    /{media-id}                               { url (5 minutes), mime_type, sha256, file_size }; the url is downloaded with the token
 *   DELETE /{media-id}
 *   GET    /{waba-id}/message_templates             (paged)   POST: create   DELETE ?name=&hsm_id=
 *   POST   /{template-id}                            edit (components, category)
 *   GET|POST /{phone-number-id}/whatsapp_business_profile
 *   POST   /{app-id}/uploads → POST /{upload-id}    Resumable Upload: the profile photo's handle
 *   GET|POST|DELETE /{phone-number-id}/block_users
 *   GET    /{waba-id}?fields=analytics… | pricing_analytics…;  GET /{waba-id}/template_analytics
 *   POST   /{phone-number-id}/register | deregister | request_code | verify_code;  POST /{phone-number-id} { pin } | { webhook_configuration }
 *   POST   /{waba-id}/subscribed_apps
 *   GET    /{phone-number-id}?fields=…
 */
import type { NotificationChannel, Notification } from "../types.js";
import {
  WABIZ_DEFAULT_GRAPH_VERSION, WABIZ_TEXT_MAX, isPhoneWaId, type WaBizTemplateInput,
} from "@polpo-ai/core/whatsapp-business";
import { markdownToWhatsApp } from "./whatsapp.js";
import { templateComponents, type WaTemplate, type WaTemplateButton, type WaTemplateComponent } from "./whatsapp-business-messages.js";

export { templateBodyParams, templateProblem, templateComponents, templateNeeds, templatePreview, type WaTemplate, type WaTemplateComponent } from "./whatsapp-business-messages.js";

export const GRAPH_BASE = "https://graph.facebook.com";

/** Hosts the access token may be sent to when downloading media (Meta's own). */
export const WA_MEDIA_HOSTS = ["graph.facebook.com", "lookaside.fbsbx.com"] as const;

/** True when a media URL is on one of Meta's hosts over https (the token never goes anywhere else). */
export function isMetaMediaUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && (WA_MEDIA_HOSTS as readonly string[]).includes(u.hostname);
  } catch {
    return false;
  }
}

/** Meta's error for a free-form message outside the 24-hour window ("re-engagement message"). */
export const WA_ERROR_OUTSIDE_WINDOW = 131047;

export class WaGraphError extends Error {
  constructor(message: string, readonly status: number, readonly code?: number, readonly title?: string, readonly details?: string) {
    super(message);
    this.name = "WaGraphError";
  }
}

export interface WaPhoneInfo {
  id?: string;
  displayPhoneNumber?: string;
  verifiedName?: string;
  qualityRating?: string;
  messagingLimitTier?: string;
  nameStatus?: string;
  newNameStatus?: string;
  codeVerificationStatus?: string;
  throughput?: string;
  platformType?: string;
  accountMode?: string;
  officialBusinessAccount?: string;
}

export interface WaBusinessProfile {
  about?: string;
  address?: string;
  description?: string;
  email?: string;
  profilePictureUrl?: string;
  websites?: string[];
  vertical?: string;
}

export const WA_PROFILE_VERTICALS = [
  "UNDEFINED", "OTHER", "AUTO", "BEAUTY", "APPAREL", "EDU", "ENTERTAIN", "EVENT_PLAN", "FINANCE", "GROCERY", "GOVT", "HOTEL", "HEALTH",
  "NONPROFIT", "PROF_SERVICES", "RETAIL", "TRAVEL", "RESTAURANT", "NOT_A_BIZ",
] as const;

export interface WaGraphOptions {
  version?: string;
  phoneNumberId: string;
  wabaId: string;
  token: () => Promise<string | undefined>;
  fetch?: typeof fetch;
}

/** Split a text into WhatsApp messages (at paragraphs, then lines, then words). */
export function splitWhatsAppText(text: string, max = WABIZ_TEXT_MAX): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = Math.max(window.lastIndexOf("\n\n"), -1);
    if (cut < max * 0.5) cut = window.lastIndexOf("\n");
    if (cut < max * 0.5) cut = window.lastIndexOf(" ");
    if (cut < max * 0.5) cut = max;
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) out.push(rest);
  return out;
}

const TEMPLATE_FIELDS = "id,name,language,status,category,components,parameter_format,quality_score,rejected_reason";

function toButton(b: any): WaTemplateButton {
  const out: WaTemplateButton = {};
  for (const k of ["type", "text", "url", "phone_number", "otp_type", "flow_id"] as const) if (b?.[k] !== undefined) (out as Record<string, unknown>)[k] = String(b[k]);
  if (b?.example !== undefined) out.example = b.example;
  return out;
}

function toComponent(c: any): WaTemplateComponent {
  return {
    type: String(c?.type ?? ""), ...(c?.format ? { format: String(c.format) } : {}), ...(c?.text ? { text: String(c.text) } : {}),
    ...(Array.isArray(c?.buttons) ? { buttons: c.buttons.map(toButton) } : {}),
    ...(Array.isArray(c?.cards) ? { cards: c.cards.map((card: any) => ({ components: Array.isArray(card?.components) ? card.components.map(toComponent) : [] })) } : {}),
    ...(c?.example !== undefined ? { example: c.example } : {}),
    ...(c?.limited_time_offer ? { limited_time_offer: c.limited_time_offer } : {}),
    ...(c?.add_security_recommendation !== undefined ? { add_security_recommendation: !!c.add_security_recommendation } : {}),
    ...(c?.code_expiration_minutes !== undefined ? { code_expiration_minutes: Number(c.code_expiration_minutes) } : {}),
  };
}

export function toTemplate(t: any): WaTemplate {
  return {
    ...(t.id ? { id: String(t.id) } : {}), name: String(t.name), language: String(t.language), status: String(t.status ?? "UNKNOWN"),
    category: String(t.category ?? "UNKNOWN").toUpperCase(),
    ...(t.parameter_format ? { parameterFormat: String(t.parameter_format).toUpperCase() as WaTemplate["parameterFormat"] } : {}),
    components: Array.isArray(t.components) ? t.components.map(toComponent) : [],
    ...(t.quality_score?.score ? { quality: String(t.quality_score.score) } : {}),
    ...(t.rejected_reason && t.rejected_reason !== "NONE" ? { rejectedReason: String(t.rejected_reason) } : {}),
  };
}

/** A template definition to create or edit (Meta's shape: name, language, category, components, parameter_format). */
export interface WaTemplateDefinition {
  name: string;
  language: string;
  category: "UTILITY" | "MARKETING" | "AUTHENTICATION";
  components: Array<Record<string, unknown>>;
  parameterFormat?: "POSITIONAL" | "NAMED";
  /** Let Meta change the category when it does not match the content. */
  allowCategoryChange?: boolean;
}

export type WaAnalyticsKind = "messages" | "pricing" | "templates";

export class WaGraphClient {
  constructor(private readonly o: WaGraphOptions) {}

  private get version() { return this.o.version || WABIZ_DEFAULT_GRAPH_VERSION; }
  private get f() { return this.o.fetch ?? fetch; }

  private async token(): Promise<string> {
    const token = await this.o.token();
    if (!token) throw new WaGraphError("The access token is not set (Settings → Channels → WhatsApp Business)", 0);
    return token;
  }

  private async parse<T>(res: Response): Promise<T> {
    const text = await res.text();
    let json: any;
    try { json = text ? JSON.parse(text) : {}; } catch { json = {}; }
    if (!res.ok || json?.error) {
      const e = json?.error ?? {};
      const details = e.error_data?.details as string | undefined;
      throw new WaGraphError(
        `Meta refused the request (${res.status}${e.code ? `, code ${e.code}` : ""}): ${e.message ?? (text.slice(0, 200) || res.statusText)}${details ? ` — ${details}` : ""}`,
        res.status, typeof e.code === "number" ? e.code : undefined, e.error_user_title ?? e.type, details,
      );
    }
    return json as T;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = await this.token();
    const res = await this.f(`${GRAPH_BASE}/${this.version}/${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(20_000),
    });
    return this.parse<T>(res);
  }

  private recipient(to: string): Record<string, string> {
    // a phone number goes as `to`; a business-scoped user id (no phone number) as `recipient`
    return isPhoneWaId(to) ? { to } : { recipient: to };
  }

  /** Send any message body (whatsapp-business-messages.ts builds them); the wamid. */
  async sendPayload(to: string, payload: Record<string, unknown>, endpoint: "messages" | "marketing_messages" = "messages"): Promise<string> {
    const r = await this.request<{ messages?: Array<{ id: string }> }>("POST", `${this.o.phoneNumberId}/${endpoint}`, {
      messaging_product: "whatsapp", recipient_type: "individual", ...this.recipient(to), ...payload,
    });
    const id = r.messages?.[0]?.id;
    if (!id) throw new WaGraphError("Meta accepted the message but returned no id", 200);
    return id;
  }

  /** Send a text (split when longer than 4096); the wamids, in order. The first part may quote a message. */
  async sendText(to: string, text: string, o: { replyTo?: string; previewUrl?: boolean } = {}): Promise<string[]> {
    const ids: string[] = [];
    for (const [i, part] of splitWhatsAppText(markdownToWhatsApp(text)).entries()) {
      ids.push(await this.sendPayload(to, {
        ...(i === 0 && o.replyTo ? { context: { message_id: o.replyTo } } : {}),
        type: "text", text: { body: part, preview_url: o.previewUrl === true },
      }));
    }
    return ids;
  }

  /** Send a template with all its components (checked against its definition). */
  async sendTemplate(to: string, t: WaTemplate, input: WaBizTemplateInput | string[], o: { marketing?: boolean } = {}): Promise<string> {
    const components = templateComponents(t, Array.isArray(input) ? { body: input } : input);
    return this.sendPayload(to, {
      type: "template", template: { name: t.name, language: { code: t.language }, ...(components.length ? { components } : {}) },
    }, o.marketing ? "marketing_messages" : "messages");
  }

  /** Mark an inbound message read, with the typing indicator (it lasts until the reply, at most 25 s). */
  async markRead(wamid: string, typing: boolean): Promise<void> {
    await this.request("POST", `${this.o.phoneNumberId}/messages`, {
      messaging_product: "whatsapp", status: "read", message_id: wamid, ...(typing ? { typing_indicator: { type: "text" } } : {}),
    });
  }

  // ── Media ──

  /** Upload a file for sending (valid 30 days); its media id. */
  async uploadMedia(data: Buffer, mimeType: string, filename: string): Promise<string> {
    const token = await this.token();
    const form = new FormData();
    form.append("messaging_product", "whatsapp");
    form.append("type", mimeType);
    form.append("file", new Blob([new Uint8Array(data)], { type: mimeType }), filename);
    const res = await this.f(`${GRAPH_BASE}/${this.version}/${this.o.phoneNumberId}/media`, {
      method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form, signal: AbortSignal.timeout(120_000),
    });
    const r = await this.parse<{ id?: string }>(res);
    if (!r.id) throw new WaGraphError("Meta accepted the upload but returned no media id", 200);
    return r.id;
  }

  /** A media's download URL (valid 5 minutes) and what Meta knows of it. */
  async mediaInfo(mediaId: string): Promise<{ url: string; mimeType?: string; sha256?: string; size?: number }> {
    const r = await this.request<{ url?: string; mime_type?: string; sha256?: string; file_size?: number | string }>("GET",
      `${encodeURIComponent(mediaId)}?phone_number_id=${encodeURIComponent(this.o.phoneNumberId)}`);
    if (!r.url) throw new WaGraphError("Meta returned no URL for the media", 200);
    return {
      url: r.url, ...(r.mime_type ? { mimeType: r.mime_type } : {}), ...(r.sha256 ? { sha256: r.sha256 } : {}),
      ...(r.file_size !== undefined && Number.isFinite(Number(r.file_size)) ? { size: Number(r.file_size) } : {}),
    };
  }

  /**
   * Download a media URL with the token: only https on Meta's hosts (the token never goes anywhere
   * else), at most maxBytes (checked on the header and while reading).
   */
  async downloadMedia(url: string, maxBytes: number): Promise<{ data: Buffer; mimeType?: string }> {
    if (!isMetaMediaUrl(url)) throw new WaGraphError(`Refused to download media from ${(() => { try { return new URL(url).hostname; } catch { return "an invalid URL"; } })()}: only Meta's hosts`, 0);
    const token = await this.token();
    const res = await this.f(url, { headers: { Authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new WaGraphError(`Meta refused the media download (${res.status})`, res.status);
    const declared = Number(res.headers.get("content-length") ?? "0");
    if (declared > maxBytes) throw new WaGraphError(`The file is too large (${Math.ceil(declared / 1024)} KB; at most ${Math.floor(maxBytes / 1024)} KB)`, 413);
    const chunks: Buffer[] = [];
    let total = 0;
    if (res.body) {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => undefined);
          throw new WaGraphError(`The file is too large (over ${Math.floor(maxBytes / 1024)} KB)`, 413);
        }
        chunks.push(Buffer.from(value));
      }
    }
    const type = res.headers.get("content-type") ?? undefined;
    return { data: Buffer.concat(chunks), ...(type ? { mimeType: type.split(";")[0]!.trim() } : {}) };
  }

  async deleteMedia(mediaId: string): Promise<void> {
    await this.request("DELETE", `${encodeURIComponent(mediaId)}?phone_number_id=${encodeURIComponent(this.o.phoneNumberId)}`);
  }

  // ── Templates ──

  /** Every template of the account (all pages, at most 2000). */
  async listTemplates(): Promise<WaTemplate[]> {
    const out: WaTemplate[] = [];
    let path: string | undefined = `${this.o.wabaId}/message_templates?fields=${TEMPLATE_FIELDS}&limit=100`;
    for (let i = 0; path && i < 20; i++) {
      const r: { data?: any[]; paging?: { cursors?: { after?: string }; next?: string } } = await this.request("GET", path);
      for (const t of r.data ?? []) out.push(toTemplate(t));
      const after = r.paging?.next ? r.paging.cursors?.after : undefined;
      path = after ? `${this.o.wabaId}/message_templates?fields=${TEMPLATE_FIELDS}&limit=100&after=${encodeURIComponent(after)}` : undefined;
    }
    return out;
  }

  /** Create a template (it goes to Meta's review); its id, status and category. */
  async createTemplate(d: WaTemplateDefinition): Promise<{ id: string; status: string; category: string }> {
    const r = await this.request<{ id?: string; status?: string; category?: string }>("POST", `${this.o.wabaId}/message_templates`, {
      name: d.name, language: d.language, category: d.category, components: d.components,
      ...(d.parameterFormat ? { parameter_format: d.parameterFormat } : {}),
      ...(d.allowCategoryChange ? { allow_category_change: true } : {}),
    });
    return { id: String(r.id ?? ""), status: String(r.status ?? "PENDING"), category: String(r.category ?? d.category) };
  }

  /** Edit a template's components (and category); it goes back to review. */
  async editTemplate(id: string, d: { components?: Array<Record<string, unknown>>; category?: string }): Promise<void> {
    await this.request("POST", encodeURIComponent(id), { ...(d.components ? { components: d.components } : {}), ...(d.category ? { category: d.category } : {}) });
  }

  /** Delete a template: every language by name, or one by its id. */
  async deleteTemplate(name: string, id?: string): Promise<void> {
    await this.request("DELETE", `${this.o.wabaId}/message_templates?name=${encodeURIComponent(name)}${id ? `&hsm_id=${encodeURIComponent(id)}` : ""}`);
  }

  // ── Business profile ──

  async businessProfile(): Promise<WaBusinessProfile> {
    const r = await this.request<{ data?: Array<Record<string, unknown>> }>("GET",
      `${this.o.phoneNumberId}/whatsapp_business_profile?fields=about,address,description,email,profile_picture_url,websites,vertical`);
    const p = r.data?.[0] ?? {};
    const sv = (v: unknown) => (typeof v === "string" && v ? v : undefined);
    const out: WaBusinessProfile = {};
    if (sv(p.about)) out.about = sv(p.about); if (sv(p.address)) out.address = sv(p.address);
    if (sv(p.description)) out.description = sv(p.description); if (sv(p.email)) out.email = sv(p.email);
    if (sv(p.profile_picture_url)) out.profilePictureUrl = sv(p.profile_picture_url);
    if (Array.isArray(p.websites)) out.websites = p.websites.map(String);
    if (sv(p.vertical)) out.vertical = sv(p.vertical);
    return out;
  }

  async updateBusinessProfile(p: Omit<WaBusinessProfile, "profilePictureUrl"> & { profilePictureHandle?: string }): Promise<void> {
    await this.request("POST", `${this.o.phoneNumberId}/whatsapp_business_profile`, {
      messaging_product: "whatsapp",
      ...(p.about !== undefined ? { about: p.about } : {}), ...(p.address !== undefined ? { address: p.address } : {}),
      ...(p.description !== undefined ? { description: p.description } : {}), ...(p.email !== undefined ? { email: p.email } : {}),
      ...(p.websites !== undefined ? { websites: p.websites } : {}), ...(p.vertical !== undefined ? { vertical: p.vertical } : {}),
      ...(p.profilePictureHandle ? { profile_picture_handle: p.profilePictureHandle } : {}),
    });
  }

  /** Resumable Upload (the profile photo): a handle to give the business profile. */
  async resumableUpload(appId: string, data: Buffer, mimeType: string): Promise<string> {
    const session = await this.request<{ id?: string }>("POST", `${encodeURIComponent(appId)}/uploads?file_length=${data.length}&file_type=${encodeURIComponent(mimeType)}`);
    if (!session.id) throw new WaGraphError("Meta opened no upload session", 200);
    const token = await this.token();
    const res = await this.f(`${GRAPH_BASE}/${this.version}/${session.id}`, {
      method: "POST", headers: { Authorization: `OAuth ${token}`, file_offset: "0" }, body: new Uint8Array(data), signal: AbortSignal.timeout(120_000),
    });
    const r = await this.parse<{ h?: string }>(res);
    if (!r.h) throw new WaGraphError("Meta returned no file handle", 200);
    return r.h;
  }

  // ── Blocked users ──

  async blockUsers(users: string[], block: boolean): Promise<{ done: string[]; failed: Array<{ user: string; error: string }> }> {
    const r = await this.request<{ block_users?: { added_users?: any[]; removed_users?: any[]; failed_users?: any[] } }>(block ? "POST" : "DELETE", `${this.o.phoneNumberId}/block_users`, {
      messaging_product: "whatsapp", block_users: users.map((u) => (isPhoneWaId(u) ? { user: `+${u}` } : { user_id: u })),
    });
    const b = r.block_users ?? {};
    const list = (block ? b.added_users : b.removed_users) ?? [];
    return {
      done: list.map((u: any) => String(u.wa_id ?? u.input ?? u.user_id ?? "")),
      failed: (b.failed_users ?? []).map((u: any) => ({ user: String(u.wa_id ?? u.input ?? u.user_id ?? ""), error: String(u.errors?.[0]?.message ?? u.errors?.[0]?.title ?? "refused") })),
    };
  }

  async blockedUsers(limit = 100): Promise<string[]> {
    const r = await this.request<{ data?: Array<{ wa_id?: string; messaging_product?: string; user_id?: string }> }>("GET", `${this.o.phoneNumberId}/block_users?limit=${limit}`);
    return (r.data ?? []).map((u) => String(u.wa_id ?? u.user_id ?? "")).filter(Boolean);
  }

  // ── Analytics ──

  /**
   * messages: sent / delivered per window (analytics); pricing: cost and volume per category
   * (pricing_analytics); templates: sent, delivered, read, clicked per template (template_analytics, 90 days).
   */
  async analytics(kind: WaAnalyticsKind, o: { start: number; end: number; granularity?: string; templateIds?: string[]; dimensions?: string[] }): Promise<unknown> {
    if (kind === "templates") {
      if (!o.templateIds?.length) throw new WaGraphError("Template analytics need template ids (at most 10)", 0);
      const q = new URLSearchParams({
        start: String(o.start), end: String(o.end), granularity: "DAILY", template_ids: JSON.stringify(o.templateIds.slice(0, 10)),
        metric_types: JSON.stringify(["SENT", "DELIVERED", "READ", "CLICKED"]),
      });
      return this.request("GET", `${this.o.wabaId}/template_analytics?${q.toString()}`);
    }
    // the whole account (Meta filters by display numbers, not ids: every number of the account is counted)
    const phones = "";
    const field = kind === "messages"
      ? `analytics.start(${o.start}).end(${o.end}).granularity(${o.granularity ?? "DAY"})${phones}`
      : `pricing_analytics.start(${o.start}).end(${o.end}).granularity(${o.granularity ?? "DAILY"})${phones}${o.dimensions?.length ? `.dimensions(${JSON.stringify(o.dimensions)})` : ""}`;
    return this.request("GET", `${this.o.wabaId}?fields=${encodeURIComponent(field)}`);
  }

  // ── Phone number ──

  /** The phone number as Meta knows it: name and its review, quality rating, messaging limit tier, mode. */
  async phoneInfo(): Promise<WaPhoneInfo> {
    const r = await this.request<Record<string, unknown>>("GET",
      `${this.o.phoneNumberId}?fields=id,display_phone_number,verified_name,quality_rating,messaging_limit_tier,name_status,new_name_status,code_verification_status,throughput,platform_type,account_mode,is_official_business_account`);
    const s = (v: unknown) => (typeof v === "string" && v ? v : typeof v === "boolean" ? String(v) : undefined);
    const throughput = (r.throughput as { level?: unknown } | undefined)?.level;
    const out: WaPhoneInfo = {};
    const set = (k: keyof WaPhoneInfo, v: unknown) => { const x = s(v); if (x) out[k] = x; };
    set("id", r.id); set("displayPhoneNumber", r.display_phone_number); set("verifiedName", r.verified_name);
    set("qualityRating", r.quality_rating); set("messagingLimitTier", r.messaging_limit_tier); set("nameStatus", r.name_status);
    set("newNameStatus", r.new_name_status); set("codeVerificationStatus", r.code_verification_status); set("throughput", throughput);
    set("platformType", r.platform_type); set("accountMode", r.account_mode); set("officialBusinessAccount", r.is_official_business_account);
    return out;
  }

  /** Register the number for the Cloud API with its two-step verification PIN (6 digits). */
  async register(pin: string): Promise<void> {
    await this.request("POST", `${this.o.phoneNumberId}/register`, { messaging_product: "whatsapp", pin });
  }

  async deregister(): Promise<void> {
    await this.request("POST", `${this.o.phoneNumberId}/deregister`, {});
  }

  /** Set (or change) the two-step verification PIN. */
  async setTwoStepPin(pin: string): Promise<void> {
    await this.request("POST", this.o.phoneNumberId, { pin });
  }

  async requestCode(method: "SMS" | "VOICE", language: string): Promise<void> {
    await this.request("POST", `${this.o.phoneNumberId}/request_code`, { code_method: method, language });
  }

  async verifyCode(code: string): Promise<void> {
    await this.request("POST", `${this.o.phoneNumberId}/verify_code`, { code });
  }

  /** The callback Meta calls for this number (an override of the app's), if any. */
  async webhookConfiguration(): Promise<{ application?: string; phoneNumber?: string; whatsappBusinessAccount?: string }> {
    const r = await this.request<{ webhook_configuration?: Record<string, unknown> }>("GET", `${this.o.phoneNumberId}?fields=webhook_configuration`);
    const w = r.webhook_configuration ?? {};
    const sv = (v: unknown) => (typeof v === "string" && v ? v : undefined);
    return {
      ...(sv(w.application) ? { application: sv(w.application) } : {}), ...(sv(w.phone_number) ? { phoneNumber: sv(w.phone_number) } : {}),
      ...(sv(w.whatsapp_business_account) ? { whatsappBusinessAccount: sv(w.whatsapp_business_account) } : {}),
    };
  }

  /** Point this number's deliveries at a callback of its own (one app shared by several instances); "" removes the override. */
  async setWebhookOverride(callbackUrl: string, verifyToken: string): Promise<void> {
    await this.request("POST", this.o.phoneNumberId, { webhook_configuration: { override_callback_uri: callbackUrl, verify_token: verifyToken } });
  }

  /** Subscribe the app to the account's webhooks (without it no message reaches the webhook). */
  async subscribeApp(): Promise<void> {
    await this.request("POST", `${this.o.wabaId}/subscribed_apps`, {});
  }
}

/** What the notification channel needs from the service (whatsapp-business-service.ts). */
export interface WaBusinessNotifier {
  notify(channel: string, notification: Notification): Promise<void>;
  test(channel: string): Promise<boolean>;
}

/**
 * The notification channel: notification rules and conversation pipes hand their notifications to
 * the service, which applies the window, opt-out and caps (free-form inside the window; outside it
 * the configured notification template, or a failure).
 */
export class WaBusinessChannel implements NotificationChannel {
  readonly type = "whatsapp-business";
  constructor(private readonly name: string, private readonly notifier: () => WaBusinessNotifier | undefined) {}

  private service(): WaBusinessNotifier {
    const s = this.notifier();
    if (!s) throw new Error(`WhatsApp Business channel "${this.name}" is not running`);
    return s;
  }

  async send(notification: Notification): Promise<void> {
    await this.service().notify(this.name, notification);
  }

  async test(): Promise<boolean> {
    return this.service().test(this.name);
  }
}
