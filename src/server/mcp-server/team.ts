/**
 * The team: read, create, configure and remove agents (model, role, prompt, tools, skills, identity,
 * avatar), and the teams they belong to. Changes need polpo:admin, as they change who works on the
 * instance and with which tools.
 */
import { z } from "zod";
import { agentEffectiveModel, agentEngineIdOf, modelWithEngineText } from "@polpo-ai/core/engine-label";
import { AGENT_NOTIFY_TOOL, agentNotifyPerMinute, allowedToolsInclude, describeAgentNotifyAllowlist, type AgentNotifyChannels } from "@polpo-ai/core";
import { MAX_LOGO_BYTES, fetchPublicImage, sniffImage } from "./config.js";
import {
  DESTRUCTIVE, READ, UPDATE, WRITE, apiError, apiGet, apiSend, confirmParam, dashboardLink, enc, fail, hasScope, looseObject, ok, qs, short,
  type McpDeps, type Register,
} from "./kit.js";

const identity = z.object({
  displayName: z.string().optional().describe("A person-like name, e.g. Alice Chen"),
  title: z.string().optional().describe("A job title, e.g. Head of Growth"),
  company: z.string().optional().describe("The company it works for"),
  color: z.string().regex(/^agent(?:[1-9]|10)$/, "an agent colour token: agent1 … agent10").optional()
    .describe("Its colour on screen (avatar, badges): an agent colour token agent1 … agent10 of the instance's look (polpo_branding_update tokens agent1…); omit to pick one from its name"),
}).passthrough();

/** Per-connector tool selection: { <connector id>: "*" | [raw MCP tool names] }. */
const connectorToolsParam = z.record(
  z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, "a connector id"),
  z.union([z.literal("*"), z.array(z.string().min(1).max(200)).max(1000)]),
);
const CONNECTOR_TOOLS_HELP = "Which tools of each connector granted to it the agent gets, keyed by connector id: \"*\" (or no key) = all its tools, current and future; "
  + "a list = only those tools (the server's tool names as polpo_connectors_list with id shows them, not mcp__…). It never grants a connector (polpo_connector_update_access does).";

/** Notification channels an agent may post to (send_notification). */
const notifyChannelsParam = z.union([
  z.literal("*"),
  z.array(z.object({
    channel: z.string().min(1).max(64).describe("A configured channel's name (polpo_channels_list), e.g. slack"),
    targets: z.array(z.string().min(1).max(320)).max(100).optional()
      .describe("Targets it may pick with `to`: Slack channel ids (C0…), Telegram chat ids, email addresses, or \"*\" for any; omit for the channel's default target only"),
  })).max(50),
]);
const NOTIFY_CHANNELS_HELP = "Notification channels it may post to with its send_notification tool (Slack as the Polpo bot, Telegram, email, webhook, push…): "
  + "\"*\" = every configured channel's default target, or a list of { channel, targets? }. The agent also needs send_notification in allowedTools. "
  + "A channel not configured yet is kept, with a warning.";

/** "slack (to: C0LEADS) · max 5/min" or why it has no tool. */
function notifyLine(a: { allowedTools?: string[]; notifyChannels?: AgentNotifyChannels; notifyRateLimit?: number }): string | undefined {
  const has = a.notifyChannels === "*" || (Array.isArray(a.notifyChannels) && a.notifyChannels.length > 0);
  if (!has) return undefined;
  const toolOn = allowedToolsInclude(a.allowedTools, AGENT_NOTIFY_TOOL);
  return `notifications: ${describeAgentNotifyAllowlist(a.notifyChannels)} · max ${agentNotifyPerMinute(a)}/min`
    + (toolOn ? "" : ` · ⚠ off: add ${AGENT_NOTIFY_TOOL} to allowedTools`);
}

const agentFields = {
  role: z.string().optional().describe("What it does, in a line (shown everywhere)"),
  model: z.string().optional().describe("provider:model (polpo_models_list); omit for the default"),
  systemPrompt: z.string().optional().describe("Its instructions: how it works, what it must and must not do"),
  allowedTools: z.array(z.string()).optional().describe("Tools it may use (patterns allowed, e.g. browser_*, artifact_* to make artifacts people open in Polpo, "
    + "mcp__linear__*); omit for the defaults. An agent on a harness engine (Claude Code, Codex, OpenCode) gets the Polpo tools listed here too (artifacts, email, data…), run on the Polpo server"),
  skills: z.array(z.string()).optional().describe("Names of skills it uses"),
  identity: identity.optional().describe("How it presents itself"),
  reportsTo: z.string().optional().describe("The agent it reports to (its manager: it can always escalate to it)"),
  talksTo: z.object({
    mode: z.enum(["org", "list", "anyone", "none"]).describe("org: its manager, its direct reports and the extra agents (the default for new agents); "
      + "list: only the listed agents; anyone: every agent; none: no agent. Polpo always talks to it"),
    agents: z.array(z.string().min(1)).optional().describe("Extra agents (org) or the only agents (list)"),
    acceptFrom: z.enum(["anyone", "lines"]).optional().describe("lines: it also refuses senders outside its own lines (default anyone)"),
  }).optional().describe("Its communication lines: which agents it may talk to (ask_agent, message_agent) and set off in rooms (polpo_agent_lines shows the team's)"),
  maxTurns: z.number().int().positive().max(1000).optional().describe("Most steps per run"),
  notifyChannels: notifyChannelsParam.optional().describe(NOTIFY_CHANNELS_HELP),
  notifyRateLimit: z.number().int().min(1).max(60).optional().describe("send_notification messages per minute (default 5)"),
  browserEgress: z.string().regex(/^[A-Za-z0-9_-]*$/, "the name of an egress proxy").optional()
    .describe("Where its browser goes out to the internet: the name of a proxy in the settings' egress proxies (polpo_config_get); '' for direct"),
  browserHeaded: z.boolean().optional()
    .describe("true: its browser (always real Google Chrome) runs headed (a visible window on its computer's virtual display), so a person can watch it live and take control (login, 2FA, CAPTCHA) from the computer's page; false: headless. Unset: headed on a remote computer (Daytona, E2B), headless on this server"),
  computers: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/)).optional()
    .describe("Computers it may use (ids from polpo_computers_list); \"host\" (this server) always"),
  defaultComputer: z.string().regex(/^([a-z0-9][a-z0-9-]{0,39})?$/).optional()
    .describe("The computer its chats and tasks run on (polpo_computers_list); \"host\" or '' for this server"),
  engine: z.union([
    z.literal("polpo"),
    z.object({
      harness: z.enum(["claude-code", "codex", "opencode"]).describe("The official agent runtime (it must be enabled: polpo_harnesses_get). opencode: any model, open-weight ones included (Kimi, GLM, Qwen on Bedrock or a gateway)"),
      model: z.string().max(200).optional().describe("Model id for the runtime (Bedrock: an inference profile id; OpenCode: the provider's id, e.g. global.moonshotai.kimi-k3.1); omit for the harness setting's"),
      permissionMode: z.enum(["allow-all", "allow-edits", "allow-reads"]).optional().describe("What the runtime may do without asking (default allow-all: it works unattended in its computer)"),
      effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional().describe("Reasoning effort"),
      maxBudgetUsd: z.number().positive().max(10000).optional().describe("Stop a run when its estimated spend passes this (USD)"),
      credentialRef: z.object({ owner: z.string().min(1), service: z.string().min(1) }).optional()
        .describe("This agent's own key (cost separation): a vault entry (owner + service, never the key) that replaces the harness's API key or gateway key"),
    }),
    z.object({
      type: z.literal("cli").describe("The official CLI program (unmodified) signed in with a person's own account"),
      cli: z.enum(["claude", "codex"]).describe("claude: Claude Code (claude.ai plan); codex: Codex (ChatGPT plan)"),
      account: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/).optional().describe("The CLI account (polpo_harnesses_get → cli.accounts); default: the only one of that CLI on the agent's computer"),
      model: z.string().max(200).optional().describe("Model or alias for the CLI (e.g. opus, sonnet, gpt-5.5-codex); omit for the CLI's default"),
      permissionMode: z.enum(["allow-all", "allow-edits", "allow-reads"]).optional().describe("What the CLI may do unattended (default allow-all)"),
      args: z.array(z.string().max(300)).max(20).optional().describe("Extra command-line flags (not the account, protocol, session or instructions flags)"),
    }),
  ]).optional().describe("Its engine: \"polpo\" (Polpo's own, the default), an official harness (Claude Code, Codex, OpenCode) running inside its computer "
    + "(a Daytona v2 computer, set with defaultComputer; credentials from polpo_harnesses_update, never from here), or { type: \"cli\" }: the official Claude Code / Codex "
    + "program signed in with a person's own plan (a CLI account: polpo_harnesses_get). A personal sign-in runs only work its owner starts (Anthropic's and OpenAI's terms)."),
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

type Agent = {
  name: string; role?: string; model?: string; systemPrompt?: string; allowedTools?: string[]; skills?: string[]; identity?: { displayName?: string; title?: string };
  reportsTo?: string; talksTo?: { mode: string; agents?: string[]; acceptFrom?: string }; engine?: unknown; connectorTools?: Record<string, "*" | string[]>;
  notifyChannels?: AgentNotifyChannels; notifyRateLimit?: number;
  versioning?: { production?: string; latest?: string; draft?: { hasChanges?: boolean; changedFields?: string[]; stale?: boolean; warning?: string } };
};

/** Selected tool names the connector no longer lists (it may be disconnected: then nothing is reported). */
async function staleConnectorTools(deps: McpDeps, selection: Agent["connectorTools"]): Promise<Record<string, string[]>> {
  const stale: Record<string, string[]> = {};
  for (const [id, entry] of Object.entries(selection ?? {})) {
    if (!Array.isArray(entry) || entry.length === 0) continue;
    const t = await apiGet(deps, `/connectors/${enc(id)}/tools`);
    if (!t.ok) continue;
    const known = new Set(((t.data as { tools?: Array<{ name: string }> })?.tools ?? []).map((x) => x.name));
    const missing = entry.filter((name) => !known.has(name));
    if (missing.length) stale[id] = missing;
  }
  return stale;
}

/** "lin: echo, search · notion: all" */
function connectorToolsLine(selection: Agent["connectorTools"], stale: Record<string, string[]> = {}): string | undefined {
  const entries = Object.entries(selection ?? {});
  if (!entries.length) return undefined;
  return `connector tools: ${entries.map(([id, entry]) => `${id}: ${entry === "*" ? "all" : entry.length ? entry.join(", ") : "none"}${stale[id]?.length ? ` (stale: ${stale[id]!.join(", ")})` : ""}`).join(" · ")}`;
}

async function loadAgent(deps: McpDeps, name: string): Promise<{ ok: true; agent: Agent } | { ok: false; status: number; error: string }> {
  const r = await apiGet(deps, `/agents/${enc(name)}`);
  return r.ok ? { ok: true, agent: r.data as Agent } : r;
}

/** "org (+ seo-writer)" · "list: a, b" · "anyone (not set)" */
function linesText(talksTo: Agent["talksTo"]): string {
  if (!talksTo) return "anyone (not set: restrict it with talksTo)";
  const extra = talksTo.agents?.length ? talksTo.agents.join(", ") : "";
  const base = talksTo.mode === "org" ? `org (manager and direct reports${extra ? ` + ${extra}` : ""})`
    : talksTo.mode === "list" ? `list: ${extra || "nobody"}`
    : talksTo.mode;
  return `${base}${talksTo.acceptFrom === "lines" ? " · accepts only its lines" : ""}`;
}

type LinesChart = {
  agents: Array<{ agent: string; mode: string; explicit: boolean; manager?: string; reports: string[]; agents: string[]; acceptFrom: string; reachable: string[] }>;
  edges: Array<{ from: string; to: string; kind: string }>;
  unrestricted: string[];
};

export function registerTeamTools(tool: Register, deps: McpDeps): void {
  tool("team", "polpo_agent_lines", {
    title: "Org chart and communication lines",
    description: "The team's org chart (who reports to whom) and communication lines: for every agent, its lines mode (org, list, anyone, none), "
      + "its manager and direct reports, and the agents it can talk to (ask_agent, message_agent, rooms). Polpo talks to every agent; an agent can always escalate to its manager. "
      + "Agents without lines (created before them) talk to anyone: restrict them with polpo_agent_update talksTo.",
    inputSchema: { agent: z.string().optional().describe("Only this agent's lines") },
    outputSchema: { chart: looseObject },
    annotations: READ,
  }, async ({ agent }) => {
    const r = await apiGet(deps, "/agents/lines");
    if (!r.ok) return apiError(r, "Reading the communication lines");
    const chart = r.data as LinesChart;
    const rows = chart.agents.filter((l) => !agent || l.agent === agent);
    if (agent && rows.length === 0) return fail(`There is no agent "${agent}". Find the name with polpo_agents_list.`);
    const text = [
      ...rows.map((l) => `${l.agent}${l.manager ? ` → reports to ${l.manager}` : ""} · ${l.explicit ? l.mode : "anyone (not set)"}`
        + `${l.acceptFrom === "lines" ? " · accepts only its lines" : ""} · talks to: ${l.mode === "anyone" ? "any agent" : l.reachable.join(", ") || "no agent"}`),
      ...(!agent && chart.unrestricted.length ? ["", `Not restricted yet (talk to anyone): ${chart.unrestricted.join(", ")}.`] : []),
      "Polpo talks to every agent; every agent can escalate to its manager.",
    ].join("\n");
    return ok(text, { chart: (agent ? { ...chart, agents: rows, edges: chart.edges.filter((e) => e.from === agent || e.to === agent) } : chart) as Record<string, unknown> });
  });

  tool("team", "polpo_agent_get", {
    title: "Get an agent",
    description: "One agent's configuration (what runs in production): role, model, instructions, tools, skills, identity, who it reports to, "
      + "its production version and whether its draft has unpublished changes (polpo_agent_versions). polpo_agent_show shows how it is doing instead.",
    inputSchema: { name: z.string().min(1).describe("The agent's name (polpo_agents_list)") },
    outputSchema: { agent: looseObject, stale_connector_tools: z.record(z.string(), z.array(z.string())).optional() },
    annotations: READ,
  }, async ({ name }) => {
    const r = await loadAgent(deps, name);
    if (!r.ok) return r.status === 404 ? fail(`There is no agent "${name}". Find the name with polpo_agents_list.`) : apiError(r, `Reading agent ${name}`);
    const a = r.agent;
    const stale = await staleConnectorTools(deps, a.connectorTools);
    const connectorLine = connectorToolsLine(a.connectorTools, stale);
    const text = [
      `${a.name}${a.identity?.displayName ? ` (${a.identity.displayName}${a.identity.title ? `, ${a.identity.title}` : ""})` : ""}: ${a.role ?? "no role"}`,
      `model: ${modelWithEngineText(agentEffectiveModel(a), agentEngineIdOf(a.engine), "default")}${a.reportsTo ? ` · reports to ${a.reportsTo}` : ""}`,
      ...(a.versioning ? [`version: ${a.versioning.production ?? "none"} in production${a.versioning.latest && a.versioning.latest !== a.versioning.production ? ` · latest ${a.versioning.latest}` : ""}`
        + `${a.versioning.draft?.hasChanges ? ` · draft has changes (${(a.versioning.draft.changedFields ?? []).join(", ")})` : ""}`
        + `${a.versioning.draft?.stale ? ` · ⚠ ${a.versioning.draft.warning}` : ""}`] : []),
      `communication lines: ${linesText(a.talksTo)}`,
      `tools: ${a.allowedTools?.join(", ") ?? "defaults"} · skills: ${a.skills?.join(", ") || "none"}`,
      ...(connectorLine ? [connectorLine] : []),
      ...(notifyLine(a) ? [notifyLine(a)!] : []),
      ...(a.engine && typeof a.engine === "object"
        ? [(a.engine as { type?: string }).type === "cli"
          ? `engine: ${(a.engine as { cli?: string }).cli} CLI${(a.engine as { account?: string }).account ? ` (account ${(a.engine as { account?: string }).account})` : ""}${(a.engine as { model?: string }).model ? ` (${(a.engine as { model?: string }).model})` : ""}`
          : `engine: ${(a.engine as { harness?: string }).harness} harness${(a.engine as { model?: string }).model ? ` (${(a.engine as { model?: string }).model})` : ""}`]
        : []),
      ...(a.systemPrompt ? ["", short(a.systemPrompt, 3000)] : []),
    ].join("\n");
    return ok(text, { agent: a as Record<string, unknown>, ...(Object.keys(stale).length ? { stale_connector_tools: stale } : {}) });
  });

  tool("team", "polpo_agent_create", {
    title: "Create an agent",
    description: "Add an agent to the team: a name, what it does and, optionally, its model, instructions, tools, skills and identity. "
      + "It can take tasks right away. Ask the person before adding agents they did not ask for.",
    inputSchema: {
      name: z.string().min(1).max(60).regex(/^[a-z0-9][a-z0-9_-]*$/i, "letters, digits, - and _").describe("A short unique name, e.g. growth-analyst"),
      ...agentFields,
      connector_tools: connectorToolsParam.optional().describe(CONNECTOR_TOOLS_HELP),
      team: z.string().optional().describe("The team to add it to (default the main team)"),
    },
    outputSchema: { agent: looseObject, warnings: z.array(z.string()).optional() },
    annotations: WRITE,
  }, async ({ team, connector_tools, ...fields }) => {
    const body = { ...fields, ...(connector_tools ? { connectorTools: connector_tools } : {}) };
    const exists = await loadAgent(deps, body.name);
    if (exists.ok) return fail(`There is already an agent "${body.name}": choose another name, or change it with polpo_agent_update.`);
    const egress = await unknownEgress(deps, body.browserEgress);
    if (egress) return fail(egress);
    const r = await apiSend(deps, "POST", `/agents${team ? `?team=${enc(team)}` : ""}`, body);
    if (!r.ok) return apiError(r, `Creating agent ${body.name}`);
    const created = await loadAgent(deps, body.name);
    const warnings = (r.data as { warnings?: string[] } | undefined)?.warnings ?? [];
    return ok(`Created agent ${body.name}${body.role ? `: ${body.role}` : ""}.${warnings.length ? `\n⚠ ${warnings.join("\n⚠ ")}` : ""}`,
      { agent: (created.ok ? created.agent : body) as Record<string, unknown>, ...(warnings.length ? { warnings } : {}) });
  });

  tool("team", "polpo_agent_update", {
    title: "Update an agent",
    description: "Change an agent's role, model, instructions, tools (and which tools of each connector: connector_tools), the notification channels it may post to (notifyChannels, with send_notification in allowedTools), skills, identity, manager, communication lines (talksTo), browser egress proxy, computer (defaultComputer) or engine (polpo, or a Claude Code / Codex / OpenCode harness). Only the fields given change "
      + "(a list given replaces the old one); the result lists what changed. Agents are versioned: the change goes to its draft; publish: false keeps it there "
      + "(publish later with polpo_agent_publish), publish: true makes a new version, deploy: true also deploys it to production. Without either flag the instance setting "
      + "decides (by default: published and deployed, so it applies to its next runs).",
    inputSchema: {
      name: z.string().min(1).describe("The agent's name"),
      ...agentFields,
      computers: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/)).nullable().optional()
        .describe("Computers it may use (ids from polpo_computers_list), replacing the list; null or [] clears it (\"host\", this server, is always allowed)"),
      connector_tools: connectorToolsParam.nullable().optional()
        .describe(`${CONNECTOR_TOOLS_HELP} Replaces the whole selection; null clears it (every tool of every granted connector).`),
      notifyChannels: notifyChannelsParam.nullable().optional().describe(`${NOTIFY_CHANNELS_HELP} Replaces the whole list; null or [] removes it (no send_notification).`),
      notifyRateLimit: z.number().int().min(1).max(60).nullable().optional().describe("send_notification messages per minute (default 5); null resets it"),
      publish: z.boolean().optional().describe("false: only the draft changes; true: publish the draft as a new version (default: the instance setting, normally publish and deploy)"),
      deploy: z.boolean().optional().describe("true: publish and deploy the new version to production now"),
      bump: z.enum(["major", "minor", "patch"]).optional().describe("The published version's bump (default: suggested from the change)"),
      version: z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/).optional().describe("An explicit version number for the published version"),
      note: z.string().max(2000).optional().describe("Release note"),
    },
    outputSchema: { agent: looseObject, changed: z.array(z.string()), versioning: looseObject.optional() },
    annotations: UPDATE,
  }, async ({ name, connector_tools, publish, deploy, bump, version, note, ...fields }) => {
    const patch: Record<string, unknown> = { ...fields, ...(connector_tools !== undefined ? { connectorTools: connector_tools } : {}) };
    const flags = Object.fromEntries(Object.entries({ publish, deploy, bump, version, note }).filter(([, v]) => v !== undefined));
    const before = await loadAgent(deps, name);
    if (!before.ok) return before.status === 404 ? fail(`There is no agent "${name}". Find the name with polpo_agents_list.`) : apiError(before, `Reading agent ${name}`);
    const body = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    if (Object.keys(body).length === 0) return fail("Nothing to change: give at least one field (role, model, systemPrompt, allowedTools, connector_tools, notifyChannels, notifyRateLimit, skills, identity, reportsTo, talksTo, maxTurns, browserEgress, browserHeaded, defaultComputer, engine).");
    const egress = await unknownEgress(deps, patch.browserEgress as string | undefined);
    if (egress) return fail(egress);
    const r = await apiSend(deps, "PATCH", `/agents/${enc(name)}`, { ...body, ...flags });
    if (!r.ok) return apiError(r, `Updating agent ${name}`);
    const result = r.data as Record<string, unknown> & { versioning?: {
      mode?: string; draftChanged?: boolean; production?: string; published?: { version: string; bump: string }; deployed?: { from?: string; to: string }; draft?: { hasChanges: boolean; nextVersion?: string };
      deployStatus?: string; deployMessage?: string; gate?: { id: string; status: string; failed: string[] };
    } };
    const v = result?.versioning;
    if (v && !v.deployed && v.published && v.deployStatus && v.deployStatus !== "deployed") {
      // the agent's required suites decide the deploy
      const g = v.gate?.status === "running" ? await awaitGate(name, v.gate.id) : undefined;
      if (g && g.status === "passed" && g.deployId) {
        return ok(`${name}: ${Object.keys(body).join(", ")} published as ${v.published.version} and deployed to production: every required suite passed.\n${gateText(g)}`,
          { agent: result, changed: Object.keys(body), versioning: { ...v, deployStatus: "deployed", gate: g } as Record<string, unknown> });
      }
      const status = g ? (g.status === "running" ? "pending" : "blocked") : v.deployStatus;
      const text = status === "pending"
        ? `${name}: ${Object.keys(body).join(", ")} published as ${v.published.version}; its deploy is being verified by the required suites (production moves when they pass: polpo_agent_deploy_gates id "${v.gate?.id}").`
        : `${name}: ${Object.keys(body).join(", ")} published as ${v.published.version} but NOT deployed: the required suites blocked it (production stays on ${v.production ?? "its version"}).`;
      return ok(`${text}${g ? `\n${gateText(g)}` : v.gate?.failed.length ? `\n${v.gate.failed.join("\n")}` : ""}`,
        { agent: result, changed: Object.keys(body), versioning: { ...v, deployStatus: status, ...(g ? { gate: g } : {}) } as Record<string, unknown> });
    }
    if (v && !v.deployed) {
      // the draft (or a published version not deployed): report what changed there
      const changedInDraft = v.draftChanged ? Object.keys(body) : [];
      const where = v.published ? `published as ${v.published.version} (${v.published.bump}), not deployed: production stays on ${v.production ?? "its version"} (polpo_agent_deploy)`
        : v.draftChanged ? `saved in the draft${v.draft?.nextVersion ? ` (would publish ${v.draft.nextVersion})` : ""}: production is unchanged (polpo_agent_publish)`
        : "nothing changed (the values were the same)";
      return ok(`${name}: ${changedInDraft.length ? `${changedInDraft.join(", ")} ` : ""}${where}.`, { agent: result, changed: changedInDraft, versioning: v as Record<string, unknown> });
    }
    const after = await loadAgent(deps, name);
    const agent = (after.ok ? after.agent : { ...before.agent, ...body }) as Record<string, unknown>;
    const changed = Object.keys(body).filter((k) => JSON.stringify((before.agent as Record<string, unknown>)[k]) !== JSON.stringify(agent[k]));
    const versionNote = v?.deployed ? ` Version ${v.deployed.to} deployed to production${v.deployed.from ? ` (was ${v.deployed.from})` : ""}.` : "";
    const warnings = Array.isArray(result?.warnings) ? result.warnings as string[] : [];
    return ok((changed.length ? `Updated ${name}: ${changed.join(", ")}.${versionNote}` : `Nothing changed on ${name} (the values were the same).`)
      + (warnings.length ? `\n⚠ ${warnings.join("\n⚠ ")}` : ""),
      { agent, changed, ...(v ? { versioning: v as Record<string, unknown> } : {}) });
  });

  // ── Versions: draft → publish → deploy (production) → rollback ──

  const versionRef = z.string().regex(/^((0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)|draft|production)$/, "a version (1.2.0), draft or production");
  const semver = z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, "a version: major.minor.patch (e.g. 1.2.0)");
  /** Long text kept as it is (diffs, JSON), cut at n characters. */
  const clipText = (s: string, n: number) => s.length > n ? `${s.slice(0, n)}
… (cut: the structured result has all of it)` : s;
  const notFoundAgent = (name: string) => fail(`There is no agent "${name}". Find the name with polpo_agents_list.`);
  type FieldChange = { field: string; kind: string; textDiff?: string };
  type VersionDiff = { from?: string; to: string; changes: FieldChange[]; unified: string; suggestedBump?: string };
  const changesLine = (changes: FieldChange[]) => changes.length ? changes.map((c) => `${c.field} (${c.kind})`).join(", ") : "no changes";
  const deployLine = (d: { at: string; actor: string; from?: string; to: string; action: string; note?: string; id: string; gate?: { status: string; failed: string[]; override?: { reason: string } } }) =>
    `${d.at.slice(0, 16).replace("T", " ")} · ${d.action === "rollback" ? "ROLLBACK " : d.action === "initial" ? "initial " : d.action === "blocked" ? "BLOCKED by suites " : ""}${d.from ? `${d.from} → ` : ""}${d.to} · ${d.actor}`
    + `${d.gate ? ` · ${d.gate.status === "override" ? `OVERRIDE ("${short(d.gate.override?.reason ?? "", 120)}")` : d.gate.status === "passed" ? "suites ✓" : `suites ${d.gate.status}`}` : ""}`
    + `${d.note && d.action !== "blocked" ? ` · "${short(d.note, 120)}"` : ""}${d.action === "blocked" && d.gate?.failed.length ? ` · ${short(d.gate.failed.join(" · "), 300)}` : ""} [${d.id}]`;

  type GateSuite = { suiteId: string; suiteName: string; status: string; runId?: string; passRate?: number; score?: number; reasons: string[]; failedCases?: Array<{ caseName: string; failed: string[]; error?: string }>; progress?: { done: number; total: number } };
  type Gate = {
    id: string; agent: string; version: string; from?: string; trigger: string; status: string; requestedBy: string; requestedAt: string; finishedAt?: string;
    progress: { done: number; total: number }; suites: GateSuite[]; deployId?: string; override?: { by: string; at: string; reason: string; failed: string[] }; error?: string;
  };
  const GATE_MARK: Record<string, string> = { running: "⏳ verifying", passed: "✓ passed", blocked: "✗ blocked", failed: "✗ failed", override: "⚠ override", cancelled: "– cancelled", errored: "✗ errored" };
  /** A gate as text: status, progress, each suite's verdict with its failed cases and the run to open. */
  const gateText = (g: Gate) => [
    `${GATE_MARK[g.status] ?? g.status} · ${g.agent}@${g.version} (${g.trigger === "publish" ? "publish check" : g.trigger === "api-update" ? "API update" : "deploy"}${g.from ? `, production ${g.from}` : ""}) · ${g.progress.done}/${g.progress.total} cases · by ${g.requestedBy} [${g.id}]`,
    ...g.suites.flatMap((s) => [
      `  ${s.status === "passed" ? "✓" : s.status === "running" || s.status === "queued" ? "…" : "✗"} ${s.suiteName} [${s.suiteId}]: ${s.status}${s.passRate !== undefined ? ` · pass rate ${Math.round(s.passRate * 100)}%` : ""}${s.score !== undefined ? ` · score ${s.score.toFixed(2)}` : ""}${s.runId ? ` · run ${s.runId} (polpo_agent_suite_run_get)` : ""}`,
      ...s.reasons.map((r) => `      ${r}`),
      ...(s.failedCases ?? []).slice(0, 5).map((c) => `      ✗ ${c.caseName}: ${short(c.error ?? c.failed.join("; "), 200)}`),
    ]),
    ...(g.override ? [`  override by ${g.override.by}: "${g.override.reason}"`] : []),
    ...(g.error ? [`  ${g.error}`] : []),
  ].join("\n");
  /** Wait (polling, up to ~50 s) for a gate to leave "running". */
  const awaitGate = async (name: string, id: string): Promise<Gate | undefined> => {
    let last: Gate | undefined;
    for (let i = 0; i < 2; i++) {
      const r = await apiGet(deps, `/agents/${enc(name)}/deploy-gates/${enc(id)}${qs({ wait: 25 })}`);
      if (!r.ok) return last;
      last = r.data as Gate;
      if (last.status !== "running") return last;
    }
    return last;
  };
  /** The version's latest deploy gate (after a 409 GATE_BLOCKED). */
  const latestGate = async (name: string, version: string): Promise<Gate | undefined> => {
    const r = await apiGet(deps, `/agents/${enc(name)}/deploy-gates${qs({ version, limit: 1 })}`);
    return r.ok ? (r.data as Gate[])[0] : undefined;
  };
  const suitesLink = (name: string) => dashboardLink(deps, `/agents/${enc(name)}?tab=versions`);

  tool("team", "polpo_agent_versions", {
    title: "List an agent's versions",
    description: "An agent's published versions (newest first: number, author, date, note, changed fields), which one production runs, "
      + "and its draft (unpublished changes and the suggested next version). polpo_agent_version_get shows one; polpo_agent_version_diff compares two.",
    inputSchema: { name: z.string().min(1).describe("The agent's name (polpo_agents_list)") },
    outputSchema: { state: looseObject, versions: z.array(looseObject) },
    annotations: READ,
  }, async ({ name }) => {
    const r = await apiGet(deps, `/agents/${enc(name)}/versions`);
    if (!r.ok) return r.status === 404 ? notFoundAgent(name) : apiError(r, `Reading ${name}'s versions`);
    const data = r.data as {
      state: { production?: string; latest?: string; draft: { hasChanges: boolean; stale?: boolean; warning?: string; changes: FieldChange[]; nextVersion?: string; suggestedBump?: string }; gate?: { requiredSuites: Array<{ id: string; name: string }>; pending?: Gate } };
      versions: Array<{ version: string; author: string; createdAt: string; note?: string; changedFields: string[]; gate?: { status: string; failed: string[] } }>;
    };
    const s = data.state;
    const gateBadge = (g?: { status: string; failed: string[] }) => g ? ` · suites ${GATE_MARK[g.status] ?? g.status}${g.failed.length && g.status !== "override" ? ` (${short(g.failed.join(" · "), 160)})` : ""}` : "";
    const text = [
      `${name}: production ${s.production ?? "none"} · latest ${s.latest ?? "none"}`,
      s.draft.hasChanges
        ? `Draft: ${changesLine(s.draft.changes)} → would publish ${s.draft.nextVersion} (${s.draft.suggestedBump})`
        : "Draft: no unpublished changes",
      ...(s.draft.stale ? [`⚠ ${s.draft.warning} (polpo_agent_draft action rebase or discard)`] : []),
      ...(s.gate?.requiredSuites.length ? [`Deploys are gated by: ${s.gate.requiredSuites.map((x) => x.name).join(", ")}`] : []),
      ...(s.gate?.pending ? [`In verifica: ${s.gate.pending.version} (${s.gate.pending.progress.done}/${s.gate.pending.progress.total} cases) [${s.gate.pending.id}]`] : []),
      "",
      ...data.versions.map((v) => `${v.version}${v.version === s.production ? " (production)" : ""} · ${v.createdAt.slice(0, 16).replace("T", " ")} · ${v.author}${v.note ? ` · "${short(v.note, 120)}"` : ""} · ${v.changedFields.join(", ") || "—"}${gateBadge(v.gate)}`),
    ].join("\n");
    return ok(text, { state: s as Record<string, unknown>, versions: data.versions as Array<Record<string, unknown>> });
  });

  tool("team", "polpo_agent_version_get", {
    title: "Get an agent version",
    description: "One version's full configuration, read-only: a published version (1.2.0), \"production\" (what runs) or \"draft\" (the unpublished working copy).",
    inputSchema: {
      name: z.string().min(1).describe("The agent's name"),
      version: versionRef.describe("1.2.0, production or draft"),
    },
    outputSchema: { version: looseObject },
    annotations: READ,
  }, async ({ name, version }) => {
    const r = await apiGet(deps, `/agents/${enc(name)}/versions/${enc(version)}`);
    if (!r.ok) return r.status === 404 ? fail(`${name} has no version ${version}: see polpo_agent_versions.`) : apiError(r, `Reading ${name}@${version}`);
    const v = r.data as { version: string; author?: string; createdAt?: string; note?: string; config: Record<string, unknown>; skillVersions?: Record<string, number> };
    const text = [
      `${name}@${v.version}${v.author ? ` · by ${v.author}` : ""}${v.createdAt ? ` · ${v.createdAt.slice(0, 16).replace("T", " ")}` : ""}${v.note ? ` · "${v.note}"` : ""}`,
      ...(v.skillVersions && Object.keys(v.skillVersions).length ? [`skills pinned: ${Object.entries(v.skillVersions).map(([k, n]) => `${k} v${n}`).join(", ")}`] : []),
      "",
      clipText(JSON.stringify(v.config, null, 2), 6000),
    ].join("\n");
    return ok(text, { version: v as Record<string, unknown> });
  });

  tool("team", "polpo_agent_version_diff", {
    title: "Compare two agent versions",
    description: "What changed between two versions of an agent, git style: the changed fields and a unified diff of the whole configuration "
      + "(instructions as line diffs). to defaults to the draft; from defaults to the latest published version for the draft, else the version before to.",
    inputSchema: {
      name: z.string().min(1).describe("The agent's name"),
      to: versionRef.optional().describe("The newer side: 1.2.0, production or draft (default draft)"),
      from: versionRef.optional().describe("The older side (default: see above)"),
    },
    outputSchema: { diff: looseObject },
    annotations: READ,
  }, async ({ name, to, from }) => {
    const r = await apiGet(deps, `/agents/${enc(name)}/diff${qs({ to, from })}`);
    if (!r.ok) return r.status === 404 ? fail(`${name} or that version does not exist: see polpo_agent_versions.`) : apiError(r, `Comparing ${name}'s versions`);
    const d = r.data as VersionDiff;
    const text = d.changes.length
      ? [`${name}: ${d.from ?? "empty"} → ${d.to}: ${changesLine(d.changes)}${d.suggestedBump ? ` (a ${d.suggestedBump} change)` : ""}`, "", clipText(d.unified, 8000)].join("\n")
      : `${name}: ${d.from ?? "empty"} and ${d.to} are the same.`;
    return ok(text, { diff: d as unknown as Record<string, unknown> });
  });

  tool("team", "polpo_agent_draft", {
    title: "Rebase or discard an agent's draft",
    description: "An agent's draft is based on the version production ran when it started. After a rollback or deploy, a stale draft must be rebased onto "
      + "production (its own changes applied over what runs now) or discarded before it can be published. action: rebase, or discard (needs confirm: true: the unpublished changes are lost).",
    inputSchema: {
      name: z.string().min(1).describe("The agent's name"),
      action: z.enum(["rebase", "discard"]).describe("rebase onto production, or discard the draft"),
      confirm: confirmParam("discard the draft").optional(),
    },
    outputSchema: { result: looseObject },
    annotations: DESTRUCTIVE,
  }, async ({ name, action, confirm }) => {
    if (action === "discard") {
      if (confirm !== true) return fail(`Discarding ${name}'s draft loses its unpublished changes: ask the person, then call again with confirm: true.`);
      const r = await apiSend(deps, "DELETE", `/agents/${enc(name)}/draft`);
      if (!r.ok) return r.status === 404 ? notFoundAgent(name) : apiError(r, `Discarding ${name}'s draft`);
      return ok((r.data as { discarded: boolean }).discarded ? `Discarded ${name}'s draft.` : `${name} had no draft.`, { result: r.data as Record<string, unknown> });
    }
    const r = await apiSend(deps, "POST", `/agents/${enc(name)}/draft/rebase`);
    if (!r.ok) return r.status === 404 ? fail(r.error ?? `${name} has no draft.`) : apiError(r, `Rebasing ${name}'s draft`);
    const d = r.data as { from?: string; to?: string; dropped: boolean };
    return ok(d.dropped ? `${name}'s draft had nothing left to change over production ${d.to ?? ""}: dropped.`
      : `Rebased ${name}'s draft from ${d.from ?? "?"} onto production ${d.to ?? "?"}: publish it with polpo_agent_publish.`, { result: d as unknown as Record<string, unknown> });
  });

  tool("team", "polpo_agent_publish", {
    title: "Publish an agent's draft",
    description: "Publish the agent's draft (its unpublished changes) as a new immutable version. The number follows the suggested bump "
      + "(patch: text, instructions, identity; minor: added tools, skills, connectors or settings; major: engine or model change, removed tools, skills or connectors) "
      + "unless bump or version say otherwise. It does not change what runs: deploy it with polpo_agent_deploy (or deploy: true here, after the person agreed; through the agent's required suites, if any). "
      + "Suites with gate.onPublish run on publish (a non-blocking check: polpo_agent_deploy_gates).",
    inputSchema: {
      name: z.string().min(1).describe("The agent's name"),
      bump: z.enum(["major", "minor", "patch"]).optional().describe("Override the suggested bump"),
      version: semver.optional().describe("An explicit version number, above the latest"),
      note: z.string().max(2000).optional().describe("Release note: what changed and why"),
      deploy: z.boolean().optional().describe("Also deploy it to production now (ask the person first)"),
    },
    outputSchema: { version: looseObject, deploy: looseObject.optional(), gate: looseObject.optional(), check: looseObject.optional() },
    annotations: WRITE,
  }, async ({ name, bump, version, note, deploy }) => {
    const r = await apiSend(deps, "POST", `/agents/${enc(name)}/publish`, { bump, version, note, deploy });
    if (!r.ok) {
      if (r.status === 404) return notFoundAgent(name);
      if (r.status === 409) return fail(/rebase/.test(r.error ?? "") ? `${r.error} (polpo_agent_draft).` : `${r.error}. Change it first (polpo_agent_update with publish: false writes the draft), or see polpo_agent_versions.`);
      return apiError(r, `Publishing ${name}`);
    }
    const data = r.data as { version: { version: string; changes: FieldChange[] }; deploy?: { from?: string; to: string }; deployStatus?: string; message?: string; gate?: Gate; check?: Gate };
    let gate = data.gate;
    if (gate?.status === "running") gate = await awaitGate(name, gate.id) ?? gate;
    const deployed = data.deploy || (gate && (gate.status === "passed" || gate.status === "override") && gate.deployId);
    const what = deployed ? ` Deployed to production${data.deploy ? ` (${data.deploy.from ?? "none"} → ${data.deploy.to})` : ""}.`
      : deploy && gate ? (gate.status === "running" ? ` Its deploy is being verified by the required suites: production moves when they pass (polpo_agent_deploy_gates id "${gate.id}").` : ` NOT deployed: the required suites blocked it. Production is unchanged.`)
      : ` Production is unchanged: deploy it with polpo_agent_deploy.`;
    return ok(`Published ${name}@${data.version.version}: ${changesLine(data.version.changes)}.${what}${gate ? `\n${gateText(gate)}` : ""}${data.check ? `\nPublish check started [${data.check.id}]: polpo_agent_deploy_gates.` : ""}`,
      { version: data.version as unknown as Record<string, unknown>, ...(data.deploy ? { deploy: data.deploy as unknown as Record<string, unknown> } : {}), ...(gate ? { gate: gate as unknown as Record<string, unknown> } : {}), ...(data.check ? { check: data.check as unknown as Record<string, unknown> } : {}) });
  });

  tool("team", "polpo_agent_deploy", {
    title: "Deploy an agent version",
    description: "Deploy a published version to production: every chat, task, mission, schedule, channel and delegation that does not pin a version uses it from its next run "
      + "(runs in flight keep theirs). Recorded in the deploy history. Needs confirm: true after the person agreed (show them polpo_agent_version_diff first). "
      + "When the agent has required suites (deploy gate) they run against the version first: production moves only if every one passes (this waits up to ~50 s, then the deploy stays pending: "
      + "polpo_agent_deploy_gates); otherwise the deploy is blocked and recorded. override_reason (admins only) deploys anyway, recording which gates failed. cancel_gate: stop a verification.",
    inputSchema: {
      name: z.string().min(1).describe("The agent's name"),
      version: semver.optional().describe("The published version to deploy (polpo_agent_versions); not needed with cancel_gate"),
      note: z.string().max(2000).optional().describe("Why (kept in the deploy history)"),
      override_reason: z.string().min(3).max(2000).optional().describe("Admins only: deploy even though the required suites failed (or without running them); the reason is recorded in the deploy history"),
      cancel_gate: z.string().optional().describe("A deploy gate's id (polpo_agent_deploy_gates): stop that verification, nothing is deployed"),
      confirm: confirmParam("deploy this version to production"),
    },
    outputSchema: { deploy: looseObject.optional(), gate: looseObject.optional(), status: z.string().optional() },
    annotations: DESTRUCTIVE,
  }, async ({ name, version, note, override_reason, cancel_gate, confirm }) => {
    if (cancel_gate) {
      const r = await apiSend(deps, "POST", `/agents/${enc(name)}/deploy-gates/${enc(cancel_gate)}/cancel`, {});
      if (!r.ok) return r.status === 404 ? fail(`${name} has no deploy gate ${cancel_gate}: see polpo_agent_deploy_gates.`) : apiError(r, `Cancelling ${cancel_gate}`);
      return ok(`Cancelled: nothing was deployed.\n${gateText(r.data as Gate)}`, { gate: r.data as Record<string, unknown>, status: "cancelled" });
    }
    if (!version) return fail("Give version (the published version to deploy), or cancel_gate.");
    if (override_reason && !isAdmin()) return fail("Only an admin (scope polpo:admin) can deploy past the required suites.");
    if (confirm !== true) {
      const d = await apiGet(deps, `/agents/${enc(name)}/diff${qs({ to: version, from: "production" })}`);
      const summary = d.ok ? changesLine((d.data as VersionDiff).changes) : "see polpo_agent_version_diff";
      return fail(`Deploying ${name}@${version} to production changes: ${summary}.${override_reason ? ` With an override: the required suites are skipped or their failures ignored ("${override_reason}").` : ""} Ask the person, then call again with confirm: true.`);
    }
    const r = await apiSend(deps, "POST", `/agents/${enc(name)}/deploy`, { version, note, ...(override_reason ? { override: { reason: override_reason } } : {}) });
    if (!r.ok) {
      if (r.status === 404) return fail(`${name} has no version ${version}: see polpo_agent_versions.`);
      if (r.code === "GATE_BLOCKED") {
        const g = await latestGate(name, version);
        return fail(`${r.error}${g ? `\n${gateText(g)}` : ""}\nFix the agent (or the test), publish and deploy again; an admin may deploy anyway with override_reason. ${suitesLink(name)}`);
      }
      return apiError(r, `Deploying ${name}@${version}`);
    }
    const data = r.data as { status?: string; gate?: Gate; from?: string; to?: string; message?: string };
    if (data.status === "pending" && data.gate) {
      const g = await awaitGate(name, data.gate.id) ?? data.gate;
      if (g.status === "running") {
        return ok(`${name}@${version} is being verified by its required suites (${g.progress.done}/${g.progress.total} cases): production moves when they pass. Check it with polpo_agent_deploy_gates id "${g.id}"; stop it with cancel_gate.\n${gateText(g)}`,
          { gate: g as unknown as Record<string, unknown>, status: "pending" });
      }
      if (g.status === "passed" && g.deployId) return ok(`Deployed ${name}@${version} to production: every required suite passed.\n${gateText(g)}`, { gate: g as unknown as Record<string, unknown>, status: "deployed" });
      const failed = g.suites.filter((s) => s.status !== "passed").map((s) => `${s.suiteName}: ${s.reasons.join("; ") || s.status}`);
      return fail(`${g.status === "blocked" ? `Blocked by suites: ${failed.join(" · ")}` : `The verification ${g.status}`}. ${name}@${version} was NOT deployed: production is unchanged.\n${gateText(g)}\nAn admin may deploy anyway with override_reason. ${suitesLink(name)}`);
    }
    const gateNote = data.gate ? `\n${gateText(data.gate)}` : "";
    return ok(`Deployed ${name}@${data.to ?? version} to production${data.from ? ` (was ${data.from})` : ""}${data.gate?.status === "override" ? " with an override" : ""}.${gateNote}`,
      { deploy: data as unknown as Record<string, unknown>, ...(data.gate ? { gate: data.gate as unknown as Record<string, unknown> } : {}), status: "deployed" });
  });

  tool("team", "polpo_agent_deploy_gates", {
    title: "An agent's deploy gates",
    description: "The deploy gates of an agent: its required suites (gate.required) run against a version before it reaches production, or when it is published (gate.onPublish). "
      + "Each gate: in verifica (running, with progress), passed (deployed), blocked (not deployed: which suites failed, why, the failed cases and the runs to open with polpo_agent_suite_run_get), "
      + "override (deployed anyway by an admin: who, when, why), cancelled. id: one gate (wait: up to 50 s for it to finish). version: that version's gates.",
    inputSchema: {
      name: z.string().min(1).describe("The agent's name"),
      id: z.string().optional().describe("One gate's id"),
      version: semver.optional().describe("Only this version's gates"),
      wait: z.boolean().optional().describe("With id: wait (up to ~50 s) for a running gate to finish"),
      limit: z.number().int().min(1).max(50).optional().describe("How many (default 10)"),
    },
    outputSchema: { gate: looseObject.optional(), gates: z.array(looseObject).optional(), required: z.array(looseObject).optional() },
    annotations: READ,
  }, async ({ name, id, version, wait, limit }) => {
    if (id) {
      const g = wait ? await awaitGate(name, id) : await apiGet(deps, `/agents/${enc(name)}/deploy-gates/${enc(id)}`).then((r) => r.ok ? r.data as Gate : undefined);
      if (!g) return fail(`${name} has no deploy gate ${id}: list them with polpo_agent_deploy_gates.`);
      return ok(gateText(g), { gate: g as unknown as Record<string, unknown> });
    }
    const [r, v] = await Promise.all([
      apiGet(deps, `/agents/${enc(name)}/deploy-gates${qs({ version, limit: limit ?? 10 })}`),
      apiGet(deps, `/agents/${enc(name)}/versions`),
    ]);
    if (!r.ok) return r.status === 404 ? notFoundAgent(name) : apiError(r, `Reading ${name}'s deploy gates`);
    const gates = r.data as Gate[];
    const required = v.ok ? ((v.data as { state: { gate?: { requiredSuites: Array<{ id: string; name: string; onPublish: boolean }> } } }).state.gate?.requiredSuites ?? []) : [];
    const head = required.length
      ? `${name}'s deploys are gated by: ${required.map((s) => `${s.name} [${s.id}]${s.onPublish ? " (also on publish)" : ""}`).join(", ")}`
      : `${name} has no required suites: deploys are immediate (mark a suite gate.required with polpo_agent_suite_save).`;
    return ok([head, "", ...(gates.length ? gates.map(gateText) : ["No deploy gates yet."]), suitesLink(name)].filter(Boolean).join("\n"),
      { gates: gates as unknown as Array<Record<string, unknown>>, required: required as unknown as Array<Record<string, unknown>> });
  });

  tool("team", "polpo_agent_rollback", {
    title: "Roll an agent back",
    description: "Put production back on the version it ran before the current one (or on to): one step, recorded as a rollback in the deploy history. "
      + "Needs confirm: true after the person agreed.",
    inputSchema: {
      name: z.string().min(1).describe("The agent's name"),
      to: semver.optional().describe("A specific published version (default: the previous deploy)"),
      note: z.string().max(2000).optional().describe("Why (kept in the deploy history)"),
      confirm: confirmParam("roll production back"),
    },
    outputSchema: { deploy: looseObject },
    annotations: DESTRUCTIVE,
  }, async ({ name, to, note, confirm }) => {
    if (confirm !== true) {
      const v = await apiGet(deps, `/agents/${enc(name)}/versions`);
      const prod = v.ok ? (v.data as { state: { production?: string } }).state.production : undefined;
      return fail(`Rolling ${name} back moves production from ${prod ?? "its version"} to ${to ?? "the previous deploy"}. Ask the person, then call again with confirm: true.`);
    }
    const r = await apiSend(deps, "POST", `/agents/${enc(name)}/rollback`, { to, note });
    if (!r.ok) {
      if (r.status === 404) return fail(r.error ?? `Nothing to roll back to for ${name}.`);
      if (r.status === 409) return fail(r.error ?? `Nothing to roll back for ${name}.`);
      return apiError(r, `Rolling ${name} back`);
    }
    const e = r.data as { from?: string; to: string };
    return ok(`Rolled ${name} back: production ${e.from ?? "?"} → ${e.to}.`, { deploy: e as unknown as Record<string, unknown> });
  });

  tool("team", "polpo_agent_deploys", {
    title: "An agent's deploy history",
    description: "Every deploy of an agent to production, newest first: when, who, from → to, note, rollbacks marked. "
      + "id: one deploy with its git-style diff (the version it replaced vs the one it deployed).",
    inputSchema: {
      name: z.string().min(1).describe("The agent's name"),
      id: z.string().optional().describe("One deploy's id (from the list): its diff"),
      limit: z.number().int().min(1).max(200).optional().describe("How many (default 20)"),
    },
    outputSchema: { deploys: z.array(looseObject).optional(), deploy: looseObject.optional() },
    annotations: READ,
  }, async ({ name, id, limit }) => {
    if (id) {
      const r = await apiGet(deps, `/agents/${enc(name)}/deploys/${enc(id)}`);
      if (!r.ok) return r.status === 404 ? fail(`${name} has no deploy ${id}: list them with polpo_agent_deploys.`) : apiError(r, `Reading deploy ${id}`);
      const d = r.data as Parameters<typeof deployLine>[0] & { diff: VersionDiff };
      return ok([deployLine(d), `changes: ${changesLine(d.diff.changes)}`, "", clipText(d.diff.unified, 8000)].join("\n"), { deploy: d as unknown as Record<string, unknown> });
    }
    const r = await apiGet(deps, `/agents/${enc(name)}/deploys${qs({ limit: String(limit ?? 20) })}`);
    if (!r.ok) return r.status === 404 ? notFoundAgent(name) : apiError(r, `Reading ${name}'s deploys`);
    const list = r.data as Array<Parameters<typeof deployLine>[0]>;
    return ok(list.length ? [`${name}: ${list.length} deploy(s), newest first`, ...list.map(deployLine)].join("\n") : `${name} has no deploys yet.`,
      { deploys: list as unknown as Array<Record<string, unknown>> });
  });

  type TestItem = { label: string; status: string; detail?: string; fix?: { label: string; href?: string; action?: { type: string; connector?: string } } };
  type TestRun = { id: string; agent: string; target: string; version?: string; status: string; startedAt: string; checks: Array<{ id: string; title: string; status: string; summary: string; items: TestItem[] }> };
  const MARK: Record<string, string> = { pass: "✓", warn: "⚠", fail: "✗", skip: "–" };
  const isAdmin = () => !deps.principal || hasScope(deps.principal, "polpo:admin");
  const runText = (r: TestRun) => [
    `${MARK[r.status] ?? r.status} ${r.agent}${r.target === "production" ? (r.version ? `@${r.version} (production)` : "") : `@${r.target}`} · ${r.startedAt.slice(0, 16).replace("T", " ")} [${r.id}]`,
    ...r.checks.flatMap((ch) => [
      `${MARK[ch.status] ?? ch.status} ${ch.title}: ${ch.summary}`,
      ...ch.items.filter((i) => i.status === "fail" || i.status === "warn").map((i) => `   ${MARK[i.status]} ${i.label}${i.detail ? `: ${short(i.detail, 300)}` : ""}`
        + `${i.fix?.action?.type === "grant-connector-access" ? ` → fix: polpo_agent_test with fix_connector "${i.fix.action.connector}"` : i.fix?.href ? ` → ${dashboardLink(deps, i.fix.href)}` : ""}`),
    ]),
  ].join("\n");

  tool("team", "polpo_agent_test", {
    title: "Test an agent",
    description: "Check everything an agent has at its disposal and say what works: engine and model (a minimal real request, a few tokens), tools "
      + "(allowedTools resolve to real tools), connectors (connected, signed in, tools listed; a connector named in allowedTools whose access leaves the agent out), "
      + "vault references (names only), skills (load, pinned versions), computer and sandbox (a stopped machine is not started unless start_computer), "
      + "channels routed to it, versioning (stale draft). Each check: ✓ / ⚠ / ✗ with details and a fix. "
      + "checks: some of engine, tools, connectors, vault, skills, computer, channels, versioning, smoke (default: all but smoke). "
      + "smoke runs a tiny real chat turn that calls one harmless tool (costs tokens; needs the admin scope). target: production (default), draft or a version (1.2.0). "
      + "history: true lists past runs instead. fix_connector: grant that connector's access to the agent (the one-click fix; needs the admin scope).",
    inputSchema: {
      name: z.string().min(1).describe("The agent's name (polpo_agents_list)"),
      checks: z.array(z.enum(["engine", "tools", "connectors", "vault", "skills", "computer", "channels", "versioning", "smoke"])).optional().describe("Which checks (default all but smoke)"),
      target: z.string().optional().describe("production (default), draft, or a published version like 1.2.0"),
      start_computer: z.boolean().optional().describe("Start a stopped remote computer to test it (it may cost: only when the person asked)"),
      smoke_prompt: z.string().max(4000).optional().describe("The smoke run's message (default: call register_outcome once)"),
      history: z.boolean().optional().describe("List the agent's past test runs instead of running"),
      fix_connector: z.string().optional().describe("Apply the fix: grant this connector's access to the agent"),
    },
    outputSchema: { run: looseObject.optional(), runs: z.array(looseObject).optional(), fixed: z.string().optional() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ name, checks, target, start_computer, smoke_prompt, history, fix_connector }) => {
    if (fix_connector) {
      if (!isAdmin()) return fail("Granting a connector's access changes the instance: it needs the admin scope (polpo:admin). The person can click the fix in the agent's Tests tab.");
      const r = await apiSend(deps, "POST", `/agents/${enc(name)}/tests/fix`, { type: "grant-connector-access", connector: fix_connector });
      if (!r.ok) return r.status === 404 ? fail(r.error ?? `There is no agent "${name}" or connector "${fix_connector}".`) : apiError(r, `Granting ${fix_connector} to ${name}`);
      const m = (r.data as { message: string }).message;
      return ok(`${m}. Run polpo_agent_test again to check.`, { fixed: m });
    }
    if (history) {
      const r = await apiGet(deps, `/agents/${enc(name)}/tests${qs({ limit: "20" })}`);
      if (!r.ok) return r.status === 404 ? notFoundAgent(name) : apiError(r, `Reading ${name}'s tests`);
      const runs = r.data as TestRun[];
      return ok(runs.length ? runs.map((x) => `${MARK[x.status] ?? x.status} ${x.startedAt.slice(0, 16).replace("T", " ")} · ${x.target}${x.version ? ` (${x.version})` : ""} · ${x.checks.map((c) => `${c.id} ${MARK[c.status] ?? c.status}`).join(", ")} [${x.id}]`).join("\n") : `${name} has not been tested yet.`,
        { runs: runs as unknown as Array<Record<string, unknown>> });
    }
    if (checks?.includes("smoke") && !isAdmin()) return fail("The smoke run is a real chat turn with the agent (it costs tokens): it needs the admin scope (polpo:admin). Run the other checks without it.");
    const r = await apiSend(deps, "POST", `/agents/${enc(name)}/tests`, {
      ...(checks?.length ? { checks } : {}), ...(target ? { target } : {}), ...(start_computer ? { startComputer: true } : {}), ...(smoke_prompt ? { smokePrompt: smoke_prompt } : {}),
    });
    if (!r.ok) return r.status === 404 ? fail(r.error ?? `There is no agent "${name}" (or no such version).`) : apiError(r, `Testing ${name}`);
    const run = r.data as TestRun;
    return ok(runText(run), { run: run as unknown as Record<string, unknown> });
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
