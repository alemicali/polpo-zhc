/**
 * The agent card: what the `polpo_agent_show` MCP App shows about one agent, built from the instance's API
 * data. Inline it is a compact card (status, the task at hand, today, what is next, the main goal);
 * full screen it adds the tasks, the goals and the routine.
 *
 * Pure (no I/O): the widget in widgets/agent-card imports the types, the MCP server builds the card.
 */
import type { TaskRunContext } from "@polpo-ai/core/run-context";
import { taskFailure, type TaskFailure } from "@polpo-ai/core/task-failure";
import { agentColorIndex } from "@polpo-ai/core/appearance";
import { engineKindOf, engineMarkLabel, modelWithEngineText } from "@polpo-ai/core/engine-label";
import { agentEngine, computerLabel, engineMark, formatUsd, modelLabel, runCostUsd, runView, type BrandMark, type RunView } from "./mcp-run-view.js";

export type AgentCardStatus = "working" | "idle" | "waiting";

export interface AgentCardTask {
  id: string;
  title: string;
  status: string;
  updatedAt?: string;
  /** Where and with what its latest run executed. */
  run?: Pick<RunView, "engine" | "engineLabel" | "engineKind" | "engineMark" | "modelLabel" | "auth" | "computer" | "costUsd">;
  /** Why it failed (the labelled reason) and whether it was retried. */
  failure?: TaskFailure;
  /** Its runs get only part of the agent's tools (Task.toolScope). */
  toolScoped?: boolean;
}

/** A connector the agent may use: several accounts of one app are told apart by name and account. */
export interface AgentCardConnector {
  id: string;
  /** The name, plus the signed-in account when the name does not say it. */
  label: string;
  account?: string;
  status?: string;
  /** Which of its tools the agent gets: all, or how many (agent.connectorTools). */
  tools: "all" | number;
}

export interface AgentCardGoal {
  id: string;
  title: string;
  horizon?: string;
  parentId?: string;
  progress?: number;
  status: string;
  due?: string;
  measure?: string;
}

export interface AgentCardRoutineItem {
  id: string;
  /** What it is, in the agent's words. */
  text: string;
  why?: string;
  /** Next run (ISO). */
  at: string;
  /** Proposed by the agent: it waits for a person to confirm. */
  proposed: boolean;
  /** Repeats (cron or interval) rather than running once. */
  recurring: boolean;
  cron?: string;
  everyMinutes?: number;
}

export interface AgentCard {
  /** Orders the cards of one agent in a conversation: a newer card supersedes older ones. */
  key: { createdAt: number; seq: number };
  generatedAt: string;
  agent: {
    name: string; displayName?: string; role?: string; model?: string; timezone?: string;
    /** Its engine: Polpo's own or an agent harness (Claude Code, Codex, OpenCode), with the mark the card draws. */
    engine?: { id: string; /** "Polpo", "Claude Code Harness", "Codex CLI". */ label: string; kind?: string; mark: BrandMark; model?: string; modelLabel?: string };
    /** The computer its chats and tasks run on (defaultComputer): "this server" or its id. */
    computer?: string;
    /** The published version production runs (agent versions), and whether its draft has unpublished changes. */
    version?: string;
    draftChanges?: boolean;
    /** Its colour: the look's agent colour 1…10 (identity.color, else from its name), for the avatar. */
    color: number;
  };
  /** The instance look's brand, status and agent colours per mode (only those its custom look sets). */
  appearance?: { light?: Record<string, string>; dark?: Record<string, string> };
  status: AgentCardStatus;
  /** The task in progress, or the last one it finished. */
  current?: AgentCardTask & { active: boolean };
  today: { done: number; failed: number; waiting: number };
  /** The next thing it plans: an intention or a routine run. */
  next?: AgentCardRoutineItem;
  /** Its main goal: the broadest open goal of its plan, or its first configured goal. */
  goal?: { title: string; progress?: number; horizon?: string; measure?: string };
  /** Whether it has goals and initiative (drive) on. */
  drive: boolean;
  /** Full screen: its self-portrait, tasks, goals, routine and latest reflections. */
  portrait?: string;
  tasks: AgentCardTask[];
  goals: AgentCardGoal[];
  routine: AgentCardRoutineItem[];
  journal: Array<{ at: string; summary: string }>;
  /** The connectors it may use (external apps over MCP), with their accounts. */
  connectors: AgentCardConnector[];
  /** Its communication lines: who it may talk to (GET /agents/lines). */
  lines?: AgentCardLines;
}

export interface AgentCardLines {
  mode: string;
  /** false: not set (an agent from before the lines: it talks to anyone). */
  explicit: boolean;
  manager?: string;
  reachable: string[];
}

export interface AgentCardInput {
  agent: {
    name: string;
    role?: string;
    model?: string;
    identity?: { displayName?: string; title?: string; timezone?: string; color?: string };
    drive?: { enabled?: boolean; goals?: string[] };
    engine?: unknown;
    defaultComputer?: string;
    connectorTools?: Record<string, "*" | string[]>;
    /** GET /agents/{name}: production version and draft state. */
    versioning?: { production?: string; draft?: { hasChanges?: boolean } };
  };
  tasks: Array<{
    id: string; title: string; status: string; assignTo?: string; updatedAt?: string; createdAt?: string;
    runs?: TaskRunContext[]; toolScope?: unknown; result?: { stderr?: string; exitCode?: number; retryable?: boolean; assessment?: { passed?: boolean; llmReview?: string; globalScore?: number } };
  }>;
  /** GET /agents/lines: the team's lines (the agent's row is used). */
  lines?: { agents: Array<{ agent: string; mode: string; explicit: boolean; manager?: string; reachable: string[] }> };
  /** GET /connectors: the agent's are those whose access lists it (or "*"). */
  connectors?: Array<{ id: string; name: string; account?: string; status?: string; enabled?: boolean; access?: { agents?: string[] | "*" } }>;
  drive?: {
    self?: string;
    plan?: Array<{ id: string; title: string; horizon?: string; parentId?: string; progress?: number; status: string; due?: string; measure?: string; updatedAt?: string }>;
    intentions?: Array<{ id: string; prompt: string; message?: string; why?: string; state: string; nextRunAt: string; cron?: string; everyMinutes?: number }>;
    journal?: Array<{ at: string; summary: string }>;
  };
  now: Date;
  key: { createdAt: number; seq: number };
}

const ACTIVE = new Set(["assigned", "in_progress", "review"]);
const WAITING = new Set(["awaiting_approval"]);
const HORIZON_ORDER = ["long", "quarter", "month", "week", "day"];

/** The calendar day of a time in a timezone (YYYY-MM-DD). */
function dayIn(time: Date, timeZone?: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(time);
  } catch {
    return time.toISOString().slice(0, 10);
  }
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

type InputTask = AgentCardInput["tasks"][number];

/** A task row: its latest run (engine, model, auth, computer, cost) and why it failed. */
function cardTask(t: InputTask): AgentCardTask {
  const last = t.runs?.at(-1);
  const v = last ? runView(last) : undefined;
  let cost: number | undefined;
  for (const r of t.runs ?? []) { const c = runCostUsd(r); if (c !== undefined) cost = (cost ?? 0) + c; }
  const failure = taskFailure(t as Parameters<typeof taskFailure>[0]);
  return {
    id: t.id, title: t.title, status: t.status,
    ...(t.updatedAt ? { updatedAt: t.updatedAt } : {}),
    ...(v ? { run: {
      engine: v.engine, engineLabel: v.engineLabel, engineKind: v.engineKind, engineMark: v.engineMark, computer: v.computer,
      ...(v.modelLabel ? { modelLabel: v.modelLabel } : {}), ...(v.auth ? { auth: v.auth } : {}), ...(cost !== undefined ? { costUsd: cost } : {}),
    } } : {}),
    ...(failure ? { failure } : {}),
    ...(t.toolScope ? { toolScoped: true } : {}),
  };
}

/** The connectors an agent may use, labelled with their accounts. */
function agentConnectors(input: AgentCardInput): AgentCardConnector[] {
  const name = input.agent.name;
  const selection = input.agent.connectorTools ?? {};
  return (input.connectors ?? [])
    .filter((c) => c.enabled !== false && (c.access?.agents === "*" || (Array.isArray(c.access?.agents) && c.access.agents.includes(name))))
    .map((c) => {
      const account = c.account?.trim();
      const pick = selection[c.id];
      return {
        id: c.id,
        label: account && !c.name.toLowerCase().includes(account.toLowerCase()) ? `${c.name} – ${account}` : c.name,
        ...(account ? { account } : {}),
        ...(c.status ? { status: c.status } : {}),
        tools: Array.isArray(pick) ? pick.length : "all" as const,
      };
    })
    .slice(0, 30);
}

export function buildAgentCard(input: AgentCardInput): AgentCard {
  const { agent, now } = input;
  const timezone = agent.identity?.timezone;
  const tasks = input.tasks
    .filter((t) => t.assignTo === agent.name)
    .sort((a, b) => (b.updatedAt ?? b.createdAt ?? "").localeCompare(a.updatedAt ?? a.createdAt ?? ""));
  const today = dayIn(now, timezone);
  const isToday = (t: { updatedAt?: string }) => !!t.updatedAt && dayIn(new Date(t.updatedAt), timezone) === today;

  const active = tasks.find((t) => ACTIVE.has(t.status));
  const finished = tasks.find((t) => t.status === "done" || t.status === "failed");
  const current = active ?? finished;

  const routine: AgentCardRoutineItem[] = (input.drive?.intentions ?? [])
    .filter((c) => c.state === "active" || c.state === "proposed")
    .map((c) => ({
      id: c.id,
      text: clip((c.why ?? c.message ?? c.prompt).replace(/\s+/g, " ").trim(), 160),
      ...(c.why ? { why: c.why } : {}),
      at: c.nextRunAt,
      proposed: c.state === "proposed",
      recurring: !!c.cron || (c.everyMinutes ?? 0) > 0,
      ...(c.cron ? { cron: c.cron } : {}),
      ...(c.everyMinutes ? { everyMinutes: c.everyMinutes } : {}),
    }))
    .sort((a, b) => a.at.localeCompare(b.at));

  const waitingTasks = tasks.filter((t) => WAITING.has(t.status)).length;
  const proposals = routine.filter((r) => r.proposed).length;

  const plan = input.drive?.plan ?? [];
  const goals: AgentCardGoal[] = plan
    .filter((p) => p.horizon)
    .map((p) => ({
      id: p.id, title: p.title, status: p.status,
      ...(p.horizon ? { horizon: p.horizon } : {}),
      ...(p.parentId ? { parentId: p.parentId } : {}),
      ...(typeof p.progress === "number" ? { progress: p.progress } : {}),
      ...(p.due ? { due: p.due } : {}),
      ...(p.measure ? { measure: p.measure } : {}),
    }))
    .sort((a, b) => HORIZON_ORDER.indexOf(a.horizon!) - HORIZON_ORDER.indexOf(b.horizon!));
  const open = goals.filter((g) => g.status === "todo" || g.status === "doing");
  const main = open.find((g) => !g.parentId) ?? open[0];
  const configured = agent.drive?.goals?.find((g) => g.trim());

  return {
    key: input.key,
    generatedAt: now.toISOString(),
    agent: {
      name: agent.name,
      ...(agent.identity?.displayName ? { displayName: agent.identity.displayName } : {}),
      ...(agent.role || agent.identity?.title ? { role: agent.role || agent.identity?.title } : {}),
      ...(agent.model ? { model: agent.model } : {}),
      ...(timezone ? { timezone } : {}),
      engine: engineOf(agent),
      ...(agent.defaultComputer ? { computer: computerLabel({ id: agent.defaultComputer, kind: agent.defaultComputer === "host" ? "host" : "computer" }) } : {}),
      ...(agent.versioning?.production ? { version: agent.versioning.production } : {}),
      ...(agent.versioning?.draft?.hasChanges ? { draftChanges: true } : {}),
      color: agentColorIndex(agent.name, agent.identity?.color),
    },
    status: waitingTasks + proposals > 0 ? "waiting" : active ? "working" : "idle",
    ...(current ? { current: { ...cardTask(current), active: current === active } } : {}),
    today: {
      done: tasks.filter((t) => t.status === "done" && isToday(t)).length,
      failed: tasks.filter((t) => t.status === "failed" && isToday(t)).length,
      waiting: waitingTasks + proposals,
    },
    ...(routine[0] ? { next: routine[0] } : {}),
    ...(main
      ? { goal: { title: main.title, ...(main.progress !== undefined ? { progress: main.progress } : {}), ...(main.horizon ? { horizon: main.horizon } : {}), ...(main.measure ? { measure: main.measure } : {}) } }
      : configured ? { goal: { title: configured } } : {}),
    drive: !!agent.drive?.enabled,
    ...(input.drive?.self?.trim() ? { portrait: clip(input.drive.self.trim(), 1500) } : {}),
    tasks: tasks.slice(0, 30).map(cardTask),
    goals: goals.slice(0, 40),
    routine: routine.slice(0, 20),
    journal: (input.drive?.journal ?? []).slice(0, 5).map((j) => ({ at: j.at, summary: clip(j.summary, 400) })),
    connectors: agentConnectors(input),
    ...linesOf(input),
  };
}

function linesOf(input: AgentCardInput): { lines?: AgentCardLines } {
  const rows = input.lines?.agents;
  const row = Array.isArray(rows) ? rows.find((l) => l.agent === input.agent.name) : undefined;
  if (!row) return {};
  return { lines: { mode: row.mode, explicit: row.explicit, ...(row.manager ? { manager: row.manager } : {}), reachable: row.reachable.slice(0, 50) } };
}

/** The agent's engine: a harness (with its model), else Polpo's own engine with the agent's model. */
function engineOf(agent: AgentCardInput["agent"]): NonNullable<AgentCard["agent"]["engine"]> {
  const e = agentEngine(agent.engine);
  const model = e.id === "polpo" ? agent.model : e.model;
  const label = modelLabel(model);
  return { id: e.id, label: engineMarkLabel(e.id), kind: engineKindOf(e.id), mark: engineMark(e.id), ...(model ? { model } : {}), ...(label ? { modelLabel: label } : {}) };
}

/** The card as text, for the model and for clients that do not show apps. */
export function agentCardText(card: AgentCard): string {
  const name = card.agent.displayName ? `${card.agent.displayName} (${card.agent.name})` : card.agent.name;
  const lines = [`${name}${card.agent.role ? ` — ${card.agent.role}` : ""}: ${card.status === "working" ? "working" : card.status === "waiting" ? "waiting for a person" : "idle"}.`];
  // the model it runs, then its engine and type: "Model: Sonnet 4.5 (Claude Code · Harness) on gpu-box."
  if (card.agent.engine) lines.push(`Model: ${modelWithEngineText(card.agent.engine.modelLabel, card.agent.engine.id, "default")}${card.agent.computer ? ` on ${card.agent.computer}` : ""}.`);
  if (card.agent.version) lines.push(`Version ${card.agent.version} in production${card.agent.draftChanges ? " (its draft has unpublished changes)" : ""}.`);
  if (card.current) {
    const run = card.current.run;
    lines.push(`${card.current.active ? "Working on" : "Last finished"}: ${card.current.title} [${card.current.status}] (${card.current.id})`
      + `${run ? ` with ${modelWithEngineText(run.modelLabel, run.engine)} on ${run.computer.label}${run.costUsd !== undefined ? `, ${formatUsd(run.costUsd)}` : ""}` : ""}.`);
    if (card.current.failure) lines.push(`It failed: ${card.current.failure.reason}${card.current.failure.retryable ? "" : " (not retried: a re-run would fail the same way)"}.`);
  }
  lines.push(`Today: ${card.today.done} done, ${card.today.failed} failed, ${card.today.waiting} waiting for a person.`);
  if (card.next) lines.push(`Next: ${card.next.at} — ${card.next.text}${card.next.proposed ? " (proposed, to confirm)" : ""}.`);
  if (card.goal) lines.push(`Main goal: ${card.goal.title}${card.goal.progress !== undefined ? ` (${card.goal.progress}%)` : ""}.`);
  if (!card.drive) lines.push("Goals and initiative (drive) are off for this agent.");
  if (card.lines) {
    lines.push(`Communication lines: ${card.lines.explicit ? card.lines.mode : "anyone (not set)"}`
      + ` — talks to ${card.lines.mode === "anyone" ? "any agent" : card.lines.reachable.join(", ") || "no agent"}${card.lines.manager ? `; escalates to ${card.lines.manager}` : ""}.`);
  }
  if (card.connectors.length) lines.push(`Connectors: ${card.connectors.map((c) => `${c.label} [${c.id}]${c.tools === "all" ? "" : ` (${c.tools} tools)`}`).join(", ")}.`);
  return lines.join("\n");
}
