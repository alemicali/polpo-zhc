import type { NotificationChannel, Notification } from "../types.js";
import type { NotificationChannelConfig } from "../../core/types.js";

/**
 * Telegram notification channel — sends messages via Bot API.
 *
 * Uses HTML parse_mode (much more reliable than MarkdownV2).
 * Converts standard Markdown from templates to Telegram HTML.
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
    const severityEmoji: Record<string, string> = {
      info: "ℹ️",
      warning: "⚠️",
      critical: "🚨",
    };

    const emoji = severityEmoji[notification.severity] ?? "ℹ️";
    const title = escapeHtml(notification.title);
    const body = markdownToHtml(notification.body);
    const event = escapeHtml(notification.sourceEvent);

    const text = [
      `${emoji} <b>${title}</b>`,
      "",
      body,
      "",
      `<i>${event}</i>`,
    ].join("\n");

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

  async test(): Promise<boolean> {
    try {
      const url = `https://api.telegram.org/bot${this.botToken}/getMe`;
      const response = await fetch(url);
      return response.ok;
    } catch {
      return false;
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
