/**
 * The artifact store of the server: the record store of the project (database or .polpo/artifacts/)
 * plus blob files for large contents (src/artifacts/blobs.ts).
 *
 * - A content up to artifactLimits().inlineBytes stays in the record, a larger one becomes a blob (the
 *   record keeps its reference, size and the first few KB as an excerpt for search and previews).
 * - Versions are full snapshots: a blob version refers to its file (identical contents share one),
 *   pruned to versions.maxCount / versions.maxTotalBytes; a blob no version refers to any more is removed.
 * - Contents are read whole (readContent) only to change them in place or to read one part; listing,
 *   search and the dashboard read the record, the excerpt or a byte range (openContent).
 * - Records written before blobs existed (contents inline up to 1 MB, versions included) are moved
 *   to blobs by migrate(), and anyway on their next change; nothing is lost.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { nanoid } from "nanoid";
import {
  applyArtifactPatch, artifactContentProblem, artifactLimits, artifactSize, ArtifactEditConflictError, buildArtifact,
  formatArtifactBytes, utf8Bytes,
  type Artifact, type ArtifactBlobRef, type ArtifactFilter, type ArtifactPatch, type ArtifactStore, type ArtifactSummary,
  type ArtifactType, type ArtifactVersion, type NewArtifact,
} from "@polpo-ai/core/artifacts";
import { ARTIFACT_EXCERPT_CHARS, ArtifactBlobs, ArtifactContentError, inspectTextFile } from "./blobs.js";

/** A content given as a file (an upload, a file of the instance, another artifact's blob). */
export interface ContentFile {
  path: string;
  /** Move it into the store instead of copying (a staged upload). */
  move?: boolean;
}

export type NewLargeArtifact = NewArtifact & { contentFile?: ContentFile };
export type LargeArtifactPatch = ArtifactPatch & { contentFile?: ContentFile };

/** Over the instance-wide limit of artifact storage (settings.artifacts.maxTotalBytes). */
export class ArtifactQuotaError extends Error {
  constructor(used: number, limit: number) {
    super(`The artifacts of this instance take ${formatArtifactBytes(used)} of ${formatArtifactBytes(limit)} (settings.artifacts.maxTotalBytes): delete artifacts or raise the limit`);
    this.name = "ArtifactQuotaError";
  }
}

/** Too large to change in place or read by part (settings.artifacts.maxEditBytes). */
export class ArtifactTooLargeToEditError extends Error {
  constructor(size: number) {
    const limit = artifactLimits().maxEditBytes;
    super(`This artifact is ${formatArtifactBytes(size)}: contents over ${formatArtifactBytes(limit)} are not changed in place. `
      + "Replace the whole content by upload (PUT /artifacts/:id/content, polpo_artifact_upload_prepare + finalize, artifact_from_file), "
      + "or read it by byte range (offset/limit).");
    this.name = "ArtifactTooLargeToEditError";
  }
}

const excerptOf = (text: string) => text.slice(0, ARTIFACT_EXCERPT_CHARS);
const MIGRATION_MARKER = ".migrated-v1";

/** Checks the beginning of a content too large to read whole (type markers only). */
function headProblem(type: ArtifactType, head: string, kind?: string): string | undefined {
  if (type !== "doc" && !head.trim()) return "The content is empty";
  if (type === "svg" && !/<svg[\s>]/i.test(head)) return "An svg artifact must contain an <svg> element near its beginning";
  if (type === "html" && (kind === "slides" || kind === "sheets" || kind === "motion") && head.trimStart().startsWith("{") && !/"version"\s*:\s*1\b/.test(head)) {
    return `A ${kind} workspace must have version 1`;
  }
  return undefined;
}

export class LargeArtifactStore implements ArtifactStore {
  private migrated?: Promise<number>;

  constructor(readonly base: ArtifactStore & Required<Pick<ArtifactStore, "put">>, readonly blobs: ArtifactBlobs) {}

  list(filter?: ArtifactFilter): Promise<ArtifactSummary[]> {
    return this.base.list(filter);
  }

  /** The record: a blob content is empty here (readContent / openContent read it). */
  get(id: string): Promise<Artifact | undefined> {
    return this.base.get(id);
  }

  /** The path of a blob (to copy it into another artifact). */
  blobPath(artifactId: string, ref: ArtifactBlobRef): string {
    return this.blobs.path(artifactId, ref);
  }

  /** The whole content of the artifact (or of one of its versions). */
  async readContent(artifact: Artifact, version?: number): Promise<string> {
    const item = version === undefined || version === artifact.version ? artifact : artifact.versions.find((v) => v.version === version);
    if (!item) throw new Error(`No version ${version} of artifact ${artifact.id}`);
    return item.blob ? this.blobs.readText(artifact.id, item.blob) : item.content;
  }

  /** The content, checked against settings.artifacts.maxEditBytes (to change it in place or read a part). */
  async readEditable(artifact: Artifact, version?: number): Promise<string> {
    const item = version === undefined || version === artifact.version ? artifact : artifact.versions.find((v) => v.version === version);
    if (item && artifactSize(item) > artifactLimits().maxEditBytes) throw new ArtifactTooLargeToEditError(artifactSize(item));
    return this.readContent(artifact, version);
  }

  /** A byte range of the content (or of a version): start..end inclusive, clamped to the size. */
  openContent(artifact: Artifact, options: { version?: number; start?: number; end?: number } = {}): { size: number; start: number; end: number; etag: string; stream: Readable } {
    const item: Artifact | ArtifactVersion | undefined = options.version === undefined || options.version === artifact.version
      ? artifact : artifact.versions.find((v) => v.version === options.version);
    if (!item) throw new Error(`No version ${options.version} of artifact ${artifact.id}`);
    const size = artifactSize(item);
    const start = Math.max(0, Math.min(options.start ?? 0, size));
    const end = Math.max(start - 1, Math.min(options.end ?? size - 1, size - 1));
    const etag = `"${item.blob?.sha256.slice(0, 32) ?? `${artifact.id}-v${item.version}`}"`;
    if (item.blob) return { size, start, end, etag, stream: this.blobs.stream(artifact.id, item.blob, start, end) };
    const bytes = Buffer.from(item.content, "utf-8").subarray(start, end + 1);
    return { size, start, end, etag, stream: Readable.from(bytes.byteLength ? [bytes] : []) };
  }

  /** Bytes of every artifact of the instance: blobs, plus contents kept in the records. */
  async usage(): Promise<{ bytes: number; maxBytes: number }> {
    const [blobs, list] = await Promise.all([this.blobs.usage(), this.base.list()]);
    const inline = list.filter((a) => !a.blob).reduce((sum, a) => sum + a.size, 0);
    return { bytes: blobs + inline, maxBytes: artifactLimits().maxTotalBytes };
  }

  private async checkQuota(adding: number): Promise<void> {
    if (adding <= artifactLimits().inlineBytes) return;
    const { bytes, maxBytes } = await this.usage();
    if (bytes + adding > maxBytes) throw new ArtifactQuotaError(bytes, maxBytes);
  }

  /**
   * The content to store for a new or changed content: inline text, or a blob (written now, so a
   * conflict retry writes nothing again). Checks it against the type and kind.
   */
  private async storeContent(artifactId: string, type: ArtifactType, kind: string | undefined, input: { content?: string; contentFile?: ContentFile }): Promise<{ content: string } | { blob: ArtifactBlobRef; excerpt: string }> {
    const limits = artifactLimits();
    if (input.contentFile) {
      const info = await stat(input.contentFile.path).catch(() => undefined);
      if (!info?.isFile()) throw new ArtifactContentError("The uploaded file is missing");
      if (info.size > limits.maxBytes) throw new ArtifactContentError(`The content is over ${formatArtifactBytes(limits.maxBytes)} (${formatArtifactBytes(info.size)})`);
      const inspected = await inspectTextFile(input.contentFile.path);
      if (inspected.ref.size <= limits.maxEditBytes) {
        // small enough to check whole, like any content (and kept in the record when within inlineBytes)
        const text = utf8Bytes(inspected.head) === inspected.ref.size ? inspected.head : await readFile(input.contentFile.path, "utf-8");
        const problem = artifactContentProblem(type, text, kind);
        if (problem) throw new ArtifactContentError(problem);
        if (inspected.ref.size <= limits.inlineBytes) {
          if (input.contentFile.move) await rm(input.contentFile.path, { force: true });
          return { content: text };
        }
      } else {
        const problem = headProblem(type, inspected.head, kind);
        if (problem) throw new ArtifactContentError(problem);
      }
      await this.checkQuota(inspected.ref.size);
      const blob = await this.blobs.writeFile(artifactId, input.contentFile.path, { move: input.contentFile.move, inspected });
      return { blob, excerpt: excerptOf(inspected.head) };
    }
    const content = input.content ?? "";
    const problem = artifactContentProblem(type, content, kind);
    if (problem) throw new ArtifactContentError(problem);
    const bytes = utf8Bytes(content);
    if (bytes <= limits.inlineBytes) return { content };
    await this.checkQuota(bytes);
    return { blob: await this.blobs.writeText(artifactId, content), excerpt: excerptOf(content) };
  }

  /** Moves large inline contents (current and versions) of a record into blobs. */
  private async externalize(artifact: Artifact): Promise<Artifact> {
    const inline = artifactLimits().inlineBytes;
    let next = artifact;
    if (!artifact.blob && utf8Bytes(artifact.content) > inline) {
      const blob = await this.blobs.writeText(artifact.id, artifact.content);
      next = { ...next, content: "", blob, size: blob.size, excerpt: excerptOf(artifact.content) };
    }
    if (artifact.versions.some((v) => !v.blob && utf8Bytes(v.content) > inline)) {
      const versions: ArtifactVersion[] = [];
      for (const v of artifact.versions) {
        if (v.blob || utf8Bytes(v.content) <= inline) { versions.push(v); continue; }
        const blob = await this.blobs.writeText(artifact.id, v.content);
        versions.push({ ...v, content: "", blob, size: blob.size });
      }
      next = { ...next, versions };
    }
    return next;
  }

  private refs(artifact: Artifact): string[] {
    return [artifact.blob?.sha256, ...artifact.versions.map((v) => v.blob?.sha256)].filter((s): s is string => !!s);
  }

  async create(input: NewLargeArtifact): Promise<Artifact> {
    const { contentFile, ...rest } = input;
    const id = `art_${nanoid(12)}`;
    const kind = input.kind?.trim() || undefined;
    try {
      const stored = input.blob ? { blob: input.blob, excerpt: input.excerpt ?? "" } : await this.storeContent(id, input.type, kind, { content: input.content, contentFile });
      const artifact = buildArtifact(id, { ...rest, ...("blob" in stored ? { content: "", blob: stored.blob, excerpt: stored.excerpt } : { content: stored.content }) });
      if (!(await this.base.put(artifact, { ifUpdatedAt: null }))) throw new Error(`Artifact ${id} exists`);
      return artifact;
    } catch (err) {
      await this.blobs.remove(id);
      throw err;
    }
  }

  async update(id: string, patch: LargeArtifactPatch): Promise<Artifact | undefined> {
    const { contentFile, ...rest } = patch;
    const first = await this.base.get(id);
    if (!first) return undefined;
    if (patch.expectedVersion !== undefined && patch.expectedVersion !== first.version) throw new ArtifactEditConflictError();
    const wantsContent = !patch.blob && (contentFile !== undefined || patch.content !== undefined);
    const stored = wantsContent
      ? await this.storeContent(id, first.type, patch.kind !== undefined ? patch.kind.trim() || undefined : first.kind, { content: patch.content, contentFile })
      : undefined;
    const { content: _content, blob, excerpt, ...meta } = rest;
    const contentPatch: ArtifactPatch = blob ? { blob, excerpt } : stored ? ("blob" in stored ? { blob: stored.blob, excerpt: stored.excerpt } : { content: stored.content }) : {};
    let current: Artifact | undefined = first;
    for (let attempt = 0; attempt < 5 && current; attempt += 1) {
      const source = await this.externalize(current);
      const timestamp = new Date(Math.max(Date.now(), Date.parse(current.updatedAt) + 1)).toISOString();
      const next = applyArtifactPatch(source, { ...meta, ...contentPatch }, timestamp);
      if (await this.base.put(next, { ifUpdatedAt: current.updatedAt })) {
        await this.blobs.sweep(id, this.refs(next));
        return next;
      }
      current = await this.base.get(id);
    }
    if (!current) return undefined;
    throw new ArtifactEditConflictError();
  }

  async restore(id: string, version: number, author?: string): Promise<Artifact | undefined> {
    const current = await this.base.get(id);
    if (!current) return undefined;
    const old = current.versions.find((v) => v.version === version);
    if (!old) throw new Error(`No version ${version} of this artifact`);
    return this.update(id, {
      ...(old.blob ? { blob: old.blob } : { content: old.content }),
      expectedVersion: current.version, author, note: `restored version ${version}`,
    });
  }

  async delete(id: string): Promise<boolean> {
    const deleted = await this.base.delete(id);
    if (deleted) await this.blobs.remove(id);
    return deleted;
  }

  put(artifact: Artifact, options?: { ifUpdatedAt?: string | null }): Promise<boolean> {
    return this.base.put(artifact, options);
  }

  /**
   * Move the large inline contents of records written before blobs existed into blobs (once per
   * project: a marker file records it). Returns how many records changed.
   */
  migrate(): Promise<number> {
    this.migrated ??= (async () => {
      const marker = join(this.blobs.root, MIGRATION_MARKER);
      if (existsSync(marker)) return 0;
      let changed = 0;
      for (const summary of await this.base.list()) {
        const current = await this.base.get(summary.id);
        if (!current) continue;
        const next = await this.externalize(current);
        if (next !== current && await this.base.put(next, { ifUpdatedAt: current.updatedAt })) changed += 1;
      }
      await mkdir(this.blobs.root, { recursive: true });
      await writeFile(marker, new Date().toISOString());
      return changed;
    })();
    return this.migrated;
  }
}
