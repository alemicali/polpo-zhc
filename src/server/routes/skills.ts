import { Hono } from "hono";
import type { ServerEnv } from "../app.js";
import { discoverSkills } from "../../llm/skills.js";

/**
 * Skill discovery routes.
 * Exposes the project-level skill pool from .polpo/skills/, .claude/skills/,
 * and ~/.claude/skills/.
 */
export function skillRoutes(): Hono<ServerEnv> {
  const app = new Hono<ServerEnv>();

  // GET /skills — discover available skills in the project
  app.get("/", (c) => {
    const orchestrator = c.get("orchestrator");
    const workDir = orchestrator.getWorkDir();
    const polpoDir = orchestrator.getPolpoDir();
    const skills = discoverSkills(workDir, polpoDir);
    return c.json({ ok: true, data: skills });
  });

  return app;
}
