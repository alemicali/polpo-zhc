/**
 * Checking a task's tool scope against what its agent has (connectors, their tools, built-in
 * tools), here where the connector store and Polpo's tool names are known. The rules themselves
 * (narrow only, apply at run time) live in @polpo-ai/core (task-tool-scope.ts).
 */
import {
  applyTaskToolScope, normalizeTaskToolScope, taskToolScopeGrantProblems, taskToolScopeMissingGrants, taskToolScopeProblems,
  type AgentConfig, type ConnectorConfig, type TaskToolScope,
} from "@polpo-ai/core";
import { ConnectorStore } from "../mcp/store.js";
import type { RunnerConfig } from "./types.js";

/** A tool scope that asks for more than the agent has, or is malformed: 400 INVALID_TOOL_SCOPE. */
export class TaskToolScopeError extends Error {
  readonly code = "INVALID_TOOL_SCOPE";
  readonly status = 400;
  /**
   * The connectors the scope names that are not granted to the agent: a scope never grants, so
   * the fix is granting them (connector access) first, then setting the scope.
   */
  readonly missingGrants: Array<{ agent: string; id: string; label: string }>;
  constructor(readonly problems: string[], missingGrants: Array<{ agent: string; id: string; label: string }> = []) {
    super(`Invalid toolScope: ${problems.join("; ")}`);
    this.missingGrants = missingGrants;
    this.name = "TaskToolScopeError";
  }
}

let knownTools: string[] | undefined;

/** Every built-in tool name an agent can be given through allowedTools. */
export async function knownBuiltinTools(): Promise<string[]> {
  if (knownTools) return knownTools;
  const [system, data, artifacts, brain, storage, decisions, notify, takeover] = await Promise.all([
    import("../tools/system-tools.js"),
    import("../tools/data-tools.js"),
    import("../tools/artifact-tools.js"),
    import("../tools/company-brain-tools.js"),
    import("../tools/storage-tools.js"),
    import("../tools/decision-tools.js"),
    import("../tools/notify-tools.js"),
    import("../tools/computer-takeover-tools.js"),
  ]);
  knownTools = [...new Set([
    ...system.ALL_EXTENDED_TOOL_NAMES,
    ...data.DATA_ORCHESTRATOR_TOOLS.map((t) => t.name).filter((n) => n.startsWith("data_")),
    ...artifacts.ARTIFACT_TOOLS.map((t) => t.name),
    ...brain.BRAIN_ORCHESTRATOR_TOOLS.map((t) => t.name).filter((n) => n.startsWith("brain_")),
    ...storage.STORAGE_AGENT_TOOLS.map((t) => t.name),
    ...decisions.DECISION_TOOL_NAMES,
    ...notify.AGENT_NOTIFY_TOOL_NAMES,
    ...takeover.COMPUTER_TAKEOVER_TOOL_NAMES,
  ])];
  return knownTools;
}

export interface TaskToolScopeCheckHost {
  agents: () => Promise<AgentConfig[]> | AgentConfig[];
  connectors: () => ConnectorConfig[];
  /** The raw tool names a connector lists (may connect); undefined when it cannot be listed. */
  listConnectorTools?: (id: string) => Promise<string[] | undefined>;
}

const LIST_TIMEOUT_MS = 8_000;

/**
 * Validate and tidy a toolScope for a task assigned to `agentName`. Returns the normalized scope
 * (undefined: inherit from the agent) and the problems; `live` lists the tools of the connectors
 * it names to reject unknown tool names (skipped for a connector that cannot be listed now).
 * An agent that does not exist (yet: a mission's volatile team) gets the shape checks only.
 */
export async function checkTaskToolScope(
  host: TaskToolScopeCheckHost, agentName: string | undefined, value: unknown, opts: { live?: boolean } = {},
): Promise<{ scope?: TaskToolScope; problems: string[]; missingGrants?: Array<{ agent: string; id: string; label: string }> }> {
  const shape = taskToolScopeProblems(value);
  if (shape.length) return { problems: shape };
  const scope = normalizeTaskToolScope(value);
  if (!scope) return { problems: [] };
  const agent = agentName ? (await host.agents()).find((a) => a.name === agentName) : undefined;
  if (!agent) return { scope, problems: [] };
  const connectors = host.connectors();
  const listed = new Map<string, string[]>();
  if (opts.live && host.listConnectorTools) {
    await Promise.all(Object.entries(scope.connectorTools ?? {}).map(async ([id, entry]) => {
      if (entry === "*" || !connectors.some((c) => c.id === id)) return;
      let timer: NodeJS.Timeout | undefined;
      const names = await Promise.race([
        host.listConnectorTools!(id).catch(() => undefined),
        new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), LIST_TIMEOUT_MS); timer.unref?.(); }),
      ]).finally(() => clearTimeout(timer));
      if (names) listed.set(id, names);
    }));
  }
  const problems = taskToolScopeGrantProblems(scope, {
    agent, connectors, knownTools: await knownBuiltinTools(), connectorToolNames: (id) => listed.get(id),
  });
  const missingGrants = taskToolScopeMissingGrants(scope, agent.name, connectors).map((g) => ({ agent: agent.name, id: g.id, label: g.label }));
  return { scope, problems, ...(missingGrants.length ? { missingGrants } : {}) };
}

/** Same as checkTaskToolScope, throwing TaskToolScopeError on problems. */
export async function requireTaskToolScope(
  host: TaskToolScopeCheckHost, agentName: string | undefined, value: unknown, opts: { live?: boolean } = {},
): Promise<TaskToolScope | undefined> {
  const { scope, problems, missingGrants } = await checkTaskToolScope(host, agentName, value, opts);
  if (problems.length) throw new TaskToolScopeError(problems, missingGrants);
  return scope;
}

/**
 * The agent config this run gets: the task's tool scope (Task.toolScope) applied on top of the
 * agent's allowedTools and connectorTools; unchanged without a scope. Connectors the scope leaves
 * out get an empty selection, so every connector of the workspace is listed.
 */
export function scopedAgentForRun(config: Pick<RunnerConfig, "agent" | "task" | "polpoDir">): RunnerConfig["agent"] {
  const scope = config.task.toolScope;
  if (!scope) return config.agent;
  let connectorIds: string[] = [];
  try { connectorIds = new ConnectorStore(config.polpoDir).list().map((c) => c.id); } catch { /* no connectors file */ }
  return applyTaskToolScope(config.agent, scope, connectorIds);
}
