import type { NotificationChannel, Notification } from "../types.js";
import type { NotificationChannelConfig } from "../../core/types.js";

/**
 * Telegram notification channel — sends messages via Bot API.
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
    const text = [
      `${emoji} *${escapeMarkdown(notification.title)}*`,
      "",
      escapeMarkdown(notification.body),
      "",
      `_${escapeMarkdown(notification.sourceEvent)}_`,
    ].join("\n");

    const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: this.chatId,
        text,
        parse_mode: "MarkdownV2",
        disable_web_page_preview: true,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Telegram API failed: ${response.status} — ${body}`);
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

/** Escape special MarkdownV2 characters for Telegram. */
function escapeMarkdown(text: string): string {
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!])/g, "\\$1");
}

function resolveEnvVar(value: string): string {
  if (value.startsWith("${") && value.endsWith("}")) {
    const envKey = value.slice(2, -1);
    return process.env[envKey] ?? "";
  }
  return value;
}
