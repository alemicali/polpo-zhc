/**
 * Skill versions — a skill's lifecycle, like agents': a draft, semver-numbered versions, a production
 * pointer, publish with a note, rollback, diffs.
 *
 *   edit ──▶ draft (the skill's folder) ──publish──▶ 1.3.0 (a copy of the folder) = production
 *                                                    ◀── rollback (production back to 1.2.0) ──
 *
 * The skill's folder (`.polpo/skills/<name>/`, what people and tools edit) is its **draft**, the
 * working copy. **Production** is a published version: its files are materialised next to the pool in
 * `<pool>/.production/<name>/` and that is what agents load ({@link runtimeSkillDir}: prompts, bundled
 * files, harness sync, progressive tools). A folder that differs from production is a pending draft,
 * whoever changed it: Polpo (a dashboard edit in draft mode) or something else — files edited on disk
 * show as "external changes" and never reach agents until someone publishes them (or discards them).
 *
 * Every change Polpo makes runs through {@link withSkillVersion} with a mode: "draft" leaves it in the
 * draft; "publish" (the default for internal callers: learning, the CLI, installs) publishes the folder
 * at once as a new version in production ("Applied directly"). A new skill is published as 1.0.0.
 *
 * Storage, outside the skill pools so agents never see it:
 *
 *   <polpoDir>/skill-versions/<pool>/project/<name>/      (a project skill)
 *   ~/.polpo/skill-versions/<pool>/global/<name>/         (a global skill: next to the global pool)
 *     index.json                                          (versions, production pointer, draft, events)
 *     1/ 2/ 3/ …                                          (each version's files)
 *
 * Migration (schema 1 → 2, idempotent, at start and lazily on first use): a history without semver gets
 * one — what agents ran until then (the folder; recorded first as "external" when it differs from the
 * latest version, as the old model did at the next change) becomes 1.0.0 in production and older
 * versions 0.0.<n>; a skill without history is published as 1.0.0.
 *
 * Retention: the last {@link SKILL_VERSION_RETENTION.maxVersions} versions and at most
 * {@link SKILL_VERSION_RETENTION.maxBytes} per skill (the oldest go first; production, the draft's base
 * and the latest always stay). Deleting a skill keeps its history for
 * {@link SKILL_VERSION_RETENTION.deletedDays} days, so it can be restored; then it is purged.
 * POLPO_SKILL_VERSIONS_KEEP, POLPO_SKILL_VERSIONS_MAX_MB and POLPO_SKILL_VERSIONS_DELETED_DAYS change
 * the defaults.
 *
 * Everything here is synchronous: in one process two changes to a skill never interleave.
 */

import { createHash, randomBytes } from "node:crypto";
import {
  copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { getGlobalPolpoDir } from "../core/constants.js";
import { listSkillFiles, looksLikeText, readSkillFrontmatter, resolveSkillFile, zipSkillDir, type SkillFileEntry } from "./skill-bundle.js";

// ── Types ──

export type SkillVersionPool = "agent" | "orchestrator";
export type SkillVersionScope = "project" | "global";

/** How a version (or a draft) came to be. */
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
  | "external"
  /** The draft published. */
  | "publish";

export type SkillVersionBump = "major" | "minor" | "patch";

/** A change is left in the draft, or published at once as a new version in production. */
export type SkillVersionMode = "draft" | "publish";

export interface SkillVersion {
  /** The storage number (1, 2, 3…; never reused). */
  version: number;
  /** Semver: "1.3.0". Every version has one once migrated. */
  semver?: string;
  createdAt: string;
  /** Who: "person:<email>", an agent's name, "polpo", "mcp:<client>", "cli", "system:…" or "unknown". */
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
  /** The release note. */
  note?: string;
  /** How the number was chosen. */
  bump?: SkillVersionBump | "custom" | "initial" | "migration";
  /** The version it was edited from (production when the draft started). */
  previous?: string;
  /** It holds changes made outside Polpo (files edited on disk). */
  external?: boolean;
}

/** The draft's metadata (its files are the skill's folder). */
export interface SkillDraftMeta {
  /** The version (number) production ran when the draft started. */
  base?: number;
  updatedAt: string;
  updatedBy: string;
  /** The folder's hash after Polpo's last write: a different hash means files changed outside Polpo. */
  hash: string;
  source?: SkillVersionSource;
  restoredFrom?: number;
  /** Files changed outside Polpo were in the folder when Polpo last wrote it (they stay flagged). */
  external?: boolean;
}

export type SkillVersionEventAction = "initial" | "migration" | "publish" | "rollback" | "discard" | "rebase";

/** One step of the lifecycle (newest last in the index): who, when, from → to, the note. */
export interface SkillVersionEvent {
  id: string;
  action: SkillVersionEventAction;
  /** Semver production ran before (publish, rollback). */
  from?: string;
  fromVersion?: number;
  /** Semver production runs after. */
  to?: string;
  toVersion?: number;
  actor: string;
  at: string;
  note?: string;
  /** A publish made in the same call as the change (no separate draft step). */
  direct?: boolean;
}

export interface SkillVersionHistory {
  /** The skill's folder name. */
  skill: string;
  pool: SkillVersionPool;
  scope: SkillVersionScope;
  /** 2: semver, production pointer, draft and events. Absent: a history from before (migrated on use). */
  schema?: number;
  /** Oldest first. */
  versions: SkillVersion[];
  /** The next version number (numbers are never reused, even after pruning). */
  next: number;
  /** The version (number) agents run. */
  production?: number;
  /** The version materialised in `<pool>/.production/<name>/`. */
  materialized?: number;
  draft?: SkillDraftMeta;
  /** Oldest first, the last {@link MAX_EVENTS}. */
  events?: SkillVersionEvent[];
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

/** Who makes a change, how, and whether it is published at once. */
export interface SkillChange {
  author?: string;
  source: SkillVersionSource;
  restoredFrom?: number;
  /** "publish" (default): published at once as a new version in production. "draft": left in the draft. */
  mode?: SkillVersionMode;
  note?: string;
  bump?: SkillVersionBump;
  /** An explicit semver for the version published (above the highest). */
  version?: string;
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

const MAX_EVENTS = 200;
const SCHEMA = 2;

export class SkillVersionError extends Error {
  constructor(message: string, readonly code: "NOT_FOUND" | "INVALID" | "NO_CHANGES" | "CONFLICT" = "NOT_FOUND") {
    super(message);
    this.name = "SkillVersionError";
  }
}

// ── Semver ──

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function isSkillSemver(v: string): boolean { return SEMVER.test(v); }

function parseSemver(v: string | undefined): [number, number, number] {
  const m = v ? SEMVER.exec(v) : null;
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
}

export function compareSkillSemver(a: string | undefined, b: string | undefined): number {
  const pa = parseSemver(a), pb = parseSemver(b);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i]! - pb[i]!;
  return 0;
}

export function bumpSkillSemver(v: string | undefined, bump: SkillVersionBump): string {
  const [ma, mi, pa] = parseSemver(v);
  if (bump === "major") return `${ma + 1}.0.0`;
  if (bump === "minor") return `${ma}.${mi + 1}.0`;
  return `${ma}.${mi}.${pa + 1}`;
}

/** "1.2.0" for a version (its number when it has no semver yet). */
export function skillVersionLabel(v: Pick<SkillVersion, "version" | "semver"> | undefined): string {
  return v ? v.semver ?? `v${v.version}` : "";
}

// ── Paths ──

const SAFE_NAME = /^[A-Za-z0-9._-]+$/;
/** The folder of a pool that holds production copies (never a skill name). */
export const PRODUCTION_DIR = ".production";

function assertRef(ref: SkillRef): void {
  if (!SAFE_NAME.test(ref.name) || ref.name === "." || ref.name === ".." || ref.name === PRODUCTION_DIR || ref.name.length > 128) {
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

/** The installed skill's folder (its draft: where its files are edited), whether it exists or not. */
export function skillFolder(polpoDir: string, ref: SkillRef): string {
  assertRef(ref);
  const base = ref.global ? getGlobalPolpoDir() : polpoDir;
  return ref.pool === "orchestrator" ? join(base, ".agent", "skills", ref.name) : join(base, "skills", ref.name);
}

/** Where production's files are materialised: `<pool>/.production/<name>/`. */
export function productionSkillFolder(polpoDir: string, ref: SkillRef): string {
  const folder = skillFolder(polpoDir, ref);
  return join(dirname(folder), PRODUCTION_DIR, ref.name);
}

/**
 * The folder agents load a skill from: its production copy when the skill is versioned, else the
 * folder itself (a skill not yet under versioning, or one outside a pool). `path` is the skill's
 * folder in a pool, or a symlink to it (an agent's skills/ folder).
 */
export function runtimeSkillDir(path: string): string {
  let real: string;
  try { real = realpathSync(path); } catch { return path; }
  const prod = join(dirname(real), PRODUCTION_DIR, basename(real));
  try { if (statSync(join(prod, "SKILL.md")).isFile()) return prod; } catch { /* not versioned */ }
  return path;
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
  return { skill: ref.name, pool: ref.pool, scope: ref.global ? "global" : "project", schema: SCHEMA, versions: [], next: 1, events: [] };
}

const eventId = () => `skv_${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;

function pushEvent(h: SkillVersionHistory, e: Omit<SkillVersionEvent, "id" | "at"> & { at?: string }): SkillVersionEvent {
  const ev: SkillVersionEvent = { id: eventId(), at: e.at ?? new Date().toISOString(), ...e } as SkillVersionEvent;
  h.events = [...(h.events ?? []), ev].slice(-MAX_EVENTS);
  return ev;
}

// ── Listeners (the server turns publishes and rollbacks into bus events) ──

export interface SkillLifecycleNotice {
  polpoDir: string;
  ref: SkillRef;
  action: "published" | "rolled-back";
  version: SkillVersion;
  from?: string;
  event: SkillVersionEvent;
}

const listeners = new Set<(n: SkillLifecycleNotice) => void>();

/** Called after every publish and rollback (any caller: routes, learning, the CLI). Returns the unsubscribe. */
export function onSkillLifecycle(listener: (n: SkillLifecycleNotice) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function notify(n: SkillLifecycleNotice): void {
  for (const l of listeners) {
    try { l(n); } catch { /* a listener never breaks a change */ }
  }
}

// ── Folder state ──

interface FolderState { files: SkillFileEntry[]; totalBytes: number; hash: string; name?: string; description?: string }

const stateCache = new Map<string, { sig: string; state: FolderState }>();

/** The files of a folder, their total size, a hash of their paths and bytes, and SKILL.md's name/description. */
function folderState(dir: string): FolderState | undefined {
  let root: string;
  try { root = realpathSync(dir); } catch { return undefined; }
  if (!lstatSync(root).isDirectory()) return undefined;
  const { files } = listSkillFiles(root, 100_000);
  // a cheap signature (paths, sizes, mtimes) saves re-reading unchanged folders
  // (only when every file is older than a few seconds: a write in the same clock tick with the
  // same size would otherwise look unchanged)
  let sig = "";
  let recent = false;
  const now = Date.now();
  for (const f of files) {
    let m = 0;
    try { m = statSync(join(root, ...f.path.split("/"))).mtimeMs; } catch { /* gone */ }
    if (now - m < 3000) recent = true;
    sig += `${f.path}\0${f.size}\0${m}\n`;
  }
  const cached = recent ? undefined : stateCache.get(root);
  if (cached && cached.sig === sig) return cached.state;
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
  const state: FolderState = { files, totalBytes, hash: h.digest("hex"), ...(name ? { name } : {}), ...(description ? { description } : {}) };
  if (stateCache.size > 500) stateCache.clear();
  if (!recent) stateCache.set(root, { sig, state });
  return state;
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

function isSymlink(p: string): boolean {
  try { return lstatSync(p).isSymbolicLink(); } catch { return false; }
}

/** Replace `target` with a fresh copy of `files` (from `from`), atomically enough: staging + rename. */
function swapFolder(target: string, fill: (fresh: string) => void): void {
  const base = dirname(target);
  mkdirSync(base, { recursive: true });
  const staging = join(base, ".staging");
  const id = randomBytes(6).toString("hex");
  const fresh = join(staging, `${basename(target)}-${id}`);
  const old = join(staging, `${basename(target)}-${id}-old`);
  try {
    mkdirSync(fresh, { recursive: true });
    fill(fresh);
    const hadOld = existsSync(target) || isSymlink(target);
    if (hadOld) renameSync(target, old);
    try { renameSync(fresh, target); } catch (err) {
      if (hadOld) renameSync(old, target);
      throw err;
    }
    if (hadOld) rmSync(old, { recursive: true, force: true });
  } finally {
    rmSync(fresh, { recursive: true, force: true });
    try { if (readdirSync(staging).length === 0) rmSync(staging, { recursive: true, force: true }); } catch { /* gone */ }
  }
}

function versionPath(polpoDir: string, ref: SkillRef, version: number): string {
  return join(skillVersionsDir(polpoDir, ref), String(version));
}

/** Write production's files into `<pool>/.production/<name>/` (removed when there is no production). */
function materialize(polpoDir: string, ref: SkillRef, h: SkillVersionHistory): void {
  const target = productionSkillFolder(polpoDir, ref);
  if (h.production === undefined || h.deletedAt) {
    rmSync(target, { recursive: true, force: true });
    delete h.materialized;
    return;
  }
  const dir = versionPath(polpoDir, ref, h.production);
  if (!existsSync(dir)) throw new SkillVersionError(`Version ${h.production} of "${ref.name}" is missing on disk`);
  swapFolder(target, (fresh) => copyFolder(dir, listSkillFiles(dir, 100_000).files, fresh));
  h.materialized = h.production;
}

// ── Recording ──

function record(polpoDir: string, ref: SkillRef, h: SkillVersionHistory, folder: string, state: FolderState, v: Omit<SkillVersion, "version" | "createdAt" | "files" | "totalBytes" | "hash" | "name" | "description">): SkillVersion {
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
  const out: SkillVersion = {
    version: n, ...(v.semver ? { semver: v.semver } : {}), createdAt: new Date().toISOString(), author: v.author || "unknown", source: v.source,
    files: state.files.length, totalBytes: state.totalBytes,
    ...(state.name ? { name: state.name } : {}), ...(state.description ? { description: state.description } : {}),
    ...(v.restoredFrom !== undefined ? { restoredFrom: v.restoredFrom } : {}),
    hash: state.hash,
    ...(v.note?.trim() ? { note: v.note.trim() } : {}),
    ...(v.bump ? { bump: v.bump } : {}),
    ...(v.previous ? { previous: v.previous } : {}),
    ...(v.external ? { external: true } : {}),
  };
  h.versions.push(out);
  h.next = n + 1;
  return out;
}

/** Keep the last maxVersions versions and at most maxBytes; production, the draft's base and the latest always stay. */
function prune(polpoDir: string, ref: SkillRef, h: SkillVersionHistory): void {
  const dir = skillVersionsDir(polpoDir, ref);
  const { maxVersions, maxBytes } = SKILL_VERSION_RETENTION;
  const keep = new Set([h.production, h.draft?.base, h.versions.at(-1)?.version].filter((x): x is number => x !== undefined));
  let total = h.versions.reduce((s, v) => s + v.totalBytes, 0);
  while (h.versions.length > maxVersions || total > maxBytes) {
    const i = h.versions.findIndex((v) => !keep.has(v.version));
    if (i < 0) break;
    const [old] = h.versions.splice(i, 1);
    total -= old!.totalBytes;
    rmSync(join(dir, String(old!.version)), { recursive: true, force: true });
  }
}

const findVersion = (h: SkillVersionHistory, n: number | undefined) => (n === undefined ? undefined : h.versions.find((v) => v.version === n));
const highestSemver = (h: SkillVersionHistory) => h.versions.reduce<string | undefined>((top, v) => (v.semver && compareSkillSemver(v.semver, top) > 0 ? v.semver : top), undefined);

// ── Versioning (migration, the first version) ──

/**
 * Bring a skill under versioning (idempotent): a skill without history is published as 1.0.0; a
 * history from before semver is migrated (what agents ran — the folder — is 1.0.0 in production);
 * production's copy is materialised when missing. Returns the history, or undefined when the skill
 * has neither files nor history.
 */
export function ensureSkillVersioning(polpoDir: string, ref: SkillRef, actor = "system:migration"): SkillVersionHistory | undefined {
  const folder = skillFolder(polpoDir, ref);
  let h = readHistory(polpoDir, ref);
  if (!h && !existsSync(folder)) return undefined;
  if (h?.deletedAt) return h;
  let dirty = false;
  if (!h || h.versions.length === 0) {
    const state = folderState(folder);
    if (!state) return h;
    h = h ?? emptyHistory(ref);
    h.schema = SCHEMA;
    const v = record(polpoDir, ref, h, folder, state, { author: actor, source: "external", semver: "1.0.0", bump: "initial", note: "Initial version" });
    h.production = v.version;
    pushEvent(h, { action: "initial", to: v.semver, toVersion: v.version, actor, note: "Initial version" });
    dirty = true;
  } else if (h.schema !== SCHEMA || h.production === undefined) {
    // a history from before semver: what agents ran (the folder) becomes 1.0.0 in production
    const state = folderState(folder);
    if (state && h.versions.at(-1)?.hash !== state.hash) {
      record(polpoDir, ref, h, folder, state, { author: "unknown", source: "external" });
    }
    const latest = h.versions.at(-1)!;
    for (const v of h.versions) {
      if (!v.semver) {
        v.semver = v === latest ? "1.0.0" : `0.0.${v.version}`;
        v.bump = "migration";
      }
    }
    h.schema = SCHEMA;
    h.production = latest.version;
    h.events = h.events ?? [];
    pushEvent(h, { action: "migration", to: latest.semver, toVersion: latest.version, actor, note: "Versioned: the skill as it ran became 1.0.0" });
    prune(polpoDir, ref, h);
    dirty = true;
  }
  if (h.materialized !== h.production || !existsSync(join(productionSkillFolder(polpoDir, ref), "SKILL.md"))) {
    materialize(polpoDir, ref, h);
    dirty = true;
  }
  if (dirty) writeHistory(polpoDir, ref, h);
  return h;
}

/**
 * Bring every skill of this project (and the global pools) under versioning. Returns the skills
 * initialised or migrated.
 */
export function migrateSkillVersions(polpoDir: string): string[] {
  const done: string[] = [];
  for (const pool of ["agent", "orchestrator"] as const) {
    for (const global of [false, true]) {
      const poolDir = dirname(skillFolder(polpoDir, { pool, global, name: "x" }));
      let names: string[];
      try { names = readdirSync(poolDir); } catch { continue; }
      for (const name of names) {
        if (!SAFE_NAME.test(name) || name.startsWith(".")) continue;
        if (!existsSync(join(poolDir, name, "SKILL.md"))) continue;
        const ref = { pool, global, name };
        try {
          const before = readHistory(polpoDir, ref);
          const wasDone = before?.schema === SCHEMA && before.production !== undefined;
          ensureSkillVersioning(polpoDir, ref);
          if (!wasDone) done.push(`${pool === "orchestrator" ? "orchestrator/" : ""}${global ? "global/" : ""}${name}`);
        } catch (err) {
          console.warn(`[skills] could not version ${name}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  }
  return done;
}

// ── Draft state ──

export interface SkillDraftFileChange { path: string; status: "added" | "removed" | "changed" }

export interface SkillVersionState {
  skill: string;
  pool: SkillVersionPool;
  scope: SkillVersionScope;
  /** The version agents run. */
  production?: { version: number; semver: string; createdAt: string; author: string; note?: string };
  /** The highest semver. */
  latest?: string;
  versions: number;
  deleted?: boolean;
  draft: {
    /** The folder differs from production, or a draft was saved. */
    exists: boolean;
    hasChanges: boolean;
    /** Files changed outside Polpo (edited on disk) are in the draft. */
    external: boolean;
    /** The version the draft started from. */
    baseVersion?: string;
    base?: number;
    /** Production moved away from the draft's base (a rollback): rebase or discard before publishing. */
    stale: boolean;
    warning?: string;
    updatedAt?: string;
    updatedBy?: string;
    source?: SkillVersionSource;
    restoredFrom?: number;
    changes: SkillDraftFileChange[];
    suggestedBump?: SkillVersionBump;
    nextVersion?: string;
  };
}

/** Files that differ between two folders (by bytes). */
function fileChanges(a: string | undefined, b: string): SkillDraftFileChange[] {
  const read = (dir: string, p: string) => readFileSync(join(dir, ...p.split("/")));
  const fa = new Map(a && existsSync(a) ? listSkillFiles(a, 100_000).files.map((f) => [f.path, f.size]) : []);
  const fb = new Map(existsSync(b) ? listSkillFiles(b, 100_000).files.map((f) => [f.path, f.size]) : []);
  const out: SkillDraftFileChange[] = [];
  for (const p of [...new Set([...fa.keys(), ...fb.keys()])].sort()) {
    if (!fa.has(p)) out.push({ path: p, status: "added" });
    else if (!fb.has(p)) out.push({ path: p, status: "removed" });
    else if (fa.get(p) !== fb.get(p) || !read(a!, p).equals(read(b, p))) out.push({ path: p, status: "changed" });
  }
  return out;
}

function frontmatterOf(dir: string | undefined): { name?: string; description?: string; tools?: string } {
  if (!dir) return {};
  try {
    const fm = readSkillFrontmatter(readFileSync(join(dir, "SKILL.md"), "utf8"));
    if (!fm.ok) return {};
    const tools = fm.fm.allowedTools;
    return { name: fm.fm.name, description: fm.fm.description, tools: tools === undefined ? undefined : JSON.stringify(tools) };
  } catch { return {}; }
}

/**
 * The bump a change deserves: major when files are removed or the skill is renamed; minor when files
 * are added or what agents read to choose it (description, expected tools) changes; patch otherwise.
 */
export function suggestSkillBump(fromDir: string | undefined, toDir: string, changes = fileChanges(fromDir, toDir)): SkillVersionBump | undefined {
  if (!changes.length) return undefined;
  const a = frontmatterOf(fromDir), b = frontmatterOf(toDir);
  if (changes.some((c) => c.status === "removed") || (a.name && b.name && a.name !== b.name)) return "major";
  if (changes.some((c) => c.status === "added") || a.description !== b.description || a.tools !== b.tools) return "minor";
  return "patch";
}

const staleMessage = (name: string, base?: string, production?: string) =>
  `${name}'s draft is based on ${base ?? "an earlier version"}, production is now ${production ?? "another version"}: rebase it onto production or discard it first`;

/** The skill's lifecycle state: production, latest, the draft (changes, external, stale, suggested bump). */
export function skillVersionState(polpoDir: string, ref: SkillRef): SkillVersionState | undefined {
  const h = ensureSkillVersioning(polpoDir, ref);
  if (!h) return undefined;
  const folder = skillFolder(polpoDir, ref);
  const prod = findVersion(h, h.production);
  const prodDir = prod ? versionPath(polpoDir, ref, prod.version) : undefined;
  const latest = highestSemver(h);
  const state = h.deletedAt ? undefined : folderState(folder);
  const hasChanges = !!state && (!prod || prod.hash !== state.hash);
  const changes = hasChanges ? fileChanges(prodDir, folder) : [];
  const meta = h.draft;
  const external = hasChanges && (!meta || meta.hash !== state!.hash || !!meta.external);
  const base = meta?.base ?? prod?.version;
  const baseV = findVersion(h, base);
  const stale = hasChanges && !!prod && base !== undefined && base !== prod.version;
  const bump = hasChanges ? suggestSkillBump(prodDir, folder, changes) : undefined;
  return {
    skill: ref.name, pool: ref.pool, scope: ref.global ? "global" : "project",
    ...(prod ? { production: { version: prod.version, semver: skillVersionLabel(prod), createdAt: prod.createdAt, author: prod.author, ...(prod.note ? { note: prod.note } : {}) } } : {}),
    ...(latest ? { latest } : {}),
    versions: h.versions.length,
    ...(h.deletedAt ? { deleted: true } : {}),
    draft: {
      exists: hasChanges,
      hasChanges,
      external,
      ...(baseV ? { baseVersion: skillVersionLabel(baseV), base: baseV.version } : {}),
      stale,
      ...(stale ? { warning: staleMessage(ref.name, skillVersionLabel(baseV), skillVersionLabel(prod)).replace(" first", "") } : {}),
      ...(hasChanges && meta ? { updatedAt: meta.updatedAt, updatedBy: meta.updatedBy, ...(meta.source ? { source: meta.source } : {}), ...(meta.restoredFrom !== undefined ? { restoredFrom: meta.restoredFrom } : {}) } : {}),
      changes,
      ...(bump ? { suggestedBump: bump, nextVersion: bumpSkillSemver(latest ?? "0.0.0", bump) } : {}),
    },
  };
}

// ── Publish ──

export interface PublishSkillOptions {
  actor: string;
  bump?: SkillVersionBump;
  /** An explicit semver (overrides bump); must be above the highest. */
  version?: string;
  note?: string;
  source?: SkillVersionSource;
  restoredFrom?: number;
  /** Published in the same call as the change. */
  direct?: boolean;
  /** Whether it holds changes made outside Polpo (default: the folder differs from Polpo's last write). */
  external?: boolean;
}

/** The semver a publish would get. */
function nextSemver(h: SkillVersionHistory, bump: SkillVersionBump | undefined, explicit: string | undefined): { semver: string; bump: SkillVersion["bump"] } {
  const top = highestSemver(h);
  if (explicit) {
    if (!isSkillSemver(explicit)) throw new SkillVersionError(`"${explicit}" is not a version (major.minor.patch, e.g. 1.4.0)`, "INVALID");
    if (top && compareSkillSemver(explicit, top) <= 0) throw new SkillVersionError(`Version ${explicit} must be above the latest, ${top}`, "CONFLICT");
    return { semver: explicit, bump: "custom" };
  }
  if (!top) return { semver: "1.0.0", bump: "initial" };
  const b = bump ?? "patch";
  return { semver: bumpSkillSemver(top, b), bump: b };
}

/** Publish the folder as a new version and point production at it (history already loaded and migrated). */
function publishUnlocked(polpoDir: string, ref: SkillRef, h: SkillVersionHistory, opts: PublishSkillOptions & { allowStale?: boolean }): SkillVersion {
  const folder = skillFolder(polpoDir, ref);
  const state = folderState(folder);
  if (!state) throw new SkillVersionError(`Skill "${ref.name}" has no files to publish`, "NOT_FOUND");
  const prod = findVersion(h, h.production);
  const wasDeleted = !!h.deletedAt;
  if (prod && prod.hash === state.hash && !wasDeleted) throw new SkillVersionError(`${ref.name} has no draft changes to publish`, "NO_CHANGES");
  const base = findVersion(h, h.draft?.base ?? prod?.version);
  if (!opts.allowStale && !wasDeleted && prod && base && base.version !== prod.version) {
    throw new SkillVersionError(staleMessage(ref.name, skillVersionLabel(base), skillVersionLabel(prod)), "CONFLICT");
  }
  const external = opts.external ?? (!!prod && (!h.draft || h.draft.hash !== state.hash || !!h.draft.external));
  // a deleted skill brought back exactly as it was: its latest version again
  const same = wasDeleted ? h.versions.find((v) => v.hash === state.hash && v.semver) : undefined;
  let v: SkillVersion;
  if (same) v = same;
  else {
    const prodDir = prod ? versionPath(polpoDir, ref, prod.version) : undefined;
    const suggested = opts.bump ?? (prodDir ? suggestSkillBump(prodDir, folder) : undefined);
    const next = nextSemver(h, suggested, opts.version);
    v = record(polpoDir, ref, h, folder, state, {
      author: opts.actor, source: opts.source ?? "publish", semver: next.semver, bump: next.bump, note: opts.note,
      ...(base?.semver ? { previous: base.semver } : {}), ...(opts.restoredFrom !== undefined ? { restoredFrom: opts.restoredFrom } : {}),
      ...(external && !wasDeleted ? { external: true } : {}),
    });
  }
  h.schema = SCHEMA;
  h.production = v.version;
  delete h.draft;
  delete h.deletedAt;
  delete h.deletedBy;
  const ev = pushEvent(h, {
    action: prod ? "publish" : "initial",
    ...(prod && !wasDeleted ? { from: skillVersionLabel(prod), fromVersion: prod.version } : {}),
    to: v.semver, toVersion: v.version, actor: opts.actor,
    ...(opts.note?.trim() ? { note: opts.note.trim() } : {}), ...(opts.direct ? { direct: true } : {}),
  });
  prune(polpoDir, ref, h);
  materialize(polpoDir, ref, h);
  writeHistory(polpoDir, ref, h);
  notify({ polpoDir, ref, action: "published", version: v, ...(prod && !wasDeleted ? { from: skillVersionLabel(prod) } : {}), event: ev });
  return v;
}

/** Publish the skill's draft (its folder) as a new version in production. */
export function publishSkillDraft(polpoDir: string, ref: SkillRef, opts: PublishSkillOptions): SkillVersion {
  const h = ensureSkillVersioning(polpoDir, ref);
  if (!h) throw new SkillVersionError(`Skill "${ref.name}" not found`);
  return publishUnlocked(polpoDir, ref, h, opts);
}

/** Save the draft's metadata after Polpo wrote the folder (no metadata when it equals production). */
function saveDraftMeta(polpoDir: string, ref: SkillRef, h: SkillVersionHistory, who: SkillChange, externalBefore = false): void {
  const state = folderState(skillFolder(polpoDir, ref));
  const prod = findVersion(h, h.production);
  if (!state || (prod && prod.hash === state.hash)) delete h.draft;
  else {
    h.draft = {
      base: h.draft?.base ?? prod?.version,
      updatedAt: new Date().toISOString(),
      updatedBy: who.author || "unknown",
      hash: state.hash,
      source: who.source,
      ...(who.restoredFrom !== undefined ? { restoredFrom: who.restoredFrom } : {}),
      ...(externalBefore ? { external: true } : {}),
    };
    if (h.draft.base === undefined) delete h.draft.base;
  }
  writeHistory(polpoDir, ref, h);
}

/**
 * Run a change to a skill folder through versioning: the skill is brought under versioning first
 * (that failing aborts the change), then `change` writes the folder (the draft), then, per
 * `who.mode`, the folder is published at once as a new version in production ("publish", the
 * default; a stale draft refuses it before anything is written) or left in the draft ("draft").
 * A new skill — or a deleted one written again — is always published (1.0.0 for a new one).
 */
export function withSkillVersion<T>(polpoDir: string, ref: SkillRef, who: SkillChange, change: () => T): T {
  const mode = who.mode ?? "publish";
  const before = ensureSkillVersioning(polpoDir, ref);
  // files changed outside Polpo before this change ride along with it, flagged external
  const st = before && !before.deletedAt && before.production !== undefined ? skillVersionState(polpoDir, ref) : undefined;
  if (mode === "publish" && st?.draft.stale) throw new SkillVersionError(staleMessage(ref.name, st.draft.baseVersion, st.production?.semver), "CONFLICT");
  const externalBefore = !!st?.draft.external;
  const out = change();
  try {
    const h = readHistory(polpoDir, ref) ?? emptyHistory(ref);
    const exists = existsSync(join(skillFolder(polpoDir, ref), "SKILL.md")) || !!folderState(skillFolder(polpoDir, ref));
    if (!exists) return out;
    if (h.versions.length === 0) {
      ensureSkillVersioning(polpoDir, ref, who.author || "unknown");
      // the first version records how the skill came to be
      const fresh = readHistory(polpoDir, ref);
      const first = fresh?.versions[0];
      if (fresh && first && fresh.versions.length === 1) {
        first.source = who.source;
        first.author = who.author || "unknown";
        if (who.note?.trim()) first.note = who.note.trim();
        const ev = fresh.events?.at(-1);
        if (ev) { ev.actor = first.author; if (who.note?.trim()) ev.note = who.note.trim(); }
        writeHistory(polpoDir, ref, fresh);
        if (ev) notify({ polpoDir, ref, action: "published", version: first, event: ev });
      }
    } else if (h.deletedAt || h.production === undefined || mode === "publish") {
      const state = folderState(skillFolder(polpoDir, ref));
      const prod = findVersion(h, h.production);
      if (state && (h.deletedAt || !prod || prod.hash !== state.hash)) {
        publishUnlocked(polpoDir, ref, h, {
          actor: who.author || "unknown", source: who.source, note: who.note ?? "Applied directly", bump: who.bump, version: who.version,
          restoredFrom: who.restoredFrom, direct: true, external: externalBefore,
        });
      } else if (h.draft) { delete h.draft; writeHistory(polpoDir, ref, h); }
    } else {
      saveDraftMeta(polpoDir, ref, h, who, externalBefore);
    }
  } catch (err) {
    if (err instanceof SkillVersionError && (err.code === "CONFLICT" || err.code === "INVALID")) throw err;
    console.warn(`[skills] could not record a version of ${ref.name}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return out;
}

/**
 * Record the folder as it is now as a new version in production when it differs from production
 * (kept for callers that wrote the folder themselves). Returns the new version, or undefined.
 */
export function recordSkillVersion(polpoDir: string, ref: SkillRef, change: SkillChange): SkillVersion | undefined {
  const h = ensureSkillVersioning(polpoDir, ref, change.author || "unknown");
  if (!h) return undefined;
  const state = folderState(skillFolder(polpoDir, ref));
  const prod = findVersion(h, h.production);
  if (!state || (prod && prod.hash === state.hash && !h.deletedAt)) return undefined;
  return publishUnlocked(polpoDir, ref, h, { actor: change.author || "unknown", source: change.source, note: change.note, direct: true, allowStale: true });
}

// ── Rollback, discard, rebase ──

/** A version by number ("3", 3) or semver ("1.2.0"); "production" / "latest" too. */
export function resolveSkillVersionRef(h: SkillVersionHistory, ref: string | number): SkillVersion | undefined {
  if (typeof ref === "number") return findVersion(h, ref);
  const r = ref.trim().replace(/^v(?=\d+\.\d+\.\d+$)/, "");
  if (r === "production") return findVersion(h, h.production);
  if (r === "latest") { const top = highestSemver(h); return h.versions.find((v) => v.semver === top); }
  if (isSkillSemver(r)) return h.versions.find((v) => v.semver === r);
  const n = Number(r.replace(/^v/, ""));
  return Number.isInteger(n) && n > 0 ? findVersion(h, n) : undefined;
}

export interface SkillRollbackResult {
  from?: string;
  to: SkillVersion;
  /** The working folder followed production (it had no draft changes); false: the draft was kept (now stale). */
  folderReset: boolean;
  event: SkillVersionEvent;
}

/**
 * Point production back at an earlier version: `to`, or the version production ran before the publish
 * that brought the current one (repeated rollbacks walk back), else the version below it. A folder
 * without draft changes follows production; a pending draft is kept (it becomes stale).
 */
export function rollbackSkill(polpoDir: string, ref: SkillRef, opts: { actor: string; to?: string | number; note?: string }): SkillRollbackResult {
  const h = ensureSkillVersioning(polpoDir, ref);
  if (!h || h.deletedAt) throw new SkillVersionError(`Skill "${ref.name}" not found`);
  const current = findVersion(h, h.production);
  let target: SkillVersion | undefined;
  if (opts.to !== undefined && opts.to !== "") {
    target = resolveSkillVersionRef(h, opts.to);
    if (!target) throw new SkillVersionError(`${ref.name} has no version ${opts.to}`);
  } else {
    const back = [...(h.events ?? [])].reverse()
      .find((e) => e.toVersion === current?.version && (e.action === "publish" || e.action === "initial") && e.fromVersion !== undefined && e.fromVersion !== current?.version);
    target = findVersion(h, back?.fromVersion)
      ?? h.versions.filter((v) => current && v.version !== current.version && compareSkillSemver(v.semver, current.semver) < 0)
        .sort((a, b) => compareSkillSemver(a.semver, b.semver)).at(-1);
  }
  if (!target) throw new SkillVersionError(`${ref.name} has no earlier version to roll back to`);
  if (current && target.version === current.version) throw new SkillVersionError(`${ref.name} already runs ${skillVersionLabel(target)} in production`, "NO_CHANGES");
  if (!existsSync(versionPath(polpoDir, ref, target.version))) throw new SkillVersionError(`Version ${skillVersionLabel(target)} of "${ref.name}" is missing on disk`);
  const folder = skillFolder(polpoDir, ref);
  const state = folderState(folder);
  const clean = !state || (!!current && current.hash === state.hash);
  if (clean) {
    const dir = versionPath(polpoDir, ref, target.version);
    swapFolder(folder, (fresh) => copyFolder(dir, listSkillFiles(dir, 100_000).files, fresh));
    delete h.draft;
  } else if (!h.draft) {
    // the pending changes were made on the version production ran until now (kept as the draft's base)
    h.draft = { ...(current ? { base: current.version } : {}), updatedAt: new Date().toISOString(), updatedBy: "unknown", hash: "" };
  } else if (h.draft.base === undefined && current) h.draft.base = current.version;
  h.production = target.version;
  const ev = pushEvent(h, {
    action: "rollback", ...(current ? { from: skillVersionLabel(current), fromVersion: current.version } : {}),
    to: skillVersionLabel(target), toVersion: target.version, actor: opts.actor, ...(opts.note?.trim() ? { note: opts.note.trim() } : {}),
  });
  materialize(polpoDir, ref, h);
  writeHistory(polpoDir, ref, h);
  notify({ polpoDir, ref, action: "rolled-back", version: target, ...(current ? { from: skillVersionLabel(current) } : {}), event: ev });
  return { ...(current ? { from: skillVersionLabel(current) } : {}), to: target, folderReset: clean, event: ev };
}

/** Throw the draft away: the folder becomes production's files again. Returns false when there was nothing to discard. */
export function discardSkillDraft(polpoDir: string, ref: SkillRef, actor: string): boolean {
  const h = ensureSkillVersioning(polpoDir, ref);
  if (!h || h.deletedAt) throw new SkillVersionError(`Skill "${ref.name}" not found`);
  const prod = findVersion(h, h.production);
  if (!prod) throw new SkillVersionError(`${ref.name} has no production version`);
  const folder = skillFolder(polpoDir, ref);
  const state = folderState(folder);
  if (state && state.hash === prod.hash) {
    if (h.draft) { delete h.draft; writeHistory(polpoDir, ref, h); }
    return false;
  }
  const dir = versionPath(polpoDir, ref, prod.version);
  swapFolder(folder, (fresh) => copyFolder(dir, listSkillFiles(dir, 100_000).files, fresh));
  delete h.draft;
  pushEvent(h, { action: "discard", to: skillVersionLabel(prod), toVersion: prod.version, actor });
  writeHistory(polpoDir, ref, h);
  return true;
}

/**
 * Move a stale draft onto what production runs now, file by file: a file the draft changed (against
 * its base) keeps the draft's content; every other file becomes production's. Nothing left to change:
 * the draft goes.
 */
export function rebaseSkillDraft(polpoDir: string, ref: SkillRef, actor: string): { dropped: boolean; from?: string; to?: string } {
  const h = ensureSkillVersioning(polpoDir, ref);
  if (!h || h.deletedAt) throw new SkillVersionError(`Skill "${ref.name}" not found`);
  const prod = findVersion(h, h.production);
  if (!prod) throw new SkillVersionError(`${ref.name} has no production version`);
  const folder = skillFolder(polpoDir, ref);
  const state = folderState(folder);
  if (!state || state.hash === prod.hash) throw new SkillVersionError(`${ref.name} has no draft to rebase`, "NOT_FOUND");
  const base = findVersion(h, h.draft?.base ?? prod.version) ?? prod;
  const baseDir = versionPath(polpoDir, ref, base.version);
  const prodDir = versionPath(polpoDir, ref, prod.version);
  const filesOf = (dir: string) => new Map(listSkillFiles(dir, 100_000).files.map((f) => [f.path, readFileSync(join(realpathSync(dir), ...f.path.split("/")))]));
  const d = filesOf(folder), b = existsSync(baseDir) ? filesOf(baseDir) : new Map<string, Buffer>(), p = filesOf(prodDir);
  const result = new Map<string, Buffer>();
  for (const path of new Set([...d.keys(), ...b.keys(), ...p.keys()])) {
    const dv = d.get(path), bv = b.get(path), pv = p.get(path);
    const draftChanged = !(dv === undefined ? bv === undefined : bv !== undefined && dv.equals(bv));
    const v = draftChanged ? dv : pv;
    if (v !== undefined) result.set(path, v);
  }
  swapFolder(folder, (fresh) => {
    for (const [path, bytes] of result) {
      const dest = join(fresh, ...path.split("/"));
      if (!dest.startsWith(fresh + sep)) throw new Error(`Unsafe path "${path}"`);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, bytes);
    }
  });
  const after = folderState(folder);
  const dropped = !after || after.hash === prod.hash;
  if (dropped) delete h.draft;
  else h.draft = { ...(h.draft ?? { source: "edit" as const }), base: prod.version, updatedAt: new Date().toISOString(), updatedBy: actor, hash: after!.hash };
  pushEvent(h, { action: "rebase", from: skillVersionLabel(base), fromVersion: base.version, to: skillVersionLabel(prod), toVersion: prod.version, actor });
  writeHistory(polpoDir, ref, h);
  return { dropped, from: skillVersionLabel(base), to: skillVersionLabel(prod) };
}

// ── Deletion ──

/**
 * Before a skill is deleted: bring it under versioning (its production stays its latest published
 * state) and mark the history deleted (kept {@link SKILL_VERSION_RETENTION.deletedDays} days, so the
 * skill can be restored). Production's copy goes with the skill.
 */
export function markSkillDeleted(polpoDir: string, ref: SkillRef, by?: string): void {
  const h = ensureSkillVersioning(polpoDir, ref);
  if (!h || h.versions.length === 0) { rmSync(productionSkillFolder(polpoDir, ref), { recursive: true, force: true }); return; }
  h.deletedAt = new Date().toISOString();
  if (by) h.deletedBy = by;
  delete h.draft;
  materialize(polpoDir, ref, h);
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
    if (!SAFE_NAME.test(name) || name === PRODUCTION_DIR) continue;
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

/** A skill's history (newest first), or undefined when it has none. `current` is production's number. */
export function listSkillVersions(polpoDir: string, ref: SkillRef): (SkillVersionHistory & { current?: number }) | undefined {
  let h: SkillVersionHistory | undefined;
  try { h = ensureSkillVersioning(polpoDir, ref); } catch { h = readHistory(polpoDir, ref); }
  if (!h) return undefined;
  return {
    ...h, versions: [...h.versions].reverse(), events: [...(h.events ?? [])].reverse(),
    ...(h.production !== undefined && !h.deletedAt ? { current: h.production } : {}),
  };
}

/** Does the skill have a history (project or global)? */
export function hasSkillVersions(polpoDir: string, ref: SkillRef): boolean {
  return (readHistory(polpoDir, ref)?.versions.length ?? 0) > 0;
}

function versionDir(polpoDir: string, ref: SkillRef, version: number | string): { dir: string; meta: SkillVersion } {
  const h = readHistory(polpoDir, ref);
  const meta = h ? resolveSkillVersionRef(h, version) : undefined;
  if (!meta) throw new SkillVersionError(`Skill "${ref.name}" has no version ${version}`);
  const dir = versionPath(polpoDir, ref, meta.version);
  if (!existsSync(dir)) throw new SkillVersionError(`Version ${skillVersionLabel(meta)} of "${ref.name}" is missing on disk`);
  return { dir, meta };
}

/** The files of one version (number or semver). */
export function listSkillVersionFiles(polpoDir: string, ref: SkillRef, version: number | string): { version: SkillVersion; files: SkillFileEntry[]; totalBytes: number } {
  const { dir, meta } = versionDir(polpoDir, ref, version);
  const { files } = listSkillFiles(dir, 100_000);
  return { version: meta, files, totalBytes: files.reduce((s, f) => s + f.size, 0) };
}

/** The absolute path of a file of a version, or undefined when the path is unsafe or not a file. */
export function resolveSkillVersionFile(polpoDir: string, ref: SkillRef, version: number | string, relPath: string): string | undefined {
  const { dir } = versionDir(polpoDir, ref, version);
  return resolveSkillFile(dir, relPath);
}

/** A version as a .skill archive (the folder at its root). */
export function zipSkillVersion(polpoDir: string, ref: SkillRef, version: number | string): Buffer {
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
  /** "1.2.0", "draft", "v3": what each side is. */
  from: string;
  to: string;
  /** The versions compared (absent for the draft). */
  a?: SkillVersion;
  b?: SkillVersion;
  files: SkillFileDiff[];
  unchanged: number;
  summary: { added: number; removed: number; changed: number };
}

/** "draft", "production", "latest", a number or a semver → a folder, a label and the version. */
function sideOf(polpoDir: string, ref: SkillRef, side: string | number): { dir: string; label: string; meta?: SkillVersion } {
  if (side === "draft") {
    const folder = skillFolder(polpoDir, ref);
    if (!existsSync(folder)) throw new SkillVersionError(`Skill "${ref.name}" has no draft (it was deleted)`);
    return { dir: folder, label: "draft" };
  }
  const { dir, meta } = versionDir(polpoDir, ref, side);
  return { dir, label: skillVersionLabel(meta), meta };
}

/**
 * Compare two sides of a skill — "draft", "production", "latest", a version number or a semver: files
 * added, removed and changed, with unified diffs of text files (size-capped).
 */
export function diffSkillRefs(polpoDir: string, ref: SkillRef, from: string | number, to: string | number): SkillVersionDiff {
  ensureSkillVersioning(polpoDir, ref);
  const va = sideOf(polpoDir, ref, from);
  const vb = sideOf(polpoDir, ref, to);
  const fa = new Map(listSkillFiles(va.dir, 100_000).files.map((f) => [f.path, f.size]));
  const fb = new Map(listSkillFiles(vb.dir, 100_000).files.map((f) => [f.path, f.size]));
  const rootA = realpathSync(va.dir), rootB = realpathSync(vb.dir);
  const paths = [...new Set([...fa.keys(), ...fb.keys()])].sort();
  const files: SkillFileDiff[] = [];
  let unchanged = 0;
  let budget = SKILL_DIFF_LIMITS.maxTotalChars;
  const read = (dir: string, p: string) => readFileSync(join(dir, ...p.split("/")));
  for (const p of paths) {
    const inA = fa.has(p), inB = fb.has(p);
    const bytesA = inA ? read(rootA, p) : undefined;
    const bytesB = inB ? read(rootB, p) : undefined;
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
  return {
    skill: ref.name, from: va.label, to: vb.label, ...(va.meta ? { a: va.meta } : {}), ...(vb.meta ? { b: vb.meta } : {}),
    files, unchanged, summary: { added: count("added"), removed: count("removed"), changed: count("changed") },
  };
}

/** Compare two versions (numbers or semvers). */
export function diffSkillVersions(polpoDir: string, ref: SkillRef, a: number | string, b: number | string): SkillVersionDiff {
  return diffSkillRefs(polpoDir, ref, a, b);
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

export interface SkillRestoreResult {
  restoredFrom: number;
  /** The version published (publish mode, or a deleted skill brought back). */
  published?: SkillVersion;
  /** The restore is in the draft (draft mode): publish it to put it in production. */
  draft: boolean;
}

/**
 * Put a version's files back as the skill's folder (recreating a deleted skill). In "draft" mode the
 * restore is the draft (publish it, or roll production back instead); in "publish" mode (the default)
 * it is published at once as a new version (source "restore"). A deleted skill is always published.
 */
export function restoreSkillVersion(polpoDir: string, ref: SkillRef, version: number | string, author?: string, opts: { mode?: SkillVersionMode; note?: string; bump?: SkillVersionBump } = {}): SkillRestoreResult {
  const { dir, meta } = versionDir(polpoDir, ref, version);
  const folder = skillFolder(polpoDir, ref);
  const before = readHistory(polpoDir, ref);
  const prodBefore = before?.production;
  withSkillVersion(polpoDir, ref, {
    author, source: "restore", restoredFrom: meta.version, mode: opts.mode ?? "publish",
    note: opts.note ?? `Restored ${skillVersionLabel(meta)}`, ...(opts.bump ? { bump: opts.bump } : {}),
  }, () => {
    swapFolder(folder, (fresh) => copyFolder(dir, listSkillFiles(dir, 100_000).files, fresh));
  });
  const h = readHistory(polpoDir, ref);
  const published = h && (h.production !== prodBefore || before?.deletedAt) ? findVersion(h, h.production) : undefined;
  return { restoredFrom: meta.version, ...(published ? { published } : {}), draft: !published && !!h?.draft };
}
