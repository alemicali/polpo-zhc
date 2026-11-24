/**
 * WhatsApp Business (Meta Cloud API) channels of an instance: the webhook, the persisted inbox, the
 * rules for sending, templates, approvals and retention. One service per instance (.polpo
 * directory); the orchestrator gives it each channel's gateway, the server its routes, the
 * notification router its channels, the tools their sends.
 *
 * Webhook (public, GET/POST /api/v1/channels/whatsapp-business/webhooks/:name):
 * - GET: Meta's verification (hub.mode=subscribe, hub.verify_token compared in constant time) →
 *   hub.challenge as text/plain.
 * - POST: X-Hub-Signature-256 = sha256=HMAC-SHA256(app secret, raw body bytes), compared in
 *   constant time; 1 MB at most; rate limited per channel. A delivery for another phone number
 *   is ignored. Accepted deliveries are written to the inbox (.polpo/whatsapp-business-inbox/<channel>/)
 *   before Meta gets its 200, then processed in order: nothing is lost across a restart (the inbox
 *   is drained at start) and nothing is handled twice (processed keys in the store, kept 7 days:
 *   `in:<wamid>` once the message is stored, `done:<wamid>` once the agent answered it,
 *   `st:<wamid>:<status>` per status).
 * - Every delivery is in the channel's event log (.polpo/whatsapp-business-events/<channel>.json,
 *   capped): outcome, signature, what came in — message types and lengths, contacts masked,
 *   never a message's text.
 *
 * Sending (every path but a reply to the message that just came in checks the window):
 * - free-form text only inside the 24-hour window the contact's last message opened (Meta's
 *   131047 is handled too);
 * - business-initiated messages only as approved templates of an allowed category, never to a
 *   contact who opted out, within the daily caps; sent by agents or Polpo they wait for an
 *   operator's approval (business.approveTemplates, default on).
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  WABIZ_PROCESSED_TTL_MS, WABIZ_SECRET_KINDS, WABIZ_SECRET_REF_FIELD, WABIZ_VAULT_OWNER, WABIZ_WINDOW_MS,
  canSendFreeForm, dayStartIso, isPhoneWaId, maskPhone, newContact, normalizeWaId, optInKeyword, optOutKeyword,
  resolveWaBusinessSettings, wabizChatId, wabizVaultService, waIdFromChat, windowClosesAt,
  type ResolvedWaBusinessSettings, type WaBizContact, type WaBizMessage, type WaBizSecretKind, type WaBusinessStore,
} from "@polpo-ai/core/whatsapp-business";
import type { NotificationChannelConfig, PolpoEventMap, VaultStore } from "@polpo-ai/core";
import { CappedWebhookEventLog, type WebhookEventBase, type WebhookEventOutcome, type WebhookEventPage } from "../core/webhook-event-log.js";
import type { Notification } from "./types.js";
import {
  WA_ERROR_OUTSIDE_WINDOW, WaGraphClient, WaGraphError, templateProblem,
  type WaPhoneInfo, type WaTemplate, type WaBusinessNotifier,
} from "./channels/whatsapp-business.js";

export const WABIZ_WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;
/** Deliveries per minute per channel (Meta batches; bursts beyond this are refused and retried by Meta). */
export const WABIZ_WEBHOOK_RATE_PER_MINUTE = 600;
export const WABIZ_EVENTS_MAX = 300;
/** An inbox delivery that keeps failing is moved aside after this many attempts. */
const INBOX_MAX_ATTEMPTS = 5;
const TYPING_EVERY_MS = 20_000;
const PURGE_EVERY_MS = 6 * 3_600_000;

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

/** A send refused by a rule (window, opt-out, cap, template): the reason is for the caller. */
export class WaBizPolicyError extends Error {
  constructor(message: string, readonly code: "OUTSIDE_WINDOW" | "OPTED_OUT" | "CAP_REACHED" | "TEMPLATE" | "NOT_CONFIGURED" | "NOT_FOUND" | "CATEGORY") {
    super(message);
    this.name = "WaBizPolicyError";
  }
}

/** The gateway of one channel, as the orchestrator gives it. */
export interface WaBizGatewayHandle {
  handle(input: { waId: string; chatId: string; name?: string; text: string; messageId: string }): Promise<{ text: string } | undefined>;
}

export interface WaBusinessServiceOptions {
  polpoDir: () => string;
  channels: () => Record<string, NotificationChannelConfig>;
  store: () => WaBusinessStore;
  vault: () => VaultStore | undefined | null;
  emit?: <K extends "channel:message-status" | "channel:webhook">(event: K, payload: PolpoEventMap[K]) => void;
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

const PLACEHOLDER: Record<string, string> = {
  image: "[immagine]", video: "[video]", audio: "[audio]", voice: "[messaggio vocale]", document: "[documento]",
  sticker: "[sticker]", location: "[posizione]", contacts: "[contatto]", order: "[ordine]", system: "[messaggio di sistema]",
};

/** The text of an inbound message: text, interactive and button replies as text, a placeholder for the rest (MVP). */
export function inboundText(m: any): { text: string; type: string } | undefined {
  const type = String(m?.type ?? "unknown");
  if (type === "text") return { text: String(m.text?.body ?? ""), type };
  if (type === "interactive") {
    const r = m.interactive?.button_reply ?? m.interactive?.list_reply ?? m.interactive?.nfm_reply;
    const t = [r?.title, r?.description].filter((x) => typeof x === "string" && x).join(" — ");
    return { text: t || "[risposta interattiva]", type };
  }
  if (type === "button") return { text: String(m.button?.text ?? m.button?.payload ?? "[pulsante]"), type };
  if (type === "reaction") return undefined; // a reaction is not a message to answer
  if (type === "audio" && m.audio?.voice) return { text: PLACEHOLDER.voice!, type };
  const caption = m?.[type]?.caption;
  return { text: `${PLACEHOLDER[type] ?? "[messaggio non supportato]"}${typeof caption === "string" && caption ? ` ${caption}` : ""}`, type };
}

const STATUS_RANK: Record<string, number> = { accepted: 1, sent: 2, delivered: 3, read: 4 };

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
  async receive(name: string, raw: Buffer, signatureHeader: string | undefined | null): Promise<{ status: 200 | 400 | 401 | 404 | 413 | 429 | 500 | 503; body: Record<string, unknown> }> {
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
      if (d.fields.includes("message_template_status_update") || d.fields.includes("message_template_quality_update")) {
        void this.templates(name, { refresh: true }).catch(() => undefined);
      }
      if (!mine) {
        const why = d.phoneNumberIds.length ? `For another phone number (${d.phoneNumberIds.join(", ")})` : `No message or status in it (${d.fields.join(", ") || "no field"})`;
        this.record(name, { ...base, outcome: "ignored", reason: why, action: d.fields.some((f) => f.startsWith("message_template")) ? "Templates refreshed" : "Nothing" });
        return { status: 200, body: { ok: true, ignored: true } };
      }
      const rec = this.record(name, { ...base, outcome: "accepted", action: `Queued: ${d.messages} message(s), ${d.statuses} status(es)` });
      this.enqueue({ id: rec.id, channel: name, receivedAt: rec.receivedAt, eventId: rec.id, attempts: 0, body: raw.toString("utf8") });
      void this.drain();
      return { status: 200, body: { ok: true } };
    } catch (err) {
      this.record(name, { t0, outcome: "error", httpStatus: 500, signature: "not-checked", bytes, reason: `Internal error: ${(err as Error).message}` });
      return { status: 500, body: { ok: false, error: "Internal error" } };
    }
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
        for (const s of Array.isArray(v.statuses) ? v.statuses : []) await this.applyStatus(item.channel, s);
        const contacts: any[] = Array.isArray(v.contacts) ? v.contacts : [];
        for (const m of Array.isArray(v.messages) ? v.messages : []) {
          const wamid = String(m?.id ?? "");
          if (!wamid) continue;
          const c = contacts.find((x) => x?.wa_id === m.from || x?.user_id === m.from) ?? contacts[0];
          const waId = normalizeWaId(String(m.from ?? c?.wa_id ?? c?.user_id ?? ""));
          if (!waId) continue;
          const extracted = inboundText(m);
          const stored = await this.storeInbound(item.channel, waId, wamid, m, c, extracted);
          if (!extracted || !stored.route) {
            await store.markProcessed(`done:${item.channel}:${wamid}`, this.iso());
            continue;
          }
          // done (a retry or a restart) or being answered right now (the same message in two deliveries)
          const routing = `${item.channel}:${wamid}`;
          if (this.routing.has(routing) || await store.isProcessed(`done:${item.channel}:${wamid}`)) continue;
          this.routing.add(routing);
          replies.push(this.inChatOrder(`${item.channel}:${waId}`, () => this.routeInbound(item.channel, waId, wamid, extracted.text, stored.name))
            .finally(() => this.routing.delete(routing)));
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
  private async storeInbound(name: string, waId: string, wamid: string, m: any, c: any, extracted: { text: string; type: string } | undefined): Promise<{ route: boolean; name?: string }> {
    const store = this.o.store();
    const at = Number.isFinite(Number(m.timestamp)) ? new Date(Number(m.timestamp) * 1000).toISOString() : this.iso();
    const contact = (await store.getContact(name, waId)) ?? newContact(name, waId, this.iso());
    const displayName = typeof c?.profile?.name === "string" ? c.profile.name : contact.name;
    const optOut = extracted && extracted.type === "text" ? optOutKeyword(extracted.text) : undefined;
    const optIn = extracted && extracted.type === "text" ? optInKeyword(extracted.text) : undefined;
    if (!(await store.isProcessed(`in:${name}:${wamid}`))) {
      if (!contact.lastInboundAt || contact.lastInboundAt <= at) {
        contact.lastInboundAt = at;
        contact.lastInboundWamid = wamid;
      }
      if (displayName) contact.name = displayName;
      if (typeof c?.user_id === "string" && c.user_id) contact.userId = c.user_id;
      if (optOut) contact.optOut = { at, keyword: optOut };
      if (optIn) { contact.optOut = null; contact.optIn = { at, source: `keyword:${optIn}` }; }
      contact.updatedAt = this.iso();
      await store.saveContact(contact);
      if (extracted) {
        await store.saveMessage({
          id: wamid, channel: name, waId, direction: "in", type: extracted.type, text: extracted.text, bodyLength: extracted.text.length,
          status: "received", statuses: [{ status: "received", at }], createdAt: at, updatedAt: this.iso(),
        });
        this.emitStatus(name, wamid, "received", "in", waId);
      }
      await store.markProcessed(`in:${name}:${wamid}`, this.iso());
      if (optOut) this.o.log?.("info", `WhatsApp Business "${name}": ${maskPhone(waId)} opted out (${optOut})`);
    }
    // an opt-out or opt-in keyword is not a message for the agent
    return { route: !optOut && !optIn, ...(displayName ? { name: displayName } : {}) };
  }

  private async routeInbound(name: string, waId: string, wamid: string, text: string, displayName?: string): Promise<void> {
    const store = this.o.store();
    const s = this.settings(name);
    const gateway = this.gateways.get(name);
    if (s.markRead) {
      try { await this.graph(name).markRead(wamid, s.typing && !!gateway); this.typingAt.set(`${name}:${waId}`, this.now()); }
      catch (err) { this.o.log?.("warn", `WhatsApp Business "${name}": mark read failed: ${(err as Error).message}`); }
    }
    if (!gateway) {
      await store.markProcessed(`done:${name}:${wamid}`, this.iso());
      return;
    }
    const cfg = this.need(name);
    const chatId = wabizChatId(String(cfg.phoneNumberId), waId);
    const reply = await gateway.handle({ waId, chatId, ...(displayName ? { name: displayName } : {}), text, messageId: wamid });
    // done before the reply goes out: a crash while sending loses the reply rather than sending it twice
    await store.markProcessed(`done:${name}:${wamid}`, this.iso());
    if (reply?.text?.trim()) await this.sendReply(name, chatId, reply.text);
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

  // ── Typing ──────────────────────────────────────────────────────────

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

  /** Free-form text: only inside the 24-hour window. */
  async sendText(name: string, to: string, text: string, o: { sentBy: string; initiated?: "reply" }): Promise<string[]> {
    this.need(name);
    const waId = waIdFromChat(to);
    if (!text.trim()) throw new WaBizPolicyError("Empty message", "TEMPLATE");
    const store = this.o.store();
    const contact = await store.getContact(name, waId);
    if (!canSendFreeForm(contact, this.now())) {
      throw new WaBizPolicyError(
        `${maskPhone(waId)} has not written in the last 24 hours: outside the window only an approved template can be sent (wabiz_send_template)`,
        "OUTSIDE_WINDOW",
      );
    }
    try {
      const ids = await this.graph(name).sendText(waId, text);
      await this.saveOutbound(name, waId, ids, { type: "text", initiated: "reply", sentBy: o.sentBy, text, bodyLength: text.length });
      return ids;
    } catch (err) {
      if (err instanceof WaGraphError && err.code === WA_ERROR_OUTSIDE_WINDOW) {
        throw new WaBizPolicyError(`Meta says the 24-hour window with ${maskPhone(waId)} is closed (131047): send an approved template instead`, "OUTSIDE_WINDOW");
      }
      throw err;
    }
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

  /** Every check of a business-initiated template (opt-out, template, category, caps). */
  private async checkTemplate(name: string, waId: string, template: string, language: string | undefined, params: string[], sentBy: string, o: { categories: boolean }): Promise<WaTemplate> {
    const s = this.settings(name);
    const store = this.o.store();
    const contact = await store.getContact(name, waId);
    if (contact?.optOut) throw new WaBizPolicyError(`${maskPhone(waId)} opted out (${contact.optOut.keyword}, ${contact.optOut.at.slice(0, 10)}): no business-initiated messages`, "OPTED_OUT");
    const t = await this.template(name, template, language);
    const problem = templateProblem(t, params);
    if (problem) throw new WaBizPolicyError(problem, "TEMPLATE");
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
   * A business-initiated message (an approved template). `approval: "queue"` (agents, Polpo) with
   * business.approveTemplates waits for an operator; "direct" (an operator, a notification rule
   * set up by an admin) sends now. Every rule is checked either way.
   */
  async sendTemplate(name: string, to: string, template: string, params: string[], o: { language?: string; sentBy: string; approval: "queue" | "direct"; categories?: boolean; reason?: string }): Promise<WaBizSendResult> {
    this.need(name);
    const waId = waIdFromChat(to);
    if (!waId) throw new WaBizPolicyError("No recipient", "NOT_FOUND");
    const s = this.settings(name);
    const t = await this.checkTemplate(name, waId, template, o.language, params, o.sentBy, { categories: o.categories !== false });
    const store = this.o.store();
    if (o.approval === "queue" && s.approveTemplates) {
      const id = `pending_${this.now().toString(36)}${randomBytes(4).toString("hex")}`;
      const at = this.iso();
      await store.saveMessage({
        id, channel: name, waId, direction: "out", type: "template", initiated: "business", sentBy: o.sentBy,
        template: { name: t.name, language: t.language, category: t.category }, status: "pending_approval",
        statuses: [{ status: "pending_approval", at }],
        pending: { template: t.name, language: t.language, params, requestedBy: o.sentBy, requestedAt: at, ...(o.reason ? { reason: o.reason } : {}) },
        createdAt: at, updatedAt: at,
      });
      this.emitStatus(name, id, "pending_approval", "out", waId);
      return { status: "pending_approval", id, note: `Waiting for an operator's approval (Settings → Channels → ${name}, or the API / MCP): id ${id}` };
    }
    const id = await this.graph(name).sendTemplate(waId, t, params);
    await this.saveOutbound(name, waId, [id], {
      type: "template", initiated: "business", sentBy: o.sentBy, template: { name: t.name, language: t.language, category: t.category },
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
    // the rules are checked again: the contact may have opted out, the day's cap may be used up
    const t = await this.checkTemplate(name, m.waId, m.pending.template, m.pending.language, m.pending.params, m.sentBy ?? "polpo", { categories: true });
    const wamid = await this.graph(name).sendTemplate(m.waId, t, m.pending.params);
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
    return this.o.store().deleteContact(name, waIdFromChat(to));
  }

  /** Retention: messages older than retentionDays, processed keys older than 7 days. */
  async purge(): Promise<{ messages: number; contacts: number; processed: number }> {
    const store = this.o.store();
    let messages = 0;
    let contacts = 0;
    for (const name of this.channelNames()) {
      const days = this.settings(name).retentionDays;
      const r = await store.purge(name, new Date(this.now() - days * 24 * 3_600_000).toISOString());
      messages += r.messages; contacts += r.contacts;
    }
    const processed = await store.purgeProcessed(new Date(this.now() - WABIZ_PROCESSED_TTL_MS).toISOString());
    return { messages, contacts, processed };
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
          const t = inboundText(m);
          items.push({ kind: "message", ...(m?.id ? { wamid: String(m.id) } : {}), type: String(m?.type ?? "unknown"), ...(t ? { length: t.text.length } : {}), ...(m?.from ? { contact: maskPhone(normalizeWaId(String(m.from))) } : {}) });
        }
      }
      for (const s of Array.isArray(v.statuses) ? v.statuses : []) {
        statuses++;
        if (items.length < 20) {
          const e = Array.isArray(s?.errors) ? s.errors[0] : undefined;
          items.push({ kind: "status", ...(s?.id ? { wamid: String(s.id) } : {}), ...(s?.status ? { status: String(s.status) } : {}), ...(s?.recipient_id ? { contact: maskPhone(normalizeWaId(String(s.recipient_id))) } : {}), ...(e ? { error: `${e.code ?? ""} ${e.title ?? ""}`.trim() } : {}) });
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
