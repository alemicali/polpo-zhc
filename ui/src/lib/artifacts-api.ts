/** Artifacts: documents, dashboards, designs and diagrams that agents and people make. */
import { apiUrl, config } from "@/lib/config";

export type ArtifactType = "doc" | "html" | "svg" | "mermaid" | "view";

export interface ArtifactVersion {
  version: number;
  content: string;
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
  sources?: string[];
  refreshSeconds?: number;
  pinned?: boolean;
  tags?: string[];
  createdAt: string;
  updatedAt: string;
  size: number;
}

export interface Artifact extends Omit<ArtifactSummary, "size"> {
  content: string;
  versions: ArtifactVersion[];
}

export type ArtifactDataMethod = "sources" | "describe" | "query" | "sql";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body) headers.set("content-type", "application/json");
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

export const artifactsApi = {
  list: (filter: { type?: ArtifactType; q?: string; sessionId?: string } = {}) => {
    const params = new URLSearchParams(Object.entries(filter).filter(([, v]) => v) as [string, string][]);
    return request<ArtifactSummary[]>(`/artifacts${params.size ? `?${params}` : ""}`);
  },
  get: (id: string) => request<Artifact>(one(id)),
  update: (id: string, patch: Partial<Pick<Artifact, "title" | "description" | "content" | "pinned">> & { note?: string }) =>
    request<Artifact>(one(id), { method: "PATCH", body: JSON.stringify(patch) }),
  restore: (id: string, version: number) => request<Artifact>(`${one(id)}/restore/${version}`, { method: "POST" }),
  remove: (id: string) => request<{ deleted: boolean }>(one(id), { method: "DELETE" }),
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

/** The artifact id in a tool result ("Created artifact art_… …"). */
export function artifactIdOf(result: string | undefined): string | undefined {
  return result ? /\b(art_[\w-]+)/.exec(result)?.[1] : undefined;
}
