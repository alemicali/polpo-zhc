/**
 * Mirror an agent's identity onto its dedicated Telegram bot: avatar → bot
 * profile photo, bio → description, title/role → short description.
 *
 * Telegram keeps every uploaded profile photo in the bot's photo history, so
 * the photo is only uploaded when the avatar actually changes: the digest of
 * the last synced values is kept per bot in `<polpoDir>/telegram-bot-profiles.json`.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

export interface BotProfileAgent {
  name: string;
  role?: string;
  identity?: { avatar?: string; bio?: string; title?: string };
}

export interface BotProfileSyncOptions {
  botToken: string;
  agent: BotProfileAgent;
  /** Directories an avatar path may be relative to (project root, agent work dir). */
  roots: string[];
  /** File holding the digests of what each bot already shows. */
  statePath: string;
  fetch?: typeof fetch;
}

export interface BotProfileSyncResult {
  photo: "updated" | "unchanged" | "missing" | "failed";
  description: "updated" | "unchanged" | "failed";
  error?: string;
}

const DESCRIPTION_MAX = 512;
const SHORT_DESCRIPTION_MAX = 120;
const PHOTO_SIZE = 640;

const digest = (data: string | Buffer) => createHash("sha256").update(data).digest("hex").slice(0, 16);

/** Read an avatar that may be stored as raw image bytes or as base64 text (UI uploads). */
export function readAvatar(avatarPath: string, roots: string[]): Buffer | undefined {
  const candidates = isAbsolute(avatarPath) ? [avatarPath] : roots.map(root => resolve(join(root, avatarPath)));
  const file = candidates.find(p => existsSync(p));
  if (!file) return undefined;
  const raw = readFileSync(file);
  const isImage = raw.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])) // PNG
    || raw.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))                  // JPEG
    || (raw.subarray(0, 4).toString() === "RIFF" && raw.subarray(8, 12).toString() === "WEBP")
    || raw.subarray(0, 3).toString() === "GIF";
  if (isImage) return raw;
  const text = raw.toString("utf-8").trim().replace(/^data:[^;]+;base64,/, "");
  if (!/^[A-Za-z0-9+/=\s]+$/.test(text)) return undefined;
  return Buffer.from(text, "base64");
}

/** Square JPEG, as setMyProfilePhoto only accepts static .JPG photos. */
export async function toProfileJpeg(image: Buffer): Promise<Buffer> {
  // loaded on use: sharp is native, the server starts without it (desktop sidecar)
  const { default: sharp } = await import("sharp");
  return sharp(image).rotate().resize(PHOTO_SIZE, PHOTO_SIZE, { fit: "cover" }).flatten({ background: "#ffffff" }).jpeg({ quality: 90 }).toBuffer();
}

function loadState(statePath: string): Record<string, { photo?: string; description?: string }> {
  try { return JSON.parse(readFileSync(statePath, "utf-8")); } catch { return {}; }
}

async function callTelegram(fetchImpl: typeof fetch, botToken: string, method: string, body: unknown): Promise<void> {
  const init: RequestInit = body instanceof FormData
    ? { method: "POST", body }
    : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
  const res = await fetchImpl(`https://api.telegram.org/bot${botToken}/${method}`, init);
  const json = await res.json().catch(() => null) as { ok?: boolean; description?: string } | null;
  if (!json?.ok) throw new Error(`${method}: ${json?.description ?? res.status}`);
}

export async function syncTelegramBotProfile(opts: BotProfileSyncOptions): Promise<BotProfileSyncResult> {
  const fetchImpl = opts.fetch ?? fetch;
  const botKey = digest(opts.botToken);
  const state = loadState(opts.statePath);
  const current = state[botKey] ?? {};
  const result: BotProfileSyncResult = { photo: "missing", description: "unchanged" };

  // ── Description ──
  const identity = opts.agent.identity ?? {};
  const description = (identity.bio ?? "").trim().slice(0, DESCRIPTION_MAX);
  const shortDescription = (identity.title ?? opts.agent.role ?? "").trim().slice(0, SHORT_DESCRIPTION_MAX);
  const descriptionDigest = digest(`${description}\n${shortDescription}`);
  if (descriptionDigest !== current.description) {
    try {
      await callTelegram(fetchImpl, opts.botToken, "setMyDescription", { description });
      await callTelegram(fetchImpl, opts.botToken, "setMyShortDescription", { short_description: shortDescription });
      current.description = descriptionDigest;
      result.description = "updated";
    } catch (err) {
      result.description = "failed";
      result.error = err instanceof Error ? err.message : String(err);
    }
  }

  // ── Profile photo (only when the avatar changed) ──
  const avatar = identity.avatar ? readAvatar(identity.avatar, opts.roots) : undefined;
  if (avatar) {
    const photoDigest = digest(avatar);
    if (photoDigest === current.photo) {
      result.photo = "unchanged";
    } else {
      try {
        const jpeg = await toProfileJpeg(avatar);
        const form = new FormData();
        form.append("photo", JSON.stringify({ type: "static", photo: "attach://avatar" }));
        form.append("avatar", new Blob([new Uint8Array(jpeg)], { type: "image/jpeg" }), "avatar.jpg");
        await callTelegram(fetchImpl, opts.botToken, "setMyProfilePhoto", form);
        current.photo = photoDigest;
        result.photo = "updated";
      } catch (err) {
        result.photo = "failed";
        result.error = err instanceof Error ? err.message : String(err);
      }
    }
  }

  // Re-read before writing: several bots sync concurrently and share this file.
  const latest = loadState(opts.statePath);
  latest[botKey] = current;
  try { writeFileSync(opts.statePath, JSON.stringify(latest, null, 2)); } catch { /* best effort */ }
  return result;
}
