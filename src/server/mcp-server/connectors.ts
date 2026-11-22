/**
 * Connectors: MCP servers the agents and Polpo use (Linear, Notion, Gmail…). Add from the catalog
 * or a remote URL, choose who may use them and which tools, test, authorize with OAuth (the person
 * opens the link), disconnect and remove. Secrets never pass through here: API tokens, header values
 * and OAuth app client secrets are entered in the dashboard (setup_url). Changes need polpo:connectors (or polpo:admin).
 */
import { z } from "zod";
import {
  BAD_CURSOR, DESTRUCTIVE, READ, UPDATE, apiError, apiGet, apiSend, confirmParam, cursorParam, dashboardLink, enc, fail, limitParam, ok,
  page, pageOutput, short,
  type McpDeps, type Register,
} from "./kit.js";
import { setupHandoff } from "./setup.js";
import { unknownAgents } from "./tasks.js";

type Connector = {
  id: string; name: string; description?: string; transport: { type: string; url?: string }; auth: { type: string; oauth?: { app?: string } };
  access: { agents: string[] | "*"; polpo: boolean }; enabled: boolean; catalogId?: string; status?: string; lastError?: string; toolCount?: number;
  lastConnectedAt?: string; toolPolicy?: Record<string, string>;
  secrets?: { bearerToken: boolean; headers: string[]; clientSecret: boolean; values: string[]; oauth: { authorized: boolean } };
};
type CatalogEntry = {
  id: string; name: string; category: string; description: string; url?: string; urlTemplate?: string; variants?: Array<{ label: string; url: string }>;
  auth: string; authNotes?: string; oauth?: { app?: string }; docs?: string; setup?: string;
};

const connectorItem = z.object({
  id: z.string(), name: z.string(), status: z.string(), enabled: z.boolean(), url: z.string().optional(), auth: z.string(),
  agents: z.union([z.array(z.string()), z.literal("*")]), polpo: z.boolean(), tool_count: z.number().int().optional(),
  authorized: z.boolean().optional(), credentials_set: z.boolean().optional(), last_error: z.string().optional(), catalog_id: z.string().optional(),
  tool_policy: z.record(z.string(), z.string()).optional(),
});

/** A server URL without what could carry a key (user info, query, fragment). */
function safeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}${u.search ? "?…" : ""}`;
  } catch {
    return "(invalid URL)";
  }
}

/** What a connector is, without secrets (only whether they are set). */
const view = (c: Connector) => ({
  id: c.id, name: c.name, status: c.enabled ? c.status ?? "disconnected" : "disabled", enabled: c.enabled,
  ...(c.transport.url ? { url: safeUrl(c.transport.url) } : {}), auth: c.auth.type, agents: c.access.agents, polpo: c.access.polpo,
  ...(c.toolCount !== undefined ? { tool_count: c.toolCount } : {}),
  ...(c.auth.type === "oauth" ? { authorized: !!c.secrets?.oauth.authorized } : {}),
  ...(c.auth.type === "bearer" || c.auth.type === "headers" ? { credentials_set: !!(c.secrets?.bearerToken || c.secrets?.headers.length) } : {}),
  ...(c.lastError ? { last_error: c.lastError } : {}), ...(c.catalogId ? { catalog_id: c.catalogId } : {}),
  ...(c.toolPolicy && Object.keys(c.toolPolicy).length ? { tool_policy: c.toolPolicy } : {}),
});
const line = (c: ReturnType<typeof view>) => `- ${c.id} "${c.name}" [${c.status}] ${c.auth}${c.authorized === false ? " (not authorized)" : ""}${c.credentials_set === false ? " (no token)" : ""}`
  + `${c.tool_count !== undefined ? `, ${c.tool_count} tools` : ""} · agents: ${c.agents === "*" ? "all" : c.agents.join(", ") || "none"}${c.polpo ? " + Polpo" : ""}${c.last_error ? ` · error: ${short(c.last_error, 100)}` : ""}`;

async function loadConnector(deps: McpDeps, id: string) {
  const r = await apiGet(deps, `/connectors/${enc(id)}`);
  return r.ok ? { ok: true as const, connector: r.data as Connector } : r;
}
const notFound = (id: string) => fail(`There is no connector "${id}". List them with polpo_connectors_list.`);

export function registerConnectorTools(tool: Register, deps: McpDeps): void {
  const setupUrl = (id?: string, field?: string) => (id ? setupHandoff(deps, { kind: "connector", item: id, ...(field ? { field } : {}) }, "connector's credentials").setup_url : dashboardLink(deps, "/connectors"));

  /** The OAuth link to open (or that it is authorized already). */
  async function oauthStart(id: string): Promise<{ ok: true; url?: string; authorized: boolean } | { ok: false; error: string; status: number }> {
    const r = await apiSend(deps, "POST", `/connectors/${enc(id)}/oauth/start`);
    if (!r.ok) return r;
    const d = r.data as { authorizationUrl?: string; authorized?: boolean };
    return { ok: true, ...(d.authorizationUrl ? { url: d.authorizationUrl } : {}), authorized: !!d.authorized };
  }

  tool("connectors", "polpo_connectors_list", {
    title: "List connectors",
    description: "The connectors (MCP servers agents and Polpo use): status, auth and whether it is authorized or has its token (never the secrets), "
      + "tool count, who may use them. With id, that connector and its tools with their policy (allow, ask, off).",
    inputSchema: {
      id: z.string().optional().describe("One connector, with its tools"),
      limit: limitParam(50, 200),
      cursor: cursorParam(),
    },
    outputSchema: { ...pageOutput(connectorItem), tools: z.array(z.object({ name: z.string(), description: z.string().optional(), policy: z.string() })).optional() },
    annotations: READ,
  }, async ({ id, limit, cursor }) => {
    if (id) {
      const c = await loadConnector(deps, id);
      if (!c.ok) return c.status === 404 ? notFound(id) : apiError(c, `Reading connector ${id}`);
      const t = await apiGet(deps, `/connectors/${enc(id)}/tools`);
      const tools = t.ok ? ((t.data as { tools?: Array<{ name: string; description?: string; policy: string }> })?.tools ?? []).map((x) => ({ name: x.name, ...(x.description ? { description: short(x.description, 200) } : {}), policy: x.policy })) : undefined;
      const v = view(c.connector);
      return ok(`${line(v).slice(2)}${tools ? `\ntools:\n${tools.map((x) => `- ${x.name} [${x.policy}]${x.description ? `: ${short(x.description, 100)}` : ""}`).join("\n") || "(none)"}` : `\n(tools not available: ${t.ok ? "" : t.error})`}`,
        { items: [v], next_cursor: null, total: 1, ...(tools ? { tools } : {}) });
    }
    const r = await apiGet(deps, "/connectors");
    if (!r.ok) return apiError(r, "Listing connectors");
    const p = page(((r.data as { connectors?: Connector[] })?.connectors ?? []).map(view), limit ?? 50, cursor);
    if (!p) return fail(BAD_CURSOR);
    return ok(`${p.items.map(line).join("\n") || "No connectors. Find one with polpo_connector_catalog."}${p.next_cursor ? `\n(more: cursor ${p.next_cursor})` : ""}`, p);
  });

  const catalogItem = z.object({
    id: z.string(), name: z.string(), category: z.string(), description: z.string(), auth: z.string(),
    url: z.string().optional(), url_template: z.string().optional(), needs: z.string().optional(), docs: z.string().optional(),
  });

  tool("connectors", "polpo_connector_catalog", {
    title: "Search the connector catalog",
    description: "Well-known remote MCP servers that can be added in one step (polpo_connector_add with catalog_id): what each does, how it signs in "
      + "(oauth: the person opens a link; bearer: a token entered in the dashboard; oauth_preregistered: an OAuth app set up once in the dashboard).",
    inputSchema: {
      text: z.string().optional().describe("Words, e.g. crm, google, jira"),
      category: z.string().optional().describe("Only this category"),
      limit: limitParam(30, 200),
      cursor: cursorParam(),
    },
    outputSchema: pageOutput(catalogItem),
    annotations: READ,
  }, async ({ text, category, limit, cursor }) => {
    const r = await apiGet(deps, "/connectors/catalog");
    if (!r.ok) return apiError(r, "Reading the catalog");
    const d = r.data as { entries: CatalogEntry[]; oauthApps?: Array<{ id: string; hasSecret?: boolean }> };
    const apps = new Set((d.oauthApps ?? []).map((a) => a.id));
    const words = (text ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    const all = (d.entries ?? [])
      .filter((e) => words.every((w) => `${e.id} ${e.name} ${e.category} ${e.description}`.toLowerCase().includes(w)) && (!category || e.category.toLowerCase() === category.toLowerCase()))
      .map((e) => ({
        id: e.id, name: e.name, category: e.category, description: e.description, auth: e.auth,
        ...(e.url ? { url: e.url } : {}), ...(e.urlTemplate ? { url_template: e.urlTemplate } : {}),
        ...(e.auth === "bearer" ? { needs: "a token, entered in the dashboard" }
          : e.auth === "oauth_preregistered" && !apps.has(e.oauth?.app ?? e.id) ? { needs: `the "${e.oauth?.app ?? e.id}" OAuth app, set up once in the dashboard` } : {}),
        ...(e.docs ? { docs: e.docs } : {}),
      }));
    const p = page(all, limit ?? 30, cursor);
    if (!p) return fail(BAD_CURSOR);
    return ok(`${p.items.map((e) => `- ${e.id}: ${e.name} (${e.category}, ${e.auth}) — ${short(e.description, 120)}${e.url_template ? ` [your URL: ${e.url_template}]` : ""}${e.needs ? ` [needs ${e.needs}]` : ""}`).join("\n") || "Nothing matches."}`
      + `${p.next_cursor ? `\n(${p.total} in all; more: cursor ${p.next_cursor})` : ""}`, p);
  });

  tool("connectors", "polpo_connector_add", {
    title: "Add a connector",
    description: "Add a connector from the catalog (catalog_id) or a remote MCP server (url, https). For OAuth ones it returns authorization_url: "
      + "give it to the person to open and sign in. Servers that need a token or an OAuth app's secret are added but finished in the dashboard (setup_url): "
      + "secrets never go through this connector. Agents get its tools only when listed in agents; Polpo by default.",
    inputSchema: {
      catalog_id: z.string().optional().describe("A catalog id (polpo_connector_catalog)"),
      url: z.string().url().optional().describe("A remote MCP server's URL, or your account's URL for catalog entries with a url_template"),
      name: z.string().max(80).optional().describe("Display name (default: the catalog's name, or the host)"),
      id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, "lowercase letters, digits and -").optional().describe("Slug used in tool names mcp__<id>__<tool>"),
      transport: z.enum(["http", "sse"]).optional().describe("http (default: streamable HTTP, falls back to SSE) or sse"),
      auth: z.enum(["none", "oauth"]).optional().describe("For a custom URL: none (default) or oauth. Token-based servers are set up in the dashboard"),
      agents: z.union([z.array(z.string()), z.literal("*")]).optional().describe("Agents that may use its tools ('*' for all; default none)"),
      polpo: z.boolean().optional().describe("Polpo may use its tools (default true)"),
    },
    outputSchema: {
      connector: connectorItem, authorization_url: z.string().optional(), setup_url: z.string().optional(),
      next: z.string().describe("What to do next"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ catalog_id, url, name, id, transport, auth, agents, polpo }) => {
    if (!catalog_id && !url) return fail("Give catalog_id (polpo_connector_catalog) or the url of a remote MCP server.");
    if (Array.isArray(agents)) {
      const missing = await unknownAgents(deps, agents);
      if (missing) return fail(missing);
    }
    let entry: CatalogEntry | undefined;
    if (catalog_id) {
      const cat = await apiGet(deps, "/connectors/catalog");
      if (!cat.ok) return apiError(cat, "Reading the catalog");
      entry = ((cat.data as { entries: CatalogEntry[] }).entries ?? []).find((e) => e.id === catalog_id);
      if (!entry) return fail(`There is no catalog entry "${catalog_id}". Search with polpo_connector_catalog.`);
      if (entry.urlTemplate && !url) return fail(`${entry.name} needs your account's URL: pass url, following ${entry.urlTemplate}.`);
      if (auth) return fail("auth is for custom URLs: a catalog entry signs in its own way.");
    }
    const derivedName = name ?? (entry ? undefined : (() => { try { return new URL(url!).hostname.replace(/^(www|mcp|api)\./, ""); } catch { return undefined; } })());
    const r = await apiSend(deps, "POST", "/connectors", {
      ...(entry ? { catalogId: entry.id } : {}), ...(url ? { url } : {}), ...(derivedName ? { name: derivedName } : {}), ...(id ? { id } : {}),
      // never a local process (stdio) from here: a remote transport, the catalog's or http
      ...(transport ? { transport: { type: transport } } : entry ? {} : { transport: { type: "http" } }),
      ...(auth ? { auth: { type: auth } } : {}),
      access: { ...(agents !== undefined ? { agents } : {}), ...(polpo !== undefined ? { polpo } : {}) },
    });
    if (!r.ok) return apiError(r, "Adding the connector", /url|private|https/i.test(r.error) ? "Give a public https URL of a remote MCP server." : undefined);
    const c = r.data as Connector;
    const v = view(c);
    const setup = setupUrl(c.id);
    if (c.auth.type === "bearer" || c.auth.type === "headers") {
      const h = setupHandoff(deps, { kind: "connector", item: c.id, field: c.auth.type === "bearer" ? "bearerToken" : "headers" }, "token");
      return ok(`Added ${c.name} [${c.id}]. It needs a token (secrets never go through this connector). ${h.next_step}`,
        { connector: v, ...h, next: "Enter the token in the dashboard, then polpo_setup_wait and polpo_connector_test" });
    }
    if (c.auth.type === "oauth") {
      const start = await oauthStart(c.id);
      if (!start.ok) {
        return ok(`Added ${c.name} [${c.id}], but it cannot be authorized yet: ${start.error}. ${entry?.setup ? `${entry.setup}\n` : ""}The person finishes the setup in the dashboard (${setup}), then polpo_connector_connect.`,
          { connector: v, setup_url: setup, next: "Finish the OAuth setup in the dashboard, then polpo_connector_connect" });
      }
      if (start.url) {
        return ok(`Added ${c.name} [${c.id}]. The person opens this link to sign in and allow it:\n${start.url}\nThen check it with polpo_connectors_list { id: "${c.id}" }.`,
          { connector: v, authorization_url: start.url, next: "Open authorization_url, sign in, then polpo_connectors_list with id" });
      }
    }
    const test = await apiSend(deps, "POST", `/connectors/${enc(c.id)}/test`);
    const t = test.ok ? test.data as { ok: boolean; error?: string; tools?: unknown[]; connector?: Connector } : undefined;
    const after = t?.connector ? view(t.connector) : v;
    return ok(`Added ${c.name} [${c.id}]. ${t?.ok ? `Connected: ${t.tools?.length ?? 0} tools.` : `The first connection failed: ${t?.error ?? (test.ok ? "unknown" : test.error)}.`}`,
      { connector: after, next: t?.ok ? "Grant agents with polpo_connector_update if needed" : "Check the URL, then polpo_connector_test" });
  });

  tool("connectors", "polpo_connector_update", {
    title: "Change a connector",
    description: "Change who may use a connector (agents: the full list or '*'; add_agents / remove_agents), whether Polpo may, turn it on or off, "
      + "rename it, or set its tools' policy (allow, ask: the person approves each call in the chat, off: hidden). Only the fields given change.",
    inputSchema: {
      id: z.string().min(1).describe("The connector's id"),
      name: z.string().min(1).max(80).optional().describe("A new display name"),
      description: z.string().max(500).optional().describe("A new description"),
      enabled: z.boolean().optional().describe("false turns it off, true on"),
      agents: z.union([z.array(z.string()), z.literal("*")]).optional().describe("The agents that may use it from now on ('*' for all)"),
      add_agents: z.array(z.string()).optional().describe("Agents to grant"),
      remove_agents: z.array(z.string()).optional().describe("Agents to take it from"),
      polpo: z.boolean().optional().describe("Polpo may use its tools"),
      tool_policy: z.record(z.string(), z.enum(["allow", "ask", "off"])).optional().describe("Per tool (the server's tool name): allow, ask or off; merged with the current policy"),
    },
    outputSchema: { connector: connectorItem, changed: z.array(z.string()) },
    annotations: UPDATE,
  }, async ({ id, name, description, enabled, agents, add_agents, remove_agents, polpo, tool_policy }) => {
    const cur = await loadConnector(deps, id);
    if (!cur.ok) return cur.status === 404 ? notFound(id) : apiError(cur, `Reading connector ${id}`);
    const c = cur.connector;
    let nextAgents: string[] | "*" | undefined = agents;
    if (add_agents?.length || remove_agents?.length) {
      const base = agents ?? c.access.agents;
      if (base === "*") return fail("It is granted to every agent: pass agents with the full list instead of add_agents / remove_agents.");
      nextAgents = [...new Set([...base, ...(add_agents ?? [])])].filter((a) => !(remove_agents ?? []).includes(a));
    }
    if (Array.isArray(nextAgents)) {
      const missing = await unknownAgents(deps, nextAgents);
      if (missing) return fail(missing);
    }
    const body = {
      ...(name !== undefined ? { name } : {}), ...(description !== undefined ? { description } : {}), ...(enabled !== undefined ? { enabled } : {}),
      ...(nextAgents !== undefined || polpo !== undefined ? { access: { agents: nextAgents ?? c.access.agents, polpo: polpo ?? c.access.polpo } } : {}),
      ...(tool_policy ? { toolPolicy: { ...(c.toolPolicy ?? {}), ...tool_policy } } : {}),
    };
    if (Object.keys(body).length === 0) return fail("Nothing to change: give name, description, enabled, agents, add_agents, remove_agents, polpo or tool_policy.");
    const r = await apiSend(deps, "PATCH", `/connectors/${enc(id)}`, body);
    if (!r.ok) return apiError(r, `Updating connector ${id}`);
    const after = r.data as Connector;
    const changed = [
      ...(name !== undefined && name !== c.name ? ["name"] : []), ...(description !== undefined && description !== c.description ? ["description"] : []),
      ...(enabled !== undefined && enabled !== c.enabled ? ["enabled"] : []),
      ...(JSON.stringify(after.access.agents) !== JSON.stringify(c.access.agents) ? ["agents"] : []), ...(after.access.polpo !== c.access.polpo ? ["polpo"] : []),
      ...(tool_policy && JSON.stringify(after.toolPolicy ?? {}) !== JSON.stringify(c.toolPolicy ?? {}) ? ["tool_policy"] : []),
    ];
    const v = view(after);
    return ok(changed.length ? `Updated ${id}: ${changed.join(", ")}.\n${line(v).slice(2)}` : `Nothing changed on ${id} (the values were the same).`, { connector: v, changed });
  });

  tool("connectors", "polpo_connector_test", {
    title: "Test a connector",
    description: "Connect to a connector now and list its tools: it says whether it works, needs authorization (polpo_connector_connect) or fails and why.",
    inputSchema: { id: z.string().min(1).describe("The connector's id") },
    outputSchema: { ok: z.boolean(), status: z.string(), error: z.string().optional(), tools: z.array(z.string()), connector: connectorItem.optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ id }) => {
    const r = await apiSend(deps, "POST", `/connectors/${enc(id)}/test`);
    if (!r.ok) return r.status === 404 ? notFound(id) : apiError(r, `Testing connector ${id}`);
    const d = r.data as { ok: boolean; status: string; error?: string; tools?: Array<{ name: string }>; connector?: Connector };
    const tools = (d.tools ?? []).map((t) => t.name);
    const next = d.status === "needs_auth" || d.status === "needs_reauth" ? " Authorize it with polpo_connector_connect." : "";
    return ok(d.ok ? `${id} works: ${tools.length} tools (${short(tools.join(", "), 600)}).` : `${id} does not work (${d.status}): ${d.error ?? "unknown error"}.${next}`,
      { ok: d.ok, status: d.status, ...(d.error ? { error: d.error } : {}), tools, ...(d.connector ? { connector: view(d.connector) } : {}) });
  });

  tool("connectors", "polpo_connector_connect", {
    title: "Authorize a connector",
    description: "For an OAuth connector (new, or needs_reauth): returns authorization_url for the person to open and sign in. "
      + "Connectors that need a token or an OAuth app's secret are set up in the dashboard (setup_url).",
    inputSchema: { id: z.string().min(1).describe("The connector's id") },
    outputSchema: { authorized: z.boolean(), authorization_url: z.string().optional(), setup_url: z.string().optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ id }) => {
    const cur = await loadConnector(deps, id);
    if (!cur.ok) return cur.status === 404 ? notFound(id) : apiError(cur, `Reading connector ${id}`);
    const setup = setupUrl(id);
    if (cur.connector.auth.type !== "oauth") {
      return ok(`${id} signs in with ${cur.connector.auth.type === "none" ? "nothing (test it with polpo_connector_test)" : `a token, entered in the dashboard: ${setup}`}.`, { authorized: false, setup_url: setup });
    }
    const start = await oauthStart(id);
    if (!start.ok) return fail(`${id} cannot be authorized from here: ${start.error}. The person finishes the setup in the dashboard: ${setup}`);
    if (start.authorized) return ok(`${id} is authorized already.`, { authorized: true });
    return ok(`The person opens this link to sign in and allow ${cur.connector.name}:\n${start.url}`, { authorized: false, ...(start.url ? { authorization_url: start.url } : {}) });
  });

  tool("connectors", "polpo_connector_disconnect", {
    title: "Disconnect a connector",
    description: "Sign a connector out: its OAuth tokens are revoked and forgotten (the configuration stays; polpo_connector_connect signs in again). Needs confirm: true.",
    inputSchema: { id: z.string().min(1).describe("The connector's id"), confirm: confirmParam("disconnect it") },
    outputSchema: { connector: connectorItem },
    annotations: DESTRUCTIVE,
  }, async ({ id, confirm }) => {
    const cur = await loadConnector(deps, id);
    if (!cur.ok) return cur.status === 404 ? notFound(id) : apiError(cur, `Reading connector ${id}`);
    if (confirm !== true) return fail(`Disconnecting ${cur.connector.name} signs it out: agents lose its tools until someone signs in again. Ask the person, then call again with confirm: true.`);
    const r = await apiSend(deps, "POST", `/connectors/${enc(id)}/disconnect`);
    if (!r.ok) return apiError(r, `Disconnecting ${id}`);
    return ok(`Disconnected ${id}.`, { connector: view(r.data as Connector) });
  });

  tool("connectors", "polpo_connector_remove", {
    title: "Remove a connector",
    description: "Remove a connector: its tokens are revoked, its secrets and configuration deleted; agents lose its tools. It cannot be undone. Needs confirm: true.",
    inputSchema: { id: z.string().min(1).describe("The connector's id"), confirm: confirmParam("remove the connector") },
    outputSchema: { id: z.string(), removed: z.boolean() },
    annotations: DESTRUCTIVE,
  }, async ({ id, confirm }) => {
    const cur = await loadConnector(deps, id);
    if (!cur.ok) return cur.status === 404 ? notFound(id) : apiError(cur, `Reading connector ${id}`);
    if (confirm !== true) return fail(`Removing ${cur.connector.name} deletes it and its secrets for good: ask the person, then call again with confirm: true.`);
    const r = await apiSend(deps, "DELETE", `/connectors/${enc(id)}`);
    if (!r.ok) return apiError(r, `Removing ${id}`);
    return ok(`Removed connector ${id}.`, { id, removed: true });
  });
}
