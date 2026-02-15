import type { NotificationChannel, Notification, OutcomeAttachment } from "../types.js";
import type { NotificationChannelConfig } from "../../core/types.js";
import { basename } from "node:path";

/**
 * Generic HTTP webhook notification channel.
 * Sends the full notification as a JSON POST request.
 *
 * Configuration:
 *   url: Target webhook URL
 *   headers: Optional custom headers
 */
export class WebhookChannel implements NotificationChannel {
  readonly type = "webhook";
  private url: string;
  private headers: Record<string, string>;

  constructor(config: NotificationChannelConfig) {
    const url = resolveEnvVar(config.url ?? "");
    if (!url) throw new Error("Webhook channel requires url");
    this.url = url;
    this.headers = {};
    if (config.headers) {
      for (const [k, v] of Object.entries(config.headers)) {
        this.headers[k] = resolveEnvVar(v);
      }
    }
  }

  async send(notification: Notification): Promise<void> {
    const response = await fetch(this.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...this.headers,
      },
      body: JSON.stringify({
        id: notification.id,
        event: notification.sourceEvent,
        severity: notification.severity,
        title: notification.title,
        body: notification.body,
        data: notification.sourceData,
        timestamp: notification.timestamp,
        ruleId: notification.ruleId,
      }),
    });

    if (!response.ok) {
      throw new Error(`Webhook failed: ${response.status} ${response.statusText}`);
    }
  }

  async sendWithAttachments(notification: Notification, attachments: OutcomeAttachment[]): Promise<void> {
    // Include attachments as base64-encoded data in the JSON payload
    const attachmentPayloads = attachments.map(att => ({
      label: att.label,
      type: att.type,
      filename: att.filePath ? basename(att.filePath) : undefined,
      mimeType: att.mimeType,
      size: att.size,
      text: att.text,
      url: att.url,
      // Base64-encode file content for JSON transport
      contentBase64: att.content ? att.content.toString("base64") : undefined,
    }));

    const response = await fetch(this.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...this.headers,
      },
      body: JSON.stringify({
        id: notification.id,
        event: notification.sourceEvent,
        severity: notification.severity,
        title: notification.title,
        body: notification.body,
        data: notification.sourceData,
        timestamp: notification.timestamp,
        ruleId: notification.ruleId,
        attachments: attachmentPayloads,
      }),
    });

    if (!response.ok) {
      throw new Error(`Webhook failed: ${response.status} ${response.statusText}`);
    }
  }

  async test(): Promise<boolean> {
    try {
      new URL(this.url);
      return true;
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
