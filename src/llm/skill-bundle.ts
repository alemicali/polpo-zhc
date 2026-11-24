/**
 * Skill bundles — `.skill` / `.zip` archives of Agent Skills, and the files inside an installed skill.
 *
 * A skill is a folder with a SKILL.md (YAML frontmatter: `name`, `description`, optional `license`,
 * `compatibility`, `metadata`, `allowed-tools`) plus any bundled files (`scripts/`, `references/`,
 * `assets/`, …) the instructions point to. A `.skill` file is a zip of that folder (Anthropic's
 * skill-creator `package_skill.py` writes the folder at the archive root: `my-skill/SKILL.md`); a
 * `.zip` may hold the folder, the files directly (`SKILL.md` at the root), or several skills.
 *
 * Spec: https://agentskills.io/specification, https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview
 *
 * Archives are untrusted input. Reading one never touches the disk and refuses: entries outside the
 * skill (absolute paths, `..`), symlinks, encrypted entries, methods other than stored/deflate, ZIP64,
 * more than {@link SKILL_BUNDLE_LIMITS.maxFiles} files, a file over `maxFileBytes`, more than
 * `maxTotalBytes` uncompressed (checked on the real inflated bytes, not the declared sizes, so a zip
 * bomb stops at the limit) and CRC mismatches. Hidden junk (`__MACOSX/`, `.DS_Store`, `._*`,
 * `Thumbs.db`, `__pycache__/`, `*.pyc`, `.git/`) is dropped and reported. Executable bits are not kept:
 * files are written 0644 (agents run bundled scripts with their interpreter, e.g. `python scripts/x.py`).
 *
 * Zip reading and writing use node:zlib only (no dependency).
 */

import { inflateRawSync, deflateRawSync } from "node:zlib";
import { randomBytes } from "node:crypto";
import {
  existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync,
} from "node:fs";
import { dirname, extname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";

// ── Limits ──

export const SKILL_BUNDLE_LIMITS = {
  /** The archive itself (bytes on the wire). */
  maxArchiveBytes: 30 * 1024 * 1024,
  /** All files of the archive, uncompressed (Anthropic's Skills API limit: 30 MB). */
  maxTotalBytes: 30 * 1024 * 1024,
  /** Files in the archive (junk included). */
  maxFiles: 1000,
  /** One file, uncompressed. */
  maxFileBytes: 10 * 1024 * 1024,
  /** A path inside the archive. */
  maxPathLength: 255,
} as const;

export type SkillBundleLimits = { [K in keyof typeof SKILL_BUNDLE_LIMITS]: number };

/** The frontmatter keys of the Agent Skills spec (others are kept, with a warning). */
const KNOWN_FRONTMATTER_KEYS = new Set(["name", "description", "license", "allowed-tools", "metadata", "compatibility"]);
/** Spec: 1–64 lowercase letters, digits and single hyphens, not at the ends. */
export const SPEC_SKILL_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const RESERVED_NAME_WORDS = ["anthropic", "claude"];

export class SkillBundleError extends Error {
  constructor(message: string, readonly code: "BAD_ARCHIVE" | "UNSAFE_ARCHIVE" | "TOO_LARGE" | "NO_SKILL" = "BAD_ARCHIVE") {
    super(message);
    this.name = "SkillBundleError";
  }
}

// ── CRC-32 (zlib.crc32 is missing on older Node 20 releases) ──

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
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ── Zip reading ──

export interface ZipEntry {
  /** Normalised POSIX path inside the archive. */
  path: string;
  data: Buffer;
  /** The archive marked it executable (not kept on install). */
  executable: boolean;
}

/** Why a path is junk to drop, or undefined. */
export function junkReason(path: string): string | undefined {
  const parts = path.split("/");
  const base = parts[parts.length - 1];
  if (parts.includes("__MACOSX")) return "macOS resource fork";
  if (parts.includes(".git")) return "git metadata";
  if (parts.includes("__pycache__") || base.endsWith(".pyc")) return "Python bytecode";
  if (base === ".DS_Store" || base.startsWith("._")) return "macOS metadata";
  if (base === "Thumbs.db" || base === "desktop.ini") return "Windows metadata";
  return undefined;
}

/**
 * A safe relative POSIX path, or undefined: no absolute paths or drive letters, no `..`,
 * no NUL or control characters, no empty segments.
 */
export function safeRelativePath(raw: string): string | undefined {
  // eslint-disable-next-line no-control-regex
  if (!raw || /[\u0000-\u001f]/.test(raw)) return undefined;
  const p = raw.replace(/\\/g, "/");
  if (p.startsWith("/") || /^[A-Za-z]:/.test(p)) return undefined;
  const parts = p.split("/").filter((s) => s !== "" && s !== ".");
  if (parts.length === 0 || parts.some((s) => s === "..")) return undefined;
  return parts.join("/");
}

/** Read a zip archive in memory, enforcing the limits. Throws SkillBundleError. */
export function readZipArchive(buf: Buffer, limits: SkillBundleLimits = SKILL_BUNDLE_LIMITS): { entries: ZipEntry[]; ignored: string[] } {
  if (buf.length > limits.maxArchiveBytes) {
    throw new SkillBundleError(`The archive is ${mb(buf.length)}: the limit is ${mb(limits.maxArchiveBytes)}`, "TOO_LARGE");
  }
  if (buf.length < 22) throw new SkillBundleError("Not a zip archive (too short)");
  // End of central directory: the last 0x06054b50 within the final 64 KB + 22 bytes
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new SkillBundleError("Not a zip archive (no end of central directory)");
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) {
    throw new SkillBundleError("ZIP64 archives are not supported (a skill must be under 30 MB)");
  }
  if (count > limits.maxFiles) {
    throw new SkillBundleError(`The archive has ${count} entries: the limit is ${limits.maxFiles} files`, "TOO_LARGE");
  }
  if (cdOffset + cdSize > buf.length) throw new SkillBundleError("Corrupt zip archive (central directory out of range)");

  const entries: ZipEntry[] = [];
  const ignored: string[] = [];
  const seen = new Set<string>();
  let total = 0;
  let at = cdOffset;
  for (let n = 0; n < count; n++) {
    if (at + 46 > buf.length || buf.readUInt32LE(at) !== 0x02014b50) throw new SkillBundleError("Corrupt zip archive (bad central directory entry)");
    const madeBy = buf.readUInt16LE(at + 4);
    const flags = buf.readUInt16LE(at + 8);
    const method = buf.readUInt16LE(at + 10);
    const crc = buf.readUInt32LE(at + 16);
    const compSize = buf.readUInt32LE(at + 20);
    const size = buf.readUInt32LE(at + 24);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const external = buf.readUInt32LE(at + 38);
    const localOffset = buf.readUInt32LE(at + 42);
    const rawName = buf.subarray(at + 46, at + 46 + nameLen).toString("utf8");
    at += 46 + nameLen + extraLen + commentLen;

    const isDir = rawName.endsWith("/") || rawName.endsWith("\\");
    const path = safeRelativePath(rawName);
    if (!path) {
      if (isDir && rawName.replace(/[\\/.]/g, "") === "") continue; // "./" style root entry
      throw new SkillBundleError(`Unsafe path in the archive: "${rawName}" (absolute paths and ".." are not allowed)`, "UNSAFE_ARCHIVE");
    }
    if (path.length > limits.maxPathLength) throw new SkillBundleError(`Path too long in the archive: "${path.slice(0, 80)}…"`, "UNSAFE_ARCHIVE");
    const unixMode = (madeBy >> 8) === 3 ? external >>> 16 : 0;
    const fileType = unixMode & 0o170000;
    if (fileType === 0o120000) throw new SkillBundleError(`The archive contains a symlink ("${path}"): symlinks are not allowed`, "UNSAFE_ARCHIVE");
    if (isDir || fileType === 0o040000) continue;
    if (fileType !== 0 && fileType !== 0o100000) throw new SkillBundleError(`The archive contains a special file ("${path}")`, "UNSAFE_ARCHIVE");
    if (flags & 0x1) throw new SkillBundleError(`"${path}" is encrypted: encrypted archives are not supported`);
    const junk = junkReason(path);
    if (junk) { ignored.push(path); continue; }
    if (seen.has(path)) throw new SkillBundleError(`"${path}" appears twice in the archive`, "UNSAFE_ARCHIVE");
    seen.add(path);
    if (size > limits.maxFileBytes) throw new SkillBundleError(`"${path}" is ${mb(size)}: the limit per file is ${mb(limits.maxFileBytes)}`, "TOO_LARGE");
    if (total + size > limits.maxTotalBytes) throw new SkillBundleError(`The archive is over ${mb(limits.maxTotalBytes)} uncompressed`, "TOO_LARGE");

    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== 0x04034b50) throw new SkillBundleError(`Corrupt zip archive (bad local header for "${path}")`);
    const dataStart = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
    if (dataStart + compSize > buf.length) throw new SkillBundleError(`Corrupt zip archive ("${path}" is truncated)`);
    const raw = buf.subarray(dataStart, dataStart + compSize);
    let data: Buffer;
    if (method === 0) {
      data = Buffer.from(raw);
    } else if (method === 8) {
      // never inflate more than the declared size, and the declared size is within the limits
      try {
        data = size === 0 ? Buffer.alloc(0) : inflateRawSync(raw, { maxOutputLength: size });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new SkillBundleError(/maxOutputLength|buffer|too large/i.test(msg)
          ? `"${path}" inflates beyond its declared size (zip bomb?)` : `"${path}" cannot be decompressed: ${msg}`, "UNSAFE_ARCHIVE");
      }
    } else {
      throw new SkillBundleError(`"${path}" uses compression method ${method}: only stored and deflate are supported`);
    }
    if (data.length !== size) throw new SkillBundleError(`"${path}" is ${data.length} bytes, not the declared ${size}`, "UNSAFE_ARCHIVE");
    if (crc32(data) !== crc) throw new SkillBundleError(`"${path}" is corrupt (CRC mismatch)`);
    total += data.length;
    entries.push({ path, data, executable: (unixMode & 0o111) !== 0 });
  }
  return { entries, ignored };
}

// ── Zip writing ──

export interface ZipInput { path: string; data: Uint8Array }

/** Build a zip archive (deflate, or stored when that is smaller). */
export function writeZipArchive(files: ZipInput[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  // 1980-01-01 00:00 in DOS time: stable archives (same bytes for the same files)
  const dosTime = 0, dosDate = (0 << 9) | (1 << 5) | 1;
  for (const f of files) {
    const name = Buffer.from(f.path, "utf8");
    const raw = Buffer.from(f.data);
    const deflated = deflateRawSync(raw);
    const stored = deflated.length >= raw.length;
    const body = stored ? raw : deflated;
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(stored ? 0 : 8, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4); // made by Unix
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(stored ? 0 : 8, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

// ── Frontmatter ──

export interface SkillFrontmatter {
  name?: string;
  description?: string;
  license?: string;
  compatibility?: string;
  allowedTools?: string[];
  metadata?: Record<string, unknown>;
  /** Keys outside the spec. */
  unknownKeys: string[];
}

/** Parse SKILL.md's frontmatter strictly (YAML), or explain why it cannot. */
export function readSkillFrontmatter(raw: string): { ok: true; fm: SkillFrontmatter; body: string } | { ok: false; error: string } {
  const text = raw.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const m = text.match(/^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/);
  if (!m) return { ok: false, error: "SKILL.md has no YAML frontmatter (it must start with a --- block with name and description)" };
  let data: unknown;
  try { data = parseYaml(m[1]); } catch (err) {
    return { ok: false, error: `SKILL.md frontmatter is not valid YAML: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}` };
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return { ok: false, error: "SKILL.md frontmatter must be a YAML mapping (name: …, description: …)" };
  const o = data as Record<string, unknown>;
  const tools = o["allowed-tools"];
  const allowedTools = Array.isArray(tools) ? tools.map(String).filter(Boolean)
    : typeof tools === "string" ? tools.split(/[,\s]+/).filter(Boolean) : undefined;
  return {
    ok: true,
    body: m[2],
    fm: {
      ...(typeof o.name === "string" ? { name: o.name.trim() } : o.name != null ? { name: String(o.name) } : {}),
      ...(typeof o.description === "string" ? { description: o.description.trim() } : {}),
      ...(typeof o.license === "string" ? { license: o.license } : {}),
      ...(typeof o.compatibility === "string" ? { compatibility: o.compatibility } : {}),
      ...(allowedTools?.length ? { allowedTools } : {}),
      ...(o.metadata && typeof o.metadata === "object" && !Array.isArray(o.metadata) ? { metadata: o.metadata as Record<string, unknown> } : {}),
      unknownKeys: Object.keys(o).filter((k) => !KNOWN_FRONTMATTER_KEYS.has(k)),
    },
  };
}

/** Errors for a skill name under the Agent Skills spec (empty: valid). */
export function specNameErrors(name: string): string[] {
  if (!name) return ["The skill has no name"];
  const errors: string[] = [];
  if (name.length > 64) errors.push(`The name "${name.slice(0, 70)}" is longer than 64 characters`);
  if (!SPEC_SKILL_NAME_RE.test(name)) errors.push(`The name "${name}" must use only lowercase letters, digits and single hyphens (not at the start or end)`);
  return errors;
}

/** A spec-compliant name derived from any text ("My Skill_v2" → "my-skill-v2"). */
export function slugSkillName(text: string): string {
  return text.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64).replace(/-+$/, "");
}

/** SKILL.md with its frontmatter `name` set (added when missing); the rest is kept byte for byte. */
export function setFrontmatterName(raw: string, name: string): string {
  const m = raw.match(/^(\uFEFF?---\r?\n)([\s\S]*?)(\r?\n---)/);
  if (!m) return `---\nname: ${name}\n---\n${raw}`;
  const fmText = m[2];
  const next = /^name\s*:.*$/m.test(fmText) ? fmText.replace(/^name\s*:.*$/m, `name: ${name}`) : `name: ${name}\n${fmText}`;
  return m[1] + next + m[3] + raw.slice(m[0].length);
}

// ── Bundles ──

export interface BundleFile { path: string; size: number }

export interface BundleSkill {
  /** The skill's name: frontmatter `name`, else the folder name. */
  name: string;
  /** Its folder in the archive ("" when SKILL.md is at the archive root). */
  folder: string;
  description: string;
  license?: string;
  compatibility?: string;
  allowedTools?: string[];
  metadata?: Record<string, unknown>;
  /** Files of the skill, relative to its folder (SKILL.md included). */
  files: BundleFile[];
  totalBytes: number;
  /** Problems that block the install (a rename can fix name errors). */
  errors: string[];
  /** Deviations from the spec or best practices that do not block it. */
  warnings: string[];
}

export interface SkillBundlePreview {
  archiveName?: string;
  skills: BundleSkill[];
  /** Junk dropped (__MACOSX, .DS_Store…). */
  ignored: string[];
  /** Archive-level notes (files outside any skill folder, executable bits…). */
  warnings: string[];
}

export interface ParsedSkillBundle {
  preview: SkillBundlePreview;
  /** folder → (relative path → bytes) */
  contents: Map<string, Map<string, Buffer>>;
}

/**
 * Read a `.skill` / `.zip` archive: find its skills (every folder with a SKILL.md that is not inside
 * another skill), validate them, and keep their files in memory for {@link installSkillBundle}.
 */
export function parseSkillBundle(buf: Buffer, opts: { filename?: string; limits?: SkillBundleLimits } = {}): ParsedSkillBundle {
  const { entries, ignored } = readZipArchive(buf, opts.limits ?? SKILL_BUNDLE_LIMITS);
  const warnings: string[] = [];
  const archiveBase = (opts.filename ?? "").replace(/\\/g, "/").split("/").pop()?.replace(/\.(skill|zip)$/i, "") ?? "";

  // skill roots: folders holding SKILL.md, shallowest first; nested ones are files of the outer skill
  const roots = entries
    .filter((e) => e.path === "SKILL.md" || e.path.endsWith("/SKILL.md"))
    .map((e) => (e.path === "SKILL.md" ? "" : e.path.slice(0, -"/SKILL.md".length)))
    .sort((a, b) => depth(a) - depth(b) || a.localeCompare(b));
  const accepted: string[] = [];
  for (const r of roots) if (!accepted.some((a) => a === "" || r.startsWith(a + "/"))) accepted.push(r);
  if (accepted.length === 0) {
    const lower = entries.find((e) => /(^|\/)skill\.md$/i.test(e.path));
    throw new SkillBundleError(lower
      ? `No SKILL.md found ("${lower.path}" must be named SKILL.md, in capitals)`
      : "No SKILL.md found: a skill is a folder with a SKILL.md file (YAML frontmatter with name and description)", "NO_SKILL");
  }

  const contents = new Map<string, Map<string, Buffer>>();
  for (const r of accepted) contents.set(r, new Map());
  const outside: string[] = [];
  let executables = 0;
  for (const e of entries) {
    const root = accepted.find((a) => a === "" || e.path.startsWith(a + "/"));
    if (root === undefined) { outside.push(e.path); continue; }
    contents.get(root)!.set(root === "" ? e.path : e.path.slice(root.length + 1), e.data);
    if (e.executable) executables++;
  }
  if (outside.length) warnings.push(`${outside.length} file(s) outside any skill folder are not installed: ${outside.slice(0, 5).join(", ")}${outside.length > 5 ? "…" : ""}`);
  if (executables) warnings.push(`${executables} file(s) were marked executable in the archive: they are installed without the executable bit (agents run scripts with their interpreter, e.g. python scripts/x.py)`);

  const skills: BundleSkill[] = [];
  for (const folder of accepted) {
    const files = contents.get(folder)!;
    const folderName = folder === "" ? archiveBase : folder.split("/").pop()!;
    const skill: BundleSkill = {
      name: folderName, folder, description: "",
      files: [...files.entries()].map(([path, data]) => ({ path, size: data.length })).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
      totalBytes: [...files.values()].reduce((s, d) => s + d.length, 0),
      errors: [], warnings: [],
    };
    const fmr = readSkillFrontmatter(files.get("SKILL.md")!.toString("utf8"));
    if (!fmr.ok) {
      skill.errors.push(fmr.error);
    } else {
      const { fm, body } = fmr;
      if (fm.name) skill.name = fm.name;
      else skill.warnings.push(`SKILL.md has no name: using ${folderName ? `the folder name "${folderName}"` : "none"}`);
      if (!fm.description) skill.errors.push("SKILL.md has no description (say what the skill does and when to use it)");
      else {
        skill.description = fm.description;
        if (fm.description.length > 1024) skill.errors.push(`The description is ${fm.description.length} characters: the limit is 1024`);
        if (/<\/?[A-Za-z][^>]*>/.test(fm.description)) skill.warnings.push("The description contains XML/HTML tags (the spec does not allow them)");
      }
      if (fm.license) skill.license = fm.license;
      if (fm.compatibility) {
        skill.compatibility = fm.compatibility;
        if (fm.compatibility.length > 500) skill.warnings.push("compatibility is longer than 500 characters");
      }
      if (fm.allowedTools) skill.allowedTools = fm.allowedTools;
      if (fm.metadata) skill.metadata = fm.metadata;
      if (fm.unknownKeys.length) skill.warnings.push(`Frontmatter keys outside the spec are kept but ignored: ${fm.unknownKeys.join(", ")}`);
      const lines = body.split("\n").length;
      if (lines > 500) skill.warnings.push(`SKILL.md is ${lines} lines: keep it under 500 and move details to referenced files`);
    }
    skill.errors.push(...specNameErrors(skill.name));
    if (RESERVED_NAME_WORDS.some((w) => skill.name.includes(w))) skill.warnings.push(`The name contains a reserved word (${RESERVED_NAME_WORDS.join(", ")}): Claude's Skills API rejects it`);
    if (folderName && folder !== "" && skill.name !== folderName) skill.warnings.push(`The folder is "${folderName}" but the name is "${skill.name}": it is installed as "${skill.name}"`);
    skills.push(skill);
  }
  const names = skills.map((s) => s.name);
  for (const s of skills) if (names.filter((n) => n === s.name).length > 1) s.errors.push(`Two skills in the archive are named "${s.name}"`);
  return { preview: { ...(opts.filename ? { archiveName: opts.filename } : {}), skills, ignored, warnings }, contents };
}

export type ConflictPolicy = "fail" | "replace" | "skip";

export interface BundleInstallOptions {
  /** Only these skills (archive names); default all. */
  skills?: string[];
  /** archive name → name to install as (also written to SKILL.md). */
  renames?: Record<string, string>;
  /** When a skill with the name exists: fail (default, reported as an error), replace it, or skip it. */
  onConflict?: ConflictPolicy;
  /** Names that exist in the target pool (besides directories in targetBase). */
  existingNames?: Iterable<string>;
  /** Runs each skill's write (e.g. to record the skill's versions around it). */
  wrap?: (name: string, write: () => void) => void;
}

export interface BundleInstallResult {
  installed: Array<{ name: string; from: string; path: string; replaced: boolean; files: number }>;
  skipped: Array<{ name: string; reason: string }>;
  errors: Array<{ name: string; error: string }>;
}

/** Install a parsed bundle's skills into a pool directory (e.g. .polpo/skills). */
export function installSkillBundle(bundle: ParsedSkillBundle, targetBase: string, opts: BundleInstallOptions = {}): BundleInstallResult {
  const result: BundleInstallResult = { installed: [], skipped: [], errors: [] };
  const renames = opts.renames ?? {};
  const policy = opts.onConflict ?? "fail";
  const existing = new Set(opts.existingNames ?? []);
  const wanted = opts.skills?.length ? new Set(opts.skills) : undefined;
  if (wanted) {
    const unknown = [...wanted].filter((n) => !bundle.preview.skills.some((s) => s.name === n));
    for (const n of unknown) result.errors.push({ name: n, error: `"${n}" is not in the archive (it has: ${bundle.preview.skills.map((s) => s.name).join(", ")})` });
  }
  const planned = new Set<string>();
  mkdirSync(targetBase, { recursive: true });
  for (const skill of bundle.preview.skills) {
    if (wanted && !wanted.has(skill.name)) continue;
    const target = (renames[skill.name] ?? skill.name).trim();
    const renamed = target !== skill.name;
    // name errors are about the final name; other errors block the install
    const blocking = skill.errors.filter((e) => !(renamed && (e.startsWith("The name ") || e.startsWith("The skill has no name"))));
    const nameErrors = renamed ? specNameErrors(target) : [];
    if (blocking.length || nameErrors.length) { result.errors.push({ name: skill.name, error: [...blocking, ...nameErrors].join("; ") }); continue; }
    if (planned.has(target)) { result.errors.push({ name: skill.name, error: `Two skills would be installed as "${target}"` }); continue; }
    const dir = join(targetBase, target);
    const exists = existsSync(dir) || existing.has(target);
    if (exists && policy === "skip") { result.skipped.push({ name: target, reason: "a skill with this name exists" }); continue; }
    if (exists && policy === "fail") { result.errors.push({ name: skill.name, error: `A skill named "${target}" exists: replace it, install it under another name, or skip it` }); continue; }
    planned.add(target);
    try {
      const write = () => writeSkillDir(bundle.contents.get(skill.folder)!, targetBase, target, renamed);
      if (opts.wrap) opts.wrap(target, write); else write();
      result.installed.push({ name: target, from: skill.name, path: dir, replaced: exists, files: skill.files.length });
    } catch (err) {
      result.errors.push({ name: skill.name, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}

/** Write a skill's files into a staging folder, then swap it in (the old version goes only once the new one is complete). */
function writeSkillDir(files: Map<string, Buffer>, targetBase: string, name: string, rewriteName: boolean): void {
  const staging = join(targetBase, ".staging");
  const id = randomBytes(6).toString("hex");
  const fresh = join(staging, `${name}-${id}`);
  mkdirSync(fresh, { recursive: true });
  try {
    for (const [rel, data] of files) {
      const safe = safeRelativePath(rel);
      if (!safe) throw new Error(`Unsafe path "${rel}"`);
      const abs = join(fresh, ...safe.split("/"));
      if (!abs.startsWith(fresh + sep)) throw new Error(`Unsafe path "${rel}"`);
      mkdirSync(dirname(abs), { recursive: true });
      const bytes = rel === "SKILL.md" && rewriteName ? Buffer.from(setFrontmatterName(data.toString("utf8"), name), "utf8") : data;
      // 0644: executable bits from the archive are not kept
      writeFileSync(abs, bytes, { mode: 0o644 });
    }
    const dir = join(targetBase, name);
    const old = join(staging, `${name}-${id}-old`);
    const hadOld = existsSync(dir) || isSymlink(dir);
    if (hadOld) renameSync(dir, old);
    try { renameSync(fresh, dir); } catch (err) {
      if (hadOld) renameSync(old, dir);
      throw err;
    }
    if (hadOld) rmSync(old, { recursive: true, force: true });
  } finally {
    rmSync(fresh, { recursive: true, force: true });
    try { if (readdirSync(staging).length === 0) rmSync(staging, { recursive: true, force: true }); } catch { /* gone */ }
  }
}

function isSymlink(p: string): boolean {
  try { return lstatSync(p).isSymbolicLink(); } catch { return false; }
}

// ── Installed skills: files ──

export interface SkillFileEntry { path: string; size: number }

/** The files of an installed skill (relative POSIX paths), symlinks and junk skipped. */
export function listSkillFiles(skillDir: string, max = 2000): { files: SkillFileEntry[]; truncated: boolean } {
  const files: SkillFileEntry[] = [];
  let truncated = false;
  let root: string;
  try { root = realpathSync(skillDir); } catch { return { files, truncated }; }
  const walk = (dir: string, prefix: string) => {
    let names: string[];
    try { names = readdirSync(dir).sort(); } catch { return; }
    for (const n of names) {
      if (files.length >= max) { truncated = true; return; }
      const rel = prefix ? `${prefix}/${n}` : n;
      if (junkReason(rel) || n === ".staging") continue;
      const abs = join(dir, n);
      let st;
      try { st = lstatSync(abs); } catch { continue; }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) walk(abs, rel);
      else if (st.isFile()) files.push({ path: rel, size: st.size });
    }
  };
  walk(root, "");
  return { files, truncated };
}

/**
 * The absolute path of a file inside a skill folder, or undefined when the path is unsafe
 * (absolute, `..`, through a symlink out of the folder) or not a regular file.
 */
export function resolveSkillFile(skillDir: string, relPath: string): string | undefined {
  const safe = safeRelativePath(relPath);
  if (!safe) return undefined;
  let root: string;
  try { root = realpathSync(skillDir); } catch { return undefined; }
  const abs = resolve(root, ...safe.split("/"));
  let real: string;
  try { real = realpathSync(abs); } catch { return undefined; }
  if (real !== root && !real.startsWith(root + sep)) return undefined;
  const rel = relative(root, real);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return undefined;
  try { if (!lstatSync(real).isFile()) return undefined; } catch { return undefined; }
  return real;
}

/**
 * A skill's bundled text files (UTF-8), for runtimes that materialize a skill's files next to its
 * SKILL.md (agent harnesses). Binary or oversized files are left out and named in `skipped`.
 */
export function readSkillTextFiles(
  skillDir: string,
  limits: { maxFiles?: number; maxFileBytes?: number; maxTotalBytes?: number } = {},
): { files: Array<{ path: string; content: string }>; skipped: string[] } {
  const maxFiles = limits.maxFiles ?? 200, maxFile = limits.maxFileBytes ?? 512 * 1024, maxTotal = limits.maxTotalBytes ?? 4 * 1024 * 1024;
  const out: Array<{ path: string; content: string }> = [];
  const skipped: string[] = [];
  let total = 0;
  let root: string;
  try { root = realpathSync(skillDir); } catch { return { files: out, skipped }; }
  for (const f of listSkillFiles(root).files) {
    if (f.path === "SKILL.md") continue;
    if (out.length >= maxFiles || f.size > maxFile || total + f.size > maxTotal) { skipped.push(f.path); continue; }
    let bytes: Buffer;
    try { bytes = readFileSync(join(root, ...f.path.split("/"))); } catch { skipped.push(f.path); continue; }
    if (!looksLikeText(bytes)) { skipped.push(f.path); continue; }
    try { out.push({ path: f.path, content: new TextDecoder("utf-8", { fatal: true }).decode(bytes) }); } catch { skipped.push(f.path); continue; }
    total += f.size;
  }
  return { files: out, skipped };
}

/** Zip an installed skill folder (the folder at the archive root, as `.skill` files have it). */
export function zipSkillDir(skillDir: string, rootName: string, maxBytes = 100 * 1024 * 1024): Buffer {
  const { files } = listSkillFiles(skillDir, SKILL_BUNDLE_LIMITS.maxFiles * 5);
  const total = files.reduce((s, f) => s + f.size, 0);
  if (total > maxBytes) throw new SkillBundleError(`The skill is ${mb(total)}: too large to download as one archive`, "TOO_LARGE");
  const root = realpathSync(skillDir);
  return writeZipArchive(files.map((f) => ({ path: `${rootName}/${f.path}`, data: readFileSync(join(root, ...f.path.split("/"))) })));
}

const MIME: Record<string, string> = {
  ".md": "text/markdown", ".markdown": "text/markdown", ".txt": "text/plain", ".csv": "text/csv", ".tsv": "text/tab-separated-values",
  ".json": "application/json", ".jsonl": "application/x-ndjson", ".yaml": "text/yaml", ".yml": "text/yaml", ".toml": "text/plain",
  ".xml": "application/xml", ".html": "text/html", ".htm": "text/html", ".css": "text/css",
  ".js": "text/javascript", ".mjs": "text/javascript", ".cjs": "text/javascript", ".ts": "text/typescript", ".tsx": "text/typescript", ".jsx": "text/javascript",
  ".py": "text/x-python", ".sh": "text/x-shellscript", ".bash": "text/x-shellscript", ".rb": "text/x-ruby", ".go": "text/x-go", ".rs": "text/x-rust",
  ".java": "text/x-java", ".c": "text/x-c", ".h": "text/x-c", ".cpp": "text/x-c++", ".sql": "text/x-sql", ".r": "text/plain", ".ini": "text/plain", ".env": "text/plain",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml", ".ico": "image/x-icon",
  ".pdf": "application/pdf", ".zip": "application/zip", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".ttf": "font/ttf", ".otf": "font/otf", ".woff": "font/woff", ".woff2": "font/woff2",
};

/** The content type to serve a skill file with (text types get charset=utf-8). */
export function skillFileContentType(path: string, sample?: Uint8Array): string {
  const ext = extname(path).toLowerCase();
  const known = MIME[ext] ?? (posix.basename(path).toUpperCase() === "LICENSE" ? "text/plain" : undefined);
  const type = known ?? (sample && looksLikeText(sample) ? "text/plain" : "application/octet-stream");
  return /^(text\/|application\/(json|xml|x-ndjson))/.test(type) ? `${type}; charset=utf-8` : type;
}

/** No NUL byte and valid UTF-8 in the first KB. */
export function looksLikeText(bytes: Uint8Array): boolean {
  const head = bytes.subarray(0, 1024);
  if (head.includes(0)) return false;
  try { new TextDecoder("utf-8", { fatal: true }).decode(head.length === 1024 ? head.subarray(0, 1020) : head); return true; } catch { return false; }
}

// ── Staged uploads (preview, then install without uploading again) ──

interface Staged { buf: Buffer; filename?: string; expires: number }
const STAGE_TTL_MS = 30 * 60_000;
const STAGE_MAX_ENTRIES = 8;
const STAGE_MAX_BYTES = 128 * 1024 * 1024;
const staged = new Map<string, Staged>();

function pruneStaged(now = Date.now()): void {
  for (const [id, s] of staged) if (s.expires <= now) staged.delete(id);
  let total = [...staged.values()].reduce((s, x) => s + x.buf.length, 0);
  for (const [id, s] of staged) {
    if (staged.size <= STAGE_MAX_ENTRIES && total <= STAGE_MAX_BYTES) break;
    staged.delete(id);
    total -= s.buf.length;
  }
}

/** Keep an uploaded archive for 30 minutes; returns its upload id. */
export function stageSkillUpload(buf: Buffer, filename?: string): string {
  const id = `su_${randomBytes(12).toString("hex")}`;
  staged.set(id, { buf, ...(filename ? { filename } : {}), expires: Date.now() + STAGE_TTL_MS });
  pruneStaged();
  return id;
}

export function getStagedSkillUpload(id: string): { buf: Buffer; filename?: string } | undefined {
  pruneStaged();
  const s = staged.get(id);
  return s ? { buf: s.buf, ...(s.filename ? { filename: s.filename } : {}) } : undefined;
}

export function dropStagedSkillUpload(id: string): void {
  staged.delete(id);
}

// ── helpers ──

function depth(p: string): number {
  return p === "" ? 0 : p.split("/").length;
}

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(bytes < 1024 * 1024 ? 2 : 1)} MB`;
}
