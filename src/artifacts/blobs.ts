/**
 * Blob files of artifacts: contents larger than artifactLimits().inlineBytes are kept as files in the
 * instance's storage directory, not inside the artifact's record (file or database).
 *
 *   <polpoDir>/artifact-blobs/<artifact id>/<sha256>     one file per distinct content (UTF-8 text)
 *   <polpoDir>/artifact-blobs/.staging/<upload id>       uploads in progress (kept 30 minutes)
 *
 * Blobs are content-addressed per artifact: versions with the same content (a restore, an undo) share
 * one file, and deleting an artifact removes its folder. A blob no record refers to any more is removed
 * after a grace period (a concurrent change may be about to refer to it).
 */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { nanoid } from "nanoid";
import type { ArtifactBlobRef } from "@polpo-ai/core/artifacts";

/** Characters of a blob kept in the record as its excerpt (search, previews). */
export const ARTIFACT_EXCERPT_CHARS = 8_000;
/** How long an upload in progress is kept. */
export const ARTIFACT_STAGING_TTL_MS = 30 * 60_000;

const SHA = /^[a-f0-9]{64}$/;
const STAGING_ID = /^upl_[\w-]{12}$/;

export class ArtifactContentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactContentError";
  }
}

/** A file's SHA-256, size and excerpt, checking it is UTF-8 text (an artifact content is text). */
export async function inspectTextFile(path: string): Promise<{ ref: ArtifactBlobRef; excerpt: string; head: string }> {
  const hash = createHash("sha256");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0;
  let head = "";
  try {
    for await (const chunk of createReadStream(path, { highWaterMark: 256 * 1024 }) as AsyncIterable<Buffer>) {
      hash.update(chunk);
      size += chunk.byteLength;
      const text = decoder.decode(chunk, { stream: true });
      if (head.length < 64 * 1024) head += text.slice(0, 64 * 1024 - head.length);
      if (size <= 64 * 1024 && text.includes("\u0000")) throw new ArtifactContentError("This is a binary file, not text");
    }
    decoder.decode();
  } catch (err) {
    if (err instanceof ArtifactContentError) throw err;
    if (err instanceof TypeError) throw new ArtifactContentError("The content is not UTF-8 text (an artifact is text: Markdown, HTML, SVG, Mermaid or workspace JSON)");
    throw err;
  }
  return { ref: { sha256: hash.digest("hex"), size }, excerpt: head.slice(0, ARTIFACT_EXCERPT_CHARS), head };
}

export interface StagedUpload {
  id: string;
  size: number;
  filename?: string;
  /** Who started it (only they finalize it). */
  by?: string;
  complete: boolean;
  expires: number;
}

export class ArtifactBlobs {
  readonly root: string;
  private readonly staging: string;
  private usageCache?: { bytes: number; at: number };

  /** gcGraceMs: an unreferenced blob newer than this is kept (default 10 minutes). */
  constructor(polpoDir: string, private readonly options: { gcGraceMs?: number } = {}) {
    this.root = join(polpoDir, "artifact-blobs");
    this.staging = join(this.root, ".staging");
  }

  private dir(artifactId: string): string {
    return join(this.root, encodeURIComponent(artifactId));
  }

  path(artifactId: string, ref: Pick<ArtifactBlobRef, "sha256">): string {
    if (!SHA.test(ref.sha256)) throw new Error("Invalid blob reference");
    return join(this.dir(artifactId), ref.sha256);
  }

  private async adopt(artifactId: string, ref: ArtifactBlobRef, write: (tmp: string) => Promise<void>): Promise<ArtifactBlobRef> {
    const target = this.path(artifactId, ref);
    await mkdir(this.dir(artifactId), { recursive: true });
    const existing = await stat(target).catch(() => undefined);
    if (existing?.size === ref.size) {
      // shared by another version: touched so a concurrent sweep keeps it
      const now = new Date();
      await utimes(target, now, now).catch(() => {});
      return ref;
    }
    const tmp = `${target}.${nanoid(6)}.tmp`;
    try {
      await write(tmp);
      await rename(tmp, target);
    } finally {
      await rm(tmp, { force: true });
    }
    if (this.usageCache) this.usageCache.bytes += ref.size;
    return ref;
  }

  /** Keep a text as a blob of the artifact. */
  async writeText(artifactId: string, text: string): Promise<ArtifactBlobRef> {
    const bytes = Buffer.from(text, "utf-8");
    const ref = { sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.byteLength };
    return this.adopt(artifactId, ref, (tmp) => writeFile(tmp, bytes, { mode: 0o600 }));
  }

  /** Keep a file as a blob of the artifact: moved when move is true (a staged upload), copied otherwise. */
  async writeFile(artifactId: string, source: string, options: { move?: boolean; inspected?: { ref: ArtifactBlobRef } } = {}): Promise<ArtifactBlobRef> {
    const ref = options.inspected?.ref ?? (await inspectTextFile(source)).ref;
    return this.adopt(artifactId, ref, (tmp) => options.move ? rename(source, tmp) : copyFile(source, tmp));
  }

  async readText(artifactId: string, ref: ArtifactBlobRef): Promise<string> {
    try {
      return await readFile(this.path(artifactId, ref), "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`The content of artifact ${artifactId} is missing from the storage (blob ${ref.sha256.slice(0, 12)})`);
      throw err;
    }
  }

  /** Bytes start..end (inclusive) of a blob, as a stream. */
  stream(artifactId: string, ref: ArtifactBlobRef, start = 0, end = ref.size - 1): Readable {
    if (ref.size === 0 || end < start) return Readable.from([]);
    return createReadStream(this.path(artifactId, ref), { start, end });
  }

  /** Remove the blobs of an artifact no record refers to (older than the grace period). */
  async sweep(artifactId: string, keep: Iterable<string>): Promise<number> {
    const kept = new Set(keep);
    const grace = this.options.gcGraceMs ?? 10 * 60_000;
    const names = await readdir(this.dir(artifactId)).catch(() => [] as string[]);
    let removed = 0;
    for (const name of names) {
      if (kept.has(name) || !SHA.test(name)) continue;
      const path = join(this.dir(artifactId), name);
      const info = await stat(path).catch(() => undefined);
      if (!info || Date.now() - info.mtimeMs < grace) continue;
      await rm(path, { force: true });
      if (this.usageCache) this.usageCache.bytes -= info.size;
      removed += 1;
    }
    return removed;
  }

  async remove(artifactId: string): Promise<void> {
    await rm(this.dir(artifactId), { recursive: true, force: true });
    this.usageCache = undefined;
  }

  /** Bytes of every blob of the instance (cached for a minute). */
  async usage(): Promise<number> {
    if (this.usageCache && Date.now() - this.usageCache.at < 60_000) return this.usageCache.bytes;
    let bytes = 0;
    for (const dir of await readdir(this.root).catch(() => [] as string[])) {
      if (dir.startsWith(".")) continue;
      for (const name of await readdir(join(this.root, dir)).catch(() => [] as string[])) {
        if (SHA.test(name)) bytes += (await stat(join(this.root, dir, name)).catch(() => undefined))?.size ?? 0;
      }
    }
    this.usageCache = { bytes, at: Date.now() };
    return bytes;
  }

  // ── Uploads in progress ────────────────────────────────────────────

  stagedPath(id: string): string {
    if (!STAGING_ID.test(id)) throw new Error("Invalid upload id");
    return join(this.staging, id);
  }

  private metaPath(id: string): string {
    return `${this.stagedPath(id)}.json`;
  }

  async staged(id: string): Promise<StagedUpload | undefined> {
    if (!STAGING_ID.test(id)) return undefined;
    try {
      const meta = JSON.parse(await readFile(this.metaPath(id), "utf-8")) as StagedUpload;
      if (meta.expires <= Date.now()) {
        await this.dropStaged(id);
        return undefined;
      }
      return meta;
    } catch {
      return undefined;
    }
  }

  private async saveMeta(meta: StagedUpload): Promise<void> {
    await writeFile(this.metaPath(meta.id), JSON.stringify(meta), { mode: 0o600 });
  }

  /** Start an upload; returns its id. */
  async stage(input: { filename?: string; by?: string } = {}): Promise<StagedUpload> {
    await mkdir(this.staging, { recursive: true });
    await this.sweepStaged();
    const meta: StagedUpload = {
      id: `upl_${nanoid(12)}`, size: 0, complete: false, expires: Date.now() + ARTIFACT_STAGING_TTL_MS,
      ...(input.filename ? { filename: input.filename } : {}), ...(input.by ? { by: input.by } : {}),
    };
    await writeFile(this.stagedPath(meta.id), "", { mode: 0o600 });
    await this.saveMeta(meta);
    return meta;
  }

  /**
   * Append bytes (a buffer or a stream) to an upload; refuses past maxBytes (the upload is then
   * dropped). complete: no more parts follow.
   */
  async appendStaged(id: string, data: Uint8Array | AsyncIterable<Uint8Array>, options: { maxBytes: number; complete?: boolean }): Promise<StagedUpload> {
    const meta = await this.staged(id);
    if (!meta) throw new Error(`There is no upload ${id} in progress (uploads are kept ${ARTIFACT_STAGING_TTL_MS / 60_000} minutes)`);
    if (meta.complete) throw new Error(`Upload ${id} is complete: finalize it, or start a new one`);
    let size = meta.size;
    const limit = options.maxBytes;
    const counted = async function* (source: AsyncIterable<Uint8Array>) {
      for await (const chunk of source) {
        size += chunk.byteLength;
        if (size > limit) throw new UploadTooLargeError(limit);
        yield chunk;
      }
    };
    const source = data instanceof Uint8Array ? (async function* () { yield data; })() : data;
    try {
      await pipeline(counted(source), createWriteStream(this.stagedPath(id), { flags: "a", mode: 0o600 }));
    } catch (err) {
      if (err instanceof UploadTooLargeError) await this.dropStaged(id);
      throw err;
    }
    const next = { ...meta, size, complete: options.complete ?? meta.complete, expires: Date.now() + ARTIFACT_STAGING_TTL_MS };
    await this.saveMeta(next);
    return next;
  }

  async dropStaged(id: string): Promise<void> {
    if (!STAGING_ID.test(id)) return;
    await rm(this.stagedPath(id), { force: true });
    await rm(this.metaPath(id), { force: true });
  }

  /** Remove expired uploads. */
  async sweepStaged(): Promise<void> {
    for (const name of await readdir(this.staging).catch(() => [] as string[])) {
      if (!name.endsWith(".json")) continue;
      await this.staged(name.slice(0, -".json".length));
    }
  }
}

export class UploadTooLargeError extends Error {
  constructor(readonly limit: number) {
    super(`The content is over the artifact limit (${limit} bytes)`);
    this.name = "UploadTooLargeError";
  }
}
