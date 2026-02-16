import { Hono } from "hono";
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
export function skillRoutes(): Hono<ServerEnv> {
  const app = new Hono<ServerEnv>();

  // GET /skills — list skills with agent assignments
  app.get("/", (c) => {
    const orchestrator = c.get("orchestrator");
    const workDir = orchestrator.getWorkDir();
    const polpoDir = orchestrator.getPolpoDir();
    const agentNames = getAgentNames(polpoDir);
    const skills = listSkillsWithAssignments(workDir, polpoDir, agentNames);
    return c.json({ ok: true, data: skills });
  });

  // POST /skills/add — install skills from a source
  app.post("/add", async (c) => {
    const orchestrator = c.get("orchestrator");
    const polpoDir = orchestrator.getPolpoDir();

    const body = await c.req.json<{
      source: string;
      skillNames?: string[];
      global?: boolean;
      force?: boolean;
    }>().catch(() => null);

    if (!body?.source) {
      return c.json({ ok: false, error: "Missing required field: source", code: "VALIDATION_ERROR" }, 400);
    }

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
  app.delete("/:name", (c) => {
    const orchestrator = c.get("orchestrator");
    const polpoDir = orchestrator.getPolpoDir();
    const name = c.req.param("name");
    const global = c.req.query("global") === "true";

    const removed = removeSkill(polpoDir, name, global);
    if (!removed) {
      return c.json({ ok: false, error: "Skill not found", code: "NOT_FOUND" }, 404);
    }

    return c.json({ ok: true, data: { removed: name } });
  });

  // POST /skills/:name/assign — assign a skill to an agent
  app.post("/:name/assign", async (c) => {
    const orchestrator = c.get("orchestrator");
    const workDir = orchestrator.getWorkDir();
    const polpoDir = orchestrator.getPolpoDir();
    const skillName = c.req.param("name");

    const body = await c.req.json<{ agent: string }>().catch(() => null);
    if (!body?.agent) {
      return c.json({ ok: false, error: "Missing required field: agent", code: "VALIDATION_ERROR" }, 400);
    }

    // Find skill in pool
    const pool = discoverSkills(workDir, polpoDir);
    const skill = pool.find(s => s.name === skillName);
    if (!skill) {
      return c.json({ ok: false, error: "Skill not found", code: "NOT_FOUND" }, 404);
    }

    assignSkillToAgent(polpoDir, body.agent, skillName, skill.path);
    return c.json({ ok: true, data: { skill: skillName, agent: body.agent } });
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
