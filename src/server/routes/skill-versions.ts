/**
 * Skill versions over REST: a skill's history (every change recorded as a copy of the whole folder),
 * a version's files, the diff between two versions, restore, and a version as a `.skill` archive.
 * For agents' skills (/skills/{name}/versions…) and the orchestrator's (/skills/orchestrator/{name}/versions…).
 * A deleted skill keeps its history for a grace period: these routes work for it too (restore brings it back).
 */
import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import { readFileSync } from "node:fs";
import { basename, posix } from "node:path";
import { findSkillDir, type SkillPool } from "../../llm/skills.js";
import { SkillBundleError, skillFileContentType } from "../../llm/skill-bundle.js";
import {
  SKILL_VERSION_RETENTION, SkillVersionError, diffSkillVersions, hasSkillVersions, listSkillVersionFiles, listSkillVersions,
  resolveSkillVersionFile, restoreSkillVersion, zipSkillVersion, type SkillRef,
} from "../../llm/skill-versions.js";

export interface SkillVersionDeps {
  polpoDir: string;
  workDir: string;
  /** Who makes the request ("person:<email>", an agent, "polpo", "mcp:<client>"). */
  author?: (c: Context) => string;
  emit: (event: "skill:changed", data: { scope: "agent" | "orchestrator"; action: "created" | "updated"; skillName?: string; timestamp: string }) => void;
}

const errorSchema = z.object({ ok: z.boolean(), error: z.string(), code: z.string().optional() });
const okAny = z.object({ ok: z.boolean(), data: z.any() });
const json = (schema: z.ZodTypeAny, description: string) => ({ content: { "application/json": { schema } }, description });
const scopeQuery = z.object({ scope: z.enum(["project", "global"]).optional().describe("project or global (default: where the skill is, or where its history is)") });

export function registerSkillVersionRoutes(app: OpenAPIHono, getDeps: () => SkillVersionDeps): void {
  const fail = (c: Context, status: 400 | 404, error: string, code: string) => c.json({ ok: false, error, code }, status);

  for (const pool of ["orchestrator", "agent"] as const satisfies readonly SkillPool[]) {
    const prefix = pool === "orchestrator" ? "/orchestrator" : "";
    const what = pool === "orchestrator" ? "an orchestrator skill" : "a skill";

    /** The skill's history: where the skill is, else where a history of the name is (a deleted skill). */
    const refFor = (c: Context): SkillRef | Response => {
      const deps = getDeps();
      const name = c.req.param("name")!;
      if (!/^[A-Za-z0-9._-]+$/.test(name) || name === "." || name === "..") return fail(c, 400, `Invalid skill name "${name}"`, "INVALID_NAME");
      const scope = c.req.query("scope");
      if (scope === "project" || scope === "global") return { pool, global: scope === "global", name };
      const info = findSkillDir(deps.workDir, deps.polpoDir, name, pool);
      if (info) return { pool, global: info.source === "global", name: basename(info.path) };
      for (const global of [false, true]) if (hasSkillVersions(deps.polpoDir, { pool, global, name })) return { pool, global, name };
      return fail(c, 404, `Skill "${name}" not found, and it has no history`, "NOT_FOUND");
    };
    const num = (c: Context, key: string): number | Response => {
      const n = Number(c.req.param(key));
      return Number.isInteger(n) && n > 0 ? n : fail(c, 400, `Invalid version "${c.req.param(key)}"`, "INVALID_VERSION");
    };
    const guard = (c: Context, fn: () => Response | Promise<Response>) => {
      try { return fn(); } catch (err) {
        if (err instanceof SkillVersionError) return fail(c, err.code === "INVALID" ? 400 : 404, err.message, err.code);
        if (err instanceof SkillBundleError) return c.json({ ok: false, error: err.message, code: err.code }, 413);
        throw err;
      }
    };

    // ── GET {name}/versions ──
    app.openapi(createRoute({
      method: "get",
      path: `${prefix}/{name}/versions`,
      tags: ["Skills"],
      summary: `List ${what}'s versions`,
      description: "The skill's history, newest first: every change Polpo made to it (create, edit, upload, git or local install, restore) "
        + "with its number, date, author, source, file count, size and SKILL.md's name and description at that time. The current state is the "
        + "latest version (`current`); a deleted skill's history is kept for a grace period (`deletedAt`) and can be restored.",
      request: { params: z.object({ name: z.string() }), query: scopeQuery },
      responses: { 200: json(okAny, "The versions"), 400: json(errorSchema, "Invalid name"), 404: json(errorSchema, "No such skill or history") },
    }), ((c: Context) => guard(c, () => {
      const ref = refFor(c);
      if (ref instanceof Response) return ref;
      const h = listSkillVersions(getDeps().polpoDir, ref);
      return c.json({
        ok: true,
        data: {
          name: ref.name, pool, scope: ref.global ? "global" : "project",
          versions: h?.versions ?? [], ...(h?.current ? { current: h.current } : {}),
          ...(h?.deletedAt ? { deletedAt: h.deletedAt, ...(h.deletedBy ? { deletedBy: h.deletedBy } : {}) } : {}),
          retention: { maxVersions: SKILL_VERSION_RETENTION.maxVersions, maxBytes: SKILL_VERSION_RETENTION.maxBytes, deletedDays: SKILL_VERSION_RETENTION.deletedDays },
        },
      }, 200);
    })) as any);

    // ── GET {name}/versions/{version}/files ──
    app.openapi(createRoute({
      method: "get",
      path: `${prefix}/{name}/versions/{version}/files`,
      tags: ["Skills"],
      summary: `List the files of a version of ${what}`,
      request: { params: z.object({ name: z.string(), version: z.string() }), query: scopeQuery },
      responses: { 200: json(okAny, "The files"), 400: json(errorSchema, "Invalid name or version"), 404: json(errorSchema, "No such version") },
    }), ((c: Context) => guard(c, () => {
      const ref = refFor(c);
      if (ref instanceof Response) return ref;
      const n = num(c, "version");
      if (n instanceof Response) return n;
      const v = listSkillVersionFiles(getDeps().polpoDir, ref, n);
      return c.json({ ok: true, data: { name: ref.name, version: v.version, files: v.files, totalBytes: v.totalBytes, truncated: false } }, 200);
    })) as any);

    const readFile = (c: Context, rel: string) => guard(c, () => {
      const ref = refFor(c);
      if (ref instanceof Response) return ref;
      const n = num(c, "version");
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
        + "named; files over 512 KB, or diffs past the size cap, are marked truncated).",
      request: { params: z.object({ name: z.string(), a: z.string(), b: z.string() }), query: scopeQuery },
      responses: { 200: json(okAny, "The diff"), 400: json(errorSchema, "Invalid name or version"), 404: json(errorSchema, "No such version") },
    }), ((c: Context) => guard(c, () => {
      const ref = refFor(c);
      if (ref instanceof Response) return ref;
      const a = num(c, "a");
      if (a instanceof Response) return a;
      const b = num(c, "b");
      if (b instanceof Response) return b;
      return c.json({ ok: true, data: diffSkillVersions(getDeps().polpoDir, ref, a, b) }, 200);
    })) as any);

    // ── POST {name}/versions/{version}/restore ──
    app.openapi(createRoute({
      method: "post",
      path: `${prefix}/{name}/versions/{version}/restore`,
      tags: ["Skills"],
      summary: `Restore a version of ${what}`,
      description: "Put that version's files back as the skill (recreating a deleted skill). The current state is recorded first, "
        + "and the restore is recorded as a new version (source restore), so it can be undone.",
      request: { params: z.object({ name: z.string(), version: z.string() }), query: scopeQuery },
      responses: { 200: json(okAny, "Restored: the new version"), 400: json(errorSchema, "Invalid name or version"), 404: json(errorSchema, "No such version") },
    }), ((c: Context) => guard(c, () => {
      const deps = getDeps();
      const ref = refFor(c);
      if (ref instanceof Response) return ref;
      const n = num(c, "version");
      if (n instanceof Response) return n;
      const wasDeleted = !!listSkillVersions(deps.polpoDir, ref)?.deletedAt;
      const version = restoreSkillVersion(deps.polpoDir, ref, n, deps.author?.(c) ?? "person:dashboard");
      deps.emit("skill:changed", { scope: pool, action: wasDeleted ? "created" : "updated", skillName: ref.name, timestamp: new Date().toISOString() });
      return c.json({ ok: true, data: { name: ref.name, restoredFrom: n, version } }, 200);
    })) as any);

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
      const n = num(c, "version");
      if (n instanceof Response) return n;
      const zip = zipSkillVersion(getDeps().polpoDir, ref, n);
      const ext = c.req.query("format") === "zip" ? "zip" : "skill";
      return new Response(new Uint8Array(zip), {
        status: 200,
        headers: {
          "Content-Type": "application/zip",
          "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(`${ref.name}-v${n}.${ext}`)}`,
          "Cache-Control": "no-store",
        },
      });
    })) as any);
  }
}
