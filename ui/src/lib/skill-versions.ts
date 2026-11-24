/** Skill versions in the dashboard: who made a version and how, in words. */

/** "person:ada@example.com" → "ada@example.com"; "mcp:Claude" → "Claude (MCP)"; "polpo" → "Polpo". */
export function versionAuthor(author: string): string {
  if (author.startsWith("person:")) return author.slice("person:".length);
  if (author.startsWith("mcp:")) return `${author.slice("mcp:".length)} (MCP)`;
  if (author === "polpo") return "Polpo";
  if (author === "cli") return "CLI";
  return author;
}

const SOURCE_LABEL: Record<string, string> = {
  create: "Created", upload: "Upload", git: "Git", local: "Local install", edit: "Edit", restore: "Restore", external: "Found on disk",
};

/** "Upload", "Restore of v2", "Found on disk"… */
export function versionSourceLabel(v: { source: string; restoredFrom?: number }): string {
  const label = SOURCE_LABEL[v.source] ?? v.source;
  return v.source === "restore" && v.restoredFrom ? `${label} of v${v.restoredFrom}` : label;
}
