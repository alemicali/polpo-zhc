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
    return ok(`${s.name} (${s.source}): ${s.description}${s.allowedTools?.length ? `\ntools: ${s.allowedTools.join(", ")}` : ""}\n\n${s.content ?? ""}`
      + (bundled.length ? `\n\n---\nBundled files (read one with polpo_skill_file_read):\n${bundled.slice(0, 100).map((x) => `- ${x.path} (${size(x.size)})`).join("\n")}${bundled.length > 100 ? "\n- …" : ""}` : ""),
    { skill: { ...skill, files } });
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
    description: "Change a skill's description, instructions, expected tools, tags or category. Only the fields given change; agents use the new version from their next run.",
    inputSchema: {
      name: z.string().min(1).describe("The skill's name"),
      description: z.string().min(1).max(1000).optional().describe("The new description"),
      content: z.string().min(1).max(200_000).optional().describe("The new instructions (replaces them all)"),
      allowed_tools: z.array(z.string()).optional().describe("The tools it expects"),
      tags: z.array(z.string()).optional().describe("Tags for search"),
      category: z.string().optional().describe("A category to group it"),
    },
    outputSchema: { skill: skillItem, changed: z.array(z.string()) },
    annotations: UPDATE,
  }, async ({ name, description, content, allowed_tools, tags, category }) => {
    const list = await listSkills(deps);
    if (!list.ok) return apiError(list, "Listing skills");
    const skill = list.skills.find((s) => s.name === name);
    if (!skill) return notFound(name);
    const changed: string[] = [];
    if (description !== undefined || content !== undefined || allowed_tools !== undefined) {
      const r = await apiSend(deps, "PUT", `/skills/${enc(name)}`, {
        ...(description !== undefined ? { description } : {}), ...(content !== undefined ? { content } : {}),
        ...(allowed_tools !== undefined ? { allowedTools: allowed_tools } : {}), ...(skill.source === "global" ? { global: true } : {}),
      });
      if (!r.ok) return r.status === 404 ? notFound(name) : apiError(r, `Updating skill ${name}`);
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
    return ok(`Updated skill ${name}: ${changed.join(", ")}.`, {
      skill: view({ ...skill, ...(description ? { description } : {}), ...(tags ? { tags } : {}), ...(category !== undefined ? { category } : {}) }), changed,
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
    description: "Remove a skill from the pool (agents that had it lose it). It cannot be undone. Needs confirm: true.",
    inputSchema: { name: z.string().min(1).describe("The skill's name"), confirm: confirmParam("delete the skill") },
    outputSchema: { name: z.string(), removed: z.boolean() },
    annotations: DESTRUCTIVE,
  }, async ({ name, confirm }) => {
    const list = await listSkills(deps);
    if (!list.ok) return apiError(list, "Listing skills");
    const skill = list.skills.find((s) => s.name === name);
    if (!skill) return notFound(name);
    if (confirm !== true) return fail(`Deleting skill ${name}${skill.assignedTo?.length ? ` (used by ${skill.assignedTo.join(", ")})` : ""} cannot be undone: ask the person, then call again with confirm: true.`);
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
}
