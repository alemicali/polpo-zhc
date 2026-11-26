/**
 * Slack inbound over Socket Mode: people talk to Polpo or an agent from Slack, through the same
 * ChannelGateway as Telegram (pairing, allowlist, /agent, sessions, groups, files, buttons).
 *
 * Socket Mode keeps an outbound WebSocket open to Slack, so the instance needs no public URL (it
 * stays on the tailnet). A Slack channel (`type: "slack"`) with `gateway.enableInbound` and both
 * tokens in the vault gets a bridge:
 *
 *   - the app-level token (xapp-…, connections:write) opens the socket;
 *   - the bot token (xoxb-…) reads files, posts replies (chat.postMessage, in thread) and uploads
 *     files (files.uploadV2).
 *
 * Both live in the vault under the reserved owner "$channels" (services slack:<channel>:botToken
 * and slack:<channel>:appToken), written from the dashboard only; they never appear in the
 * configuration, in MCP arguments or in logs (the Slack clients' logger drops debug output and
 * masks anything token-shaped).
 *
 * Mapping:
 *   - a DM (channel_type "im") is a private conversation with the person (peer slack:<user id>);
 *   - in a Slack channel the bot answers mentions, replies in threads it is part of and /polpo
 *     (with slack.channelMessages "all", every message of an enabled channel); the channel is a
 *     group (slack:group:<channel id>, enabled with /enable like a Telegram group) and each thread
 *     a topic: a conversation, and a session, of its own;
 *   - replies go out with chat.postMessage in the thread (a top-level mention opens one); reply
 *     buttons become Block Kit buttons and come back as block_actions; files are downloaded with
 *     the bot token and uploaded with files.uploadV2;
 *   - the slash command (/polpo by default) runs gateway commands: "/polpo agent backend" is
 *     "/agent backend", "/polpo" alone is "/help" (Slack keeps "/…" typed in a message for itself).
 */
import { readFile } from "node:fs/promises";
import type { NotificationChannelConfig, VaultStore } from "@polpo-ai/core";
import type { InboundAttachment } from "./channels/telegram.js";
import type { SlackPoster } from "./channels/slack.js";
import type { InboundGroup } from "./telegram-groups.js";
import type { ChannelGateway, ChannelOutboundFile, GatewayReply, ReplyButton } from "./channel-gateway.js";
import {
  SLACK_BUTTON_ACTION, attachmentKind, decodeThreadTs, encodeThreadTs, markdownToMrkdwn, redactSlackTokens, replyBlocks, slackToPlain, splitSlackText,
} from "./slack-format.js";

export const SLACK_VAULT_OWNER = "$channels";
export type SlackSecretKind = "botToken" | "appToken";
export const SLACK_SECRET_KINDS: readonly SlackSecretKind[] = ["botToken", "appToken"];

/** The vault entry of a Slack channel's token (owner "$channels"; the value under the key "secret"). */
export function slackVaultService(channel: string, kind: SlackSecretKind): string {
  return `slack:${channel}:${kind}`;
}

/** Inbound files larger than this are skipped (the chat attachment store's limit). */
const MAX_FILE_BYTES = 15 * 1024 * 1024;
/** Reconnect delays after a failed start (Socket Mode reconnects a live socket on its own). */
const RETRY_DELAYS_MS = [5_000, 15_000, 60_000, 300_000];

// ── The Slack clients, as far as the bridge uses them (mocked in tests) ──

export interface SlackSocketLike {
  on(event: string, listener: (...args: any[]) => void): unknown;
  start(): Promise<unknown>;
  disconnect(): Promise<void>;
}

export interface SlackWebLike {
  auth: { test(): Promise<{ ok?: boolean; user_id?: string; user?: string; team?: string; team_id?: string; bot_id?: string }> };
  chat: { postMessage(args: Record<string, unknown>): Promise<{ ok?: boolean; ts?: string; channel?: string }> };
  filesUploadV2(args: Record<string, unknown>): Promise<unknown>;
  users?: { info(args: { user: string }): Promise<{ user?: { name?: string; real_name?: string; profile?: { display_name?: string; real_name?: string } } }> };
}

/** What the Slack client libraries log through: debug dropped, tokens masked. */
export interface SlackLogger {
  debug(...msg: unknown[]): void;
  info(...msg: unknown[]): void;
  warn(...msg: unknown[]): void;
  error(...msg: unknown[]): void;
  setLevel(level: unknown): void;
  getLevel(): any;
  setName(name: string): void;
}

export type SlackClientFactory = (tokens: { appToken: string; botToken: string }, logger: SlackLogger) =>
  Promise<{ socket: SlackSocketLike; web: SlackWebLike }>;

/** A socket that never connects: posting with the bot token only (no app-level token). */
export const NO_SOCKET: SlackSocketLike = { on: () => undefined, start: async () => undefined, disconnect: async () => {} };

/** The official clients: @slack/socket-mode and @slack/web-api (the socket only with an app-level token). */
export const defaultSlackClients: SlackClientFactory = async ({ appToken, botToken }, logger) => {
  const { WebClient } = await import("@slack/web-api");
  const web = new WebClient(botToken, { logger: logger as never });
  if (!appToken) return { socket: NO_SOCKET, web: web as unknown as SlackWebLike };
  const { SocketModeClient } = await import("@slack/socket-mode");
  const socket = new SocketModeClient({ appToken, logger: logger as never, autoReconnectEnabled: true });
  return { socket: socket as unknown as SlackSocketLike, web: web as unknown as SlackWebLike };
};

/** The gateway as the bridge uses it (a ChannelGateway in production). */
export type SlackGatewayHandle = Pick<ChannelGateway, "handleMessageReply" | "joinsByIntent" | "handleMenuCallback" | "handleGroupJoined" | "setPartialResponseHandler">;

export type SlackConnectionState = "not-configured" | "stopped" | "connecting" | "connected" | "reconnecting" | "error";

export interface SlackStatus {
  channel: string;
  /** Inbound on in the configuration. */
  inbound: boolean;
  /** Which tokens are in the vault (never their values). */
  secrets: Record<SlackSecretKind, boolean>;
  state: SlackConnectionState;
  /** From auth.test once connected. */
  team?: string;
  botUserId?: string;
  botName?: string;
  connectedAt?: string;
  lastEventAt?: string;
  lastError?: string;
  /** Messages handled since the bridge started. */
  received: number;
}

type Log = (level: "info" | "warn", message: string) => void;

/** A Slack message event, as far as the bridge reads it. */
interface SlackMessageEvent {
  type: string;
  subtype?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  channel?: string;
  channel_type?: string;
  inviter?: string;
  files?: Array<{ id?: string; name?: string; title?: string; mimetype?: string; subtype?: string; size?: number; url_private_download?: string; url_private?: string }>;
}

function quietLogger(log: Log): SlackLogger {
  const out = (level: "info" | "warn", msg: unknown[]) => log(level, redactSlackTokens(msg.map((m) => (m instanceof Error ? m.message : typeof m === "string" ? m : "")).join(" ")).slice(0, 300));
  return {
    debug: () => {},
    info: () => {},
    warn: (...m) => out("warn", m),
    error: (...m) => out("warn", m),
    setLevel: () => {},
    getLevel: () => "warn",
    setName: () => {},
  };
}

// ── One Slack app, one socket ────────────────────────────────────────

export interface SlackBridgeOptions {
  name: string;
  config: () => NotificationChannelConfig | undefined;
  tokens: { appToken: string; botToken: string };
  clients: SlackClientFactory;
  log: Log;
  fetch?: typeof fetch;
  /** Overridable in tests. */
  retryDelaysMs?: number[];
}

export class SlackBridge {
  readonly name: string;
  private socket?: SlackSocketLike;
  private web?: SlackWebLike;
  private gateway?: SlackGatewayHandle;
  private stopped = false;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private attempts = 0;
  private seen = new Set<string>();
  /** Threads the bot posted in ("<channel>:<thread ts>"): a message there is addressed to it. */
  private botThreads = new Set<string>();
  /** DM threads in flight: partial replies go to the same thread. */
  private dmThread = new Map<string, string>();
  private names = new Map<string, string>();
  readonly status: Omit<SlackStatus, "channel" | "inbound" | "secrets"> = { state: "stopped", received: 0 };

  constructor(private readonly o: SlackBridgeOptions) {
    this.name = o.name;
  }

  /** Same tokens: the bridge can be kept across a configuration reload. */
  sameTokens(t: { appToken: string; botToken: string }): boolean {
    return t.appToken === this.o.tokens.appToken && t.botToken === this.o.tokens.botToken;
  }

  setGateway(gateway: SlackGatewayHandle | undefined): void {
    this.gateway = gateway;
    gateway?.setPartialResponseHandler(async (chatId, text, target) => {
      const thread = decodeThreadTs(target?.threadId) ?? this.dmThread.get(chatId);
      await this.post(chatId, text, { threadTs: thread });
    });
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.status.state = "connecting";
    try {
      const { socket, web } = await this.o.clients(this.o.tokens, quietLogger(this.o.log));
      this.socket = socket;
      this.web = web;
      const me = await web.auth.test();
      this.status.botUserId = me.user_id;
      this.status.botName = me.user;
      this.status.team = me.team;
      socket.on("connected", () => {
        this.status.state = "connected";
        this.status.connectedAt = new Date().toISOString();
        this.status.lastError = undefined;
        this.attempts = 0;
        this.o.log("info", `Slack "${this.name}" connected (Socket Mode${me.team ? `, ${me.team}` : ""}${me.user ? `, @${me.user}` : ""})`);
      });
      socket.on("reconnecting", () => { if (!this.stopped) this.status.state = "reconnecting"; });
      socket.on("disconnected", () => { if (!this.stopped) this.status.state = "reconnecting"; });
      socket.on("error", (err: unknown) => {
        this.status.lastError = redactSlackTokens(err instanceof Error ? err.message : String(err));
      });
      socket.on("slack_event", (e: { ack: (r?: unknown) => Promise<void>; type: string; body: any }) => { void this.onEnvelope(e); });
      await socket.start();
      if (this.status.state === "connecting") this.status.state = "connected";
      this.status.connectedAt ??= new Date().toISOString();
    } catch (err) {
      const message = redactSlackTokens(err instanceof Error ? err.message : String(err));
      this.status.state = "error";
      this.status.lastError = message;
      this.o.log("warn", `Slack "${this.name}" could not connect: ${message}`);
      await this.socket?.disconnect().catch(() => {});
      this.socket = undefined;
      this.scheduleRetry();
    }
  }

  private scheduleRetry(): void {
    const delays = this.o.retryDelaysMs ?? RETRY_DELAYS_MS;
    if (this.stopped || delays.length === 0) return;
    const delay = delays[Math.min(this.attempts, delays.length - 1)];
    this.attempts++;
    this.retryTimer = setTimeout(() => { if (!this.stopped) void this.start(); }, delay);
    this.retryTimer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.status.state = "stopped";
    await this.socket?.disconnect().catch(() => {});
    this.socket = undefined;
  }

  // ── Inbound ──

  private async onEnvelope(e: { ack: (r?: unknown) => Promise<void>; type: string; body: any }): Promise<void> {
    // Slack wants the ack within 3 seconds: always first
    await e.ack().catch(() => {});
    this.status.lastEventAt = new Date().toISOString();
    try {
      if (e.type === "events_api") await this.onEvent(e.body?.event as SlackMessageEvent | undefined);
      else if (e.type === "slash_commands") await this.onSlashCommand(e.body ?? {});
      else if (e.type === "interactive") await this.onInteractive(e.body ?? {});
    } catch (err) {
      this.status.lastError = redactSlackTokens(err instanceof Error ? err.message : String(err));
      this.o.log("warn", `Slack "${this.name}": ${this.status.lastError}`);
    }
  }

  private firstSeen(key: string): boolean {
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    if (this.seen.size > 1000) this.seen.delete(this.seen.values().next().value!);
    return true;
  }

  private async displayName(user: string): Promise<string | undefined> {
    if (this.names.has(user)) return this.names.get(user);
    const r = await this.web?.users?.info({ user }).catch(() => undefined);
    const name = r?.user?.profile?.display_name || r?.user?.profile?.real_name || r?.user?.real_name || r?.user?.name || undefined;
    if (name) this.names.set(user, name);
    return name;
  }

  private async onEvent(ev: SlackMessageEvent | undefined): Promise<void> {
    if (!ev || !this.gateway) return;
    const me = this.status.botUserId;
    if (ev.type === "member_joined_channel") {
      if (ev.user && ev.user === me && ev.channel && ev.inviter) {
        const reply = await this.gateway.handleGroupJoined("slack", ev.channel, undefined, ev.inviter);
        if (reply) await this.post(ev.channel, reply);
      }
      return;
    }
    if (ev.type !== "message" && ev.type !== "app_mention") return;
    // the bot's own messages, edits, deletions, joins…: only plain messages and file shares
    if (ev.bot_id || !ev.user || ev.user === me) return;
    if (ev.subtype && ev.subtype !== "file_share" && ev.subtype !== "thread_broadcast") return;
    if (!ev.channel || !ev.ts) return;
    // message and app_mention both arrive for a mention: handle it once
    if (!this.firstSeen(`${ev.channel}:${ev.ts}`)) return;
    this.status.received++;

    const { text, mentioned } = slackToPlain(ev.text ?? "", me);
    const isDm = ev.channel_type === "im" || (ev.type === "message" && ev.channel.startsWith("D"));
    const displayName = await this.displayName(ev.user);
    const attachments = await this.download(ev.files ?? []);
    const base = { channel: "slack" as const, externalId: ev.user, chatId: ev.channel, displayName, messageId: ev.ts };

    if (isDm) {
      if (!text && attachments.length === 0) return;
      if (ev.thread_ts) this.dmThread.set(ev.channel, ev.thread_ts);
      try {
        const reply = await this.gateway.handleMessageReply({ ...base, text, ...(attachments.length ? { attachments } : {}) });
        await this.deliver(ev.channel, reply, ev.thread_ts);
      } finally {
        if (ev.thread_ts) this.dmThread.delete(ev.channel);
      }
      return;
    }

    // a Slack channel: a group; a thread is a topic (top-level mentions open one)
    const inBotThread = !!ev.thread_ts && this.botThreads.has(`${ev.channel}:${ev.thread_ts}`);
    const all = this.o.config()?.slack?.channelMessages === "all";
    const addressed = ev.type === "app_mention" || mentioned || inBotThread || all;
    const threadTs = ev.thread_ts ?? (addressed ? ev.ts : undefined);
    const group: InboundGroup = { addressed, ...(threadTs ? { threadId: encodeThreadTs(threadTs) } : {}) };
    const msg = { ...base, text, group, ...(attachments.length ? { attachments } : {}) };
    if (!addressed && await this.gateway.joinsByIntent(msg).catch(() => false)) group.addressed = true;
    const reply = await this.gateway.handleMessageReply(msg);
    if (group.addressed) await this.deliver(ev.channel, reply, threadTs);
  }

  private async onSlashCommand(body: { text?: string; user_id?: string; user_name?: string; channel_id?: string; response_url?: string }): Promise<void> {
    if (!this.gateway || !body.user_id || !body.channel_id) return;
    this.status.received++;
    const raw = (body.text ?? "").trim();
    // "/polpo" → /help, "/polpo agent x" → /agent x, "/polpo /status" → /status
    const text = !raw ? "/help" : raw.startsWith("/") ? raw : `/${raw}`;
    const isDm = body.channel_id.startsWith("D");
    const displayName = (await this.displayName(body.user_id)) ?? body.user_name;
    const reply = await this.gateway.handleMessageReply({
      channel: "slack", externalId: body.user_id, chatId: body.channel_id, displayName, text,
      ...(isDm ? {} : { group: { addressed: true } }),
    });
    if (!reply || (!reply.text.trim() && !reply.buttons && !reply.files?.length)) return;
    try {
      await this.deliver(body.channel_id, reply);
    } catch (err) {
      // the bot is not in that channel: answer the person only (ephemeral, through the response URL)
      if (!body.response_url) throw err;
      const f = this.o.fetch ?? fetch;
      await f(body.response_url, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ response_type: "ephemeral", text: markdownToMrkdwn(reply.text), blocks: reply.buttons ? replyBlocks(markdownToMrkdwn(reply.text), reply.buttons) : undefined }),
      });
    }
  }

  private async onInteractive(body: { type?: string; user?: { id?: string; name?: string; username?: string }; channel?: { id?: string }; container?: { thread_ts?: string; message_ts?: string }; message?: { thread_ts?: string; ts?: string }; actions?: Array<{ action_id?: string; value?: string }> }): Promise<void> {
    if (!this.gateway || body.type !== "block_actions") return;
    const action = body.actions?.[0];
    const user = body.user?.id;
    const chatId = body.channel?.id;
    if (!action?.action_id?.startsWith(SLACK_BUTTON_ACTION) || !action.value || !user || !chatId) return;
    const sep = action.value.indexOf(":");
    if (sep <= 0) return;
    const threadTs = body.container?.thread_ts ?? body.message?.thread_ts;
    const isDm = chatId.startsWith("D");
    const displayName = (await this.displayName(user)) ?? body.user?.name ?? body.user?.username;
    const text = await this.gateway.handleMenuCallback(action.value.slice(0, sep), action.value.slice(sep + 1), {
      channel: "slack", externalId: user, chatId, displayName,
      ...(isDm ? {} : { group: { addressed: true, ...(threadTs ? { threadId: encodeThreadTs(threadTs) } : {}) } }),
    });
    if (text) await this.post(chatId, text, { threadTs });
  }

  /** Inbound files, downloaded with the bot token (files:read). */
  private async download(files: NonNullable<SlackMessageEvent["files"]>): Promise<InboundAttachment[]> {
    const out: InboundAttachment[] = [];
    const f = this.o.fetch ?? fetch;
    for (const file of files) {
      const url = file.url_private_download ?? file.url_private;
      if (!url || (file.size ?? 0) > MAX_FILE_BYTES) continue;
      try {
        const res = await f(url, { headers: { Authorization: `Bearer ${this.o.tokens.botToken}` } });
        if (!res.ok) continue;
        const data = Buffer.from(await res.arrayBuffer());
        if (data.length > MAX_FILE_BYTES) continue;
        const mimeType = file.mimetype || "application/octet-stream";
        out.push({ kind: attachmentKind(mimeType, file.subtype), filename: file.name || file.title || "file", mimeType, data });
      } catch {
        // a file that cannot be downloaded is skipped, the message still goes through
      }
    }
    return out;
  }

  // ── Outbound ──

  /** A gateway reply: text (split, buttons on the last piece), then files, in the thread. */
  async deliver(chatId: string, reply: GatewayReply | undefined, threadTs?: string): Promise<void> {
    if (!reply || reply.deliveredTo) return;
    const text = reply.forceReply?.placeholder ? `${reply.text}\n\n_${reply.forceReply.placeholder}_` : reply.text;
    if (text.trim() || reply.buttons) await this.post(chatId, text, { threadTs, buttons: reply.buttons });
    for (const file of reply.files ?? []) await this.upload(chatId, file, threadTs);
  }

  /** Post a message (Markdown in), split to Slack's size; returns the last message's ts. */
  async post(chatId: string, text: string, opts: { threadTs?: string; buttons?: ReplyButton[][] } = {}): Promise<string | undefined> {
    if (!this.web) throw new Error(`Slack "${this.name}" is not connected`);
    const pieces = splitSlackText(markdownToMrkdwn(text));
    let ts: string | undefined;
    for (const [i, piece] of pieces.entries()) {
      const last = i === pieces.length - 1;
      const blocks = last && opts.buttons?.length ? replyBlocks(piece, opts.buttons) : undefined;
      const r = await this.web.chat.postMessage({
        channel: chatId, text: piece || " ", ...(opts.threadTs ? { thread_ts: opts.threadTs } : {}), ...(blocks ? { blocks } : {}),
        unfurl_links: false,
      });
      ts = r.ts ?? ts;
    }
    if (opts.threadTs) this.rememberThread(chatId, opts.threadTs);
    return ts;
  }

  private rememberThread(chatId: string, threadTs: string): void {
    this.botThreads.add(`${chatId}:${threadTs}`);
    if (this.botThreads.size > 2000) this.botThreads.delete(this.botThreads.values().next().value!);
  }

  async upload(chatId: string, file: ChannelOutboundFile | { filename: string; data: Buffer }, threadTs?: string): Promise<void> {
    if (!this.web) throw new Error(`Slack "${this.name}" is not connected`);
    const data = "data" in file ? file.data : await readFile(file.path);
    await this.web.filesUploadV2({
      channel_id: chatId, file: data, filename: file.filename, title: file.filename, ...(threadTs ? { thread_ts: threadTs } : {}),
    });
  }

  async test(): Promise<boolean> {
    if (!this.web) return false;
    const r = await this.web.auth.test().catch(() => undefined);
    return !!r?.user_id;
  }
}

// ── The instance's Slack apps ────────────────────────────────────────

export interface SlackServiceOptions {
  channels: () => Record<string, NotificationChannelConfig>;
  vault: () => VaultStore | undefined;
  log: Log;
  clients?: SlackClientFactory;
  fetch?: typeof fetch;
  retryDelaysMs?: number[];
}

export class SlackService {
  private bridges = new Map<string, SlackBridge>();
  private gateways = new Map<string, SlackGatewayHandle>();
  private syncing: Promise<void> = Promise.resolve();

  constructor(private readonly o: SlackServiceOptions) {}

  private config(name: string): NotificationChannelConfig | undefined {
    const c = this.o.channels()[name];
    return c?.type === "slack" ? c : undefined;
  }

  channelNames(): string[] {
    return Object.entries(this.o.channels()).filter(([, c]) => c?.type === "slack").map(([n]) => n);
  }

  // ── Secrets (vault, $channels) ──

  private async secret(name: string, kind: SlackSecretKind): Promise<string | undefined> {
    const entry = await this.o.vault()?.get(SLACK_VAULT_OWNER, slackVaultService(name, kind)).catch(() => undefined);
    const v = entry?.credentials?.secret;
    return typeof v === "string" && v.trim() ? v.trim() : undefined;
  }

  async secretsSet(name: string): Promise<Record<SlackSecretKind, boolean>> {
    return { botToken: !!(await this.secret(name, "botToken")), appToken: !!(await this.secret(name, "appToken")) };
  }

  /** Store a token in the vault (the dashboard only); null removes it. The bridge restarts. */
  async setSecret(name: string, kind: SlackSecretKind, value: string | null): Promise<void> {
    if (!this.config(name)) throw new SlackNotFoundError(`No Slack channel "${name}"`);
    const vault = this.o.vault();
    if (!vault) throw new Error("This instance has no vault: the token cannot be stored");
    const service = slackVaultService(name, kind);
    if (value === null) await vault.remove(SLACK_VAULT_OWNER, service);
    else {
      const v = value.trim();
      const prefix = kind === "botToken" ? "xoxb-" : "xapp-";
      if (!v.startsWith(prefix) || v.length < 20 || /\s/.test(v)) {
        throw new SlackInputError(`That does not look like a ${kind === "botToken" ? "bot token (xoxb-…)" : "app-level token (xapp-…)"}`);
      }
      await vault.set(SLACK_VAULT_OWNER, service, { type: "custom", label: `Slack "${name}": ${kind}`, credentials: { secret: v } });
    }
    await this.sync();
  }

  /** The bot token, for outbound notifications (chat.postMessage) without inbound. */
  async botToken(name: string): Promise<string | undefined> {
    return this.config(name) ? this.secret(name, "botToken") : undefined;
  }

  // ── Bridges ──

  setGateway(name: string, gateway: SlackGatewayHandle | undefined): void {
    if (gateway) this.gateways.set(name, gateway); else this.gateways.delete(name);
    this.bridges.get(name)?.setGateway(gateway);
  }

  clearGateways(): void {
    this.gateways.clear();
    for (const b of this.bridges.values()) b.setGateway(undefined);
  }

  /** Start, keep or stop each channel's bridge to match the configuration and the vault (serialized). */
  sync(): Promise<void> {
    this.syncing = this.syncing.then(() => this.doSync()).catch((err) => {
      this.o.log("warn", `Slack: ${redactSlackTokens(err instanceof Error ? err.message : String(err))}`);
    });
    return this.syncing;
  }

  private async doSync(): Promise<void> {
    const wanted = new Map<string, { appToken: string; botToken: string }>();
    for (const name of this.channelNames()) {
      if (!this.config(name)?.gateway?.enableInbound) continue;
      const [appToken, botToken] = await Promise.all([this.secret(name, "appToken"), this.secret(name, "botToken")]);
      if (appToken && botToken) wanted.set(name, { appToken, botToken });
    }
    for (const [name, bridge] of [...this.bridges]) {
      const tokens = wanted.get(name);
      if (tokens && bridge.sameTokens(tokens)) continue;
      this.bridges.delete(name);
      await bridge.stop();
    }
    for (const [name, tokens] of wanted) {
      if (this.bridges.has(name)) { this.bridges.get(name)!.setGateway(this.gateways.get(name)); continue; }
      const bridge = new SlackBridge({
        name, tokens, config: () => this.config(name), clients: this.o.clients ?? defaultSlackClients,
        log: this.o.log, fetch: this.o.fetch, retryDelaysMs: this.o.retryDelaysMs,
      });
      bridge.setGateway(this.gateways.get(name));
      this.bridges.set(name, bridge);
      await bridge.start();
    }
  }

  bridge(name: string): SlackBridge | undefined {
    return this.bridges.get(name);
  }

  async status(name: string): Promise<SlackStatus> {
    const c = this.config(name);
    if (!c) throw new SlackNotFoundError(`No Slack channel "${name}"`);
    const secrets = await this.secretsSet(name);
    const b = this.bridges.get(name);
    const inbound = c.gateway?.enableInbound === true;
    if (b) return { channel: name, inbound, secrets, ...b.status };
    return { channel: name, inbound, secrets, state: secrets.appToken && secrets.botToken ? "stopped" : "not-configured", received: 0 };
  }

  /**
   * Post to a Slack channel with the bot token (a running bridge, or a one-off client): the
   * conversation pipe, notifications to a chatId, polpo_message_send.
   */
  async post(name: string, chatId: string, text: string, opts: { threadTs?: string; files?: ChannelOutboundFile[]; buttons?: ReplyButton[][] } = {}): Promise<{ ts?: string }> {
    const running = this.bridges.get(name);
    const bridge = running?.status.state === "connected" || running?.status.state === "reconnecting" ? running : await this.oneOff(name);
    const ts = text.trim() || opts.buttons ? await bridge.post(chatId, text, opts) : undefined;
    for (const f of opts.files ?? []) await bridge.upload(chatId, f, opts.threadTs);
    return { ts };
  }

  /** A web client only (no socket), for posting when inbound is off. */
  private async oneOff(name: string): Promise<SlackBridge> {
    const botToken = await this.botToken(name);
    if (!botToken) throw new SlackInputError(`Slack "${name}" has no bot token: add it in the dashboard (Configuration → Channels → ${name})`);
    const clients = this.o.clients ?? defaultSlackClients;
    const bridge = new SlackBridge({
      name, tokens: { appToken: "", botToken }, config: () => this.config(name), log: this.o.log, fetch: this.o.fetch, retryDelaysMs: [],
      clients: async (t, logger) => ({ socket: NO_SOCKET, web: (await clients(t, logger)).web }),
    });
    await bridge.start();
    if (bridge.status.state === "error") { await bridge.stop(); throw new Error(`Slack "${name}": ${bridge.status.lastError ?? "could not connect"}`); }
    await bridge.stop();
    // stop() keeps the web client: post works after it
    return bridge;
  }

  async test(name: string): Promise<boolean> {
    const b = this.bridges.get(name);
    if (b) return b.test();
    try { return await (await this.oneOff(name)).test(); } catch { return false; }
  }

  async dispose(): Promise<void> {
    for (const b of this.bridges.values()) await b.stop();
    this.bridges.clear();
    this.gateways.clear();
  }
}

export class SlackNotFoundError extends Error { readonly code = "NOT_FOUND"; }
export class SlackInputError extends Error { readonly code = "INVALID"; }

// ── One service per instance (the notification channel finds it by .polpo dir) ──

const services = new Map<string, SlackService>();

export function registerSlackService(polpoDir: string, service: SlackService | undefined): void {
  const prev = services.get(polpoDir);
  if (prev && prev !== service) void prev.dispose();
  if (service) services.set(polpoDir, service); else services.delete(polpoDir);
}

export function slackServiceFor(polpoDir: string | undefined): SlackService | undefined {
  return polpoDir ? services.get(polpoDir) : undefined;
}

/** The Slack notification channel's way to post with the app's bot token (undefined: no Slack service). */
export function slackPosterFor(polpoDir: string, channel: string): SlackPoster | undefined {
  const service = services.get(polpoDir);
  if (!service) return undefined;
  return {
    hasBotToken: async () => !!(await service.botToken(channel)),
    post: (chatId, text, opts) => service.post(channel, chatId, text, opts),
    test: () => service.test(channel),
  };
}
