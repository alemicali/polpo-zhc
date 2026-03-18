/**
 * Skill routes — discover, list, read, create, delete, assign/unassign.
 *
 * Uses FileSystem abstraction so it works on any backend:
 *   - NodeFileSystem (self-hosted)
 *   - SandboxProxyFS (cloud, lazy)
 *
 * Install from GitHub (git clone) is NOT included — that's shell-specific
 * and stays in the root src/server/routes/skills.ts.
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { resolve, join } from "node:path";
import type { FileSystem } from "@polpo-ai/core";
// Dynamic import to work around workspace version resolution.
// At publish time, @polpo-ai/core@^0.3.5 will be resolved correctly.
// @ts-ignore — resolved at publish time with @polpo-ai/core@^0.3.5
const coreImport = (): Promise<any> => import("@polpo-ai/core");

// Types inlined — mirror @polpo-ai/core/skills-reader types.
interface SkillInfo {
  name: string;
  description: string;
  allowedTools?: string[];
  source: "project" | "global";
  path: string;
  tags?: string[];
  category?: string;
}

interface LoadedSkill extends SkillInfo {
  content: string;
}

type SkillIndex = Record<string, { tags?: string[]; category?: string }>;

// ── Dependencies ──

export interface SkillRouteDeps {
  polpoDir: string;
  fs: FileSystem;
  getAgents: () => Promise<Array<{ name: string; skills?: string[] }>>;
  /** Update an agent's skills list. Used for assign/unassign. */
  updateAgentSkills?: (agentName: string, skills: string[]) => Promise<void>;
}

// ── Helpers ──

async function loadSkillIndex(fs: FileSystem, polpoDir: string): Promise<SkillIndex | null> {
  const indexPath = join(polpoDir, "skills-index.json");
  if (!(await fs.exists(indexPath))) return null;
  try {
    const raw = await fs.readFile(indexPath);
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as SkillIndex;
  } catch { return null; }
}

async function saveSkillIndex(fs: FileSystem, polpoDir: string, index: SkillIndex): Promise<void> {
  await fs.mkdir(polpoDir).catch(() => {});
  await fs.writeFile(join(polpoDir, "skills-index.json"), JSON.stringify(index, null, 2) + "\n");
}

async function loadSkillContent(fs: FileSystem, info: SkillInfo): Promise<LoadedSkill | null> {
  const skillPath = resolve(info.path, "SKILL.md");
  try {
    const raw = await fs.readFile(skillPath);
    const core = await coreImport();
    return { ...info, content: core.extractSkillBody(raw) };
  } catch { return null; }
}

// ── Route factory ──

export function skillRoutes(getDeps: () => SkillRouteDeps): OpenAPIHono {
  const app = new OpenAPIHono();

  // GET / — list skills with assignments
  app.openapi(
    createRoute({
      method: "get", path: "/", tags: ["Skills"], summary: "List skills with agent assignments",
      responses: { 200: { content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.array(z.any()) }) } }, description: "Skills list" } },
    }),
    async (c) => {
      const { fs, polpoDir, getAgents } = getDeps();
      const agents = await getAgents();
      const agentNames = agents.map((a) => a.name);
      const configSkills = new Map<string, string[]>();
      for (const a of agents) {
        if (a.skills?.length) configSkills.set(a.name, a.skills);
      }
      const core = await coreImport();
      const skills = await core.listSkillsWithAssignments(fs, polpoDir, agentNames, configSkills);
      return c.json({ ok: true, data: skills });
    },
  );

  // GET /:name/content — full skill content
  app.openapi(
    createRoute({
      method: "get", path: "/:name/content", tags: ["Skills"], summary: "Get skill content",
      request: { params: z.object({ name: z.string() }) },
      responses: {
        200: { content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.any() }) } }, description: "Skill content" },
        404: { content: { "application/json": { schema: z.object({ ok: z.literal(false), error: z.string() }) } }, description: "Not found" },
      },
    }),
    async (c: any) => {
      const { fs, polpoDir } = getDeps();
      const name = c.req.param("name");
      const core = await coreImport();
      const pool = await core.discoverSkills(fs, polpoDir) as SkillInfo[];
      const info = pool.find((s) => s.name === name);
      if (!info) return c.json({ ok: false, error: "Skill not found" }, 404);
      const loaded = await loadSkillContent(fs, info);
      if (!loaded) return c.json({ ok: false, error: "Could not load skill content" }, 404);
      return c.json({ ok: true, data: loaded });
    },
  );

  // GET /index — skills index (tags, categories)
  app.openapi(
    createRoute({
      method: "get", path: "/index", tags: ["Skills"], summary: "Get skills index",
      responses: { 200: { content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.any() }) } }, description: "Skills index" } },
    }),
    async (c) => {
      const { fs, polpoDir } = getDeps();
      const index = await loadSkillIndex(fs, polpoDir);
      return c.json({ ok: true, data: index ?? {} });
    },
  );

  // PUT /:name/index — update skill index entry (tags, category)
  app.openapi(
    createRoute({
      method: "put", path: "/:name/index", tags: ["Skills"], summary: "Update skill index entry",
      request: {
        params: z.object({ name: z.string() }),
        body: { content: { "application/json": { schema: z.object({ tags: z.array(z.string()).optional(), category: z.string().optional() }) } } },
      },
      responses: { 200: { content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.any() }) } }, description: "Updated" } },
    }),
    async (c: any) => {
      const { fs, polpoDir } = getDeps();
      const name = c.req.param("name");
      const body = await c.req.json();
      const index = (await loadSkillIndex(fs, polpoDir)) ?? {};
      index[name] = { ...index[name], ...body };
      if (index[name].tags?.length === 0) delete index[name].tags;
      if (!index[name].category) delete index[name].category;
      if (Object.keys(index[name]).length === 0) delete index[name];
      await saveSkillIndex(fs, polpoDir, index);
      return c.json({ ok: true, data: { skill: name, ...body } });
    },
  );

  // POST /create — create a new skill
  app.openapi(
    createRoute({
      method: "post", path: "/create", tags: ["Skills"], summary: "Create a new skill",
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
        200: { content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.any() }) } }, description: "Created" },
        400: { content: { "application/json": { schema: z.object({ ok: z.literal(false), error: z.string() }) } }, description: "Error" },
      },
    }),
    async (c: any) => {
      const { fs, polpoDir } = getDeps();
      const { name, description, content, allowedTools } = await c.req.json();

      const targetDir = join(polpoDir, "skills", name);
      if (await fs.exists(targetDir)) {
        return c.json({ ok: false, error: `Skill "${name}" already exists` }, 400);
      }

      await fs.mkdir(targetDir);

      const fmLines = [`---`, `name: ${name}`, `description: ${description}`];
      if (allowedTools?.length) {
        fmLines.push(`allowed-tools:`);
        for (const t of allowedTools) fmLines.push(`  - ${t}`);
      }
      fmLines.push(`---`, ``);

      await fs.writeFile(join(targetDir, "SKILL.md"), fmLines.join("\n") + content);
      return c.json({ ok: true, data: { name, path: targetDir } });
    },
  );

  // DELETE /:name — remove a skill
  app.openapi(
    createRoute({
      method: "delete", path: "/:name", tags: ["Skills"], summary: "Remove a skill",
      request: { params: z.object({ name: z.string() }) },
      responses: {
        200: { content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.any() }) } }, description: "Removed" },
        404: { content: { "application/json": { schema: z.object({ ok: z.literal(false), error: z.string() }) } }, description: "Not found" },
      },
    }),
    async (c: any) => {
      const { fs, polpoDir } = getDeps();
      const name = c.req.param("name");
      const targetDir = join(polpoDir, "skills", name);
      if (!(await fs.exists(targetDir))) {
        return c.json({ ok: false, error: "Skill not found" }, 404);
      }
      await fs.remove(targetDir);
      return c.json({ ok: true, data: { removed: true, name } });
    },
  );

  // POST /:name/assign — assign skill to agent
  app.openapi(
    createRoute({
      method: "post", path: "/:name/assign", tags: ["Skills"], summary: "Assign skill to agent",
      request: {
        params: z.object({ name: z.string() }),
        body: { content: { "application/json": { schema: z.object({ agent: z.string().min(1) }) } } },
      },
      responses: {
        200: { content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.any() }) } }, description: "Assigned" },
        400: { content: { "application/json": { schema: z.object({ ok: z.literal(false), error: z.string() }) } }, description: "Error" },
      },
    }),
    async (c: any) => {
      const { getAgents, updateAgentSkills } = getDeps();
      const skillName = c.req.param("name");
      const { agent: agentName } = await c.req.json();

      if (!updateAgentSkills) {
        return c.json({ ok: false, error: "Skill assignment not supported" }, 400);
      }

      const agents = await getAgents();
      const agent = agents.find((a) => a.name === agentName);
      if (!agent) return c.json({ ok: false, error: `Agent "${agentName}" not found` }, 400);

      const current = agent.skills ?? [];
      if (!current.includes(skillName)) {
        await updateAgentSkills(agentName, [...current, skillName]);
      }

      return c.json({ ok: true, data: { skill: skillName, agent: agentName } });
    },
  );

  // POST /:name/unassign — unassign skill from agent
  app.openapi(
    createRoute({
      method: "post", path: "/:name/unassign", tags: ["Skills"], summary: "Unassign skill from agent",
      request: {
        params: z.object({ name: z.string() }),
        body: { content: { "application/json": { schema: z.object({ agent: z.string().min(1) }) } } },
      },
      responses: {
        200: { content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.any() }) } }, description: "Unassigned" },
        400: { content: { "application/json": { schema: z.object({ ok: z.literal(false), error: z.string() }) } }, description: "Error" },
      },
    }),
    async (c: any) => {
      const { getAgents, updateAgentSkills } = getDeps();
      const skillName = c.req.param("name");
      const { agent: agentName } = await c.req.json();

      if (!updateAgentSkills) {
        return c.json({ ok: false, error: "Skill assignment not supported" }, 400);
      }

      const agents = await getAgents();
      const agent = agents.find((a) => a.name === agentName);
      if (!agent) return c.json({ ok: false, error: `Agent "${agentName}" not found` }, 400);

      const current = agent.skills ?? [];
      await updateAgentSkills(agentName, current.filter((s) => s !== skillName));

      return c.json({ ok: true, data: { skill: skillName, agent: agentName } });
    },
  );

  return app;
}
