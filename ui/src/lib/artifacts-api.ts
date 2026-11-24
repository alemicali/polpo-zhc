/** Artifacts: documents, dashboards, designs and diagrams that agents and people make. */
import { apiUrl, config } from "@/lib/config";

export type ArtifactType = "doc" | "html" | "svg" | "mermaid" | "view";

export interface ArtifactVersion {
  version: number;
  /** Empty for a large version: read it with artifactsApi.version. */
  content: string;
  /** Bytes, and where a large version is kept. */
  size?: number;
  blob?: { sha256: string; size: number };
  author?: string;
  note?: string;
  at: string;
}

export interface ArtifactSummary {
  id: string;
  title: string;
  type: ArtifactType;
  kind?: string;
  description?: string;
  version: number;
  author?: string;
  note?: string;
  createdBy: string;
  sessionId?: string;
  /** The task it was made in (an agent working on a task), and that task's mission. */
  taskId?: string;
  missionId?: string;
  sources?: string[];
  refreshSeconds?: number;
  pinned?: boolean;
  tags?: string[];
  createdAt: string;
  updatedAt: string;
  size: number;
}

/** How much the versions take, against the limits (settings.artifacts.versions). */
export interface ArtifactVersionUsage {
  count: number;
  bytes: number;
  currentBytes: number;
  maxCount: number;
  maxBytes: number;
}

export interface Artifact extends Omit<ArtifactSummary, "size"> {
  content: string;
  versions: ArtifactVersion[];
  size?: number;
  /** The content is over the viewer limit: it is read as a file or by part, not opened in the editors. */
  contentOmitted?: boolean;
  /** The beginning of a large content. */
  excerpt?: string;
  usage?: ArtifactVersionUsage;
}

export interface ArtifactRead {
  text: string;
  size: number;
  start?: number;
  end?: number;
  more?: boolean;
  outline?: string;
}

export interface ArtifactUploadOptions {
  title?: string;
  type?: Exclude<ArtifactType, "view">;
  kind?: string;
  filename?: string;
  /** Bytes sent so far, of the total. */
  onProgress?: (sent: number, total: number) => void;
  /** Files over this go in parts (default ARTIFACT_UPLOAD_PART_BYTES). */
  partBytes?: number;
}

/** Larger files go in parts of this size (with progress). */
export const ARTIFACT_UPLOAD_PART_BYTES = 8 * 1024 * 1024;
/** Over this, the editors warn that a content is large (and may be slow). */
export const ARTIFACT_LARGE_WARNING_BYTES = 2 * 1024 * 1024;

export type ArtifactDataMethod = "sources" | "describe" | "query" | "sql";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  if (config.apiKey) headers.set("authorization", `Bearer ${config.apiKey}`);
  let response: Response;
  try {
    response = await fetch(apiUrl(`/api/v1${path}`), { ...init, headers, credentials: "include" });
  } catch {
    throw new Error("Could not reach the Polpo server");
  }
  const body = await response.json().catch(() => null) as { ok?: boolean; data?: unknown; error?: unknown } | null;
  if (!response.ok || !body?.ok) {
    const error = typeof body?.error === "string" ? body.error : (body?.error as { message?: string } | undefined)?.message;
    throw new Error(error || `Artifact request failed (${response.status})`);
  }
  return body.data as T;
}

const one = (id: string) => `/artifacts/${encodeURIComponent(id)}`;

const query = (values: Record<string, string | number | boolean | undefined>) => {
  const params = new URLSearchParams(Object.entries(values).filter(([, v]) => v !== undefined && v !== "" && v !== false).map(([k, v]) => [k, String(v)]));
  return params.size ? `?${params}` : "";
};

/** A file as the body: in one request, or in parts with progress when it is large; then the finishing call. */
async function sendFile<T>(file: Blob, filename: string | undefined, opts: Pick<ArtifactUploadOptions, "onProgress" | "partBytes">, single: () => Promise<T>, finish: (uploadId: string) => Promise<T>): Promise<T> {
  const { onProgress } = opts;
  const partBytes = opts.partBytes ?? ARTIFACT_UPLOAD_PART_BYTES;
  onProgress?.(0, file.size);
  if (file.size <= partBytes) {
    const result = await single();
    onProgress?.(file.size, file.size);
    return result;
  }
  let uploadId: string | undefined;
  for (let at = 0; at < file.size; at += partBytes) {
    const more = at + partBytes < file.size;
    const part = await request<{ uploadId: string; size: number }>(`/artifacts/uploads${query({ append_to: uploadId, more, filename })}`, {
      method: "POST", body: file.slice(at, at + partBytes), headers: { "content-type": "application/octet-stream" },
    });
    uploadId = part.uploadId;
    onProgress?.(part.size, file.size);
  }
  return finish(uploadId!);
}

export const artifactsApi = {
  list: (filter: { type?: ArtifactType; q?: string; sessionId?: string; mine?: boolean } = {}) => {
    const params = new URLSearchParams(Object.entries(filter).filter(([, value]) => value).map(([key, value]) => [key, String(value)]));
    return request<ArtifactSummary[]>(`/artifacts${params.size ? `?${params}` : ""}`);
  },
  get: (id: string) => request<Artifact>(one(id)),
  preview: (id: string, signal?: AbortSignal) => request<{ content: string }>(`${one(id)}?preview=1`, { signal }),
  create: (input: Pick<Artifact, "title" | "type" | "content" | "kind">) =>
    request<Artifact>("/artifacts", { method: "POST", body: JSON.stringify(input) }),
  update: (id: string, patch: Partial<Pick<Artifact, "title" | "description" | "content" | "pinned">> & { note?: string; expectedVersion?: number }) =>
    request<Artifact>(one(id), { method: "PATCH", body: JSON.stringify(patch) }),
  duplicate: (id: string, version: number) => request<Artifact>(`${one(id)}/duplicate`, { method: "POST", body: JSON.stringify({ version }) }),
  restore: (id: string, version: number) => request<Artifact>(`${one(id)}/restore/${version}`, { method: "POST" }),
  remove: (id: string) => request<{ deleted: boolean }>(one(id), { method: "DELETE" }),
  /** One version with its content (left out over the viewer limit). */
  version: (id: string, version: number) => request<ArtifactVersion & { contentOmitted?: boolean }>(`${one(id)}/versions/${version}`),
  /** A byte range, the outline, or one part (tab, slide, sheet + range, board, page, scene). */
  read: (id: string, opts: Record<string, string | number | boolean | undefined>, signal?: AbortSignal) =>
    request<ArtifactRead>(`${one(id)}/read${query(opts)}`, { signal }),
  /** The content as a file (Range supported). */
  contentUrl: (id: string, opts: { version?: number; download?: boolean } = {}) => apiUrl(`/api/v1${one(id)}/content${query(opts)}`),
  /** Create an artifact from a file (type detected from its name and content unless given). */
  upload: (file: Blob, opts: ArtifactUploadOptions = {}) => {
    const filename = opts.filename ?? (file as File).name;
    const fields = { title: opts.title, type: opts.type, kind: opts.kind, filename };
    return sendFile(file, filename, opts,
      () => request<Artifact>(`/artifacts/upload${query(fields)}`, { method: "POST", body: file, headers: { "content-type": "application/octet-stream" } }),
      (uploadId) => request<Artifact>(`/artifacts/uploads/${encodeURIComponent(uploadId)}/finalize`, { method: "POST", body: JSON.stringify(fields) }));
  },
  /** Replace the content with a file (the previous one becomes a version); refused if it changed since expectedVersion. */
  replaceContent: (id: string, file: Blob, opts: { expectedVersion: number; filename?: string } & Pick<ArtifactUploadOptions, "onProgress" | "partBytes">) => {
    const filename = opts.filename ?? (file as File).name;
    return sendFile(file, filename, opts,
      () => request<Artifact>(`${one(id)}/content${query({ expectedVersion: opts.expectedVersion, filename })}`, { method: "PUT", body: file, headers: { "content-type": "application/octet-stream" } }),
      (uploadId) => request<Artifact>(`/artifacts/uploads/${encodeURIComponent(uploadId)}/finalize`, { method: "POST", body: JSON.stringify({ id, expectedVersion: opts.expectedVersion }) }));
  },
  data: (id: string, method: ArtifactDataMethod, params: unknown) =>
    request<unknown>(`${one(id)}/data`, { method: "POST", body: JSON.stringify({ method, params }) }),
};

export const ARTIFACT_TYPE_LABEL: Record<ArtifactType, string> = {
  doc: "Document",
  html: "Page",
  svg: "Drawing",
  mermaid: "Diagram",
  view: "Legacy view",
};

/** What a person sees as the artifact's kind: the html kind (Dashboard, Design…) or the type. */
export function artifactLabel(a: Pick<ArtifactSummary, "type" | "kind">): string {
  if (a.type === "html" && a.kind) return a.kind.charAt(0).toUpperCase() + a.kind.slice(1);
  return ARTIFACT_TYPE_LABEL[a.type];
}

/** Structured workspaces use versioned JSON. Earlier HTML artifacts can have the same kind. */
export function artifactWorkspace(a: Pick<Artifact, "type" | "kind">, content: string): "slides" | "sheets" | "motion" | undefined {
  if (a.type !== "html" || !content.trimStart().startsWith("{")) return undefined;
  return a.kind === "slides" || a.kind === "sheets" || a.kind === "motion" ? a.kind : undefined;
}

export function downloadArtifactFile(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** File name and media type to download an artifact. */
export function artifactDownload(a: Pick<Artifact, "title" | "type">): { filename: string; mime: string } {
  const base = a.title.trim().replace(/[^\w\- ]+/g, "").replace(/\s+/g, "-").toLowerCase() || "artifact";
  switch (a.type) {
    case "doc": return { filename: `${base}.md`, mime: "text/markdown" };
    case "html": return { filename: `${base}.html`, mime: "text/html" };
    case "svg": return { filename: `${base}.svg`, mime: "image/svg+xml" };
    case "mermaid": return { filename: `${base}.mmd`, mime: "text/plain" };
    default: return { filename: `${base}.json`, mime: "application/json" };
  }
}

/** Save an artifact's content (the current one, or a version's) as a file. */
export function saveArtifactFile(a: Pick<Artifact, "title" | "type" | "kind">, content: string): void {
  const { filename, mime } = artifactDownload(a);
  if (artifactWorkspace(a, content)) {
    downloadArtifactFile(filename.replace(/\.html$/, ".json"), new Blob([content], { type: "application/json" }));
  } else {
    downloadArtifactFile(filename, new Blob([content], { type: mime }));
  }
}

/** The artifact's address in the dashboard, to share. */
export function artifactLink(id: string): string {
  const path = `/artifacts/${encodeURIComponent(id)}`;
  // the desktop app runs from file:// with hash routes
  return window.location.protocol === "file:" ? `${window.location.href.split("#")[0]}#${path}` : `${window.location.origin}${path}`;
}

/** The artifact id in a tool result ("Created artifact art_… …"). */
export function artifactIdOf(result: string | undefined): string | undefined {
  return result ? /\b(art_[\w-]+)/.exec(result)?.[1] : undefined;
}

/** Download the content (or a version) as a file, through the API (cookie or API key). */
export async function downloadArtifactContent(artifact: Pick<Artifact, "id" | "title" | "type">, version?: number): Promise<void> {
  const headers = new Headers();
  if (config.apiKey) headers.set("authorization", `Bearer ${config.apiKey}`);
  const response = await fetch(artifactsApi.contentUrl(artifact.id, { download: true, ...(version ? { version } : {}) }), { headers, credentials: "include" });
  if (!response.ok) throw new Error(`Download failed (${response.status})`);
  const name = /filename="([^"]+)"/.exec(response.headers.get("content-disposition") ?? "")?.[1] ?? artifactDownload(artifact).filename;
  downloadArtifactFile(name, await response.blob());
}
