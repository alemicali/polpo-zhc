/**
 * Skill bundles in the dashboard: the file tree of a skill, how each file is shown, relative links
 * inside SKILL.md, and a dropped folder zipped in the browser (stored, no compression) so it is
 * uploaded exactly like a .skill archive.
 */

export interface SkillFile { path: string; size: number }

export interface TreeNode {
  name: string;
  /** Full relative path ("" for the root). */
  path: string;
  kind: "dir" | "file";
  size: number;
  children: TreeNode[];
}

/** Folders first (alphabetical), then files; SKILL.md first at the root. */
export function buildFileTree(files: SkillFile[]): TreeNode {
  const root: TreeNode = { name: "", path: "", kind: "dir", size: 0, children: [] };
  for (const f of files) {
    const parts = f.path.split("/");
    let node = root;
    parts.forEach((part, i) => {
      const path = parts.slice(0, i + 1).join("/");
      const isFile = i === parts.length - 1;
      let child = node.children.find((c) => c.name === part && c.kind === (isFile ? "file" : "dir"));
      if (!child) {
        child = { name: part, path, kind: isFile ? "file" : "dir", size: 0, children: [] };
        node.children.push(child);
      }
      child.size += f.size;
      node = child;
    });
    root.size += f.size;
  }
  const sort = (n: TreeNode) => {
    n.children.sort((a, b) => {
      if (n.path === "" && a.name === "SKILL.md") return -1;
      if (n.path === "" && b.name === "SKILL.md") return 1;
      if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    n.children.forEach(sort);
  };
  sort(root);
  return root;
}

/** Every folder on the way to a file ("a/b/c.md" → ["a", "a/b"]). */
export function ancestorsOf(path: string): string[] {
  const parts = path.split("/");
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join("/"));
}

export type SkillFileKind = "markdown" | "json" | "code" | "text" | "image" | "pdf" | "audio" | "video" | "binary";

const CODE_LANG: Record<string, string> = {
  py: "python", sh: "bash", bash: "bash", zsh: "bash", js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "jsx",
  ts: "typescript", tsx: "tsx", rb: "ruby", go: "go", rs: "rust", java: "java", c: "c", h: "c", cpp: "cpp", hpp: "cpp",
  sql: "sql", yaml: "yaml", yml: "yaml", toml: "toml", xml: "xml", html: "html", htm: "html", css: "css", r: "r", ps1: "powershell",
  ini: "ini", dockerfile: "dockerfile", jsonl: "json",
};
const TEXT_EXT = new Set(["txt", "csv", "tsv", "log", "env", "cfg", "conf", "gitignore", "license"]);
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "bmp", "avif"]);

function ext(path: string): string {
  const base = path.split("/").pop() ?? "";
  if (/^(LICENSE|README|NOTICE|CHANGELOG)$/i.test(base)) return "license";
  if (/^Dockerfile$/i.test(base)) return "dockerfile";
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(i + 1).toLowerCase() : "";
}

/** How a file is shown: rendered markdown, pretty JSON, highlighted code, text, image, PDF… or a download. */
export function skillFileKind(path: string): SkillFileKind {
  const e = ext(path);
  if (e === "md" || e === "markdown" || e === "mdx") return "markdown";
  if (e === "json") return "json";
  if (IMAGE_EXT.has(e)) return "image";
  if (e === "pdf") return "pdf";
  if (["mp3", "wav", "ogg", "m4a"].includes(e)) return "audio";
  if (["mp4", "webm", "mov"].includes(e)) return "video";
  if (e in CODE_LANG) return "code";
  if (TEXT_EXT.has(e)) return "text";
  return "binary";
}

/** The highlighter's language for a code file ("" when none). */
export function codeLanguage(path: string): string {
  return CODE_LANG[ext(path)] ?? "";
}

/** A fenced code block that cannot be closed early by the content. */
export function fenced(content: string, lang = ""): string {
  const longest = Math.max(2, ...[...content.matchAll(/`{3,}/g)].map((m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  return `${fence}${lang}\n${content}\n${fence}`;
}

/** JSON pretty-printed, or the text as is when it does not parse. */
export function prettyJson(text: string): string {
  try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; }
}

/**
 * The skill file a link inside a skill file points to (relative to that file's folder), or null for
 * external links, anchors and paths outside the skill. `known` limits it to files that exist.
 */
export function resolveSkillLink(href: string | undefined, fromPath: string, known?: Set<string>): string | null {
  if (!href) return null;
  const h = href.trim();
  if (!h || h.startsWith("#") || h.startsWith("/") || h.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(h)) return null;
  const clean = h.split(/[?#]/)[0];
  let decoded: string;
  try { decoded = decodeURI(clean); } catch { decoded = clean; }
  const parts = fromPath.split("/").slice(0, -1);
  for (const seg of decoded.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  const path = parts.join("/");
  if (!path) return null;
  return !known || known.has(path) ? path : null;
}

export function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Strip the YAML frontmatter block from SKILL.md for the rendered view. */
export function stripFrontmatter(md: string): string {
  return md.replace(/^﻿?---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
}

// ── A dropped folder → a zip (stored) ──

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Files (relative path → bytes) as a zip archive with no compression. */
export function zipStored(files: Array<{ path: string; data: Uint8Array }>): Uint8Array {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.path);
    const crc = crc32(f.data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true);
    local.setUint16(8, 0, true); local.setUint16(12, 33, true); local.setUint32(14, crc, true);
    local.setUint32(18, f.data.length, true); local.setUint32(22, f.data.length, true); local.setUint16(26, name.length, true);
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true); cd.setUint16(4, 20, true); cd.setUint16(6, 20, true); cd.setUint16(8, 0x0800, true);
    cd.setUint16(14, 33, true); cd.setUint32(16, crc, true); cd.setUint32(20, f.data.length, true); cd.setUint32(24, f.data.length, true);
    cd.setUint16(28, name.length, true); cd.setUint32(42, offset, true);
    chunks.push(new Uint8Array(local.buffer), name, f.data);
    central.push(new Uint8Array(cd.buffer), name);
    offset += 30 + name.length + f.data.length;
  }
  const cdSize = central.reduce((s, c) => s + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  const all = [...chunks, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((s, c) => s + c.length, 0));
  let at = 0;
  for (const c of all) { out.set(c, at); at += c.length; }
  return out;
}

/** An uploadable archive from picked/dropped files: a .skill/.zip as is, a folder's files zipped. */
export async function archiveFromFiles(files: Array<{ file: File; path: string }>): Promise<{ blob: Blob; filename: string }> {
  if (files.length === 1 && /\.(skill|zip)$/i.test(files[0]!.file.name)) return { blob: files[0]!.file, filename: files[0]!.file.name };
  const entries = await Promise.all(files.map(async ({ file, path }) => ({ path: path.replace(/^\/+/, ""), data: new Uint8Array(await file.arrayBuffer()) })));
  const top = entries[0]?.path.split("/")[0] ?? "skill";
  const zip = zipStored(entries);
  return { blob: new Blob([zip as Uint8Array<ArrayBuffer>], { type: "application/zip" }), filename: `${entries.every((e) => e.path.includes("/")) ? top : "skill"}.zip` };
}

/** The files of a dropped folder (DataTransfer), with their paths. */
export async function filesFromDataTransfer(dt: DataTransfer): Promise<Array<{ file: File; path: string }>> {
  const out: Array<{ file: File; path: string }> = [];
  const items = [...dt.items].map((i) => (typeof i.webkitGetAsEntry === "function" ? i.webkitGetAsEntry() : null));
  if (items.every((e) => !e)) return [...dt.files].map((file) => ({ file, path: file.name }));
  const walk = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
    if (entry.isFile) {
      const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
      out.push({ file, path: `${prefix}${entry.name}` });
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
        if (batch.length === 0) break;
        for (const e of batch) await walk(e, `${prefix}${entry.name}/`);
      }
    }
  };
  for (const e of items) if (e) await walk(e, "");
  return out;
}
