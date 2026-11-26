/**
 * WhatsApp Business (Meta Cloud API) channels of an instance: the webhook, the persisted inbox, the
 * rules for sending, media, templates, approvals, account management and retention. One service
 * per instance (.polpo directory); the orchestrator gives it each channel's gateway, the server its
 * routes, the notification router its channels, the tools their sends.
 *
 * Webhook (public, GET/POST /api/v1/channels/whatsapp-business/webhooks/:name):
 * - GET: Meta's verification (hub.mode=subscribe, hub.verify_token compared in constant time) →
 *   hub.challenge as text/plain.
 * - POST: X-Hub-Signature-256 = sha256=HMAC-SHA256(app secret, raw body bytes), compared in
 *   constant time; 1 MB at most; rate limited per channel. Accepted deliveries are written to the
 *   inbox (.polpo/whatsapp-business-inbox/) before Meta gets its 200, then processed in order:
 *   nothing is lost across a restart (the inbox is drained at start) and nothing is handled twice
 *   (processed keys in the store, kept 7 days: `in:<wamid>` once the message is stored,
 *   `done:<wamid>` once the agent answered it, `st:<wamid>:<status>` per status).
 * - One Meta app shared by several numbers: a delivery for another channel of this instance is
 *   handled as that channel's; for a number another instance owns (business.sharedApp.routes) the
 *   raw body and its signature are forwarded there unchanged. Per-number callback overrides at
 *   Meta (setWebhookOverride) route each number to its own instance in the first place.
 * - Account-level fields (account_update, phone_number_quality_update, phone_number_name_update,
 *   message_template_status_update / quality / category, business_capability_update,
 *   account_alerts, security) are kept in the channel's account log and announced.
 * - Every delivery is in the channel's event log (.polpo/whatsapp-business-events/<channel>.json,
 *   capped): outcome, signature, what came in — message types and lengths, contacts masked,
 *   never a message's text.
 *
 * Inbound messages of every type are normalized (whatsapp-business-inbound.ts); media are
 * downloaded with the token from Meta's hosts only, within Meta's and the channel's size limits,
 * kept under .polpo/whatsapp-business/media/<channel>/ for the retention, and handed to the agent
 * as attachments (voice notes are transcribed by the gateway). Reactions, edits and revokes update
 * the message they refer to.
 *
 * Sending (every path but a reply to the message that just came in checks the window):
 * - every free-form type (text, media, location, contacts, reactions, interactive messages, flows,
 *   products, order details) only inside the 24-hour window the contact's last message opened
 *   (Meta's 131047 is handled too), never to a blocked contact;
 * - business-initiated messages only as approved templates of an allowed category, never to a
 *   contact who opted out (or stopped marketing messages, for marketing templates), within the
 *   daily caps; sent by agents or Polpo they wait for an operator's approval
 *   (business.approveTemplates, default on).
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import {
  WABIZ_MEDIA_LIMITS, WABIZ_PROCESSED_TTL_MS, WABIZ_SECRET_KINDS, WABIZ_SECRET_REF_FIELD, WABIZ_VAULT_OWNER, WABIZ_WINDOW_MS,
  canSendFreeForm, dayStartIso, isPhoneWaId, maskPhone, mediaKindFor, mediaProblem, newContact, normalizeWaId, optInKeyword, optOutKeyword,
  resolveWaBusinessSettings, wabizChatId, wabizVaultService, waIdFromChat, windowClosesAt,
  type ResolvedWaBusinessSettings, type WaBizContact, type WaBizMedia, type WaBizMediaKind, type WaBizMessage, type WaBizOutbound,
  type WaBizSecretKind, type WaBizTemplateInput, type WaBusinessStore,
} from "@polpo-ai/core/whatsapp-business";
import type { NotificationChannelConfig, PolpoEventMap, VaultStore } from "@polpo-ai/core";
import { CappedWebhookEventLog, type WebhookEventBase, type WebhookEventOutcome, type WebhookEventPage } from "../core/webhook-event-log.js";
import type { Notification } from "./types.js";
import {
  WA_ERROR_OUTSIDE_WINDOW, WaGraphClient, WaGraphError,
  type WaAnalyticsKind, type WaBusinessProfile, type WaPhoneInfo, type WaTemplate, type WaTemplateDefinition, type WaBusinessNotifier,
} from "./channels/whatsapp-business.js";
import { WaPayloadError, outboundPayload, outboundSummary, templateComponents, templatePreview, templateStatusProblem } from "./channels/whatsapp-business-messages.js";
import { parseInbound, type WaBizInboundEvent, type WaBizParsedInbound } from "./whatsapp-business-inbound.js";

export const WABIZ_WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;
/** Deliveries per minute per channel (Meta batches; bursts beyond this are refused and retried by Meta). */
export const WABIZ_WEBHOOK_RATE_PER_MINUTE = 600;
export const WABIZ_EVENTS_MAX = 300;
export const WABIZ_ACCOUNT_EVENTS_MAX = 200;
/** An inbox delivery that keeps failing is moved aside after this many attempts. */
const INBOX_MAX_ATTEMPTS = 5;
const TYPING_EVERY_MS = 20_000;
const PURGE_EVERY_MS = 6 * 3_600_000;

/** Webhook fields about the account, not a conversation. */
export const WABIZ_ACCOUNT_FIELDS = [
  "account_update", "account_alerts", "account_review_update", "business_capability_update", "phone_number_name_update",
  "phone_number_quality_update", "message_template_status_update", "message_template_quality_update", "message_template_components_update",
  "template_category_update", "security",
] as const;

/** The public path Meta calls (under the API). */
export const wabizWebhookPath = (channel: string) => `/api/v1/channels/whatsapp-business/webhooks/${encodeURIComponent(channel)}`;

/** The Tailscale Funnel command that exposes the webhooks of an instance (the path only, not the dashboard). */
export function wabizFunnelCommand(instance: string | undefined, port: number | undefined): string {
  return `tailscale funnel --bg --set-path /${instance || "<instance>"}/api/v1/channels/whatsapp-business/webhooks `
    + `http://127.0.0.1:${port ?? "<port>"}/api/v1/channels/whatsapp-business/webhooks`;
}

export const WABIZ_FUNNEL_NOTE = "Meta must reach POLPO_PUBLIC_URL + /api/v1/channels/whatsapp-business/webhooks/<channel> over HTTPS: "
  + "behind Tailscale Funnel, expose that path as well (not only /mcp), with the command shown.";

export type WaBizSignature = "valid" | "invalid" | "missing" | "not-checked";

/** One webhook delivery as the event log keeps it (never a message's text). */
export interface WaBizWebhookEvent extends WebhookEventBase {
  channel: string;
  reason?: string;
  httpStatus: number;
  signature: WaBizSignature;
  /** "verify", or the webhook field(s): messages, message_template_status_update… */
  eventType?: string;
  phoneNumberId?: string;
  messages?: number;
  statuses?: number;
  /** What the delivery carried: types and lengths, contacts masked. */
  items?: Array<{ kind: "message" | "status"; wamid?: string; type?: string; length?: number; status?: string; contact?: string; error?: string }>;
  action?: string;
  processingMs: number;
  bytes: number;
}
export type WaBizWebhookEventSummary = Omit<WaBizWebhookEvent, "items">;

/** An account-level webhook (quality, name review, templates, capabilities, alerts), as kept. */
export interface WaBizAccountEvent {
  id: string;
  channel: string;
  field: string;
  at: string;
  /** One line: what changed. */
  summary: string;
  value: Record<string, unknown>;
}

export interface WaBizChannelStatus {
  channel: string;
  phoneNumberId?: string;
  wabaId?: string;
  graphApiVersion: string;
  audience: "customers" | "operators";
  agent?: string;
  inbound: boolean;
  secrets: Record<WaBizSecretKind, boolean>;
  state: "receiving" | "configured" | "not-configured";
  missing: string[];
  callbackUrl?: string;
  funnelCommand: string;
  note: string;
  lastEventAt?: string;
  lastError?: string;
  counts: Record<WebhookEventOutcome, number>;
  inbox: number;
  pendingApprovals: number;
  sentToday: number;
  limits: ResolvedWaBusinessSettings["limits"];
  phone?: WaPhoneInfo & { checkedAt: string };
  templates?: { count: number; approved: number; syncedAt: string };
  /** What this channel can do beyond text: media, catalog, payments, marketing messages, shared app routes. */
  capabilities: {
    media: { download: boolean; maxBytes: number };
    catalogId?: string;
    payments?: { market: "IN" | "BR" };
    marketingMessagesApi: boolean;
    profilePhoto: boolean;
    sharedRoutes: string[];
  };
  lastAccountEvent?: { field: string; summary: string; at: string };
}

export interface WaBizConversation {
  contact: WaBizContact & { masked?: string };
  window: { open: boolean; closesAt?: string };
  optedOut: boolean;
  messages: WaBizMessage[];
}

export type WaBizSendResult =
  | { status: "sent"; ids: string[] }
  | { status: "pending_approval"; id: string; note: string };

/** A send refused by a rule (window, opt-out, cap, template, a payload over Meta's limits): the reason is for the caller. */
export class WaBizPolicyError extends Error {
  constructor(message: string, readonly code: "OUTSIDE_WINDOW" | "OPTED_OUT" | "CAP_REACHED" | "TEMPLATE" | "NOT_CONFIGURED" | "NOT_FOUND" | "CATEGORY" | "INVALID" | "BLOCKED") {
    super(message);
    this.name = "WaBizPolicyError";
  }
}

/** An inbound file handed to the agent (the gateway's attachment shape). */
export interface WaBizAttachment {
  kind: "photo" | "document" | "voice" | "audio" | "video";
  filename: string;
  mimeType: string;
  data: Buffer;
}

/** What the agent answered: text, reply buttons (→ interactive buttons or a list), files, a voice reply. */
export interface WaBizGatewayReply {
  text: string;
  buttons?: Array<Array<{ text: string; data: string }>>;
  files?: Array<{ path: string; filename: string }>;
  voice?: { data: Buffer; mimeType: string; filename: string };
}

/** The gateway of one channel, as the orchestrator gives it. */
export interface WaBizGatewayHandle {
  handle(input: { waId: string; chatId: string; name?: string; text: string; messageId: string; attachments?: WaBizAttachment[]; voice?: boolean }): Promise<WaBizGatewayReply | undefined>;
}

/** A file to send (uploaded to Meta first). */
export interface WaBizFile { data: Buffer; mimeType: string; filename: string }

export interface WaBusinessServiceOptions {
  polpoDir: () => string;
  channels: () => Record<string, NotificationChannelConfig>;
  store: () => WaBusinessStore;
  vault: () => VaultStore | undefined | null;
  emit?: <K extends "channel:message-status" | "channel:webhook" | "channel:wabiz-event">(event: K, payload: PolpoEventMap[K]) => void;
  log?: (level: "info" | "warn", message: string) => void;
  publicBase?: () => string | undefined;
  /** For the Funnel command: the instance's name in the public path and its port. */
  instance?: () => { name?: string; port?: number };
  fetch?: typeof fetch;
  now?: () => number;
  /** Run background work (purge, inbox drain timer); off in tests. */
  timers?: boolean;
}

interface InboxItem { id: string; channel: string; receivedAt: string; eventId: string; attempts: number; body: string }

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Meta's X-Hub-Signature-256 over the raw body bytes. */
export function wabizSignature(appSecret: string, raw: Buffer | string): string {
  return `sha256=${createHmac("sha256", appSecret).update(raw).digest("hex")}`;
}

export function verifyWabizSignature(raw: Buffer, header: string | undefined | null, appSecret: string): WaBizSignature {
  if (!header) return "missing";
  const expected = wabizSignature(appSecret, raw);
  return safeEqual(header.trim().toLowerCase(), expected) ? "valid" : "invalid";
}

/** The text and type of an inbound message (normalized), or undefined for a reaction, an edit or a revoke. */
export function inboundText(m: any): { text: string; type: string } | undefined {
  const p = parseInbound(m);
  if (p.reaction || p.edit || p.revoke) return undefined;
  return { text: p.text, type: p.type };
}

const STATUS_RANK: Record<string, number> = { accepted: 1, sent: 2, delivered: 3, read: 4 };

const EXT: Record<string, string> = {
  "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "audio/ogg": ".ogg", "audio/mpeg": ".mp3", "audio/mp4": ".m4a",
  "audio/aac": ".aac", "audio/amr": ".amr", "video/mp4": ".mp4", "video/3gpp": ".3gp", "application/pdf": ".pdf",
};

const ATTACHMENT_KIND: Record<WaBizMediaKind, WaBizAttachment["kind"]> = { image: "photo", sticker: "photo", audio: "audio", video: "video", document: "document" };

const safeName = (s: string) => s.replace(/[^\w.-]/g, "_").slice(0, 120);

export class WaBusinessService implements WaBusinessNotifier {
  private readonly log: CappedWebhookEventLog<WaBizWebhookEvent, WaBizWebhookEventSummary>;
  private readonly buckets = new Map<string, { at: number; count: number }>();
  private readonly gateways = new Map<string, WaBizGatewayHandle>();
  private readonly typingAt = new Map<string, number>();
  private readonly inFlight = new Set<string>();
  /** Inbox files whose replies are still running. */
  private readonly fileWork = new Set<Promise<void>>();
  /** Messages being answered now (channel:wamid). */
  private readonly routing = new Set<string>();
  private readonly chatQueues = new Map<string, Promise<void>>();
  private drainChain: Promise<void> = Promise.resolve();
  private timers: ReturnType<typeof setInterval>[] = [];
  private phoneInfo = new Map<string, WaPhoneInfo & { checkedAt: string }>();

  constructor(private readonly o: WaBusinessServiceOptions) {
    this.log = new CappedWebhookEventLog(o.polpoDir, "whatsapp-business-events", WABIZ_EVENTS_MAX, ({ items: _i, ...rest }) => rest);
  }

  private now(): number { return (this.o.now ?? Date.now)(); }
  private iso(): string { return new Date(this.now()).toISOString(); }

  /** Start: drain what the inbox kept from before, then the periodic purge and drain. */
  start(): void {
    void this.drain();
    if (this.o.timers === false) return;
    void this.purge().catch(() => undefined);
    const purge = setInterval(() => void this.purge().catch(() => undefined), PURGE_EVERY_MS);
    const drain = setInterval(() => void this.drain(), 60_000);
    purge.unref?.(); drain.unref?.();
    this.timers.push(purge, drain);
  }

  dispose(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.gateways.clear();
  }

  // ── Configuration ───────────────────────────────────────────────────

  channelNames(): string[] {
    return Object.entries(this.o.channels()).filter(([, c]) => c?.type === "whatsapp-business").map(([n]) => n);
  }

  config(name: string): NotificationChannelConfig | undefined {
    const c = this.o.channels()[name];
    return c?.type === "whatsapp-business" ? c : undefined;
  }

  private need(name: string): NotificationChannelConfig {
    const c = this.config(name);
    if (!c) throw new WaBizPolicyError(`No WhatsApp Business channel "${name}"`, "NOT_FOUND");
    return c;
  }

  settings(name: string): ResolvedWaBusinessSettings {
    return resolveWaBusinessSettings(this.config(name)?.business);
  }

  /** The local channel of a phone number id (one Meta app, several numbers on this instance). */
  channelForPhone(phoneNumberId: string): string | undefined {
    return this.channelNames().find((n) => String(this.config(n)?.phoneNumberId ?? "") === phoneNumberId);
  }

  setGateway(name: string, handle: WaBizGatewayHandle | undefined): void {
    if (handle) this.gateways.set(name, handle);
    else this.gateways.delete(name);
  }

  clearGateways(): void { this.gateways.clear(); }

  // ── Secrets ─────────────────────────────────────────────────────────

  private ref(name: string, kind: WaBizSecretKind): { owner: string; service: string } {
    const configured = this.config(name)?.[WABIZ_SECRET_REF_FIELD[kind]];
    // only the channel's own entries under $channels are honoured (validated on save, checked again here)
    if (configured?.owner === WABIZ_VAULT_OWNER && configured.service === wabizVaultService(name, kind)) return configured;
    return { owner: WABIZ_VAULT_OWNER, service: wabizVaultService(name, kind) };
  }

  private async secret(name: string, kind: WaBizSecretKind): Promise<string | undefined> {
    const r = this.ref(name, kind);
    const entry = await this.o.vault()?.get(r.owner, r.service).catch(() => undefined);
    const v = entry?.credentials?.secret;
    return typeof v === "string" && v.trim() ? v.trim() : undefined;
  }

  async secretsSet(name: string): Promise<Record<WaBizSecretKind, boolean>> {
    const out = {} as Record<WaBizSecretKind, boolean>;
    for (const k of WABIZ_SECRET_KINDS) out[k] = !!(await this.secret(name, k));
    return out;
  }

  /** Store a secret in the vault ($channels; the dashboard only); null removes it. */
  async setSecret(name: string, kind: WaBizSecretKind, value: string | null): Promise<void> {
    this.need(name);
    const vault = this.o.vault();
    if (!vault) throw new Error("This instance has no vault: the secret cannot be stored");
    const r = this.ref(name, kind);
    if (value === null) { await vault.remove(r.owner, r.service); return; }
    const v = value.trim();
    if (v.length < 8 || /\s/.test(v)) throw new Error(`That does not look like a ${kind === "accessToken" ? "access token" : kind === "appSecret" ? "app secret" : "verify token"}`);
    await vault.set(r.owner, r.service, { type: "custom", label: `WhatsApp Business "${name}": ${kind}`, credentials: { secret: v } });
  }

  /** A fresh verify token (stored; returned once, to paste in Meta's dashboard). */
  async generateVerifyToken(name: string): Promise<string> {
    const token = randomBytes(24).toString("base64url");
    await this.setSecret(name, "verifyToken", token);
    return token;
  }

  graph(name: string): WaGraphClient {
    const c = this.need(name);
    return new WaGraphClient({
      version: c.graphApiVersion, phoneNumberId: String(c.phoneNumberId ?? ""), wabaId: String(c.wabaId ?? ""),
      token: () => this.secret(name, "accessToken"), ...(this.o.fetch ? { fetch: this.o.fetch } : {}),
    });
  }

  callbackUrl(name: string): string | undefined {
    const base = this.o.publicBase?.()?.replace(/\/+$/, "");
    return base ? `${base}${wabizWebhookPath(name)}` : undefined;
  }

  // ── Webhook ─────────────────────────────────────────────────────────

  private hit(name: string): number {
    const now = this.now();
    const b = this.buckets.get(name);
    if (!b || now - b.at >= 60_000) { this.buckets.set(name, { at: now, count: 1 }); return 1; }
    return ++b.count;
  }

  private record(name: string, r: Omit<WaBizWebhookEvent, "id" | "channel" | "receivedAt" | "processingMs"> & { t0: number; receivedAt?: number }): WaBizWebhookEvent {
    const { t0, receivedAt, ...rest } = r;
    const at = receivedAt ?? this.now();
    const rec: WaBizWebhookEvent = {
      id: `wbe_${at.toString(36)}${randomBytes(4).toString("hex")}`, channel: name, receivedAt: new Date(at).toISOString(),
      ...rest, processingMs: Math.max(0, Math.round(performance.now() - t0)),
    };
    try { this.log.add(name, rec); } catch (err) { this.o.log?.("warn", `WhatsApp Business "${name}": the delivery could not be recorded: ${(err as Error).message}`); }
    this.announceEvent(rec, "recorded");
    return rec;
  }

  private announceEvent(rec: WaBizWebhookEvent, action: "recorded" | "updated"): void {
    try { this.o.emit?.("channel:webhook", { channel: rec.channel, id: rec.id, action, outcome: rec.outcome, ...(rec.eventType ? { eventType: rec.eventType } : {}) }); } catch { /* listeners never change a delivery */ }
  }

  /** A structured event (a flow completed, an order, a payment, an account update…) for triggers and the dashboard. */
  private announce(channel: string, kind: string, data: Record<string, unknown>, o: { waId?: string; messageId?: string } = {}): void {
    try {
      this.o.emit?.("channel:wabiz-event", {
        channel, kind, ...(o.waId ? { contact: maskPhone(o.waId) } : {}), ...(o.messageId ? { messageId: o.messageId } : {}), data,
      });
    } catch { /* listeners never change a delivery */ }
  }

  /** GET: Meta's subscription check. */
  async verifyChallenge(name: string, q: { mode?: string; token?: string; challenge?: string }): Promise<{ status: 200 | 403 | 404; text: string }> {
    const t0 = performance.now();
    if (!this.config(name)) return { status: 404, text: "Not found" };
    const expected = await this.secret(name, "verifyToken");
    const ok = q.mode === "subscribe" && !!expected && !!q.token && safeEqual(q.token, expected) && !!q.challenge;
    this.record(name, {
      t0, outcome: ok ? "accepted" : "rejected", httpStatus: ok ? 200 : 403, signature: "not-checked", eventType: "verify", bytes: 0,
      ...(ok ? { action: "Subscription verified: Meta can deliver to this endpoint" } : {
        reason: !expected ? "No verify token is set for this channel" : q.mode !== "subscribe" ? "hub.mode is not subscribe" : "The verify token does not match",
      }),
    });
    return ok ? { status: 200, text: q.challenge! } : { status: 403, text: "Forbidden" };
  }

  refuseTooLarge(name: string, bytes: number): { status: 413; body: Record<string, unknown> } {
    if (this.config(name)) {
      this.record(name, { t0: performance.now(), outcome: "rejected", httpStatus: 413, signature: "not-checked", bytes, reason: `Body too large (${Math.round(bytes / 1024)} KB; at most 1024 KB)` });
    }
    return { status: 413, body: { ok: false, error: "Body too large" } };
  }

  /** POST: one delivery. Answers fast; the content is processed from the inbox. */
  async receive(name: string, raw: Buffer, signatureHeader: string | undefined | null, o: { routedFrom?: string } = {}): Promise<{ status: 200 | 400 | 401 | 404 | 413 | 429 | 500 | 503; body: Record<string, unknown> }> {
    const t0 = performance.now();
    const cfg = this.config(name);
    // an unknown channel is not recorded (anyone can post to any path)
    if (!cfg) return { status: 404, body: { ok: false, error: "Not found" } };
    const bytes = raw.length;
    if (bytes > WABIZ_WEBHOOK_MAX_BODY_BYTES) return this.refuseTooLarge(name, bytes);
    const hits = this.hit(name);
    if (hits > WABIZ_WEBHOOK_RATE_PER_MINUTE) {
      if (hits === WABIZ_WEBHOOK_RATE_PER_MINUTE + 1) {
        this.record(name, { t0, outcome: "rejected", httpStatus: 429, signature: "not-checked", bytes, reason: `Too many requests (over ${WABIZ_WEBHOOK_RATE_PER_MINUTE} a minute: the rest of this minute's are refused without being recorded)` });
      }
      return { status: 429, body: { ok: false, error: "Too many requests" } };
    }
    try {
      const appSecret = await this.secret(name, "appSecret");
      if (!appSecret) {
        this.record(name, { t0, outcome: "rejected", httpStatus: 503, signature: "not-checked", bytes, reason: "The app secret is not set: deliveries cannot be verified" });
        return { status: 503, body: { ok: false, error: "Not configured" } };
      }
      const signature = verifyWabizSignature(raw, signatureHeader, appSecret);
      if (signature !== "valid") {
        this.record(name, { t0, outcome: "rejected", httpStatus: 401, signature, bytes, reason: signature === "missing" ? "Missing X-Hub-Signature-256" : "Signature does not match (X-Hub-Signature-256)" });
        return { status: 401, body: { ok: false, error: "Signature refused" } };
      }
      let body: any;
      try { body = JSON.parse(raw.toString("utf8")); } catch {
        this.record(name, { t0, outcome: "rejected", httpStatus: 400, signature, bytes, reason: "Not JSON" });
        return { status: 400, body: { ok: false, error: "Not JSON" } };
      }
      const d = describeDelivery(body);
      const mine = d.phoneNumberIds.includes(String(cfg.phoneNumberId));
      const base = {
        t0, httpStatus: 200, signature, bytes, ...(d.fields.length ? { eventType: d.fields.join(",") } : {}),
        ...(d.phoneNumberIds[0] ? { phoneNumberId: d.phoneNumberIds[0] } : {}),
        messages: d.messages, statuses: d.statuses, items: d.items,
      };
      if (d.fields.some((f) => f.startsWith("message_template") || f === "template_category_update")) {
        void this.templates(name, { refresh: true }).catch(() => undefined);
      }
      // account-level fields: kept in the account log (once per delivery, by the channel Meta called)
      const account = !o.routedFrom ? this.recordAccountFields(name, body) : 0;
      // one Meta app, several numbers: the others' deliveries go to their channel (here) or their instance
      const routed: string[] = [];
      if (!o.routedFrom) {
        for (const phone of d.phoneNumberIds.filter((p) => p !== String(cfg.phoneNumberId))) {
          const local = this.channelForPhone(phone);
          if (local && local !== name) {
            const r = await this.receive(local, raw, signatureHeader, { routedFrom: name });
            routed.push(`${phone} → channel ${local} (${r.status})`);
            continue;
          }
          const target = this.settings(name).sharedRoutes[phone];
          if (target) routed.push(`${phone} → ${await this.forward(target, raw, signatureHeader)}`);
        }
      }
      if (!mine) {
        const why = routed.length ? `For another phone number: routed ${routed.join("; ")}`
          : account ? `Account update (${d.fields.join(", ")})`
            : d.phoneNumberIds.length ? `For another phone number (${d.phoneNumberIds.join(", ")})` : `No message or status in it (${d.fields.join(", ") || "no field"})`;
        this.record(name, {
          ...base, outcome: routed.length || account ? "accepted" : "ignored", reason: why,
          action: routed.length ? "Routed" : account ? `Recorded ${account} account update(s)` : d.fields.some((f) => f.startsWith("message_template")) ? "Templates refreshed" : "Nothing",
        });
        return { status: 200, body: { ok: true, ...(routed.length || account ? {} : { ignored: true }) } };
      }
      const rec = this.record(name, { ...base, outcome: "accepted", action: `Queued: ${d.messages} message(s), ${d.statuses} status(es)${routed.length ? `; routed ${routed.join("; ")}` : ""}${o.routedFrom ? ` (via ${o.routedFrom})` : ""}` });
      this.enqueue({ id: rec.id, channel: name, receivedAt: rec.receivedAt, eventId: rec.id, attempts: 0, body: raw.toString("utf8") });
      void this.drain();
      return { status: 200, body: { ok: true } };
    } catch (err) {
      this.record(name, { t0, outcome: "error", httpStatus: 500, signature: "not-checked", bytes, reason: `Internal error: ${(err as Error).message}` });
      return { status: 500, body: { ok: false, error: "Internal error" } };
    }
  }

  /** Forward a delivery, unchanged (raw body and signature), to the instance that owns its number. */
  private async forward(url: string, raw: Buffer, signature: string | undefined | null): Promise<string> {
    try {
      const u = new URL(url);
      if (u.protocol !== "https:") return "refused (not https)";
      const res = await (this.o.fetch ?? fetch)(u.toString(), {
        method: "POST", headers: { "Content-Type": "application/json", ...(signature ? { "X-Hub-Signature-256": signature } : {}) },
        body: new Uint8Array(raw), redirect: "error", signal: AbortSignal.timeout(10_000),
      });
      return `${u.host}${u.pathname} (${res.status})`;
    } catch (err) {
      return `failed (${(err as Error).message})`;
    }
  }

  // ── Account events ──────────────────────────────────────────────────

  private accountFile(name: string): string { return join(this.o.polpoDir(), "whatsapp-business", `account-${safeName(name)}.json`); }

  accountEvents(name: string, limit = 50): WaBizAccountEvent[] {
    this.need(name);
    try { return (JSON.parse(readFileSync(this.accountFile(name), "utf8")) as WaBizAccountEvent[]).slice(0, limit); } catch { return []; }
  }

  private recordAccountFields(name: string, body: any): number {
    const events: WaBizAccountEvent[] = [];
    for (const entry of Array.isArray(body?.entry) ? body.entry : []) {
      for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
        const field = String(change?.field ?? "");
        if (!(WABIZ_ACCOUNT_FIELDS as readonly string[]).includes(field)) continue;
        const value = (change?.value ?? {}) as Record<string, unknown>;
        events.push({ id: `wae_${this.now().toString(36)}${randomBytes(3).toString("hex")}`, channel: name, field, at: this.iso(), summary: accountSummary(field, value), value });
      }
    }
    if (!events.length) return 0;
    try {
      const prev = (() => { try { return JSON.parse(readFileSync(this.accountFile(name), "utf8")) as WaBizAccountEvent[]; } catch { return []; } })();
      mkdirSync(join(this.o.polpoDir(), "whatsapp-business"), { recursive: true });
      writeFileSync(this.accountFile(name), JSON.stringify([...events.reverse(), ...prev].slice(0, WABIZ_ACCOUNT_EVENTS_MAX)));
    } catch (err) {
      this.o.log?.("warn", `WhatsApp Business "${name}": an account update could not be kept: ${(err as Error).message}`);
    }
    for (const e of events) {
      this.announce(name, "account", { field: e.field, summary: e.summary, value: e.value });
      // the quality rating, tier or name review changed: read the number again
      if (e.field.startsWith("phone_number") || e.field === "account_update") this.phoneInfo.delete(name);
      this.o.log?.("info", `WhatsApp Business "${name}": ${e.field}: ${e.summary}`);
    }
    return events.length;
  }

  // ── Inbox ───────────────────────────────────────────────────────────

  private inboxDir(): string { return join(this.o.polpoDir(), "whatsapp-business-inbox"); }

  private enqueue(item: InboxItem): void {
    const dir = this.inboxDir();
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${item.receivedAt.replace(/[:.]/g, "-")}_${item.id}.json`);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(item));
    renameSync(tmp, file);
  }

  inboxCount(name?: string): number {
    try {
      const files = readdirSync(this.inboxDir()).filter((f) => f.endsWith(".json"));
      if (!name) return files.length;
      return files.filter((f) => { try { return (JSON.parse(readFileSync(join(this.inboxDir(), f), "utf8")) as InboxItem).channel === name; } catch { return false; } }).length;
    } catch { return 0; }
  }

  /** Process what the inbox holds, oldest first (one drain at a time). Resolves when the deliveries were read (replies may still run). */
  drain(): Promise<void> {
    this.drainChain = this.drainChain.then(() => this.drainOnce()).catch((err) => {
      this.o.log?.("warn", `WhatsApp Business inbox: ${(err as Error).message}`);
    });
    return this.drainChain;
  }

  /** Resolves when the inbox is drained and every reply started from it finished (tests, shutdown). */
  async idle(): Promise<void> {
    await this.drain();
    await Promise.all([...this.chatQueues.values()]);
    await Promise.all([...this.fileWork]);
  }

  private async drainOnce(): Promise<void> {
    const dir = this.inboxDir();
    if (!existsSync(dir)) return;
    const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
    for (const f of files) {
      if (this.inFlight.has(f)) continue;
      const path = join(dir, f);
      let item: InboxItem;
      try { item = JSON.parse(readFileSync(path, "utf8")) as InboxItem; } catch { rmSync(path, { force: true }); continue; }
      if (!this.config(item.channel)) continue; // the channel was removed: kept until it comes back or is cleaned up
      this.inFlight.add(f);
      try {
        const replies = await this.process(item);
        // the file goes once every reply it started is done (a restart in between re-runs only what is not done)
        const work: Promise<void> = Promise.all(replies).then(() => { rmSync(path, { force: true }); }, (err) => this.failed(path, item, err))
          .finally(() => { this.inFlight.delete(f); this.fileWork.delete(work); });
        this.fileWork.add(work);
      } catch (err) {
        this.failed(path, item, err);
        this.inFlight.delete(f);
      }
    }
  }

  private failed(path: string, item: InboxItem, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    item.attempts++;
    try {
      if (item.attempts >= INBOX_MAX_ATTEMPTS) {
        const dead = join(this.inboxDir(), "failed");
        mkdirSync(dead, { recursive: true });
        renameSync(path, join(dead, path.split(/[\\/]/).pop()!));
      } else {
        writeFileSync(path, JSON.stringify(item));
      }
      if (this.log.update(item.channel, item.eventId, { outcome: "error", reason: `Processing failed (attempt ${item.attempts}): ${message}` })) {
        const rec = this.log.get(item.channel, item.eventId);
        if (rec) this.announceEvent(rec, "updated");
      }
    } catch { /* the file stays for the next drain */ }
    this.o.log?.("warn", `WhatsApp Business "${item.channel}": a delivery failed (attempt ${item.attempts}): ${message}`);
  }

  /** One delivery: statuses applied, messages stored and handed to the gateway (each chat in order). */
  private async process(item: InboxItem): Promise<Promise<void>[]> {
    const cfg = this.config(item.channel)!;
    const store = this.o.store();
    const body = JSON.parse(item.body);
    const replies: Promise<void>[] = [];
    for (const entry of Array.isArray(body?.entry) ? body.entry : []) {
      for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
        const v = change?.value ?? {};
        if (String(v?.metadata?.phone_number_id ?? "") !== String(cfg.phoneNumberId)) continue; // another number of the account
        if (Array.isArray(v.user_preferences)) await this.applyPreferences(item.channel, v.user_preferences);
        for (const s of Array.isArray(v.statuses) ? v.statuses : []) {
          if (String(s?.type ?? "") === "payment") {
            const payment = await this.applyPayment(item.channel, s);
            if (payment) replies.push(this.inChatOrder(`${item.channel}:${payment.waId}`, () => this.routeInbound(item.channel, payment.waId, payment.id, payment.text, [], undefined)));
          } else await this.applyStatus(item.channel, s);
        }
        const contacts: any[] = Array.isArray(v.contacts) ? v.contacts : [];
        for (const m of Array.isArray(v.messages) ? v.messages : []) {
          const wamid = String(m?.id ?? "");
          if (!wamid) continue;
          const c = contacts.find((x) => x?.wa_id === m.from || x?.user_id === m.from || x?.user_id === m.from_user_id) ?? contacts[0];
          const waId = normalizeWaId(String(m.from ?? m.from_user_id ?? c?.wa_id ?? c?.user_id ?? ""));
          if (!waId) continue;
          const parsed = parseInbound(m);
          if (parsed.reaction || parsed.edit || parsed.revoke) {
            await this.applyChange(item.channel, waId, wamid, parsed);
            continue;
          }
          const stored = await this.storeInbound(item.channel, waId, wamid, m, c, parsed);
          if (!parsed.route || !stored.route) {
            await store.markProcessed(`done:${item.channel}:${wamid}`, this.iso());
            continue;
          }
          // done (a retry or a restart) or being answered right now (the same message in two deliveries)
          const routing = `${item.channel}:${wamid}`;
          if (this.routing.has(routing) || await store.isProcessed(`done:${item.channel}:${wamid}`)) continue;
          this.routing.add(routing);
          replies.push(this.inChatOrder(`${item.channel}:${waId}`, async () => {
            const attachments = await this.attachmentsFor(item.channel, wamid);
            let text = parsed.text;
            if (parsed.media && !attachments.length) {
              // the file was not kept (too large, downloads off, Meta refused): the agent is told what it was
              const skipped = (await store.getMessage(wamid))?.media?.skipped;
              const what = parsed.media.voice ? "voice message" : parsed.media.kind === "image" ? "photo" : parsed.media.kind;
              text = `[${what}${parsed.media.filename ? ` ${parsed.media.filename}` : ""} not available${skipped ? `: ${skipped}` : ""}]${text ? ` ${text}` : ""}`;
            }
            await this.routeInbound(item.channel, waId, wamid, text, attachments, stored.name, parsed.media?.voice || parsed.type === "voice");
          }).finally(() => this.routing.delete(routing)));
        }
      }
    }
    return replies;
  }

  private inChatOrder(key: string, run: () => Promise<void>): Promise<void> {
    const prev = this.chatQueues.get(key) ?? Promise.resolve();
    const next = prev.then(run, run);
    this.chatQueues.set(key, next.catch(() => undefined));
    void next.finally(() => { if (this.chatQueues.get(key) === next) this.chatQueues.delete(key); }).catch(() => undefined);
    return next;
  }

  /** Store the message and update the contact (window, opt-out) once; route: whether the agent should see it. */
  private async storeInbound(name: string, waId: string, wamid: string, m: any, c: any, parsed: WaBizParsedInbound): Promise<{ route: boolean; name?: string }> {
    const store = this.o.store();
    const at = Number.isFinite(Number(m.timestamp)) ? new Date(Number(m.timestamp) * 1000).toISOString() : this.iso();
    const contact = (await store.getContact(name, waId)) ?? newContact(name, waId, this.iso());
    const displayName = typeof c?.profile?.name === "string" ? c.profile.name : contact.name;
    const optOut = parsed.type === "text" ? optOutKeyword(parsed.text) : undefined;
    const optIn = parsed.type === "text" ? optInKeyword(parsed.text) : undefined;
    if (!(await store.isProcessed(`in:${name}:${wamid}`))) {
      // a system notice or a call permission answer does not open the window (only a message the person wrote)
      const opensWindow = parsed.type !== "system";
      if (opensWindow && (!contact.lastInboundAt || contact.lastInboundAt <= at)) {
        contact.lastInboundAt = at;
        contact.lastInboundWamid = wamid;
      }
      if (displayName) contact.name = displayName;
      if (typeof c?.user_id === "string" && c.user_id) contact.userId = c.user_id;
      if (optOut) contact.optOut = { at, keyword: optOut };
      if (optIn) { contact.optOut = null; contact.optIn = { at, source: `keyword:${optIn}` }; }
      if (parsed.type === "interactive.call_permission_reply" && parsed.content) {
        const cp = parsed.content as { response: "accept" | "reject"; permanent?: boolean; expiresAt?: string };
        contact.callPermission = { response: cp.response, ...(cp.permanent !== undefined ? { permanent: cp.permanent } : {}), ...(cp.expiresAt ? { expiresAt: cp.expiresAt } : {}), at };
      }
      contact.updatedAt = this.iso();
      await store.saveContact(contact);
      const media = parsed.media ? await this.downloadInbound(name, waId, wamid, parsed.media) : undefined;
      await store.saveMessage({
        id: wamid, channel: name, waId, direction: "in", type: parsed.type, text: parsed.text, bodyLength: parsed.text.length,
        ...(media ? { media } : {}), ...(parsed.content ? { content: parsed.content } : {}), ...(parsed.context ? { context: parsed.context } : {}),
        ...(parsed.referral ? { referral: parsed.referral } : {}),
        status: "received", statuses: [{ status: "received", at }], createdAt: at, updatedAt: this.iso(),
      });
      this.emitStatus(name, wamid, "received", "in", waId);
      if (parsed.event) this.announce(name, parsed.event.kind, eventData(parsed.event), { waId, messageId: wamid });
      await store.markProcessed(`in:${name}:${wamid}`, this.iso());
      if (optOut) this.o.log?.("info", `WhatsApp Business "${name}": ${maskPhone(waId)} opted out (${optOut})`);
    }
    // an opt-out or opt-in keyword is not a message for the agent
    return { route: !optOut && !optIn, ...(displayName ? { name: displayName } : {}) };
  }

  /** A reaction, an edit or a revoke: the message it refers to changes (stored once per wamid). */
  private async applyChange(name: string, waId: string, wamid: string, p: WaBizParsedInbound): Promise<void> {
    const store = this.o.store();
    if (!(await store.markProcessed(`in:${name}:${wamid}`, this.iso()))) return;
    const targetId = p.reaction?.messageId ?? p.edit?.originalId ?? p.revoke?.originalId ?? "";
    const target = targetId ? await store.getMessage(targetId) : undefined;
    const at = this.iso();
    if (p.reaction) {
      // a reaction opens the window like any message the person sends
      const contact = (await store.getContact(name, waId)) ?? newContact(name, waId, at);
      contact.lastInboundAt = at; contact.lastInboundWamid = wamid; contact.updatedAt = at;
      await store.saveContact(contact);
      if (target && target.channel === name) {
        const others = (target.reactions ?? []).filter((r) => r.by !== "contact");
        target.reactions = p.reaction.emoji ? [...others, { emoji: p.reaction.emoji, by: "contact", at }] : others;
        target.updatedAt = at;
        await store.saveMessage(target);
      }
      this.emitStatus(name, targetId || wamid, p.reaction.emoji ? `reaction ${p.reaction.emoji}` : "reaction removed", "in", waId);
      this.announce(name, "reaction", { messageId: targetId, emoji: p.reaction.emoji }, { waId, messageId: wamid });
      return;
    }
    if (!target || target.channel !== name || target.waId !== waId) return;
    if (p.edit) {
      target.text = p.edit.text; target.bodyLength = p.edit.text.length; target.edited = { at }; target.updatedAt = at;
      await store.saveMessage(target);
      this.emitStatus(name, targetId, "edited", "in", waId);
    } else if (p.revoke) {
      // the person deleted it for everyone: its text and media go too
      if (target.media?.stored) rmSync(join(this.mediaDir(name), target.media.stored), { force: true });
      const { media: _m, text: _t, ...rest } = target;
      await store.saveMessage({ ...rest, ...(target.media ? { media: { kind: target.media.kind } } : {}), bodyLength: 0, revoked: { at }, updatedAt: at });
      this.emitStatus(name, targetId, "revoked", "in", waId);
    }
  }

  /** user_preferences: the person stopped or resumed marketing messages from WhatsApp itself. */
  private async applyPreferences(name: string, prefs: any[]): Promise<void> {
    const store = this.o.store();
    for (const p of prefs) {
      const waId = normalizeWaId(String(p?.wa_id ?? p?.user_id ?? ""));
      const value = String(p?.value ?? "");
      if (!waId || (value !== "stop" && value !== "resume") || String(p?.category ?? "marketing_messages") !== "marketing_messages") continue;
      const at = Number.isFinite(Number(p.timestamp)) ? new Date(Number(p.timestamp) * 1000).toISOString() : this.iso();
      const c = (await store.getContact(name, waId)) ?? newContact(name, waId, this.iso());
      c.marketing = { value, at };
      c.updatedAt = this.iso();
      await store.saveContact(c);
      this.announce(name, "marketing_preference", { value }, { waId });
    }
  }

  /** A payment status (India): kept as an inbound event of the conversation and handed to the agent. */
  private async applyPayment(name: string, s: any): Promise<{ waId: string; id: string; text: string } | undefined> {
    const store = this.o.store();
    const status = String(s?.status ?? "");
    const payment = (s?.payment ?? {}) as Record<string, any>;
    const ref = String(payment.reference_id ?? "");
    const waId = normalizeWaId(String(s?.recipient_id ?? ""));
    const id = `pay:${String(s?.id ?? ref)}:${status}`;
    if (!waId || !status) return undefined;
    if (!(await store.markProcessed(`st:${name}:${id}`, this.iso()))) return undefined;
    const at = Number.isFinite(Number(s.timestamp)) ? new Date(Number(s.timestamp) * 1000).toISOString() : this.iso();
    const amount = payment.amount && Number.isFinite(Number(payment.amount.value)) ? Number(payment.amount.value) / Number(payment.amount.offset || 100) : undefined;
    const content = {
      payment: { referenceId: ref, status, ...(amount !== undefined ? { amount } : {}), ...(payment.currency ? { currency: String(payment.currency) } : {}), ...(payment.transaction ? { transaction: payment.transaction } : {}) },
    };
    const text = `[payment ${status} for order ${ref}${amount !== undefined ? `: ${amount} ${payment.currency ?? ""}`.trimEnd() : ""}]`;
    await store.saveMessage({ id, channel: name, waId, direction: "in", type: "payment", text, bodyLength: text.length, content, status: "received", statuses: [{ status: "received", at }], createdAt: at, updatedAt: this.iso() });
    this.announce(name, "payment", content.payment, { waId, messageId: id });
    if (await store.isProcessed(`done:${name}:${id}`)) return undefined;
    return { waId, id, text };
  }

  // ── Media ───────────────────────────────────────────────────────────

  private mediaDir(name: string): string { return join(this.o.polpoDir(), "whatsapp-business", "media", safeName(name)); }

  /** Download an inbound media from Meta (its host only), within the limits; the media described either way. */
  private async downloadInbound(name: string, waId: string, wamid: string, media: WaBizMedia): Promise<WaBizMedia> {
    const s = this.settings(name);
    if (!s.media.download) return { ...media, skipped: "Media downloads are off (business.media.download)" };
    if (!media.mediaId) return { ...media, skipped: "No media id" };
    const max = Math.min(s.media.maxBytes, WABIZ_MEDIA_LIMITS[media.kind]?.maxBytes ?? s.media.maxBytes);
    if (media.size !== undefined && media.size > max) return { ...media, skipped: `Too large (${Math.ceil(media.size / 1024)} KB; at most ${Math.floor(max / 1024)} KB)` };
    try {
      const g = this.graph(name);
      const info = await g.mediaInfo(media.mediaId);
      if (info.size !== undefined && info.size > max) return { ...media, size: info.size, skipped: `Too large (${Math.ceil(info.size / 1024)} KB; at most ${Math.floor(max / 1024)} KB)` };
      const file = await g.downloadMedia(info.url, max);
      const mimeType = media.mimeType ?? info.mimeType ?? file.mimeType ?? "application/octet-stream";
      const ext = (media.filename && extname(media.filename)) || EXT[mimeType.split(";")[0]!.trim()] || "";
      const stored = `${safeName(waId)}_${safeName(wamid)}${ext}`;
      mkdirSync(this.mediaDir(name), { recursive: true });
      writeFileSync(join(this.mediaDir(name), stored), file.data);
      return { ...media, mimeType, size: file.data.length, ...(info.sha256 && !media.sha256 ? { sha256: info.sha256 } : {}), stored };
    } catch (err) {
      this.o.log?.("warn", `WhatsApp Business "${name}": media ${media.kind} not downloaded: ${(err as Error).message}`);
      return { ...media, skipped: (err as Error).message.slice(0, 200) };
    }
  }

  /** The stored media of a message, as the gateway's attachment (empty when none was kept). */
  private async attachmentsFor(name: string, wamid: string): Promise<WaBizAttachment[]> {
    const m = await this.o.store().getMessage(wamid);
    const media = m?.media;
    if (!media?.stored) return [];
    try {
      const data = await readFile(join(this.mediaDir(name), media.stored));
      const mimeType = (media.mimeType ?? "application/octet-stream").split(";")[0]!.trim();
      const kind = media.voice ? "voice" : ATTACHMENT_KIND[media.kind];
      return [{ kind, filename: media.filename ?? `${media.voice ? "voice" : media.kind}${extname(media.stored)}`, mimeType, data }];
    } catch { return []; }
  }

  /** A message's file (dashboard, MCP card): inbound downloads and outbound sends kept locally. */
  async mediaFile(name: string, messageId: string): Promise<{ data: Buffer; mimeType: string; filename: string }> {
    this.need(name);
    const m = await this.o.store().getMessage(messageId);
    if (!m || m.channel !== name || !m.media?.stored) throw new WaBizPolicyError(`No media kept for message ${messageId}`, "NOT_FOUND");
    const path = join(this.mediaDir(name), basename(m.media.stored));
    if (!existsSync(path)) throw new WaBizPolicyError(`The media of ${messageId} is no longer kept`, "NOT_FOUND");
    return { data: await readFile(path), mimeType: m.media.mimeType ?? "application/octet-stream", filename: m.media.filename ?? basename(path) };
  }

  private async routeInbound(name: string, waId: string, wamid: string, text: string, attachments: WaBizAttachment[], displayName?: string, voice?: boolean): Promise<void> {
    const store = this.o.store();
    const s = this.settings(name);
    const gateway = this.gateways.get(name);
    if (s.markRead && !wamid.startsWith("pay:")) {
      try { await this.graph(name).markRead(wamid, s.typing && !!gateway); this.typingAt.set(`${name}:${waId}`, this.now()); }
      catch (err) { this.o.log?.("warn", `WhatsApp Business "${name}": mark read failed: ${(err as Error).message}`); }
    }
    if (!gateway) {
      await store.markProcessed(`done:${name}:${wamid}`, this.iso());
      return;
    }
    const cfg = this.need(name);
    const chatId = wabizChatId(String(cfg.phoneNumberId), waId);
    const reply = await gateway.handle({
      waId, chatId, ...(displayName ? { name: displayName } : {}), text, messageId: wamid,
      ...(attachments.length ? { attachments } : {}), ...(voice ? { voice: true } : {}),
    });
    // done before the reply goes out: a crash while sending loses the reply rather than sending it twice
    await store.markProcessed(`done:${name}:${wamid}`, this.iso());
    if (reply) await this.sendGatewayReply(name, chatId, reply);
  }

  /**
   * The agent's answer: text; its reply buttons as interactive buttons (up to 3, 20 characters) or a
   * list (up to 10 rows); its files as media; a voice reply as audio. Inside the window by construction.
   */
  async sendGatewayReply(name: string, chatId: string, reply: WaBizGatewayReply): Promise<void> {
    const sentBy = this.config(name)?.gateway?.agent ?? "polpo";
    const buttons = (reply.buttons ?? []).flat().filter((b) => b.text && b.data);
    if (reply.voice) {
      await this.sendMessage(name, chatId, { type: "media", kind: "audio" }, { sentBy, file: { data: reply.voice.data, mimeType: reply.voice.mimeType, filename: reply.voice.filename } }).catch((err) => {
        this.o.log?.("warn", `WhatsApp Business "${name}": the voice reply was not sent (${(err as Error).message}); sending the text`);
      });
    }
    if (buttons.length && reply.text.trim()) {
      const body = reply.text.trim();
      const fitsButtons = buttons.length <= 3 && buttons.every((b) => b.text.length <= 20) && body.length <= 1024;
      const fitsList = buttons.length <= 10 && buttons.every((b) => b.text.length <= 24) && body.length <= 4096;
      if (fitsButtons) await this.sendMessage(name, chatId, { type: "buttons", body, buttons: buttons.map((b) => ({ id: b.data.slice(0, 256), title: b.text })) }, { sentBy });
      else if (fitsList) await this.sendMessage(name, chatId, { type: "list", body, button: "Choose", sections: [{ rows: buttons.map((b) => ({ id: b.data.slice(0, 200), title: b.text })) }] }, { sentBy });
      else await this.sendText(name, chatId, `${body}\n\n${buttons.map((b) => `• ${b.text}`).join("\n")}`, { sentBy, initiated: "reply" });
    } else if (reply.text.trim()) {
      // with a voice reply the text follows it (WhatsApp audio has no caption)
      await this.sendReply(name, chatId, reply.text);
    }
    for (const f of reply.files ?? []) {
      try {
        const data = await readFile(f.path);
        const mimeType = mimeFor(f.filename);
        const kind = mediaKindFor(mimeType);
        const fits = !mediaProblem(kind, mimeType, data.length);
        await this.sendMessage(name, chatId, { type: "media", kind: fits ? kind : "document", ...(fits && kind !== "document" ? {} : { filename: f.filename }) }, { sentBy, file: { data, mimeType, filename: f.filename } });
      } catch (err) {
        this.o.log?.("warn", `WhatsApp Business "${name}": the file ${f.filename} was not sent: ${(err as Error).message}`);
      }
    }
  }

  /** A status webhook: the message's status history, pricing and error; announced on the bus. */
  private async applyStatus(name: string, s: any): Promise<void> {
    const store = this.o.store();
    const wamid = String(s?.id ?? "");
    const status = String(s?.status ?? "");
    if (!wamid || !status) return;
    if (!(await store.markProcessed(`st:${name}:${wamid}:${status}`, this.iso()))) return; // a retried status
    const at = Number.isFinite(Number(s.timestamp)) ? new Date(Number(s.timestamp) * 1000).toISOString() : this.iso();
    const waId = normalizeWaId(String(s.recipient_id ?? s.recipient_user_id ?? ""));
    const err = Array.isArray(s.errors) && s.errors[0] ? s.errors[0] : undefined;
    const msg = (await store.getMessage(wamid)) ?? {
      id: wamid, channel: name, waId, direction: "out" as const, type: "unknown", status: "accepted" as const, statuses: [],
      createdAt: at, updatedAt: at,
    } satisfies WaBizMessage;
    msg.statuses.push({ status, at, ...(err ? { error: `${err.code ?? ""} ${err.title ?? err.message ?? ""}`.trim() } : {}) });
    if (status === "failed" || status === "deleted") msg.status = status as WaBizMessage["status"];
    else if ((STATUS_RANK[status] ?? 0) > (STATUS_RANK[msg.status] ?? 0) && msg.status !== "failed") msg.status = status as WaBizMessage["status"];
    if (s.pricing) {
      msg.pricing = {
        ...(s.pricing.category ? { category: String(s.pricing.category) } : {}), ...(s.pricing.type ? { type: String(s.pricing.type) } : {}),
        ...(typeof s.pricing.billable === "boolean" ? { billable: s.pricing.billable } : {}), ...(s.pricing.pricing_model ? { model: String(s.pricing.pricing_model) } : {}),
      };
    }
    if (err) {
      msg.error = { ...(typeof err.code === "number" ? { code: err.code } : {}), ...(err.title ? { title: String(err.title) } : {}), ...(err.error_data?.details ? { detail: String(err.error_data.details) } : {}) };
    }
    msg.updatedAt = this.iso();
    await store.saveMessage(msg);
    this.emitStatus(name, wamid, status, msg.direction, msg.waId, msg.error?.title, msg.pricing?.category);
  }

  private emitStatus(channel: string, messageId: string, status: string, direction: "in" | "out", waId?: string, error?: string, pricingCategory?: string): void {
    try {
      this.o.emit?.("channel:message-status", {
        channel, messageId, status, direction, ...(waId ? { contact: maskPhone(waId) } : {}),
        ...(error ? { error } : {}), ...(pricingCategory ? { pricingCategory } : {}),
      });
    } catch { /* listeners never change a delivery */ }
  }

  // ── Typing and read receipts ────────────────────────────────────────

  /** The typing indicator while an answer is prepared (on the contact's last message; at most every 20 s). */
  async typing(name: string, chatId: string): Promise<void> {
    if (!this.settings(name).typing) return;
    const waId = waIdFromChat(chatId);
    const key = `${name}:${waId}`;
    const last = this.typingAt.get(key) ?? 0;
    if (this.now() - last < TYPING_EVERY_MS) return;
    const contact = await this.o.store().getContact(name, waId);
    if (!contact?.lastInboundWamid || !canSendFreeForm(contact, this.now())) return;
    this.typingAt.set(key, this.now());
    await this.graph(name).markRead(contact.lastInboundWamid, true).catch(() => undefined);
  }

  /** Mark a contact's message read (blue ticks), optionally with the typing indicator. */
  async markRead(name: string, messageId: string, o: { typing?: boolean } = {}): Promise<void> {
    this.need(name);
    const m = await this.o.store().getMessage(messageId);
    if (!m || m.channel !== name || m.direction !== "in") throw new WaBizPolicyError(`No message ${messageId} from a contact on ${name}`, "NOT_FOUND");
    await this.graph(name).markRead(messageId, !!o.typing && canSendFreeForm(await this.o.store().getContact(name, m.waId), this.now()));
  }

  // ── Sending ─────────────────────────────────────────────────────────

  private async saveOutbound(name: string, waId: string, ids: string[], fields: Partial<WaBizMessage> & { type: string }): Promise<void> {
    const store = this.o.store();
    const at = this.iso();
    for (const id of ids) {
      // a status webhook may have arrived first: keep its history
      const prev = await store.getMessage(id);
      await store.saveMessage({
        ...prev, ...fields, id, channel: name, waId, direction: "out", status: prev && prev.status !== "accepted" ? prev.status : "accepted",
        statuses: [{ status: "accepted", at }, ...(prev?.statuses ?? [])], createdAt: prev?.createdAt ?? at, updatedAt: at,
      } as WaBizMessage);
      this.emitStatus(name, id, "accepted", "out", waId);
    }
  }

  /** The answer to the message that just came in (inside the window by construction). */
  async sendReply(name: string, chatId: string, text: string): Promise<string[]> {
    const waId = waIdFromChat(chatId);
    return this.sendText(name, waId, text, { sentBy: this.config(name)?.gateway?.agent ?? "polpo", initiated: "reply" });
  }

  /** The window and the block list: every free-form type goes out only inside the window, never to a blocked contact. */
  private async checkFreeForm(name: string, waId: string, what: string): Promise<void> {
    const contact = await this.o.store().getContact(name, waId);
    if (contact?.blocked) throw new WaBizPolicyError(`${maskPhone(waId)} is blocked on ${name}: unblock them first`, "BLOCKED");
    if (!canSendFreeForm(contact, this.now())) {
      throw new WaBizPolicyError(
        `${maskPhone(waId)} has not written in the last 24 hours: outside the window ${what} cannot be sent, only an approved template (wabiz_send_template)`,
        "OUTSIDE_WINDOW",
      );
    }
  }

  private outsideWindow(err: unknown, waId: string): never {
    if (err instanceof WaGraphError && err.code === WA_ERROR_OUTSIDE_WINDOW) {
      throw new WaBizPolicyError(`Meta says the 24-hour window with ${maskPhone(waId)} is closed (131047): send an approved template instead`, "OUTSIDE_WINDOW");
    }
    throw err;
  }

  /** Free-form text: only inside the 24-hour window. */
  async sendText(name: string, to: string, text: string, o: { sentBy: string; initiated?: "reply"; replyTo?: string }): Promise<string[]> {
    this.need(name);
    const waId = waIdFromChat(to);
    if (!text.trim()) throw new WaBizPolicyError("Empty message", "TEMPLATE");
    await this.checkFreeForm(name, waId, "a message");
    try {
      const ids = await this.graph(name).sendText(waId, text, { ...(o.replyTo ? { replyTo: o.replyTo } : {}) });
      await this.saveOutbound(name, waId, ids, { type: "text", initiated: "reply", sentBy: o.sentBy, text, bodyLength: text.length, ...(o.replyTo ? { context: { id: o.replyTo } } : {}) });
      return ids;
    } catch (err) {
      return this.outsideWindow(err, waId);
    }
  }

  /**
   * Any free-form message (media, location, contacts, reaction, interactive, flow, products, order
   * details…): checked against Meta's limits, only inside the window. A file is checked against
   * Meta's type and size for its kind, uploaded, and kept for the conversation view.
   */
  async sendMessage(name: string, to: string, message: WaBizOutbound, o: { sentBy: string; file?: WaBizFile }): Promise<{ status: "sent"; ids: string[] }> {
    this.need(name);
    const waId = waIdFromChat(to);
    if (!waId) throw new WaBizPolicyError("No recipient", "NOT_FOUND");
    if (message.type === "text") return { status: "sent", ids: await this.sendText(name, waId, message.text, { sentBy: o.sentBy, ...(message.replyTo ? { replyTo: message.replyTo } : {}) }) };
    const s = this.settings(name);
    await this.checkFreeForm(name, waId, message.type === "reaction" ? "a reaction" : `a ${message.type.replace(/_/g, " ")} message`);
    let msg = message;
    let stored: string | undefined;
    let fileMeta: { mimeType: string; size: number; filename: string } | undefined;
    if (message.type === "media" && o.file) {
      const problem = mediaProblem(message.kind, o.file.mimeType, o.file.data.length);
      if (problem) throw new WaBizPolicyError(problem, "INVALID");
      try {
        const mediaId = await this.graph(name).uploadMedia(o.file.data, o.file.mimeType, o.file.filename);
        msg = { ...message, mediaId, link: undefined, ...(message.kind === "document" ? { filename: message.filename ?? o.file.filename } : {}) };
      } catch (err) {
        return this.outsideWindow(err, waId);
      }
      fileMeta = { mimeType: o.file.mimeType, size: o.file.data.length, filename: o.file.filename };
    }
    let payload: Record<string, unknown>;
    try {
      payload = outboundPayload(msg, { ...(s.catalogId ? { catalogId: s.catalogId } : {}), ...(s.payments ? { payments: s.payments } : {}) });
    } catch (err) {
      if (err instanceof WaPayloadError) throw new WaBizPolicyError(err.message, "INVALID");
      throw err;
    }
    if (message.type === "reaction") {
      const target = await this.o.store().getMessage(message.messageId);
      if (!target || target.channel !== name || target.waId !== waId) throw new WaBizPolicyError(`No message ${message.messageId} in the conversation with ${maskPhone(waId)}`, "NOT_FOUND");
    }
    let id: string;
    try {
      id = await this.graph(name).sendPayload(waId, payload);
    } catch (err) {
      return this.outsideWindow(err, waId);
    }
    if (message.type === "reaction") {
      // a reaction is kept on the message it reacts to
      const store = this.o.store();
      const target = (await store.getMessage(message.messageId))!;
      const at = this.iso();
      const others = (target.reactions ?? []).filter((r) => r.by !== "business");
      target.reactions = message.emoji ? [...others, { emoji: message.emoji, by: "business", at }] : others;
      target.updatedAt = at;
      await store.saveMessage(target);
      this.emitStatus(name, message.messageId, message.emoji ? `reaction ${message.emoji}` : "reaction removed", "out", waId);
      return { status: "sent", ids: [id] };
    }
    if (fileMeta && o.file) {
      stored = `${safeName(waId)}_${safeName(id)}${extname(fileMeta.filename) || EXT[fileMeta.mimeType] || ""}`;
      try {
        mkdirSync(this.mediaDir(name), { recursive: true });
        writeFileSync(join(this.mediaDir(name), stored), o.file.data);
      } catch { stored = undefined; }
    }
    const summary = outboundSummary(message);
    const media: WaBizMedia | undefined = msg.type === "media"
      ? {
        kind: msg.kind, ...(msg.mediaId ? { mediaId: msg.mediaId } : {}), ...(msg.link ? { link: msg.link } : {}), ...(msg.caption ? { caption: msg.caption } : {}),
        ...(fileMeta ? { mimeType: fileMeta.mimeType, size: fileMeta.size } : {}), ...(msg.filename ?? fileMeta?.filename ? { filename: msg.filename ?? fileMeta?.filename } : {}),
        ...(stored ? { stored } : {}),
      }
      : undefined;
    const { replyTo, ...content } = message;
    await this.saveOutbound(name, waId, [id], {
      type: message.type === "media" ? message.kind : message.type, initiated: "reply", sentBy: o.sentBy, text: summary, bodyLength: summary.length,
      ...(media ? { media } : { content: content as Record<string, unknown> }), ...(replyTo ? { context: { id: replyTo } } : {}),
    });
    return { status: "sent", ids: [id] };
  }

  // ── Templates ───────────────────────────────────────────────────────

  private templatesFile(name: string): string { return join(this.o.polpoDir(), "whatsapp-business", `templates-${name.replace(/[^\w.-]/g, "_")}.json`); }

  /** The account's templates (synced from Meta; `refresh` syncs again). */
  async templates(name: string, o: { refresh?: boolean } = {}): Promise<{ templates: WaTemplate[]; syncedAt?: string }> {
    this.need(name);
    const file = this.templatesFile(name);
    if (!o.refresh && existsSync(file)) {
      try { return JSON.parse(readFileSync(file, "utf8")) as { templates: WaTemplate[]; syncedAt: string }; } catch { /* sync again */ }
    }
    if (!o.refresh && !existsSync(file) && !(await this.secret(name, "accessToken"))) return { templates: [] };
    const templates = await this.graph(name).listTemplates();
    const data = { templates, syncedAt: this.iso() };
    mkdirSync(join(this.o.polpoDir(), "whatsapp-business"), { recursive: true });
    writeFileSync(file, JSON.stringify(data));
    return data;
  }

  private async template(name: string, template: string, language?: string): Promise<WaTemplate> {
    let { templates } = await this.templates(name);
    let found = templates.filter((t) => t.name === template && (!language || t.language === language));
    if (!found.length) {
      ({ templates } = await this.templates(name, { refresh: true }));
      found = templates.filter((t) => t.name === template && (!language || t.language === language));
    }
    if (!found.length) throw new WaBizPolicyError(`No template "${template}"${language ? ` in ${language}` : ""} on this WhatsApp Business account (wabiz_templates lists them)`, "TEMPLATE");
    if (!language && found.length > 1) throw new WaBizPolicyError(`Template "${template}" exists in ${found.map((t) => t.language).join(", ")}: say which language`, "TEMPLATE");
    return found[0]!;
  }

  /** Every check of a business-initiated template (block, opt-out, marketing preference, template, category, caps). */
  private async checkTemplate(name: string, waId: string, template: string, language: string | undefined, input: WaBizTemplateInput, sentBy: string, o: { categories: boolean }): Promise<WaTemplate> {
    const s = this.settings(name);
    const store = this.o.store();
    const contact = await store.getContact(name, waId);
    if (contact?.blocked) throw new WaBizPolicyError(`${maskPhone(waId)} is blocked on ${name}: unblock them first`, "BLOCKED");
    if (contact?.optOut) throw new WaBizPolicyError(`${maskPhone(waId)} opted out (${contact.optOut.keyword}, ${contact.optOut.at.slice(0, 10)}): no business-initiated messages`, "OPTED_OUT");
    const t = await this.template(name, template, language);
    const status = templateStatusProblem(t);
    if (status) throw new WaBizPolicyError(status, "TEMPLATE");
    try { templateComponents(t, input); } catch (err) { throw new WaBizPolicyError((err as Error).message, "TEMPLATE"); }
    if (t.category === "MARKETING" && contact?.marketing?.value === "stop") {
      throw new WaBizPolicyError(`${maskPhone(waId)} stopped marketing messages in WhatsApp (${contact.marketing.at.slice(0, 10)}): no marketing templates`, "OPTED_OUT");
    }
    if (o.categories && !s.allowedCategories.includes(t.category as never)) {
      throw new WaBizPolicyError(`Template ${t.name} is ${t.category}: this channel allows ${s.allowedCategories.join(", ")} (business.allowedCategories)`, "CATEGORY");
    }
    const since = dayStartIso(this.now());
    const total = await store.countBusinessInitiated(name, since);
    if (total >= s.limits.businessInitiatedPerDay) {
      throw new WaBizPolicyError(`Daily cap reached: ${total}/${s.limits.businessInitiatedPerDay} business-initiated messages today (business.limits.businessInitiatedPerDay)`, "CAP_REACHED");
    }
    const perAgent = s.limits.perAgentPerDay[sentBy];
    if (perAgent !== undefined) {
      const mine = await store.countBusinessInitiated(name, since, sentBy);
      if (mine >= perAgent) throw new WaBizPolicyError(`Daily cap reached for ${sentBy}: ${mine}/${perAgent} today (business.limits.perAgentPerDay)`, "CAP_REACHED");
    }
    return t;
  }

  /**
   * A business-initiated message (an approved template, every component filled). `approval:
   * "queue"` (agents, Polpo) with business.approveTemplates waits for an operator; "direct" (an
   * operator, a notification rule set up by an admin) sends now. Every rule is checked either way.
   * `params` are the body's (legacy); `components` fills header, named body, buttons, carousel, OTP.
   */
  async sendTemplate(name: string, to: string, template: string, params: string[], o: { language?: string; sentBy: string; approval: "queue" | "direct"; categories?: boolean; reason?: string; components?: WaBizTemplateInput }): Promise<WaBizSendResult> {
    this.need(name);
    const waId = waIdFromChat(to);
    if (!waId) throw new WaBizPolicyError("No recipient", "NOT_FOUND");
    const s = this.settings(name);
    const input: WaBizTemplateInput = { ...(o.components ?? {}), ...(o.components?.body === undefined && (params.length || !o.components) ? { body: params } : {}) };
    const t = await this.checkTemplate(name, waId, template, o.language, input, o.sentBy, { categories: o.categories !== false });
    const store = this.o.store();
    const preview = templatePreview(t, input);
    if (o.approval === "queue" && s.approveTemplates) {
      const id = `pending_${this.now().toString(36)}${randomBytes(4).toString("hex")}`;
      const at = this.iso();
      await store.saveMessage({
        id, channel: name, waId, direction: "out", type: "template", initiated: "business", sentBy: o.sentBy,
        template: { name: t.name, language: t.language, category: t.category }, status: "pending_approval", text: preview, bodyLength: preview.length,
        statuses: [{ status: "pending_approval", at }],
        pending: { template: t.name, language: t.language, params: Array.isArray(input.body) ? input.body : [], requestedBy: o.sentBy, requestedAt: at, ...(o.reason ? { reason: o.reason } : {}), components: input },
        content: { components: input },
        createdAt: at, updatedAt: at,
      });
      this.emitStatus(name, id, "pending_approval", "out", waId);
      return { status: "pending_approval", id, note: `Waiting for an operator's approval (Settings → Channels → ${name}, or the API / MCP): id ${id}` };
    }
    const id = await this.graph(name).sendTemplate(waId, t, input, { marketing: s.marketingMessagesApi && t.category === "MARKETING" });
    await this.saveOutbound(name, waId, [id], {
      type: "template", initiated: "business", sentBy: o.sentBy, template: { name: t.name, language: t.language, category: t.category },
      text: preview, bodyLength: preview.length, content: { components: input },
    });
    return { status: "sent", ids: [id] };
  }

  /** Sends waiting for approval, oldest first. */
  async pending(name: string): Promise<WaBizMessage[]> {
    this.need(name);
    return (await this.o.store().listMessages(name, { status: "pending_approval", limit: 200 })).reverse();
  }

  async approve(name: string, id: string, by: string): Promise<{ id: string; sentAs: string }> {
    const store = this.o.store();
    const m = await store.getMessage(id);
    if (!m || m.channel !== name || m.status !== "pending_approval" || !m.pending) throw new WaBizPolicyError(`No send waiting for approval with id ${id}`, "NOT_FOUND");
    const input: WaBizTemplateInput = m.pending.components ?? { body: m.pending.params };
    // the rules are checked again: the contact may have opted out, the day's cap may be used up
    const t = await this.checkTemplate(name, m.waId, m.pending.template, m.pending.language, input, m.sentBy ?? "polpo", { categories: true });
    const wamid = await this.graph(name).sendTemplate(m.waId, t, input, { marketing: this.settings(name).marketingMessagesApi && t.category === "MARKETING" });
    await store.deleteMessage(id);
    const at = this.iso();
    await store.saveMessage({
      ...m, id: wamid, status: "accepted", statuses: [...m.statuses, { status: `approved by ${by}`, at }, { status: "accepted", at }],
      pending: undefined, updatedAt: at,
    });
    this.emitStatus(name, id, "approved", "out", m.waId);
    this.emitStatus(name, wamid, "accepted", "out", m.waId);
    return { id, sentAs: wamid };
  }

  async reject(name: string, id: string, by: string, reason?: string): Promise<void> {
    const store = this.o.store();
    const m = await store.getMessage(id);
    if (!m || m.channel !== name || m.status !== "pending_approval") throw new WaBizPolicyError(`No send waiting for approval with id ${id}`, "NOT_FOUND");
    const at = this.iso();
    await store.saveMessage({ ...m, status: "rejected", statuses: [...m.statuses, { status: `rejected by ${by}${reason ? `: ${reason}` : ""}`, at }], updatedAt: at });
    this.emitStatus(name, id, "rejected", "out", m.waId);
  }

  // ── Template management ─────────────────────────────────────────────

  async createTemplate(name: string, d: WaTemplateDefinition): Promise<{ id: string; status: string; category: string }> {
    this.need(name);
    if (!/^[a-z0-9_]{1,512}$/.test(d.name)) throw new WaBizPolicyError("Template names are lowercase letters, digits and underscores", "INVALID");
    if (!Array.isArray(d.components) || !d.components.some((c) => String(c.type ?? "").toUpperCase() === "BODY")) throw new WaBizPolicyError("A template needs a BODY component", "INVALID");
    const r = await this.graph(name).createTemplate(d);
    await this.templates(name, { refresh: true }).catch(() => undefined);
    return r;
  }

  async editTemplate(name: string, id: string, d: { components?: Array<Record<string, unknown>>; category?: string }): Promise<void> {
    this.need(name);
    await this.graph(name).editTemplate(id, d);
    await this.templates(name, { refresh: true }).catch(() => undefined);
  }

  async deleteTemplate(name: string, template: string, id?: string): Promise<void> {
    this.need(name);
    await this.graph(name).deleteTemplate(template, id);
    await this.templates(name, { refresh: true }).catch(() => undefined);
  }

  // ── Business profile, blocked users, phone number, analytics ────────

  async profile(name: string): Promise<WaBusinessProfile> {
    return this.graph(name).businessProfile();
  }

  async updateProfile(name: string, p: Omit<WaBusinessProfile, "profilePictureUrl">, photo?: WaBizFile): Promise<WaBusinessProfile> {
    const g = this.graph(name);
    if (p.about !== undefined && p.about.length > 139) throw new WaBizPolicyError("about: at most 139 characters", "INVALID");
    if (p.description !== undefined && p.description.length > 512) throw new WaBizPolicyError("description: at most 512 characters", "INVALID");
    if (p.address !== undefined && p.address.length > 256) throw new WaBizPolicyError("address: at most 256 characters", "INVALID");
    if (p.email !== undefined && p.email.length > 128) throw new WaBizPolicyError("email: at most 128 characters", "INVALID");
    if (p.websites !== undefined && (p.websites.length > 2 || p.websites.some((w) => !/^https?:\/\//.test(w) || w.length > 256))) throw new WaBizPolicyError("websites: at most 2, with http(s)://", "INVALID");
    let handle: string | undefined;
    if (photo) {
      const appId = this.settings(name).appId;
      if (!appId) throw new WaBizPolicyError("Set business.appId (the Meta app's id) to upload a profile photo", "NOT_CONFIGURED");
      if (!["image/jpeg", "image/png"].includes(photo.mimeType)) throw new WaBizPolicyError("The profile photo must be JPEG or PNG", "INVALID");
      if (photo.data.length > 5 * 1024 * 1024) throw new WaBizPolicyError("The profile photo can be at most 5 MB", "INVALID");
      handle = await g.resumableUpload(appId, photo.data, photo.mimeType);
    }
    await g.updateBusinessProfile({ ...p, ...(handle ? { profilePictureHandle: handle } : {}) });
    return g.businessProfile();
  }

  /** Block or unblock contacts (Meta: only people who wrote in the last 24 hours can be blocked). */
  async block(name: string, users: string[], block: boolean, by: string): Promise<{ done: string[]; failed: Array<{ user: string; error: string }> }> {
    this.need(name);
    const ids = users.map(waIdFromChat).filter(Boolean);
    if (!ids.length) throw new WaBizPolicyError("No contact to block", "NOT_FOUND");
    const r = await this.graph(name).blockUsers(ids, block);
    const store = this.o.store();
    const failed = new Set(r.failed.map((f) => normalizeWaId(f.user)));
    for (const waId of ids) {
      if (failed.has(waId)) continue;
      const c = (await store.getContact(name, waId)) ?? newContact(name, waId, this.iso());
      c.blocked = block ? { at: this.iso(), by } : null;
      c.updatedAt = this.iso();
      await store.saveContact(c);
    }
    return r;
  }

  async blocked(name: string): Promise<string[]> {
    return this.graph(name).blockedUsers();
  }

  async analytics(name: string, kind: WaAnalyticsKind, o: { start: number; end: number; granularity?: string; templateIds?: string[]; dimensions?: string[] }): Promise<unknown> {
    this.need(name);
    if (!(o.end > o.start)) throw new WaBizPolicyError("end must be after start", "INVALID");
    return this.graph(name).analytics(kind, o);
  }

  /** Phone number actions: register (with the PIN), deregister, set the two-step PIN, request and verify a code, subscribe the app. */
  async phoneAction(name: string, a: { action: "register" | "deregister" | "set_pin" | "request_code" | "verify_code" | "subscribe_app"; pin?: string; code?: string; method?: "SMS" | "VOICE"; language?: string }): Promise<void> {
    const g = this.graph(name);
    const pin = () => { if (!/^\d{6}$/.test(a.pin ?? "")) throw new WaBizPolicyError("The PIN is 6 digits", "INVALID"); return a.pin!; };
    switch (a.action) {
      case "register": return g.register(pin());
      case "deregister": return g.deregister();
      case "set_pin": return g.setTwoStepPin(pin());
      case "request_code": return g.requestCode(a.method ?? "SMS", a.language ?? "en_US");
      case "verify_code":
        if (!/^\d{4,8}$/.test(a.code ?? "")) throw new WaBizPolicyError("The verification code is digits", "INVALID");
        return g.verifyCode(a.code!);
      case "subscribe_app": return g.subscribeApp();
      default: throw new WaBizPolicyError(`Unknown phone action ${String((a as { action?: unknown }).action)}`, "INVALID");
    }
  }

  /** This number's callback at Meta: the app's, or an override to this instance (one app shared by several instances). */
  async webhookOverride(name: string, set?: boolean): Promise<{ callbackUrl?: string; current: Awaited<ReturnType<WaGraphClient["webhookConfiguration"]>> }> {
    const g = this.graph(name);
    if (set === true) {
      const url = this.callbackUrl(name);
      if (!url) throw new WaBizPolicyError("POLPO_PUBLIC_URL is not set: Meta needs this instance's public HTTPS callback", "NOT_CONFIGURED");
      const token = await this.secret(name, "verifyToken");
      if (!token) throw new WaBizPolicyError("Set (or generate) the verify token first", "NOT_CONFIGURED");
      await g.setWebhookOverride(url, token);
    } else if (set === false) {
      const token = (await this.secret(name, "verifyToken")) ?? "";
      await g.setWebhookOverride("", token);
    }
    const url = this.callbackUrl(name);
    return { ...(url ? { callbackUrl: url } : {}), current: await g.webhookConfiguration() };
  }

  // ── Notifications (rules, conversation pipe) ────────────────────────

  /** Who a notification goes to: the pipe's chat, else the operators. */
  private recipients(name: string, n: Notification): string[] {
    const chat = (n.sourceData as { chatId?: unknown } | undefined)?.chatId;
    if (typeof chat === "string" && chat) return [waIdFromChat(chat)];
    const cfg = this.need(name);
    if (cfg.chatId) return [waIdFromChat(cfg.chatId)];
    return this.settings(name).operators;
  }

  async notify(name: string, n: Notification): Promise<void> {
    const to = this.recipients(name, n);
    if (!to.length) throw new Error(`WhatsApp Business "${name}": nobody to notify (business.operators is empty)`);
    const s = this.settings(name);
    const errors: string[] = [];
    for (const waId of to) {
      try {
        const contact = await this.o.store().getContact(name, waId);
        if (canSendFreeForm(contact, this.now())) {
          await this.sendText(name, waId, `*${n.title}*\n\n${n.body}`, { sentBy: "notification" });
        } else if (s.outsideWindow === "template" && s.notificationTemplate) {
          const nt = s.notificationTemplate;
          const fill = (p: string) => p.replace(/\{(title|body|severity|event)\}/g, (_m, k: string) =>
            String(k === "title" ? n.title : k === "body" ? n.body : k === "severity" ? n.severity : n.sourceEvent)).replace(/\s*\n\s*/g, " ").slice(0, 1000);
          await this.sendTemplate(name, waId, nt.name, (nt.bodyParams ?? []).map(fill), { language: nt.language, sentBy: "notification", approval: "direct", categories: false });
        } else {
          throw new WaBizPolicyError(`${maskPhone(waId)} is outside the 24-hour window (business.outsideWindow is fail)`, "OUTSIDE_WINDOW");
        }
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }
    }
    if (errors.length === to.length) throw new Error(errors.join("; "));
    if (errors.length) this.o.log?.("warn", `WhatsApp Business "${name}": notification not delivered to everyone: ${errors.join("; ")}`);
  }

  /** The phone number at Meta (and the token works). */
  async test(name: string): Promise<boolean> {
    const info = await this.graph(name).phoneInfo();
    this.phoneInfo.set(name, { ...info, checkedAt: this.iso() });
    return true;
  }

  async testDetails(name: string): Promise<WaPhoneInfo & { checkedAt: string }> {
    await this.test(name);
    return this.phoneInfo.get(name)!;
  }

  // ── Reads ───────────────────────────────────────────────────────────

  async status(name: string): Promise<WaBizChannelStatus> {
    const cfg = this.need(name);
    const s = this.settings(name);
    const secrets = await this.secretsSet(name);
    const missing = [
      ...(!cfg.phoneNumberId ? ["phoneNumberId"] : []), ...(!cfg.wabaId ? ["wabaId"] : []),
      ...WABIZ_SECRET_KINDS.filter((k) => !secrets[k]),
      ...(s.audience === "customers" && cfg.gateway?.enableInbound && !cfg.gateway.agent ? ["gateway.agent"] : []),
    ];
    const all = this.log.all(name);
    const { counts } = this.log.counts(name);
    const lastDelivery = all.find((e) => e.eventType !== "verify" && e.outcome !== "rejected");
    const lastError = all.find((e) => e.outcome === "rejected" || e.outcome === "error");
    const recent = !!lastDelivery && this.now() - Date.parse(lastDelivery.receivedAt) < WABIZ_WINDOW_MS;
    const state = missing.length ? "not-configured" : recent ? "receiving" : "configured";
    const store = this.o.store();
    const tfile = this.templatesFile(name);
    let templates: WaBizChannelStatus["templates"];
    try {
      if (existsSync(tfile)) {
        const d = JSON.parse(readFileSync(tfile, "utf8")) as { templates: WaTemplate[]; syncedAt: string };
        templates = { count: d.templates.length, approved: d.templates.filter((t) => t.status === "APPROVED").length, syncedAt: d.syncedAt };
      }
    } catch { /* not synced */ }
    const inst = this.o.instance?.() ?? {};
    // the instance's name is the public URL's first path segment (https://host.ts.net/<instance>)
    if (!inst.name) {
      try { inst.name = new URL(this.o.publicBase?.() ?? "").pathname.split("/").filter(Boolean)[0]; } catch { /* no public URL */ }
    }
    const url = this.callbackUrl(name);
    const phone = this.phoneInfo.get(name);
    const lastAccount = (() => { try { return this.accountEvents(name, 1)[0]; } catch { return undefined; } })();
    return {
      channel: name,
      ...(cfg.phoneNumberId ? { phoneNumberId: String(cfg.phoneNumberId) } : {}),
      ...(cfg.wabaId ? { wabaId: String(cfg.wabaId) } : {}),
      graphApiVersion: cfg.graphApiVersion || "v23.0",
      audience: s.audience,
      ...(cfg.gateway?.agent ? { agent: cfg.gateway.agent } : {}),
      inbound: !!cfg.gateway?.enableInbound,
      secrets, state, missing,
      ...(url ? { callbackUrl: url } : {}),
      funnelCommand: wabizFunnelCommand(inst.name, inst.port),
      note: WABIZ_FUNNEL_NOTE,
      ...(lastDelivery ? { lastEventAt: lastDelivery.receivedAt } : {}),
      ...(lastError && (!lastDelivery || lastError.receivedAt > lastDelivery.receivedAt) ? { lastError: lastError.reason ?? lastError.outcome } : {}),
      counts,
      inbox: this.inboxCount(name),
      pendingApprovals: (await store.listMessages(name, { status: "pending_approval", limit: 500 })).length,
      sentToday: await store.countBusinessInitiated(name, dayStartIso(this.now())),
      limits: s.limits,
      ...(phone ? { phone } : {}),
      ...(templates ? { templates } : {}),
      capabilities: {
        media: s.media, ...(s.catalogId ? { catalogId: s.catalogId } : {}), ...(s.payments ? { payments: { market: s.payments.market } } : {}),
        marketingMessagesApi: s.marketingMessagesApi, profilePhoto: !!s.appId, sharedRoutes: Object.keys(s.sharedRoutes),
      },
      ...(lastAccount ? { lastAccountEvent: { field: lastAccount.field, summary: lastAccount.summary, at: lastAccount.at } } : {}),
    };
  }

  events(name: string, o: { limit?: number; cursor?: string; outcomes?: readonly WebhookEventOutcome[] } = {}): WebhookEventPage<WaBizWebhookEventSummary> {
    this.need(name);
    return this.log.list(name, o);
  }

  event(name: string, id: string): WaBizWebhookEvent | undefined {
    this.need(name);
    return this.log.get(name, id);
  }

  async contacts(name: string, limit = 100): Promise<Array<WaBizContact & { window: { open: boolean; closesAt?: string } }>> {
    this.need(name);
    const now = this.now();
    return (await this.o.store().listContacts(name, { limit })).map((c) => ({ ...c, window: { open: canSendFreeForm(c, now), ...(windowClosesAt(c, now) ? { closesAt: windowClosesAt(c, now) } : {}) } }));
  }

  async conversation(name: string, to: string, limit = 50): Promise<WaBizConversation> {
    this.need(name);
    const waId = waIdFromChat(to);
    const store = this.o.store();
    const contact = (await store.getContact(name, waId)) ?? newContact(name, waId, this.iso());
    const now = this.now();
    const closesAt = windowClosesAt(contact, now);
    return {
      contact: { ...contact, ...(isPhoneWaId(waId) ? { masked: maskPhone(waId) } : {}) },
      window: { open: canSendFreeForm(contact, now), ...(closesAt ? { closesAt } : {}) },
      optedOut: !!contact.optOut,
      messages: await store.listMessages(name, { waId, limit }),
    };
  }

  async setOptIn(name: string, to: string, optIn: boolean, source: string): Promise<WaBizContact> {
    this.need(name);
    const waId = waIdFromChat(to);
    const store = this.o.store();
    const c = (await store.getContact(name, waId)) ?? newContact(name, waId, this.iso());
    if (optIn) { c.optIn = { at: this.iso(), source }; c.optOut = null; }
    else { c.optIn = null; c.optOut = { at: this.iso(), keyword: source }; }
    c.updatedAt = this.iso();
    await store.saveContact(c);
    return c;
  }

  async deleteContact(name: string, to: string): Promise<boolean> {
    this.need(name);
    const waId = waIdFromChat(to);
    // the contact's files go with it
    try {
      const dir = this.mediaDir(name);
      for (const f of readdirSync(dir)) if (f.startsWith(`${safeName(waId)}_`)) rmSync(join(dir, f), { force: true });
    } catch { /* no media */ }
    return this.o.store().deleteContact(name, waId);
  }

  /** Retention: messages and media files older than retentionDays, processed keys older than 7 days. */
  async purge(): Promise<{ messages: number; contacts: number; processed: number; files: number }> {
    const store = this.o.store();
    let messages = 0;
    let contacts = 0;
    let files = 0;
    for (const name of this.channelNames()) {
      const days = this.settings(name).retentionDays;
      const before = this.now() - days * 24 * 3_600_000;
      const r = await store.purge(name, new Date(before).toISOString());
      messages += r.messages; contacts += r.contacts;
      try {
        const dir = this.mediaDir(name);
        for (const f of readdirSync(dir)) {
          const p = join(dir, f);
          if (statSync(p).mtimeMs < before) { rmSync(p, { force: true }); files++; }
        }
      } catch { /* no media */ }
    }
    const processed = await store.purgeProcessed(new Date(this.now() - WABIZ_PROCESSED_TTL_MS).toISOString());
    return { messages, contacts, processed, files };
  }
}

function eventData(e: WaBizInboundEvent): Record<string, unknown> {
  return e.data;
}

const MIME: Record<string, string> = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif", ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg", ".opus": "audio/ogg", ".m4a": "audio/mp4", ".aac": "audio/aac", ".amr": "audio/amr", ".mp4": "video/mp4", ".3gp": "video/3gpp",
  ".pdf": "application/pdf", ".txt": "text/plain", ".csv": "text/csv", ".json": "application/json",
  ".doc": "application/msword", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint", ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

/** A file's type from its name (what agents' files go out as). */
export function mimeFor(filename: string): string {
  return MIME[extname(filename).toLowerCase()] ?? "application/octet-stream";
}

/** One line for an account-level webhook. */
function accountSummary(field: string, v: Record<string, any>): string {
  switch (field) {
    case "phone_number_quality_update": return `${v.display_phone_number ?? "the number"}: ${v.event ?? "quality changed"}${v.current_limit ? `, limit ${v.current_limit}` : ""}`;
    case "phone_number_name_update": return `${v.display_phone_number ?? "the number"}: display name "${v.requested_verified_name ?? ""}" ${v.decision ?? ""}${v.rejection_reason && v.rejection_reason !== "NONE" ? ` (${v.rejection_reason})` : ""}`.trim();
    case "message_template_status_update": return `template ${v.message_template_name ?? v.message_template_id ?? ""} (${v.message_template_language ?? ""}): ${v.event ?? ""}${v.reason && v.reason !== "NONE" ? ` (${v.reason})` : ""}`;
    case "message_template_quality_update": return `template ${v.message_template_name ?? v.message_template_id ?? ""}: quality ${v.previous_quality_score ?? "?"} → ${v.new_quality_score ?? "?"}`;
    case "template_category_update": return `template ${v.message_template_name ?? v.message_template_id ?? ""}: category ${v.previous_category ?? "?"} → ${v.new_category ?? "?"}`;
    case "account_update": return `${v.event ?? "account updated"}${v.ban_info?.waba_ban_state ? ` (${v.ban_info.waba_ban_state})` : ""}`;
    case "business_capability_update": return `capabilities: ${Object.entries(v).filter(([k]) => k !== "messaging_product").map(([k, x]) => `${k} ${typeof x === "object" ? JSON.stringify(x) : String(x)}`).join(", ")}`;
    case "account_alerts": return `${v.alert_severity ?? ""} ${v.alert_type ?? ""}: ${v.alert_description ?? ""}`.trim();
    case "account_review_update": return `account review: ${v.decision ?? ""}`;
    case "security": return `security: ${v.event ?? ""}`;
    default: return field;
  }
}

/** What a delivery carries, for the event log (no text, contacts masked). */
function describeDelivery(body: any): { fields: string[]; phoneNumberIds: string[]; messages: number; statuses: number; items: NonNullable<WaBizWebhookEvent["items"]> } {
  const fields = new Set<string>();
  const ids = new Set<string>();
  const items: NonNullable<WaBizWebhookEvent["items"]> = [];
  let messages = 0;
  let statuses = 0;
  for (const entry of Array.isArray(body?.entry) ? body.entry : []) {
    for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
      if (typeof change?.field === "string") fields.add(change.field.slice(0, 60));
      const v = change?.value ?? {};
      if (v?.metadata?.phone_number_id) ids.add(String(v.metadata.phone_number_id));
      for (const m of Array.isArray(v.messages) ? v.messages : []) {
        messages++;
        if (items.length < 20) {
          const t = parseInbound(m);
          items.push({ kind: "message", ...(m?.id ? { wamid: String(m.id) } : {}), type: t.type, ...(t.text ? { length: t.text.length } : {}), ...(m?.from ? { contact: maskPhone(normalizeWaId(String(m.from))) } : {}) });
        }
      }
      for (const s of Array.isArray(v.statuses) ? v.statuses : []) {
        statuses++;
        if (items.length < 20) {
          const e = Array.isArray(s?.errors) ? s.errors[0] : undefined;
          items.push({ kind: "status", ...(s?.id ? { wamid: String(s.id) } : {}), ...(s?.status ? { status: String(s.status) } : {}), ...(s?.type ? { type: String(s.type) } : {}), ...(s?.recipient_id ? { contact: maskPhone(normalizeWaId(String(s.recipient_id))) } : {}), ...(e ? { error: `${e.code ?? ""} ${e.title ?? ""}`.trim() } : {}) });
        }
      }
    }
  }
  return { fields: [...fields], phoneNumberIds: [...ids], messages, statuses, items };
}

// ── One service per instance ──────────────────────────────────────────

const services = new Map<string, WaBusinessService>();

export function registerWaBusinessService(polpoDir: string, service: WaBusinessService | undefined): void {
  const prev = services.get(polpoDir);
  if (prev && prev !== service) prev.dispose();
  if (service) services.set(polpoDir, service);
  else services.delete(polpoDir);
}

export function waBusinessServiceFor(polpoDir: string | undefined): WaBusinessService | undefined {
  return polpoDir ? services.get(polpoDir) : undefined;
}

export type { WaBizMediaKind };
