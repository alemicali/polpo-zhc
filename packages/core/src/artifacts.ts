/**
 * Artifacts: what agents and people make to look at and keep — a document, a dashboard, a design,
 * a diagram. One concept with types:
 *
 * - `doc`: Markdown.
 * - `html`: a self-contained HTML page (a dashboard, a design, a small app). It runs isolated, with no
 *   network; it reads the instance's data sources through the `polpo` bridge, with the rights of whoever
 *   made it (an agent sees only the sources it is granted).
 * - `svg`, `mermaid`: a drawing, a diagram.
 * - `view`: a data view (JSON widget spec), the former Views, kept readable but deprecated.
 *
 * Every change keeps the previous content as a version, so any change can be undone.
 */

export const ARTIFACT_TYPES = ["doc", "html", "svg", "mermaid", "view"] as const;
export type ArtifactType = (typeof ARTIFACT_TYPES)[number];

/** What an html artifact is, for listing and the prompt (free text accepted, these are the usual ones). */
export const ARTIFACT_KINDS = ["dashboard", "design", "app", "report", "page"] as const;

/** Largest content kept, per artifact. */
export const MAX_ARTIFACT_BYTES = 1_000_000;
/** Versions kept per artifact (the newest). */
export const MAX_ARTIFACT_VERSIONS = 30;

const encoder = new TextEncoder();
const utf8Bytes = (text: string): number => encoder.encode(text).length;

export interface ArtifactVersion {
  version: number;
  content: string;
  /** Agent name, "polpo", or a person. */
  author?: string;
  /** What changed, in a few words. */
  note?: string;
  at: string;
}

export interface Artifact {
  id: string;
  title: string;
  type: ArtifactType;
  /** For html: dashboard, design, app… */
  kind?: string;
  description?: string;
  /** The current content (Markdown, HTML, SVG, Mermaid source, or a view's JSON). */
  content: string;
  /** The current version number (1 = first). */
  version: number;
  /** Who wrote the current version, and why (when it is not the first). */
  author?: string;
  note?: string;
  /** Earlier versions, newest first (the current one is not among them). */
  versions: ArtifactVersion[];
  /** Who made it: an agent's name, "polpo", or a person ("person:<email or name>"). Its data rights are theirs. */
  createdBy: string;
  /** The chat it was made in. */
  sessionId?: string;
  /** Data sources the content reads (declared by the author, for listing and refresh). */
  sources?: string[];
  /** Re-run the data every N seconds while open (html). */
  refreshSeconds?: number;
  pinned?: boolean;
  tags?: string[];
  createdAt: string;
  updatedAt: string;
}

/** An artifact as listed (no content, no versions). */
export type ArtifactSummary = Omit<Artifact, "content" | "versions"> & { size: number };

export interface NewArtifact {
  title: string;
  type: ArtifactType;
  kind?: string;
  description?: string;
  content: string;
  createdBy: string;
  sessionId?: string;
  sources?: string[];
  refreshSeconds?: number;
  pinned?: boolean;
  tags?: string[];
}

export interface ArtifactPatch {
  title?: string;
  kind?: string;
  description?: string;
  /** New content: the previous one becomes a version. */
  content?: string;
  sources?: string[];
  refreshSeconds?: number | null;
  pinned?: boolean;
  tags?: string[];
  /** Who changed it and why (for the version). */
  author?: string;
  note?: string;
}

export interface ArtifactFilter {
  type?: ArtifactType;
  kind?: string;
  createdBy?: string;
  sessionId?: string;
  /** Title or description contains it (case-insensitive). */
  q?: string;
}

export interface ArtifactStore {
  list(filter?: ArtifactFilter): Promise<ArtifactSummary[]>;
  get(id: string): Promise<Artifact | undefined>;
  create(input: NewArtifact): Promise<Artifact>;
  update(id: string, patch: ArtifactPatch): Promise<Artifact | undefined>;
  /** Make an earlier version the current content (as a new version). */
  restore(id: string, version: number, author?: string): Promise<Artifact | undefined>;
  delete(id: string): Promise<boolean>;
}

export function isArtifactType(value: unknown): value is ArtifactType {
  return typeof value === "string" && (ARTIFACT_TYPES as readonly string[]).includes(value);
}

/** Checks a new or changed content; returns the problem, if any. */
export function artifactContentProblem(type: ArtifactType, content: string): string | undefined {
  if (!content.trim()) return "The content is empty";
  if (utf8Bytes(content) > MAX_ARTIFACT_BYTES) return `The content is over ${MAX_ARTIFACT_BYTES / 1000} KB`;
  if (type === "svg" && !/<svg[\s>]/i.test(content)) return "An svg artifact must contain an <svg> element";
  if (type === "view") {
    try {
      const view = JSON.parse(content) as { widgets?: unknown };
      if (!Array.isArray(view.widgets)) return "A view is a JSON object with widgets";
    } catch {
      return "A view must be valid JSON";
    }
  }
  return undefined;
}

/** The listing of an artifact. */
export function summarizeArtifact(artifact: Artifact): ArtifactSummary {
  const { content, versions: _versions, ...rest } = artifact;
  return { ...rest, size: utf8Bytes(content) };
}

export function matchesArtifactFilter(artifact: Pick<Artifact, "type" | "kind" | "createdBy" | "sessionId" | "title" | "description">, filter: ArtifactFilter = {}): boolean {
  if (filter.type && artifact.type !== filter.type) return false;
  if (filter.kind && artifact.kind !== filter.kind) return false;
  if (filter.createdBy && artifact.createdBy !== filter.createdBy) return false;
  if (filter.sessionId && artifact.sessionId !== filter.sessionId) return false;
  if (filter.q) {
    const q = filter.q.toLowerCase();
    if (!artifact.title.toLowerCase().includes(q) && !(artifact.description ?? "").toLowerCase().includes(q)) return false;
  }
  return true;
}

/**
 * The artifact after a patch (pure): a changed content keeps the previous one as a version (newest
 * first, at most MAX_ARTIFACT_VERSIONS). Throws on an invalid content.
 */
export function applyArtifactPatch(artifact: Artifact, patch: ArtifactPatch, now = new Date().toISOString()): Artifact {
  const next: Artifact = { ...artifact, updatedAt: now };
  if (patch.title !== undefined) next.title = patch.title.trim() || artifact.title;
  if (patch.kind !== undefined) next.kind = patch.kind.trim() || undefined;
  if (patch.description !== undefined) next.description = patch.description.trim() || undefined;
  if (patch.sources !== undefined) next.sources = patch.sources;
  if (patch.refreshSeconds !== undefined) next.refreshSeconds = patch.refreshSeconds === null ? undefined : patch.refreshSeconds;
  if (patch.pinned !== undefined) next.pinned = patch.pinned;
  if (patch.tags !== undefined) next.tags = patch.tags;
  if (patch.content !== undefined && patch.content !== artifact.content) {
    const problem = artifactContentProblem(artifact.type, patch.content);
    if (problem) throw new Error(problem);
    const previous: ArtifactVersion = {
      version: artifact.version,
      content: artifact.content,
      author: artifact.author ?? artifact.createdBy,
      ...(artifact.note ? { note: artifact.note } : {}),
      at: artifact.updatedAt,
    };
    next.content = patch.content;
    next.version = artifact.version + 1;
    next.versions = [previous, ...artifact.versions].slice(0, MAX_ARTIFACT_VERSIONS);
    if (patch.author) next.author = patch.author; else delete next.author;
    if (patch.note?.trim()) next.note = patch.note.trim(); else delete next.note;
  }
  return next;
}

/** A new artifact (pure). Throws on an invalid type or content. */
export function buildArtifact(id: string, input: NewArtifact, now = new Date().toISOString()): Artifact {
  if (!isArtifactType(input.type)) throw new Error(`Unknown artifact type "${String(input.type)}" (${ARTIFACT_TYPES.join(", ")})`);
  const problem = artifactContentProblem(input.type, input.content);
  if (problem) throw new Error(problem);
  return {
    id,
    title: input.title.trim() || "Untitled",
    type: input.type,
    ...(input.kind?.trim() ? { kind: input.kind.trim() } : {}),
    ...(input.description?.trim() ? { description: input.description.trim() } : {}),
    content: input.content,
    version: 1,
    versions: [],
    createdBy: input.createdBy,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.sources?.length ? { sources: input.sources } : {}),
    ...(input.refreshSeconds ? { refreshSeconds: input.refreshSeconds } : {}),
    ...(input.pinned ? { pinned: true } : {}),
    ...(input.tags?.length ? { tags: input.tags } : {}),
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Apply find/replace edits to a content (each `find` must occur exactly once), so an agent can change
 * part of a long artifact without rewriting it. Throws naming the edit that does not apply.
 */
export function applyArtifactEdits(content: string, edits: ReadonlyArray<{ find: string; replace: string }>): string {
  let out = content;
  edits.forEach((edit, i) => {
    if (!edit.find) throw new Error(`Edit ${i + 1}: find is empty`);
    const first = out.indexOf(edit.find);
    if (first < 0) throw new Error(`Edit ${i + 1}: the text to find is not in the artifact`);
    if (out.indexOf(edit.find, first + edit.find.length) >= 0) throw new Error(`Edit ${i + 1}: the text to find occurs more than once; include more context`);
    out = out.slice(0, first) + edit.replace + out.slice(first + edit.find.length);
  });
  return out;
}
