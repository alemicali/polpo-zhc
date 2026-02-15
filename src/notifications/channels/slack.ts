import type { NotificationChannel, Notification } from "../types.js";
import type { NotificationChannelConfig } from "../../core/types.js";

/**
 * Slack notification channel — sends messages via Incoming Webhook.
 *
 * Configuration:
 *   webhookUrl: Slack Incoming Webhook URL
 */
export class SlackChannel implements NotificationChannel {
  readonly type = "slack";
  private webhookUrl: string;

  constructor(config: NotificationChannelConfig) {
    const url = resolveEnvVar(config.webhookUrl ?? "");
    if (!url) throw new Error("Slack channel requires webhookUrl");
    this.webhookUrl = url;
  }

  async send(notification: Notification): Promise<void> {
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

    const response = await fetch(this.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`Slack webhook failed: ${response.status} ${response.statusText}`);
    }
  }

  async test(): Promise<boolean> {
    try {
      // Slack webhooks don't have a test endpoint — just validate URL format
      const url = new URL(this.webhookUrl);
      return url.hostname.includes("slack.com") || url.hostname.includes("hooks.slack.com");
    } catch {
      return false;
    }
  }
}

function resolveEnvVar(value: string): string {
  if (value.startsWith("${") && value.endsWith("}")) {
    const envKey = value.slice(2, -1);
    return process.env[envKey] ?? "";
  }
  return value;
}
