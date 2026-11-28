import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
  discoverSkills,
  installSkills,
  removeSkill,
  createAgentSkill,
  isSafeSkillName,
  assignSkillToAgent,
  unassignSkillFromAgent,
  listSkillsWithAssignments,
  discoverOrchestratorSkills,
  installOrchestratorSkills,
  removeOrchestratorSkill,
  createOrchestratorSkill,
  updateOrchestratorSkill,
  updateAgentSkill,
  getSkillByName,
  updateSkillIndex,
  loadSkillIndex,
} from "../../llm/skills.js";
import { basename, resolve } from "node:path";
import { registerSkillBundleRoutes } from "./skill-bundles.js";
import { registerSkillVersionRoutes } from "./skill-versions.js";
import { SkillVersionError, skillVersionState, type SkillRef, type SkillVersionMode } from "../../llm/skill-versions.js";

/** Body fields of a change to a skill: publish it at once or leave it in the draft. */
export const skillPublishFields = {
  publish: z.boolean().optional().describe("true: published at once as a new version in production; false: only the draft changes (publish it later). Absent: settings.skills.versioning.autoPublishApiUpdates decides (default: published)."),
  bump: z.enum(["major", "minor", "patch"]).optional().describe("The version bump when published (default: suggested from the change)"),
  version: z.string().optional().describe("An explicit version when published (major.minor.patch, above the latest)"),
  note: z.string().max(2000).optional().describe("The release note when published"),
};
const publishFields = skillPublishFields;


/**
 * Skill routes — discover, install, remove, and assign skills.
 * Pool lives in .polpo/skills/ (project) and ~/.polpo/skills/ (global).
 */
export function skillRoutes(getDeps: () => {
  polpoDir: string;
  workDir: string;
  getAgents: () => Promise<any[]>;
  emit: (event: "skill:changed", data: { scope: "agent" | "orchestrator"; action: "created" | "updated" | "deleted" | "installed" | "assigned" | "unassigned" | "indexed"; skillName?: string; agentName?: string; timestamp: string }) => void;
  /** Who makes a request, recorded in the skills' versions (default "person:dashboard"). */
  author?: (c: any) => string;
  /** settings.skills.versioning.autoPublishApiUpdates (default true): a change without `publish` is published at once. */
  autoPublish?: () => boolean;
}): OpenAPIHono {
  const app = new OpenAPIHono();
  const authorOf = (c: any) => getDeps().author?.(c) ?? "person:dashboard";
  /** publish: true → published at once; false → the draft; absent → the instance setting (default: published). */
  const modeOf = (publish: boolean | undefined): SkillVersionMode => (publish ?? (getDeps().autoPublish?.() ?? true)) ? "publish" : "draft";
  const stateOf = (ref: SkillRef) => {
    try { return skillVersionState(getDeps().polpoDir, ref); } catch { return undefined; }
  };
  const versioningOf = (ref: SkillRef, mode: SkillVersionMode) => {
    try {
      const state = skillVersionState(getDeps().polpoDir, ref);
      return state ? { mode, ...state } : { mode };
    } catch { return { mode }; }
  };

  // Bundles: upload .skill/.zip archives, browse and download a skill's files (both pools)
  registerSkillBundleRoutes(app, getDeps);
  // Versions: every change recorded; list, browse, diff, restore, download (both pools)
  registerSkillVersionRoutes(app, getDeps);

  // GET /skills — list skills with agent assignments
  const listSkillsRoute = createRoute({
    method: "get",
    path: "/",
    tags: ["Skills"],
    summary: "List skills",
    responses: {
      200: {
        content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.array(z.any()) }) } },
        description: "List of skills",
      },
    },
  });

  app.openapi(listSkillsRoute, async (c) => {
    const deps = getDeps();
    const workDir = deps.workDir;
    const polpoDir = deps.polpoDir;

    // Get agent names from the configured store (authoritative source)
    const configAgents = await deps.getAgents();
    const allAgentNames = configAgents.map(a => a.name);

    // Build map of agentName → configured skill names for config-based assignment detection
    const agentConfigSkills = new Map<string, string[]>();
    for (const agent of configAgents) {
      if (agent.skills?.length) {
        agentConfigSkills.set(agent.name, agent.skills);
      }
    }

    const skills = listSkillsWithAssignments(workDir, polpoDir, allAgentNames, agentConfigSkills);
    return c.json({ ok: true, data: skills });
  });

  // POST /skills/add — install skills from a source
  const addSkillRoute = createRoute({
    method: "post",
    path: "/add",
    tags: ["Skills"],
    summary: "Install skills",
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({
              source: z.string().min(1),
              skillNames: z.array(z.string()).optional(),
              global: z.boolean().optional(),
              force: z.boolean().optional(),
            }),
          },
        },
      },
    },
    responses: {
      201: {
        content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.any() }) } },
        description: "Skills installed",
      },
      400: {
        content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.any() }) } },
        description: "Installation failed",
      },
    },
  });

  app.openapi(addSkillRoute, (c) => {
    const deps = getDeps();
    const polpoDir = deps.polpoDir;

    const body = c.req.valid("json");

    const result = installSkills(body.source, polpoDir, {
      skillNames: body.skillNames,
      global: body.global,
      force: body.force,
      author: authorOf(c),
    });
    if (result.installed.length > 0) deps.emit("skill:changed", { scope: "agent", action: "installed", timestamp: new Date().toISOString() });

    const hasErrors = result.errors.length > 0 && result.installed.length === 0;
    return c.json({
      ok: !hasErrors,
      data: result,
    }, hasErrors ? 400 : 201);
  });

  // POST /skills/create — create a new agent skill from scratch
  const createSkillRoute = createRoute({
    method: "post",
    path: "/create",
    tags: ["Skills"],
    summary: "Create skill",
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({
              name: z.string().min(1),
              description: z.string().min(1),
              content: z.string().min(1),
              allowedTools: z.array(z.string()).optional(),
              global: z.boolean().optional(),
            }),
          },
        },
      },
    },
    responses: {
      201: {
        content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.object({ name: z.string(), path: z.string() }) }) } },
        description: "Skill created",
      },
      400: {
        content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string(), code: z.string() }) } },
        description: "Invalid skill name",
      },
      409: {
        content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string(), code: z.string() }) } },
        description: "Skill already exists",
      },
    },
  });

  app.openapi(createSkillRoute, (c) => {
    const deps = getDeps();
    const polpoDir = deps.polpoDir;
    const workDir = deps.workDir;
    const body = c.req.valid("json");
    if (!isSafeSkillName(body.name)) {
      return c.json({ ok: false, error: "Invalid skill name — use letters, numbers, \".\", \"_\" or \"-\"", code: "INVALID_NAME" }, 400);
    }

    const existing = discoverSkills(workDir, polpoDir);
    if (existing.some(s => s.name === body.name)) {
      return c.json({ ok: false, error: `Skill "${body.name}" already exists`, code: "CONFLICT" }, 409);
    }

    const skillPath = createAgentSkill(polpoDir, body.name, body.description, body.content, {
      allowedTools: body.allowedTools,
      global: body.global,
      author: authorOf(c),
    });
    deps.emit("skill:changed", { scope: "agent", action: "created", skillName: body.name, timestamp: new Date().toISOString() });
    return c.json({ ok: true, data: { name: body.name, path: skillPath } }, 201);
  });

  // PUT /skills/:name — update an agent skill (only the fields given change)
  const updateSkillRoute = createRoute({
    method: "put",
    path: "/{name}",
    tags: ["Skills"],
    summary: "Update skill",
    request: {
      params: z.object({ name: z.string() }),
      body: {
        content: {
          "application/json": {
            schema: z.object({
              description: z.string().min(1).optional(),
              content: z.string().min(1).optional(),
              allowedTools: z.array(z.string()).optional(),
              global: z.boolean().optional(),
              ...publishFields,
            }),
          },
        },
      },
    },
    responses: {
      200: {
        content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.object({ name: z.string(), updated: z.boolean(), versioning: z.any().optional() }) }) } },
        description: "Skill updated (versioning: draft or published, and the lifecycle state)",
      },
      404: {
        content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string(), code: z.string() }) } },
        description: "Skill not found",
      },
    },
  });

  app.openapi(updateSkillRoute, (c) => {
    const deps = getDeps();
    const { name } = c.req.valid("param");
    const { global, publish, bump, version, note, ...updates } = c.req.valid("json");
    const mode = modeOf(publish);
    let updated: boolean;
    try {
      updated = updateAgentSkill(deps.polpoDir, name, updates, global, authorOf(c), { mode, ...(note ? { note } : {}), ...(bump ? { bump } : {}), ...(version ? { version } : {}) });
    } catch (err) {
      if (err instanceof SkillVersionError) return c.json({ ok: false, error: err.message, code: err.code }, err.code === "CONFLICT" ? 409 : 400) as any;
      throw err;
    }
    if (!updated) {
      return c.json({ ok: false, error: `Skill "${name}" not found${global ? " in the global pool" : ""}`, code: "NOT_FOUND" }, 404);
    }
    deps.emit("skill:changed", { scope: "agent", action: "updated", skillName: name, timestamp: new Date().toISOString() });
    return c.json({ ok: true, data: { name, updated: true, versioning: versioningOf({ pool: "agent", global, name }, mode) } }, 200);
  });

  // DELETE /skills/:name — remove a skill from the pool
  const deleteSkillRoute = createRoute({
    method: "delete",
    path: "/{name}",
    tags: ["Skills"],
    summary: "Remove skill",
    request: {
      params: z.object({ name: z.string() }),
      query: z.object({ global: z.string().optional() }),
    },
    responses: {
      200: {
        content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.object({ removed: z.string() }) }) } },
        description: "Skill removed",
      },
      404: {
        content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string(), code: z.string() }) } },
        description: "Skill not found",
      },
    },
  });

  app.openapi(deleteSkillRoute, (c) => {
    const deps = getDeps();
    const polpoDir = deps.polpoDir;
    const { name } = c.req.valid("param");
    const { global: globalParam } = c.req.valid("query");
    const global = globalParam === "true";

    const removed = removeSkill(polpoDir, name, global, authorOf(c));
    if (!removed) {
      return c.json({ ok: false, error: "Skill not found", code: "NOT_FOUND" }, 404);
    }

    deps.emit("skill:changed", { scope: "agent", action: "deleted", skillName: name, timestamp: new Date().toISOString() });

    return c.json({ ok: true, data: { removed: name } }, 200);
  });

  // POST /skills/:name/assign — assign a skill to an agent
  const assignSkillRoute = createRoute({
    method: "post",
    path: "/{name}/assign",
    tags: ["Skills"],
    summary: "Assign skill",
    request: {
      params: z.object({ name: z.string() }),
      body: {
        content: {
          "application/json": {
            schema: z.object({ agent: z.string().min(1) }),
          },
        },
      },
    },
    responses: {
      200: {
        content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.object({ skill: z.string(), agent: z.string() }) }) } },
        description: "Skill assigned",
      },
      404: {
        content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string(), code: z.string() }) } },
        description: "Skill not found",
      },
    },
  });

  app.openapi(assignSkillRoute, (c) => {
    const deps = getDeps();
    const workDir = deps.workDir;
    const polpoDir = deps.polpoDir;
    const { name: skillName } = c.req.valid("param");
    const { agent } = c.req.valid("json");

    // Find skill in pool
    const pool = discoverSkills(workDir, polpoDir);
    const skill = pool.find(s => s.name === skillName);
    if (!skill) {
      return c.json({ ok: false, error: "Skill not found", code: "NOT_FOUND" }, 404);
    }

    assignSkillToAgent(polpoDir, agent, skillName, skill.path);
    deps.emit("skill:changed", { scope: "agent", action: "assigned", skillName, agentName: agent, timestamp: new Date().toISOString() });
    return c.json({ ok: true, data: { skill: skillName, agent } }, 200);
  });

  // POST /skills/:name/unassign — unassign a skill from an agent
  const unassignSkillRoute = createRoute({
    method: "post",
    path: "/{name}/unassign",
    tags: ["Skills"],
    summary: "Unassign skill",
    request: {
      params: z.object({ name: z.string() }),
      body: {
        content: {
          "application/json": {
            schema: z.object({ agent: z.string().min(1) }),
          },
        },
      },
    },
    responses: {
      200: {
        content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.object({ skill: z.string(), agent: z.string() }) }) } },
        description: "Skill unassigned",
      },
      404: {
        content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string(), code: z.string() }) } },
        description: "Assignment not found",
      },
    },
  });

  app.openapi(unassignSkillRoute, (c) => {
    const deps = getDeps();
    const polpoDir = deps.polpoDir;
    const { name: skillName } = c.req.valid("param");
    const { agent } = c.req.valid("json");

    const removed = unassignSkillFromAgent(polpoDir, agent, skillName);
    if (!removed) {
      return c.json({ ok: false, error: "Assignment not found", code: "NOT_FOUND" }, 404);
    }
    deps.emit("skill:changed", { scope: "agent", action: "unassigned", skillName, agentName: agent, timestamp: new Date().toISOString() });
    return c.json({ ok: true, data: { skill: skillName, agent } }, 200);
  });

  // GET /skills/:name/content — get agent skill content
  const getSkillContentRoute = createRoute({
    method: "get",
    path: "/{name}/content",
    tags: ["Skills"],
    summary: "Get skill content",
    description: "The skill as agents run it (its production version) with `versioning` (production, latest, the draft: changes, external, stale). "
      + "?view=draft returns the skill's folder instead: the draft, pending changes included.",
    request: {
      params: z.object({ name: z.string() }),
      query: z.object({ view: z.enum(["production", "draft"]).optional() }),
    },
    responses: {
      200: {
        content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.any() }) } },
        description: "Skill content",
      },
      404: {
        content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string(), code: z.string() }) } },
        description: "Skill not found",
      },
    },
  });

  app.openapi(getSkillContentRoute, (c) => {
    const deps = getDeps();
    const polpoDir = deps.polpoDir;
    const workDir = deps.workDir;
    const { name } = c.req.valid("param");
    const view = c.req.query("view") === "draft" ? "draft" : "production";

    const skill = getSkillByName(workDir, polpoDir, name, "agent", view);
    if (!skill) {
      return c.json({ ok: false, error: `Skill "${name}" not found`, code: "NOT_FOUND" }, 404);
    }
    const state = stateOf({ pool: "agent", global: skill.source === "global", name: basename(skill.path) });
    return c.json({ ok: true, data: { ...skill, view, ...(state ? { versioning: state } : {}) } }, 200);
  });

  // ═══════════════════════════════════════════════════════
  //  ORCHESTRATOR SKILL ROUTES
  // ═══════════════════════════════════════════════════════

  // GET /skills/orchestrator — list orchestrator skills
  const listOrchSkillsRoute = createRoute({
    method: "get",
    path: "/orchestrator",
    tags: ["Skills"],
    summary: "List orchestrator skills",
    responses: {
      200: {
        content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.array(z.any()) }) } },
        description: "List of orchestrator skills",
      },
    },
  });

  app.openapi(listOrchSkillsRoute, (c) => {
    const deps = getDeps();
    const skills = discoverOrchestratorSkills(deps.polpoDir);
    return c.json({ ok: true, data: skills });
  });

  // POST /skills/orchestrator — create a new orchestrator skill
  const createOrchSkillRoute = createRoute({
    method: "post",
    path: "/orchestrator",
    tags: ["Skills"],
    summary: "Create orchestrator skill",
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({
              name: z.string().min(1),
              description: z.string().min(1),
              content: z.string().min(1),
              allowedTools: z.array(z.string()).optional(),
            }),
          },
        },
      },
    },
    responses: {
      201: {
        content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.object({ name: z.string(), path: z.string() }) }) } },
        description: "Skill created",
      },
      409: {
        content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string(), code: z.string() }) } },
        description: "Skill already exists",
      },
    },
  });

  app.openapi(createOrchSkillRoute, (c) => {
    const deps = getDeps();
    const polpoDir = deps.polpoDir;
    const body = c.req.valid("json");

    const existing = discoverOrchestratorSkills(polpoDir);
    if (existing.some(s => s.name === body.name)) {
      return c.json({ ok: false, error: `Skill "${body.name}" already exists`, code: "CONFLICT" }, 409);
    }

    const skillPath = createOrchestratorSkill(polpoDir, body.name, body.description, body.content, {
      allowedTools: body.allowedTools,
      author: authorOf(c),
    });
    deps.emit("skill:changed", { scope: "orchestrator", action: "created", skillName: body.name, timestamp: new Date().toISOString() });
    return c.json({ ok: true, data: { name: body.name, path: skillPath } }, 201);
  });

  // PUT /skills/orchestrator/:name — update an orchestrator skill
  const updateOrchSkillRoute = createRoute({
    method: "put",
    path: "/orchestrator/{name}",
    tags: ["Skills"],
    summary: "Update orchestrator skill",
    request: {
      params: z.object({ name: z.string() }),
      body: {
        content: {
          "application/json": {
            schema: z.object({
              description: z.string().optional(),
              content: z.string().optional(),
              allowedTools: z.array(z.string()).optional(),
              ...publishFields,
            }),
          },
        },
      },
    },
    responses: {
      200: {
        content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.object({ name: z.string(), versioning: z.any().optional() }) }) } },
        description: "Skill updated (versioning: draft or published, and the lifecycle state)",
      },
      404: {
        content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string(), code: z.string() }) } },
        description: "Skill not found",
      },
    },
  });

  app.openapi(updateOrchSkillRoute, (c) => {
    const deps = getDeps();
    const polpoDir = deps.polpoDir;
    const { name } = c.req.valid("param");
    const { publish, bump, version, note, ...body } = c.req.valid("json");
    const mode = modeOf(publish);
    let ok: boolean;
    try {
      ok = updateOrchestratorSkill(polpoDir, name, body, false, authorOf(c), { mode, ...(note ? { note } : {}), ...(bump ? { bump } : {}), ...(version ? { version } : {}) });
    } catch (err) {
      if (err instanceof SkillVersionError) return c.json({ ok: false, error: err.message, code: err.code }, err.code === "CONFLICT" ? 409 : 400) as any;
      throw err;
    }
    if (!ok) {
      return c.json({ ok: false, error: `Skill "${name}" not found`, code: "NOT_FOUND" }, 404);
    }
    deps.emit("skill:changed", { scope: "orchestrator", action: "updated", skillName: name, timestamp: new Date().toISOString() });
    return c.json({ ok: true, data: { name, versioning: versioningOf({ pool: "orchestrator", name }, mode) } }, 200);
  });

  // DELETE /skills/orchestrator/:name — remove an orchestrator skill
  const deleteOrchSkillRoute = createRoute({
    method: "delete",
    path: "/orchestrator/{name}",
    tags: ["Skills"],
    summary: "Remove orchestrator skill",
    request: {
      params: z.object({ name: z.string() }),
    },
    responses: {
      200: {
        content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.object({ removed: z.string() }) }) } },
        description: "Skill removed",
      },
      404: {
        content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string(), code: z.string() }) } },
        description: "Skill not found",
      },
    },
  });

  app.openapi(deleteOrchSkillRoute, (c) => {
    const deps = getDeps();
    const polpoDir = deps.polpoDir;
    const { name } = c.req.valid("param");

    const removed = removeOrchestratorSkill(polpoDir, name, false, authorOf(c));
    if (!removed) {
      return c.json({ ok: false, error: "Skill not found", code: "NOT_FOUND" }, 404);
    }
    deps.emit("skill:changed", { scope: "orchestrator", action: "deleted", skillName: name, timestamp: new Date().toISOString() });
    return c.json({ ok: true, data: { removed: name } }, 200);
  });

  // GET /skills/orchestrator/:name/content — get orchestrator skill content
  const getOrchSkillContentRoute = createRoute({
    method: "get",
    path: "/orchestrator/{name}/content",
    tags: ["Skills"],
    summary: "Get orchestrator content",
    description: "The skill as Polpo runs it (its production version) with `versioning`; ?view=draft returns the skill's folder (the draft).",
    request: {
      params: z.object({ name: z.string() }),
      query: z.object({ view: z.enum(["production", "draft"]).optional() }),
    },
    responses: {
      200: {
        content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.any() }) } },
        description: "Skill content",
      },
      404: {
        content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string(), code: z.string() }) } },
        description: "Skill not found",
      },
    },
  });

  app.openapi(getOrchSkillContentRoute, (c) => {
    const deps = getDeps();
    const polpoDir = deps.polpoDir;
    const workDir = deps.workDir;
    const { name } = c.req.valid("param");

    const view = c.req.query("view") === "draft" ? "draft" : "production";
    const skill = getSkillByName(workDir, polpoDir, name, "orchestrator", view);
    if (!skill) {
      return c.json({ ok: false, error: `Skill "${name}" not found`, code: "NOT_FOUND" }, 404);
    }
    const state = stateOf({ pool: "orchestrator", global: skill.source === "global", name: basename(skill.path) });
    return c.json({ ok: true, data: { ...skill, view, ...(state ? { versioning: state } : {}) } }, 200);
  });

  // POST /skills/orchestrator/add — install orchestrator skills from source
  const addOrchSkillRoute = createRoute({
    method: "post",
    path: "/orchestrator/add",
    tags: ["Skills"],
    summary: "Install orchestrator skills",
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({
              source: z.string().min(1),
              skillNames: z.array(z.string()).optional(),
              force: z.boolean().optional(),
            }),
          },
        },
      },
    },
    responses: {
      201: {
        content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.any() }) } },
        description: "Skills installed",
      },
      400: {
        content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.any() }) } },
        description: "Installation failed",
      },
    },
  });

  app.openapi(addOrchSkillRoute, (c) => {
    const deps = getDeps();
    const polpoDir = deps.polpoDir;
    const body = c.req.valid("json");

    const result = installOrchestratorSkills(body.source, polpoDir, {
      skillNames: body.skillNames,
      force: body.force,
      author: authorOf(c),
    });
    if (result.installed.length > 0) deps.emit("skill:changed", { scope: "orchestrator", action: "installed", timestamp: new Date().toISOString() });

    const hasErrors = result.errors.length > 0 && result.installed.length === 0;
    return c.json({ ok: !hasErrors, data: result }, hasErrors ? 400 : 201);
  });

  // ═══════════════════════════════════════════════════════
  //  SKILLS INDEX ROUTES (tags & categories)
  // ═══════════════════════════════════════════════════════

  // GET /skills/index — get the full skills index
  const getSkillIndexRoute = createRoute({
    method: "get",
    path: "/index",
    tags: ["Skills"],
    summary: "Get skills index",
    responses: {
      200: {
        content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.any() }) } },
        description: "Skills index",
      },
    },
  });

  app.openapi(getSkillIndexRoute, (c) => {
    const deps = getDeps();
    const polpoDir = deps.polpoDir;
    const index = loadSkillIndex(polpoDir) ?? {};
    return c.json({ ok: true, data: index });
  });

  // PUT /skills/:name/index — update a skill's index entry (tags, category)
  const updateSkillIndexRoute = createRoute({
    method: "put",
    path: "/{name}/index",
    tags: ["Skills"],
    summary: "Update skill index",
    request: {
      params: z.object({ name: z.string() }),
      body: {
        content: {
          "application/json": {
            schema: z.object({
              tags: z.array(z.string()).optional(),
              category: z.string().optional(),
            }),
          },
        },
      },
    },
    responses: {
      200: {
        content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.object({ skill: z.string(), tags: z.array(z.string()).optional(), category: z.string().optional() }) }) } },
        description: "Index entry updated",
      },
      400: {
        content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string() }) } },
        description: "Invalid skill name",
      },
    },
  });

  app.openapi(updateSkillIndexRoute, (c) => {
    const deps = getDeps();
    const polpoDir = deps.polpoDir;
    const { name } = c.req.valid("param");
    const body = c.req.valid("json");
    if (!isSafeSkillName(name)) {
      return c.json({ ok: false, error: "Invalid skill name" }, 400);
    }

    updateSkillIndex(polpoDir, name, { tags: body.tags, category: body.category });
    deps.emit("skill:changed", { scope: "agent", action: "indexed", skillName: name, timestamp: new Date().toISOString() });
    return c.json({ ok: true, data: { skill: name, ...body } }, 200);
  });

  return app;
}

