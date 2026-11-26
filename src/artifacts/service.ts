/**
 * Changing and reading artifacts the same way everywhere (REST, MCP through REST, the agents' and
 * Polpo's tools): one change request (update / rewrite / append / prepend / patch / ops) and reads by
 * byte range or by part, without loading large contents whole when it is not needed.
 */
import {
  artifactLimits, artifactSize, artifactVersionUsage, ArtifactEditConflictError, formatArtifactBytes,
  type Artifact, type ArtifactPatch,
} from "@polpo-ai/core/artifacts";
import type { LargeArtifactStore } from "./store.js";
import {
  artifactOutline, changeShape, readArtifactPart, resolveArtifactChange,
  type ArtifactContentChange, type ArtifactPartSelector,
} from "./ops.js";

/** Characters an agent reads at once by default (more: offset/limit or a part). */
export const ARTIFACT_READ_CHARS = 60_000;

/** The fields of a change request that are not about the content. */
export type ArtifactMetaPatch = Omit<ArtifactPatch, "content" | "blob" | "excerpt">;

/**
 * Apply a change request to an artifact: the content change (if any) plus metadata. A change made
 * since expectedVersion (default: the version read here) is refused with ArtifactEditConflictError.
 */
export async function changeArtifact(
  store: LargeArtifactStore,
  artifact: Artifact,
  change: ArtifactContentChange,
  meta: ArtifactMetaPatch,
): Promise<{ artifact: Artifact; summary?: string }> {
  if (meta.expectedVersion !== undefined && meta.expectedVersion !== artifact.version) throw new ArtifactEditConflictError();
  const shape = changeShape(change);
  const expectedVersion = meta.expectedVersion ?? artifact.version;
  if (!shape.changes) {
    const updated = await store.update(artifact.id, { ...meta, expectedVersion });
    if (!updated) throw new Error(`No artifact ${artifact.id}`);
    return { artifact: updated };
  }
  const target = { type: artifact.type, kind: meta.kind !== undefined ? meta.kind.trim() || undefined : artifact.kind };
  const current = shape.needsCurrent ? await store.readEditable(artifact) : "";
  const { content, summary } = resolveArtifactChange(target, current, change);
  const updated = await store.update(artifact.id, { ...meta, content, expectedVersion });
  if (!updated) throw new Error(`No artifact ${artifact.id}`);
  return { artifact: updated, summary };
}

export interface ArtifactReadOptions {
  version?: number;
  /** Bytes from the start (UTF-8). */
  offset?: number;
  /** Bytes to read (default ARTIFACT_READ_CHARS). */
  limit?: number;
  /** The structure only (tabs, slides, sheets, boards, scenes). */
  outline?: boolean;
  part?: ArtifactPartSelector;
}

export interface ArtifactReadResult {
  text: string;
  /** Bytes of the whole content. */
  size: number;
  /** The byte range read (for offset/limit and the default read). */
  start?: number;
  end?: number;
  /** More content follows (read on with offset = end). */
  more?: boolean;
  outline?: string;
}

const hasPart = (part?: ArtifactPartSelector) => !!part && Object.values(part).some((v) => v !== undefined && v !== "");

async function streamText(stream: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/** Decode a byte range, dropping a UTF-8 sequence cut at either end. */
function decodeRange(bytes: Buffer): { text: string; lead: number; trail: number } {
  let lead = 0;
  while (lead < bytes.length && lead < 3 && (bytes[lead]! & 0xc0) === 0x80) lead += 1;
  let trail = 0;
  for (let i = bytes.length - 1; i >= Math.max(lead, bytes.length - 4); i -= 1) {
    const b = bytes[i]!;
    if ((b & 0xc0) === 0x80) continue;
    const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
    if (bytes.length - i < need) trail = bytes.length - i;
    break;
  }
  return { text: bytes.subarray(lead, bytes.length - trail).toString("utf-8"), lead, trail };
}

/** Read an artifact (or a version): a byte range, a part, its outline, or the beginning with its outline. */
export async function readArtifact(store: LargeArtifactStore, artifact: Artifact, options: ArtifactReadOptions = {}): Promise<ArtifactReadResult> {
  const item = options.version === undefined || options.version === artifact.version ? artifact : artifact.versions.find((v) => v.version === options.version);
  if (!item) {
    throw new Error(`No version ${options.version} (current v${artifact.version}; kept: ${artifact.versions.map((v) => v.version).join(", ") || "none"})`);
  }
  const size = artifactSize(item);
  const editable = size <= artifactLimits().maxEditBytes;
  if (options.outline || hasPart(options.part)) {
    const content = await store.readEditable(artifact, options.version);
    if (hasPart(options.part)) return { text: readArtifactPart(artifact, content, options.part!), size };
    return { text: artifactOutline(artifact, content), size };
  }
  const ranged = options.offset !== undefined || options.limit !== undefined;
  const limit = Math.max(1, Math.min(options.limit ?? ARTIFACT_READ_CHARS, 4 * ARTIFACT_READ_CHARS));
  const offset = Math.max(0, options.offset ?? 0);
  if (!ranged && size <= ARTIFACT_READ_CHARS) {
    return { text: await store.readContent(artifact, options.version), size, start: 0, end: size, more: false };
  }
  const opened = store.openContent(artifact, { version: options.version, start: offset, end: offset + limit - 1 });
  const bytes = await streamText(opened.stream as AsyncIterable<Uint8Array>);
  const { text, lead, trail } = decodeRange(bytes);
  const start = opened.start + lead;
  const end = opened.start + bytes.length - trail;
  const result: ArtifactReadResult = { text, size, start, end, more: end < size };
  if (!ranged && editable) result.outline = artifactOutline(artifact, await store.readContent(artifact, options.version));
  return result;
}

/** One line on the versions of an artifact against the limits: "12 versions, 3.1 MB of 1 GB (max 1000)". */
export function versionUsageLine(artifact: Artifact): string {
  const u = artifactVersionUsage(artifact);
  return `${u.count} earlier version${u.count === 1 ? "" : "s"}, ${formatArtifactBytes(u.bytes)} of ${formatArtifactBytes(u.maxBytes)} (max ${u.maxCount}; the oldest are pruned first)`;
}
