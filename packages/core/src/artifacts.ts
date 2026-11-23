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
export type ArtifactSummary = Omit<Artifact, "content" | "versions"> & { size: number };

export interface NewArtifact {
  title: string;
  type: ArtifactType;
  kind?: string;
  description?: string;
  content: string;
  createdBy: string;
  sessionId?: string;
  taskId?: string;
  missionId?: string;
  sources?: string[];
  refreshSeconds?: number;
  pinned?: boolean;
  tags?: string[];
}

export interface ArtifactPatch {
  /** The version an editor opened, if the caller requires a conditional save. */
  expectedVersion?: number;
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
export function artifactContentProblem(type: ArtifactType, content: string, kind?: string): string | undefined {
  if (type !== "doc" && !content.trim()) return "The content is empty";
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
  if (type === "html" && content.trimStart().startsWith("{")) {
    const key = kind === "slides" ? "slides" : kind === "sheets" ? "sheets" : kind === "motion" ? "scenes" : null;
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

export class ArtifactEditConflictError extends Error {
  constructor() {
    super("This artifact changed while you were editing it.");
    this.name = "ArtifactEditConflictError";
  }
}

/**
 * The artifact after a patch (pure): a changed content keeps the previous one as a version (newest
 * first, at most MAX_ARTIFACT_VERSIONS). Throws on an invalid content.
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
  if (patch.content !== undefined && patch.content !== artifact.content) {
    const problem = artifactContentProblem(artifact.type, patch.content, next.kind);
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
  const problem = artifactContentProblem(input.type, input.content, input.kind?.trim());
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
