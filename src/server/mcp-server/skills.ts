/**
 * Skills (instructions agents load when a task calls for them): list, read, create, update,
 * install, delete, and assign them to agents. Changes need polpo:admin, as they change what agents do.
 */
import { z } from "zod";
import {
  BAD_CURSOR, DESTRUCTIVE, READ, UPDATE, WRITE, apiError, apiGet, apiSend, confirmParam, cursorParam, enc, fail, limitParam, looseObject,
  ok, page, pageOutput, short,
  type McpDeps, type Register,
} from "./kit.js";
import { unknownAgents } from "./tasks.js";

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
    const s = r.data as Skill & { path?: string };
    const { path: _path, ...skill } = s;
    return ok(`${s.name} (${s.source}): ${s.description}${s.allowedTools?.length ? `\ntools: ${s.allowedTools.join(", ")}` : ""}\n\n${s.content ?? ""}`, { skill });
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
}
