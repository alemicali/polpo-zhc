/**
 * Email tools for sending messages via SMTP.
 *
 * Provides tools for agents to:
 * - Send emails with HTML or plain text
 * - Add attachments from local files
 * - Send to multiple recipients (to, cc, bcc)
 *
 * Uses `nodemailer` for SMTP transport.
 * SMTP configuration is passed via environment variables or tool parameters.
 *
 * Required env vars for SMTP:
 *   SMTP_HOST - SMTP server hostname
 *   SMTP_PORT - SMTP port (default: 587)
 *   SMTP_USER - SMTP username
 *   SMTP_PASS - SMTP password
 *   SMTP_FROM - Default sender address
 *
 * Or pass connection details directly in tool parameters.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, basename } from "node:path";
import { Type } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { resolveAllowedPaths, assertPathAllowed } from "./path-sandbox.js";

// ─── Tool: email_send ───

const EmailSendSchema = Type.Object({
  to: Type.Union([
    Type.String(),
    Type.Array(Type.String()),
  ], { description: "Recipient email address(es)" }),
  subject: Type.String({ description: "Email subject line" }),
  body: Type.String({ description: "Email body content (plain text or HTML)" }),
  html: Type.Optional(Type.Boolean({ description: "Treat body as HTML (default: auto-detect)" })),
  cc: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())], { description: "CC recipients" })),
  bcc: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())], { description: "BCC recipients" })),
  from: Type.Optional(Type.String({ description: "Sender address (overrides SMTP_FROM env var)" })),
  reply_to: Type.Optional(Type.String({ description: "Reply-to address" })),
  attachments: Type.Optional(Type.Array(
    Type.Object({
      path: Type.String({ description: "File path of the attachment" }),
      filename: Type.Optional(Type.String({ description: "Override filename in the email" })),
    }),
    { description: "File attachments" },
  )),
  // SMTP config overrides (optional - defaults to env vars)
  smtp_host: Type.Optional(Type.String({ description: "SMTP host (overrides SMTP_HOST env var)" })),
  smtp_port: Type.Optional(Type.Number({ description: "SMTP port (overrides SMTP_PORT env var)" })),
  smtp_user: Type.Optional(Type.String({ description: "SMTP user (overrides SMTP_USER env var)" })),
  smtp_pass: Type.Optional(Type.String({ description: "SMTP password (overrides SMTP_PASS env var)" })),
  smtp_secure: Type.Optional(Type.Boolean({ description: "Use TLS (default: true for port 465, STARTTLS for others)" })),
});

function createEmailSendTool(cwd: string, sandbox: string[]): AgentTool<typeof EmailSendSchema> {
  return {
    name: "email_send",
    label: "Send Email",
    description: "Send an email via SMTP. Supports HTML content, multiple recipients (to/cc/bcc), " +
      "file attachments, and reply-to. Configure SMTP via environment variables (SMTP_HOST, SMTP_PORT, " +
      "SMTP_USER, SMTP_PASS, SMTP_FROM) or pass parameters directly.",
    parameters: EmailSendSchema,
    async execute(_id, params) {
      // Resolve SMTP config from params or env
      const host = params.smtp_host ?? process.env.SMTP_HOST;
      const port = params.smtp_port ?? Number(process.env.SMTP_PORT ?? "587");
      const user = params.smtp_user ?? process.env.SMTP_USER;
      const pass = params.smtp_pass ?? process.env.SMTP_PASS;
      const from = params.from ?? process.env.SMTP_FROM;

      if (!host) {
        return {
          content: [{ type: "text", text: "Error: SMTP host not configured. Set SMTP_HOST env var or pass smtp_host parameter." }],
          details: { error: "no_smtp_host" },
        };
      }
      if (!from) {
        return {
          content: [{ type: "text", text: "Error: Sender address not configured. Set SMTP_FROM env var or pass 'from' parameter." }],
          details: { error: "no_from" },
        };
      }

      try {
        const nodemailer = await import("nodemailer");

        const secure = params.smtp_secure ?? (port === 465);
        const transporter = nodemailer.default.createTransport({
          host,
          port,
          secure,
          auth: user ? { user, pass } : undefined,
        });

        // Process attachments
        const attachments: Array<{ filename: string; content: Buffer }> = [];
        if (params.attachments) {
          for (const att of params.attachments) {
            const attPath = resolve(cwd, att.path);
            assertPathAllowed(attPath, sandbox, "email_send");
            if (!existsSync(attPath)) {
              return {
                content: [{ type: "text", text: `Error: attachment not found: ${att.path}` }],
                details: { error: "attachment_not_found", path: att.path },
              };
            }
            attachments.push({
              filename: att.filename ?? basename(attPath),
              content: readFileSync(attPath),
            });
          }
        }

        // Detect HTML
        const isHtml = params.html ?? (params.body.includes("<") && params.body.includes(">"));

        const mailOptions: Record<string, any> = {
          from,
          to: Array.isArray(params.to) ? params.to.join(", ") : params.to,
          subject: params.subject,
          ...(isHtml ? { html: params.body } : { text: params.body }),
          ...(params.cc && { cc: Array.isArray(params.cc) ? params.cc.join(", ") : params.cc }),
          ...(params.bcc && { bcc: Array.isArray(params.bcc) ? params.bcc.join(", ") : params.bcc }),
          ...(params.reply_to && { replyTo: params.reply_to }),
          ...(attachments.length > 0 && { attachments }),
        };

        const info = await transporter.sendMail(mailOptions);

        const recipientCount = (Array.isArray(params.to) ? params.to.length : 1) +
          (params.cc ? (Array.isArray(params.cc) ? params.cc.length : 1) : 0) +
          (params.bcc ? (Array.isArray(params.bcc) ? params.bcc.length : 1) : 0);

        return {
          content: [{ type: "text", text: `Email sent successfully!\nTo: ${params.to}\nSubject: ${params.subject}\nMessage ID: ${info.messageId}\nRecipients: ${recipientCount}${attachments.length ? `\nAttachments: ${attachments.length}` : ""}` }],
          details: {
            messageId: info.messageId,
            accepted: info.accepted,
            rejected: info.rejected,
            recipients: recipientCount,
            attachments: attachments.length,
          },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Email send error: ${err.message}` }],
          details: { error: err.message },
        };
      }
    },
  };
}

// ─── Tool: email_verify ───

const EmailVerifySchema = Type.Object({
  smtp_host: Type.Optional(Type.String({ description: "SMTP host (overrides SMTP_HOST env var)" })),
  smtp_port: Type.Optional(Type.Number({ description: "SMTP port" })),
  smtp_user: Type.Optional(Type.String({ description: "SMTP user" })),
  smtp_pass: Type.Optional(Type.String({ description: "SMTP password" })),
});

function createEmailVerifyTool(): AgentTool<typeof EmailVerifySchema> {
  return {
    name: "email_verify",
    label: "Verify SMTP",
    description: "Verify SMTP connection and credentials. Use to check that email is properly configured before sending.",
    parameters: EmailVerifySchema,
    async execute(_id, params) {
      const host = params.smtp_host ?? process.env.SMTP_HOST;
      const port = params.smtp_port ?? Number(process.env.SMTP_PORT ?? "587");
      const user = params.smtp_user ?? process.env.SMTP_USER;
      const pass = params.smtp_pass ?? process.env.SMTP_PASS;

      if (!host) {
        return {
          content: [{ type: "text", text: "Error: SMTP host not configured. Set SMTP_HOST env var or pass smtp_host parameter." }],
          details: { error: "no_smtp_host", verified: false },
        };
      }

      try {
        const nodemailer = await import("nodemailer");
        const secure = port === 465;
        const transporter = nodemailer.default.createTransport({
          host,
          port,
          secure,
          auth: user ? { user, pass } : undefined,
        });

        await transporter.verify();

        return {
          content: [{ type: "text", text: `SMTP connection verified: ${host}:${port} (user: ${user ?? "none"})` }],
          details: { verified: true, host, port },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `SMTP verification failed: ${err.message}` }],
          details: { verified: false, error: err.message },
        };
      }
    },
  };
}

// ─── Factory ───

export type EmailToolName = "email_send" | "email_verify";

export const ALL_EMAIL_TOOL_NAMES: EmailToolName[] = ["email_send", "email_verify"];

/**
 * Create email tools.
 *
 * @param cwd - Working directory (for resolving attachment paths)
 * @param allowedPaths - Sandbox paths
 * @param allowedTools - Optional filter
 */
export function createEmailTools(cwd: string, allowedPaths?: string[], allowedTools?: string[]): AgentTool<any>[] {
  const sandbox = resolveAllowedPaths(cwd, allowedPaths);

  const factories: Record<EmailToolName, () => AgentTool<any>> = {
    email_send: () => createEmailSendTool(cwd, sandbox),
    email_verify: () => createEmailVerifyTool(),
  };

  const names = allowedTools
    ? ALL_EMAIL_TOOL_NAMES.filter(n => allowedTools.some(a => a.toLowerCase() === n))
    : ALL_EMAIL_TOOL_NAMES;

  return names.map(n => factories[n]());
}
