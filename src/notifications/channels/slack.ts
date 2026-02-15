import type { NotificationChannel, Notification, OutcomeAttachment } from "../types.js";
import type { NotificationChannelConfig } from "../../core/types.js";
import { basename } from "node:path";

/**
 * Slack notification channel — sends messages via Incoming Webhook.
 *
 * For attachments, outcome metadata is included as extra fields in the webhook
 * payload. Note: Incoming Webhooks cannot upload files — that requires a
 * Slack API token with files:write scope. If apiKey is set, we use
 * files.uploadV2 for real file uploads. Otherwise, we include file info
 * as extra text blocks in the message.
 *
 * Configuration:
 *   webhookUrl: Slack Incoming Webhook URL
 *   apiKey: (Optional) Slack Bot Token for file uploads
 */
export class SlackChannel implements NotificationChannel {
  readonly type = "slack";
  private webhookUrl: string;
  private apiToken?: string;

  constructor(config: NotificationChannelConfig) {
    const url = resolveEnvVar(config.webhookUrl ?? "");
    if (!url) throw new Error("Slack channel requires webhookUrl");
    this.webhookUrl = url;
    const token = resolveEnvVar(config.apiKey ?? "");
    if (token) this.apiToken = token;
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

  async sendWithAttachments(notification: Notification, attachments: OutcomeAttachment[]): Promise<void> {
    // Send the main message first
    await this.send(notification);

    if (!this.apiToken) {
      // No bot token — send outcome summaries as follow-up webhook messages
      for (const att of attachments) {
        const label = att.label;
        const info = att.filePath ? `${basename(att.filePath)} (${formatBytes(att.size ?? 0)})` : att.type;
        const text = att.text ? `\`\`\`\n${att.text.slice(0, 2800)}\n\`\`\`` : info;

        await fetch(this.webhookUrl, {
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
    try {
      // Slack webhooks don't have a test endpoint — just validate URL format
      const url = new URL(this.webhookUrl);
      return url.hostname.includes("slack.com") || url.hostname.includes("hooks.slack.com");
    } catch {
      return false;
    }
  }
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
