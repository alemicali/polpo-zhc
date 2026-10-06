import { config } from "@/lib/config";

// File preview helpers and state types, shared by the preview dialog and the
// useFilePreview hook. Kept out of the component module so Fast Refresh works.

// ── Helpers ──

/** Build a URL to the files API endpoint for reading a file */
export function fileReadUrl(path: string, download?: boolean): string {
  const base = config.baseUrl || "";
  const params = new URLSearchParams({ path });
  if (download) params.set("download", "1");
  return `${base}/api/v1/files/read?${params.toString()}`;
}

/** Build a URL to the files API preview endpoint */
export function filePreviewUrl(path: string): string {
  const base = config.baseUrl || "";
  return `${base}/api/v1/files/preview?path=${encodeURIComponent(path)}`;
}

/** Determine the preview category from a MIME type */
export function previewCategory(mime?: string, path?: string): "image" | "audio" | "video" | "pdf" | "code" | "text" | "mermaid" | "binary" {
  if (/\.(mmd|mermaid)$/i.test(path ?? "") || /^(text\/(vnd\.|x-)?mermaid|application\/mermaid)(;|$)/i.test(mime ?? "")) return "mermaid";
  if (!mime) return "binary";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  if (mime === "application/pdf") return "pdf";
  if (
    mime.startsWith("text/x-") ||
    mime === "text/typescript" ||
    mime === "text/javascript" ||
    mime === "text/css" ||
    mime === "text/html" ||
    mime === "application/json" ||
    mime === "application/x-ndjson" ||
    mime === "application/xml"
  ) return "code";
  if (mime.startsWith("text/")) return "text";
  return "binary";
}

/** Extract a language hint from MIME type for code blocks */
export function langFromMime(mime?: string): string {
  if (!mime) return "";
  const map: Record<string, string> = {
    "text/typescript": "typescript", "text/javascript": "javascript",
    "text/css": "css", "text/html": "html", "text/x-python": "python",
    "text/x-ruby": "ruby", "text/x-go": "go", "text/x-rust": "rust",
    "text/x-java": "java", "text/x-c": "c", "text/x-c++": "cpp",
    "text/x-sql": "sql", "text/x-shellscript": "bash",
    "text/yaml": "yaml", "text/markdown": "markdown",
    "application/json": "json", "application/x-ndjson": "json", "application/xml": "xml",
  };
  return map[mime] ?? "";
}

/** Guess MIME type from file extension */
export function mimeFromPath(path: string): string | undefined {
  const ext = path.split(".").pop()?.toLowerCase();
  if (!ext) return undefined;
  const map: Record<string, string> = {
    ts: "text/typescript", tsx: "text/typescript",
    js: "text/javascript", jsx: "text/javascript", mjs: "text/javascript",
    css: "text/css", html: "text/html", htm: "text/html",
    json: "application/json", jsonl: "application/json", xml: "application/xml",
    py: "text/x-python", rb: "text/x-ruby", go: "text/x-go",
    rs: "text/x-rust", java: "text/x-java", c: "text/x-c",
    cpp: "text/x-c++", h: "text/x-c", hpp: "text/x-c++",
    sql: "text/x-sql", sh: "text/x-shellscript", bash: "text/x-shellscript",
    yaml: "text/yaml", yml: "text/yaml",
    md: "text/markdown", mdx: "text/markdown",
    mmd: "text/vnd.mermaid", mermaid: "text/vnd.mermaid",
    txt: "text/plain", csv: "text/csv", log: "text/plain",
    svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg",
    jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
    ico: "image/x-icon", bmp: "image/bmp",
    mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg",
    mp4: "video/mp4", webm: "video/webm",
    pdf: "application/pdf",
    zip: "application/zip", gz: "application/gzip",
    wasm: "application/wasm",
    toml: "text/plain", env: "text/plain", gitignore: "text/plain",
    dockerfile: "text/plain", makefile: "text/plain",
  };
  return map[ext];
}

// ── Preview state ──

export interface FilePreviewItem {
  label: string;
  path?: string;
  url?: string;
  mimeType?: string;
  size?: number;
  text?: string;
  data?: unknown;
  type?: string;
}

export interface FilePreviewState {
  item: FilePreviewItem;
  content?: string;
  loading: boolean;
  error?: string;
}
