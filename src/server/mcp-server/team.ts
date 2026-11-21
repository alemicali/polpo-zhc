/**
 * The team: read, create, configure and remove agents (model, role, prompt, tools, skills, identity,
 * avatar), and the teams they belong to. Changes need polpo:admin, as they change who works on the
 * instance and with which tools.
 */
import { z } from "zod";
import { MAX_LOGO_BYTES, fetchPublicImage, sniffImage } from "./config.js";
import {
  DESTRUCTIVE, READ, UPDATE, WRITE, apiError, apiGet, apiSend, confirmParam, enc, fail, looseObject, ok, qs, short,
  type McpDeps, type Register,
} from "./kit.js";

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
  browserEgress: z.string().regex(/^[A-Za-z0-9_-]*$/, "the name of an egress proxy").optional()
    .describe("Where its browser goes out to the internet: the name of a proxy in the settings' egress proxies (polpo_config_get); '' for direct"),
};

/** An error when browserEgress names a proxy the settings do not have, else null. */
async function unknownEgress(deps: McpDeps, name: string | undefined): Promise<string | null> {
  if (!name) return null;
  const r = await apiGet(deps, "/config");
  if (!r.ok) return null; // the API decides
  const proxies = Object.keys((r.data as { settings?: { egressProxies?: Record<string, string> } })?.settings?.egressProxies ?? {});
  return proxies.includes(name) ? null
    : `There is no egress proxy "${name}". ${proxies.length ? `Proxies: ${proxies.join(", ")}.` : "None is set:"} Add it with polpo_config_update egress_proxies.`;
}

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
    const egress = await unknownEgress(deps, body.browserEgress);
    if (egress) return fail(egress);
    const r = await apiSend(deps, "POST", `/agents${team ? `?team=${enc(team)}` : ""}`, body);
    if (!r.ok) return apiError(r, `Creating agent ${body.name}`);
    const created = await loadAgent(deps, body.name);
    return ok(`Created agent ${body.name}${body.role ? `: ${body.role}` : ""}.`, { agent: (created.ok ? created.agent : body) as Record<string, unknown> });
  });

  tool("team", "polpo_agent_update", {
    title: "Update an agent",
    description: "Change an agent's role, model, instructions, tools, skills, identity, manager or browser egress proxy. Only the fields given change "
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
    if (Object.keys(body).length === 0) return fail("Nothing to change: give at least one field (role, model, systemPrompt, allowedTools, skills, identity, reportsTo, maxTurns, browserEgress).");
    const egress = await unknownEgress(deps, patch.browserEgress);
    if (egress) return fail(egress);
    const r = await apiSend(deps, "PATCH", `/agents/${enc(name)}`, body);
    if (!r.ok) return apiError(r, `Updating agent ${name}`);
    const after = await loadAgent(deps, name);
    const agent = (after.ok ? after.agent : { ...before.agent, ...body }) as Record<string, unknown>;
    const changed = Object.keys(body).filter((k) => JSON.stringify((before.agent as Record<string, unknown>)[k]) !== JSON.stringify(agent[k]));
    return ok(changed.length ? `Updated ${name}: ${changed.join(", ")}.` : `Nothing changed on ${name} (the values were the same).`, { agent, changed });
  });

  tool("team", "polpo_agent_delete", {
    title: "Remove an agent",
    description: "Remove an agent from the team: it stops taking tasks and its configuration is deleted (its past tasks stay). "
      + "It cannot be undone. Needs confirm: true after the person agreed.",
    inputSchema: {
      name: z.string().min(1).describe("The agent's name"),
      confirm: confirmParam("remove the agent"),
    },
    outputSchema: { name: z.string(), removed: z.boolean() },
    annotations: DESTRUCTIVE,
  }, async ({ name, confirm }) => {
    const a = await loadAgent(deps, name);
    if (!a.ok) return a.status === 404 ? fail(`There is no agent "${name}". Find the name with polpo_agents_list.`) : apiError(a, `Reading agent ${name}`);
    if (confirm !== true) return fail(`Removing ${name} (${a.agent.role ?? "no role"}) deletes its configuration for good: ask the person, then call again with confirm: true.`);
    const r = await apiSend(deps, "DELETE", `/agents/${enc(name)}`);
    if (!r.ok) return apiError(r, `Removing agent ${name}`);
    return ok(`Removed agent ${name}.`, { name, removed: true });
  });

  tool("team", "polpo_agent_avatar_set", {
    title: "Set an agent's avatar",
    description: "Give an agent a picture, shown in the dashboard and chats: from a public https URL (fetched by the server), a file of the instance, "
      + "or base64 data; PNG, JPEG, WebP or GIF up to 4 MB. remove: true goes back to its initials.",
    inputSchema: {
      name: z.string().min(1).describe("The agent's name"),
      image: z.union([
        z.object({ url: z.string().url().describe("A public https URL of the image") }),
        z.object({ path: z.string().min(1).describe("A file of the instance, e.g. assets/alice.png") }),
        z.object({ base64: z.string().min(1).describe("The image's bytes in base64"), mime_type: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]).describe("Its type") }),
      ]).optional().describe("The picture: { url } or { path } or { base64, mime_type }"),
      remove: z.boolean().optional().describe("true to remove the avatar"),
    },
    outputSchema: { name: z.string(), avatar: z.string().nullable() },
    annotations: UPDATE,
  }, async ({ name, image, remove }) => {
    if (!image && !remove) return fail("Give image ({ url }, { path } or { base64, mime_type }) or remove: true.");
    if (image && remove) return fail("Give either image or remove, not both.");
    const a = await loadAgent(deps, name);
    if (!a.ok) return a.status === 404 ? fail(`There is no agent "${name}". Find the name with polpo_agents_list.`) : apiError(a, `Reading agent ${name}`);
    if (remove) {
      const r = await apiSend(deps, "DELETE", `/agents/${enc(name)}/avatar`);
      if (!r.ok) return apiError(r, `Removing ${name}'s avatar`);
      return ok(`Removed ${name}'s avatar.`, { name, avatar: null });
    }
    let bytes: Uint8Array;
    let type: string | undefined;
    if (image && "url" in image) {
      const got = await fetchPublicImage(deps, image.url);
      if (!got.ok) return fail(`The avatar was not changed: ${got.error}. Give another URL, a file of the instance (image.path) or base64 data.`);
      ({ bytes, type } = got);
    } else if (image && "path" in image) {
      const res = await deps.api("GET", `/api/v1/files/read${qs({ path: image.path })}`);
      if (res.status >= 400) return fail(`The avatar was not changed: cannot read ${image.path} (HTTP ${res.status}). Find the file with polpo_files_search.`);
      bytes = res.bytes ?? new Uint8Array();
      type = sniffImage(bytes);
    } else {
      const b = image as { base64: string; mime_type: string };
      bytes = new Uint8Array(Buffer.from(b.base64.replace(/^data:[^,]*,/, ""), "base64"));
      type = sniffImage(bytes);
      if (type && type !== b.mime_type) return fail(`The avatar was not changed: the data is ${type}, not ${b.mime_type}. Pass mime_type ${type}.`);
    }
    if (bytes.byteLength === 0) return fail("The avatar was not changed: the image is empty.");
    if (bytes.byteLength > MAX_LOGO_BYTES) return fail("The avatar was not changed: the image is larger than 4 MB.");
    if (!type) return fail("The avatar was not changed: it is not a PNG, JPEG, WebP or GIF image.");
    const form = new FormData();
    form.append("file", new File([bytes as Uint8Array<ArrayBuffer>], `${name}.${type.split("/")[1] === "jpeg" ? "jpg" : type.split("/")[1]}`, { type }));
    const r = await apiSend(deps, "POST", `/agents/${enc(name)}/avatar`, form);
    if (!r.ok) return apiError(r, `Setting ${name}'s avatar`);
    const avatar = (r.data as { avatar?: string } | undefined)?.avatar ?? null;
    return ok(`Set ${name}'s avatar${avatar ? ` (${avatar})` : ""}.`, { name, avatar });
  });

  const teamItem = z.object({ name: z.string(), description: z.string().optional(), agents: z.array(z.string()) });
  type Team = { name: string; description?: string; agents?: Array<string | { name: string }> };
  const loadTeams = async () => {
    const r = await apiGet(deps, "/agents/teams");
    return r.ok ? { ok: true as const, teams: ((r.data as Team[]) ?? []).map((t) => ({ name: t.name, ...(t.description ? { description: t.description } : {}), agents: (t.agents ?? []).map((a) => typeof a === "string" ? a : a.name) })) } : r;
  };

  tool("team", "polpo_teams_list", {
    title: "List teams",
    description: "The teams and the agents in each (the first is the main team, where new agents go by default).",
    inputSchema: {},
    outputSchema: { items: z.array(teamItem) },
    annotations: READ,
  }, async () => {
    const t = await loadTeams();
    if (!t.ok) return apiError(t, "Listing teams");
    return ok(t.teams.map((x) => `- ${x.name}${x.description ? `: ${short(x.description, 100)}` : ""} (${x.agents.join(", ") || "no agents"})`).join("\n") || "No teams.", { items: t.teams });
  });

  tool("team", "polpo_team_save", {
    title: "Create or change a team",
    description: "Create a team (name, description), rename one (new_name), or move agents into it (add_agents: they leave their current team). "
      + "To take an agent out, move it into another team. Returns the team as it is now.",
    inputSchema: {
      name: z.string().min(1).max(80).describe("The team's name (an existing one to change it, a new one to create it)"),
      description: z.string().max(500).optional().describe("What the team is for (only when creating it)"),
      new_name: z.string().min(1).max(80).optional().describe("Rename the team to this"),
      add_agents: z.array(z.string().min(1)).optional().describe("Agents to move into this team (polpo_agents_list)"),
    },
    outputSchema: { team: teamItem, created: z.boolean(), changed: z.array(z.string()) },
    annotations: WRITE,
  }, async ({ name, description, new_name, add_agents }) => {
    const before = await loadTeams();
    if (!before.ok) return apiError(before, "Listing teams");
    const existing = before.teams.find((t) => t.name === name);
    const changed: string[] = [];
    if (!existing) {
      if (new_name) return fail(`There is no team "${name}" to rename. Teams: ${before.teams.map((t) => t.name).join(", ")}.`);
      const r = await apiSend(deps, "POST", "/agents/teams", { name, ...(description ? { description } : {}) });
      if (!r.ok) return apiError(r, `Creating team ${name}`);
    } else if (description !== undefined && description !== existing.description) {
      return fail("A team's description is set when it is created; it cannot be changed here.");
    }
    let current = name;
    if (new_name && new_name !== name) {
      if (before.teams.some((t) => t.name === new_name)) return fail(`There is already a team "${new_name}".`);
      const r = await apiSend(deps, "PATCH", "/agents/team", { oldName: name, name: new_name });
      if (!r.ok) return apiError(r, `Renaming team ${name}`);
      current = new_name;
      changed.push("name");
    }
    if (add_agents?.length) {
      const all = before.teams.flatMap((t) => t.agents);
      const missing = add_agents.filter((a) => !all.includes(a));
      if (missing.length) return fail(`No agent ${missing.map((m) => `"${m}"`).join(", ")}. Agents: ${all.join(", ") || "none"}.${changed.length || !existing ? " The team was saved." : ""}`);
      for (const agent of add_agents) {
        if (existing?.agents.includes(agent)) continue;
        const r = await apiSend(deps, "PATCH", `/agents/${enc(agent)}`, { team: current });
        if (!r.ok) return apiError(r, `Moving ${agent} into ${current}`);
        changed.push(`+${agent}`);
      }
    }
    const after = await loadTeams();
    const team = (after.ok ? after.teams.find((t) => t.name === current) : undefined) ?? { name: current, agents: add_agents ?? [] };
    return ok(`${existing ? (changed.length ? `Updated team ${current}: ${changed.join(", ")}` : `Nothing changed on team ${current}`) : `Created team ${current}`}. Agents: ${team.agents.join(", ") || "none"}.`,
      { team, created: !existing, changed });
  });

  tool("team", "polpo_team_delete", {
    title: "Delete a team",
    description: "Delete an empty team (move its agents to another team first with polpo_team_save). The last team cannot be deleted. Needs confirm: true.",
    inputSchema: {
      name: z.string().min(1).describe("The team's name"),
      confirm: confirmParam("delete the team"),
    },
    outputSchema: { name: z.string(), removed: z.boolean() },
    annotations: DESTRUCTIVE,
  }, async ({ name, confirm }) => {
    const t = await loadTeams();
    if (!t.ok) return apiError(t, "Listing teams");
    const team = t.teams.find((x) => x.name === name);
    if (!team) return fail(`There is no team "${name}". Teams: ${t.teams.map((x) => x.name).join(", ")}.`);
    if (team.agents.length) return fail(`Team ${name} still has agents (${team.agents.join(", ")}): move them to another team with polpo_team_save first.`);
    if (t.teams.length <= 1) return fail("This is the last team: it cannot be deleted.");
    if (confirm !== true) return fail(`Deleting team ${name} cannot be undone: ask the person, then call again with confirm: true.`);
    const r = await apiSend(deps, "DELETE", `/agents/teams/${enc(name)}`);
    if (!r.ok) return apiError(r, `Deleting team ${name}`);
    return ok(`Deleted team ${name}.`, { name, removed: true });
  });
}
