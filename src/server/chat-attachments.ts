import { mkdir, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { nanoid } from "nanoid";
import type { Attachment, AttachmentStore, SessionStore } from "@polpo-ai/core";

const MAX_FILE_BYTES = 15 * 1024 * 1024;
const MAX_TOTAL_BYTES = 30 * 1024 * 1024;
type Part = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }
  | { type: "file"; file: { filename: string; file_data: string } };

/** API paths are project-relative, while agent tools may start in workspace/. */
export function resolveChatAttachmentReferences(text: string, workDir: string): string {
  return text.replace(/\[file: (workspace\/attachments\/[\w-]+\/[\w-]+\.[a-zA-Z0-9]{1,12})\]/g,
    (_, path: string) => `[file: ${join(workDir, path)}]`);
}

/** Persist bytes once, return lightweight metadata in history, keep vision input for the current turn. */
export async function saveChatUserMessage(
  sessionStore: SessionStore, attachmentStore: AttachmentStore, workDir: string,
  sessionId: string, content: string | Part[],
) {
  if (!/^[\w-]+$/.test(sessionId)) throw new Error("Invalid attachment session id");
  const parts = typeof content === "string" ? [{ type: "text" as const, text: content }] : content;
  const files: { metadata: Attachment; bytes: Buffer; part: Part }[] = [];
  let total = 0;
  // Validate the entire batch before writing anything. Never fetch caller-controlled URLs.
  for (const part of parts) {
    if (part.type === "text") continue;
    const data = part.type === "file" ? part.file.file_data : part.image_url.url;
    const match = /^data:([\w.+-]+\/[\w.+-]+);base64,([A-Za-z0-9+/]+={0,2})$/.exec(data);
    if (!match) throw new Error("Attachments must contain a base64 data URL");
    const bytes = Buffer.from(match[2], "base64");
    if (!bytes.length || bytes.toString("base64").replace(/=+$/, "") !== match[2].replace(/=+$/, "")) throw new Error("Invalid attachment data");
    total += bytes.length;
    if (bytes.length > MAX_FILE_BYTES || total > MAX_TOTAL_BYTES || files.length >= 5) throw new Error("Attachment limit: 5 files, 15 MB each, 30 MB total");
    const mimeType = match[1].toLowerCase();
    if (part.type === "image_url" && !["image/jpeg", "image/png", "image/webp", "image/gif"].includes(mimeType)) throw new Error("Unsupported image format. Use JPEG, PNG, WebP or GIF.");
    const id = nanoid(20);
    const ext = ({ "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" } as Record<string, string>)[mimeType] ?? "bin";
    const filename = part.type === "file" ? part.file.filename.replace(/[\\/\x00-\x1f\x7f]/g, "_").slice(0, 160) || `file.${ext}` : `photo.${ext}`;
    files.push({ part, bytes, metadata: { id, sessionId, filename, mimeType, size: bytes.length,
      path: `workspace/attachments/${sessionId}/${id}.${part.type === "file" ? filename.match(/\.([a-zA-Z0-9]{1,12})$/)?.[1] ?? ext : ext}`, createdAt: new Date().toISOString() } });
  }
  const written: string[] = [];
  let messageSaved = false;
  try {
    for (const { metadata, bytes } of files) {
      const absolute = join(workDir, metadata.path);
      await mkdir(join(workDir, "workspace", "attachments", sessionId), { recursive: true });
      await writeFile(absolute, bytes, { flag: "wx" });
      written.push(absolute);
    }
    const text = parts.filter((p): p is Extract<Part, { type: "text" }> => p.type === "text").map(p => p.text).join("\n");
    const message = await sessionStore.addMessage(sessionId, "user", text);
    messageSaved = true;
    const attachments = files.map(({ metadata }) => ({ ...metadata, messageId: message.id }));
    for (const attachment of attachments) await attachmentStore.save(attachment);
    const modelContent = parts.map(part => part.type === "file"
      ? { type: "text" as const, text: `[file: ${files.find(f => f.part === part)!.metadata.path}]` }
      : part);
    return { ...message, attachments, modelContent };
  } catch (error) {
    // Once a message exists, preserve its bytes for recovery instead of destroying evidence.
    if (!messageSaved) await Promise.all(written.map(path => unlink(path).catch(() => {})));
    throw error;
  }
}
