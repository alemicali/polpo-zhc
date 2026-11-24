/**
 * Skill bundles over REST: upload a `.skill` / `.zip` archive (preview, then install), browse an
 * installed skill's files, read one, download the whole skill as an archive. For agents' skills
 * (/skills/…) and the orchestrator's (/skills/orchestrator/…).
 */
import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { readFileSync } from "node:fs";
import { posix } from "node:path";
import {
  assignSkillToAgent, discoverSkills, findSkillDir, installSkillBundleToPool, skillNamesIn, skillPoolDir,
  type SkillPool,
} from "../../llm/skills.js";
import {
  SKILL_BUNDLE_LIMITS, SkillBundleError, dropStagedSkillUpload, getStagedSkillUpload, listSkillFiles, parseSkillBundle,
  resolveSkillFile, skillFileContentType, stageSkillUpload, zipSkillDir,
  type BundleInstallResult, type ConflictPolicy, type ParsedSkillBundle,
} from "../../llm/skill-bundle.js";

export interface SkillBundleDeps {
  polpoDir: string;
  workDir: string;
  getAgents: () => Promise<any[]>;
  emit: (event: "skill:changed", data: { scope: "agent" | "orchestrator"; action: "installed" | "assigned"; skillName?: string; agentName?: string; timestamp: string }) => void;
  /** Who makes a request, recorded in the skills' versions. */
  author?: (c: Context) => string;
}

const errorSchema = z.object({ ok: z.boolean(), error: z.string(), code: z.string().optional(), details: z.any().optional() });
const okAny = z.object({ ok: z.boolean(), data: z.any() });
const json = (schema: z.ZodTypeAny, description: string) => ({ content: { "application/json": { schema } }, description });

const installOptions = z.object({
  pool: z.enum(["agent", "orchestrator"]).optional().describe("agent (default): the agents' pool; orchestrator: Polpo's own skills"),
  global: z.boolean().optional().describe("true: the global pool (~/.polpo) shared by every project"),
  onConflict: z.enum(["fail", "replace", "skip"]).optional().describe("When a skill with the same name exists (default fail)"),
  skills: z.array(z.string()).optional().describe("Only these skills of the archive (default all)"),
  renames: z.record(z.string(), z.string()).optional().describe("Archive name → name to install as"),
  assignTo: z.array(z.string()).optional().describe("Agents to assign the installed skills to (agent pool only)"),
});
type InstallOptions = z.infer<typeof installOptions>;

/** The preview of an archive: each skill with whether its name is taken in each pool. */
function previewOf(bundle: ParsedSkillBundle, polpoDir: string) {
  const taken = {
    agent: { project: skillNamesIn(skillPoolDir(polpoDir, "agent")), global: skillNamesIn(skillPoolDir(polpoDir, "agent", true)) },
    orchestrator: { project: skillNamesIn(skillPoolDir(polpoDir, "orchestrator")), global: skillNamesIn(skillPoolDir(polpoDir, "orchestrator", true)) },
  };
  return {
    ...bundle.preview,
    limits: SKILL_BUNDLE_LIMITS,
    skills: bundle.preview.skills.map((s) => ({
      ...s,
      exists: {
        agent: { project: taken.agent.project.has(s.name), global: taken.agent.global.has(s.name) },
        orchestrator: { project: taken.orchestrator.project.has(s.name), global: taken.orchestrator.global.has(s.name) },
      },
    })),
  };
}

export function registerSkillBundleRoutes(app: OpenAPIHono, getDeps: () => SkillBundleDeps): void {
  const fail = (c: Context, status: 400 | 404 | 409 | 413 | 422, error: string, code: string, details?: unknown) =>
    c.json({ ok: false, error, code, ...(details !== undefined ? { details } : {}) }, status);

  const install = async (c: Context, bundle: ParsedSkillBundle, opts: InstallOptions) => {
    const deps = getDeps();
    const pool: SkillPool = opts.pool ?? "agent";
    const result: BundleInstallResult = installSkillBundleToPool(deps.polpoDir, bundle, {
      pool, global: opts.global, onConflict: (opts.onConflict ?? "fail") as ConflictPolicy, author: deps.author?.(c) ?? "person:dashboard", source: "upload",
      ...(opts.skills?.length ? { skills: opts.skills } : {}), ...(opts.renames ? { renames: opts.renames } : {}),
    });
    const now = () => new Date().toISOString();
    for (const i of result.installed) deps.emit("skill:changed", { scope: pool, action: "installed", skillName: i.name, timestamp: now() });
    const assigned: Array<{ skill: string; agent: string }> = [];
    const assignErrors: string[] = [];
    if (pool === "agent" && opts.assignTo?.length && result.installed.length) {
      const known = new Set((await deps.getAgents()).map((a) => a.name as string));
      const pooled = discoverSkills(deps.workDir, deps.polpoDir);
      for (const agent of opts.assignTo) {
        if (!known.has(agent)) { assignErrors.push(`There is no agent "${agent}"`); continue; }
        for (const i of result.installed) {
          const info = pooled.find((s) => s.name === i.name);
          if (!info) { assignErrors.push(`"${i.name}" is installed in the global pool under a name a project skill already uses`); continue; }
          assignSkillToAgent(deps.polpoDir, agent, i.name, info.path);
          assigned.push({ skill: i.name, agent });
          deps.emit("skill:changed", { scope: "agent", action: "assigned", skillName: i.name, agentName: agent, timestamp: now() });
        }
      }
    }
    const data = { ...result, assigned, ...(assignErrors.length ? { assignErrors } : {}) };
    if (result.installed.length === 0 && result.errors.length) {
      const conflict = result.errors.every((e) => /exists: replace it/.test(e.error));
      return fail(c, conflict ? 409 : 422, result.errors.map((e) => `${e.name}: ${e.error}`).join("; "), conflict ? "CONFLICT" : "INVALID_SKILL", data);
    }
    return c.json({ ok: true, data }, 201);
  };

  const parse = (c: Context, buf: Buffer, filename?: string): ParsedSkillBundle | Response => {
    try {
      return parseSkillBundle(buf, { filename });
    } catch (err) {
      if (err instanceof SkillBundleError) return fail(c, err.code === "TOO_LARGE" ? 413 : 422, err.message, err.code);
      throw err;
    }
  };

  // ── POST /skills/upload ──
  app.use("/upload", bodyLimit({
    maxSize: SKILL_BUNDLE_LIMITS.maxArchiveBytes + 1024 * 1024,
    onError: (c) => c.json({ ok: false, error: `The upload is over ${SKILL_BUNDLE_LIMITS.maxArchiveBytes / 1024 / 1024} MB`, code: "TOO_LARGE" }, 413),
  }));
  const uploadRoute = createRoute({
    method: "post",
    path: "/upload",
    tags: ["Skills"],
    summary: "Upload a skill bundle",
    description: "Upload a `.skill` or `.zip` archive (multipart field `file`). With `dryRun=1` nothing is installed: the response "
      + "is a preview (each skill's name, description, files, sizes, warnings, errors, and whether the name is taken) with an `uploadId` "
      + "to install it later with POST /skills/upload/{uploadId}/install. Without dryRun the archive is installed at once with the query options.",
    request: {
      query: z.object({
        dryRun: z.string().optional().describe("1/true: preview only"),
        pool: z.enum(["agent", "orchestrator"]).optional(),
        global: z.string().optional().describe("1/true: the global pool"),
        onConflict: z.enum(["fail", "replace", "skip"]).optional(),
        skills: z.string().optional().describe("Comma-separated archive names to install"),
        assignTo: z.string().optional().describe("Comma-separated agents to assign the installed skills to"),
      }),
      body: {
        content: {
          "multipart/form-data": {
            schema: z.object({
              file: z.any().describe("The .skill or .zip archive"),
              renames: z.string().optional().describe("JSON object: archive name → name to install as"),
            }),
          },
        },
      },
    },
    responses: {
      200: json(okAny, "Preview (dryRun)"),
      201: json(okAny, "Installed"),
      400: json(errorSchema, "No file"),
      409: json(errorSchema, "A skill with the name exists (onConflict=fail)"),
      413: json(errorSchema, "Too large"),
      422: json(errorSchema, "Not a valid skill archive"),
    },
  });
  app.openapi(uploadRoute, (async (c: Context) => {
    const deps = getDeps();
    const body = await c.req.parseBody();
    const file = body.file;
    if (!(file instanceof File)) return fail(c, 400, "Send the archive as the multipart field \"file\"", "BAD_REQUEST");
    const buf = Buffer.from(await file.arrayBuffer());
    const parsed = parse(c, buf, file.name);
    if (parsed instanceof Response) return parsed;
    const q = c.req.query();
    const truthy = (v?: string) => v === "1" || v === "true";
    if (truthy(q.dryRun)) {
      const uploadId = stageSkillUpload(buf, file.name);
      return c.json({ ok: true, data: { uploadId, ...previewOf(parsed, deps.polpoDir) } }, 200);
    }
    let renames: Record<string, string> | undefined;
    if (typeof body.renames === "string" && body.renames.trim()) {
      try { renames = z.record(z.string(), z.string()).parse(JSON.parse(body.renames)); } catch { return fail(c, 400, "renames must be a JSON object of names", "BAD_REQUEST"); }
    }
    const list = (v?: string) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    return install(c, parsed, {
      ...(q.pool ? { pool: q.pool as SkillPool } : {}), global: truthy(q.global),
      ...(q.onConflict ? { onConflict: q.onConflict as ConflictPolicy } : {}),
      skills: list(q.skills), assignTo: list(q.assignTo), ...(renames ? { renames } : {}),
    });
  }) as any);

  // ── POST /skills/upload/{uploadId}/install ──
  const installRoute = createRoute({
    method: "post",
    path: "/upload/{uploadId}/install",
    tags: ["Skills"],
    summary: "Install a previewed skill bundle",
    description: "Install an archive uploaded with dryRun (kept 30 minutes): choose the pool, what to do with names that exist "
      + "(fail, replace, skip, or rename), which skills, and the agents to assign them to.",
    request: {
      params: z.object({ uploadId: z.string() }),
      body: { content: { "application/json": { schema: installOptions } } },
    },
    responses: {
      201: json(okAny, "Installed"),
      404: json(errorSchema, "Upload not found or expired"),
      409: json(errorSchema, "A skill with the name exists"),
      422: json(errorSchema, "Nothing installable"),
    },
  });
  app.openapi(installRoute, (async (c: Context) => {
    const { uploadId } = c.req.param() as { uploadId: string };
    const staged = getStagedSkillUpload(uploadId);
    if (!staged) return fail(c, 404, "This upload expired or does not exist: upload the archive again", "NOT_FOUND");
    let opts: InstallOptions;
    try { opts = installOptions.parse(await c.req.json()); } catch { return fail(c, 400, "Invalid install options", "BAD_REQUEST"); }
    const parsed = parse(c, staged.buf, staged.filename);
    if (parsed instanceof Response) return parsed;
    const res = await install(c, parsed, opts);
    if (res.status === 201) dropStagedSkillUpload(uploadId);
    return res;
  }) as any);

  // ── Files of an installed skill (both pools) ──
  for (const pool of ["orchestrator", "agent"] as const) {
    const prefix = pool === "orchestrator" ? "/orchestrator" : "";
    const tag = pool === "orchestrator" ? "orchestrator skill" : "skill";
    const locate = (name: string) => {
      const deps = getDeps();
      return findSkillDir(deps.workDir, deps.polpoDir, name, pool);
    };

    app.openapi(createRoute({
      method: "get",
      path: `${prefix}/{name}/files`,
      tags: ["Skills"],
      summary: `List a${pool === "orchestrator" ? "n" : ""} ${tag}'s files`,
      description: "Every file of the skill folder (SKILL.md, scripts/, references/, assets/…) with its size, relative to the folder.",
      request: { params: z.object({ name: z.string() }) },
      responses: { 200: json(okAny, "The files"), 404: json(errorSchema, "Skill not found") },
    }), ((c: Context) => {
      const name = c.req.param("name")!;
      const skill = locate(name);
      if (!skill) return fail(c, 404, `Skill "${name}" not found`, "NOT_FOUND");
      const { files, truncated } = listSkillFiles(skill.path);
      return c.json({ ok: true, data: { name: skill.name, source: skill.source, files, truncated, totalBytes: files.reduce((s, f) => s + f.size, 0) } }, 200);
    }) as any);

    const readFile = (c: Context, name: string, rel: string) => {
      const skill = locate(name);
      if (!skill) return fail(c, 404, `Skill "${name}" not found`, "NOT_FOUND");
      const abs = resolveSkillFile(skill.path, rel);
      if (!abs) return fail(c, 404, `"${rel}" is not a file of skill "${name}"`, "NOT_FOUND");
      const bytes = readFileSync(abs);
      const type = skillFileContentType(rel, bytes);
      const download = c.req.query("download") === "1" || c.req.query("download") === "true";
      const headers: Record<string, string> = {
        "Content-Type": type,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-store",
        "Content-Disposition": `${download ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(posix.basename(rel))}`,
      };
      // Uploaded content served from the dashboard's origin: never run its scripts (PDF viewers need no sandbox)
      if (!type.startsWith("application/pdf")) headers["Content-Security-Policy"] = "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'";
      // HTML is shown as text unless downloaded
      if (!download && /^text\/html/.test(type)) headers["Content-Type"] = "text/plain; charset=utf-8";
      return new Response(bytes, { status: 200, headers });
    };

    // /{name}/files/{path} with the path URL-encoded (documented form) …
    app.openapi(createRoute({
      method: "get",
      path: `${prefix}/{name}/files/{path}`,
      tags: ["Skills"],
      summary: `Read a${pool === "orchestrator" ? "n" : ""} ${tag}'s file`,
      description: "The raw file with its content type (text as UTF-8). The path is relative to the skill folder; slashes may be "
        + "literal or encoded (references%2Fapi.md). ?download=1 serves it as an attachment. Paths outside the folder are refused.",
      request: { params: z.object({ name: z.string(), path: z.string() }), query: z.object({ download: z.string().optional() }) },
      responses: {
        200: { description: "The file", content: { "application/octet-stream": { schema: z.any() } } },
        404: json(errorSchema, "Skill or file not found"),
      },
    }), ((c: Context) => readFile(c, c.req.param("name")!, c.req.param("path")!)) as any);
    // … and with literal slashes (references/api.md)
    app.get(`${prefix}/:name/files/*`, (c) => {
      const name = c.req.param("name");
      const marker = `/${encodeURIComponent(name)}/files/`;
      const raw = c.req.path;
      const at = raw.indexOf(marker);
      const rel = at >= 0 ? raw.slice(at + marker.length) : "";
      let decoded: string;
      try { decoded = rel.split("/").map(decodeURIComponent).join("/"); } catch { return fail(c, 404, "Invalid path", "NOT_FOUND"); }
      return readFile(c, name, decoded);
    });

    app.openapi(createRoute({
      method: "get",
      path: `${prefix}/{name}/download`,
      tags: ["Skills"],
      summary: `Download a${pool === "orchestrator" ? "n" : ""} ${tag}`,
      description: "The whole skill folder as an archive (`.skill` by default, or `.zip` with format=zip — the same zip either way, "
        + "with the folder at its root, ready to upload elsewhere).",
      request: { params: z.object({ name: z.string() }), query: z.object({ format: z.enum(["skill", "zip"]).optional() }) },
      responses: {
        200: { description: "The archive", content: { "application/zip": { schema: z.any() } } },
        404: json(errorSchema, "Skill not found"),
        413: json(errorSchema, "Too large"),
      },
    }), ((c: Context) => {
      const name = c.req.param("name")!;
      const skill = locate(name);
      if (!skill) return fail(c, 404, `Skill "${name}" not found`, "NOT_FOUND");
      let zip: Buffer;
      try { zip = zipSkillDir(skill.path, skill.name); } catch (err) {
        if (err instanceof SkillBundleError) return fail(c, 413, err.message, err.code);
        throw err;
      }
      const ext = c.req.query("format") === "zip" ? "zip" : "skill";
      return new Response(new Uint8Array(zip), {
        status: 200,
        headers: {
          "Content-Type": "application/zip",
          "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(`${skill.name}.${ext}`)}`,
          "Cache-Control": "no-store",
        },
      });
    }) as any);
  }
}
