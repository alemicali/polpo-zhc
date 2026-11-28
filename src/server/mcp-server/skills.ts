/**
 * Skills (instructions agents load when a task calls for them): list, read, create, update,
 * install, delete, and assign them to agents; upload .skill/.zip bundles (prepare → finalize) and read
 * a skill's bundled files. Changes need polpo:admin, as they change what agents do.
 */
import { z } from "zod";
import {
  BAD_CURSOR, DESTRUCTIVE, READ, UPDATE, WRITE, apiError, apiGet, apiSend, confirmParam, cursorParam, enc, fail, limitParam, looseObject,
  ok, page, pageOutput, qs, short,
  type McpDeps, type Register,
} from "./kit.js";
import { unknownAgents } from "./tasks.js";
import { fetchPublicBytes } from "./config.js";
import { SKILL_BUNDLE_LIMITS } from "../../llm/skill-bundle.js";

type Skill = { name: string; description: string; source: "project" | "global"; assignedTo?: string[]; tags?: string[]; category?: string; allowedTools?: string[]; content?: string };

const skillItem = z.object({
  name: z.string(), description: z.string(), source: z.string(), assigned_to: z.array(z.string()),
  tags: z.array(z.string()).optional(), category: z.string().optional(),
});
const view = (s: Skill) => ({
  name: s.name, description: s.description, source: s.source, assigned_to: s.assignedTo ?? [],
  ...(s.tags?.length ? { tags: s.tags } : {}), ...(s.category ? { category: s.category } : {}),
});
const SKILL_NAME = /^[A-Za-z0-9._-]+$/;

async function listSkills(deps: McpDeps) {
  const r = await apiGet(deps, "/skills");
  return r.ok ? { ok: true as const, skills: (r.data as Skill[]) ?? [] } : r;
}

const notFound = (name: string) => fail(`There is no skill "${name}". Find the name with polpo_skills_list.`);

type SkillFile = { path: string; size: number };
const size = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
const poolParam = z.enum(["agent", "orchestrator"]).optional().describe("agent (default): the agents' skills; orchestrator: Polpo's own skills");
const poolPath = (pool: "agent" | "orchestrator" | undefined) => (pool === "orchestrator" ? "/skills/orchestrator" : "/skills");

/** The largest archive (Anthropic's Skills API limit: 30 MB uncompressed). */
const MAX_ARCHIVE_BYTES = SKILL_BUNDLE_LIMITS.maxArchiveBytes;
/** Base64 chunks of an archive sent in several calls, until the last one (kept 30 minutes). */
const partials = new Map<string, { chunks: Buffer[]; size: number; filename?: string; expires: number }>();

type PreviewSkill = {
  name: string; folder: string; description: string; files: SkillFile[]; totalBytes: number; errors: string[]; warnings: string[];
  license?: string; exists: Record<"agent" | "orchestrator", { project: boolean; global: boolean }>;
};
type Preview = { uploadId: string; archiveName?: string; skills: PreviewSkill[]; ignored: string[]; warnings: string[] };

const previewSkill = z.object({
  name: z.string(), folder: z.string(), description: z.string(), files: z.array(z.object({ path: z.string(), size: z.number() })),
  total_bytes: z.number(), errors: z.array(z.string()), warnings: z.array(z.string()), name_taken: z.boolean(),
});

/**
 * Upload a skill bundle in two steps (MCP clients cannot send multipart): prepare reads the archive
 * (a public URL, a file of the instance, or base64 — in chunks when large) and returns a preview with
 * an upload id; finalize installs it with the choices made (conflicts, renames, assignment).
 */
function registerSkillBundleTools(tool: Register, deps: McpDeps): void {
  tool("skills", "polpo_skill_upload_prepare", {
    title: "Upload a skill bundle (preview)",
    description: "Read a .skill or .zip skill bundle (a folder with SKILL.md plus scripts/, references/, assets/…; several skills allowed) "
      + "and preview it without installing: each skill's name, description, files, sizes, problems (errors block the install, a rename fixes name errors) "
      + "and whether the name is taken. The archive comes from a public https URL, a file of the instance (e.g. a chat attachment), or base64 "
      + "(large archives: send chunks with more: true and append_to, the last one without more). Then install it with polpo_skill_upload_finalize and the upload_id. "
      + `Limits: ${MAX_ARCHIVE_BYTES / 1024 / 1024} MB, ${SKILL_BUNDLE_LIMITS.maxFiles} files.`,
    inputSchema: {
      archive: z.union([
        z.object({ url: z.string().url().describe("A public https URL of the archive") }),
        z.object({ path: z.string().min(1).describe("A file of the instance, e.g. attachments/pdf-tools.skill") }),
        z.object({
          base64: z.string().min(1).describe("The archive's bytes (or the next chunk of them) in base64"),
          filename: z.string().optional().describe("The archive's file name, e.g. pdf-tools.skill"),
          append_to: z.string().optional().describe("The chunk_id of the previous chunk"),
          more: z.boolean().optional().describe("true: more chunks follow (the answer has a chunk_id to append_to)"),
        }),
      ]).describe("{ url } or { path } or { base64, filename? }"),
      pool: poolParam,
      global: z.boolean().optional().describe("true: compare names with the global pool (~/.polpo) instead of this project's"),
    },
    outputSchema: {
      upload_id: z.string().optional(), chunk_id: z.string().optional(), received_bytes: z.number().optional(),
      skills: z.array(previewSkill).optional(), ignored: z.array(z.string()).optional(), warnings: z.array(z.string()).optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ archive, pool, global }) => {
    let bytes: Uint8Array;
    let filename: string | undefined;
    if ("url" in archive) {
      const got = await fetchPublicBytes(deps, archive.url, { maxBytes: MAX_ARCHIVE_BYTES, accept: "application/zip, application/octet-stream, */*", urlLabel: "archive", sizeLabel: "archive" });
      if (!got.ok) return fail(`The archive could not be read: ${got.error}. Give another URL, a file of the instance (path) or base64 data.`);
      bytes = got.bytes;
      filename = decodeURIComponent(new URL(archive.url).pathname.split("/").pop() ?? "") || undefined;
    } else if ("path" in archive) {
      const res = await deps.api("GET", `/api/v1/files/read${qs({ path: archive.path })}`);
      if (res.status >= 400) return fail(`Cannot read ${archive.path} (HTTP ${res.status}). Find the file with polpo_files_search.`);
      bytes = res.bytes ?? new Uint8Array();
      filename = archive.path.split("/").pop();
    } else {
      const now = Date.now();
      for (const [id, p] of partials) if (p.expires <= now) partials.delete(id);
      const chunk = Buffer.from(archive.base64.replace(/^data:[^,]*,/, ""), "base64");
      if (chunk.byteLength === 0) return fail("The base64 data is empty or invalid.");
      let partial = archive.append_to ? partials.get(archive.append_to) : undefined;
      if (archive.append_to && !partial) return fail(`There is no pending upload ${archive.append_to} (chunks are kept 30 minutes): start again without append_to.`);
      if (!partial) partial = { chunks: [], size: 0, ...(archive.filename ? { filename: archive.filename } : {}), expires: now + 30 * 60_000 };
      partial.chunks.push(chunk);
      partial.size += chunk.byteLength;
      if (partial.size > MAX_ARCHIVE_BYTES) {
        if (archive.append_to) partials.delete(archive.append_to);
        return fail(`The archive is over ${MAX_ARCHIVE_BYTES / 1024 / 1024} MB.`);
      }
      if (archive.more) {
        const id = archive.append_to ?? `chunk_${Math.random().toString(36).slice(2, 12)}`;
        partials.set(id, partial);
        return ok(`Received ${size(partial.size)} so far: send the next chunk with append_to: "${id}" (more: true until the last one).`, { chunk_id: id, received_bytes: partial.size });
      }
      if (archive.append_to) partials.delete(archive.append_to);
      bytes = Buffer.concat(partial.chunks);
      filename = archive.filename ?? partial.filename;
    }
    if (bytes.byteLength === 0) return fail("The archive is empty.");
    if (bytes.byteLength > MAX_ARCHIVE_BYTES) return fail(`The archive is over ${MAX_ARCHIVE_BYTES / 1024 / 1024} MB.`);
    const form = new FormData();
    form.append("file", new File([bytes as Uint8Array<ArrayBuffer>], filename || "bundle.skill", { type: "application/zip" }));
    const r = await apiSend(deps, "POST", "/skills/upload?dryRun=1", form);
    if (!r.ok) return fail(`This is not a valid skill bundle: ${r.error}. A skill is a folder with a SKILL.md (YAML frontmatter with name and description), zipped.`);
    const p = r.data as Preview;
    const scope = global ? "global" : "project";
    const items = p.skills.map((s) => ({
      name: s.name, folder: s.folder, description: s.description, files: s.files, total_bytes: s.totalBytes,
      errors: s.errors, warnings: s.warnings, name_taken: s.exists[pool ?? "agent"][scope],
    }));
    const lines = items.map((s) => `- ${s.name}${s.folder ? ` (folder ${s.folder})` : ""}: ${short(s.description, 120)}\n  ${s.files.length} files, ${size(s.total_bytes)}`
      + `${s.name_taken ? " — the name is taken (on_conflict replace/skip, or renames)" : ""}`
      + `${s.errors.length ? `\n  errors: ${s.errors.join("; ")}` : ""}${s.warnings.length ? `\n  warnings: ${s.warnings.join("; ")}` : ""}`);
    return ok(`Preview of ${p.archiveName ?? "the archive"} (nothing installed yet; upload_id ${p.uploadId}, kept 30 minutes):\n${lines.join("\n")}`
      + `${p.warnings.length ? `\nNotes: ${p.warnings.join("; ")}` : ""}${p.ignored.length ? `\nIgnored junk: ${p.ignored.length} file(s)` : ""}`
      + "\nShow this to the person, then install with polpo_skill_upload_finalize.",
    { upload_id: p.uploadId, skills: items, ignored: p.ignored, warnings: p.warnings });
  });

  tool("skills", "polpo_skill_upload_finalize", {
    title: "Install an uploaded skill bundle",
    description: "Install a bundle previewed with polpo_skill_upload_prepare (its upload_id): into the agents' pool (default) or Polpo's own, "
      + "this project or the global pool; choose what happens when a name exists (fail, replace, skip) or rename skills; optionally only some "
      + "skills, and assign them to agents.",
    inputSchema: {
      upload_id: z.string().min(1).describe("The upload_id from polpo_skill_upload_prepare"),
      pool: poolParam,
      global: z.boolean().optional().describe("true: the global pool (every project on this machine)"),
      on_conflict: z.enum(["fail", "replace", "skip"]).optional().describe("When a skill with the same name exists (default fail)"),
      renames: z.record(z.string(), z.string()).optional().describe("Archive name → name to install as (lowercase letters, digits, hyphens)"),
      skills: z.array(z.string()).optional().describe("Only these skills of the archive (default all)"),
      assign_to: z.array(z.string()).optional().describe("Agents to assign the installed skills to (agents' pool)"),
    },
    outputSchema: {
      installed: z.array(z.object({ name: z.string(), from: z.string(), replaced: z.boolean(), files: z.number() })),
      skipped: z.array(z.string()), errors: z.array(z.string()), assigned: z.array(z.string()),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async ({ upload_id, pool, global, on_conflict, renames, skills, assign_to }) => {
    if (assign_to?.length) {
      const missing = await unknownAgents(deps, assign_to);
      if (missing) return fail(missing);
    }
    const res = await deps.api("POST", `/api/v1/skills/upload/${enc(upload_id)}/install`, {
      ...(pool ? { pool } : {}), ...(global ? { global } : {}), ...(on_conflict ? { onConflict: on_conflict } : {}),
      ...(renames ? { renames } : {}), ...(skills?.length ? { skills } : {}), ...(assign_to?.length ? { assignTo: assign_to } : {}),
    });
    type Out = { installed?: Array<{ name: string; from: string; replaced: boolean; files: number }>; skipped?: Array<{ name: string }>; errors?: Array<{ name: string; error: string }>; assigned?: Array<{ skill: string; agent: string }> };
    const body = res.body as { ok?: boolean; data?: Out; details?: Out; error?: string; code?: string } | null;
    if (res.status === 404) return fail(`Upload ${upload_id} expired or does not exist: run polpo_skill_upload_prepare again.`);
    const d = body?.data ?? body?.details ?? {};
    const installed = (d.installed ?? []).map(({ name, from, replaced, files }) => ({ name, from, replaced, files }));
    const skipped = (d.skipped ?? []).map((s) => s.name);
    const errors = (d.errors ?? []).map((e) => `${e.name}: ${e.error}`);
    const assigned = (d.assigned ?? []).map((a) => `${a.skill} → ${a.agent}`);
    if (res.status >= 400 && installed.length === 0) {
      return fail(`Nothing was installed: ${errors.join("; ") || body?.error || `HTTP ${res.status}`}.${body?.code === "CONFLICT" ? " Pass on_conflict (replace or skip) or renames." : ""}`);
    }
    return ok(`Installed ${installed.map((i) => `${i.name}${i.from !== i.name ? ` (from ${i.from})` : ""}${i.replaced ? " (replaced)" : ""}`).join(", ") || "nothing"}.`
      + `${skipped.length ? ` Skipped: ${skipped.join(", ")}.` : ""}${errors.length ? ` Errors: ${errors.join("; ")}.` : ""}${assigned.length ? ` Assigned: ${assigned.join(", ")}.` : ""}`,
    { installed, skipped, errors, assigned });
  });

  tool("skills", "polpo_skill_files", {
    title: "List a skill's files",
    description: "The files of an installed skill (SKILL.md, scripts/, references/, assets/…) with sizes. Read one with polpo_skill_file_read.",
    inputSchema: { name: z.string().min(1).describe("The skill's name"), pool: poolParam },
    outputSchema: { name: z.string(), files: z.array(z.object({ path: z.string(), size: z.number() })), total_bytes: z.number() },
    annotations: READ,
  }, async ({ name, pool }) => {
    const r = await apiGet(deps, `${poolPath(pool)}/${enc(name)}/files`);
    if (!r.ok) return r.status === 404 ? notFound(name) : apiError(r, `Listing ${name}'s files`);
    const d = r.data as { name: string; files: SkillFile[]; totalBytes: number };
    return ok(`${d.name}: ${d.files.length} files, ${size(d.totalBytes)}\n${d.files.map((f) => `- ${f.path} (${size(f.size)})`).join("\n")}`,
      { name: d.name, files: d.files, total_bytes: d.totalBytes });
  });

  tool("skills", "polpo_skill_file_read", {
    title: "Read a skill's file",
    description: "One file of an installed skill, by its path in the skill folder (e.g. references/api.md, scripts/run.py). "
      + "Text comes back as text (truncated at max_chars); a binary file comes back as its type and size, or as base64 with encoding: base64 (up to 4 MB).",
    inputSchema: {
      name: z.string().min(1).describe("The skill's name"),
      path: z.string().min(1).describe("The file's path in the skill folder, from polpo_skill_files"),
      pool: poolParam,
      max_chars: z.number().int().min(100).max(500_000).optional().describe("Longest text returned (default 60000)"),
      encoding: z.enum(["text", "base64"]).optional().describe("base64: the raw bytes (binary files)"),
    },
    outputSchema: { path: z.string(), content_type: z.string(), size: z.number(), text: z.string().optional(), base64: z.string().optional(), truncated: z.boolean().optional() },
    annotations: READ,
  }, async ({ name, path, pool, max_chars, encoding }) => {
    const rel = path.split("/").map(enc).join("/");
    const res = await deps.api("GET", `/api/v1${poolPath(pool)}/${enc(name)}/files/${rel}`);
    if (res.status === 404) return fail(`"${path}" is not a file of skill ${name}. List them with polpo_skill_files.`);
    if (res.status >= 400) return fail(`Reading ${path} of ${name} failed (HTTP ${res.status}).`);
    const bytes = res.bytes ?? new Uint8Array();
    const type = res.headers.get("content-type") ?? "application/octet-stream";
    const text = /^(text\/|application\/(json|xml|x-ndjson))/.test(type);
    if (encoding === "base64") {
      if (bytes.byteLength > 4 * 1024 * 1024) return fail(`${path} is ${size(bytes.byteLength)}: base64 is limited to 4 MB. Download it from the dashboard.`);
      return ok(`${path} (${type}, ${size(bytes.byteLength)}) as base64.`, { path, content_type: type, size: bytes.byteLength, base64: Buffer.from(bytes).toString("base64") });
    }
    if (!text) return ok(`${path} is a binary file (${type}, ${size(bytes.byteLength)}). Pass encoding: base64 for its bytes.`, { path, content_type: type, size: bytes.byteLength });
    const all = Buffer.from(bytes).toString("utf8");
    const max = max_chars ?? 60_000;
    const truncated = all.length > max;
    const out = truncated ? all.slice(0, max) : all;
    return ok(`${path} (${size(bytes.byteLength)}):\n\n${out}${truncated ? `\n\n[truncated at ${max} characters]` : ""}`,
      { path, content_type: type, size: bytes.byteLength, text: out, ...(truncated ? { truncated } : {}) });
  });
}

type SkillVersionItem = {
  version: number; semver?: string; createdAt: string; author: string; source: string; files: number; totalBytes: number;
  name?: string; description?: string; restoredFrom?: number; note?: string; previous?: string; external?: boolean;
};
type SkillDraftState = {
  exists: boolean; hasChanges: boolean; external: boolean; baseVersion?: string; stale: boolean; warning?: string;
  updatedAt?: string; updatedBy?: string; source?: string; changes: Array<{ path: string; status: string }>; suggestedBump?: string; nextVersion?: string;
};
type SkillState = { production?: { version: number; semver: string; createdAt: string; author: string; note?: string }; latest?: string; versions: number; deleted?: boolean; draft: SkillDraftState };
type SkillEvent = { action: string; from?: string; to?: string; actor: string; at: string; note?: string; direct?: boolean };
type VersionList = {
  name: string; scope: string; versions: SkillVersionItem[]; current?: number; production?: string; latest?: string; state?: SkillState;
  events?: SkillEvent[]; deletedAt?: string;
};
type FileDiff = { path: string; status: "added" | "removed" | "changed"; sizeA?: number; sizeB?: number; binary?: boolean; diff?: string; additions?: number; deletions?: number; truncated?: boolean };

const versionItem = z.object({
  version: z.number(), semver: z.string().optional(), created_at: z.string(), author: z.string(), source: z.string(), files: z.number(), total_bytes: z.number(),
  description: z.string().optional(), restored_from: z.number().optional(), note: z.string().optional(), previous: z.string().optional(),
  external: z.boolean().optional(), current: z.boolean(),
});
const draftItem = z.object({
  has_changes: z.boolean(), external: z.boolean(), stale: z.boolean(), base_version: z.string().optional(), warning: z.string().optional(),
  updated_by: z.string().optional(), updated_at: z.string().optional(), changes: z.array(z.object({ path: z.string(), status: z.string() })),
  suggested_bump: z.string().optional(), next_version: z.string().optional(),
});
const by = (author: string) => author.replace(/^person:/, "");
/** A version: its semver (1.2.0), its number (3), production or latest. */
const versionRef = z.union([z.number().int().min(1), z.string().min(1).max(40)]);
const label = (v: { version: number; semver?: string }) => v.semver ?? `v${v.version}`;

const draftView = (d: SkillDraftState) => ({
  has_changes: d.hasChanges, external: d.external, stale: d.stale, ...(d.baseVersion ? { base_version: d.baseVersion } : {}), ...(d.warning ? { warning: d.warning } : {}),
  ...(d.updatedBy ? { updated_by: d.updatedBy } : {}), ...(d.updatedAt ? { updated_at: d.updatedAt } : {}), changes: d.changes,
  ...(d.suggestedBump ? { suggested_bump: d.suggestedBump } : {}), ...(d.nextVersion ? { next_version: d.nextVersion } : {}),
});

/** "Draft: 2 files changed (external changes made on disk) — would publish 1.3.0" */
function draftLine(name: string, d: SkillDraftState | undefined): string {
  if (!d?.hasChanges) return "Draft: no changes (the skill's files are production's).";
  const what = d.changes.slice(0, 8).map((c) => `${c.status} ${c.path}`).join(", ") + (d.changes.length > 8 ? ", …" : "");
  return `Draft has changes: ${what}${d.external ? " — includes files changed outside Polpo (on disk)" : ""}${d.updatedBy ? `, last by ${by(d.updatedBy)}` : ""}.`
    + `${d.stale ? ` STALE: ${d.warning ?? "production moved"} (polpo_skill_draft action rebase or discard).` : d.nextVersion ? ` Publishing would make ${d.nextVersion} (${d.suggestedBump}): polpo_skill_publish.` : ""}`
    + ` Diff: polpo_skill_version_diff name "${name}" (production → draft).`;
}

/**
 * A skill's lifecycle, like an agent's: versions (semver) and production, the draft (dashboard
 * edits, restores, files changed on disk), publish, rollback, discard or rebase the draft, diffs.
 */
function registerSkillVersionTools(tool: Register, deps: McpDeps): void {
  tool("skills", "polpo_skill_versions", {
    title: "List a skill's versions",
    description: "A skill's lifecycle: its versions newest first (semver, date, who, how, release note), which one is in production (what agents run), "
      + "the draft (the skill's folder: unpublished edits and files changed on disk, shown as external changes — they never reach agents until published), "
      + "and the history of publishes and rollbacks. Compare with polpo_skill_version_diff, publish the draft with polpo_skill_publish, "
      + "roll production back with polpo_skill_rollback, discard or rebase the draft with polpo_skill_draft.",
    inputSchema: { name: z.string().min(1).describe("The skill's name"), pool: poolParam, limit: limitParam(20, 100) },
    outputSchema: {
      name: z.string(), scope: z.string(), current: z.number().optional(), production: z.string().optional(), latest: z.string().optional(),
      deleted_at: z.string().optional(), versions: z.array(versionItem), total: z.number(), draft: draftItem.optional(),
      events: z.array(z.object({ action: z.string(), from: z.string().optional(), to: z.string().optional(), actor: z.string(), at: z.string(), note: z.string().optional() })),
    },
    annotations: READ,
  }, async ({ name, pool, limit }) => {
    const r = await apiGet(deps, `${poolPath(pool)}/${enc(name)}/versions`);
    if (!r.ok) return r.status === 404 ? notFound(name) : apiError(r, `Listing ${name}'s versions`);
    const d = r.data as VersionList;
    const items = d.versions.slice(0, limit ?? 20).map((v) => ({
      version: v.version, ...(v.semver ? { semver: v.semver } : {}), created_at: v.createdAt, author: v.author, source: v.source, files: v.files, total_bytes: v.totalBytes,
      ...(v.description ? { description: v.description } : {}), ...(v.restoredFrom !== undefined ? { restored_from: v.restoredFrom } : {}),
      ...(v.note ? { note: v.note } : {}), ...(v.previous ? { previous: v.previous } : {}), ...(v.external ? { external: true } : {}),
      current: v.version === d.current,
    }));
    const events = (d.events ?? []).slice(0, 10).map((e) => ({ action: e.action, ...(e.from ? { from: e.from } : {}), ...(e.to ? { to: e.to } : {}), actor: e.actor, at: e.at, ...(e.note ? { note: e.note } : {}) }));
    const lines = items.map((v) => `- ${label(v)}${v.current ? " (production)" : ""} ${v.created_at.slice(0, 16).replace("T", " ")} by ${by(v.author)} (${v.source}${v.restored_from ? ` of v${v.restored_from}` : ""}${v.external ? ", with external changes" : ""}): ${v.files} files, ${size(v.total_bytes)}${v.note ? ` — ${short(v.note, 120)}` : ""}`);
    const evLines = events.slice(0, 5).map((e) => `- ${e.at.slice(0, 16).replace("T", " ")} ${e.action}${e.from || e.to ? ` ${e.from ?? "—"} → ${e.to ?? "—"}` : ""} by ${by(e.actor)}${e.note ? `: ${short(e.note, 100)}` : ""}`);
    return ok(`${d.name}: ${d.versions.length} version${d.versions.length === 1 ? "" : "s"}${d.production ? `, production ${d.production}` : ""}${d.latest && d.latest !== d.production ? ` (latest ${d.latest})` : ""}`
      + `${d.deletedAt ? ` (the skill was deleted ${d.deletedAt.slice(0, 10)}: restore a version to bring it back)` : ""}\n${draftLine(d.name, d.state?.draft)}\n${lines.join("\n") || "No versions yet."}`
      + `${d.versions.length > items.length ? `\n(${d.versions.length - items.length} older not shown)` : ""}${evLines.length ? `\nHistory:\n${evLines.join("\n")}` : ""}`,
    {
      name: d.name, scope: d.scope, ...(d.current ? { current: d.current } : {}), ...(d.production ? { production: d.production } : {}), ...(d.latest ? { latest: d.latest } : {}),
      ...(d.deletedAt ? { deleted_at: d.deletedAt } : {}), versions: items, total: d.versions.length, ...(d.state ? { draft: draftView(d.state.draft) } : {}), events,
    });
  });

  tool("skills", "polpo_skill_version_diff", {
    title: "Compare versions of a skill",
    description: "What changed in a skill between two sides: \"draft\", \"production\", \"latest\", a version (1.2.0) or its number (polpo_skill_versions). "
      + "Default: production → draft (what publishing would change). Files added, removed and changed, with a unified diff for text files "
      + "(binary or very large files are only named).",
    inputSchema: {
      name: z.string().min(1).describe("The skill's name"),
      a: versionRef.optional().describe("The older side (default production)"),
      b: versionRef.optional().describe("The newer side (default draft)"),
      pool: poolParam,
      max_chars: z.number().int().min(500).max(500_000).optional().describe("Longest diff text returned (default 40000)"),
    },
    outputSchema: {
      a: z.union([z.number(), z.string()]), b: z.union([z.number(), z.string()]), from: z.string().optional(), to: z.string().optional(), unchanged: z.number(),
      files: z.array(z.object({ path: z.string(), status: z.string(), binary: z.boolean().optional(), additions: z.number().optional(), deletions: z.number().optional(), truncated: z.boolean().optional() })),
      diff: z.string(),
    },
    annotations: READ,
  }, async ({ name, a, b, pool, max_chars }) => {
    const from = a ?? "production", to = b ?? "draft";
    const r = await apiGet(deps, `${poolPath(pool)}/${enc(name)}/diff${qs({ from: String(from), to: String(to) })}`);
    if (!r.ok) return r.status === 404 ? fail(`${r.error}. List the versions with polpo_skill_versions.`) : apiError(r, `Comparing versions of ${name}`);
    const d = r.data as { files: FileDiff[]; unchanged: number; from: string; to: string };
    const files = d.files.map(({ path, status, binary, additions, deletions, truncated }) => ({
      path, status, ...(binary ? { binary } : {}), ...(additions !== undefined ? { additions } : {}), ...(deletions !== undefined ? { deletions } : {}), ...(truncated ? { truncated } : {}),
    }));
    const max = max_chars ?? 40_000;
    let text = d.files.map((f) => f.diff ?? `${f.status === "added" ? "+++" : f.status === "removed" ? "---" : "~~~"} ${f.path}${f.binary ? " (binary)" : f.truncated ? " (too large to show)" : ""}\n`).join("");
    const cut = text.length > max;
    if (cut) text = `${text.slice(0, max)}\n[cut at ${max} characters]`;
    const summary = files.map((f) => `- ${f.status} ${f.path}${f.additions !== undefined ? ` (+${f.additions} −${f.deletions})` : ""}${f.binary ? " (binary)" : ""}`).join("\n");
    return ok(`${name} ${d.from} → ${d.to}: ${files.length ? `${files.length} file(s) differ, ${d.unchanged} unchanged` : "identical"}\n${summary}${text ? `\n\n${text}` : ""}`,
      { a: from, b: to, from: d.from, to: d.to, unchanged: d.unchanged, files, diff: text });
  });

  tool("skills", "polpo_skill_publish", {
    title: "Publish a skill's draft",
    description: "Publish the skill's draft (its unpublished changes, including files changed on disk) as a new version and put it in production: "
      + "agents use it from their next run. The number follows the suggested bump (major: files removed or the skill renamed; minor: files added, "
      + "or the description or expected tools changed; patch: instructions and other edits) unless bump or version say otherwise. "
      + "Show the person the diff first (polpo_skill_version_diff).",
    inputSchema: {
      name: z.string().min(1).describe("The skill's name"),
      bump: z.enum(["major", "minor", "patch"]).optional().describe("Override the suggested bump"),
      version: z.string().regex(/^\d+\.\d+\.\d+$/, "major.minor.patch").optional().describe("An explicit version number, above the latest"),
      note: z.string().max(2000).optional().describe("Release note: what changed and why"),
      pool: poolParam,
    },
    outputSchema: { name: z.string(), version: z.string(), version_number: z.number(), previous: z.string().optional(), production: z.string() },
    annotations: WRITE,
  }, async ({ name, bump, version, note, pool }) => {
    const r = await apiSend(deps, "POST", `${poolPath(pool)}/${enc(name)}/publish`, { ...(bump ? { bump } : {}), ...(version ? { version } : {}), ...(note ? { note } : {}) });
    if (!r.ok) {
      if (r.status === 404) return notFound(name);
      if (r.status === 409) return fail(/rebase/.test(r.error ?? "") ? `${r.error} (polpo_skill_draft).` : `${r.error}.`);
      if (r.code === "NO_CHANGES") return fail(`${name}'s draft equals production: nothing to publish. Change it first (polpo_skill_update with publish: false writes the draft).`);
      return apiError(r, `Publishing ${name}`);
    }
    const v = (r.data as { version: SkillVersionItem }).version;
    return ok(`Published ${name} ${label(v)}${v.previous ? ` (was ${v.previous})` : ""}: in production, agents use it from their next run.${v.external ? " It includes files changed outside Polpo." : ""}`,
      { name, version: label(v), version_number: v.version, ...(v.previous ? { previous: v.previous } : {}), production: label(v) });
  });

  tool("skills", "polpo_skill_rollback", {
    title: "Roll a skill back",
    description: "Put an earlier version of a skill in production: `to` (1.2.0 or its number), or the version production ran before the current one "
      + "(repeated rollbacks walk back). Agents use it from their next run. A pending draft is kept (it becomes stale: rebase or discard it). "
      + "Needs confirm: true after the person agreed.",
    inputSchema: {
      name: z.string().min(1).describe("The skill's name"),
      to: versionRef.optional().describe("The version to go back to (default: the previous production)"),
      note: z.string().max(2000).optional().describe("Why (kept in the history)"),
      pool: poolParam,
      confirm: confirmParam("roll production back"),
    },
    outputSchema: { name: z.string(), from: z.string().optional(), to: z.string(), draft_kept: z.boolean() },
    annotations: DESTRUCTIVE,
  }, async ({ name, to, note, pool, confirm }) => {
    if (confirm !== true) return fail(`Rolling ${name} back changes what agents run${to !== undefined ? ` to ${to}` : " to the previous production version"}: ask the person, then call again with confirm: true.`);
    const r = await apiSend(deps, "POST", `${poolPath(pool)}/${enc(name)}/rollback`, { ...(to !== undefined ? { to } : {}), ...(note ? { note } : {}) });
    if (!r.ok) return r.status === 404 ? fail(`${r.error ?? `No skill "${name}"`}. See polpo_skill_versions.`) : apiError(r, `Rolling ${name} back`);
    const d = r.data as { from?: string; to: SkillVersionItem; folderReset: boolean };
    return ok(`Rolled ${name} back: production is ${label(d.to)}${d.from ? ` (was ${d.from})` : ""}.${d.folderReset ? "" : " The pending draft was kept and is now stale: rebase or discard it (polpo_skill_draft)."}`,
      { name, ...(d.from ? { from: d.from } : {}), to: label(d.to), draft_kept: !d.folderReset });
  });

  tool("skills", "polpo_skill_draft", {
    title: "A skill's draft: show, discard or rebase",
    description: "The skill's draft is its folder: unpublished edits, restores and files changed outside Polpo (external changes). show: what is "
      + "pending against production; discard: the folder goes back to production's files (needs confirm: true: the changes are lost); "
      + "rebase: a stale draft (production was rolled back) moves onto production, keeping the files it changed.",
    inputSchema: {
      name: z.string().min(1).describe("The skill's name"),
      action: z.enum(["show", "discard", "rebase"]).optional().describe("show (default), discard or rebase"),
      pool: poolParam,
      confirm: confirmParam("discard the draft").optional(),
    },
    outputSchema: { name: z.string(), action: z.string(), production: z.string().optional(), draft: draftItem.optional(), discarded: z.boolean().optional(), dropped: z.boolean().optional() },
    annotations: DESTRUCTIVE,
  }, async ({ name, action, pool, confirm }) => {
    const base = `${poolPath(pool)}/${enc(name)}`;
    if (action === "discard") {
      if (confirm !== true) return fail(`Discarding ${name}'s draft puts its files back to production's: unpublished changes (and files changed on disk) are lost. Ask the person, then call again with confirm: true.`);
      const r = await apiSend(deps, "DELETE", `${base}/draft`);
      if (!r.ok) return r.status === 404 ? notFound(name) : apiError(r, `Discarding ${name}'s draft`);
      const d = r.data as { discarded: boolean; state?: SkillState };
      return ok(d.discarded ? `Discarded ${name}'s draft: its files are production's (${d.state?.production?.semver ?? "?"}).` : `${name} had no draft changes.`,
        { name, action, discarded: d.discarded, ...(d.state?.production ? { production: d.state.production.semver } : {}) });
    }
    if (action === "rebase") {
      const r = await apiSend(deps, "POST", `${base}/draft/rebase`);
      if (!r.ok) return r.status === 404 ? fail(r.error ?? `${name} has no draft.`) : apiError(r, `Rebasing ${name}'s draft`);
      const d = r.data as { from?: string; to?: string; dropped: boolean; state?: SkillState };
      return ok(d.dropped ? `${name}'s draft had nothing left to change over production ${d.to ?? ""}: dropped.`
        : `Rebased ${name}'s draft from ${d.from ?? "?"} onto production ${d.to ?? "?"}: publish it with polpo_skill_publish.`,
      { name, action, dropped: d.dropped, ...(d.to ? { production: d.to } : {}), ...(d.state ? { draft: draftView(d.state.draft) } : {}) });
    }
    const r = await apiGet(deps, `${base}/versioning`);
    if (!r.ok) return r.status === 404 ? notFound(name) : apiError(r, `Reading ${name}'s draft`);
    const s = r.data as SkillState;
    return ok(`${name}: production ${s.production?.semver ?? "none"}${s.latest && s.latest !== s.production?.semver ? ` (latest ${s.latest})` : ""}. ${draftLine(name, s.draft)}`,
      { name, action: "show", ...(s.production ? { production: s.production.semver } : {}), draft: draftView(s.draft) });
  });

  tool("skills", "polpo_skill_restore", {
    title: "Restore a version of a skill",
    description: "Put an older version of a skill back as its files (its whole folder), or bring back a deleted skill. publish: true makes it a new version "
      + "in production at once; publish: false leaves it in the draft (publish it later; to switch production without a new version use polpo_skill_rollback); "
      + "without it the instance setting decides (default: published). Needs confirm: true.",
    inputSchema: {
      name: z.string().min(1).describe("The skill's name"),
      version: versionRef.describe("The version to restore: 1.2.0 or its number (polpo_skill_versions)"),
      publish: z.boolean().optional().describe("true: publish at once; false: only the draft"),
      note: z.string().max(2000).optional().describe("Release note when published"),
      pool: poolParam,
      confirm: confirmParam("restore the version"),
    },
    outputSchema: { name: z.string(), restored_from: z.number(), version: z.number().optional(), published: z.string().optional(), draft: z.boolean() },
    annotations: DESTRUCTIVE,
  }, async ({ name, version, publish, note, pool, confirm }) => {
    if (confirm !== true) return fail(`Restoring version ${version} of ${name} replaces its current files (they stay in the history): ask the person, then call again with confirm: true.`);
    const r = await apiSend(deps, "POST", `${poolPath(pool)}/${enc(name)}/versions/${enc(String(version))}/restore`, { ...(publish !== undefined ? { publish } : {}), ...(note ? { note } : {}) });
    if (!r.ok) return r.status === 404 ? fail(`${r.error}. List the versions with polpo_skill_versions.`) : apiError(r, `Restoring version ${version} of ${name}`);
    const d = r.data as { restoredFrom: number; version?: SkillVersionItem; draft: boolean };
    return ok(d.version
      ? `Restored ${name} to version ${version}: it is now ${label(d.version)} in production.`
      : `Restored version ${version} of ${name} into its draft: production is unchanged. Publish it with polpo_skill_publish.`,
    { name, restored_from: d.restoredFrom, ...(d.version ? { version: d.version.version, published: label(d.version) } : {}), draft: d.draft });
  });
}

export function registerSkillTools(tool: Register, deps: McpDeps): void {
  tool("skills", "polpo_skills_list", {
    title: "List skills",
    description: "The skills in the pool: name, what it is for, where it lives (project or global), the agents it is assigned to, tags. "
      + "Filter by words, agent or category; read one with polpo_skill_get.",
    inputSchema: {
      text: z.string().optional().describe("Words in the name or description"),
      agent: z.string().optional().describe("Only skills assigned to this agent"),
      category: z.string().optional().describe("Only this category"),
      limit: limitParam(30, 200),
      cursor: cursorParam(),
    },
    outputSchema: pageOutput(skillItem),
    annotations: READ,
  }, async ({ text, agent, category, limit, cursor }) => {
    const r = await listSkills(deps);
    if (!r.ok) return apiError(r, "Listing skills");
    const words = (text ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    const all = r.skills
      .filter((s) => words.every((w) => `${s.name} ${s.description} ${(s.tags ?? []).join(" ")}`.toLowerCase().includes(w))
        && (!agent || (s.assignedTo ?? []).includes(agent)) && (!category || s.category === category))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(view);
    const p = page(all, limit ?? 30, cursor);
    if (!p) return fail(BAD_CURSOR);
    return ok(`${p.items.map((s) => `- ${s.name} (${s.source}${s.assigned_to.length ? `; ${s.assigned_to.join(", ")}` : "; unassigned"}): ${short(s.description, 140)}`).join("\n") || "No skills match."}`
      + `${p.next_cursor ? `\n(more: cursor ${p.next_cursor})` : ""}`, p);
  });

  tool("skills", "polpo_skill_get", {
    title: "Read a skill",
    description: "One skill in full: its description, the tools it expects, tags and its instructions (the SKILL.md body).",
    inputSchema: { name: z.string().min(1).describe("The skill's name") },
    outputSchema: { skill: looseObject },
    annotations: READ,
  }, async ({ name }) => {
    const r = await apiGet(deps, `/skills/${enc(name)}/content`);
    if (!r.ok) return r.status === 404 ? notFound(name) : apiError(r, `Reading skill ${name}`);
    const s = r.data as Skill & { path?: string; dir?: string };
    const { path: _path, dir: _dir, files: _files, filesTruncated: _t, ...skill } = s as Skill & { path?: string; dir?: string; files?: unknown; filesTruncated?: unknown };
    // its bundled files (scripts/, references/, assets/…): read one with polpo_skill_file_read
    const f = await apiGet(deps, `/skills/${enc(name)}/files`);
    const files = f.ok ? ((f.data as { files?: SkillFile[] }).files ?? []) : [];
    const bundled = files.filter((x) => x.path !== "SKILL.md");
    // its lifecycle: production (what agents run, and what this shows), the draft (polpo_skill_versions lists the versions)
    const h = await apiGet(deps, `/skills/${enc(name)}/versions`);
    const list = h.ok ? (h.data as VersionList) : undefined;
    const versions = list?.versions ?? [];
    const prod = versions.find((v) => v.version === list?.current) ?? versions[0];
    const draft = list?.state?.draft;
    return ok(`${s.name} (${s.source}): ${s.description}${s.allowedTools?.length ? `\ntools: ${s.allowedTools.join(", ")}` : ""}`
      + `${prod ? `\nversion: ${label(prod)} in production (${prod.createdAt.slice(0, 10)} by ${by(prod.author)}), ${versions.length} version${versions.length === 1 ? "" : "s"} (polpo_skill_versions)` : ""}`
      + `${draft?.hasChanges ? `\n${draftLine(s.name, draft)}` : ""}\n\n${s.content ?? ""}`
      + (bundled.length ? `\n\n---\nBundled files (read one with polpo_skill_file_read):\n${bundled.slice(0, 100).map((x) => `- ${x.path} (${size(x.size)})`).join("\n")}${bundled.length > 100 ? "\n- …" : ""}` : ""),
    { skill: { ...skill, files, versions: versions.length, ...(prod ? { current_version: prod.version, production: label(prod) } : {}), ...(draft ? { draft: draftView(draft) } : {}) } });
  });

  tool("skills", "polpo_skill_create", {
    title: "Create a skill",
    description: "Write a new skill: a name, when to use it (description) and its instructions (markdown). Assign it to agents with polpo_skill_assign.",
    inputSchema: {
      name: z.string().min(1).max(80).regex(SKILL_NAME, "letters, digits, '.', '_' and '-'").describe("A short unique name, e.g. weekly-report"),
      description: z.string().min(1).max(1000).describe("What it is for and when to use it (agents read this to decide)"),
      content: z.string().min(1).max(200_000).describe("The instructions, in markdown"),
      allowed_tools: z.array(z.string()).optional().describe("Tools it expects (informational)"),
      global: z.boolean().optional().describe("true: in the global pool (every project on this machine) instead of this project"),
      assign_to: z.array(z.string()).optional().describe("Agents to assign it to right away"),
    },
    outputSchema: { skill: skillItem },
    annotations: WRITE,
  }, async ({ name, description, content, allowed_tools, global, assign_to }) => {
    const missing = await unknownAgents(deps, assign_to ?? []);
    if (missing) return fail(missing);
    const r = await apiSend(deps, "POST", "/skills/create", { name, description, content, ...(allowed_tools ? { allowedTools: allowed_tools } : {}), ...(global ? { global } : {}) });
    if (!r.ok) return r.status === 409 ? fail(`There is already a skill "${name}": change it with polpo_skill_update, or choose another name.`) : apiError(r, `Creating skill ${name}`);
    for (const agent of assign_to ?? []) {
      const a = await apiSend(deps, "POST", `/skills/${enc(name)}/assign`, { agent });
      if (!a.ok) return apiError(a, `Assigning ${name} to ${agent}`, "The skill was created.");
    }
    return ok(`Created skill ${name}${assign_to?.length ? `, assigned to ${assign_to.join(", ")}` : ""}.`,
      { skill: { name, description, source: global ? "global" : "project", assigned_to: assign_to ?? [] } });
  });

  tool("skills", "polpo_skill_update", {
    title: "Update a skill",
    description: "Change a skill's description, instructions, expected tools, tags or category. Only the fields given change. "
      + "publish: true publishes the change at once as a new version in production (agents use it from their next run); publish: false only writes the "
      + "draft (publish it later with polpo_skill_publish); without it the instance setting decides (default: published at once, \"Applied directly\"). "
      + "bump, version and note apply to the published version. Tags and category are not versioned.",
    inputSchema: {
      name: z.string().min(1).describe("The skill's name"),
      description: z.string().min(1).max(1000).optional().describe("The new description"),
      content: z.string().min(1).max(200_000).optional().describe("The new instructions (replaces them all)"),
      allowed_tools: z.array(z.string()).optional().describe("The tools it expects"),
      tags: z.array(z.string()).optional().describe("Tags for search"),
      category: z.string().optional().describe("A category to group it"),
      publish: z.boolean().optional().describe("true: publish at once; false: only the draft"),
      bump: z.enum(["major", "minor", "patch"]).optional().describe("The bump when published (default: suggested)"),
      version: z.string().regex(/^\d+\.\d+\.\d+$/, "major.minor.patch").optional().describe("An explicit version when published"),
      note: z.string().max(2000).optional().describe("Release note when published"),
    },
    outputSchema: { skill: skillItem, changed: z.array(z.string()), mode: z.string().optional(), production: z.string().optional(), draft: draftItem.optional() },
    annotations: UPDATE,
  }, async ({ name, description, content, allowed_tools, tags, category, publish, bump, version, note }) => {
    const list = await listSkills(deps);
    if (!list.ok) return apiError(list, "Listing skills");
    const skill = list.skills.find((s) => s.name === name);
    if (!skill) return notFound(name);
    const changed: string[] = [];
    let versioning: ({ mode?: string } & Partial<SkillState>) | undefined;
    if (description !== undefined || content !== undefined || allowed_tools !== undefined) {
      const r = await apiSend(deps, "PUT", `/skills/${enc(name)}`, {
        ...(description !== undefined ? { description } : {}), ...(content !== undefined ? { content } : {}),
        ...(allowed_tools !== undefined ? { allowedTools: allowed_tools } : {}), ...(skill.source === "global" ? { global: true } : {}),
        ...(publish !== undefined ? { publish } : {}), ...(bump ? { bump } : {}), ...(version ? { version } : {}), ...(note ? { note } : {}),
      });
      if (!r.ok) {
        if (r.status === 409) return fail(`${r.error} (polpo_skill_draft).`);
        return r.status === 404 ? notFound(name) : apiError(r, `Updating skill ${name}`);
      }
      versioning = (r.data as { versioning?: { mode?: string } & Partial<SkillState> }).versioning;
      if (description !== undefined) changed.push("description");
      if (content !== undefined) changed.push("content");
      if (allowed_tools !== undefined) changed.push("allowedTools");
    }
    if (tags !== undefined || category !== undefined) {
      const r = await apiSend(deps, "PUT", `/skills/${enc(name)}/index`, { tags: tags ?? skill.tags ?? [], ...(category !== undefined ? { category } : skill.category ? { category: skill.category } : {}) });
      if (!r.ok) return apiError(r, `Updating ${name}'s tags`, changed.length ? `${changed.join(", ")} changed already.` : undefined);
      if (tags !== undefined) changed.push("tags");
      if (category !== undefined) changed.push("category");
    }
    if (changed.length === 0) return fail("Nothing to change: give description, content, allowed_tools, tags or category.");
    const prodLabel = versioning?.production?.semver;
    const where = !versioning?.mode ? ""
      : versioning.mode === "draft" ? ` Saved in the draft: production${prodLabel ? ` (${prodLabel})` : ""} is unchanged.${versioning.draft?.nextVersion ? ` Publishing would make ${versioning.draft.nextVersion}` : ""} (polpo_skill_publish).`
      : ` Published: production is ${prodLabel ?? "updated"}, agents use it from their next run.`;
    return ok(`Updated skill ${name}: ${changed.join(", ")}.${where}`, {
      skill: view({ ...skill, ...(description ? { description } : {}), ...(tags ? { tags } : {}), ...(category !== undefined ? { category } : {}) }), changed,
      ...(versioning?.mode ? { mode: versioning.mode } : {}), ...(prodLabel ? { production: prodLabel } : {}), ...(versioning?.draft ? { draft: draftView(versioning.draft) } : {}),
    });
  });

  tool("skills", "polpo_skill_install", {
    title: "Install skills",
    description: "Install skills from a source: a GitHub repository (owner/repo, or a URL, optionally /tree/<branch>/<path>) or a local path on the server. "
      + "It downloads them into the pool; the result lists what was installed and what failed. Assign them with polpo_skill_assign.",
    inputSchema: {
      source: z.string().min(1).describe("e.g. anthropics/skills, https://github.com/owner/repo, or a path on the server"),
      names: z.array(z.string()).optional().describe("Only these skills of the source (default: all)"),
      global: z.boolean().optional().describe("true: in the global pool instead of this project"),
      force: z.boolean().optional().describe("true: overwrite skills with the same name"),
    },
    outputSchema: { installed: z.array(z.string()), skipped: z.array(z.string()).optional(), errors: z.array(z.string()) },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ source, names, global, force }) => {
    const res = await deps.api("POST", "/api/v1/skills/add", { source, ...(names ? { skillNames: names } : {}), ...(global ? { global } : {}), ...(force ? { force } : {}) });
    const body = res.body as { ok?: boolean; data?: { installed?: Array<string | { name: string }>; skipped?: Array<string | { name: string }>; errors?: Array<string | { name?: string; error?: string }> }; error?: string } | null;
    const nameOf = (x: string | { name?: string; error?: string }) => typeof x === "string" ? x : x.name ?? x.error ?? JSON.stringify(x);
    const installed = (body?.data?.installed ?? []).map(nameOf);
    const skipped = (body?.data?.skipped ?? []).map(nameOf);
    const errors = (body?.data?.errors ?? []).map((e) => typeof e === "string" ? e : `${e.name ?? ""}${e.error ? `: ${e.error}` : ""}`);
    if (res.status >= 400 && installed.length === 0) return fail(`Nothing was installed from ${source}: ${errors.join("; ") || body?.error || `HTTP ${res.status}`}. Check the source (owner/repo or URL).`);
    return ok(`Installed ${installed.length ? installed.join(", ") : "nothing"} from ${source}.${skipped.length ? ` Skipped (already there; force: true overwrites): ${skipped.join(", ")}.` : ""}${errors.length ? ` Errors: ${errors.join("; ")}.` : ""}`,
      { installed, ...(skipped.length ? { skipped } : {}), errors });
  });

  tool("skills", "polpo_skill_delete", {
    title: "Delete a skill",
    description: "Remove a skill from the pool (agents that had it lose it). Its history is kept for a while (30 days by default): polpo_skill_restore brings it back. Needs confirm: true.",
    inputSchema: { name: z.string().min(1).describe("The skill's name"), confirm: confirmParam("delete the skill") },
    outputSchema: { name: z.string(), removed: z.boolean() },
    annotations: DESTRUCTIVE,
  }, async ({ name, confirm }) => {
    const list = await listSkills(deps);
    if (!list.ok) return apiError(list, "Listing skills");
    const skill = list.skills.find((s) => s.name === name);
    if (!skill) return notFound(name);
    if (confirm !== true) return fail(`Deleting skill ${name}${skill.assignedTo?.length ? ` (used by ${skill.assignedTo.join(", ")})` : ""} takes it from its agents (its versions are kept, so it can be restored): ask the person, then call again with confirm: true.`);
    const r = await apiSend(deps, "DELETE", `/skills/${enc(name)}${skill.source === "global" ? "?global=true" : ""}`);
    if (!r.ok) return apiError(r, `Deleting skill ${name}`);
    return ok(`Deleted skill ${name}.`, { name, removed: true });
  });

  tool("skills", "polpo_skill_assign", {
    title: "Assign or unassign a skill",
    description: "Give a skill to agents (assign) or take it away (unassign). The agents use it from their next run.",
    inputSchema: {
      name: z.string().min(1).describe("The skill's name"),
      agents: z.array(z.string().min(1)).min(1).describe("The agents (polpo_agents_list)"),
      action: z.enum(["assign", "unassign"]).optional().describe("assign (default) or unassign"),
    },
    outputSchema: { name: z.string(), action: z.string(), agents: z.array(z.string()), assigned_to: z.array(z.string()) },
    annotations: UPDATE,
  }, async ({ name, agents, action }) => {
    const act = action ?? "assign";
    const missing = await unknownAgents(deps, agents);
    if (missing) return fail(missing);
    const list = await listSkills(deps);
    if (!list.ok) return apiError(list, "Listing skills");
    const skill = list.skills.find((s) => s.name === name);
    if (!skill) return notFound(name);
    const done: string[] = [];
    for (const agent of agents) {
      const has = (skill.assignedTo ?? []).includes(agent);
      if ((act === "assign") === has) continue;
      const r = await apiSend(deps, "POST", `/skills/${enc(name)}/${act}`, { agent });
      if (!r.ok) return apiError(r, `${act === "assign" ? "Assigning" : "Unassigning"} ${name} ${act === "assign" ? "to" : "from"} ${agent}`, done.length ? `Done already: ${done.join(", ")}.` : undefined);
      done.push(agent);
    }
    const after = await listSkills(deps);
    const assigned = (after.ok ? after.skills.find((s) => s.name === name)?.assignedTo : undefined) ?? [];
    return ok(done.length ? `${act === "assign" ? "Assigned" : "Unassigned"} ${name} ${act === "assign" ? "to" : "from"} ${done.join(", ")}. Now used by: ${assigned.join(", ") || "nobody"}.`
      : `Nothing changed: ${name} was already ${act === "assign" ? "assigned to" : "not assigned to"} ${agents.join(", ")}.`, { name, action: act, agents: done, assigned_to: assigned });
  });

  registerSkillBundleTools(tool, deps);
  registerSkillVersionTools(tool, deps);
}
