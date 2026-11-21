/**
 * The team: read, create and configure agents (model, role, prompt, tools, skills, identity).
 * Changes need polpo:admin, as they change who works on the instance and with which tools.
 */
import { z } from "zod";
import { READ, UPDATE, WRITE, apiError, apiGet, apiSend, enc, fail, looseObject, ok, short, type McpDeps, type Register } from "./kit.js";

const identity = z.object({
  displayName: z.string().optional().describe("A person-like name, e.g. Alice Chen"),
  title: z.string().optional().describe("A job title, e.g. Head of Growth"),
  company: z.string().optional().describe("The company it works for"),
}).passthrough();

const agentFields = {
  role: z.string().optional().describe("What it does, in a line (shown everywhere)"),
  model: z.string().optional().describe("provider:model (polpo_models_list); omit for the default"),
  systemPrompt: z.string().optional().describe("Its instructions: how it works, what it must and must not do"),
  allowedTools: z.array(z.string()).optional().describe("Tools it may use (patterns allowed, e.g. browser_*, mcp__linear__*); omit for the defaults"),
  skills: z.array(z.string()).optional().describe("Names of skills it uses"),
  identity: identity.optional().describe("How it presents itself"),
  reportsTo: z.string().optional().describe("The agent it reports to"),
  maxTurns: z.number().int().positive().max(1000).optional().describe("Most steps per run"),
};

type Agent = { name: string; role?: string; model?: string; systemPrompt?: string; allowedTools?: string[]; skills?: string[]; identity?: { displayName?: string; title?: string }; reportsTo?: string };

async function loadAgent(deps: McpDeps, name: string): Promise<{ ok: true; agent: Agent } | { ok: false; status: number; error: string }> {
  const r = await apiGet(deps, `/agents/${enc(name)}`);
  return r.ok ? { ok: true, agent: r.data as Agent } : r;
}

export function registerTeamTools(tool: Register, deps: McpDeps): void {
  tool("team", "polpo_agent_get", {
    title: "Get an agent",
    description: "One agent's configuration: role, model, instructions, tools, skills, identity and who it reports to. "
      + "polpo_agent_show shows how it is doing instead.",
    inputSchema: { name: z.string().min(1).describe("The agent's name (polpo_agents_list)") },
    outputSchema: { agent: looseObject },
    annotations: READ,
  }, async ({ name }) => {
    const r = await loadAgent(deps, name);
    if (!r.ok) return r.status === 404 ? fail(`There is no agent "${name}". Find the name with polpo_agents_list.`) : apiError(r, `Reading agent ${name}`);
    const a = r.agent;
    const text = [
      `${a.name}${a.identity?.displayName ? ` (${a.identity.displayName}${a.identity.title ? `, ${a.identity.title}` : ""})` : ""}: ${a.role ?? "no role"}`,
      `model: ${a.model ?? "default"}${a.reportsTo ? ` · reports to ${a.reportsTo}` : ""}`,
      `tools: ${a.allowedTools?.join(", ") ?? "defaults"} · skills: ${a.skills?.join(", ") || "none"}`,
      ...(a.systemPrompt ? ["", short(a.systemPrompt, 3000)] : []),
    ].join("\n");
    return ok(text, { agent: a as Record<string, unknown> });
  });

  tool("team", "polpo_agent_create", {
    title: "Create an agent",
    description: "Add an agent to the team: a name, what it does and, optionally, its model, instructions, tools, skills and identity. "
      + "It can take tasks right away. Ask the person before adding agents they did not ask for.",
    inputSchema: {
      name: z.string().min(1).max(60).regex(/^[a-z0-9][a-z0-9_-]*$/i, "letters, digits, - and _").describe("A short unique name, e.g. growth-analyst"),
      ...agentFields,
      team: z.string().optional().describe("The team to add it to (default the main team)"),
    },
    outputSchema: { agent: looseObject },
    annotations: WRITE,
  }, async ({ team, ...body }) => {
    const exists = await loadAgent(deps, body.name);
    if (exists.ok) return fail(`There is already an agent "${body.name}": choose another name, or change it with polpo_agent_update.`);
    const r = await apiSend(deps, "POST", `/agents${team ? `?team=${enc(team)}` : ""}`, body);
    if (!r.ok) return apiError(r, `Creating agent ${body.name}`);
    const created = await loadAgent(deps, body.name);
    return ok(`Created agent ${body.name}${body.role ? `: ${body.role}` : ""}.`, { agent: (created.ok ? created.agent : body) as Record<string, unknown> });
  });

  tool("team", "polpo_agent_update", {
    title: "Update an agent",
    description: "Change an agent's role, model, instructions, tools, skills, identity or manager. Only the fields given change "
      + "(a list given replaces the old one); the result lists what changed. It applies to its next runs.",
    inputSchema: {
      name: z.string().min(1).describe("The agent's name"),
      ...agentFields,
    },
    outputSchema: { agent: looseObject, changed: z.array(z.string()) },
    annotations: UPDATE,
  }, async ({ name, ...patch }) => {
    const before = await loadAgent(deps, name);
    if (!before.ok) return before.status === 404 ? fail(`There is no agent "${name}". Find the name with polpo_agents_list.`) : apiError(before, `Reading agent ${name}`);
    const body = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    if (Object.keys(body).length === 0) return fail("Nothing to change: give at least one field (role, model, systemPrompt, allowedTools, skills, identity, reportsTo, maxTurns).");
    const r = await apiSend(deps, "PATCH", `/agents/${enc(name)}`, body);
    if (!r.ok) return apiError(r, `Updating agent ${name}`);
    const after = await loadAgent(deps, name);
    const agent = (after.ok ? after.agent : { ...before.agent, ...body }) as Record<string, unknown>;
    const changed = Object.keys(body).filter((k) => JSON.stringify((before.agent as Record<string, unknown>)[k]) !== JSON.stringify(agent[k]));
    return ok(changed.length ? `Updated ${name}: ${changed.join(", ")}.` : `Nothing changed on ${name} (the values were the same).`, { agent, changed });
  });
}
