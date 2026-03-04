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
import { join } from "node:path";
import { mkdirSync } from "node:fs";

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
  private chatJid: string;
  private polpoDir: string;
  private profilePath: string;
  private sock?: WASocket;
  private connected = false;

  constructor(config: NotificationChannelConfig, polpoDir: string) {
    const chatId = config.chatId ?? "";
    if (!chatId) throw new Error("WhatsApp channel requires chatId (phone number with country code)");
    this.chatJid = phoneToJid(chatId);
    this.polpoDir = polpoDir;
    const profileName = config.profileDir ?? "default";
    this.profilePath = join(polpoDir, "whatsapp-profiles", profileName);
    mkdirSync(this.profilePath, { recursive: true });
  }

  getProfilePath(): string { return this.profilePath; }
  getChatJid(): string { return this.chatJid; }
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
    const text = this.formatMessage(notification);
    await this.sock.sendMessage(this.chatJid, { text });
  }

  async sendWithAttachments(notification: Notification, attachments: OutcomeAttachment[]): Promise<void> {
    if (!this.sock) throw new Error("WhatsApp not connected");

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
    sock.ev.on("messaging-history.set", ({ messages: historyMsgs, contacts: historyContacts }) => {
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

          const text =
            msg.message.conversation ??
            msg.message.extendedTextMessage?.text ??
            msg.message.imageMessage?.caption ??
            msg.message.videoMessage?.caption ??
            msg.message.documentMessage?.caption ??
            undefined;

          const mediaType = msg.message.imageMessage ? "image"
            : msg.message.videoMessage ? "video"
            : msg.message.audioMessage ? "audio"
            : msg.message.documentMessage ? "document"
            : undefined;

          const chatId = msg.key.remoteJid ?? "";
          const messageId = msg.key.id ?? undefined;
          const isFromMe = !!msg.key.fromMe;
          const pushName = msg.pushName ?? undefined;
          const senderId = msg.key.remoteJid ?? "";
          const rawTs = msg.messageTimestamp;
          const timestamp = typeof rawTs === "number" ? rawTs
            : typeof rawTs === "object" && rawTs !== null && "toNumber" in rawTs ? (rawTs as { toNumber(): number }).toNumber()
            : Math.floor(Date.now() / 1000);

          if (messageId && (text || mediaType)) {
            this.store!.appendMessage({
              id: messageId,
              chatJid: chatId,
              senderJid: isFromMe ? (this.selfJid ?? "me") : senderId,
              senderName: isFromMe ? undefined : pushName,
              text: text ?? `[${mediaType}]`,
              fromMe: isFromMe,
              timestamp,
              mediaType,
            });
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

        // Extract text from various message types
        const text =
          msg.message.conversation ??
          msg.message.extendedTextMessage?.text ??
          msg.message.imageMessage?.caption ??
          msg.message.videoMessage?.caption ??
          msg.message.documentMessage?.caption ??
          undefined;

        // Detect media type
        const mediaType = msg.message.imageMessage ? "image"
          : msg.message.videoMessage ? "video"
          : msg.message.audioMessage ? "audio"
          : msg.message.documentMessage ? "document"
          : undefined;

        const senderId = msg.key.remoteJid ?? "";
        const chatId = msg.key.remoteJid ?? "";
        const pushName = msg.pushName ?? undefined;
        const messageId = msg.key.id ?? undefined;
        const isFromMe = !!msg.key.fromMe;
        const rawTs = msg.messageTimestamp;
        const timestamp = typeof rawTs === "number" ? rawTs
          : typeof rawTs === "object" && rawTs !== null && "toNumber" in rawTs ? (rawTs as { toNumber(): number }).toNumber()
          : Math.floor(Date.now() / 1000);

        // ── Store: buffer ALL messages (history + realtime, inbound + outbound) ──
        // This gives agents complete conversation history via whatsapp_* tools
        if (this.store && messageId && (text || mediaType)) {
          this.store.appendMessage({
            id: messageId,
            chatJid: chatId,
            senderJid: isFromMe ? (this.selfJid ?? "me") : senderId,
            senderName: isFromMe ? undefined : pushName,
            text: text ?? `[${mediaType}]`,
            fromMe: isFromMe,
            timestamp,
            mediaType,
          });

          // Upsert contact from pushName (inbound messages)
          if (!isFromMe && pushName && senderId && !senderId.endsWith("@g.us")) {
            this.store.upsertContact(senderId, pushName, timestamp);
          }
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
            if (credsSaved) {
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
            reject(new Error("WhatsApp login was rejected"));
          }
          // Other close reasons during interactive login are handled by QR re-display
        }
      });
    });
  }
}
