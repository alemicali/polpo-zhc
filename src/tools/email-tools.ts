/**
 * Email tools for sending and reading messages via SMTP/IMAP.
 *
 * Provides tools for agents to:
 * - Send emails with HTML or plain text (SMTP)
 * - Save draft emails to IMAP Drafts folder
 * - Add attachments from local files
 * - Send to multiple recipients (to, cc, bcc)
 * - List, read, and search emails (IMAP)
 *
 * Credential resolution order:
 *   1. Tool parameters (explicit overrides)
 *   2. Agent vault (per-agent credentials from polpo.json)
 *   3. Environment variables (global fallback)
 *
 * SMTP env vars: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM
 * IMAP env vars: IMAP_HOST, IMAP_PORT, IMAP_USER, IMAP_PASS
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, basename, join, dirname } from "node:path";
import { Type } from "@sinclair/typebox";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { resolveAllowedPaths, assertPathAllowed } from "./path-sandbox.js";
import type { ResolvedVault } from "../vault/index.js";

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
  from: Type.Optional(Type.String({ description: "Sender address (overrides vault/env)" })),
  reply_to: Type.Optional(Type.String({ description: "Reply-to address" })),
  attachments: Type.Optional(Type.Array(
    Type.Object({
      path: Type.String({ description: "File path of the attachment" }),
      filename: Type.Optional(Type.String({ description: "Override filename in the email" })),
    }),
    { description: "File attachments" },
  )),
  // SMTP config overrides (optional - defaults to vault then env vars)
  smtp_host: Type.Optional(Type.String({ description: "SMTP host (overrides vault/env)" })),
  smtp_port: Type.Optional(Type.Number({ description: "SMTP port (overrides vault/env)" })),
  smtp_user: Type.Optional(Type.String({ description: "SMTP user (overrides vault/env)" })),
  smtp_pass: Type.Optional(Type.String({ description: "SMTP password (overrides vault/env)" })),
  smtp_secure: Type.Optional(Type.Boolean({ description: "Use TLS (default: true for port 465, STARTTLS for others)" })),
});

const EmailDraftSchema = Type.Object({
  to: Type.Optional(Type.Union([
    Type.String(),
    Type.Array(Type.String()),
  ], { description: "Recipient email address(es)" })),
  subject: Type.Optional(Type.String({ description: "Email subject line" })),
  body: Type.Optional(Type.String({ description: "Draft body content (plain text or HTML)" })),
  html: Type.Optional(Type.Boolean({ description: "Treat body as HTML (default: auto-detect)" })),
  cc: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())], { description: "CC recipients" })),
  bcc: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())], { description: "BCC recipients" })),
  from: Type.Optional(Type.String({ description: "Sender address (defaults to SMTP_FROM or IMAP user)" })),
  reply_to: Type.Optional(Type.String({ description: "Reply-to address" })),
  attachments: Type.Optional(Type.Array(
    Type.Object({
      path: Type.String({ description: "File path of the attachment" }),
      filename: Type.Optional(Type.String({ description: "Override filename in the draft" })),
    }),
    { description: "File attachments" },
  )),
  folder: Type.Optional(Type.String({ description: "Drafts folder path (default: auto-detect from IMAP special-use, then 'Drafts')" })),
  imap_host: Type.Optional(Type.String({ description: "IMAP host (overrides vault/env)" })),
  imap_port: Type.Optional(Type.Number({ description: "IMAP port (overrides vault/env)" })),
  imap_user: Type.Optional(Type.String({ description: "IMAP user (overrides vault/env)" })),
  imap_pass: Type.Optional(Type.String({ description: "IMAP password (overrides vault/env)" })),
  imap_tls: Type.Optional(Type.Boolean({ description: "Use TLS for IMAP (overrides vault/env)" })),
});

/**
 * Validate that all recipient addresses are in allowed domains.
 * Throws if any address has a domain not in the allowlist.
 */
function validateRecipientDomains(addresses: string | string[], allowedDomains: string[]): void {
  const addrs = Array.isArray(addresses) ? addresses : [addresses];
  for (const addr of addrs) {
    const atIdx = addr.lastIndexOf("@");
    if (atIdx < 0) continue; // malformed — let SMTP reject it
    const domain = addr.slice(atIdx + 1).toLowerCase().trim();
    if (!allowedDomains.some(d => d.toLowerCase() === domain)) {
      throw new Error(`Recipient domain "${domain}" is not in the allowed domains: ${allowedDomains.join(", ")}`);
    }
  }
}

function createEmailSendTool(cwd: string, sandbox: string[], vault?: ResolvedVault, emailAllowedDomains?: string[]): AgentTool<typeof EmailSendSchema> {
  return {
    name: "email_send",
    label: "Send Email",
    description: "Send an email via SMTP. Supports HTML content, multiple recipients (to/cc/bcc), " +
      "file attachments, and reply-to. Credentials are resolved from: tool params > agent vault > env vars.",
    parameters: EmailSendSchema,
    async execute(_id, params) {
      // Resolve SMTP config: tool params > vault > env vars
      const vaultSmtp = vault?.getSmtp();
      const host = params.smtp_host ?? vaultSmtp?.host ?? process.env.SMTP_HOST;
      const port = params.smtp_port ?? vaultSmtp?.port ?? Number(process.env.SMTP_PORT ?? "587");
      const user = params.smtp_user ?? vaultSmtp?.user ?? process.env.SMTP_USER;
      const pass = params.smtp_pass ?? vaultSmtp?.pass ?? process.env.SMTP_PASS;
      const from = params.from ?? vaultSmtp?.from ?? process.env.SMTP_FROM;

      if (!host) throw new Error("SMTP host not configured. Set SMTP_HOST env var, configure vault, or pass smtp_host parameter.");
      if (!from) throw new Error("Sender address not configured. Set SMTP_FROM env var, configure vault, or pass 'from' parameter.");

      // Validate recipient domains against allowlist
      if (emailAllowedDomains && emailAllowedDomains.length > 0) {
        validateRecipientDomains(params.to, emailAllowedDomains);
        if (params.cc) validateRecipientDomains(params.cc, emailAllowedDomains);
        if (params.bcc) validateRecipientDomains(params.bcc, emailAllowedDomains);
      }

      const nodemailer = await import("nodemailer");

      const secure = params.smtp_secure ?? vaultSmtp?.secure ?? (port === 465);
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
          if (!existsSync(attPath)) throw new Error(`Attachment not found: ${att.path}`);
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

      // Check for rejected recipients
      if (info.rejected?.length) {
        throw new Error(`Email rejected by server for: ${info.rejected.join(", ")}`);
      }

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
    },
  };
}

function createEmailDraftTool(cwd: string, sandbox: string[], vault?: ResolvedVault, emailAllowedDomains?: string[]): AgentTool<typeof EmailDraftSchema> {
  return {
    name: "email_draft",
    label: "Save Draft Email",
    description: "Create a draft email by appending a composed message to the IMAP Drafts folder. " +
      "Supports HTML content, multiple recipients (to/cc/bcc), and file attachments.",
    parameters: EmailDraftSchema,
    async execute(_id, params) {
      if (emailAllowedDomains && emailAllowedDomains.length > 0) {
        if (params.to) validateRecipientDomains(params.to, emailAllowedDomains);
        if (params.cc) validateRecipientDomains(params.cc, emailAllowedDomains);
        if (params.bcc) validateRecipientDomains(params.bcc, emailAllowedDomains);
      }

      const vaultSmtp = vault?.getSmtp();
      const vaultImap = vault?.getImap();
      const from = params.from ?? vaultSmtp?.from ?? process.env.SMTP_FROM ?? vaultImap?.user ?? process.env.IMAP_USER;

      const attachments: Array<{ filename: string; content: Buffer }> = [];
      if (params.attachments) {
        for (const att of params.attachments) {
          const attPath = resolve(cwd, att.path);
          assertPathAllowed(attPath, sandbox, "email_draft");
          if (!existsSync(attPath)) throw new Error(`Attachment not found: ${att.path}`);
          attachments.push({
            filename: att.filename ?? basename(attPath),
            content: readFileSync(attPath),
          });
        }
      }

      const body = params.body ?? "";
      const isHtml = params.html ?? (body.includes("<") && body.includes(">"));

      const nodemailer = await import("nodemailer");
      const streamTransport = nodemailer.default.createTransport({
        streamTransport: true,
        buffer: true,
        newline: "windows",
      });

      const mailOptions: Record<string, any> = {
        ...(from && { from }),
        ...(params.to && { to: Array.isArray(params.to) ? params.to.join(", ") : params.to }),
        ...(params.cc && { cc: Array.isArray(params.cc) ? params.cc.join(", ") : params.cc }),
        ...(params.bcc && { bcc: Array.isArray(params.bcc) ? params.bcc.join(", ") : params.bcc }),
        subject: params.subject ?? "",
        ...(isHtml ? { html: body } : { text: body }),
        ...(params.reply_to && { replyTo: params.reply_to }),
        ...(attachments.length > 0 && { attachments }),
      };

      const composed = await streamTransport.sendMail(mailOptions) as { message?: Buffer };
      const rawMessage = composed.message;
      if (!rawMessage || !Buffer.isBuffer(rawMessage)) {
        throw new Error("Failed to compose draft message as RFC822 buffer");
      }

      const client = await connectImap(vault, {
        host: params.imap_host,
        port: params.imap_port,
        user: params.imap_user,
        pass: params.imap_pass,
        tls: params.imap_tls,
      });

      try {
        const folder = params.folder ?? await detectDraftFolder(client);
        const appendResult = await client.append(folder, rawMessage, ["\\Draft"]);

        return {
          content: [{ type: "text", text: `Draft saved successfully!\nFolder: ${folder}\nSubject: ${params.subject ?? "(no subject)"}${params.to ? `\nTo: ${params.to}` : ""}` }],
          details: {
            folder,
            subject: params.subject ?? "",
            to: params.to,
            attachments: attachments.length,
            append: appendResult,
          },
        };
      } finally {
        await client.logout();
      }
    },
  };
}

// ─── Tool: email_verify ───

const EmailVerifySchema = Type.Object({
  smtp_host: Type.Optional(Type.String({ description: "SMTP host (overrides vault/env)" })),
  smtp_port: Type.Optional(Type.Number({ description: "SMTP port" })),
  smtp_user: Type.Optional(Type.String({ description: "SMTP user" })),
  smtp_pass: Type.Optional(Type.String({ description: "SMTP password" })),
});

function createEmailVerifyTool(vault?: ResolvedVault): AgentTool<typeof EmailVerifySchema> {
  return {
    name: "email_verify",
    label: "Verify SMTP",
    description: "Verify SMTP connection and credentials. Use to check that email is properly configured before sending.",
    parameters: EmailVerifySchema,
    async execute(_id, params) {
      const vaultSmtp = vault?.getSmtp();
      const host = params.smtp_host ?? vaultSmtp?.host ?? process.env.SMTP_HOST;
      const port = params.smtp_port ?? vaultSmtp?.port ?? Number(process.env.SMTP_PORT ?? "587");
      const user = params.smtp_user ?? vaultSmtp?.user ?? process.env.SMTP_USER;
      const pass = params.smtp_pass ?? vaultSmtp?.pass ?? process.env.SMTP_PASS;

      if (!host) throw new Error("SMTP host not configured. Set SMTP_HOST env var, configure vault, or pass smtp_host parameter.");

      const nodemailer = await import("nodemailer");
      const secure = vaultSmtp?.secure ?? (port === 465);
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
    },
  };
}

// ─── IMAP Tools ───

/** Helper: connect to IMAP server using vault or env vars */
type ImapConnectionOverrides = {
  host?: string;
  port?: number;
  user?: string;
  pass?: string;
  tls?: boolean;
};

async function connectImap(vault?: ResolvedVault, overrides?: ImapConnectionOverrides) {
  const vaultImap = vault?.getImap();
  const host = overrides?.host ?? vaultImap?.host ?? process.env.IMAP_HOST;
  const port = overrides?.port ?? vaultImap?.port ?? Number(process.env.IMAP_PORT ?? "993");
  const user = overrides?.user ?? vaultImap?.user ?? process.env.IMAP_USER;
  const pass = overrides?.pass ?? vaultImap?.pass ?? process.env.IMAP_PASS;
  const tls = overrides?.tls ?? vaultImap?.tls ?? true;

  if (!host) throw new Error("IMAP host not configured. Set IMAP_HOST env var or configure vault.");
  if (!user) throw new Error("IMAP user not configured. Set IMAP_USER env var or configure vault.");

  const { ImapFlow } = await import("imapflow");
  const client = new ImapFlow({
    host,
    port,
    secure: tls,
    auth: { user, pass: pass ?? "" },
    logger: false as any,
  });
  await client.connect();
  return client;
}

async function detectDraftFolder(client: any): Promise<string> {
  try {
    for await (const mailbox of client.list()) {
      if (mailbox?.specialUse === "\\Drafts") {
        return mailbox.path;
      }
      const flags = mailbox?.flags;
      if (flags instanceof Set && flags.has("\\Drafts")) {
        return mailbox.path;
      }
      if (Array.isArray(flags) && flags.includes("\\Drafts")) {
        return mailbox.path;
      }
    }
  } catch {
    // Fall back to conventional Drafts folder name.
  }
  return "Drafts";
}

// ─── Tool: email_list ───

const EmailListSchema = Type.Object({
  folder: Type.Optional(Type.String({ description: "Mail folder (default: INBOX)" })),
  limit: Type.Optional(Type.Number({ description: "Max emails to return (default: 20)" })),
  unseen_only: Type.Optional(Type.Boolean({ description: "Only show unread emails (default: false)" })),
});

function createEmailListTool(vault?: ResolvedVault): AgentTool<typeof EmailListSchema> {
  return {
    name: "email_list",
    label: "List Emails",
    description: "List recent emails from the inbox (or specified folder). Returns subject, from, date, and UID for each message. Use email_read to get full content.",
    parameters: EmailListSchema,
    async execute(_id, params) {
      const client = await connectImap(vault);
      const folder = params.folder ?? "INBOX";
      const limit = params.limit ?? 20;

      const lock = await client.getMailboxLock(folder);
      try {
        const messages: string[] = [];
        let count = 0;

        // Fetch recent messages (newest first)
        const searchCriteria = params.unseen_only ? { seen: false } : { all: true };
        const searchResult = await client.search(searchCriteria, { uid: true });
        const uids = Array.isArray(searchResult) ? searchResult : [];

        // Get the last N UIDs
        const targetUids = uids.slice(-limit).reverse();

        for (const uid of targetUids) {
          const msg = await client.fetchOne(String(uid), { envelope: true, uid: true, flags: true }, { uid: true }) as any;
          if (!msg?.envelope) continue;

          const env = msg.envelope;
          const fromAddr = env.from?.[0] ? `${env.from[0].name ?? ""} <${env.from[0].address ?? ""}>`.trim() : "unknown";
          const date = env.date ? new Date(env.date).toISOString() : "unknown";
          const unread = !msg.flags?.has("\\Seen") ? " [UNREAD]" : "";

          messages.push(`UID: ${msg.uid} | ${date} | From: ${fromAddr} | Subject: ${env.subject ?? "(no subject)"}${unread}`);
          count++;
        }

        return {
          content: [{ type: "text", text: messages.length > 0 ? `${folder} — ${count} message(s):\n\n${messages.join("\n")}` : `${folder} — no messages found` }],
          details: { folder, count },
        };
      } finally {
        lock.release();
        await client.logout();
      }
    },
  };
}

// ─── Attachment Helpers ───

interface AttachmentInfo {
  /** MIME part number (e.g. "2", "1.2") — pass this to email_download_attachment */
  part: string;
  /** Filename from Content-Disposition or Content-Type name parameter */
  filename: string;
  /** MIME type (e.g. "application/pdf") */
  mimeType: string;
  /** Approximate size in bytes */
  size?: number;
  /** Content-Transfer-Encoding */
  encoding?: string;
}

/**
 * Walk a bodyStructure tree and collect attachment metadata.
 * Attachments are parts with disposition=attachment, or non-text/non-multipart
 * inline parts that have a filename.
 */
function findAttachments(node: any, path: number[] = []): AttachmentInfo[] {
  const attachments: AttachmentInfo[] = [];
  if (!node) return attachments;

  const isAttachment =
    node.disposition === "attachment" ||
    (node.disposition === "inline" && (node.dispositionParameters?.filename || node.parameters?.name)) ||
    (node.type && node.type !== "text" && node.type !== "multipart" && !node.disposition &&
      (node.dispositionParameters?.filename || node.parameters?.name));

  if (isAttachment) {
    const filename =
      node.dispositionParameters?.filename ??
      node.parameters?.name ??
      `attachment-${path.join(".")}`;
    attachments.push({
      part: path.length ? path.join(".") : "1",
      filename,
      mimeType: `${node.type ?? "application"}/${node.subtype ?? "octet-stream"}`,
      size: node.size,
      encoding: node.encoding,
    });
  }

  if (node.childNodes && Array.isArray(node.childNodes)) {
    for (let i = 0; i < node.childNodes.length; i++) {
      attachments.push(...findAttachments(node.childNodes[i], [...path, i + 1]));
    }
  }

  return attachments;
}

// ─── Tool: email_read ───

const EmailReadSchema = Type.Object({
  uid: Type.Number({ description: "Email UID (from email_list)" }),
  folder: Type.Optional(Type.String({ description: "Mail folder (default: INBOX)" })),
  mark_read: Type.Optional(Type.Boolean({ description: "Mark as read after fetching (default: true)" })),
  download_attachments: Type.Optional(Type.Boolean({ description: "Download all attachments to the output directory (default: false). Use email_download_attachment for selective download." })),
});

function createEmailReadTool(vault?: ResolvedVault, outputDir?: string, sandbox?: string[]): AgentTool<typeof EmailReadSchema> {
  return {
    name: "email_read",
    label: "Read Email",
    description: "Read the full content of an email by UID. Returns headers, body text, and attachment metadata (filename, size, part ID). " +
      "Set download_attachments=true to save all attachments to the output directory, or use email_download_attachment for selective download.",
    parameters: EmailReadSchema,
    async execute(_id, params) {
      const client = await connectImap(vault);
      const folder = params.folder ?? "INBOX";
      const markRead = params.mark_read ?? true;

      const lock = await client.getMailboxLock(folder);
      try {
        const msg = await client.fetchOne(String(params.uid), {
          envelope: true,
          source: true,
          bodyStructure: true,
          uid: true,
          flags: true,
        }, { uid: true }) as any;

        if (!msg) throw new Error(`Email UID ${params.uid} not found in ${folder}`);

        const env = msg.envelope;
        const fromAddr = env?.from?.[0] ? `${env.from[0].name ?? ""} <${env.from[0].address ?? ""}>`.trim() : "unknown";
        const toAddr = env?.to?.map((a: any) => `${a.name ?? ""} <${a.address ?? ""}>`.trim()).join(", ") ?? "unknown";
        const date = env?.date ? new Date(env.date).toISOString() : "unknown";

        // Extract text body from source
        let bodyText = "";
        if (msg.source) {
          const source = msg.source.toString("utf-8");
          const headerEnd = source.indexOf("\r\n\r\n");
          if (headerEnd >= 0) {
            bodyText = source.slice(headerEnd + 4);
            if (bodyText.length > 10000) {
              bodyText = bodyText.slice(0, 10000) + "\n... (truncated)";
            }
          }
        }

        // Extract attachment metadata from bodyStructure
        const attachments = findAttachments(msg.bodyStructure);

        // Optionally download all attachments
        const downloadedFiles: string[] = [];
        if (params.download_attachments && attachments.length > 0) {
          const downloadDir = outputDir ?? process.cwd();
          for (const att of attachments) {
            const { content } = await client.download(String(params.uid), att.part, { uid: true }) as any;
            const chunks: Buffer[] = [];
            for await (const chunk of content) {
              chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            }
            const buffer = Buffer.concat(chunks);
            const filePath = join(downloadDir, att.filename);
            mkdirSync(dirname(filePath), { recursive: true });
            writeFileSync(filePath, buffer);
            downloadedFiles.push(filePath);
          }
        }

        // Mark as read if requested
        if (markRead) {
          try {
            await client.messageFlagsAdd(String(params.uid), ["\\Seen"], { uid: true });
          } catch { /* best-effort */ }
        }

        const parts = [
          `From: ${fromAddr}`,
          `To: ${toAddr}`,
          `Date: ${date}`,
          `Subject: ${env?.subject ?? "(no subject)"}`,
          `UID: ${msg.uid}`,
        ];

        if (attachments.length > 0) {
          parts.push(``, `Attachments (${attachments.length}):`);
          for (const att of attachments) {
            const sizeStr = att.size ? ` (${(att.size / 1024).toFixed(1)} KB)` : "";
            parts.push(`  - [part ${att.part}] ${att.filename} — ${att.mimeType}${sizeStr}`);
          }
          if (downloadedFiles.length > 0) {
            parts.push(``, `Downloaded to:`);
            for (const f of downloadedFiles) parts.push(`  - ${f}`);
          }
        }

        parts.push(``, bodyText || "(empty body)");

        return {
          content: [{ type: "text", text: parts.join("\n") }],
          details: {
            uid: params.uid,
            subject: env?.subject,
            attachments: attachments.map(a => ({ part: a.part, filename: a.filename, mimeType: a.mimeType, size: a.size })),
            downloadedFiles: downloadedFiles.length > 0 ? downloadedFiles : undefined,
          },
        };
      } finally {
        lock.release();
        await client.logout();
      }
    },
  };
}

// ─── Tool: email_download_attachment ───

const EmailDownloadAttachmentSchema = Type.Object({
  uid: Type.Number({ description: "Email UID (from email_list or email_read)" }),
  part: Type.String({ description: "MIME part number of the attachment (from email_read attachment list, e.g. '2', '1.2')" }),
  folder: Type.Optional(Type.String({ description: "Mail folder (default: INBOX)" })),
  filename: Type.Optional(Type.String({ description: "Override the output filename (default: uses the attachment's original filename)" })),
  output_path: Type.Optional(Type.String({ description: "Custom output path relative to working directory (default: output directory)" })),
});

function createEmailDownloadAttachmentTool(vault?: ResolvedVault, cwd?: string, outputDir?: string, sandbox?: string[]): AgentTool<typeof EmailDownloadAttachmentSchema> {
  return {
    name: "email_download_attachment",
    label: "Download Email Attachment",
    description: "Download a specific attachment from an email by UID and MIME part number. " +
      "Use email_read first to see the list of attachments with their part numbers.",
    parameters: EmailDownloadAttachmentSchema,
    async execute(_id, params) {
      const client = await connectImap(vault);
      const folder = params.folder ?? "INBOX";

      const lock = await client.getMailboxLock(folder);
      try {
        // If no filename override, fetch bodyStructure to get the original filename
        let filename = params.filename;
        if (!filename) {
          const msg = await client.fetchOne(String(params.uid), { bodyStructure: true }, { uid: true }) as any;
          if (msg?.bodyStructure) {
            const attachments = findAttachments(msg.bodyStructure);
            const match = attachments.find(a => a.part === params.part);
            filename = match?.filename ?? `attachment-${params.part}`;
          } else {
            filename = `attachment-${params.part}`;
          }
        }

        // Download the part
        const { meta, content } = await client.download(String(params.uid), params.part, { uid: true }) as any;
        const chunks: Buffer[] = [];
        for await (const chunk of content) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        const buffer = Buffer.concat(chunks);

        if (buffer.length === 0) {
          throw new Error(`Attachment part ${params.part} is empty or not found in UID ${params.uid}`);
        }

        // Determine output path
        let filePath: string;
        if (params.output_path) {
          filePath = resolve(cwd ?? process.cwd(), params.output_path);
        } else {
          filePath = join(outputDir ?? cwd ?? process.cwd(), filename);
        }

        // Sandbox check
        if (sandbox) {
          assertPathAllowed(filePath, sandbox, "email_download_attachment");
        }

        mkdirSync(dirname(filePath), { recursive: true });
        writeFileSync(filePath, buffer);

        const contentType = meta?.contentType ?? "application/octet-stream";
        return {
          content: [{ type: "text", text: `Attachment downloaded:\n  File: ${filePath}\n  Size: ${(buffer.length / 1024).toFixed(1)} KB\n  Type: ${contentType}\n  Part: ${params.part}` }],
          details: {
            path: filePath,
            size: buffer.length,
            contentType,
            part: params.part,
            uid: params.uid,
            filename,
          },
        };
      } finally {
        lock.release();
        await client.logout();
      }
    },
  };
}

// ─── Tool: email_search ───

const EmailSearchSchema = Type.Object({
  from: Type.Optional(Type.String({ description: "Search by sender address" })),
  subject: Type.Optional(Type.String({ description: "Search by subject (substring)" })),
  since: Type.Optional(Type.String({ description: "Search emails since date (YYYY-MM-DD)" })),
  body: Type.Optional(Type.String({ description: "Search by body text (substring)" })),
  folder: Type.Optional(Type.String({ description: "Mail folder (default: INBOX)" })),
  limit: Type.Optional(Type.Number({ description: "Max results (default: 20)" })),
});

function createEmailSearchTool(vault?: ResolvedVault): AgentTool<typeof EmailSearchSchema> {
  return {
    name: "email_search",
    label: "Search Emails",
    description: "Search emails by sender, subject, date, or body text. Returns matching messages with UID, subject, from, and date.",
    parameters: EmailSearchSchema,
    async execute(_id, params) {
      if (!params.from && !params.subject && !params.since && !params.body) {
        throw new Error("Provide at least one search criterion (from, subject, since, or body)");
      }

      const client = await connectImap(vault);
      const folder = params.folder ?? "INBOX";
      const limit = params.limit ?? 20;

      const lock = await client.getMailboxLock(folder);
      try {
        // Build search query
        const query: Record<string, any> = {};
        if (params.from) query.from = params.from;
        if (params.subject) query.subject = params.subject;
        if (params.since) query.since = params.since;
        if (params.body) query.body = params.body;

        const searchResult = await client.search(query, { uid: true });
        const uids = Array.isArray(searchResult) ? searchResult : [];
        const targetUids = uids.slice(-limit).reverse();

        const messages: string[] = [];
        for (const uid of targetUids) {
          const msg = await client.fetchOne(String(uid), { envelope: true, uid: true, flags: true }, { uid: true }) as any;
          if (!msg?.envelope) continue;

          const env = msg.envelope;
          const fromAddr = env.from?.[0] ? `${env.from[0].name ?? ""} <${env.from[0].address ?? ""}>`.trim() : "unknown";
          const date = env.date ? new Date(env.date).toISOString() : "unknown";
          const unread = !msg.flags?.has("\\Seen") ? " [UNREAD]" : "";

          messages.push(`UID: ${msg.uid} | ${date} | From: ${fromAddr} | Subject: ${env.subject ?? "(no subject)"}${unread}`);
        }

        return {
          content: [{ type: "text", text: messages.length > 0 ? `Search results (${messages.length}):\n\n${messages.join("\n")}` : "No emails found matching your criteria" }],
          details: { folder, count: messages.length, query: params },
        };
      } finally {
        lock.release();
        await client.logout();
      }
    },
  };
}

// ─── Factory ───

export type EmailToolName = "email_send" | "email_draft" | "email_verify" | "email_list" | "email_read" | "email_search" | "email_download_attachment";

export const ALL_EMAIL_TOOL_NAMES: EmailToolName[] = ["email_send", "email_draft", "email_verify", "email_list", "email_read", "email_search", "email_download_attachment"];

/**
 * Create email tools.
 *
 * @param cwd - Working directory (for resolving attachment paths)
 * @param allowedPaths - Sandbox paths
 * @param allowedTools - Optional filter
 * @param vault - Resolved vault credentials (per-agent SMTP/IMAP)
 * @param emailAllowedDomains - Allowed recipient email domains (omit for unrestricted)
 * @param outputDir - Per-task output directory for downloaded attachments
 */
export function createEmailTools(cwd: string, allowedPaths?: string[], allowedTools?: string[], vault?: ResolvedVault, emailAllowedDomains?: string[], outputDir?: string): AgentTool<any>[] {
  const sandbox = resolveAllowedPaths(cwd, allowedPaths);

  const factories: Record<EmailToolName, () => AgentTool<any>> = {
    email_send: () => createEmailSendTool(cwd, sandbox, vault, emailAllowedDomains),
    email_draft: () => createEmailDraftTool(cwd, sandbox, vault, emailAllowedDomains),
    email_verify: () => createEmailVerifyTool(vault),
    email_list: () => createEmailListTool(vault),
    email_read: () => createEmailReadTool(vault, outputDir, sandbox),
    email_search: () => createEmailSearchTool(vault),
    email_download_attachment: () => createEmailDownloadAttachmentTool(vault, cwd, outputDir, sandbox),
  };

  const names = allowedTools
    ? ALL_EMAIL_TOOL_NAMES.filter(n => allowedTools.some(a => a.toLowerCase() === n))
    : ALL_EMAIL_TOOL_NAMES;

  return names.map(n => factories[n]());
}
