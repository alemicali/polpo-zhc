/**
 * Skill versions — the history of a skill folder, like artifacts have.
 *
 * Every change Polpo makes to a skill (create, edit of SKILL.md, install from an upload, git or a
 * local path, restore) is recorded as a version: a copy of the whole skill folder (every file) with
 * who made it, how, when, its file count and size, and SKILL.md's name and description at that time.
 * The current state of a skill is its latest version. Before a change, the folder on disk is compared
 * with the latest version: when it differs (a skill installed before versioning existed, or files
 * changed outside Polpo) it is recorded first, as source "external", so no state is ever lost.
 *
 * Storage, outside the skill pools so agents never see it:
 *
 *   <polpoDir>/skill-versions/<pool>/project/<name>/      (a project skill)
 *   ~/.polpo/skill-versions/<pool>/global/<name>/         (a global skill: next to the global pool)
 *     index.json                                          (the versions' metadata)
 *     1/ 2/ 3/ …                                          (each version's files)
 *
 * Retention: the last {@link SKILL_VERSION_RETENTION.maxVersions} versions and at most
 * {@link SKILL_VERSION_RETENTION.maxBytes} per skill (the oldest go first; the latest is always kept).
 * Deleting a skill keeps its history (the state it had is its latest version) for
 * {@link SKILL_VERSION_RETENTION.deletedDays} days, so it can be restored; then it is purged.
 * POLPO_SKILL_VERSIONS_KEEP, POLPO_SKILL_VERSIONS_MAX_MB and POLPO_SKILL_VERSIONS_DELETED_DAYS change
 * the defaults.
 *
 * Everything here is synchronous: in one process two changes to a skill never interleave.
 */

import { createHash, randomBytes } from "node:crypto";
import {
  copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync,
} from "node:fs";
import { dirname, join, sep } from "node:path";
import { getGlobalPolpoDir } from "../core/constants.js";
import { listSkillFiles, looksLikeText, readSkillFrontmatter, resolveSkillFile, zipSkillDir, type SkillFileEntry } from "./skill-bundle.js";

// ── Types ──

export type SkillVersionPool = "agent" | "orchestrator";
export type SkillVersionScope = "project" | "global";

/** How a version came to be. */
export type SkillVersionSource =
  /** Created from scratch (dashboard, MCP, Polpo, an agent learning). */
  | "create"
  /** Installed from a .skill / .zip upload. */
  | "upload"
  /** Installed from a git repository. */
  | "git"
  /** Installed from a path on the server (a folder or an archive). */
  | "local"
  /** SKILL.md edited (description, instructions, tools). */
  | "edit"
  /** An older version restored. */
  | "restore"
  /** Found on disk: the skill before versioning, or files changed outside Polpo. */
  | "external";

export interface SkillVersion {
  version: number;
  createdAt: string;
  /** Who: "person:<email>", an agent's name, "polpo", "mcp:<client>", "cli", or "unknown". */
  author: string;
  source: SkillVersionSource;
  files: number;
  totalBytes: number;
  /** SKILL.md's frontmatter at that time. */
  name?: string;
  description?: string;
  /** The version a restore brought back. */
  restoredFrom?: number;
  /** sha256 of the folder's paths and bytes (identical states are not recorded twice). */
  hash: string;
}

export interface SkillVersionHistory {
  /** The skill's folder name. */
  skill: string;
  pool: SkillVersionPool;
  scope: SkillVersionScope;
  /** Oldest first. */
  versions: SkillVersion[];
  /** The next version number (numbers are never reused, even after pruning). */
  next: number;
  /** The skill was deleted: its history is kept until then + the grace period. */
  deletedAt?: string;
  deletedBy?: string;
}

/** Which skill: its pool, project or global, and its folder name. */
export interface SkillRef {
  pool: SkillVersionPool;
  global?: boolean;
  name: string;
}

/** Who makes a change and how. */
export interface SkillChange {
  author?: string;
  source: SkillVersionSource;
  restoredFrom?: number;
}

const envInt = (name: string, fallback: number): number => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
};

/** Defaults (env overrides read when used). */
export const SKILL_VERSION_RETENTION = {
  get maxVersions(): number { return envInt("POLPO_SKILL_VERSIONS_KEEP", 20); },
  get maxBytes(): number { return envInt("POLPO_SKILL_VERSIONS_MAX_MB", 50) * 1024 * 1024; },
  get deletedDays(): number { return envInt("POLPO_SKILL_VERSIONS_DELETED_DAYS", 30); },
};

export class SkillVersionError extends Error {
  constructor(message: string, readonly code: "NOT_FOUND" | "INVALID" = "NOT_FOUND") {
    super(message);
    this.name = "SkillVersionError";
  }
}

// ── Paths ──

const SAFE_NAME = /^[A-Za-z0-9._-]+$/;

function assertRef(ref: SkillRef): void {
  if (!SAFE_NAME.test(ref.name) || ref.name === "." || ref.name === ".." || ref.name.length > 128) {
    throw new SkillVersionError(`Invalid skill name "${ref.name}"`, "INVALID");
  }
}

/** The root of every skill history of a pool and scope. */
export function skillVersionsRoot(polpoDir: string, pool: SkillVersionPool, global = false): string {
  return join(global ? getGlobalPolpoDir() : polpoDir, "skill-versions", pool, global ? "global" : "project");
}

/** The folder of one skill's history. */
export function skillVersionsDir(polpoDir: string, ref: SkillRef): string {
  assertRef(ref);
  return join(skillVersionsRoot(polpoDir, ref.pool, ref.global), ref.name);
}

/** The installed skill's folder (where its files live), whether it exists or not. */
export function skillFolder(polpoDir: string, ref: SkillRef): string {
  assertRef(ref);
  const base = ref.global ? getGlobalPolpoDir() : polpoDir;
  return ref.pool === "orchestrator" ? join(base, ".agent", "skills", ref.name) : join(base, "skills", ref.name);
}

// ── Index ──

function indexPath(dir: string): string {
  return join(dir, "index.json");
}

function readHistory(polpoDir: string, ref: SkillRef): SkillVersionHistory | undefined {
  const dir = skillVersionsDir(polpoDir, ref);
  try {
    const parsed = JSON.parse(readFileSync(indexPath(dir), "utf-8")) as SkillVersionHistory;
    if (!parsed || !Array.isArray(parsed.versions)) return undefined;
    return parsed;
  } catch { return undefined; }
}

function writeHistory(polpoDir: string, ref: SkillRef, h: SkillVersionHistory): void {
  const dir = skillVersionsDir(polpoDir, ref);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.index-${randomBytes(4).toString("hex")}.json`);
  writeFileSync(tmp, JSON.stringify(h, null, 2) + "\n", "utf-8");
  renameSync(tmp, indexPath(dir));
}

function emptyHistory(ref: SkillRef): SkillVersionHistory {
  return { skill: ref.name, pool: ref.pool, scope: ref.global ? "global" : "project", versions: [], next: 1 };
}

// ── Folder state ──

interface FolderState { files: SkillFileEntry[]; totalBytes: number; hash: string; name?: string; description?: string }

/** The files of a folder, their total size, a hash of their paths and bytes, and SKILL.md's name/description. */
function folderState(dir: string): FolderState | undefined {
  let root: string;
  try { root = realpathSync(dir); } catch { return undefined; }
  if (!lstatSync(root).isDirectory()) return undefined;
  const { files } = listSkillFiles(root, 100_000);
  const h = createHash("sha256");
  let totalBytes = 0;
  let name: string | undefined;
  let description: string | undefined;
  for (const f of files) {
    const bytes = readFileSync(join(root, ...f.path.split("/")));
    h.update(f.path).update("\0").update(String(bytes.length)).update("\0").update(bytes);
    totalBytes += bytes.length;
    if (f.path === "SKILL.md") {
      const fm = readSkillFrontmatter(bytes.toString("utf8"));
      if (fm.ok) {
        if (fm.fm.name) name = fm.fm.name;
        if (fm.fm.description) description = fm.fm.description.slice(0, 1024);
      }
    }
  }
  return { files, totalBytes, hash: h.digest("hex"), ...(name ? { name } : {}), ...(description ? { description } : {}) };
}

/** Copy a folder's regular files (no symlinks, no junk) into `to`, written 0644. */
function copyFolder(from: string, files: SkillFileEntry[], to: string): void {
  const root = realpathSync(from);
  mkdirSync(to, { recursive: true });
  for (const f of files) {
    const dest = join(to, ...f.path.split("/"));
    if (!dest.startsWith(to + sep)) throw new Error(`Unsafe path "${f.path}"`);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(join(root, ...f.path.split("/")), dest);
  }
}

// ── Recording ──

function record(polpoDir: string, ref: SkillRef, h: SkillVersionHistory, folder: string, state: FolderState, change: SkillChange): SkillVersion {
  const dir = skillVersionsDir(polpoDir, ref);
  const n = Math.max(h.next, (h.versions.at(-1)?.version ?? 0) + 1);
  const tmp = join(dir, `.tmp-${n}-${randomBytes(4).toString("hex")}`);
  try {
    copyFolder(folder, state.files, tmp);
    rmSync(join(dir, String(n)), { recursive: true, force: true });
    renameSync(tmp, join(dir, String(n)));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  const v: SkillVersion = {
    version: n, createdAt: new Date().toISOString(), author: change.author || "unknown", source: change.source,
    files: state.files.length, totalBytes: state.totalBytes,
    ...(state.name ? { name: state.name } : {}), ...(state.description ? { description: state.description } : {}),
    ...(change.restoredFrom !== undefined ? { restoredFrom: change.restoredFrom } : {}),
    hash: state.hash,
  };
  h.versions.push(v);
  h.next = n + 1;
  return v;
}

/** Keep the last maxVersions versions and at most maxBytes (the latest always stays). */
function prune(polpoDir: string, ref: SkillRef, h: SkillVersionHistory): void {
  const dir = skillVersionsDir(polpoDir, ref);
  const { maxVersions, maxBytes } = SKILL_VERSION_RETENTION;
  let total = h.versions.reduce((s, v) => s + v.totalBytes, 0);
  while (h.versions.length > 1 && (h.versions.length > maxVersions || total > maxBytes)) {
    const old = h.versions.shift()!;
    total -= old.totalBytes;
    rmSync(join(dir, String(old.version)), { recursive: true, force: true });
  }
}

/**
 * Record the skill folder as it is on disk when it differs from the latest version (or there is none).
 * Returns the new version, or undefined when nothing changed or the folder does not exist.
 */
export function recordSkillVersion(polpoDir: string, ref: SkillRef, change: SkillChange): SkillVersion | undefined {
  const folder = skillFolder(polpoDir, ref);
  const state = folderState(folder);
  if (!state) return undefined;
  const h = readHistory(polpoDir, ref) ?? emptyHistory(ref);
  if (h.versions.at(-1)?.hash === state.hash && !h.deletedAt) return undefined;
  const v = record(polpoDir, ref, h, folder, state, change);
  delete h.deletedAt;
  delete h.deletedBy;
  prune(polpoDir, ref, h);
  writeHistory(polpoDir, ref, h);
  return v;
}

/**
 * Run a change to a skill folder with its history: the folder as it is now is recorded first when
 * the history does not hold it (that failing aborts the change: no state is lost silently), then
 * `change` runs, then the new state is recorded as a version by `who` (best effort: a failure here
 * leaves the change done and the next one records it as "external").
 */
export function withSkillVersion<T>(polpoDir: string, ref: SkillRef, who: SkillChange, change: () => T): T {
  recordSkillVersion(polpoDir, ref, { author: "unknown", source: "external" });
  const out = change();
  try {
    recordSkillVersion(polpoDir, ref, who);
  } catch (err) {
    console.warn(`[skills] could not record a version of ${ref.name}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return out;
}

/**
 * Before a skill is deleted: make sure its current state is its latest version and mark the history
 * deleted (kept {@link SKILL_VERSION_RETENTION.deletedDays} days, so the skill can be restored).
 */
export function markSkillDeleted(polpoDir: string, ref: SkillRef, by?: string): void {
  recordSkillVersion(polpoDir, ref, { author: "unknown", source: "external" });
  const h = readHistory(polpoDir, ref);
  if (!h || h.versions.length === 0) return;
  h.deletedAt = new Date().toISOString();
  if (by) h.deletedBy = by;
  writeHistory(polpoDir, ref, h);
  purgeDeletedSkillVersions(polpoDir, ref.pool, ref.global);
}

/** Remove the histories of skills deleted more than the grace period ago. Returns the purged names. */
export function purgeDeletedSkillVersions(polpoDir: string, pool: SkillVersionPool, global = false, now = Date.now()): string[] {
  const root = skillVersionsRoot(polpoDir, pool, global);
  const purged: string[] = [];
  let names: string[];
  try { names = readdirSync(root); } catch { return purged; }
  const grace = SKILL_VERSION_RETENTION.deletedDays * 24 * 60 * 60 * 1000;
  for (const name of names) {
    if (!SAFE_NAME.test(name)) continue;
    const h = readHistory(polpoDir, { pool, global, name });
    if (!h?.deletedAt) continue;
    if (now - Date.parse(h.deletedAt) < grace) continue;
    // a skill installed again under the name keeps its history
    if (existsSync(skillFolder(polpoDir, { pool, global, name }))) continue;
    rmSync(join(root, name), { recursive: true, force: true });
    purged.push(name);
  }
  return purged;
}

// ── Reading ──

/** A skill's history (newest first), or undefined when it has none. */
export function listSkillVersions(polpoDir: string, ref: SkillRef): (SkillVersionHistory & { current?: number }) | undefined {
  const h = readHistory(polpoDir, ref);
  if (!h) return undefined;
  const latest = h.versions.at(-1);
  return { ...h, versions: [...h.versions].reverse(), ...(latest && !h.deletedAt ? { current: latest.version } : {}) };
}

/** Does the skill have a history (project or global)? */
export function hasSkillVersions(polpoDir: string, ref: SkillRef): boolean {
  return (readHistory(polpoDir, ref)?.versions.length ?? 0) > 0;
}

function versionDir(polpoDir: string, ref: SkillRef, version: number): { dir: string; meta: SkillVersion } {
  const h = readHistory(polpoDir, ref);
  const meta = h?.versions.find((v) => v.version === version);
  if (!meta) throw new SkillVersionError(`Skill "${ref.name}" has no version ${version}`);
  const dir = join(skillVersionsDir(polpoDir, ref), String(version));
  if (!existsSync(dir)) throw new SkillVersionError(`Version ${version} of "${ref.name}" is missing on disk`);
  return { dir, meta };
}

/** The files of one version. */
export function listSkillVersionFiles(polpoDir: string, ref: SkillRef, version: number): { version: SkillVersion; files: SkillFileEntry[]; totalBytes: number } {
  const { dir, meta } = versionDir(polpoDir, ref, version);
  const { files } = listSkillFiles(dir, 100_000);
  return { version: meta, files, totalBytes: files.reduce((s, f) => s + f.size, 0) };
}

/** The absolute path of a file of a version, or undefined when the path is unsafe or not a file. */
export function resolveSkillVersionFile(polpoDir: string, ref: SkillRef, version: number, relPath: string): string | undefined {
  const { dir } = versionDir(polpoDir, ref, version);
  return resolveSkillFile(dir, relPath);
}

/** A version as a .skill archive (the folder at its root). */
export function zipSkillVersion(polpoDir: string, ref: SkillRef, version: number): Buffer {
  const { dir } = versionDir(polpoDir, ref, version);
  return zipSkillDir(dir, ref.name);
}

// ── Diff ──

/** Limits of a diff: text files over maxFileBytes or maxLines are reported changed without a diff. */
export const SKILL_DIFF_LIMITS = { maxFileBytes: 512 * 1024, maxLines: 20_000, maxDiffChars: 200_000, maxTotalChars: 1_000_000, context: 3 };

export interface SkillFileDiff {
  path: string;
  status: "added" | "removed" | "changed";
  sizeA?: number;
  sizeB?: number;
  binary?: boolean;
  /** Unified diff (text files), from a to b. */
  diff?: string;
  additions?: number;
  deletions?: number;
  /** No diff: the file is too large, or the diff was cut. */
  truncated?: boolean;
}

export interface SkillVersionDiff {
  skill: string;
  a: SkillVersion;
  b: SkillVersion;
  files: SkillFileDiff[];
  unchanged: number;
  summary: { added: number; removed: number; changed: number };
}

/** Compare two versions: files added, removed and changed, with unified diffs of text files (size-capped). */
export function diffSkillVersions(polpoDir: string, ref: SkillRef, a: number, b: number): SkillVersionDiff {
  const va = versionDir(polpoDir, ref, a);
  const vb = versionDir(polpoDir, ref, b);
  const fa = new Map(listSkillFiles(va.dir, 100_000).files.map((f) => [f.path, f.size]));
  const fb = new Map(listSkillFiles(vb.dir, 100_000).files.map((f) => [f.path, f.size]));
  const paths = [...new Set([...fa.keys(), ...fb.keys()])].sort();
  const files: SkillFileDiff[] = [];
  let unchanged = 0;
  let budget = SKILL_DIFF_LIMITS.maxTotalChars;
  const read = (dir: string, p: string) => readFileSync(join(dir, ...p.split("/")));
  for (const p of paths) {
    const inA = fa.has(p), inB = fb.has(p);
    const bytesA = inA ? read(va.dir, p) : undefined;
    const bytesB = inB ? read(vb.dir, p) : undefined;
    if (bytesA && bytesB && bytesA.equals(bytesB)) { unchanged++; continue; }
    const entry: SkillFileDiff = {
      path: p, status: !inA ? "added" : !inB ? "removed" : "changed",
      ...(inA ? { sizeA: fa.get(p)! } : {}), ...(inB ? { sizeB: fb.get(p)! } : {}),
    };
    const binary = (bytesA && !looksLikeText(bytesA)) || (bytesB && !looksLikeText(bytesB));
    if (binary) entry.binary = true;
    else if ((bytesA?.length ?? 0) > SKILL_DIFF_LIMITS.maxFileBytes || (bytesB?.length ?? 0) > SKILL_DIFF_LIMITS.maxFileBytes || budget <= 0) entry.truncated = true;
    else {
      const d = unifiedDiff(bytesA?.toString("utf8") ?? "", bytesB?.toString("utf8") ?? "", inA ? `a/${p}` : "/dev/null", inB ? `b/${p}` : "/dev/null");
      if (!d) entry.truncated = true;
      else {
        entry.additions = d.additions;
        entry.deletions = d.deletions;
        const cap = Math.min(SKILL_DIFF_LIMITS.maxDiffChars, budget);
        if (d.text.length > cap) { entry.diff = d.text.slice(0, cap); entry.truncated = true; } else entry.diff = d.text;
        budget -= entry.diff.length;
      }
    }
    files.push(entry);
  }
  const count = (s: SkillFileDiff["status"]) => files.filter((f) => f.status === s).length;
  return { skill: ref.name, a: va.meta, b: vb.meta, files, unchanged, summary: { added: count("added"), removed: count("removed"), changed: count("changed") } };
}

function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/**
 * A unified diff (Myers' algorithm, 3 lines of context), or undefined when the files are too long to
 * compare. Lines are compared without their line endings.
 */
export function unifiedDiff(a: string, b: string, labelA = "a", labelB = "b", context = SKILL_DIFF_LIMITS.context): { text: string; additions: number; deletions: number } | undefined {
  const A = splitLines(a), B = splitLines(b);
  if (A.length > SKILL_DIFF_LIMITS.maxLines || B.length > SKILL_DIFF_LIMITS.maxLines) return undefined;
  const ops = myers(A, B);
  if (!ops) return undefined;
  let additions = 0, deletions = 0;
  for (const o of ops) { if (o.t === "+") additions++; else if (o.t === "-") deletions++; }
  // hunks: runs of changes with `context` lines around them
  const out: string[] = [`--- ${labelA}`, `+++ ${labelB}`];
  let i = 0;
  while (i < ops.length) {
    if (ops[i].t === " ") { i++; continue; }
    let start = Math.max(0, i - context);
    let end = i;
    // extend while the next change is within 2*context unchanged lines
    for (;;) {
      while (end < ops.length && ops[end].t !== " ") end++;
      let gap = end;
      while (gap < ops.length && ops[gap].t === " ") gap++;
      if (gap < ops.length && gap - end <= context * 2) { end = gap; continue; }
      end = Math.min(ops.length, end + context);
      break;
    }
    const slice = ops.slice(start, end);
    const aStart = slice.find((o) => o.t !== "+")?.ai ?? (ops.slice(0, start).filter((o) => o.t !== "+").length);
    const bStart = slice.find((o) => o.t !== "-")?.bi ?? (ops.slice(0, start).filter((o) => o.t !== "-").length);
    const aLen = slice.filter((o) => o.t !== "+").length;
    const bLen = slice.filter((o) => o.t !== "-").length;
    out.push(`@@ -${aLen ? aStart + 1 : aStart},${aLen} +${bLen ? bStart + 1 : bStart},${bLen} @@`);
    for (const o of slice) out.push(`${o.t}${o.line}`);
    i = end;
    start = end;
  }
  return { text: out.join("\n") + "\n", additions, deletions };
}

type Op = { t: " " | "+" | "-"; line: string; ai?: number; bi?: number };

/** Myers' O(ND) diff of two line arrays (undefined past a cost bound). */
function myers(A: string[], B: string[]): Op[] | undefined {
  const N = A.length, M = B.length, MAX = N + M;
  // the trace keeps V[-d..d] per step: memory grows with the square of the edit distance, so it is bounded
  const bound = Math.min(MAX, 2000);
  const off = MAX + 1;
  const V = new Int32Array(2 * MAX + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= bound; d++) {
    trace.push(V.slice(off - d - 1, off + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && V[off + k - 1] < V[off + k + 1]) ? V[off + k + 1] : V[off + k - 1] + 1;
      let y = x - k;
      while (x < N && y < M && A[x] === B[y]) { x++; y++; }
      V[off + k] = x;
      if (x >= N && y >= M) { found = d; break; }
    }
    if (found >= 0) break;
  }
  if (found < 0) return undefined;
  // backtrack
  const ops: Op[] = [];
  let x = N, y = M;
  for (let d = found; d > 0; d--) {
    // trace[d] holds V[-d-1..d+1] (index 0 is k = -d-1)
    const t = trace[d];
    const at = (k: number) => t[k + d + 1];
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { x--; y--; ops.push({ t: " ", line: A[x], ai: x, bi: y }); }
    if (x === prevX) { y--; ops.push({ t: "+", line: B[y], bi: y }); } else { x--; ops.push({ t: "-", line: A[x], ai: x }); }
  }
  while (x > 0 && y > 0) { x--; y--; ops.push({ t: " ", line: A[x], ai: x, bi: y }); }
  return ops.reverse();
}

// ── Restore ──

/**
 * Put a version back as the skill's files (the skill is recreated when it was deleted): the current
 * state is recorded first, the version's folder is swapped in, and the result is recorded as a new
 * version (source "restore").
 */
export function restoreSkillVersion(polpoDir: string, ref: SkillRef, version: number, author?: string): SkillVersion {
  const { dir } = versionDir(polpoDir, ref, version);
  const folder = skillFolder(polpoDir, ref);
  const base = dirname(folder);
  let restored: SkillVersion | undefined;
  withSkillVersion(polpoDir, ref, { author, source: "restore", restoredFrom: version }, () => {
    mkdirSync(base, { recursive: true });
    const staging = join(base, ".staging");
    const id = randomBytes(6).toString("hex");
    const fresh = join(staging, `${ref.name}-${id}`);
    const old = join(staging, `${ref.name}-${id}-old`);
    try {
      copyFolder(dir, listSkillFiles(dir, 100_000).files, fresh);
      const hadOld = existsSync(folder) || isSymlink(folder);
      if (hadOld) renameSync(folder, old);
      try { renameSync(fresh, folder); } catch (err) {
        if (hadOld) renameSync(old, folder);
        throw err;
      }
      if (hadOld) rmSync(old, { recursive: true, force: true });
    } finally {
      rmSync(fresh, { recursive: true, force: true });
      try { if (readdirSync(staging).length === 0) rmSync(staging, { recursive: true, force: true }); } catch { /* gone */ }
    }
  });
  const h = readHistory(polpoDir, ref);
  restored = h?.versions.at(-1);
  if (!restored) throw new SkillVersionError(`Restoring version ${version} of "${ref.name}" recorded nothing`);
  // restoring the state the skill already has records nothing new: the latest version is that state
  return restored;
}

function isSymlink(p: string): boolean {
  try { return lstatSync(p).isSymbolicLink(); } catch { return false; }
}
