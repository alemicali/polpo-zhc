import type { NotificationChannel, Notification, OutcomeAttachment } from "../types.js";
import type { NotificationChannelConfig } from "../../core/types.js";
import { basename } from "node:path";

/** Posting with the Slack app's bot token (the instance's Slack service), when the channel has one. */
export interface SlackPoster {
  hasBotToken(): Promise<boolean>;
  post(chatId: string, text: string, opts: { threadTs?: string; files?: Array<{ path: string; filename: string }> }): Promise<unknown>;
  test(): Promise<boolean>;
}

/**
 * Slack notification channel — an Incoming Webhook, or the Slack app's bot token.
 *
 * With a bot token in the vault (Configuration → Channels → Slack, the same app as inbound Socket
 * Mode) a notification goes with chat.postMessage to its target: the chat id in the notification's
 * sourceData ({ chatId, threadTs }: conversation pipes, polpo_message_send), else the channel's
 * chatId. Otherwise it goes to the Incoming Webhook (webhookUrl).
 *
 * For attachments: with the bot token files are uploaded (files.uploadV2); with only a webhook,
 * outcome summaries follow as text. The legacy apiKey (a bot token in the configuration) still
 * enables uploads next to the webhook.
 *
 * Configuration:
 *   webhookUrl: (Optional) Slack Incoming Webhook URL
 *   chatId:     (Optional) Slack channel id for bot-token notifications
 *   apiKey:     (Optional, legacy) Slack Bot Token for file uploads
 */
export class SlackChannel implements NotificationChannel {
  readonly type = "slack";
  private webhookUrl?: string;
  private apiToken?: string;
  private chatId?: string;

  constructor(config: NotificationChannelConfig, private readonly poster?: () => SlackPoster | undefined) {
    const url = resolveEnvVar(config.webhookUrl ?? "");
    if (url) this.webhookUrl = url;
    const token = resolveEnvVar(config.apiKey ?? "");
    if (token) this.apiToken = token;
    if (config.chatId) this.chatId = config.chatId;
    if (!this.webhookUrl && !poster) throw new Error("Slack channel requires webhookUrl");
  }

  /** The bot-token route, when the app has a token and there is a chat to post to. */
  private async botTarget(notification: Notification): Promise<{ poster: SlackPoster; chatId: string; threadTs?: string } | undefined> {
    const data = (notification.sourceData ?? {}) as { chatId?: unknown; threadTs?: unknown };
    const chatId = typeof data.chatId === "string" && data.chatId ? data.chatId : this.chatId;
    const poster = this.poster?.();
    if (!chatId || !poster || !await poster.hasBotToken()) return undefined;
    return { poster, chatId, ...(typeof data.threadTs === "string" && data.threadTs ? { threadTs: data.threadTs } : {}) };
  }

  private requireWebhook(): string {
    if (!this.webhookUrl) throw new Error("Slack channel has neither a webhook URL nor a bot token with a channel to post to");
    return this.webhookUrl;
  }

  async send(notification: Notification): Promise<void> {
    const bot = await this.botTarget(notification);
    if (bot) {
      await bot.poster.post(bot.chatId, botText(notification), { threadTs: bot.threadTs });
      return;
    }
    const webhookUrl = this.requireWebhook();
    const severityColor: Record<string, string> = {
      info: "#36a64f",
      warning: "#daa520",
      critical: "#ff0000",
    };

    const payload = {
      attachments: [
        {
          color: severityColor[notification.severity] ?? "#36a64f",
          title: notification.title,
          text: notification.body,
          footer: `Polpo | ${notification.sourceEvent}`,
          ts: Math.floor(new Date(notification.timestamp).getTime() / 1000).toString(),
        },
      ],
    };

    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`Slack webhook failed: ${response.status} ${response.statusText}`);
    }
  }

  async sendWithAttachments(notification: Notification, attachments: OutcomeAttachment[]): Promise<void> {
    const bot = await this.botTarget(notification);
    if (bot) {
      const files = attachments.filter((a) => a.filePath).map((a) => ({ path: a.filePath!, filename: basename(a.filePath!) }));
      await bot.poster.post(bot.chatId, botText(notification), { threadTs: bot.threadTs, files });
      return;
    }
    // Send the main message first
    await this.send(notification);

    if (!this.apiToken) {
      // No bot token — send outcome summaries as follow-up webhook messages
      for (const att of attachments) {
        const label = att.label;
        const info = att.filePath ? `${basename(att.filePath)} (${formatBytes(att.size ?? 0)})` : att.type;
        const text = att.text ? `\`\`\`\n${att.text.slice(0, 2800)}\n\`\`\`` : info;

        await fetch(this.requireWebhook(), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: `*${label}*\n${text}` }),
        }).catch(() => {}); // best-effort
      }
      return;
    }

    // Upload files via Slack API (files.uploadV2)
    for (const att of attachments) {
      if (!att.content || !att.filePath) continue;
      try {
        const filename = basename(att.filePath);
        const blob = new Blob([att.content as BlobPart], { type: att.mimeType ?? "application/octet-stream" });
        const form = new FormData();
        form.append("file", blob, filename);
        form.append("filename", filename);
        form.append("title", att.label);
        form.append("initial_comment", `Outcome: ${att.label}`);

        await fetch("https://slack.com/api/files.upload", {
          method: "POST",
          headers: { "Authorization": `Bearer ${this.apiToken}` },
          body: form,
        });
      } catch {
        // best-effort
      }
    }
  }

  async test(): Promise<boolean> {
    const poster = this.poster?.();
    if (!this.webhookUrl) return poster ? poster.test() : false;
    try {
      // Slack webhooks don't have a test endpoint — just validate URL format
      const url = new URL(this.webhookUrl);
      return url.hostname.includes("slack.com") || url.hostname.includes("hooks.slack.com");
    } catch {
      return false;
    }
  }
}

/** A notification as one bot message: the title in bold (not for conversation replies), then the body. */
function botText(n: Notification): string {
  const title = n.title && n.sourceEvent !== "channel:reply" ? `**${n.title}**\n` : "";
  return `${title}${n.body}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function resolveEnvVar(value: string): string {
  if (value.startsWith("${") && value.endsWith("}")) {
    const envKey = value.slice(2, -1);
    return process.env[envKey] ?? "";
  }
  return value;
}
