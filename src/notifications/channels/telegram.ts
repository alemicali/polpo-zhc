import type { NotificationChannel, Notification, OutcomeAttachment } from "../types.js";
import type { NotificationChannelConfig } from "../../core/types.js";
import { basename } from "node:path";

/**
 * Telegram notification channel — sends messages via Bot API.
 *
 * Uses HTML parse_mode (much more reliable than MarkdownV2).
 * Converts standard Markdown from templates to Telegram HTML.
 *
 * Supports outcome attachments via sendDocument/sendPhoto/sendAudio.
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

  async send(notification: Notification): Promise<void> {
    const text = this.formatMessage(notification);
    await this.sendMessage(text);
  }

  async sendWithAttachments(notification: Notification, attachments: OutcomeAttachment[]): Promise<void> {
    // Send the text message first
    const text = this.formatMessage(notification);
    await this.sendMessage(text);

    // Send each attachment using the appropriate Telegram API method
    for (const att of attachments) {
      try {
        if (att.content && att.filePath) {
          await this.sendFile(att);
        } else if (att.text) {
          // For text outcomes, send as a message (truncated to Telegram's 4096 limit)
          const truncated = att.text.length > 3800
            ? att.text.slice(0, 3800) + "\n\n... (truncated)"
            : att.text;
          const label = escapeHtml(att.label);
          await this.sendMessage(`<b>${label}</b>\n\n<pre>${escapeHtml(truncated)}</pre>`);
        }
      } catch {
        // Best-effort — don't fail the notification if one attachment fails
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

  private async sendMessage(text: string): Promise<void> {
    const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: this.chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });

    if (!response.ok) {
      const respBody = await response.text();
      throw new Error(`Telegram API failed: ${response.status} — ${respBody}`);
    }
  }

  /**
   * Send a file attachment via Telegram Bot API.
   * Chooses the right method based on MIME type:
   *   - image/* → sendPhoto
   *   - audio/* → sendAudio
   *   - everything else → sendDocument
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

/** Escape HTML special characters for Telegram HTML parse mode. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Convert standard Markdown formatting to Telegram HTML.
 * Handles: **bold** → <b>, *italic* → <i>, `code` → <code>, _italic_ → <i>
 * Escapes HTML entities first, then applies formatting.
 */
function markdownToHtml(text: string): string {
  let html = escapeHtml(text);

  // **bold** → <b>bold</b>  (must come before single *)
  html = html.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  // *italic* → <i>italic</i>
  html = html.replace(/\*(.+?)\*/g, "<i>$1</i>");
  // _italic_ → <i>italic</i>
  html = html.replace(/_(.+?)_/g, "<i>$1</i>");
  // `code` → <code>code</code>
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
