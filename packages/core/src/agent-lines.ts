/**
 * Communication lines between agents: who an agent may talk to (ask_agent, message_agent, and the
 * agents its replies set off in a room).
 *
 * Each agent has a `talksTo` policy:
 *   - "org"    — its manager (reportsTo), its direct reports (agents whose reportsTo is it), and
 *                the extra `agents` listed. The default for agents created from now on.
 *   - "list"   — only the listed `agents`.
 *   - "anyone" — every other agent. Agents without a policy (created before the lines existed)
 *                keep this, so nothing breaks; the dashboard suggests restricting them.
 *   - "none"   — no other agent.
 *
 * Always, whatever the policy:
 *   - Polpo (the orchestrator) talks to every agent, and every agent can answer Polpo;
 *   - `escalate` reaches the agent's manager (reportsTo).
 *
 * Lines are directional: the sender's policy decides. A receiver can also refuse senders outside
 * its own lines with `acceptFrom: "lines"` (default "anyone": it accepts whoever's lines reach it).
 */
import type { AgentConfig } from "./types.js";

export type AgentLinesMode = "org" | "list" | "anyone" | "none";
export const AGENT_LINES_MODES: readonly AgentLinesMode[] = ["org", "list", "anyone", "none"];

export interface AgentTalksTo {
  mode: AgentLinesMode;
  /** Extra agents ("org") or the only agents ("list") it may talk to. */
  agents?: string[];
  /** Receiver side: "anyone" (default) accepts every sender whose lines reach it; "lines" only senders within its own lines. */
  acceptFrom?: "anyone" | "lines";
}

/** The lines given to an agent created from now on. */
export const DEFAULT_NEW_AGENT_TALKS_TO: AgentTalksTo = { mode: "org" };

/** Who Polpo is in communication lines. */
export const POLPO_LINE = "polpo";

type LinesAgent = Pick<AgentConfig, "name" | "reportsTo" | "talksTo">;

/** An agent's lines, resolved against its team. */
export interface AgentLines {
  agent: string;
  mode: AgentLinesMode;
  /** false: no policy set (an agent from before the lines: "anyone"). */
  explicit: boolean;
  manager?: string;
  reports: string[];
  /** The extra (org) or only (list) agents named, that exist. */
  agents: string[];
  acceptFrom: "anyone" | "lines";
  /** The agents it may write to (never itself); Polpo is always reachable too. */
  reachable: string[];
}

/** The policy of an agent: its own, else "anyone" (an agent from before the lines). */
export function agentLinesMode(agent: Pick<AgentConfig, "talksTo"> | undefined): AgentLinesMode {
  const mode = agent?.talksTo?.mode;
  return mode && AGENT_LINES_MODES.includes(mode) ? mode : "anyone";
}

/** `agent`'s lines among `agents` (its team, all teams). */
export function resolveAgentLines(agent: LinesAgent, agents: readonly LinesAgent[]): AgentLines {
  const names = new Set(agents.map((a) => a.name));
  const mode = agentLinesMode(agent);
  const manager = agent.reportsTo && names.has(agent.reportsTo) && agent.reportsTo !== agent.name ? agent.reportsTo : undefined;
  const reports = agents.filter((a) => a.reportsTo === agent.name && a.name !== agent.name).map((a) => a.name);
  const listed = [...new Set((agent.talksTo?.agents ?? []).filter((n) => typeof n === "string" && names.has(n) && n !== agent.name))];
  let reachable: string[];
  switch (mode) {
    case "anyone": reachable = agents.map((a) => a.name).filter((n) => n !== agent.name); break;
    case "none": reachable = []; break;
    case "list": reachable = listed; break;
    default: reachable = [...new Set([...(manager ? [manager] : []), ...reports, ...listed])];
  }
  return {
    agent: agent.name, mode, explicit: !!agent.talksTo,
    ...(manager ? { manager } : {}),
    reports, agents: listed,
    acceptFrom: agent.talksTo?.acceptFrom === "lines" ? "lines" : "anyone",
    reachable,
  };
}

const find = (agents: readonly LinesAgent[], name: string) =>
  agents.find((a) => a.name === name) ?? agents.find((a) => a.name.toLowerCase() === name.toLowerCase());

/** The sentence an agent reads about who it can reach (tool descriptions, refusals). */
export function describeReachable(lines: AgentLines): string {
  if (lines.mode === "anyone") return "You can talk to any agent of the team.";
  const who = lines.reachable.length ? `You can talk to: ${lines.reachable.join(", ")}.` : "You cannot talk to other agents.";
  return lines.manager && !lines.reachable.includes(lines.manager)
    ? `${who} To escalate to your manager (${lines.manager}), use escalate.`
    : who;
}

export interface LinesCheck {
  /** `from` undefined: Polpo. */
  from?: string;
  to: string;
  /** escalate: the sender's manager is always reachable. */
  escalation?: boolean;
}

/**
 * Why `from` may not talk to `to` under the lines, or undefined when it may. Polpo always may, and
 * an escalation always reaches the sender's manager. Unknown agents are left to the caller.
 */
export function linesRefusal(check: LinesCheck, agents: readonly LinesAgent[]): string | undefined {
  if (!check.from || check.from === POLPO_LINE) return undefined;
  if (check.to.toLowerCase() === POLPO_LINE) return undefined;
  const sender = find(agents, check.from);
  const target = find(agents, check.to);
  if (!sender || !target) return undefined;
  if (check.escalation && sender.reportsTo === target.name) return undefined;
  const senderLines = resolveAgentLines(sender, agents);
  if (!senderLines.reachable.includes(target.name)) {
    return `${target.name} is outside your communication lines (${senderLines.mode}). ${describeReachable(senderLines)}`;
  }
  const targetLines = resolveAgentLines(target, agents);
  if (targetLines.acceptFrom === "lines" && !targetLines.reachable.includes(sender.name)) {
    return `${target.name} only accepts messages from its own communication lines, and you are not in them. ${describeReachable(senderLines)}`;
  }
  return undefined;
}

/** Whether `from` (undefined: Polpo) may talk to `to`. */
export function mayTalk(check: LinesCheck, agents: readonly LinesAgent[]): boolean {
  return linesRefusal(check, agents) === undefined;
}

/** The agents `from` may actually reach: its lines, minus receivers that refuse it. */
export function reachableAgents(from: string, agents: readonly LinesAgent[]): string[] {
  const sender = find(agents, from);
  if (!sender) return agents.map((a) => a.name).filter((n) => n !== from);
  return resolveAgentLines(sender, agents).reachable.filter((to) => mayTalk({ from: sender.name, to }, agents));
}

/** The team's lines: every agent's, and the directed edges between them (the org chart view). */
export interface AgentLinesChart {
  agents: AgentLines[];
  /** from → to: `from` may talk to `to` (after the receiver's acceptFrom). */
  edges: Array<{ from: string; to: string; kind: "manager" | "report" | "extra" | "open" }>;
  /** Agents without a policy (from before the lines): they talk to anyone. */
  unrestricted: string[];
}

export function agentLinesChart(agents: readonly LinesAgent[]): AgentLinesChart {
  const all = agents.map((a) => resolveAgentLines(a, agents));
  const edges: AgentLinesChart["edges"] = [];
  for (const lines of all) {
    for (const to of lines.reachable) {
      if (!mayTalk({ from: lines.agent, to }, agents)) continue;
      const kind = lines.mode === "anyone" ? "open"
        : to === lines.manager ? "manager"
        : lines.reports.includes(to) ? "report"
        : "extra";
      edges.push({ from: lines.agent, to, kind });
    }
  }
  return { agents: all, edges, unrestricted: all.filter((l) => !l.explicit).map((l) => l.agent) };
}

/** Problems with a talksTo value (undefined: fine). */
export function talksToProblem(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return "talksTo must be an object { mode, agents?, acceptFrom? }";
  const v = value as Record<string, unknown>;
  if (!AGENT_LINES_MODES.includes(v.mode as AgentLinesMode)) return `talksTo.mode must be one of ${AGENT_LINES_MODES.join(", ")}`;
  if (v.agents !== undefined && (!Array.isArray(v.agents) || v.agents.some((n) => typeof n !== "string" || !n.trim()))) return "talksTo.agents must be a list of agent names";
  if (v.acceptFrom !== undefined && v.acceptFrom !== "anyone" && v.acceptFrom !== "lines") return 'talksTo.acceptFrom must be "anyone" or "lines"';
  return undefined;
}

/** A clean talksTo (trimmed, deduplicated names; empty lists dropped). */
export function normalizeTalksTo(value: AgentTalksTo): AgentTalksTo {
  const agents = [...new Set((value.agents ?? []).map((n) => n.trim()).filter(Boolean))];
  return {
    mode: value.mode,
    ...(agents.length ? { agents } : {}),
    ...(value.acceptFrom === "lines" ? { acceptFrom: "lines" as const } : {}),
  };
}
