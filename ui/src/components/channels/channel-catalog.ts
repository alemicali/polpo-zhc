/**
 * Channels as a catalog, like the Connectors page: what each channel type is (label, one line,
 * badges), a configured channel's state and its at-a-glance facts, and the search over both.
 * Pure: the Channels section, its detail sheet and the tests use it.
 */
import type { NotificationChannelConfig, NotificationChannelType } from "@polpo-ai/react";

/** A channel type in the "Add channel" catalog. */
export interface ChannelCatalogEntry {
  type: NotificationChannelType;
  label: string;
  /** One line under the name. */
  description: string;
  /** How it connects: "Official", "Unofficial (QR)"… */
  kind: string;
  /** People can write to Polpo through it (inbound gateway). */
  inbound: boolean;
  /** Words the search also matches. */
  keywords?: string[];
}

export const CHANNEL_CATALOG: ChannelCatalogEntry[] = [
  { type: "telegram", label: "Telegram", kind: "Official bot", inbound: true, keywords: ["bot", "botfather", "chat"],
    description: "A Telegram bot: notifications to a chat, and people talk to Polpo or a dedicated agent." },
  { type: "whatsapp", label: "WhatsApp", kind: "Unofficial (QR)", inbound: true, keywords: ["qr", "linked device", "web"],
    description: "Link this server as a WhatsApp device with a QR code: notifications and chats from a trusted number." },
  { type: "whatsapp-business", label: "WhatsApp Business", kind: "Official", inbound: true, keywords: ["meta", "cloud api", "customers", "templates"],
    description: "Your business number on Meta's Cloud API: customers write to an agent, templates for messages you start." },
  { type: "slack", label: "Slack", kind: "Webhook", inbound: false, keywords: ["incoming webhook"],
    description: "Post notifications to a Slack channel through an incoming webhook." },
  { type: "email", label: "Email", kind: "Resend · SendGrid · SMTP", inbound: false, keywords: ["mail", "smtp", "resend", "sendgrid"],
    description: "Send notifications by email through Resend, SendGrid or your SMTP server." },
  { type: "webhook", label: "Webhook", kind: "HTTP", inbound: true, keywords: ["http", "shortcuts", "api", "curl"],
    description: "HTTP in and out: talk to Polpo from Shortcuts or scripts, POST notifications to any endpoint." },
  { type: "push", label: "Push", kind: "Browser (PWA)", inbound: false, keywords: ["pwa", "browser", "notification"],
    description: "Push notifications to the browsers that subscribe to this instance." },
];

const BY_TYPE = new Map(CHANNEL_CATALOG.map((e) => [e.type as string, e]));

/** The catalog entry of a type; a generic one for types the dashboard does not know (voice, expo-push…). */
export function channelEntry(type: string): ChannelCatalogEntry {
  return BY_TYPE.get(type) ?? {
    type: type as NotificationChannelType, label: type, kind: "Other", inbound: false,
    description: "A channel set up outside the dashboard.",
  };
}

export function channelLabel(type: string): string {
  return channelEntry(type).label;
}

export function channelSupportsInbound(type: string): boolean {
  return type === "telegram" || type === "whatsapp" || type === "whatsapp-business" || type === "webhook";
}

/** Default empty config per channel type. */
export function defaultChannelConfig(type: NotificationChannelType): NotificationChannelConfig {
  switch (type) {
    case "telegram": return { type, botToken: "", chatId: "", gateway: { enableInbound: false, dmPolicy: "pairing" } };
    case "whatsapp": return { type, chatId: "", profileDir: "default", gateway: { enableInbound: false, dmPolicy: "pairing" } };
    case "slack":    return { type, webhookUrl: "" };
    case "email":    return { type, provider: "resend", apiKey: "", from: "", to: [] };
    case "webhook":  return { type, gateway: { enableInbound: false, dmPolicy: "open" } };
    case "whatsapp-business": return { type, business: { audience: "customers" }, gateway: { enableInbound: false, dmPolicy: "open" } };
    case "push":     return { type, vapidSubject: "mailto:hello@polpo.ai", ttl: 3600, urgency: "normal" };
    default:         return { type };
  }
}

/** A free channel name for a new channel of this type: "telegram", "telegram-2"… */
export function nextChannelName(type: string, taken: Iterable<string>): string {
  const names = new Set(taken);
  const base = type.replace(/[^a-zA-Z0-9_-]/g, "-");
  if (!names.has(base)) return base;
  for (let i = 2; ; i++) if (!names.has(`${base}-${i}`)) return `${base}-${i}`;
}

export const CHANNEL_NAME_RE = /^[a-zA-Z0-9_-]+$/;

// ── State ──

export type ChannelState = "connected" | "receiving" | "configured" | "needs_setup" | "error";

export const CHANNEL_STATE_LABEL: Record<ChannelState, string> = {
  connected: "Connected",
  receiving: "Receiving",
  configured: "Configured",
  needs_setup: "Needs setup",
  error: "Error",
};

/** What the dashboard knows live about a channel, beyond its config. */
export interface ChannelLive {
  /** The last "Send test": false when it failed. */
  testOk?: boolean;
  testError?: string;
  /** WhatsApp Business: the Meta connection's state and its last webhook delivery. */
  waBizState?: "receiving" | "configured" | "not-configured";
  lastEventAt?: string;
  lastError?: string;
  /** WhatsApp (QR): the profile is linked. */
  waLinked?: boolean;
}

/** What a channel still needs before it can deliver, or null when nothing. */
export function channelMissing(ch: NotificationChannelConfig): string | null {
  switch (ch.type) {
    case "telegram": return ch.botToken ? null : "the bot token";
    case "slack": return ch.webhookUrl ? null : "the webhook URL";
    case "email": return ch.apiKey || ch.host ? null : "credentials";
    case "whatsapp-business": return ch.phoneNumberId && ch.wabaId ? null : "the number's ids";
    case "webhook": return ch.url || ch.gateway?.enableInbound ? null : "a URL or inbound";
    default: return null;
  }
}

/** The status pill: the last test's failure wins, then what is missing, then what is live. */
export function channelState(ch: NotificationChannelConfig, live: ChannelLive = {}): ChannelState {
  if (live.testOk === false) return "error";
  if (channelMissing(ch)) return "needs_setup";
  if (ch.type === "whatsapp-business") {
    if (live.waBizState === "receiving") return "receiving";
    if (live.waBizState === "not-configured") return "needs_setup";
    return "configured";
  }
  if (ch.type === "whatsapp" && live.waLinked === false) return "needs_setup";
  if (!BY_TYPE.has(ch.type)) return "configured";
  return "connected";
}

/** The one line under a configured channel's name. */
export function channelSummary(ch: NotificationChannelConfig, orchestrator: string, live: ChannelLive = {}): string {
  if (live.testOk === false && live.testError) return live.testError;
  const missing = channelMissing(ch);
  if (missing) return `Needs ${missing}`;
  if (ch.type === "whatsapp" && live.waLinked === false) return `Profile ${ch.profileDir || "default"} is not linked: scan the QR code`;
  if (ch.type === "whatsapp-business" && live.waBizState === "not-configured") return "Add the access token, app secret and verify token";
  const parts: string[] = [];
  const gateway = ch.gateway;
  const customers = ch.type === "whatsapp-business" && (ch.business?.audience ?? "customers") === "customers";
  if (gateway?.enableInbound) parts.push(customers ? `Customers → ${gateway.agent ?? "no agent"}` : `Talks to ${gateway.agent ?? orchestrator}`);
  else if (channelSupportsInbound(ch.type)) parts.push("Notifications only");
  switch (ch.type) {
    case "telegram": case "whatsapp": if (ch.chatId) parts.push(`chat ${ch.chatId}`); break;
    case "email": if (ch.to?.length) parts.push(`${ch.to.length} recipient${ch.to.length === 1 ? "" : "s"}`); break;
    case "whatsapp-business": if (ch.phoneNumberId) parts.push(`number ${ch.phoneNumberId}`); break;
    case "webhook": parts.push(ch.url ? "posts notifications" : "inbound only"); break;
    case "push": parts.push(`urgency ${ch.urgency ?? "normal"}`); break;
    case "slack": parts.push(ch.apiKey ? "file uploads on" : "webhook"); break;
  }
  return parts.join(" · ") || channelEntry(ch.type).description;
}

// ── Search ──

const norm = (s: string) => s.toLowerCase().trim();

export function filterChannelCatalog(entries: ChannelCatalogEntry[], query: string): ChannelCatalogEntry[] {
  const q = norm(query);
  if (!q) return entries;
  return entries.filter((e) => [e.type, e.label, e.description, e.kind, ...(e.keywords ?? [])].some((s) => norm(s).includes(q)));
}

export function filterChannels(channels: Array<[string, NotificationChannelConfig]>, query: string): Array<[string, NotificationChannelConfig]> {
  const q = norm(query);
  if (!q) return channels;
  return channels.filter(([name, ch]) => [name, ch.type, channelLabel(ch.type), ch.gateway?.agent ?? ""].some((s) => norm(s).includes(q)));
}
