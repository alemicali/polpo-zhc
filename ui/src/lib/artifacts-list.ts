/** The artifacts list: how it sorts, reads sizes and times, and which layout (table or preview) a person chose. */
import { artifactLabel, type ArtifactSummary, type ArtifactType } from "@/lib/artifacts-api";

export type ArtifactsLayout = "table" | "preview";
export type ArtifactSortKey = "title" | "type" | "createdBy" | "origin" | "size" | "updatedAt";
export interface ArtifactSort { key: ArtifactSortKey; dir: "asc" | "desc" }

export const DEFAULT_ARTIFACT_SORT: ArtifactSort = { key: "updatedAt", dir: "desc" };
export const ARTIFACTS_LAYOUT_KEY = "polpo:artifacts:layout";

/** The layout remembered in this browser (table when nothing is stored, or storage is blocked). */
export function readArtifactsLayout(): ArtifactsLayout {
  try {
    return window.localStorage.getItem(ARTIFACTS_LAYOUT_KEY) === "preview" ? "preview" : "table";
  } catch {
    return "table";
  }
}

export function writeArtifactsLayout(layout: ArtifactsLayout): void {
  try {
    window.localStorage.setItem(ARTIFACTS_LAYOUT_KEY, layout);
  } catch {
    // storage blocked (private window, previews): the choice lasts for this visit only
  }
}

/** Who made it, for people: an agent's name, the product for "polpo", a person's name or email. */
export function artifactAuthor(by: string, product: string): string {
  return by.startsWith("person:") ? by.slice("person:".length) : by === "polpo" ? product : by;
}

/** Where it came from: a task (and its mission), a chat, or nothing known. */
export function artifactOrigin(
  a: Pick<ArtifactSummary, "taskId" | "missionId" | "sessionId">,
  names: { task?: (id: string) => string | undefined; mission?: (id: string) => string | undefined } = {},
): { label: string; to: string } | null {
  if (a.taskId) {
    const task = names.task?.(a.taskId) ?? a.taskId;
    const mission = a.missionId ? names.mission?.(a.missionId) ?? a.missionId : undefined;
    return { label: mission ? `${mission} · ${task}` : task, to: `/tasks/${encodeURIComponent(a.taskId)}` };
  }
  if (a.missionId) return { label: names.mission?.(a.missionId) ?? a.missionId, to: `/missions/${encodeURIComponent(a.missionId)}` };
  if (a.sessionId) return { label: "Chat", to: `/chat?session=${encodeURIComponent(a.sessionId)}` };
  return null;
}

export function formatArtifactSize(bytes: number | undefined): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes)) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** "just now", "5m ago", "3h ago", "2d ago", then the date. */
export function relativeTime(iso: string, now = Date.now()): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "—";
  const diff = Math.max(0, now - t);
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  return new Date(t).toLocaleDateString();
}

export function absoluteTime(iso: string): string {
  const d = new Date(iso);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

/** The list sorted by a column (ties: newest first). Pinned artifacts do not jump the order. */
export function sortArtifacts(
  items: ArtifactSummary[],
  sort: ArtifactSort,
  value: { author: (a: ArtifactSummary) => string; origin: (a: ArtifactSummary) => string },
): ArtifactSummary[] {
  const key = (a: ArtifactSummary): string | number => {
    switch (sort.key) {
      case "title": return a.title.toLowerCase();
      case "type": return artifactLabel(a).toLowerCase();
      case "createdBy": return value.author(a).toLowerCase();
      case "origin": return value.origin(a).toLowerCase();
      case "size": return a.size ?? -1;
      case "updatedAt": return a.updatedAt;
    }
  };
  const sign = sort.dir === "asc" ? 1 : -1;
  return [...items].sort((x, y) => {
    const a = key(x);
    const b = key(y);
    const c = typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b));
    return c !== 0 ? c * sign : y.updatedAt.localeCompare(x.updatedAt);
  });
}

/** Next sort when a header is clicked: same column flips, a new one starts descending for times and sizes. */
export function nextArtifactSort(current: ArtifactSort, key: ArtifactSortKey): ArtifactSort {
  if (current.key === key) return { key, dir: current.dir === "asc" ? "desc" : "asc" };
  return { key, dir: key === "updatedAt" || key === "size" ? "desc" : "asc" };
}

const TYPE_ORDER: ArtifactType[] = ["html", "doc", "mermaid", "svg", "view"];
export const ARTIFACT_GROUP_LABEL: Record<ArtifactType, string> = { html: "Pages", doc: "Documents", mermaid: "Diagrams", svg: "Drawings", view: "Legacy views" };

/** The list grouped by type, in a stable order of types (each group keeps the list's order). */
export function groupArtifactsByType(items: ArtifactSummary[]): { type: ArtifactType; items: ArtifactSummary[] }[] {
  return TYPE_ORDER.map((type) => ({ type, items: items.filter((a) => a.type === type) })).filter((g) => g.items.length > 0);
}
