/**
 * Polpo's connector management tools: list the connectors (status, tools, who can use them), add
 * one from the catalog or a custom URL (OAuth: returns the link the person opens), change who may
 * use it, connect it again, remove it (only after the person confirms). Local (stdio) connectors
 * are not available here: they run a command on the server, so only an admin adds them via the API.
 */
import { Type } from "typebox";
import type { Tool } from "@earendil-works/pi-ai";
import type { ConnectorConfig } from "@polpo-ai/core";
import { CONNECTOR_CATALOG, catalogEntry } from "../mcp/catalog.js";
import type { ConnectorManager } from "../mcp/manager.js";
import { allowPrivateNetwork } from "../mcp/net.js";
import { applyConnectorPatch, buildConnector, type ConnectorInput } from "../mcp/validate.js";
import { mcpToolName } from "../mcp/tools.js";

const Agents = Type.Union([Type.Array(Type.String()), Type.Literal("*")], { description: "Agent names, or \"*\" for every agent" });

export const CONNECTOR_TOOLS: Tool[] = [
  {
    name: "connectors_list",
    description: "List the connectors (external apps over MCP: Linear, Notion, Gmail, GitHub, custom servers): status (connected, needs (re)authorization, error), "
      + "tool count, who may use them (agents, Polpo). With catalog: true, also the catalog of apps that can be added with connector_add.",
    parameters: Type.Object({
      catalog: Type.Optional(Type.Boolean({ description: "Also list the catalog of well-known apps (ids and names)" })),
      search: Type.Optional(Type.String({ description: "Search the catalog (e.g. \"crm\", \"google\", \"jira\"), with descriptions" })),
      tools: Type.Optional(Type.String({ description: "A connector id: list its tools" })),
    }),
  },
  {
    name: "connector_add",
    description: "Add a connector: from the catalog (catalogId, e.g. \"linear\", \"notion\", \"gmail\") or a custom remote MCP server (url). "
      + "For OAuth apps it returns a link the person must open to authorize; give them the link. For token-based ones pass the token "
      + "(stored in the vault, never shown again). Agents get its tools only when granted (agents), Polpo when polpo is true (default).",
    parameters: Type.Object({
      catalogId: Type.Optional(Type.String({ description: "Catalog id (connectors_list with catalog: true)" })),
      url: Type.Optional(Type.String({ description: "Custom MCP server URL (https), or the per-account URL for catalog entries that need one" })),
      name: Type.Optional(Type.String({ description: "Display name (default: the catalog name)" })),
      id: Type.Optional(Type.String({ description: "Slug used in tool names mcp__<id>__<tool> (default: from the name)" })),
      transport: Type.Optional(Type.Union([Type.Literal("http"), Type.Literal("sse")], { description: "Default http (streamable HTTP, falls back to SSE)" })),
      auth: Type.Optional(Type.Union([Type.Literal("none"), Type.Literal("bearer"), Type.Literal("oauth")], { description: "Default: the catalog's, else none" })),
      token: Type.Optional(Type.String({ description: "auth bearer: the API token" })),
      agents: Type.Optional(Agents),
      polpo: Type.Optional(Type.Boolean({ description: "Polpo may use its tools (default true)" })),
    }),
  },
  {
    name: "connector_connect",
    description: "Connect a connector again: for OAuth ones returns a fresh authorization link (after \"needs_reauth\"); for the others tests the connection and lists its tools.",
    parameters: Type.Object({ id: Type.String({ description: "Connector id" }) }),
  },
  {
    name: "connector_update_access",
    description: "Change who may use a connector's tools (agents: the full list or \"*\"; addAgents / removeAgents to change it), whether Polpo may, and turn it on or off.",
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
}

function describe(c: ConnectorConfig): string {
  const who = [c.access.agents === "*" ? "every agent" : c.access.agents.length ? `agents: ${c.access.agents.join(", ")}` : "no agent", c.access.polpo ? "Polpo" : ""].filter(Boolean).join(" + ");
  const where = c.transport.type === "stdio" ? `local command ${c.transport.command}` : c.transport.url;
  const status = c.enabled ? (c.status ?? "not connected yet") : "disabled";
  return `- ${c.name} [${c.id}] ${status}${c.toolCount !== undefined ? `, ${c.toolCount} tools` : ""}${c.lastError ? ` (${c.lastError.slice(0, 160)})` : ""}; `
    + `auth ${c.auth.type}; used by ${who}; ${where}; tools mcp__${c.id}__*`;
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
        if (typeof args.tools === "string" && args.tools) {
          const connector = manager.store.get(args.tools);
          if (!connector) return `No connector "${args.tools}".`;
          const tools = await manager.listTools(connector.id);
          return tools.length
            ? tools.map((t) => `- ${mcpToolName(connector.id, t.name)}${connector.toolPolicy?.[t.name] === "off" ? " (off)" : ""}: ${(t.description ?? "").split("\n")[0]!.slice(0, 160)}`).join("\n")
            : `${connector.name} has no tools.`;
        }
        const list = manager.store.list();
        const lines = [list.length ? `Connectors:\n${list.map(describe).join("\n")}` : "No connectors yet."];
        if (args.catalog || typeof args.search === "string") {
          const words = typeof args.search === "string" ? args.search.toLowerCase().split(/\s+/).filter(Boolean) : [];
          const entries = CONNECTOR_CATALOG.filter((e) => words.every((w) => `${e.id} ${e.name} ${e.category} ${e.description}`.toLowerCase().includes(w)));
          lines.push(`Catalog (connector_add with catalogId; ${entries.length} of ${CONNECTOR_CATALOG.length}):`, ...entries.map((e) =>
            `- ${e.id}: ${e.name} (${e.category})${words.length ? ` — ${e.description}` : ""}`
            + `${e.auth === "oauth_preregistered" ? ` [needs the "${e.oauth?.app}" OAuth app set up once]` : e.auth === "bearer" ? " [needs a token]" : ""}`
            + `${e.urlTemplate ? ` [needs your URL: ${e.urlTemplate}]` : ""}${e.variants ? ` [regions: ${e.variants.map((v) => `${v.label} ${v.url}`).join(", ")}]` : ""}`));
        }
        return lines.join("\n");
      }
      case "connector_add": {
        const entry = typeof args.catalogId === "string" ? catalogEntry(args.catalogId) : undefined;
        if (args.catalogId && !entry) return `Unknown catalog id "${args.catalogId}". connectors_list with catalog: true lists them.`;
        const input: ConnectorInput = {
          ...(entry ? { catalogId: entry.id } : {}),
          ...(typeof args.name === "string" ? { name: args.name } : {}),
          ...(typeof args.id === "string" ? { id: args.id } : {}),
          ...(typeof args.url === "string" ? { url: args.url } : {}),
          ...(args.transport ? { transport: { type: args.transport as "http" | "sse" } } : {}),
          ...(args.auth ? { auth: { type: args.auth as "none" | "bearer" | "oauth" } } : {}),
          ...(typeof args.token === "string" ? { secrets: { bearerToken: args.token } } : {}),
          access: {
            ...(args.agents !== undefined ? { agents: args.agents as string[] | "*" } : {}),
            ...(args.polpo !== undefined ? { polpo: args.polpo === true } : {}),
          },
        };
        if (!entry && !input.url) return "Give a catalogId or the url of a remote MCP server.";
        if (!input.name && !entry) input.name = new URL(input.url!).hostname.replace(/^(www|mcp|api)\./, "");
        const { connector, secrets } = await buildConnector(input, {
          allowStdio: false,
          existingIds: manager.store.list().map((c) => c.id),
          allowPrivateNetwork: allowPrivateNetwork(ctx.settings),
        });
        const known = new Set(await ctx.agentNames());
        const unknown = connector.access.agents === "*" ? [] : connector.access.agents.filter((a) => !known.has(a));
        if (unknown.length) return `Unknown agents: ${unknown.join(", ")}.`;
        if (Object.values(secrets).some(Boolean) && !manager.secrets.available) return "The vault is not available: cannot store the token.";
        manager.store.create(connector);
        if (Object.keys(secrets).length) await manager.secrets.patch(connector.id, secrets);
        manager.announce(connector.id, "created");
        const head = `Added ${connector.name} [${connector.id}] (tools mcp__${connector.id}__*).`;
        if (connector.auth.type === "oauth") {
          const app = connector.auth.oauth?.app;
          if (app && !manager.store.getOAuthApp(app)) {
            return `${head} It needs the "${app}" OAuth app set up once before it can be authorized:\n${entry?.setup ?? ""}\nThen call connector_connect.`;
          }
          return `${head}\n${await oauthLink(ctx, connector.id)}`;
        }
        const test = await manager.test(connector.id);
        return test.ok ? `${head} Connected: ${test.tools?.length ?? 0} tools.` : `${head} The first connection failed: ${test.error}`;
      }
      case "connector_connect": {
        const connector = manager.store.get(String(args.id ?? ""));
        if (!connector) return `No connector "${args.id}".`;
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
