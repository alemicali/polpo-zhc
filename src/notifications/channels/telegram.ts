import type { NotificationChannel, Notification, OutcomeAttachment } from "../types.js";
import type { NotificationChannelConfig } from "../../core/types.js";
import { basename } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";

/**
 * Telegram notification channel — sends messages via Bot API.
 *
 * Uses HTML parse_mode (much more reliable than MarkdownV2).
 * Converts standard Markdown from templates to Telegram HTML.
 *
 * Supports outcome attachments via sendDocument/sendPhoto/sendAudio.
 * Supports inline keyboard buttons for approval workflows.
 *
 * Configuration:
 *   botToken: Telegram Bot token (from @BotFather)
 *   chatId: Chat/Group/Channel ID to send to
 */
export class TelegramChannel implements NotificationChannel {
  readonly type = "telegram";
  private botToken: string;
  private chatId: string;

  constructor(config: NotificationChannelConfig) {
    this.botToken = resolveEnvVar(config.botToken ?? "");
    this.chatId = resolveEnvVar(config.chatId ?? "");
    if (!this.botToken) throw new Error("Telegram channel requires botToken");
    if (!this.chatId) throw new Error("Telegram channel requires chatId");
  }

  getBotToken(): string { return this.botToken; }
  getChatId(): string { return this.chatId; }

  async send(notification: Notification): Promise<void> {
    const text = this.formatMessage(notification);
    const keyboard = this.buildApprovalKeyboard(notification);
    await this.sendMessage(text, keyboard);
  }

  async sendWithAttachments(notification: Notification, attachments: OutcomeAttachment[]): Promise<void> {
    const keyboard = this.buildApprovalKeyboard(notification);

    // If there's a single image attachment, send it with the text as caption + keyboard
    const imageAtt = attachments.find(a => a.content && a.mimeType?.startsWith("image/"));
    if (imageAtt && imageAtt.content && imageAtt.filePath) {
      const caption = this.formatMessage(notification);
      // Telegram caption limit is 1024 chars
      const truncatedCaption = caption.length > 1000
        ? caption.slice(0, 1000) + "..."
        : caption;
      await this.sendPhotoWithKeyboard(imageAtt, truncatedCaption, keyboard);

      // Send remaining non-image attachments
      for (const att of attachments) {
        if (att === imageAtt) continue;
        try {
          if (att.content && att.filePath) {
            await this.sendFile(att);
          } else if (att.text) {
            const truncated = att.text.length > 3800
              ? att.text.slice(0, 3800) + "\n\n... (truncated)"
              : att.text;
            const label = escapeHtml(att.label);
            await this.sendMessage(`<b>${label}</b>\n\n<pre>${escapeHtml(truncated)}</pre>`);
          }
        } catch {
          // Best-effort
        }
      }
      return;
    }

    // No image attachment — send text message with keyboard, then attachments
    const text = this.formatMessage(notification);
    await this.sendMessage(text, keyboard);

    for (const att of attachments) {
      try {
        if (att.content && att.filePath) {
          await this.sendFile(att);
        } else if (att.text) {
          const truncated = att.text.length > 3800
            ? att.text.slice(0, 3800) + "\n\n... (truncated)"
            : att.text;
          const label = escapeHtml(att.label);
          await this.sendMessage(`<b>${label}</b>\n\n<pre>${escapeHtml(truncated)}</pre>`);
        }
      } catch {
        // Best-effort
      }
    }
  }

  async test(): Promise<boolean> {
    try {
      const url = `https://api.telegram.org/bot${this.botToken}/getMe`;
      const response = await fetch(url);
      return response.ok;
    } catch {
      return false;
    }
  }

  // ─── Private helpers ─────────────────────

  /**
   * Build inline keyboard for approval notifications.
   * Only applies to approval:requested events — detected via the notification metadata.
   */
  private buildApprovalKeyboard(notification: Notification): InlineKeyboard | undefined {
    // Check if this is an approval notification by looking at sourceEvent
    if (notification.sourceEvent !== "approval:requested") return undefined;

    // Extract requestId from the event payload
    const data = notification.sourceData as Record<string, unknown> | undefined;
    const requestId = data?.requestId as string | undefined;
    if (!requestId) return undefined;

    return {
      inline_keyboard: [
        [
          { text: "✅ Approve", callback_data: `approve:${requestId}` },
          { text: "❌ Reject", callback_data: `reject:${requestId}` },
        ],
      ],
    };
  }

  private formatMessage(notification: Notification): string {
    const severityEmoji: Record<string, string> = {
      info: "ℹ️",
      warning: "⚠️",
      critical: "🚨",
    };

    const emoji = severityEmoji[notification.severity] ?? "ℹ️";
    const title = escapeHtml(notification.title);
    const body = markdownToHtml(notification.body);
    const event = escapeHtml(notification.sourceEvent);

    return [
      `${emoji} <b>${title}</b>`,
      "",
      body,
      "",
      `<i>${event}</i>`,
    ].join("\n");
  }

  private async sendMessage(text: string, replyMarkup?: InlineKeyboard): Promise<void> {
    const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
    const body: Record<string, unknown> = {
      chat_id: this.chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    };
    if (replyMarkup) {
      body.reply_markup = replyMarkup;
    }

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const respBody = await response.text();
      throw new Error(`Telegram API failed: ${response.status} — ${respBody}`);
    }
  }

  /**
   * Send a photo with caption and optional inline keyboard.
   */
  private async sendPhotoWithKeyboard(
    att: OutcomeAttachment,
    caption: string,
    keyboard?: InlineKeyboard,
  ): Promise<void> {
    const filename = att.filePath ? basename(att.filePath) : "photo.png";
    const blob = new Blob([att.content! as BlobPart], { type: att.mimeType ?? "image/png" });

    const form = new FormData();
    form.append("chat_id", this.chatId);
    form.append("photo", blob, filename);
    form.append("caption", caption);
    form.append("parse_mode", "HTML");
    if (keyboard) {
      form.append("reply_markup", JSON.stringify(keyboard));
    }

    const url = `https://api.telegram.org/bot${this.botToken}/sendPhoto`;
    const response = await fetch(url, { method: "POST", body: form });

    if (!response.ok) {
      const respBody = await response.text();
      throw new Error(`Telegram sendPhoto failed: ${response.status} — ${respBody}`);
    }
  }

  /**
   * Send a file attachment via Telegram Bot API.
   */
  private async sendFile(att: OutcomeAttachment): Promise<void> {
    const mime = att.mimeType ?? "";
    let method: string;
    let fileField: string;

    if (mime.startsWith("image/")) {
      method = "sendPhoto";
      fileField = "photo";
    } else if (mime.startsWith("audio/")) {
      method = "sendAudio";
      fileField = "audio";
    } else {
      method = "sendDocument";
      fileField = "document";
    }

    const filename = att.filePath ? basename(att.filePath) : "attachment";
    const blob = new Blob([att.content! as BlobPart], { type: mime || "application/octet-stream" });

    const form = new FormData();
    form.append("chat_id", this.chatId);
    form.append(fileField, blob, filename);
    form.append("caption", att.label);

    const url = `https://api.telegram.org/bot${this.botToken}/${method}`;
    const response = await fetch(url, { method: "POST", body: form });

    if (!response.ok) {
      const respBody = await response.text();
      throw new Error(`Telegram ${method} failed: ${response.status} — ${respBody}`);
    }
  }
}

// ─── Telegram Inline Keyboard types ────────

interface InlineKeyboardButton {
  text: string;
  callback_data?: string;
  url?: string;
}

interface InlineKeyboard {
  inline_keyboard: InlineKeyboardButton[][];
}

// ─── Telegram Callback Poller ──────────────

/**
 * Polls Telegram Bot API for callback_query updates (inline button presses).
 * Routes approval actions to the provided resolver callback.
 *
 * Supports three actions:
 *   - approve:REQUEST_ID → approves the request
 *   - reject:REQUEST_ID  → rejects the request
 *   - revise:REQUEST_ID  → prompts for feedback, then revises
 *
 * For revise: after the user presses the button, the bot asks for feedback
 * via a reply. The next text message from the same chat is used as feedback.
 */
export class TelegramCallbackPoller {
  private botToken: string;
  private chatId: string;
  private offset = 0;
  private timer?: ReturnType<typeof setInterval>;
  private pendingRevise = new Map<string, string>(); // chatId → requestId (waiting for feedback text)
  private resolver?: ApprovalCallbackResolver;
  private gateway?: TelegramGatewayHandler;

  constructor(botToken: string, chatId: string) {
    this.botToken = botToken;
    this.chatId = chatId;
  }

  setResolver(resolver: ApprovalCallbackResolver): void {
    this.resolver = resolver;
  }

  /** Attach a ChannelGateway handler for full inbound message routing.
   *  When set, non-approval messages are forwarded to the gateway instead of being ignored. */
  setGateway(handler: TelegramGatewayHandler): void {
    this.gateway = handler;
  }

  start(intervalMs = 2000): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.poll(), intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async poll(): Promise<void> {
    try {
      const url = `https://api.telegram.org/bot${this.botToken}/getUpdates`;
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          offset: this.offset,
          timeout: 1,
          allowed_updates: ["callback_query", "message"],
        }),
      });

      if (!response.ok) return;

      const data = await response.json() as TelegramUpdateResponse;
      if (!data.ok || !data.result) return;

      for (const update of data.result) {
        this.offset = Math.max(this.offset, update.update_id + 1);

        if (update.callback_query) {
          await this.handleCallback(update.callback_query);
        } else if (update.message) {
          const msg = update.message;
          const msgKeys = Object.keys(msg).filter(k => !["message_id", "chat", "from", "date"].includes(k));
          console.error(`[polpo/telegram] update ${update.update_id}: keys=[${msgKeys.join(",")}]` +
            (msg.document ? ` document=${msg.document.mime_type} file_name=${(msg.document as any).file_name}` : "") +
            (msg.text ? ` text="${msg.text.slice(0, 40)}"` : ""));
          await this.handleMessage(update.message);
        }
      }
    } catch (err) {
      console.error(`[polpo/telegram] Poll error: ${err instanceof Error ? err.stack : String(err)}`);
    }
  }

  private async handleCallback(query: TelegramCallbackQuery): Promise<void> {
    if (!query.data) return;

    const [action, requestId] = query.data.split(":", 2);
    if (!action || !requestId) return;

    // Answer the callback query first (removes loading spinner)
    await this.answerCallback(query.id);

    const chatId = String(query.message?.chat?.id ?? this.chatId);
    const senderId = String(query.from?.id ?? query.message?.chat?.id ?? this.chatId);
    const senderName = query.from?.first_name;

    // If gateway is available, route through it for identity tracking
    if (this.gateway) {
      const response = await this.gateway.handleApprovalCallback(
        action, requestId, chatId, senderId, senderName,
      );
      if (response) await this.sendReply(chatId, markdownToHtml(response));
      return;
    }

    // Fallback: original approval-only logic
    if (!this.resolver) return;

    if (action === "approve") {
      const result = await this.resolver.approve(requestId, "telegram-user");
      const msg = result.ok
        ? "✅ Approved successfully"
        : `❌ Error: ${result.error}`;
      await this.sendReply(chatId, msg);
    } else if (action === "reject") {
      this.pendingRevise.set(chatId, requestId);
      await this.sendForceReply(chatId,
        "❌ <b>Rejected — tell the agent why</b>\n\nReply with your feedback. The task will be re-executed with your notes.",
      );
    }
  }

  private async handleMessage(message: TelegramMessage): Promise<void> {
    const chatId = String(message.chat.id);
    const senderId = String(message.from?.id ?? message.chat.id);
    const senderName = message.from?.first_name;

    const text = message.text ?? message.caption;

    if (!text) return; // No usable content

    // ── Gateway mode: route ALL messages through the ChannelGateway ──
    if (this.gateway) {
      // Send typing immediately and keep refreshing every 4s until we respond
      await this.sendChatAction(chatId, "typing");
      const typingInterval = setInterval(() => {
        this.sendChatAction(chatId, "typing").catch(() => {});
      }, 4000);

      try {
        const response = await this.gateway.handleInboundMessage(
          senderId, chatId, text, senderName, String(message.message_id),
        );
        if (response) await this.sendReply(chatId, markdownToHtml(response));
      } finally {
        clearInterval(typingInterval);
      }
      return;
    }

    // ── Legacy mode: only handle pending rejection feedback ──
    if (!this.resolver) return;

    const requestId = this.pendingRevise.get(chatId);
    if (!requestId) return;

    this.pendingRevise.delete(chatId);

    const result = await this.resolver.reject(requestId, text, "telegram-user");
    const msg = result.ok
      ? `❌ Rejected — task will retry with your feedback:\n<i>${escapeHtml(text)}</i>`
      : `❌ Error: ${result.error}`;
    await this.sendReply(chatId, msg);
  }

  private async answerCallback(callbackQueryId: string): Promise<void> {
    const url = `https://api.telegram.org/bot${this.botToken}/answerCallbackQuery`;
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: callbackQueryId }),
    }).catch(() => {});
  }

  /** Send typing indicator to a chat. */
  async sendTyping(chatId: string): Promise<void> {
    await this.sendChatAction(chatId, "typing");
  }

  /** Send a partial response as a separate message (for multi-turn tool loops). */
  async sendPartial(chatId: string, text: string): Promise<void> {
    await this.sendReply(chatId, markdownToHtml(text));
  }

  private async sendChatAction(chatId: string, action: "typing" | "upload_photo" | "upload_document" = "typing"): Promise<void> {
    const url = `https://api.telegram.org/bot${this.botToken}/sendChatAction`;
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, action }),
    }).catch(() => {});
  }

  private async sendReply(chatId: string, text: string): Promise<void> {
    const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
      }),
    }).catch(() => {});
  }

  /** Send a message with ForceReply — opens the reply input automatically in the Telegram client. */
  private async sendForceReply(chatId: string, text: string): Promise<void> {
    const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        reply_markup: {
          force_reply: true,
          selective: true,
          input_field_placeholder: "Describe what needs to change...",
        },
      }),
    }).catch(() => {});
  }
}

/**
 * Gateway handler interface — bridges TelegramCallbackPoller to ChannelGateway.
 * This decouples the Telegram polling logic from the gateway routing logic.
 */
export interface TelegramGatewayHandler {
  handleInboundMessage(
    senderId: string,
    chatId: string,
    text: string,
    senderName?: string,
    messageId?: string,
  ): Promise<string | undefined>;

  handleApprovalCallback(
    action: string,
    requestId: string,
    chatId: string,
    senderId: string,
    senderName?: string,
  ): Promise<string | undefined>;
}

// ─── Types for callback resolver ───────────

export interface ApprovalCallbackResult {
  ok: boolean;
  error?: string;
}

export interface ApprovalCallbackResolver {
  approve(requestId: string, resolvedBy: string): Promise<ApprovalCallbackResult>;
  reject(requestId: string, feedback: string, resolvedBy: string): Promise<ApprovalCallbackResult>;
}

// ─── Telegram API types ────────────────────

interface TelegramUpdateResponse {
  ok: boolean;
  result?: TelegramUpdate[];
}

interface TelegramUpdate {
  update_id: number;
  callback_query?: TelegramCallbackQuery;
  message?: TelegramMessage;
}

interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
}

interface TelegramCallbackQuery {
  id: string;
  data?: string;
  message?: TelegramMessage;
  from?: TelegramUser;
}

interface TelegramFile {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  duration?: number;
  mime_type?: string;
}

interface TelegramMessage {
  message_id: number;
  chat: { id: number };
  from?: TelegramUser;
  text?: string;
  /** File attachment (document). */
  document?: TelegramFile & { file_name?: string };
  /** Caption text (on media messages) */
  caption?: string;
}

// ─── Utility functions ─────────────────────

/** Escape HTML special characters for Telegram HTML parse mode. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Convert standard Markdown formatting to Telegram HTML.
 */
function markdownToHtml(text: string): string {
  let html = escapeHtml(text);
  html = html.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  html = html.replace(/\*(.+?)\*/g, "<i>$1</i>");
  html = html.replace(/_(.+?)_/g, "<i>$1</i>");
  html = html.replace(/`(.+?)`/g, "<code>$1</code>");
  return html;
}

function resolveEnvVar(value: string): string {
  if (value.startsWith("${") && value.endsWith("}")) {
    const envKey = value.slice(2, -1);
    return process.env[envKey] ?? "";
  }
  return value;
}
