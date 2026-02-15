import type { NotificationChannel, Notification } from "../types.js";
import type { NotificationChannelConfig } from "../../core/types.js";

/**
 * Email notification channel — sends emails via HTTP API (Resend/SendGrid)
 * or SMTP.
 *
 * Configuration:
 *   provider: "resend" | "sendgrid" | "smtp"
 *   apiKey: API key for the provider
 *   to: array of recipient email addresses
 *   from: sender address (for SMTP)
 *   host/port: SMTP server (for SMTP provider)
 */
export class EmailChannel implements NotificationChannel {
  readonly type = "email";
  private provider: string;
  private apiKey: string;
  private to: string[];
  private from: string;
  private host?: string;
  private port?: number;

  constructor(config: NotificationChannelConfig) {
    this.provider = config.provider ?? "resend";
    this.apiKey = resolveEnvVar(config.apiKey ?? "");
    this.to = config.to ?? [];
    this.from = config.from ?? "polpo@notifications.local";
    this.host = config.host;
    this.port = config.port;

    if (this.to.length === 0) throw new Error("Email channel requires at least one recipient (to)");
    if (!this.apiKey && this.provider !== "smtp") {
      throw new Error(`Email channel (${this.provider}) requires apiKey`);
    }
  }

  async send(notification: Notification): Promise<void> {
    switch (this.provider) {
      case "resend":
        return this.sendViaResend(notification);
      case "sendgrid":
        return this.sendViaSendGrid(notification);
      case "smtp":
        return this.sendViaSMTP(notification);
      default:
        throw new Error(`Unknown email provider: ${this.provider}`);
    }
  }

  private async sendViaResend(notification: Notification): Promise<void> {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        from: this.from,
        to: this.to,
        subject: notification.title,
        text: notification.body,
        html: markdownToSimpleHtml(notification.body),
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Resend API failed: ${response.status} — ${body}`);
    }
  }

  private async sendViaSendGrid(notification: Notification): Promise<void> {
    const response = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        personalizations: [{ to: this.to.map(email => ({ email })) }],
        from: { email: this.from },
        subject: notification.title,
        content: [
          { type: "text/plain", value: notification.body },
          { type: "text/html", value: markdownToSimpleHtml(notification.body) },
        ],
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`SendGrid API failed: ${response.status} — ${body}`);
    }
  }

  private async sendViaSMTP(_notification: Notification): Promise<void> {
    // SMTP requires nodemailer or similar — defer to dynamic import
    // For now, throw a helpful error
    throw new Error(
      "SMTP email delivery requires the 'nodemailer' package. " +
      "Install it with: npm install nodemailer. " +
      "Consider using 'resend' or 'sendgrid' provider instead."
    );
  }

  async test(): Promise<boolean> {
    try {
      switch (this.provider) {
        case "resend": {
          const resp = await fetch("https://api.resend.com/domains", {
            headers: { "Authorization": `Bearer ${this.apiKey}` },
          });
          return resp.ok;
        }
        case "sendgrid": {
          const resp = await fetch("https://api.sendgrid.com/v3/scopes", {
            headers: { "Authorization": `Bearer ${this.apiKey}` },
          });
          return resp.ok;
        }
        default:
          return !!this.apiKey || (!!this.host && !!this.port);
      }
    } catch {
      return false;
    }
  }
}

/** Simple markdown to HTML conversion (bold, italic, line breaks). */
function markdownToSimpleHtml(md: string): string {
  return md
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/_(.+?)_/g, "<em>$1</em>")
    .replace(/\n/g, "<br>");
}

function resolveEnvVar(value: string): string {
  if (value.startsWith("${") && value.endsWith("}")) {
    const envKey = value.slice(2, -1);
    return process.env[envKey] ?? "";
  }
  return value;
}
