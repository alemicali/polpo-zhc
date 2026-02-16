import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { ServerEnv } from "../app.js";
import {
  discoverSkills,
  installSkills,
  removeSkill,
  assignSkillToAgent,
  listSkillsWithAssignments,
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
    summary: "List skills with agent assignments",
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
    const agentNames = getAgentNames(polpoDir);
    const skills = listSkillsWithAssignments(workDir, polpoDir, agentNames);
    return c.json({ ok: true, data: skills });
  });

  // POST /skills/add — install skills from a source
  const addSkillRoute = createRoute({
    method: "post",
    path: "/add",
    tags: ["Skills"],
    summary: "Install skills from a source",
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

  // DELETE /skills/:name — remove a skill from the pool
  const deleteSkillRoute = createRoute({
    method: "delete",
    path: "/{name}",
    tags: ["Skills"],
    summary: "Remove a skill from the pool",
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
    summary: "Assign a skill to an agent",
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
