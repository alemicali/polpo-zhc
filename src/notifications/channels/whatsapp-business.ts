/**
 * WhatsApp Business (Meta Cloud API): the Graph API client and the notification channel.
 *
 * The client sends text (split at 4096 characters, markdown turned into WhatsApp formatting),
 * templates (parameters checked against the template synced from Meta), marks messages read with
 * the typing indicator, lists the account's templates and reads the phone number (test, quality).
 * Everything else — the 24-hour window, opt-out, caps, approval — is the service's
 * (whatsapp-business-service.ts): the notification channel only hands notifications to it.
 *
 * Graph API (v23.0):
 *   POST /{phone-number-id}/messages   { messaging_product: "whatsapp", to | recipient, type: "text" | "template", … }
 *   POST /{phone-number-id}/messages   { messaging_product: "whatsapp", status: "read", message_id, typing_indicator: { type: "text" } }
 *   GET  /{waba-id}/message_templates  ?fields=name,language,status,category,components,parameter_format&limit=100 (paged)
 *   GET  /{phone-number-id}            ?fields=display_phone_number,verified_name,quality_rating,messaging_limit_tier,…
 */
import type { NotificationChannel, Notification } from "../types.js";
import { WABIZ_DEFAULT_GRAPH_VERSION, WABIZ_TEXT_MAX, isPhoneWaId } from "@polpo-ai/core/whatsapp-business";
import { markdownToWhatsApp } from "./whatsapp.js";

export const GRAPH_BASE = "https://graph.facebook.com";

/** Meta's error for a free-form message outside the 24-hour window ("re-engagement message"). */
export const WA_ERROR_OUTSIDE_WINDOW = 131047;

export class WaGraphError extends Error {
  constructor(message: string, readonly status: number, readonly code?: number, readonly title?: string, readonly details?: string) {
    super(message);
    this.name = "WaGraphError";
  }
}

export interface WaTemplateComponent {
  type: string;
  format?: string;
  text?: string;
  buttons?: Array<{ type?: string; text?: string; url?: string }>;
}

export interface WaTemplate {
  id?: string;
  name: string;
  language: string;
  status: string;
  category: string;
  parameterFormat?: "POSITIONAL" | "NAMED";
  components: WaTemplateComponent[];
}

export interface WaPhoneInfo {
  id?: string;
  displayPhoneNumber?: string;
  verifiedName?: string;
  qualityRating?: string;
  messagingLimitTier?: string;
  nameStatus?: string;
  codeVerificationStatus?: string;
  throughput?: string;
}

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

/** The body's placeholders, in order of first appearance: ["1", "2"] or ["name", "order"]. */
export function templateBodyParams(t: Pick<WaTemplate, "components">): string[] {
  const body = t.components.find((c) => c.type.toUpperCase() === "BODY")?.text ?? "";
  const seen: string[] = [];
  for (const m of body.matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)) if (!seen.includes(m[1]!)) seen.push(m[1]!);
  return seen;
}

/** Why a template cannot be sent with these parameters (MVP: body parameters only), or undefined. */
export function templateProblem(t: WaTemplate, params: string[]): string | undefined {
  if (t.status.toUpperCase() !== "APPROVED") return `Template ${t.name} (${t.language}) is ${t.status}, not APPROVED`;
  const header = t.components.find((c) => c.type.toUpperCase() === "HEADER");
  if (header && (header.format ?? "TEXT").toUpperCase() !== "TEXT") return `Template ${t.name} has a ${header.format} header: media headers are not supported yet`;
  if (header?.text && /\{\{/.test(header.text)) return `Template ${t.name} has a header parameter: not supported yet`;
  const buttons = t.components.find((c) => c.type.toUpperCase() === "BUTTONS")?.buttons ?? [];
  if (buttons.some((b) => b.url && /\{\{/.test(b.url))) return `Template ${t.name} has a dynamic button URL: not supported yet`;
  const expected = templateBodyParams(t).length;
  if (params.length !== expected) return `Template ${t.name} needs ${expected} body parameter${expected === 1 ? "" : "s"}, got ${params.length}`;
  if (params.some((p) => typeof p !== "string" || !p.trim())) return "Template parameters cannot be empty";
  if (params.some((p) => /[\n\t]|\s{5,}/.test(p))) return "Template parameters cannot contain new lines, tabs or more than 4 spaces in a row (Meta refuses them)";
  return undefined;
}

export class WaGraphClient {
  constructor(private readonly o: WaGraphOptions) {}

  private get version() { return this.o.version || WABIZ_DEFAULT_GRAPH_VERSION; }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = await this.o.token();
    if (!token) throw new WaGraphError("The access token is not set (Settings → Channels → WhatsApp Business)", 0);
    const res = await (this.o.fetch ?? fetch)(`${GRAPH_BASE}/${this.version}/${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(20_000),
    });
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

  private recipient(to: string): Record<string, string> {
    // a phone number goes as `to`; a business-scoped user id (no phone number) as `recipient`
    return isPhoneWaId(to) ? { to } : { recipient: to };
  }

  /** Send a text (split when longer than 4096); the wamids, in order. */
  async sendText(to: string, text: string): Promise<string[]> {
    const ids: string[] = [];
    for (const part of splitWhatsAppText(markdownToWhatsApp(text))) {
      const r = await this.request<{ messages?: Array<{ id: string }> }>("POST", `${this.o.phoneNumberId}/messages`, {
        messaging_product: "whatsapp", recipient_type: "individual", ...this.recipient(to), type: "text", text: { body: part, preview_url: false },
      });
      const id = r.messages?.[0]?.id;
      if (!id) throw new WaGraphError("Meta accepted the message but returned no id", 200);
      ids.push(id);
    }
    return ids;
  }

  /** Send a template with body parameters (positional, or named in the template's order). */
  async sendTemplate(to: string, t: Pick<WaTemplate, "name" | "language" | "components" | "parameterFormat">, params: string[]): Promise<string> {
    const names = templateBodyParams(t);
    const named = t.parameterFormat === "NAMED" || names.some((n) => !/^\d+$/.test(n));
    const components = params.length
      ? [{ type: "body", parameters: params.map((text, i) => ({ type: "text", text, ...(named ? { parameter_name: names[i] } : {}) })) }]
      : [];
    const r = await this.request<{ messages?: Array<{ id: string }> }>("POST", `${this.o.phoneNumberId}/messages`, {
      messaging_product: "whatsapp", recipient_type: "individual", ...this.recipient(to), type: "template",
      template: { name: t.name, language: { code: t.language }, ...(components.length ? { components } : {}) },
    });
    const id = r.messages?.[0]?.id;
    if (!id) throw new WaGraphError("Meta accepted the template but returned no id", 200);
    return id;
  }

  /** Mark an inbound message read, with the typing indicator (it lasts until the reply, at most 25 s). */
  async markRead(wamid: string, typing: boolean): Promise<void> {
    await this.request("POST", `${this.o.phoneNumberId}/messages`, {
      messaging_product: "whatsapp", status: "read", message_id: wamid, ...(typing ? { typing_indicator: { type: "text" } } : {}),
    });
  }

  /** Every template of the account (all pages, at most 2000). */
  async listTemplates(): Promise<WaTemplate[]> {
    const out: WaTemplate[] = [];
    let path: string | undefined = `${this.o.wabaId}/message_templates?fields=id,name,language,status,category,components,parameter_format&limit=100`;
    for (let i = 0; path && i < 20; i++) {
      const r: { data?: any[]; paging?: { cursors?: { after?: string }; next?: string } } = await this.request("GET", path);
      for (const t of r.data ?? []) {
        out.push({
          ...(t.id ? { id: String(t.id) } : {}), name: String(t.name), language: String(t.language), status: String(t.status ?? "UNKNOWN"),
          category: String(t.category ?? "UNKNOWN").toUpperCase(),
          ...(t.parameter_format ? { parameterFormat: String(t.parameter_format).toUpperCase() as WaTemplate["parameterFormat"] } : {}),
          components: Array.isArray(t.components) ? t.components.map((c: any) => ({
            type: String(c.type ?? ""), ...(c.format ? { format: String(c.format) } : {}), ...(c.text ? { text: String(c.text) } : {}),
            ...(Array.isArray(c.buttons) ? { buttons: c.buttons.map((b: any) => ({ type: b.type, text: b.text, url: b.url })) } : {}),
          })) : [],
        });
      }
      const after = r.paging?.next ? r.paging.cursors?.after : undefined;
      path = after ? `${this.o.wabaId}/message_templates?fields=id,name,language,status,category,components,parameter_format&limit=100&after=${encodeURIComponent(after)}` : undefined;
    }
    return out;
  }

  /** The phone number as Meta knows it (test): name, quality rating, messaging limit tier when Graph returns them. */
  async phoneInfo(): Promise<WaPhoneInfo> {
    const r = await this.request<Record<string, unknown>>("GET",
      `${this.o.phoneNumberId}?fields=id,display_phone_number,verified_name,quality_rating,messaging_limit_tier,name_status,code_verification_status,throughput`);
    const s = (v: unknown) => (typeof v === "string" && v ? v : undefined);
    const throughput = (r.throughput as { level?: unknown } | undefined)?.level;
    const out: WaPhoneInfo = {};
    const set = (k: keyof WaPhoneInfo, v: unknown) => { const x = s(v); if (x) out[k] = x; };
    set("id", r.id); set("displayPhoneNumber", r.display_phone_number); set("verifiedName", r.verified_name);
    set("qualityRating", r.quality_rating); set("messagingLimitTier", r.messaging_limit_tier); set("nameStatus", r.name_status);
    set("codeVerificationStatus", r.code_verification_status); set("throughput", throughput);
    return out;
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
