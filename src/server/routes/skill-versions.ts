/**
 * Skill versions over REST: a skill's lifecycle like an agent's — the draft (its folder), semver
 * versions, the production pointer agents run, publish (bump + note), rollback, discard and rebase
 * of the draft, diffs (draft vs production, between versions), a version's files, restore into the
 * draft, and a version as a `.skill` archive. For agents' skills (/skills/{name}/…) and the
 * orchestrator's (/skills/orchestrator/{name}/…). A deleted skill keeps its history for a grace
 * period: these routes work for it too (restore brings it back).
 */
import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import { readFileSync } from "node:fs";
import { basename, posix } from "node:path";
import { findSkillDir, type SkillPool } from "../../llm/skills.js";
import { SkillBundleError, skillFileContentType } from "../../llm/skill-bundle.js";
import {
  SKILL_VERSION_RETENTION, SkillVersionError, diffSkillRefs, discardSkillDraft, hasSkillVersions, listSkillVersionFiles, listSkillVersions,
  publishSkillDraft, rebaseSkillDraft, resolveSkillVersionFile, restoreSkillVersion, rollbackSkill, skillVersionLabel, skillVersionState, zipSkillVersion,
  type SkillRef, type SkillVersionMode,
} from "../../llm/skill-versions.js";

export interface SkillVersionDeps {
  polpoDir: string;
  workDir: string;
  /** Who makes the request ("person:<email>", an agent, "polpo", "mcp:<client>"). */
  author?: (c: Context) => string;
  /** settings.skills.versioning.autoPublishApiUpdates (default true). */
  autoPublish?: () => boolean;
  emit: (event: "skill:changed", data: { scope: "agent" | "orchestrator"; action: "created" | "updated"; skillName?: string; timestamp: string }) => void;
}

const errorSchema = z.object({ ok: z.boolean(), error: z.string(), code: z.string().optional() });
const okAny = z.object({ ok: z.boolean(), data: z.any() });
const json = (schema: z.ZodTypeAny, description: string) => ({ content: { "application/json": { schema } }, description });
const body = (schema: z.ZodTypeAny) => ({ content: { "application/json": { schema } }, required: false });
const scopeQuery = z.object({ scope: z.enum(["project", "global"]).optional().describe("project or global (default: where the skill is, or where its history is)") });
const VERSION_DOC = "a version: its semver (1.2.0), its number (3), production or latest";

export function registerSkillVersionRoutes(app: OpenAPIHono, getDeps: () => SkillVersionDeps): void {
  const fail = (c: Context, status: 400 | 404 | 409, error: string, code: string) => c.json({ ok: false, error, code }, status);
  const now = () => new Date().toISOString();

  for (const pool of ["orchestrator", "agent"] as const satisfies readonly SkillPool[]) {
    const prefix = pool === "orchestrator" ? "/orchestrator" : "";
    const what = pool === "orchestrator" ? "an orchestrator skill" : "a skill";
    const authorOf = (c: Context) => getDeps().author?.(c) ?? "person:dashboard";

    /** The skill's history: where the skill is, else where a history of the name is (a deleted skill). */
    const refFor = (c: Context): SkillRef | Response => {
      const deps = getDeps();
      const name = c.req.param("name")!;
      if (!/^[A-Za-z0-9._-]+$/.test(name) || name === "." || name === ".." || name === ".production") return fail(c, 400, `Invalid skill name "${name}"`, "INVALID_NAME");
      const scope = c.req.query("scope");
      if (scope === "project" || scope === "global") return { pool, global: scope === "global", name };
      const info = findSkillDir(deps.workDir, deps.polpoDir, name, pool);
      if (info) return { pool, global: info.source === "global", name: basename(info.path) };
      for (const global of [false, true]) if (hasSkillVersions(deps.polpoDir, { pool, global, name })) return { pool, global, name };
      return fail(c, 404, `Skill "${name}" not found, and it has no history`, "NOT_FOUND");
    };
    /** A version ref: a number, a semver, production or latest. */
    const ver = (c: Context, key: string): string | number | Response => {
      const raw = (c.req.param(key) ?? "").trim();
      if (/^\d+$/.test(raw) && Number(raw) > 0) return Number(raw);
      if (/^v?\d+\.\d+\.\d+$/.test(raw) || raw === "production" || raw === "latest") return raw.replace(/^v/, "");
      return fail(c, 400, `Invalid version "${raw}" (${VERSION_DOC})`, "INVALID_VERSION");
    };
    const guard = (c: Context, fn: () => Response | Promise<Response>) => {
      try { return fn(); } catch (err) {
        if (err instanceof SkillVersionError) {
          const status = err.code === "INVALID" || err.code === "NO_CHANGES" ? 400 : err.code === "CONFLICT" ? 409 : 404;
          return fail(c, status, err.message, err.code);
        }
        if (err instanceof SkillBundleError) return c.json({ ok: false, error: err.message, code: err.code }, 413);
        throw err;
      }
    };
    const changed = (name: string, action: "created" | "updated" = "updated") => getDeps().emit("skill:changed", { scope: pool, action, skillName: name, timestamp: now() });
    const stateOf = (ref: SkillRef) => skillVersionState(getDeps().polpoDir, ref);

    // ── GET {name}/versions ──
    app.openapi(createRoute({
      method: "get",
      path: `${prefix}/{name}/versions`,
      tags: ["Skills"],
      summary: `List ${what}'s versions`,
      description: "The skill's lifecycle: its versions, newest first (semver, number, date, author, source, release note, the version it was "
        + "edited from, file count, size, SKILL.md's name and description at that time), `production` (what agents run; `current` is its "
        + "number), `state` (the draft: has changes, external changes made on disk, stale, suggested bump) and `events` (publishes, "
        + "rollbacks, discards with who and when). A deleted skill's history is kept for a grace period (`deletedAt`) and can be restored.",
      request: { params: z.object({ name: z.string() }), query: scopeQuery },
      responses: { 200: json(okAny, "The versions"), 400: json(errorSchema, "Invalid name"), 404: json(errorSchema, "No such skill or history") },
    }), ((c: Context) => guard(c, () => {
      const ref = refFor(c);
      if (ref instanceof Response) return ref;
      const h = listSkillVersions(getDeps().polpoDir, ref);
      const state = h ? stateOf(ref) : undefined;
      return c.json({
        ok: true,
        data: {
          name: ref.name, pool, scope: ref.global ? "global" : "project",
          versions: h?.versions ?? [], ...(h?.current ? { current: h.current } : {}),
          ...(state?.production ? { production: state.production.semver } : {}),
          ...(state?.latest ? { latest: state.latest } : {}),
          ...(state ? { state } : {}),
          events: h?.events ?? [],
          ...(h?.deletedAt ? { deletedAt: h.deletedAt, ...(h.deletedBy ? { deletedBy: h.deletedBy } : {}) } : {}),
          retention: { maxVersions: SKILL_VERSION_RETENTION.maxVersions, maxBytes: SKILL_VERSION_RETENTION.maxBytes, deletedDays: SKILL_VERSION_RETENTION.deletedDays },
        },
      }, 200);
    })) as any);

    // ── GET {name}/versioning ──
    app.openapi(createRoute({
      method: "get",
      path: `${prefix}/{name}/versioning`,
      tags: ["Skills"],
      summary: `The lifecycle state of ${what}`,
      description: "Production (the version agents run), the latest version, and the draft: whether the skill's folder differs from production "
        + "(`hasChanges`), which files, whether files were changed outside Polpo (`external`), whether production moved away from the draft's "
        + "base (`stale`, with `warning`), and the suggested bump and next version.",
      request: { params: z.object({ name: z.string() }), query: scopeQuery },
      responses: { 200: json(okAny, "The state"), 404: json(errorSchema, "No such skill") },
    }), ((c: Context) => guard(c, () => {
      const ref = refFor(c);
      if (ref instanceof Response) return ref;
      const state = stateOf(ref);
      if (!state) return fail(c, 404, `Skill "${ref.name}" not found`, "NOT_FOUND");
      return c.json({ ok: true, data: state }, 200);
    })) as any);

    // ── POST {name}/publish ──
    app.openapi(createRoute({
      method: "post",
      path: `${prefix}/{name}/publish`,
      tags: ["Skills"],
      summary: `Publish ${what}'s draft`,
      description: "The skill's folder (its draft: dashboard edits, restores, files changed on disk) becomes a new version and production "
        + "points at it: agents run it from their next run. The number is the highest version bumped by `bump` (default: suggested — major "
        + "when files are removed or the skill renamed, minor when files are added or the description or expected tools change, patch "
        + "otherwise) or an explicit `version`. `409` when the draft is stale (rebase or discard it), `400` NO_CHANGES when the draft equals production.",
      request: {
        params: z.object({ name: z.string() }), query: scopeQuery,
        body: body(z.object({
          bump: z.enum(["major", "minor", "patch"]).optional(),
          version: z.string().optional().describe("An explicit semver, above the latest"),
          note: z.string().max(2000).optional().describe("The release note"),
        })),
      },
      responses: { 200: json(okAny, "Published: the version and the state"), 400: json(errorSchema, "No changes or invalid version"), 404: json(errorSchema, "No such skill"), 409: json(errorSchema, "Stale draft or version taken") },
    }), (async (c: Context) => {
      const b = (await c.req.json().catch(() => ({}))) as { bump?: "major" | "minor" | "patch"; version?: string; note?: string };
      return guard(c, () => {
        const ref = refFor(c);
        if (ref instanceof Response) return ref;
        const version = publishSkillDraft(getDeps().polpoDir, ref, { actor: authorOf(c), ...(b.bump ? { bump: b.bump } : {}), ...(b.version ? { version: b.version } : {}), ...(b.note ? { note: b.note } : {}) });
        changed(ref.name);
        return c.json({ ok: true, data: { name: ref.name, version, state: stateOf(ref) } }, 200);
      });
    }) as any);

    // ── POST {name}/rollback ──
    app.openapi(createRoute({
      method: "post",
      path: `${prefix}/{name}/rollback`,
      tags: ["Skills"],
      summary: `Roll ${what}'s production back`,
      description: "Production points at an earlier version: `to` (semver or number), or the one production ran before the publish that brought "
        + "the current one (repeated rollbacks walk back). Agents run it from their next run. The skill's folder follows when it had no draft "
        + "changes; a pending draft is kept and becomes stale (rebase or discard it).",
      request: {
        params: z.object({ name: z.string() }), query: scopeQuery,
        body: body(z.object({ to: z.union([z.string(), z.number()]).optional(), note: z.string().max(2000).optional() })),
      },
      responses: { 200: json(okAny, "Rolled back"), 400: json(errorSchema, "Already there"), 404: json(errorSchema, "No such skill or version") },
    }), (async (c: Context) => {
      const b = (await c.req.json().catch(() => ({}))) as { to?: string | number; note?: string };
      return guard(c, () => {
        const ref = refFor(c);
        if (ref instanceof Response) return ref;
        const r = rollbackSkill(getDeps().polpoDir, ref, { actor: authorOf(c), ...(b.to !== undefined ? { to: b.to } : {}), ...(b.note ? { note: b.note } : {}) });
        changed(ref.name);
        return c.json({ ok: true, data: { name: ref.name, from: r.from, to: r.to, folderReset: r.folderReset, event: r.event, state: stateOf(ref) } }, 200);
      });
    }) as any);

    // ── DELETE {name}/draft ──
    app.openapi(createRoute({
      method: "delete",
      path: `${prefix}/{name}/draft`,
      tags: ["Skills"],
      summary: `Discard ${what}'s draft`,
      description: "The skill's folder becomes production's files again: pending edits and files changed on disk are dropped (production is unchanged).",
      request: { params: z.object({ name: z.string() }), query: scopeQuery },
      responses: { 200: json(okAny, "Discarded"), 404: json(errorSchema, "No such skill") },
    }), ((c: Context) => guard(c, () => {
      const ref = refFor(c);
      if (ref instanceof Response) return ref;
      const discarded = discardSkillDraft(getDeps().polpoDir, ref, authorOf(c));
      if (discarded) changed(ref.name);
      return c.json({ ok: true, data: { name: ref.name, discarded, state: stateOf(ref) } }, 200);
    })) as any);

    // ── POST {name}/draft/rebase ──
    app.openapi(createRoute({
      method: "post",
      path: `${prefix}/{name}/draft/rebase`,
      tags: ["Skills"],
      summary: `Rebase ${what}'s stale draft onto production`,
      description: "File by file: a file the draft changed (against the version it started from) keeps the draft's content, every other file "
        + "becomes production's. Nothing left to change: the draft goes (`dropped`).",
      request: { params: z.object({ name: z.string() }), query: scopeQuery },
      responses: { 200: json(okAny, "Rebased"), 404: json(errorSchema, "No such skill or draft") },
    }), ((c: Context) => guard(c, () => {
      const ref = refFor(c);
      if (ref instanceof Response) return ref;
      const r = rebaseSkillDraft(getDeps().polpoDir, ref, authorOf(c));
      changed(ref.name);
      return c.json({ ok: true, data: { name: ref.name, ...r, state: stateOf(ref) } }, 200);
    })) as any);

    // ── GET {name}/diff?from=&to= ──
    app.openapi(createRoute({
      method: "get",
      path: `${prefix}/{name}/diff`,
      tags: ["Skills"],
      summary: `Compare two sides of ${what}`,
      description: `Files added, removed and changed from \`from\` to \`to\` (each "draft" or ${VERSION_DOC}), with unified diffs of text files. `
        + "Default: production → draft (what publishing would change).",
      request: { params: z.object({ name: z.string() }), query: z.object({ from: z.string().optional(), to: z.string().optional(), scope: z.enum(["project", "global"]).optional() }) },
      responses: { 200: json(okAny, "The diff"), 404: json(errorSchema, "No such skill or version") },
    }), ((c: Context) => guard(c, () => {
      const ref = refFor(c);
      if (ref instanceof Response) return ref;
      const side = (v: string | undefined, dflt: string): string | number => {
        const s = (v ?? dflt).trim();
        return /^\d+$/.test(s) ? Number(s) : s.replace(/^v(?=\d+\.\d+\.\d+$)/, "");
      };
      return c.json({ ok: true, data: diffSkillRefs(getDeps().polpoDir, ref, side(c.req.query("from"), "production"), side(c.req.query("to"), "draft")) }, 200);
    })) as any);

    // ── GET {name}/versions/{version}/files ──
    app.openapi(createRoute({
      method: "get",
      path: `${prefix}/{name}/versions/{version}/files`,
      tags: ["Skills"],
      summary: `List the files of a version of ${what}`,
      description: `\`version\`: ${VERSION_DOC}.`,
      request: { params: z.object({ name: z.string(), version: z.string() }), query: scopeQuery },
      responses: { 200: json(okAny, "The files"), 400: json(errorSchema, "Invalid name or version"), 404: json(errorSchema, "No such version") },
    }), ((c: Context) => guard(c, () => {
      const ref = refFor(c);
      if (ref instanceof Response) return ref;
      const n = ver(c, "version");
      if (n instanceof Response) return n;
      const v = listSkillVersionFiles(getDeps().polpoDir, ref, n);
      return c.json({ ok: true, data: { name: ref.name, version: v.version, files: v.files, totalBytes: v.totalBytes, truncated: false } }, 200);
    })) as any);

    const readFile = (c: Context, rel: string) => guard(c, () => {
      const ref = refFor(c);
      if (ref instanceof Response) return ref;
      const n = ver(c, "version");
      if (n instanceof Response) return n;
      const abs = resolveSkillVersionFile(getDeps().polpoDir, ref, n, rel);
      if (!abs) return fail(c, 404, `"${rel}" is not a file of version ${n} of skill "${ref.name}"`, "NOT_FOUND");
      const bytes = readFileSync(abs);
      const type = skillFileContentType(rel, bytes);
      const download = c.req.query("download") === "1" || c.req.query("download") === "true";
      const headers: Record<string, string> = {
        "Content-Type": type,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-store",
        "Content-Disposition": `${download ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(posix.basename(rel))}`,
      };
      if (!type.startsWith("application/pdf")) headers["Content-Security-Policy"] = "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'";
      if (!download && /^text\/html/.test(type)) headers["Content-Type"] = "text/plain; charset=utf-8";
      return new Response(bytes, { status: 200, headers });
    });

    // ── GET {name}/versions/{version}/files/{path} (encoded or literal slashes) ──
    app.openapi(createRoute({
      method: "get",
      path: `${prefix}/{name}/versions/{version}/files/{path}`,
      tags: ["Skills"],
      summary: `Read a file of a version of ${what}`,
      description: "The raw file of that version with its content type (text as UTF-8); slashes literal or encoded; ?download=1 as an attachment. "
        + "Paths outside the version's folder are refused.",
      request: { params: z.object({ name: z.string(), version: z.string(), path: z.string() }), query: z.object({ download: z.string().optional(), scope: z.enum(["project", "global"]).optional() }) },
      responses: {
        200: { description: "The file", content: { "application/octet-stream": { schema: z.any() } } },
        404: json(errorSchema, "No such version or file"),
      },
    }), ((c: Context) => readFile(c, c.req.param("path")!)) as any);
    app.get(`${prefix}/:name/versions/:version/files/*`, (c) => {
      const marker = `/${encodeURIComponent(c.req.param("name"))}/versions/${encodeURIComponent(c.req.param("version"))}/files/`;
      const raw = c.req.path;
      const at = raw.indexOf(marker);
      const rel = at >= 0 ? raw.slice(at + marker.length) : "";
      let decoded: string;
      try { decoded = rel.split("/").map(decodeURIComponent).join("/"); } catch { return fail(c, 404, "Invalid path", "NOT_FOUND"); }
      return readFile(c, decoded);
    });

    // ── GET {name}/versions/{a}/diff/{b} ──
    app.openapi(createRoute({
      method: "get",
      path: `${prefix}/{name}/versions/{a}/diff/{b}`,
      tags: ["Skills"],
      summary: `Compare two versions of ${what}`,
      description: "Files added, removed and changed from version a to version b, with a unified diff for text files (binary files are only "
        + `named; files over 512 KB, or diffs past the size cap, are marked truncated). a and b: ${VERSION_DOC}, or draft.`,
      request: { params: z.object({ name: z.string(), a: z.string(), b: z.string() }), query: scopeQuery },
      responses: { 200: json(okAny, "The diff"), 400: json(errorSchema, "Invalid name or version"), 404: json(errorSchema, "No such version") },
    }), ((c: Context) => guard(c, () => {
      const ref = refFor(c);
      if (ref instanceof Response) return ref;
      const a = c.req.param("a") === "draft" ? "draft" : ver(c, "a");
      if (a instanceof Response) return a;
      const b = c.req.param("b") === "draft" ? "draft" : ver(c, "b");
      if (b instanceof Response) return b;
      return c.json({ ok: true, data: diffSkillRefs(getDeps().polpoDir, ref, a, b) }, 200);
    })) as any);

    // ── POST {name}/versions/{version}/restore ──
    app.openapi(createRoute({
      method: "post",
      path: `${prefix}/{name}/versions/{version}/restore`,
      tags: ["Skills"],
      summary: `Restore a version of ${what}`,
      description: "Put that version's files back as the skill's folder (recreating a deleted skill, which is always published). "
        + "`publish: false` (what the dashboard sends) leaves the restore in the draft — publish it, or roll production back instead; "
        + "`publish: true` publishes it at once as a new version; absent, settings.skills.versioning.autoPublishApiUpdates decides (default: published).",
      request: {
        params: z.object({ name: z.string(), version: z.string() }), query: scopeQuery,
        body: body(z.object({ publish: z.boolean().optional(), note: z.string().max(2000).optional(), bump: z.enum(["major", "minor", "patch"]).optional() })),
      },
      responses: { 200: json(okAny, "Restored: the version published, or the draft"), 400: json(errorSchema, "Invalid name or version"), 404: json(errorSchema, "No such version"), 409: json(errorSchema, "Stale draft") },
    }), (async (c: Context) => {
      const b = (await c.req.json().catch(() => ({}))) as { publish?: boolean; note?: string; bump?: "major" | "minor" | "patch" };
      return guard(c, () => {
        const deps = getDeps();
        const ref = refFor(c);
        if (ref instanceof Response) return ref;
        const n = ver(c, "version");
        if (n instanceof Response) return n;
        const wasDeleted = !!listSkillVersions(deps.polpoDir, ref)?.deletedAt;
        const mode: SkillVersionMode = (b.publish ?? deps.autoPublish?.() ?? true) ? "publish" : "draft";
        const r = restoreSkillVersion(deps.polpoDir, ref, n, authorOf(c), { mode, ...(b.note ? { note: b.note } : {}), ...(b.bump ? { bump: b.bump } : {}) });
        changed(ref.name, wasDeleted ? "created" : "updated");
        return c.json({
          ok: true,
          data: {
            name: ref.name, restoredFrom: r.restoredFrom, mode, draft: r.draft,
            ...(r.published ? { version: r.published, published: skillVersionLabel(r.published) } : {}),
            state: stateOf(ref),
          },
        }, 200);
      });
    }) as any);

    // ── GET {name}/versions/{version}/download ──
    app.openapi(createRoute({
      method: "get",
      path: `${prefix}/{name}/versions/{version}/download`,
      tags: ["Skills"],
      summary: `Download a version of ${what}`,
      description: "That version's folder as an archive (`.skill`, or `.zip` with format=zip), ready to upload elsewhere.",
      request: { params: z.object({ name: z.string(), version: z.string() }), query: z.object({ format: z.enum(["skill", "zip"]).optional(), scope: z.enum(["project", "global"]).optional() }) },
      responses: {
        200: { description: "The archive", content: { "application/zip": { schema: z.any() } } },
        404: json(errorSchema, "No such version"),
      },
    }), ((c: Context) => guard(c, () => {
      const ref = refFor(c);
      if (ref instanceof Response) return ref;
      const n = ver(c, "version");
      if (n instanceof Response) return n;
      const files = listSkillVersionFiles(getDeps().polpoDir, ref, n);
      const zip = zipSkillVersion(getDeps().polpoDir, ref, n);
      const ext = c.req.query("format") === "zip" ? "zip" : "skill";
      return new Response(new Uint8Array(zip), {
        status: 200,
        headers: {
          "Content-Type": "application/zip",
          "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(`${ref.name}-${files.version.semver ?? `v${files.version.version}`}.${ext}`)}`,
          "Cache-Control": "no-store",
        },
      });
    })) as any);
  }
}
