/**
 * The agent card: what the `show_agent` MCP App shows about one agent, built from the instance's API
 * data. Inline it is a compact card (status, the task at hand, today, what is next, the main goal);
 * full screen it adds the tasks, the goals and the routine.
 *
 * Pure (no I/O): the widget in widgets/agent-card imports the types, the MCP server builds the card.
 */

export type AgentCardStatus = "working" | "idle" | "waiting";

export interface AgentCardTask {
  id: string;
  title: string;
  status: string;
  updatedAt?: string;
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
  agent: { name: string; displayName?: string; role?: string; model?: string; timezone?: string };
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
}

export interface AgentCardInput {
  agent: {
    name: string;
    role?: string;
    model?: string;
    identity?: { displayName?: string; title?: string; timezone?: string };
    drive?: { enabled?: boolean; goals?: string[] };
  };
  tasks: Array<{ id: string; title: string; status: string; assignTo?: string; updatedAt?: string; createdAt?: string }>;
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
    },
    status: waitingTasks + proposals > 0 ? "waiting" : active ? "working" : "idle",
    ...(current ? { current: { id: current.id, title: current.title, status: current.status, updatedAt: current.updatedAt, active: current === active } } : {}),
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
    tasks: tasks.slice(0, 30).map((t) => ({ id: t.id, title: t.title, status: t.status, ...(t.updatedAt ? { updatedAt: t.updatedAt } : {}) })),
    goals: goals.slice(0, 40),
    routine: routine.slice(0, 20),
    journal: (input.drive?.journal ?? []).slice(0, 5).map((j) => ({ at: j.at, summary: clip(j.summary, 400) })),
  };
}

/** The card as text, for the model and for clients that do not show apps. */
export function agentCardText(card: AgentCard): string {
  const name = card.agent.displayName ? `${card.agent.displayName} (${card.agent.name})` : card.agent.name;
  const lines = [`${name}${card.agent.role ? ` — ${card.agent.role}` : ""}: ${card.status === "working" ? "working" : card.status === "waiting" ? "waiting for a person" : "idle"}.`];
  if (card.current) lines.push(`${card.current.active ? "Working on" : "Last finished"}: ${card.current.title} [${card.current.status}] (${card.current.id}).`);
  lines.push(`Today: ${card.today.done} done, ${card.today.failed} failed, ${card.today.waiting} waiting for a person.`);
  if (card.next) lines.push(`Next: ${card.next.at} — ${card.next.text}${card.next.proposed ? " (proposed, to confirm)" : ""}.`);
  if (card.goal) lines.push(`Main goal: ${card.goal.title}${card.goal.progress !== undefined ? ` (${card.goal.progress}%)` : ""}.`);
  if (!card.drive) lines.push("Goals and initiative (drive) are off for this agent.");
  return lines.join("\n");
}
