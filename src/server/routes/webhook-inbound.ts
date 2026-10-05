/**
 * Inbound webhook channel — talk to Polpo or an agent over plain HTTP, with the
 * same gateway as Telegram (commands, /agent, suggestions, sessions, attachments).
 *
 * POST /api/v1/channels/:name/inbound
 *   Auth: "Authorization: Bearer <inboundSecret>" (or "X-Polpo-Secret: <inboundSecret>").
 *   Body, any of:
 *     - application/json  { text, sender?, name?, messageId?, callback?, attachments?: [{ filename, mimeType, data (base64) }] }
 *     - multipart/form-data or x-www-form-urlencoded with the same fields; file fields become attachments
 *     - text/plain        the message itself (sender/name from the query string)
 *   Query: ?format=text returns the reply as plain text (handy for iOS Shortcuts).
 *
 * Mounted before the instance auth gate: the channel's own secret authenticates the caller.
 */

import { Hono } from "hono";
import { createHash, timingSafeEqual } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import type { NotificationChannelConfig } from "../../core/types.js";
import type { InboundAttachment } from "../../notifications/channels/telegram.js";
import { resolveEnvVar } from "../../notifications/channels/webhook.js";
import {
  normalizeWebhookSender,
  type WebhookGatewayAdapter,
  type WebhookInboundMessage,
} from "../../notifications/webhook-gateway-adapter.js";

export interface WebhookInboundDeps {
  isInitialized: () => boolean;
  getChannelConfig: (name: string) => NotificationChannelConfig | undefined;
  getAdapter: (name: string) => WebhookGatewayAdapter | undefined;
}

/** Per inbound file; matches what Telegram bots can download. */
const MAX_INBOUND_FILE_BYTES = 20 * 1024 * 1024;
/** Outbound files larger than this are listed without their content. */
const MAX_OUTBOUND_FILE_BYTES = 10 * 1024 * 1024;

const MIME_BY_EXT: Record<string, string> = {
  ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".txt": "text/plain", ".md": "text/markdown",
  ".csv": "text/csv", ".json": "application/json", ".html": "text/html", ".zip": "application/zip",
  ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".ogg": "audio/ogg", ".mp4": "video/mp4", ".mov": "video/quicktime",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

function attachmentKind(mimeType: string): InboundAttachment["kind"] {
  if (mimeType.startsWith("image/")) return "photo";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType.startsWith("video/")) return "video";
  return "document";
}

/** Constant-time comparison (hash first so lengths always match). */
function secretMatches(given: string, expected: string): boolean {
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

function providedSecret(authorization: string | undefined, header: string | undefined): string | undefined {
  const bearer = /^Bearer\s+(.+)$/i.exec(authorization ?? "")?.[1]?.trim();
  return bearer || header?.trim() || undefined;
}

class InboundError extends Error {
  constructor(message: string, readonly status: 400 | 413) { super(message); }
}

function toAttachment(filename: string, mimeType: string, data: Buffer): InboundAttachment {
  if (data.length > MAX_INBOUND_FILE_BYTES) throw new InboundError(`${filename} is too large (max 20 MB)`, 413);
  const type = mimeType || MIME_BY_EXT[extname(filename).toLowerCase()] || "application/octet-stream";
  return { kind: attachmentKind(type), filename, mimeType: type, data };
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

async function parseInbound(req: Request, query: URLSearchParams): Promise<WebhookInboundMessage> {
  const contentType = (req.headers.get("content-type") ?? "").toLowerCase();
  const fromQuery = { sender: query.get("sender") ?? undefined, name: query.get("name") ?? undefined };

  if (contentType.includes("application/json")) {
    const body = await req.json().catch(() => { throw new InboundError("Invalid JSON body", 400); }) as Record<string, unknown>;
    const files = Array.isArray(body.attachments) ? body.attachments as Record<string, unknown>[] : [];
    return {
      sender: str(body.sender) ?? fromQuery.sender,
      name: str(body.name) ?? fromQuery.name,
      text: str(body.text) ?? str(body.message) ?? "",
      messageId: str(body.messageId),
      callback: str(body.callback),
      attachments: files.map((f, i) => {
        const data = str(f.data)?.replace(/^data:[^;]+;base64,/, "");
        if (!data) throw new InboundError(`attachments[${i}].data must be base64`, 400);
        return toAttachment(str(f.filename) ?? `file-${i + 1}`, str(f.mimeType) ?? "", Buffer.from(data, "base64"));
      }),
    };
  }

  if (contentType.includes("multipart/form-data") || contentType.includes("application/x-www-form-urlencoded")) {
    const form = await req.formData();
    const attachments: InboundAttachment[] = [];
    for (const [, value] of form.entries()) {
      if (typeof value === "string") continue;
      attachments.push(toAttachment(value.name || "file", value.type, Buffer.from(await value.arrayBuffer())));
    }
    return {
      sender: str(form.get("sender")) ?? fromQuery.sender,
      name: str(form.get("name")) ?? fromQuery.name,
      text: str(form.get("text")) ?? str(form.get("message")) ?? "",
      messageId: str(form.get("messageId")),
      callback: str(form.get("callback")),
      attachments,
    };
  }

  return { ...fromQuery, text: await req.text() };
}

async function encodeFiles(files: { path: string; filename: string }[]) {
  return Promise.all(files.map(async (f) => {
    const mimeType = MIME_BY_EXT[extname(f.filename).toLowerCase()] ?? "application/octet-stream";
    const size = (await stat(f.path)).size;
    const data = size <= MAX_OUTBOUND_FILE_BYTES ? (await readFile(f.path)).toString("base64") : undefined;
    return { filename: f.filename, mimeType, size, ...(data ? { data } : { note: "too large to inline" }) };
  }));
}

export function webhookInboundRoutes(deps: WebhookInboundDeps): Hono {
  const app = new Hono();

  app.post("/:name/inbound", async (c) => {
    const name = c.req.param("name");
    const config = deps.getChannelConfig(name);
    const expected = config?.type === "webhook" && config.inboundSecret ? resolveEnvVar(config.inboundSecret) : "";
    const given = providedSecret(c.req.header("authorization"), c.req.header("x-polpo-secret"));
    // Same answer for unknown channels and wrong secrets: names are not discoverable.
    if (!expected || !given || !secretMatches(given, expected)) {
      return c.json({ ok: false, error: "Unauthorized" }, 401);
    }
    if (!deps.isInitialized()) return c.json({ ok: false, error: "Polpo is not initialized" }, 503);
    const adapter = deps.getAdapter(name);
    if (!adapter) return c.json({ ok: false, error: `Inbound is disabled for channel "${name}"` }, 409);

    const query = new URL(c.req.url).searchParams;
    let input: WebhookInboundMessage;
    try {
      input = await parseInbound(c.req.raw, query);
    } catch (err) {
      if (err instanceof InboundError) return c.json({ ok: false, error: err.message }, err.status);
      throw err;
    }
    if (input.sender !== undefined && !normalizeWebhookSender(input.sender)) {
      return c.json({ ok: false, error: "sender may only contain letters, digits and . _ @ + - (max 64)" }, 400);
    }
    if (!input.callback && !input.text?.trim() && !input.attachments?.length) {
      return c.json({ ok: false, error: "Send text, attachments or a callback" }, 400);
    }

    const reply = await adapter.handle(input);
    const messages = reply?.messages ?? [];
    if (query.get("format") === "text") {
      return c.text(messages.join("\n\n"), 200);
    }
    return c.json({
      ok: true,
      data: {
        text: reply?.text ?? "",
        messages,
        ...(reply?.buttons ? { buttons: reply.buttons } : {}),
        ...(reply?.forceReply ? { forceReply: reply.forceReply } : {}),
        ...(reply?.files ? { files: await encodeFiles(reply.files) } : {}),
      },
    }, 200);
  });

  return app;
}
