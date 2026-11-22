/**
 * A task's optional tool scope (Task.toolScope): pure helpers for the task page's
 * "Tools for this task" card and editor. Mirrors @polpo-ai/core task-tool-scope.ts: the scope
 * only narrows what the agent has; no scope = the task inherits everything from its agent.
 */
import { agentHasAccess, connectorToolsEntry, type AgentConnectorTools, type Connector } from "@/lib/connectors-api";

export interface TaskToolScope {
  connectors?: string[] | "none";
  connectorTools?: Record<string, "*" | string[]>;
  allowedTools?: string[];
}

/** What the editor holds: inherit, or the picked connectors (each "*" or tool names) and built-in tools. */
export interface ToolScopeDraft {
  mode: "inherit" | "restrict";
  /** Connector id → "*" (all the agent gets of it) or the picked tool names. Absent: not used. */
  connectors: Record<string, "*" | string[]>;
  /** null: the agent's built-in tools; a list: only these. */
  builtin: string[] | null;
}

/** Built-in tools an agent without allowedTools gets (core, HTTP, Ink): what the editor offers. */
export const DEFAULT_BUILTIN_TOOLS = ["read", "write", "edit", "bash", "glob", "grep", "ls", "http_fetch", "http_download"] as const;

const isConnectorPattern = (p: string) => /^mcp_/i.test(p);

/** The built-in tools (and patterns) the agent has: its allowedTools without connector patterns, else the defaults. */
export function agentBuiltinTools(agent: { allowedTools?: string[] } | undefined): string[] {
  if (agent?.allowedTools) return agent.allowedTools.filter((t) => !isConnectorPattern(t));
  return [...DEFAULT_BUILTIN_TOOLS];
}

/** Connectors the agent can use: on, granted to it, and not narrowed to no tool on the agent. */
export function agentConnectors(connectors: Connector[], agent: { name: string; connectorTools?: AgentConnectorTools } | undefined): Connector[] {
  if (!agent) return [];
  return connectors.filter((c) => c.enabled && agentHasAccess(c.access, agent.name)
    && !(Array.isArray(agent.connectorTools?.[c.id]) && agent.connectorTools![c.id]!.length === 0));
}

/** The agent's own selection of a connector's tools: "*" or the names it gets. */
export function agentConnectorSelection(agent: { connectorTools?: AgentConnectorTools } | undefined, connectorId: string): "*" | string[] {
  return connectorToolsEntry(agent?.connectorTools, connectorId);
}

/** The editor's draft for a saved scope (connectors it does not name: all of the agent's when connectors is absent). */
export function draftFromScope(scope: TaskToolScope | undefined | null, available: Connector[]): ToolScopeDraft {
  if (!scope) return { mode: "inherit", connectors: {}, builtin: null };
  const ids = scope.connectors === "none" ? []
    : Array.isArray(scope.connectors) ? scope.connectors
    : available.map((c) => c.id);
  const connectors: ToolScopeDraft["connectors"] = {};
  for (const id of ids) {
    const tools = scope.connectorTools?.[id];
    connectors[id] = Array.isArray(tools) ? [...tools] : "*";
  }
  return { mode: "restrict", connectors, builtin: scope.allowedTools ? [...scope.allowedTools] : null };
}

/** The scope to save for a draft: null to inherit (clears it). */
export function scopeFromDraft(draft: ToolScopeDraft): TaskToolScope | null {
  if (draft.mode === "inherit") return null;
  const ids = Object.keys(draft.connectors);
  const scope: TaskToolScope = { connectors: ids.length ? ids : "none" };
  const picked = Object.entries(draft.connectors).filter(([, t]) => Array.isArray(t)) as Array<[string, string[]]>;
  if (picked.length) scope.connectorTools = Object.fromEntries(picked.map(([id, t]) => [id, [...new Set(t)]]));
  if (draft.builtin) scope.allowedTools = [...new Set(draft.builtin)];
  return scope;
}

/** How a connector is named in the scope: "Gmail 2 – info@acme.com" (name plus account when it does not say it). */
export function connectorScopeName(connector: Pick<Connector, "id" | "name"> & { account?: string } | undefined, id: string): string {
  if (!connector) return id;
  const account = connector.account?.trim();
  return account && !connector.name.toLowerCase().includes(account.toLowerCase()) ? `${connector.name} – ${account}` : connector.name;
}

/** The badge text: "Inherit from agent", or "Restricted: Linear (3 tools), Gmail – info@…; built-in: read, grep". */
export function describeToolScope(scope: TaskToolScope | undefined | null, connectors: Array<Pick<Connector, "id" | "name"> & { account?: string }>): string {
  if (!scope) return "Inherit from agent";
  const parts: string[] = [];
  if (scope.connectors === "none") parts.push("no connectors");
  else {
    const ids = Array.isArray(scope.connectors) ? scope.connectors : Object.keys(scope.connectorTools ?? {});
    const named = ids.map((id) => {
      const tools = scope.connectorTools?.[id];
      const name = connectorScopeName(connectors.find((c) => c.id === id), id);
      return Array.isArray(tools) ? `${name} (${tools.length} tool${tools.length === 1 ? "" : "s"})` : name;
    });
    if (named.length) parts.push(named.join(", ") + (scope.connectors === undefined ? " (other connectors as the agent)" : ""));
  }
  if (scope.allowedTools) parts.push(`built-in: ${scope.allowedTools.length ? scope.allowedTools.join(", ") : "none"}`);
  return `Restricted: ${parts.join("; ") || "as the agent"}`;
}

/** Problems the editor shows before saving (the server checks again). */
export function draftProblems(draft: ToolScopeDraft): string[] {
  if (draft.mode === "inherit") return [];
  const problems: string[] = [];
  for (const [id, tools] of Object.entries(draft.connectors)) {
    if (Array.isArray(tools) && tools.length === 0) problems.push(`No tool picked for ${id}: pick some, choose "All", or leave the connector out.`);
  }
  return problems;
}
