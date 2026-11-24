/**
 * Artifacts: what agents and people make to look at and keep — a document, a dashboard, a design,
 * a diagram. One concept with types:
 *
 * - `doc`: Markdown.
 * - `html`: a self-contained HTML page (a dashboard, a design, a small app). It runs isolated, with no
 *   network; it reads the instance's data sources through the `polpo` bridge, with the rights of whoever
 *   made it (an agent sees only the sources it is granted). Slides, Sheets and Motion use JSON in
 *   the same content field for direct editing and version history.
 * - `svg`, `mermaid`: a drawing, a diagram.
 * - `view`: a data view (JSON widget spec), the former Views, kept readable but deprecated.
 *
 * Every change keeps the previous content as a version, so any change can be undone.
 */

export const ARTIFACT_TYPES = ["doc", "html", "svg", "mermaid", "view"] as const;
export type ArtifactType = (typeof ARTIFACT_TYPES)[number];

/** Artifact kinds used by the workbench, with free-text kinds supported for existing callers. */
export const ARTIFACT_KINDS = ["dashboard", "design", "slides", "sheets", "motion", "app", "report", "page"] as const;

/** Content formats for tools that create artifacts for the dashboard. */
export const ARTIFACT_WORKSPACE_GUIDE = `Use type "doc" with Markdown for Docs. For a document with tabs, start with <!-- polpo-doc-tabs:v1 NAMESPACE --> on its own line, where NAMESPACE is 18 URL-safe letters, digits, underscores or hyphens, unique to this document. For each tab write <!-- polpo-doc-tab:NAMESPACE TAB_ID ENCODED_TITLE --> on its own line, a blank line, the tab’s Markdown and two line breaks. Keep each TAB_ID stable and unique (1–20 URL-safe letters, digits, underscores or hyphens) and encode each tab title with encodeURIComponent. Keep the existing header and markers when editing tabs. Inline dropdowns use <span data-polpo-doc-choice="ENCODED_CHOICE">LABEL</span>, where ENCODED_CHOICE is encodeURIComponent(JSON.stringify({id,name,options:[{id,label,color}],selected})). Use distinct safe ids of 1–20 URL-safe characters, a selected option id or omit selected, and one of slate, blue, green, amber, rose, violet for colors. Reuse a dropdown id to reuse its definition with an independent selection per occurrence. Use type "html" and kind "design" for a visual canvas. Write one artboard as standalone HTML with editable DOM elements. Define tweakable colors and sizes as named CSS custom properties in :root. For multiple artboards or pages, append <script type="application/json" data-polpo-design-workspace> to the primary HTML, with JSON {"version":1,"pages":[{"id":"page-1","name":"Page 1","boards":[{"id":"b1","name":"Overview","x":0,"y":0,"width":1024,"height":680,"html":""}]}]} and a closing script tag. Keep the first board's html empty because the outer document renders it. Give every additional board its own standalone HTML string, unique id, name, canvas position and pixel dimensions. Escape less-than signs in embedded HTML as JSON unicode escapes. Dashboards, small apps and reports use self-contained HTML.
Use type "html" and the matching kind for these editable workspaces. Pass the JSON object as a string in content:
- slides: {version:1, slides:[{id, layout:"title"|"content"|"split", title, body, secondary?, notes?, hidden?, theme?:"light"|"dark"|"accent", elements?:[{id,type:"text"|"rect"|"ellipse"|"image"|"table"|"video",x,y,w,h,text?,color?,fontSize?,src?,alt?,poster?,cells?,header?}]}]}. Element coordinates and dimensions are percentages. Text box fontSize is a percentage of slide width. Images use a PNG or JPEG data URL in src. Tables use a rectangular string[][] in cells (1–20 rows and columns), with header defaulting to true. Videos use an MP4 or WebM data URL or direct HTTPS .mp4/.webm URL in src, with optional PNG or JPEG poster data URL and alt text.
- sheets: {version:1, sheets:[{name,cells:{"A1":"Label","A2":"42","A3":"=SUM(A2:A2)"},styles?:{"A1":{bold?,italic?,underline?,align?:"left"|"center"|"right",color?,fill?,fontSize?,border?:"all"|"top"|"bottom"|"left"|"right",numberFormat?:"currency"|"percent"|"date",decimals?}},validations?:{"A1":{type:"checkbox"}|{type:"list",options:["Option 1","Option 2"]}},rules?:[{range,operator:"greaterThan"|"lessThan"|"equal"|"notEqual"|"greaterThanOrEqual"|"lessThanOrEqual",value,fill}],charts?:[{range,kind:"bar"|"line"|"pie",title}]}]}. When creating, write kind "sheets" before content. Write the worksheet name and its cells before any formatting or other optional fields, and list cells row by row so data can appear as it is written. Values and formulas are strings with A1 references. Use ranges like "A1:B6". A chart uses the first row for headings and the first column for category labels. Use up to 20 sheets, 500 rows and columns A through AZ. Colors use #RRGGBB, font sizes range from 8 to 36, decimals range from 0 to 8 and checkboxes use "TRUE" or "FALSE".
- motion: {version:1,width:1280,height:720,scenes:[{id,name,duration,background,transition?:"cut"|"fade",layers:[{id,type:"text"|"rect"|"ellipse",x,y,width,height,color,text?,fontSize?,animation?:"none"|"fade"|"rise"|"slide",delay?,animationDuration?}]}],audio?:{name,src,delay?}}. Positions and sizes are pixels. Duration, delay and animationDuration are seconds. Audio is an optional embedded base64 audio data URL; its delay is measured from the start of the project. Use six-digit hex colors. Give each slide, scene and element a stable unique id.`;

/**
 * Size limits of artifacts (settings.artifacts, applied with setArtifactLimits):
 *
 * - maxBytes: the largest content of one artifact (default 100 MB).
 * - inlineBytes: a content (current or a version) larger than this is kept as a blob file in the
 *   instance's storage directory instead of inside the artifact's record (default 256 KB).
 * - versions.maxCount / versions.maxTotalBytes: earlier versions kept per artifact — the newest, at
 *   most maxCount and at most maxTotalBytes in all (identical contents counted once, the current one
 *   not counted); the oldest are pruned first, the current content never (default 30 versions, 500 MB).
 * - maxEditBytes: the largest content changed in place (update, ops, patch) or read by part, which the
 *   server holds in memory to do it (default 50 MB); a larger one is replaced by upload.
 * - maxTotalBytes: every artifact of the instance together (contents and versions); over it new content
 *   is refused, from 80% a warning is shown (default 20 GB).
 */
export interface ArtifactLimits {
  maxBytes: number;
  inlineBytes: number;
  maxEditBytes: number;
  maxTotalBytes: number;
  versions: { maxCount: number; maxTotalBytes: number };
}

export const DEFAULT_ARTIFACT_LIMITS: Readonly<ArtifactLimits> = Object.freeze({
  maxBytes: 100 * 1024 * 1024,
  inlineBytes: 256 * 1024,
  maxEditBytes: 50 * 1024 * 1024,
  maxTotalBytes: 20 * 1024 * 1024 * 1024,
  versions: Object.freeze({ maxCount: 30, maxTotalBytes: 500 * 1024 * 1024 }),
});

/** settings.artifacts: every field optional. */
export interface ArtifactSettings {
  maxBytes?: number;
  inlineBytes?: number;
  maxEditBytes?: number;
  maxTotalBytes?: number;
  versions?: { maxCount?: number; maxTotalBytes?: number };
}

const positive = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;

function limitsFrom(s: ArtifactSettings = {}): ArtifactLimits {
  const d = DEFAULT_ARTIFACT_LIMITS;
  return {
    maxBytes: positive(s.maxBytes, d.maxBytes),
    inlineBytes: positive(s.inlineBytes, d.inlineBytes),
    maxEditBytes: positive(s.maxEditBytes, d.maxEditBytes),
    maxTotalBytes: positive(s.maxTotalBytes, d.maxTotalBytes),
    versions: {
      maxCount: positive(s.versions?.maxCount, d.versions.maxCount),
      maxTotalBytes: positive(s.versions?.maxTotalBytes, d.versions.maxTotalBytes),
    },
  };
}

let currentLimits: ArtifactLimits = limitsFrom();

/** The artifact limits in force in this process. */
export function artifactLimits(): ArtifactLimits {
  return currentLimits;
}

/** Apply settings.artifacts (missing or invalid fields keep the defaults); returns the limits in force. */
export function setArtifactLimits(settings: ArtifactSettings | undefined): ArtifactLimits {
  currentLimits = limitsFrom(settings);
  return currentLimits;
}

/**
 * Largest content the API sends whole with an artifact (GET /artifacts/:id) and the dashboard opens in
 * its editors; a larger one is read as a file (GET /artifacts/:id/content, with Range) or by part.
 */
export const ARTIFACT_VIEWER_BYTES = 10 * 1024 * 1024;

/** Largest content of an artifact by default (artifactLimits().maxBytes is the one in force). */
export const MAX_ARTIFACT_BYTES = DEFAULT_ARTIFACT_LIMITS.maxBytes;
/** Versions kept per artifact by default (artifactLimits().versions.maxCount is the one in force). */
export const MAX_ARTIFACT_VERSIONS = DEFAULT_ARTIFACT_LIMITS.versions.maxCount;

const encoder = new TextEncoder();
export const utf8Bytes = (text: string): number => encoder.encode(text).length;

/** "1.5 MB", "820 KB", "12 B" (binary units). */
export function formatArtifactBytes(bytes: number): string {
  const unit = (n: number, u: string) => `${n.toFixed(1).replace(/\.0$/, "")} ${u}`;
  if (bytes >= 1024 ** 3) return unit(bytes / 1024 ** 3, "GB");
  if (bytes >= 1024 ** 2) return unit(bytes / 1024 ** 2, "MB");
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/** A content kept as a file of the instance (content-addressed), not inside the artifact's record. */
export interface ArtifactBlobRef {
  /** SHA-256 of the UTF-8 bytes (hex). */
  sha256: string;
  /** Bytes. */
  size: number;
}

export interface ArtifactVersion {
  version: number;
  /** The content; empty when it is kept as a blob. */
  content: string;
  /** Where the content is when it is large (content is then empty). */
  blob?: ArtifactBlobRef;
  /** Bytes of the content. */
  size?: number;
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
  /** The current content (Markdown, HTML, SVG, Mermaid source, or a view's JSON); empty when it is a blob. */
  content: string;
  /** Where the current content is when it is large (content is then empty: the store reads it). */
  blob?: ArtifactBlobRef;
  /** Bytes of the current content. */
  size?: number;
  /** The beginning of a blob content (a few KB), for search and previews. */
  excerpt?: string;
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
  /** The task it was made in (an agent working on a task), and that task's mission. */
  taskId?: string;
  missionId?: string;
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
export type ArtifactSummary = Omit<Artifact, "content" | "versions" | "excerpt"> & { size: number };

export interface NewArtifact {
  title: string;
  type: ArtifactType;
  kind?: string;
  description?: string;
  /** The content (ignored when blob is given). */
  content: string;
  /** The content, already stored as a blob by the store. */
  blob?: ArtifactBlobRef;
  /** The beginning of a blob content. */
  excerpt?: string;
  createdBy: string;
  sessionId?: string;
  taskId?: string;
  missionId?: string;
  sources?: string[];
  refreshSeconds?: number;
  pinned?: boolean;
  tags?: string[];
  /** Who wrote the first version when it is not the creator (a person duplicating it), and why. */
  author?: string;
  note?: string;
}

export interface ArtifactPatch {
  /** The version an editor opened, if the caller requires a conditional save. */
  expectedVersion?: number;
  title?: string;
  kind?: string;
  description?: string;
  /** New content: the previous one becomes a version. */
  content?: string;
  /** New content already stored as a blob by the store (content is then ignored). */
  blob?: ArtifactBlobRef;
  /** The beginning of the blob content. */
  excerpt?: string;
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
  /**
   * Write a whole record as is (stores that keep large contents as blobs, migrations): ifUpdatedAt null
   * writes only a new id, a date only over a record with that updatedAt, undefined always. False when
   * the condition does not hold.
   */
  put?(artifact: Artifact, options?: { ifUpdatedAt?: string | null }): Promise<boolean>;
}

/** How much the versions of an artifact take, against the limits in force. */
export interface ArtifactVersionUsage {
  /** Earlier versions kept. */
  count: number;
  /** Bytes they take (identical contents counted once, the current content not counted). */
  bytes: number;
  /** Bytes of the current content. */
  currentBytes: number;
  maxCount: number;
  maxBytes: number;
}

export function isArtifactType(value: unknown): value is ArtifactType {
  return typeof value === "string" && (ARTIFACT_TYPES as readonly string[]).includes(value);
}

/** Bytes of the current content of an artifact (or of a version). */
export function artifactSize(item: Pick<Artifact, "content" | "blob" | "size"> | ArtifactVersion): number {
  if (item.blob) return item.blob.size;
  return typeof item.size === "number" ? item.size : utf8Bytes(item.content);
}

const workspaceKey = (kind?: string): string | null =>
  kind === "slides" ? "slides" : kind === "sheets" ? "sheets" : kind === "motion" ? "scenes" : null;

/** Checks the size of a content against the limits in force; returns the problem, if any. */
export function artifactSizeProblem(bytes: number): string | undefined {
  const { maxBytes } = artifactLimits();
  return bytes > maxBytes ? `The content is over ${formatArtifactBytes(maxBytes)} (${formatArtifactBytes(bytes)})` : undefined;
}

/** Checks a new or changed content; returns the problem, if any. */
export function artifactContentProblem(type: ArtifactType, content: string, kind?: string): string | undefined {
  if (type !== "doc" && !content.trim()) return "The content is empty";
  const sizeProblem = artifactSizeProblem(utf8Bytes(content));
  if (sizeProblem) return sizeProblem;
  if (type === "svg" && !/<svg[\s>]/i.test(content)) return "An svg artifact must contain an <svg> element";
  if (type === "view") {
    try {
      const view = JSON.parse(content) as { widgets?: unknown };
      if (!Array.isArray(view.widgets)) return "A view is a JSON object with widgets";
    } catch {
      return "A view must be valid JSON";
    }
  }
  if (type === "html" && content.trimStart().startsWith("{")) {
    const key = workspaceKey(kind);
    if (key) {
      try {
        const value = JSON.parse(content) as Record<string, unknown>;
        const items = value[key];
        if (value.version !== 1 || !Array.isArray(items) || !items.length) {
          return `A ${kind} workspace must have version 1 and a non-empty ${key} array`;
        }
      } catch {
        return `A ${kind} workspace must contain valid JSON`;
      }
    }
  }
  return undefined;
}

/** The listing of an artifact. */
export function summarizeArtifact(artifact: Artifact): ArtifactSummary {
  const { content: _content, versions: _versions, excerpt: _excerpt, ...rest } = artifact;
  return { ...rest, size: artifactSize(artifact) };
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

export class ArtifactEditConflictError extends Error {
  constructor() {
    super("This artifact changed while you were editing it.");
    this.name = "ArtifactEditConflictError";
  }
}

/**
 * The versions kept after a change, newest first: at most versions.maxCount, and at most
 * versions.maxTotalBytes in all (a content kept as one blob is counted once, the current content is not
 * counted because it is kept anyway). The oldest go first; the newest earlier version is always kept.
 */
export function pruneArtifactVersions(versions: ArtifactVersion[], current: Pick<Artifact, "blob">, limits = artifactLimits()): ArtifactVersion[] {
  const kept: ArtifactVersion[] = [];
  const counted = new Set<string>(current.blob ? [current.blob.sha256] : []);
  let bytes = 0;
  for (const version of versions) {
    if (kept.length >= limits.versions.maxCount) break;
    const key = version.blob?.sha256;
    const cost = key && counted.has(key) ? 0 : artifactSize(version);
    if (kept.length > 0 && bytes + cost > limits.versions.maxTotalBytes) break;
    if (key) counted.add(key);
    bytes += cost;
    kept.push(version);
  }
  return kept;
}

/** How much the versions of an artifact take, against the limits in force. */
export function artifactVersionUsage(artifact: Pick<Artifact, "versions" | "blob" | "content" | "size">, limits = artifactLimits()): ArtifactVersionUsage {
  const counted = new Set<string>(artifact.blob ? [artifact.blob.sha256] : []);
  let bytes = 0;
  for (const version of artifact.versions) {
    const key = version.blob?.sha256;
    if (key && counted.has(key)) continue;
    if (key) counted.add(key);
    bytes += artifactSize(version);
  }
  return {
    count: artifact.versions.length, bytes, currentBytes: artifactSize(artifact),
    maxCount: limits.versions.maxCount, maxBytes: limits.versions.maxTotalBytes,
  };
}

/** The current content of an artifact as a version (for its history). */
function asVersion(artifact: Artifact): ArtifactVersion {
  return {
    version: artifact.version,
    content: artifact.blob ? "" : artifact.content,
    ...(artifact.blob ? { blob: artifact.blob } : {}),
    size: artifactSize(artifact),
    author: artifact.author ?? artifact.createdBy,
    ...(artifact.note ? { note: artifact.note } : {}),
    at: artifact.updatedAt,
  };
}

/**
 * The artifact after a patch (pure): a changed content keeps the previous one as a version (newest
 * first, pruned to the version limits in force). Throws on an invalid content.
 */
export function applyArtifactPatch(artifact: Artifact, patch: ArtifactPatch, now = new Date().toISOString()): Artifact {
  if (patch.expectedVersion !== undefined && patch.expectedVersion !== artifact.version) {
    throw new ArtifactEditConflictError();
  }
  const next: Artifact = { ...artifact, updatedAt: now };
  if (patch.title !== undefined) next.title = patch.title.trim() || artifact.title;
  if (patch.kind !== undefined) next.kind = patch.kind.trim() || undefined;
  if (patch.description !== undefined) next.description = patch.description.trim() || undefined;
  if (patch.sources !== undefined) next.sources = patch.sources;
  if (patch.refreshSeconds !== undefined) next.refreshSeconds = patch.refreshSeconds === null ? undefined : patch.refreshSeconds;
  if (patch.pinned !== undefined) next.pinned = patch.pinned;
  if (patch.tags !== undefined) next.tags = patch.tags;
  const contentChanged = patch.blob
    ? patch.blob.sha256 !== artifact.blob?.sha256
    : patch.content !== undefined && (artifact.blob !== undefined || patch.content !== artifact.content);
  if (!contentChanged && next.kind !== artifact.kind && !artifact.blob) {
    // a new kind must still describe the current content (a doc is not a sheets workspace)
    const problem = artifactContentProblem(artifact.type, artifact.content, next.kind);
    if (problem) throw new Error(problem);
  }
  if (contentChanged) {
    if (patch.blob) {
      const problem = artifactSizeProblem(patch.blob.size);
      if (problem) throw new Error(problem);
      next.content = "";
      next.blob = patch.blob;
      next.size = patch.blob.size;
      if (patch.excerpt !== undefined) next.excerpt = patch.excerpt; else delete next.excerpt;
    } else {
      const content = patch.content ?? "";
      const problem = artifactContentProblem(artifact.type, content, next.kind);
      if (problem) throw new Error(problem);
      next.content = content;
      next.size = utf8Bytes(content);
      delete next.blob;
      delete next.excerpt;
    }
    next.version = artifact.version + 1;
    next.versions = pruneArtifactVersions([asVersion(artifact), ...artifact.versions], next);
    if (patch.author) next.author = patch.author; else delete next.author;
    if (patch.note?.trim()) next.note = patch.note.trim(); else delete next.note;
  }
  return next;
}

/** A new artifact (pure). Throws on an invalid type or content. */
export function buildArtifact(id: string, input: NewArtifact, now = new Date().toISOString()): Artifact {
  if (!isArtifactType(input.type)) throw new Error(`Unknown artifact type "${String(input.type)}" (${ARTIFACT_TYPES.join(", ")})`);
  const problem = input.blob ? artifactSizeProblem(input.blob.size) : artifactContentProblem(input.type, input.content, input.kind?.trim());
  if (problem) throw new Error(problem);
  return {
    id,
    title: input.title.trim() || "Untitled",
    type: input.type,
    ...(input.kind?.trim() ? { kind: input.kind.trim() } : {}),
    ...(input.description?.trim() ? { description: input.description.trim() } : {}),
    content: input.blob ? "" : input.content,
    ...(input.blob ? { blob: input.blob, ...(input.excerpt !== undefined ? { excerpt: input.excerpt } : {}) } : {}),
    size: input.blob ? input.blob.size : utf8Bytes(input.content),
    version: 1,
    ...(input.author && input.author !== input.createdBy ? { author: input.author } : {}),
    ...(input.note?.trim() ? { note: input.note.trim() } : {}),
    versions: [],
    createdBy: input.createdBy,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.taskId ? { taskId: input.taskId } : {}),
    ...(input.missionId ? { missionId: input.missionId } : {}),
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
