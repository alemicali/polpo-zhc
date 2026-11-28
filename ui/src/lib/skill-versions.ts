/** Skill versions in the dashboard: who made a version and how, in words; the skills' versioning setting. */
import { apiUrl, config } from "@/lib/config";

/** "person:ada@example.com" → "ada@example.com"; "mcp:Claude" → "Claude (MCP)"; "polpo" → "Polpo". */
export function versionAuthor(author: string): string {
  if (author.startsWith("person:")) return author.slice("person:".length);
  if (author.startsWith("mcp:")) return `${author.slice("mcp:".length)} (MCP)`;
  if (author.startsWith("system:")) return author.slice("system:".length);
  if (author === "polpo") return "Polpo";
  if (author === "cli") return "CLI";
  return author;
}

const SOURCE_LABEL: Record<string, string> = {
  create: "Created", upload: "Upload", git: "Git", local: "Local install", edit: "Edit", restore: "Restore",
  external: "Found on disk", publish: "Published",
};

/** "Upload", "Restore of v2", "Found on disk"… */
export function versionSourceLabel(v: { source: string; restoredFrom?: number }): string {
  const label = SOURCE_LABEL[v.source] ?? v.source;
  return v.source === "restore" && v.restoredFrom ? `${label} of v${v.restoredFrom}` : label;
}

/** A version's name: its semver ("1.2.0"), else its storage number ("v3"). */
export function versionLabel(v: { version: number; semver?: string }): string {
  return v.semver ?? `v${v.version}`;
}

const EVENT_LABEL: Record<string, string> = {
  initial: "Initial version", migration: "Versioning enabled", publish: "Published", rollback: "Rollback",
  discard: "Draft discarded", rebase: "Draft rebased",
};

/** A lifecycle event's action in words: "Published", "Rollback", "Draft discarded"… */
export function versionEventLabel(action: string): string {
  return EVENT_LABEL[action] ?? action;
}

/** settings.skills.versioning.autoPublishApiUpdates (PATCH /config/settings). */
export async function saveAutoPublishSkillUpdates(value: boolean): Promise<void> {
  const headers = new Headers({ "content-type": "application/json" });
  if (config.apiKey) headers.set("authorization", `Bearer ${config.apiKey}`);
  const res = await fetch(apiUrl("/api/v1/config/settings"), {
    method: "PATCH", headers, credentials: "include",
    body: JSON.stringify({ skills: { versioning: { autoPublishApiUpdates: value } } }),
  });
  const body = await res.json().catch(() => null) as { ok?: boolean; error?: string } | null;
  if (!res.ok || !body?.ok) throw new Error(body?.error || `Could not save (${res.status})`);
}
