/**
 * WhatsApp notification channel — sends/receives messages via Baileys (WhatsApp Web protocol).
 *
 * ⚠️  PERSONAL USE ONLY — This uses the unofficial WhatsApp Web protocol via Baileys.
 *     It is NOT the official WhatsApp Business API. Meta may ban accounts that violate
 *     their Terms of Service. Use a dedicated phone number, not your primary one.
 *     For production/commercial use, implement the official WhatsApp Business Cloud API instead.
 *
 * Architecture:
 *   - Uses @whiskeysockets/baileys for the WA Web multi-device protocol
 *   - Auth state persisted in .polpo/whatsapp-profiles/<profileDir>/
 *   - Outbound: send notifications to a configured JID (phone@s.whatsapp.net)
 *   - Inbound: listen for messages, route through ChannelGateway
 *   - QR code linking via `polpo whatsapp login` CLI command
 *
 * Configuration (in polpo.json):
 *   {
 *     "type": "whatsapp",
 *     "chatId": "393331234567",        // Phone number (with country code, no +)
 *     "profileDir": "default",         // Optional, defaults to "default"
 *     "gateway": {
 *       "enableInbound": true,
 *       "dmPolicy": "pairing"
 *     }
 *   }
 */

import type { NotificationChannel, Notification, OutcomeAttachment } from "../types.js";
import type { NotificationChannelConfig } from "../../core/types.js";
import type { WhatsAppStore } from "../../stores/whatsapp-store.js";
import { basename, extname, join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";

// ─── Types ─────────────────────────────────────

type WASocket = import("@whiskeysockets/baileys").WASocket;

/** Handler interface for gateway routing (mirrors TelegramGatewayHandler pattern). */
export interface WhatsAppGatewayHandler {
  handleInboundMessage(
    senderId: string,
    chatId: string,
    text: string,
    senderName?: string,
    messageId?: string,
  ): Promise<string | undefined>;
}

/** Callback for approval actions from message replies. */
export interface WhatsAppApprovalResolver {
  approve(requestId: string, resolvedBy: string): Promise<{ ok: boolean; error?: string }>;
  reject(requestId: string, feedback: string, resolvedBy: string): Promise<{ ok: boolean; error?: string }>;
}

// ─── Helpers ───────────────────────────────────

/** Convert a phone number to WhatsApp JID. */
function phoneToJid(phone: string): string {
  // Strip + prefix if present, strip spaces/dashes
  const clean = phone.replace(/[+\s-]/g, "");
  return `${clean}@s.whatsapp.net`;
}

/** Convert markdown-like formatting to WhatsApp formatting. */
function markdownToWhatsApp(text: string): string {
  // WhatsApp supports: *bold*, _italic_, ~strikethrough~, ```monospace```
  // Convert **bold** → *bold*
  let wa = text.replace(/\*\*(.+?)\*\*/g, "*$1*");
  // Leave _italic_ as-is (same syntax)
  // Convert `inline code` → ```inline code``` (WhatsApp uses triple backticks)
  wa = wa.replace(/(?<!`)(`[^`]+`)(?!`)/g, "```$1```".replace(/`{4}/g, "```"));
  return wa;
}

/** Truncate text to WhatsApp's practical limit (65536 chars, but we cap lower). */
function truncate(text: string, max = 4000): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 20) + "\n\n... (truncated)";
}

// ─── WhatsApp Channel (Outbound Notifications) ─

export class WhatsAppChannel implements NotificationChannel {
  readonly type = "whatsapp";
  private chatJid?: string;
  private polpoDir: string;
  private profilePath: string;
  private sock?: WASocket;
  private connected = false;

  constructor(config: NotificationChannelConfig, polpoDir: string) {
    const chatId = config.chatId ?? "";
    this.chatJid = chatId ? phoneToJid(chatId) : undefined;
    this.polpoDir = polpoDir;
    const profileName = config.profileDir ?? "default";
    this.profilePath = join(polpoDir, "whatsapp-profiles", profileName);
    mkdirSync(this.profilePath, { recursive: true });
  }

  getProfilePath(): string { return this.profilePath; }
  getChatJid(): string { return this.chatJid ?? ""; }
  isConnected(): boolean { return this.connected; }

  /** Set the Baileys socket (injected by WhatsAppBridge after connection). */
  setSocket(sock: WASocket): void {
    this.sock = sock;
    this.connected = true;
  }

  /** Mark as disconnected (called by WhatsAppBridge on close). */
  setDisconnected(): void {
    this.sock = undefined;
    this.connected = false;
  }

  /** Get the raw socket (used by bridge for sendMessage with ID capture). */
  getSocket(): WASocket | undefined { return this.sock; }

  async send(notification: Notification): Promise<void> {
    if (!this.sock) throw new Error("WhatsApp not connected — run `polpo whatsapp login` first");
    if (!this.chatJid) throw new Error("WhatsApp channel requires chatId for outbound notifications");
    const text = this.formatMessage(notification);
    await this.sock.sendMessage(this.chatJid, { text });
  }

  async sendWithAttachments(notification: Notification, attachments: OutcomeAttachment[]): Promise<void> {
    if (!this.sock) throw new Error("WhatsApp not connected");
    if (!this.chatJid) throw new Error("WhatsApp channel requires chatId for outbound notifications");

    // Send main message
    const text = this.formatMessage(notification);
    await this.sock.sendMessage(this.chatJid, { text });

    // Send attachments
    for (const att of attachments) {
      try {
        if (att.content && att.filePath) {
          const mime = att.mimeType ?? "application/octet-stream";
          if (mime.startsWith("image/")) {
            await this.sock.sendMessage(this.chatJid, {
              image: att.content as Buffer,
              caption: att.label,
              mimetype: mime,
            });
          } else {
            await this.sock.sendMessage(this.chatJid, {
              document: att.content as Buffer,
              fileName: att.filePath.split("/").pop() ?? "attachment",
              caption: att.label,
              mimetype: mime,
            });
          }
        } else if (att.text) {
          const truncated = truncate(att.text, 3800);
          await this.sock.sendMessage(this.chatJid, {
            text: `*${att.label}*\n\n\`\`\`${truncated}\`\`\``,
          });
        }
      } catch {
        // Best-effort for attachments
      }
    }
  }

  async test(): Promise<boolean> {
    return this.connected && !!this.sock;
  }

  /** Send a text message to a specific JID (used by the bridge for replies). */
  async sendText(jid: string, text: string): Promise<void> {
    if (!this.sock) return;
    await this.sock.sendMessage(jid, { text: truncate(text) });
  }

  /** Send composing presence to a JID (typing indicator). */
  async sendTyping(jid: string): Promise<void> {
    if (!this.sock) return;
    try {
      await this.sock.presenceSubscribe(jid);
      await this.sock.sendPresenceUpdate("composing", jid);
    } catch {
      // Best-effort
    }
  }

  /** Stop typing indicator. */
  async stopTyping(jid: string): Promise<void> {
    if (!this.sock) return;
    try {
      await this.sock.sendPresenceUpdate("paused", jid);
    } catch {
      // Best-effort
    }
  }

  private formatMessage(notification: Notification): string {
    const severityEmoji: Record<string, string> = {
      info: "ℹ️",
      warning: "⚠️",
      critical: "🚨",
    };

    const emoji = severityEmoji[notification.severity] ?? "ℹ️";
    const title = notification.title;
    const body = markdownToWhatsApp(notification.body);
    const event = notification.sourceEvent;

    return [
      `${emoji} *${title}*`,
      "",
      body,
      "",
      `_${event}_`,
    ].join("\n");
  }
}

// ─── WhatsApp Bridge (Baileys Connection + Inbound Listener) ─

/**
 * Manages the Baileys WebSocket connection and routes inbound messages.
 * Separated from WhatsAppChannel to keep outbound (notification) and
 * connection lifecycle concerns decoupled.
 */
export class WhatsAppBridge {
  private sock?: WASocket;
  private channel: WhatsAppChannel;
  private profilePath: string;
  private mediaDir: string;
  private gateway?: WhatsAppGatewayHandler;
  private store?: WhatsAppStore;
  private stopping = false;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private log: (level: string, msg: string) => void;
  /** Our own JID (set on connection). */
  private selfJid?: string;
  /** Timestamp of when bridge was connected — ignore messages before this. */
  private connectedAt = 0;

  constructor(
    channel: WhatsAppChannel,
    log?: (level: string, msg: string) => void,
  ) {
    this.channel = channel;
    this.profilePath = channel.getProfilePath();
    this.mediaDir = join(this.profilePath, "..", "..", "whatsapp-media");
    mkdirSync(this.mediaDir, { recursive: true });
    this.log = log ?? ((level, msg) => console.error(`[polpo/whatsapp] [${level}] ${msg}`));
  }

  /** Attach a gateway handler for inbound message routing. */
  setGateway(handler: WhatsAppGatewayHandler): void {
    this.gateway = handler;
  }

  /** Attach a message store for buffering all messages (inbound + outbound). */
  setStore(store: WhatsAppStore): void {
    this.store = store;
  }

  /** Get the attached store (for tool access). */
  getStore(): WhatsAppStore | undefined {
    return this.store;
  }

  /**
   * Send a text message to a JID and return the message ID.
   * Also stores the outbound message in the WhatsAppStore.
   */
  async sendMessage(jid: string, text: string): Promise<string | undefined> {
    const sock = this.channel.getSocket();
    if (!sock) throw new Error("WhatsApp not connected");
    const result = await sock.sendMessage(jid, { text: truncate(text) });
    const msgId = result?.key?.id ?? undefined;

    // Store outbound message
    if (this.store && msgId) {
      this.store.appendMessage({
        id: msgId,
        chatJid: jid,
        senderJid: this.selfJid ?? "me",
        text,
        fromMe: true,
        timestamp: Math.floor(Date.now() / 1000),
      });
    }

    return msgId;
  }

  /** Send a file/media message to a JID and return the message ID. */
  async sendMediaMessage(jid: string, opts: {
    path: string;
    caption?: string;
    mimeType?: string;
    fileName?: string;
    mediaKind?: "auto" | "image" | "video" | "audio" | "document";
    viewOnce?: boolean;
  }): Promise<string | undefined> {
    const sock = this.channel.getSocket();
    if (!sock) throw new Error("WhatsApp not connected");
    const content = buildMediaContent(opts.path, opts.mimeType, opts.fileName, opts.caption, opts.mediaKind, opts.viewOnce);
    const result = await sock.sendMessage(jid, content as any);
    const msgId = result?.key?.id ?? undefined;

    if (this.store && msgId) {
      const mime = opts.mimeType ?? guessMime(opts.path);
      const kind = resolveMediaKind(opts.mediaKind, mime);
      this.store.appendMessage({
        id: msgId,
        chatJid: jid,
        senderJid: this.selfJid ?? "me",
        text: opts.caption || `[${kind}: ${opts.fileName ?? basename(opts.path)}]`,
        fromMe: true,
        timestamp: Math.floor(Date.now() / 1000),
        mediaType: kind,
        mediaPath: opts.path,
        mimeType: mime,
        fileName: opts.fileName ?? basename(opts.path),
      });
    }

    return msgId;
  }

  /** Send WhatsApp read receipts for message keys. */
  async markRead(keys: { remoteJid: string; id: string; fromMe?: boolean; participant?: string }[]): Promise<void> {
    const sock = this.channel.getSocket();
    if (!sock || keys.length === 0) return;
    await sock.readMessages(keys as any);
    this.store?.markRead(keys.map(k => k.id));
  }

  /** Start the Baileys connection. Returns when initially connected (or throws on auth failure). */
  async start(): Promise<void> {
    this.stopping = false;
    await this.connect();
  }

  /** Gracefully disconnect. */
  stop(): void {
    this.stopping = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    if (this.sock) {
      try { this.sock.end(undefined); } catch { /* ignore */ }
      this.sock = undefined;
    }
    this.channel.setDisconnected();
  }

  private async connect(): Promise<void> {
    const {
      default: makeWASocket,
      useMultiFileAuthState,
      DisconnectReason,
      fetchLatestBaileysVersion,
      makeCacheableSignalKeyStore,
      Browsers,
      downloadMediaMessage,
    } = await import("@whiskeysockets/baileys");

    const { state, saveCreds } = await useMultiFileAuthState(this.profilePath);
    const { version } = await fetchLatestBaileysVersion();

    this.log("info", `Connecting to WhatsApp (version ${version.join(".")})...`);

    const sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, undefined as any),
      },
      printQRInTerminal: false, // We handle QR display ourselves in the CLI command
      browser: Browsers.macOS("Desktop"), // Must use Browsers helper for full history sync
      generateHighQualityLinkPreview: false,
      syncFullHistory: true, // Request full message history from phone for tool access
      shouldSyncHistoryMessage: () => true, // Accept all history sync types
    });

    this.sock = sock;

    // ── Auth state persistence ──
    sock.ev.on("creds.update", saveCreds);

    // ── Connection updates ──
    sock.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        // QR code received but we're in daemon mode — user needs to run `polpo whatsapp login`
        this.log("warn", "WhatsApp session expired — run `polpo whatsapp login` to re-authenticate");
      }

      if (connection === "open") {
        // Normalize self JID: "12345:67@s.whatsapp.net" → "12345@s.whatsapp.net"
        this.selfJid = sock.user?.id?.replace(/:.*@/, "@");
        this.connectedAt = Date.now();
        this.log("info", `WhatsApp connected (self: ${this.selfJid})`);
        this.channel.setSocket(sock);
      }

      if (connection === "close") {
        this.channel.setDisconnected();

        const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut;

        if (loggedOut) {
          this.log("warn", "WhatsApp logged out — run `polpo whatsapp login` to re-authenticate");
          return; // Don't reconnect
        }

        if (!this.stopping) {
          const delay = statusCode === DisconnectReason.restartRequired ? 1000 : 5000;
          this.log("info", `WhatsApp disconnected (code ${statusCode}), reconnecting in ${delay / 1000}s...`);
          this.reconnectTimer = setTimeout(() => {
            this.connect().catch(err => {
              this.log("warn", `WhatsApp reconnect failed: ${err instanceof Error ? err.message : String(err)}`);
            });
          }, delay);
        }
      }
    });

    // ── Contact updates (Baileys contacts.upsert event) ──
    sock.ev.on("contacts.upsert", (contacts) => {
      if (!this.store) return;
      for (const contact of contacts) {
        const name = contact.notify ?? contact.verifiedName ?? contact.name;
        if (name && contact.id) {
          this.store.upsertContact(contact.id, name);
        }
      }
    });

    // ── History sync (initial connect — bulk message import) ──
    sock.ev.on("messaging-history.set", async ({ messages: historyMsgs, contacts: historyContacts }) => {
      if (!this.store) return;

      // Buffer historical contacts
      if (historyContacts) {
        let contactCount = 0;
        for (const contact of historyContacts) {
          const name = contact.notify ?? contact.verifiedName ?? contact.name;
          if (name && contact.id) {
            this.store.upsertContact(contact.id, name);
            contactCount++;
          }
        }
        if (contactCount > 0) {
          this.log("info", `WhatsApp history sync: ${contactCount} contacts imported`);
        }
      }

      // Buffer historical messages
      if (historyMsgs && historyMsgs.length > 0) {
        let msgCount = 0;
        for (const msg of historyMsgs) {
          if (!msg.message) continue;

          if (await this.persistMessage(msg, downloadMediaMessage, sock)) {
            msgCount++;
          }
        }
        if (msgCount > 0) {
          this.log("info", `WhatsApp history sync: ${msgCount} messages imported`);
        }
      }
    });

    // ── Inbound messages ──
    // Store ALL messages (notify + history sync) for tool access,
    // but only route new real-time messages through the gateway.
    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      for (const msg of messages) {
        if (!msg.message) continue;

        const senderId = msg.key.remoteJid ?? "";
        const chatId = msg.key.remoteJid ?? "";
        const pushName = msg.pushName ?? undefined;
        const messageId = msg.key.id ?? undefined;
        const isFromMe = !!msg.key.fromMe;
        const rawTs = msg.messageTimestamp;
        const timestamp = typeof rawTs === "number" ? rawTs
          : typeof rawTs === "object" && rawTs !== null && "toNumber" in rawTs ? (rawTs as { toNumber(): number }).toNumber()
          : Math.floor(Date.now() / 1000);

        const text = getMessageText(msg.message);

        // ── Store: buffer ALL messages (history + realtime, inbound + outbound) ──
        // This gives agents complete conversation history via whatsapp_* tools
        if (await this.persistMessage(msg, downloadMediaMessage, sock)) {
          if (!isFromMe && pushName && senderId && !senderId.endsWith("@g.us")) this.store?.upsertContact(senderId, pushName, timestamp);
        }

        // ── Gateway routing: only new real-time messages ──
        // Skip history sync messages — only "notify" type is real-time
        if (type !== "notify") continue;

        // Skip old messages (timestamp before we connected)
        const msgTs = timestamp * 1000;
        if (msgTs && msgTs < this.connectedAt - 5000) continue;

        // fromMe handling: skip our own outbound messages for gateway routing
        if (isFromMe) continue;

        // Skip non-text messages for gateway routing (for now)
        if (!text) continue;

        // Skip group messages for now (only DMs)
        if (senderId.endsWith("@g.us")) continue;

        if (this.gateway) {
          // Send typing indicator
          await this.channel.sendTyping(chatId);

          // Keep refreshing typing every 4s while processing
          const typingInterval = setInterval(() => {
            this.channel.sendTyping(chatId).catch(() => {});
          }, 4000);

          try {
            const response = await this.gateway.handleInboundMessage(
              senderId, chatId, text, pushName, messageId,
            );
            if (response) {
              await this.channel.sendText(chatId, response);
            }
          } catch (err) {
            this.log("warn", `Error handling message: ${err instanceof Error ? err.message : String(err)}`);
          } finally {
            clearInterval(typingInterval);
            await this.channel.stopTyping(chatId).catch(() => {});
          }
        }
      }
    });
  }

  /**
   * Connect in interactive mode (for CLI `polpo whatsapp login`).
   * Returns a promise that resolves when QR is scanned and connection is established.
   */
  async connectInteractive(onQR: (qr: string) => void): Promise<void> {
    const {
      default: makeWASocket,
      useMultiFileAuthState,
      DisconnectReason,
      fetchLatestBaileysVersion,
      makeCacheableSignalKeyStore,
      Browsers,
    } = await import("@whiskeysockets/baileys");

    const { state, saveCreds } = await useMultiFileAuthState(this.profilePath);
    const { version } = await fetchLatestBaileysVersion();

    return new Promise<void>((resolve, reject) => {
      let credsSaved = false;
      let settled = false;

      const sock = makeWASocket({
        version,
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, undefined as any),
        },
        printQRInTerminal: false,
        browser: Browsers.macOS("Desktop"), // Must match bridge for consistent device identity
        generateHighQualityLinkPreview: false,
        syncFullHistory: false, // CLI login doesn't need history, just pairing
      });
      this.sock = sock;

      sock.ev.on("creds.update", async () => {
        await saveCreds();
        credsSaved = true;
      });

      sock.ev.on("connection.update", (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          onQR(qr);
        }

        if (connection === "open") {
          this.log("info", "WhatsApp connected successfully");
          // Wait for creds to be saved before closing — Baileys saves asynchronously
          const waitForCreds = () => {
            if (settled) return;
            if (credsSaved) {
              settled = true;
              this.log("info", "Credentials saved, closing interactive session");
              setTimeout(() => {
                try { sock.end(undefined); } catch { /* ignore */ }
              }, 1000);
              resolve();
            } else {
              setTimeout(waitForCreds, 200);
            }
          };
          // Give Baileys a moment to fire creds.update
          setTimeout(waitForCreds, 500);
        }

        if (connection === "close") {
          const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
          if (statusCode === DisconnectReason.loggedOut) {
            settled = true;
            reject(new Error("WhatsApp login was rejected"));
          } else if (this.stopping && !settled) {
            settled = true;
            reject(new Error("WhatsApp login was cancelled"));
          }
          // Other close reasons during interactive login are handled by QR re-display
        }
      });
    });
  }

  private async persistMessage(
    msg: any,
    downloadMediaMessage: (message: any, type: "buffer", options: any, ctx?: any) => Promise<Buffer>,
    sock: WASocket,
  ): Promise<boolean> {
    if (!this.store || !msg.message) return false;
    const messageId = msg.key?.id;
    const chatId = msg.key?.remoteJid ?? "";
    if (!messageId || !chatId) return false;

    const media = getMediaInfo(msg.message);
    const text = getMessageText(msg.message);
    if (!text && !media.mediaType) return false;

    const isFromMe = !!msg.key?.fromMe;
    const rawTs = msg.messageTimestamp;
    const timestamp = typeof rawTs === "number" ? rawTs
      : typeof rawTs === "object" && rawTs !== null && "toNumber" in rawTs ? (rawTs as { toNumber(): number }).toNumber()
      : Math.floor(Date.now() / 1000);

    let downloaded: { mediaPath?: string; mediaSize?: number } = {};
    if (media.mediaType) {
      downloaded = await this.downloadMedia(msg, downloadMediaMessage, sock, chatId, messageId, media, timestamp);
    }

    this.store.appendMessage({
      id: messageId,
      chatJid: chatId,
      senderJid: isFromMe ? (this.selfJid ?? "me") : (msg.key?.participant ?? msg.key?.remoteJid ?? ""),
      senderName: isFromMe ? undefined : msg.pushName ?? undefined,
      text: text ?? `[${media.mediaType}${media.fileName ? `: ${media.fileName}` : ""}]`,
      fromMe: isFromMe,
      timestamp,
      mediaType: media.mediaType,
      mediaPath: downloaded.mediaPath,
      mediaSize: downloaded.mediaSize,
      mimeType: media.mimeType,
      fileName: media.fileName,
      readAt: isFromMe ? timestamp : undefined,
    });
    return true;
  }

  private async downloadMedia(
    msg: any,
    downloadMediaMessage: (message: any, type: "buffer", options: any, ctx?: any) => Promise<Buffer>,
    sock: WASocket,
    chatId: string,
    messageId: string,
    media: { mediaType?: string; mimeType?: string; fileName?: string },
    timestamp: number,
  ): Promise<{ mediaPath?: string; mediaSize?: number }> {
    try {
      const buffer = await downloadMediaMessage(msg, "buffer", {}, { reuploadRequest: (sock as any).updateMediaMessage });
      if (!buffer?.length) return {};
      const chatDir = sanitizePathPart(chatId);
      const ext = mediaExt(media.mediaType, media.mimeType, media.fileName);
      const fileName = `${timestamp}-${sanitizePathPart(messageId)}${ext}`;
      const dir = join(this.mediaDir, chatDir);
      mkdirSync(dir, { recursive: true });
      const filePath = join(dir, fileName);
      writeFileSync(filePath, buffer);
      return { mediaPath: filePath, mediaSize: buffer.length };
    } catch (err) {
      this.log("warn", `WhatsApp media download failed: ${err instanceof Error ? err.message : String(err)}`);
      return {};
    }
  }
}

function getMessageText(message: any): string | undefined {
  return message.conversation
    ?? message.extendedTextMessage?.text
    ?? message.imageMessage?.caption
    ?? message.videoMessage?.caption
    ?? message.documentMessage?.caption
    ?? undefined;
}

function getMediaInfo(message: any): { mediaType?: "image" | "video" | "audio" | "document" | "sticker"; mimeType?: string; fileName?: string } {
  const mediaMessage = message.imageMessage ?? message.videoMessage ?? message.audioMessage ?? message.documentMessage ?? message.stickerMessage;
  const mediaType = message.imageMessage ? "image"
    : message.videoMessage ? "video"
    : message.audioMessage ? "audio"
    : message.documentMessage ? "document"
    : message.stickerMessage ? "sticker"
    : undefined;
  return {
    mediaType,
    mimeType: mediaMessage?.mimetype,
    fileName: mediaMessage?.fileName,
  };
}

function buildMediaContent(
  path: string,
  mimeType?: string,
  fileName?: string,
  caption?: string,
  mediaKind: "auto" | "image" | "video" | "audio" | "document" = "auto",
  viewOnce?: boolean,
): Record<string, unknown> {
  const mime = mimeType ?? guessMime(path);
  const kind = resolveMediaKind(mediaKind, mime);
  const file = { url: path };
  const base = { mimetype: mime, ...(caption ? { caption } : {}), ...(viewOnce ? { viewOnce: true } : {}) };
  if (kind === "image") return { image: file, ...base };
  if (kind === "video") return { video: file, ...base };
  if (kind === "audio") return { audio: file, mimetype: mime };
  return { document: file, fileName: fileName ?? basename(path), ...base };
}

function resolveMediaKind(kind: string | undefined, mime: string): "image" | "video" | "audio" | "document" {
  if (kind && kind !== "auto" && kind !== "sticker") return kind as "image" | "video" | "audio" | "document";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return "document";
}

function guessMime(path: string): string {
  const ext = extname(path).toLowerCase();
  const map: Record<string, string> = {
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif",
    ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm",
    ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".ogg": "audio/ogg", ".opus": "audio/ogg", ".wav": "audio/wav",
    ".pdf": "application/pdf", ".txt": "text/plain", ".json": "application/json", ".csv": "text/csv",
    ".doc": "application/msword", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xls": "application/vnd.ms-excel", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".zip": "application/zip",
  };
  return map[ext] ?? "application/octet-stream";
}

function mediaExt(mediaType?: string, mimeType?: string, fileName?: string): string {
  const existing = fileName ? extname(fileName) : "";
  if (existing) return existing;
  const byMime: Record<string, string> = {
    "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif",
    "video/mp4": ".mp4", "video/quicktime": ".mov", "audio/mpeg": ".mp3", "audio/mp4": ".m4a",
    "audio/ogg": ".ogg", "audio/wav": ".wav", "application/pdf": ".pdf",
  };
  if (mimeType && byMime[mimeType]) return byMime[mimeType];
  if (mediaType === "image") return ".jpg";
  if (mediaType === "video") return ".mp4";
  if (mediaType === "audio") return ".ogg";
  return ".bin";
}

function sanitizePathPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120);
}
