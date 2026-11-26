/**
 * The media log and its images: every image request (who asked, from where, the prompt, the model,
 * the size, the seed, the cost) with the images it made, under `.polpo/media/`:
 *
 *   index.json                 entries, newest first (pruned by count and age: settings.media)
 *   log/<id>.json              one entry (the prompt, the inputs described, the assets)
 *   images/<id>/<n>.<ext>      the request's images (its variants), and <n>.thumb.webp previews
 *
 * Per-instance files whatever the instance's store, like the decision log: bounded, written through
 * a temporary file and a rename. Removing an entry removes its images; the copies agents saved in
 * their own workspace stay.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { isMediaId, type MediaLogEntry, type MediaLogPage } from "@polpo-ai/core/media";

function readJson<T>(path: string): T | undefined {
  try { return JSON.parse(readFileSync(path, "utf-8")) as T; } catch { return undefined; }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(value));
  renameSync(tmp, path);
}

export class FileMediaLogStore {
  constructor(private readonly polpoDir: () => string) {}

  root(): string { return join(this.polpoDir(), "media"); }
  private indexFile(): string { return join(this.root(), "index.json"); }
  private entryFile(id: string): string { return join(this.root(), "log", `${id}.json`); }
  /** The folder of a request's images. */
  imagesDir(id: string): string { return join(this.root(), "images", id); }

  private index(): MediaLogEntry[] {
    const d = readJson<{ entries?: MediaLogEntry[] }>(this.indexFile());
    return Array.isArray(d?.entries) ? d.entries : [];
  }

  /** Record an entry; the oldest beyond `retention`, or older than `retentionDays` (0: no age limit), are removed with their images. */
  add(entry: MediaLogEntry, retention: { count: number; days: number }): void {
    writeJson(this.entryFile(entry.id), entry);
    const minAt = retention.days > 0 ? new Date(Date.now() - retention.days * 86_400_000).toISOString() : "";
    const all = [entry, ...this.index().filter((d) => d.id !== entry.id)];
    const keep: MediaLogEntry[] = [];
    for (const d of all) {
      if (keep.length < Math.max(1, retention.count) && (!minAt || d.at >= minAt || d.id === entry.id)) keep.push(d);
      else {
        rmSync(this.entryFile(d.id), { force: true });
        if (isMediaId(d.id)) rmSync(this.imagesDir(d.id), { recursive: true, force: true });
      }
    }
    writeJson(this.indexFile(), { version: 1, entries: keep });
  }

  get(id: string): MediaLogEntry | undefined {
    return isMediaId(id) && existsSync(this.entryFile(id)) ? readJson<MediaLogEntry>(this.entryFile(id)) : undefined;
  }

  /** Newest first, filtered; the cursor is an offset. */
  list(o: { limit?: number; cursor?: string; caller?: string; callerId?: string; status?: "ok" | "error"; kind?: "generate" | "edit" } = {}): MediaLogPage {
    const all = this.index().filter((d) => (!o.caller || d.caller.kind === o.caller) && (!o.callerId || d.caller.id === o.callerId)
      && (!o.status || d.status === o.status) && (!o.kind || d.kind === o.kind));
    const offset = o.cursor && /^\d+$/.test(o.cursor) ? Number(o.cursor) : 0;
    const limit = Math.max(1, Math.min(o.limit ?? 50, 200));
    const entries = all.slice(offset, offset + limit);
    return { entries, total: all.length, ...(offset + limit < all.length ? { nextCursor: String(offset + limit) } : {}) };
  }

  /** The absolute file of an asset path (relative to .polpo), refused outside media/images. */
  assetFile(relPath: string): string | undefined {
    const root = resolve(this.root(), "images");
    const abs = resolve(this.polpoDir(), relPath);
    return abs.startsWith(root + sep) ? abs : undefined;
  }
}
