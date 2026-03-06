import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { ServerEnv } from "../app.js";
import {
  discoverSkills,
  installSkills,
  removeSkill,
  createAgentSkill,
  assignSkillToAgent,
  unassignSkillFromAgent,
  listSkillsWithAssignments,
  discoverOrchestratorSkills,
  installOrchestratorSkills,
  removeOrchestratorSkill,
  createOrchestratorSkill,
  updateOrchestratorSkill,
  getSkillByName,
  updateSkillIndex,
  loadSkillIndex,
} from "../../llm/skills.js";
import { resolve } from "node:path";
import { existsSync, readdirSync } from "node:fs";

/**
 * Skill routes — discover, install, remove, and assign skills.
 * Pool lives in .polpo/skills/ (project) and ~/.polpo/skills/ (global).
 */
export function skillRoutes(): OpenAPIHono<ServerEnv> {
  const app = new OpenAPIHono<ServerEnv>();

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

  app.openapi(listSkillsRoute, (c) => {
    const orchestrator = c.get("orchestrator");
    const workDir = orchestrator.getWorkDir();
    const polpoDir = orchestrator.getPolpoDir();

    // Get agent names from config (authoritative source) + filesystem fallback
    const configAgents = orchestrator.getAgents();
    const configAgentNames = configAgents.map(a => a.name);
    const fsAgentNames = getAgentNames(polpoDir);
    // Merge: config agents are authoritative, fs agents catch orphaned symlink dirs
    const allAgentNames = [...new Set([...configAgentNames, ...fsAgentNames])];

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
    const orchestrator = c.get("orchestrator");
    const polpoDir = orchestrator.getPolpoDir();

    const body = c.req.valid("json");

    const result = installSkills(body.source, polpoDir, {
      skillNames: body.skillNames,
      global: body.global,
      force: body.force,
    });

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
      409: {
        content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string(), code: z.string() }) } },
        description: "Skill already exists",
      },
    },
  });

  app.openapi(createSkillRoute, (c) => {
    const orchestrator = c.get("orchestrator");
    const polpoDir = orchestrator.getPolpoDir();
    const workDir = orchestrator.getWorkDir();
    const body = c.req.valid("json");

    const existing = discoverSkills(workDir, polpoDir);
    if (existing.some(s => s.name === body.name)) {
      return c.json({ ok: false, error: `Skill "${body.name}" already exists`, code: "CONFLICT" }, 409);
    }

    const skillPath = createAgentSkill(polpoDir, body.name, body.description, body.content, {
      allowedTools: body.allowedTools,
      global: body.global,
    });
    return c.json({ ok: true, data: { name: body.name, path: skillPath } }, 201);
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
    const orchestrator = c.get("orchestrator");
    const polpoDir = orchestrator.getPolpoDir();
    const { name } = c.req.valid("param");
    const { global: globalParam } = c.req.valid("query");
    const global = globalParam === "true";

    const removed = removeSkill(polpoDir, name, global);
    if (!removed) {
      return c.json({ ok: false, error: "Skill not found", code: "NOT_FOUND" }, 404);
    }

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
    const orchestrator = c.get("orchestrator");
    const workDir = orchestrator.getWorkDir();
    const polpoDir = orchestrator.getPolpoDir();
    const { name: skillName } = c.req.valid("param");
    const { agent } = c.req.valid("json");

    // Find skill in pool
    const pool = discoverSkills(workDir, polpoDir);
    const skill = pool.find(s => s.name === skillName);
    if (!skill) {
      return c.json({ ok: false, error: "Skill not found", code: "NOT_FOUND" }, 404);
    }

    assignSkillToAgent(polpoDir, agent, skillName, skill.path);
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
    const orchestrator = c.get("orchestrator");
    const polpoDir = orchestrator.getPolpoDir();
    const { name: skillName } = c.req.valid("param");
    const { agent } = c.req.valid("json");

    const removed = unassignSkillFromAgent(polpoDir, agent, skillName);
    if (!removed) {
      return c.json({ ok: false, error: "Assignment not found", code: "NOT_FOUND" }, 404);
    }
    return c.json({ ok: true, data: { skill: skillName, agent } }, 200);
  });

  // GET /skills/:name/content — get agent skill content
  const getSkillContentRoute = createRoute({
    method: "get",
    path: "/{name}/content",
    tags: ["Skills"],
    summary: "Get skill content",
    request: {
      params: z.object({ name: z.string() }),
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
    const orchestrator = c.get("orchestrator");
    const polpoDir = orchestrator.getPolpoDir();
    const workDir = orchestrator.getWorkDir();
    const { name } = c.req.valid("param");

    const skill = getSkillByName(workDir, polpoDir, name, "agent");
    if (!skill) {
      return c.json({ ok: false, error: `Skill "${name}" not found`, code: "NOT_FOUND" }, 404);
    }
    return c.json({ ok: true, data: skill }, 200);
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
    const orchestrator = c.get("orchestrator");
    const skills = discoverOrchestratorSkills(orchestrator.getPolpoDir());
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
    const orchestrator = c.get("orchestrator");
    const polpoDir = orchestrator.getPolpoDir();
    const body = c.req.valid("json");

    const existing = discoverOrchestratorSkills(polpoDir);
    if (existing.some(s => s.name === body.name)) {
      return c.json({ ok: false, error: `Skill "${body.name}" already exists`, code: "CONFLICT" }, 409);
    }

    const skillPath = createOrchestratorSkill(polpoDir, body.name, body.description, body.content, {
      allowedTools: body.allowedTools,
    });
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
            }),
          },
        },
      },
    },
    responses: {
      200: {
        content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.object({ name: z.string() }) }) } },
        description: "Skill updated",
      },
      404: {
        content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string(), code: z.string() }) } },
        description: "Skill not found",
      },
    },
  });

  app.openapi(updateOrchSkillRoute, (c) => {
    const orchestrator = c.get("orchestrator");
    const polpoDir = orchestrator.getPolpoDir();
    const { name } = c.req.valid("param");
    const body = c.req.valid("json");

    const ok = updateOrchestratorSkill(polpoDir, name, body);
    if (!ok) {
      return c.json({ ok: false, error: `Skill "${name}" not found`, code: "NOT_FOUND" }, 404);
    }
    return c.json({ ok: true, data: { name } }, 200);
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
    const orchestrator = c.get("orchestrator");
    const polpoDir = orchestrator.getPolpoDir();
    const { name } = c.req.valid("param");

    const removed = removeOrchestratorSkill(polpoDir, name);
    if (!removed) {
      return c.json({ ok: false, error: "Skill not found", code: "NOT_FOUND" }, 404);
    }
    return c.json({ ok: true, data: { removed: name } }, 200);
  });

  // GET /skills/orchestrator/:name/content — get orchestrator skill content
  const getOrchSkillContentRoute = createRoute({
    method: "get",
    path: "/orchestrator/{name}/content",
    tags: ["Skills"],
    summary: "Get orchestrator content",
    request: {
      params: z.object({ name: z.string() }),
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
    const orchestrator = c.get("orchestrator");
    const polpoDir = orchestrator.getPolpoDir();
    const workDir = orchestrator.getWorkDir();
    const { name } = c.req.valid("param");

    const skill = getSkillByName(workDir, polpoDir, name, "orchestrator");
    if (!skill) {
      return c.json({ ok: false, error: `Skill "${name}" not found`, code: "NOT_FOUND" }, 404);
    }
    return c.json({ ok: true, data: skill }, 200);
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
    const orchestrator = c.get("orchestrator");
    const polpoDir = orchestrator.getPolpoDir();
    const body = c.req.valid("json");

    const result = installOrchestratorSkills(body.source, polpoDir, {
      skillNames: body.skillNames,
      force: body.force,
    });

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
    const orchestrator = c.get("orchestrator");
    const polpoDir = orchestrator.getPolpoDir();
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
    },
  });

  app.openapi(updateSkillIndexRoute, (c) => {
    const orchestrator = c.get("orchestrator");
    const polpoDir = orchestrator.getPolpoDir();
    const { name } = c.req.valid("param");
    const body = c.req.valid("json");

    updateSkillIndex(polpoDir, name, body);
    return c.json({ ok: true, data: { skill: name, ...body } });
  });

  return app;
}

function getAgentNames(polpoDir: string): string[] {
  const agentsDir = resolve(polpoDir, "agents");
  if (!existsSync(agentsDir)) return [];
  try {
    return readdirSync(agentsDir, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name);
  } catch { return []; }
}
