/**
 * Per-task tool scope: an optional narrowing of what a task's run may use, on top of what its
 * agent has. Absent: the run inherits everything from the agent (no change). It only narrows:
 *
 * - `connectors`: the connectors (ids; each account of an app is its own connector) the run may
 *   use, or "none". Absent: every connector granted to the agent.
 * - `connectorTools`: per connector, "*" or the server's raw tool names. Narrows the agent's own
 *   `connectorTools` selection (never adds a tool the agent does not get).
 * - `allowedTools`: the built-in (non-connector) tools or patterns (`read`, `bash`, `browser_*`).
 *   Narrows the agent's `allowedTools` (or its default tools when it has none). Connector tools
 *   are chosen with `connectors` / `connectorTools`, not here.
 *
 * Validation (`taskToolScopeGrantProblems`) rejects connectors or tools the agent does not have;
 * at run time (`applyTaskToolScope`) the agent config the engines see is narrowed, so Polpo's
 * engine, progressive tools_search / tools_load and harness host tools all get the same set.
 * The tools every run gets whatever its allowedTools (register_outcome, task_result,
 * dependency_results) are not affected.
 */
import { CONNECTOR_ID_PATTERN, connectorGrants, connectorOwner, connectorVisibleTo, normalizeConnectorTools, type AgentConnectorTools, type ConnectorConfig } from "./connectors.js";

export interface TaskToolScope {
  /** Connector ids the run may use, or "none". Absent: every connector the agent has. */
  connectors?: string[] | "none";
  /** Per connector id: "*" (all the agent has of it) or raw tool names. */
  connectorTools?: AgentConnectorTools;
  /** Built-in tools or patterns (not connector tools). Absent: the agent's own. */
  allowedTools?: string[];
}

/** Built-in tools an agent without `allowedTools` gets (core, HTTP, Ink; register_outcome and vault come with every agent). */
export const DEFAULT_AGENT_TOOLS: readonly string[] = [
  "read", "write", "edit", "bash", "glob", "grep", "ls", "http_fetch", "http_download",
  "ink_search", "ink_browse", "ink_add", "ink_remove", "ink_update",
];

const isConnectorPattern = (p: string) => /^mcp_/i.test(p);

/** Prefix-glob match, case-insensitive ("browser_*" matches "browser_click"; "*" matches all). */
export function toolPatternMatches(pattern: string, name: string): boolean {
  const p = pattern.toLowerCase();
  const n = name.toLowerCase();
  if (p === n) return true;
  return p.endsWith("*") && n.startsWith(p.slice(0, -1));
}

/** Problems with the shape of a toolScope value (empty when valid). */
export function taskToolScopeProblems(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (typeof value !== "object" || Array.isArray(value)) return ["toolScope must be an object: { connectors?, connectorTools?, allowedTools? }"];
  const v = value as Record<string, unknown>;
  const problems: string[] = [];
  for (const key of Object.keys(v)) {
    if (!["connectors", "connectorTools", "allowedTools"].includes(key)) problems.push(`toolScope: unknown field "${key}" (use connectors, connectorTools, allowedTools)`);
  }
  if (v.connectors !== undefined && v.connectors !== null && v.connectors !== "none") {
    if (!Array.isArray(v.connectors) || v.connectors.some((c) => typeof c !== "string")) problems.push(`toolScope.connectors must be "none" or a list of connector ids`);
    else for (const id of v.connectors as string[]) if (!CONNECTOR_ID_PATTERN.test(id)) problems.push(`toolScope.connectors: "${id}" is not a connector id`);
  }
  if (v.connectorTools !== undefined && v.connectorTools !== null) {
    if (typeof v.connectorTools !== "object" || Array.isArray(v.connectorTools)) problems.push("toolScope.connectorTools must be an object keyed by connector id");
    else {
      for (const [id, entry] of Object.entries(v.connectorTools as Record<string, unknown>)) {
        if (!CONNECTOR_ID_PATTERN.test(id)) problems.push(`toolScope.connectorTools: "${id}" is not a connector id`);
        else if (entry !== "*" && (!Array.isArray(entry) || entry.some((t) => typeof t !== "string" || t.trim() === ""))) problems.push(`toolScope.connectorTools.${id} must be "*" or a list of tool names`);
      }
    }
  }
  if (v.allowedTools !== undefined && v.allowedTools !== null) {
    if (!Array.isArray(v.allowedTools) || v.allowedTools.some((t) => typeof t !== "string" || t.trim() === "")) problems.push("toolScope.allowedTools must be a list of tool names or patterns");
  }
  return problems;
}

/**
 * Tidy a (shape-valid) toolScope: lists deduplicated, `connectors: []` becomes "none",
 * `connectorTools` "*" entries dropped, nothing left → undefined (inherit from the agent).
 */
export function normalizeTaskToolScope(value: unknown): TaskToolScope | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const v = value as TaskToolScope;
  const out: TaskToolScope = {};
  if (v.connectors === "none") out.connectors = "none";
  else if (Array.isArray(v.connectors)) {
    const ids = [...new Set(v.connectors.map((c) => c.trim()).filter(Boolean))];
    out.connectors = ids.length ? ids : "none";
  }
  const tools = normalizeConnectorTools(v.connectorTools ?? undefined);
  if (tools) out.connectorTools = tools;
  if (Array.isArray(v.allowedTools)) out.allowedTools = [...new Set(v.allowedTools.map((t) => t.trim()).filter(Boolean))];
  return Object.keys(out).length ? out : undefined;
}

/** The name, plus the signed-in account when the name does not already say it ("Gmail – info@acme.com"). */
function withAccount(connector: Pick<ConnectorConfig, "name"> & { account?: string }): string {
  const account = connector.account?.trim();
  return account && !connector.name.toLowerCase().includes(account.toLowerCase()) ? `${connector.name} – ${account}` : connector.name;
}

/** "Gmail 2 – info@acme.com (gmail-2)": how a connector is named in messages. */
export function connectorScopeLabel(connector: Pick<ConnectorConfig, "id" | "name"> & { account?: string }): string {
  return `${withAccount(connector)} (${connector.id})`;
}

export interface TaskToolScopeCheckContext {
  agent: { name: string; allowedTools?: string[]; connectorTools?: AgentConnectorTools };
  /** Every connector of the workspace. */
  connectors: Array<ConnectorConfig & { account?: string }>;
  /** The raw tool names a connector lists now, when known (unknown names are then rejected). */
  connectorToolNames?: (id: string) => string[] | undefined;
  /** Built-in tool names Polpo knows (unknown names are then rejected). */
  knownTools?: readonly string[];
  /** Built-in tools an agent without allowedTools gets (default DEFAULT_AGENT_TOOLS). */
  defaultTools?: readonly string[];
}

/**
 * Why `scope` asks for something the agent does not have (empty: it only narrows). Used when a
 * task is created or updated (rejected with these messages) and later to list stale entries
 * (a connector removed, access revoked, a tool renamed).
 */
export function taskToolScopeGrantProblems(scope: TaskToolScope | undefined, ctx: TaskToolScopeCheckContext): string[] {
  if (!scope) return [];
  const problems: string[] = [];
  const { agent } = ctx;
  const byId = new Map(ctx.connectors.map((c) => [c.id, c]));
  const connectorProblem = (field: string, id: string): string | undefined => {
    const c = byId.get(id);
    if (!c) return `${field}: there is no connector "${id}"`;
    const owner = connectorOwner(c);
    if (owner !== undefined && owner !== agent.name) {
      return `${field}: ${connectorScopeLabel(c)} belongs to agent "${owner}" (a personal connector): agent "${agent.name}" can never use it`;
    }
    if (!connectorGrants(c, agent.name)) {
      return `${field}: agent "${agent.name}" has no access to ${connectorScopeLabel(c)}${c.enabled ? "" : " (it is turned off)"}`
        + ` (a tool scope never grants: grant the connector to "${agent.name}" first)`;
    }
    const own = agent.connectorTools?.[id];
    if (Array.isArray(own) && own.length === 0) return `${field}: agent "${agent.name}" gets no tool of ${connectorScopeLabel(c)}`;
    return undefined;
  };
  if (Array.isArray(scope.connectors)) {
    for (const id of scope.connectors) {
      const p = connectorProblem("connectors", id);
      if (p) problems.push(p);
    }
  }
  for (const [id, entry] of Object.entries(scope.connectorTools ?? {})) {
    const field = `connectorTools.${id}`;
    const p = connectorProblem(field, id);
    if (p) { problems.push(p); continue; }
    if (scope.connectors === "none" || (Array.isArray(scope.connectors) && !scope.connectors.includes(id))) {
      problems.push(`${field}: ${connectorScopeLabel(byId.get(id)!)} is not among the task's connectors`);
      continue;
    }
    if (entry === "*") continue;
    const c = byId.get(id)!;
    const own = agent.connectorTools?.[id];
    const listed = ctx.connectorToolNames?.(id);
    for (const tool of entry) {
      if (Array.isArray(own) && !own.includes(tool)) problems.push(`${field}: agent "${agent.name}" does not get "${tool}" of ${connectorScopeLabel(c)} (its connectorTools do not select it)`);
      else if (c.toolPolicy?.[tool] === "off") problems.push(`${field}: "${tool}" of ${connectorScopeLabel(c)} is turned off`);
      else if (listed && !listed.includes(tool)) problems.push(`${field}: ${connectorScopeLabel(c)} has no tool "${tool}"`);
    }
  }
  for (const t of scope.allowedTools ?? []) {
    if (isConnectorPattern(t)) {
      problems.push(`allowedTools: "${t}" is a connector tool; choose connector tools with connectors / connectorTools`);
      continue;
    }
    if (ctx.knownTools && !ctx.knownTools.some((n) => toolPatternMatches(t, n))) {
      problems.push(`allowedTools: there is no built-in tool "${t}"`);
      continue;
    }
    if (agent.allowedTools) {
      const own = agent.allowedTools.filter((a) => !isConnectorPattern(a));
      if (!own.some((a) => toolPatternMatches(a, t) || toolPatternMatches(t, a))) problems.push(`allowedTools: agent "${agent.name}" does not have "${t}" (its allowedTools do not list it)`);
    } else if (!(ctx.defaultTools ?? DEFAULT_AGENT_TOOLS).some((n) => toolPatternMatches(t, n))) {
      problems.push(`allowedTools: agent "${agent.name}" does not have "${t}" (an agent without allowedTools gets only the default tools)`);
    }
  }
  return problems;
}

/**
 * The connectors a scope names that exist but are not granted to the agent (or are turned off):
 * a scope never grants, so these must be granted to the agent first (connector access), then the
 * scope set. Empty when the scope names none, or names only connectors the agent has.
 */
export function taskToolScopeMissingGrants(
  scope: TaskToolScope | undefined, agentName: string, connectors: Array<ConnectorConfig & { account?: string }>,
): Array<{ id: string; label: string; enabled: boolean }> {
  if (!scope) return [];
  const ids = new Set([...(Array.isArray(scope.connectors) ? scope.connectors : []), ...Object.keys(scope.connectorTools ?? {})]);
  const out: Array<{ id: string; label: string; enabled: boolean }> = [];
  for (const id of ids) {
    const c = connectors.find((x) => x.id === id);
    // another agent's own connector cannot be granted: taskToolScopeGrantProblems says so
    if (c && connectorVisibleTo(c, agentName) && !connectorGrants(c, agentName)) out.push({ id, label: connectorScopeLabel(c), enabled: c.enabled });
  }
  return out;
}

/**
 * The agent's allowedTools narrowed by a task's: the built-in part is the intersection of the two
 * pattern lists (the more specific of each overlapping pair), the connector part (`mcp__…`) stays
 * what the agent had (connectors are narrowed through connectorTools).
 */
export function narrowAllowedTools(agentAllowed: string[] | undefined, taskAllowed: string[]): string[] {
  const out: string[] = [];
  if (!agentAllowed) out.push(...taskAllowed.filter((t) => !isConnectorPattern(t)));
  else {
    for (const t of taskAllowed) {
      if (isConnectorPattern(t)) continue;
      for (const a of agentAllowed) {
        if (isConnectorPattern(a)) continue;
        if (toolPatternMatches(a, t)) out.push(t);
        else if (toolPatternMatches(t, a)) out.push(a);
      }
    }
  }
  // the connector part: what the agent's list let through (no list: every connector tool)
  if (!agentAllowed) out.push("mcp__*");
  else for (const a of agentAllowed) {
    if (isConnectorPattern(a)) out.push(a);
    else if (a.endsWith("*") && "mcp__".startsWith(a.slice(0, -1).toLowerCase())) out.push("mcp__*");
  }
  return [...new Set(out)];
}

/**
 * The agent config a task's run gets: `scope` applied on top of the agent's own allowedTools and
 * connectorTools. `connectorIds`: every connector of the workspace (an excluded connector gets an
 * empty selection). Without a scope the agent is returned unchanged.
 */
export function applyTaskToolScope<A extends { allowedTools?: string[]; connectorTools?: AgentConnectorTools }>(
  agent: A, scope: TaskToolScope | undefined, connectorIds: string[],
): A {
  if (!scope) return agent;
  const out: A = { ...agent };
  if (scope.connectors !== undefined || scope.connectorTools) {
    const selection: AgentConnectorTools = { ...(agent.connectorTools ?? {}) };
    const ids = new Set([...connectorIds, ...Object.keys(scope.connectorTools ?? {}), ...Object.keys(agent.connectorTools ?? {})]);
    for (const id of ids) {
      const excluded = scope.connectors === "none" || (Array.isArray(scope.connectors) && !scope.connectors.includes(id));
      if (excluded) { selection[id] = []; continue; }
      const wanted = scope.connectorTools?.[id];
      if (!Array.isArray(wanted)) continue;
      const own = agent.connectorTools?.[id];
      selection[id] = Array.isArray(own) ? wanted.filter((t) => own.includes(t)) : [...wanted];
    }
    out.connectorTools = selection;
  }
  if (scope.allowedTools) out.allowedTools = narrowAllowedTools(agent.allowedTools, scope.allowedTools);
  return out;
}

/**
 * One line for a scope ("Linear (3 tools), Gmail 2 – info@acme.com; built-in: read, grep"),
 * with connector names when known. Undefined scope: "inherited from the agent".
 */
export function describeTaskToolScope(scope: TaskToolScope | undefined, connectors: Array<Pick<ConnectorConfig, "id" | "name"> & { account?: string }> = []): string {
  if (!scope) return "inherited from the agent";
  const name = (id: string) => {
    const c = connectors.find((x) => x.id === id);
    return c ? withAccount(c) : id;
  };
  const parts: string[] = [];
  const ids = scope.connectors === "none" ? [] : Array.isArray(scope.connectors) ? scope.connectors : Object.keys(scope.connectorTools ?? {});
  if (scope.connectors === "none") parts.push("no connectors");
  else if (ids.length) {
    parts.push(ids.map((id) => {
      const tools = scope.connectorTools?.[id];
      return Array.isArray(tools) ? `${name(id)} (${tools.length} tool${tools.length === 1 ? "" : "s"})` : name(id);
    }).join(", ") + (scope.connectors === undefined ? " (others: as the agent)" : ""));
  }
  if (scope.allowedTools) parts.push(`built-in: ${scope.allowedTools.length ? scope.allowedTools.join(", ") : "none"}`);
  return `restricted: ${parts.join("; ") || "as the agent"}`;
}
