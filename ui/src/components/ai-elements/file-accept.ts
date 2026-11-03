/** File checks for the prompt input (kept out of the component module for fast refresh). */
/**
 * Does a file match an `accept` list (as for <input type="file">): "*\/*" or "*" is any file,
 * "image/*" a family, "audio/ogg" a type, ".ogg" an extension. Browsers leave the type empty for
 * extensions they do not know, so extensions are matched on the name.
 */
export function fileMatchesAccept(f: { name: string; type: string }, accept: string | undefined): boolean {
  const patterns = (accept ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (patterns.length === 0) return true;
  const type = (f.type ?? "").toLowerCase();
  const name = (f.name ?? "").toLowerCase();
  return patterns.some((pattern) => {
    if (pattern === "*/*" || pattern === "*") return true;
    if (pattern.startsWith(".")) return name.endsWith(pattern);
    if (pattern.endsWith("/*")) return type.startsWith(pattern.slice(0, -1));
    return type === pattern;
  });
}

const TYPES_BY_EXTENSION: Record<string, string> = {
  ogg: "audio/ogg", oga: "audio/ogg", opus: "audio/ogg", mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/aac",
  wav: "audio/wav", flac: "audio/flac", weba: "audio/webm", md: "text/markdown", csv: "text/csv",
};

/** The file's type, from its name when the browser does not know it (e.g. .ogg voice notes on some systems). */
export function fileMediaType(f: { name: string; type: string }): string {
  if (f.type) return f.type;
  const ext = f.name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  return (ext && TYPES_BY_EXTENSION[ext]) || "application/octet-stream";
}
