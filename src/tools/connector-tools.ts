/**
 * Polpo's connector management tools: list the connectors (status, tools, who can use them), change
 * who may use one, connect it again, remove it (only after the person confirms). Adding one is
 * connector_add, the MCP server's own tool run in process (src/llm/polpo-mcp-bridge.ts): secrets
 * (tokens, OAuth app secrets) never pass through the chat, the person enters them from a setup link. Local (stdio) connectors
 * are not available here: they run a command on the server, so only an admin adds them via the API.
 * Per-identity connectors' accounts are managed with connector_accounts / connector_account_* (also
 * MCP tools run in process): each agent / person signs its own accounts in from a link.
 */
import { Type } from "typebox";
import type { Tool } from "@earendil-works/pi-ai";
import {
  agentConnectorIdentity, connectorAccountsOf, connectorFallbackOn, connectorGrants, connectorIdentityLabel, connectorOwner, connectorVisibleTo,
  isIdentityConnector, ORG_CONNECTOR_IDENTITY, type ConnectorAccount, type ConnectorConfig,
} from "@polpo-ai/core";
import { CONNECTOR_CATALOG } from "../mcp/catalog.js";
import type { ConnectorManager } from "../mcp/manager.js";
import { allowPrivateNetwork } from "../mcp/net.js";
import { applyConnectorPatch } from "../mcp/validate.js";
import { mcpToolName } from "../mcp/tools.js";
import { connectorLabel } from "../mcp/view.js";

const Agents = Type.Union([Type.Array(Type.String()), Type.Literal("*")], { description: "Agent names, or \"*\" for every agent" });

export const CONNECTOR_TOOLS: Tool[] = [
  {
    name: "connectors_list",
    description: "List the connectors (external apps over MCP: Linear, Notion, Gmail, GitHub, custom servers): status (connected, needs (re)authorization, error), "
      + "tool count, who may use them (agents, Polpo). Several accounts of one app have their own ids (gmail, gmail-2…) and names, unless the connector is "
      + "per identity (one id for the app, each agent / person with its own accounts: connector_accounts). "
      + "With catalog: true, also the catalog of apps that can be added with connector_add (again, with a name, for another account).",
    parameters: Type.Object({
      catalog: Type.Optional(Type.Boolean({ description: "Also list the catalog of well-known apps (ids and names)" })),
      search: Type.Optional(Type.String({ description: "Search the catalog (e.g. \"crm\", \"google\", \"jira\"), with descriptions" })),
      tools: Type.Optional(Type.String({ description: "A connector id: list its tools" })),
      agent: Type.Optional(Type.String({ description: "An agent's name: which connectors it may use (and which tools it gets), and which it has no access to. "
        + "Check it before setting a task's toolScope: a scope never grants." })),
    }),
  },
  {
    name: "connector_connect",
    description: "Connect a connector again: for OAuth ones returns a fresh authorization link (after \"needs_reauth\"); for the others tests the connection and lists its tools.",
    parameters: Type.Object({ id: Type.String({ description: "Connector id" }) }),
  },
  {
    name: "connector_update_access",
    description: "Change who may use a connector's tools (agents: the full list or \"*\"; addAgents / removeAgents to change it), whether Polpo may, and turn it on or off. "
      + "An agent's own (personal) connector can only be enabled for that agent: other agents or \"*\" are refused (connector_update with owner changes the scope).",
    parameters: Type.Object({
      id: Type.String({ description: "Connector id" }),
      agents: Type.Optional(Agents),
      addAgents: Type.Optional(Type.Array(Type.String())),
      removeAgents: Type.Optional(Type.Array(Type.String())),
      polpo: Type.Optional(Type.Boolean()),
      enabled: Type.Optional(Type.Boolean()),
    }),
  },
  {
    name: "connector_remove",
    description: "Remove a connector: revokes its authorization when the app supports it and deletes its secrets. Ask the person first; call with confirm: true only after they explicitly agreed.",
    parameters: Type.Object({
      id: Type.String({ description: "Connector id" }),
      confirm: Type.Optional(Type.Boolean({ description: "true only after the person explicitly confirmed the removal" })),
    }),
  },
];

export const CONNECTOR_TOOL_NAMES = new Set(CONNECTOR_TOOLS.map((t) => t.name));

export interface ConnectorToolContext {
  manager: ConnectorManager;
  settings?: { connectors?: { allowPrivateNetwork?: boolean } };
  /** This instance's OAuth redirect URI, when known. */
  redirectUri?: string;
  agentNames: () => Promise<string[]>;
  /** An agent's per-connector tool selection (connectors_list { agent }); undefined: no such agent. */
  agentConnectorTools?: (name: string) => Promise<{ connectorTools?: Record<string, "*" | string[]> } | undefined>;
}

/** What to tell Polpo when `agent` is not granted `connector`: offer the grant first, then the scope. */
export function noAccessNote(agent: string, c: Pick<ConnectorConfig, "id" | "name" | "account" | "enabled">): string {
  return `Agent "${agent}" has no access to ${connectorLabel(c)} (${c.id})${c.enabled ? "" : " (it is turned off)"}: a task's toolScope never grants it. `
    + `Offer the person to grant it first (connector_update_access { id: "${c.id}", addAgents: ["${agent}"]${c.enabled ? "" : ", enabled: true"} }), then set the scope.`;
}

const accountText = (a: ConnectorAccount) => `"${a.label}"${a.default ? " (default)" : ""}${a.account && a.account !== a.label ? ` = ${a.account}` : ""} ${a.status ?? "not connected yet"}`;

/** A per-identity connector's accounts, by identity (`agent`: only its own, and the fallback when on). */
function describeAccounts(c: ConnectorConfig, agent?: string): string {
  const accounts = agent
    ? [...connectorAccountsOf(c, agentConnectorIdentity(agent)), ...(connectorFallbackOn(c) ? connectorAccountsOf(c, ORG_CONNECTOR_IDENTITY) : [])]
    : c.accounts ?? [];
  if (!accounts.length) return agent ? `${agent} has no account on it yet (connector_account_add)` : "no account yet (connector_account_add)";
  const byIdentity = new Map<string, ConnectorAccount[]>();
  for (const a of accounts) byIdentity.set(a.identity, [...(byIdentity.get(a.identity) ?? []), a]);
  return [...byIdentity].map(([identity, list]) => `${connectorIdentityLabel(identity)}: ${list.map(accountText).join(", ")}`).join("; ");
}

function describe(c: ConnectorConfig, agent?: string): string {
  const who = [c.access.agents === "*" ? "every agent" : c.access.agents.length ? `agents: ${c.access.agents.join(", ")}` : "no agent", c.access.polpo ? "Polpo" : ""].filter(Boolean).join(" + ");
  const owner = connectorOwner(c);
  const scope = isIdentityConnector(c)
    ? `per identity (each uses its own accounts${connectorFallbackOn(c) ? ", org fallback on" : ""}; accounts: ${describeAccounts(c, agent)})`
    : owner ? `${owner}'s own (personal: only ${owner} can ever use it)` : "org";
  const where = c.transport.type === "stdio" ? `local command ${c.transport.command}` : c.transport.type === "hosted" ? `hosted by Polpo${c.hostedVersion ? ` (v${c.hostedVersion})` : ""}` : c.transport.url;
  const status = c.enabled ? (isIdentityConnector(c) ? "per identity" : c.status ?? "not connected yet") : "disabled";
  return `- ${connectorLabel(c)} [${c.id}${c.catalogId && c.catalogId !== c.id ? `, another ${c.catalogId} account` : ""}] ${status}${c.toolCount !== undefined ? `, ${c.toolCount} tools` : ""}${c.lastError ? ` (${c.lastError.slice(0, 160)})` : ""}; `
    + `auth ${c.auth.type}; scope ${scope}; used by ${who}; ${where}; tools mcp__${c.id}__*${c.iconAsset ? `; icon: ${c.iconAsset.pinned ? "set by the person" : `found (${c.iconAsset.source})`}` : ""}`;
}

async function oauthLink(ctx: ConnectorToolContext, id: string): Promise<string> {
  if (!ctx.redirectUri) {
    return "To authorize it, open Settings → Connectors in the dashboard and press Connect (this instance's public URL is not known here; set POLPO_PUBLIC_URL).";
  }
  try {
    const result = await ctx.manager.startOAuth(id, ctx.redirectUri);
    if (result.authorized) return "It is already authorized and works.";
    return `The person must open this link to authorize it (valid 10 minutes):\n${result.authorizationUrl}`;
  } catch (err) {
    return `Could not start the authorization: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export async function executeConnectorTool(name: string, args: Record<string, unknown>, ctx: ConnectorToolContext): Promise<string> {
  const { manager } = ctx;
  try {
    switch (name) {
      case "connectors_list": {
        const agent = typeof args.agent === "string" && args.agent.trim() ? args.agent.trim() : undefined;
        let selection: Record<string, "*" | string[]> | undefined;
        if (agent) {
          const known = await ctx.agentNames();
          if (!known.includes(agent)) return `No agent "${agent}". Agents: ${known.join(", ") || "none"}.`;
          selection = (await ctx.agentConnectorTools?.(agent))?.connectorTools ?? {};
        }
        const gets = (id: string, tool: string) => {
          const picked = selection?.[id];
          return picked === undefined || picked === "*" || picked.includes(tool);
        };
        if (typeof args.tools === "string" && args.tools) {
          const connector = manager.store.get(args.tools);
          if (!connector) return `No connector "${args.tools}".`;
          if (agent && !connectorVisibleTo(connector, agent)) {
            return `${connectorLabel(connector)} (${connector.id}) belongs to agent "${connectorOwner(connector)}" (a personal connector): ${agent} can never use it.`;
          }
          const granted = !agent || connectorGrants(connector, agent);
          const tools = await manager.listTools(connector.id);
          const list = tools.length
            ? tools.map((t) => `- ${mcpToolName(connector.id, t.name)}${connector.toolPolicy?.[t.name] === "off" ? " (off)" : ""}`
              + `${agent && granted && !gets(connector.id, t.name) ? ` (not selected for ${agent})` : ""}: ${(t.description ?? "").split("\n")[0]!.slice(0, 160)}`).join("\n")
            : `${connector.name} has no tools.`;
          return agent && !granted ? `${noAccessNote(agent, connector)}\n${list}` : list;
        }
        const list = manager.store.list();
        if (agent) {
          const mine = list.filter((c) => connectorGrants(c, agent));
          // another agent's own connectors are left out: they can never be granted to this one
          const others = list.filter((c) => connectorVisibleTo(c, agent) && !connectorGrants(c, agent));
          const toolsOf = (c: ConnectorConfig) => {
            const picked = selection?.[c.id];
            return picked === undefined || picked === "*" ? "all its tools" : picked.length ? `tools: ${picked.join(", ")}` : "no tools (its connectorTools select none)";
          };
          return [
            mine.length ? `Connectors ${agent} may use:\n${mine.map((c) => `${describe(c, agent)}; ${agent} gets ${toolsOf(c)}`).join("\n")}` : `No connector is granted to ${agent}.`,
            ...(others.length ? [`${agent} has no access to: ${others.map((c) => `${connectorLabel(c)} (${c.id})${c.enabled ? "" : " (turned off)"}`).join(", ")}. `
              + `A task's toolScope never grants: to scope a task of ${agent} to one of these, offer the person to grant it first `
              + `(connector_update_access { id, addAgents: ["${agent}"] }), then set the scope.`] : []),
          ].join("\n");
        }
        const lines = [list.length ? `Connectors:\n${list.map((c) => describe(c)).join("\n")}` : "No connectors yet."];
        if (args.catalog || typeof args.search === "string") {
          const words = typeof args.search === "string" ? args.search.toLowerCase().split(/\s+/).filter(Boolean) : [];
          const entries = CONNECTOR_CATALOG.filter((e) => words.every((w) => `${e.id} ${e.name} ${e.category} ${e.description}`.toLowerCase().includes(w)));
          lines.push(`Catalog (connector_add with catalog_id; ${entries.length} of ${CONNECTOR_CATALOG.length}):`, ...entries.map((e) =>
            `- ${e.id}: ${e.name} (${e.category})${words.length ? ` — ${e.description}` : ""}`
            + `${e.auth === "oauth_preregistered" ? ` [needs the "${e.oauth?.app}" OAuth app set up once]` : e.auth === "bearer" ? " [needs a token]" : ""}`
            + `${e.urlTemplate ? ` [needs your URL: ${e.urlTemplate}]` : ""}${e.variants ? ` [regions: ${e.variants.map((v) => `${v.label} ${v.url}`).join(", ")}]` : ""}`));
        }
        return lines.join("\n");
      }
      case "connector_connect": {
        const connector = manager.store.get(String(args.id ?? ""));
        if (!connector) return `No connector "${args.id}".`;
        if (isIdentityConnector(connector)) {
          return `${connectorLabel(connector)} (${connector.id}) is per identity: each account signs in on its own. `
            + `Use connector_account_connect { id: "${connector.id}", account } (or connector_account_add for a new one; connector_accounts lists them).`;
        }
        if (connector.auth.type === "oauth") return oauthLink(ctx, connector.id);
        const test = await manager.test(connector.id);
        return test.ok ? `${connector.name} is connected: ${test.tools?.length ?? 0} tools.` : `${connector.name} could not connect: ${test.error}`;
      }
      case "connector_update_access": {
        const connector = manager.store.get(String(args.id ?? ""));
        if (!connector) return `No connector "${args.id}".`;
        let agents: string[] | "*" = connector.access.agents;
        if (args.agents !== undefined) agents = args.agents as string[] | "*";
        if (Array.isArray(args.addAgents) || Array.isArray(args.removeAgents)) {
          if (agents === "*") return "It is granted to every agent: pass agents with the full list instead of add/remove.";
          agents = [...new Set([...agents, ...((args.addAgents as string[] | undefined) ?? [])])].filter((a) => !((args.removeAgents as string[] | undefined) ?? []).includes(a));
        }
        const known = new Set(await ctx.agentNames());
        const unknown = agents === "*" ? [] : agents.filter((a) => !known.has(a));
        if (unknown.length) return `Unknown agents: ${unknown.join(", ")}.`;
        const { patch } = await applyConnectorPatch(connector, {
          access: { agents, ...(args.polpo !== undefined ? { polpo: args.polpo === true } : {}) },
          ...(args.enabled !== undefined ? { enabled: args.enabled === true } : {}),
        }, { allowStdio: false, existingIds: [], allowPrivateNetwork: allowPrivateNetwork(ctx.settings) });
        const next = manager.store.update(connector.id, patch);
        if (patch.enabled === false) { await manager.close(connector.id); manager.setStatus(connector.id, "disabled"); }
        else if (patch.enabled === true && connector.status === "disabled") manager.setStatus(connector.id, "disconnected");
        manager.announce(connector.id, "updated");
        return `Updated ${next.name}:\n${describe(manager.store.get(connector.id) ?? next)}`;
      }
      case "connector_remove": {
        const connector = manager.store.get(String(args.id ?? ""));
        if (!connector) return `No connector "${args.id}".`;
        if (args.confirm !== true) {
          return `Removing ${connector.name} revokes its authorization and deletes its secrets; ${describe(connector).slice(2)}. Ask the person to confirm, then call connector_remove with confirm: true.`;
        }
        await manager.remove(connector.id);
        return `Removed ${connector.name}.`;
      }
      default:
        return `Unknown tool: ${name}`;
    }
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}
