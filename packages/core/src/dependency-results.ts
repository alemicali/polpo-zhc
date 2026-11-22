/**
 * What a task receives from the tasks it depends on: their final result, their registered
 * outcomes (text inline, files and media as references) and their error when they failed.
 *
 * - `renderDependencyResults` is the section the orchestrator puts in a task's prompt at every
 *   run (first run, retries, continuations, fix runs), within a budget: a cap per dependency and
 *   a total, shared fairly (short results leave room to long ones). What is cut is marked, and the
 *   full result is one `task_result` call away.
 * - `taskReadScope` / `findTaskInScope` decide what the `task_result` tool may read: the task's
 *   dependencies and the tasks of its own mission, nothing else.
 *
 * Pure: no store, no Node API. The orchestrator (task-runner) and the agent tools
 * (src/tools/task-result-tools.ts) share it.
 */
import type { Task, TaskOutcome } from "./types.js";

/** `settings.dependencyResults` in polpo.json. */
export interface DependencyResultsSettings {
  /** Characters at most per dependency in the prompt (result + outcomes + error). Default 2000. */
  perTaskChars?: number;
  /** Characters at most for the whole section. Default 20000. */
  totalChars?: number;
}

export const DEFAULT_DEPENDENCY_PER_TASK_CHARS = 2_000;
export const DEFAULT_DEPENDENCY_TOTAL_CHARS = 20_000;
/** Below this a dependency's share is not worth rendering: the rest are listed by title. */
const MIN_SHARE = 240;

export const TASK_RESULT_TOOL = "task_result";
export const DEPENDENCY_RESULTS_TOOL = "dependency_results";

/** Keep only well-formed values (positive integers; unknown keys dropped). */
export function normalizeDependencyResultsSettings(raw: unknown): DependencyResultsSettings | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const out: DependencyResultsSettings = {};
  const int = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 1 ? Math.floor(v) : undefined);
  const per = int(r.perTaskChars);
  const total = int(r.totalChars);
  if (per !== undefined) out.perTaskChars = per;
  if (total !== undefined) out.totalChars = total;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** The tasks of the same mission run as `task` (its mission id, else its group). */
function sameMission(task: Pick<Task, "missionId" | "group">, other: Task): boolean {
  if (task.missionId) return other.missionId === task.missionId && (!task.group || other.group === task.group);
  return !!task.group && other.group === task.group;
}

/**
 * The tasks `task` depends on, in its dependsOn order. Entries are task ids; an entry that is not
 * an id is matched by title among the tasks of its mission (as mission documents name them).
 * Entries that match nothing come back in `missing`.
 */
export function resolveDependencies(task: Pick<Task, "id" | "dependsOn" | "missionId" | "group">, allTasks: readonly Task[]): { tasks: Task[]; missing: string[] } {
  const byId = new Map(allTasks.map((t) => [t.id, t]));
  const tasks: Task[] = [];
  const missing: string[] = [];
  const seen = new Set<string>();
  for (const ref of task.dependsOn ?? []) {
    let dep = byId.get(ref);
    if (!dep && (task.missionId || task.group)) {
      dep = allTasks.find((t) => t.id !== task.id && t.title === ref && sameMission(task, t));
    }
    if (!dep) { missing.push(ref); continue; }
    if (seen.has(dep.id)) continue;
    seen.add(dep.id);
    tasks.push(dep);
  }
  return { tasks, missing };
}

/**
 * What `task` may read with task_result: its dependencies and every task of its own mission
 * (itself included). A standalone task reads only its dependencies (and itself).
 */
export function taskReadScope(task: Pick<Task, "id" | "dependsOn" | "missionId" | "group">, allTasks: readonly Task[]): Task[] {
  const out = new Map<string, Task>();
  for (const dep of resolveDependencies(task, allTasks).tasks) out.set(dep.id, dep);
  for (const t of allTasks) if (t.id === task.id || ((task.missionId || task.group) && sameMission(task, t))) out.set(t.id, t);
  return [...out.values()];
}

/** A task of the scope by id, or by title (exact, then case-insensitive). Ambiguous titles: undefined with the candidates. */
export function findTaskInScope(ref: string, scope: readonly Task[]): { task?: Task; ambiguous?: Task[] } {
  const r = ref.trim();
  const byId = scope.find((t) => t.id === r);
  if (byId) return { task: byId };
  for (const match of [(t: Task) => t.title === r, (t: Task) => t.title.toLowerCase() === r.toLowerCase()]) {
    const found = scope.filter(match);
    if (found.length === 1) return { task: found[0] };
    if (found.length > 1) return { ambiguous: found };
  }
  return {};
}

/** The task's final result text: what its agent replied at the end of its last run. */
export function taskResultText(task: Pick<Task, "result">): string {
  return (task.result?.stdout ?? "").trim();
}

/** The task's error, when it failed (or its last run did not exit cleanly). */
export function taskErrorText(task: Pick<Task, "status" | "result">): string {
  const r = task.result;
  if (!r) return "";
  if (task.status !== "failed" && r.exitCode === 0) return "";
  const parts = [r.stderr?.trim(), r.assessment && !r.assessment.passed && r.assessment.llmReview ? `Assessment: ${r.assessment.llmReview}` : ""].filter(Boolean);
  return parts.join("\n");
}

/** The computer the task's last run used ("host" is this server). */
function lastComputer(task: Pick<Task, "runs">): string | undefined {
  const runs = task.runs ?? [];
  return runs[runs.length - 1]?.computer?.id;
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * One outcome as a line. Files and media are references the agent can use: the path as their
 * producer registered it (on the producer's computer), the outcome id and the task id.
 */
export function describeOutcome(o: TaskOutcome, task: Pick<Task, "id" | "runs">, opts: { resultText?: string } = {}): string {
  const label = `"${o.label}"`;
  switch (o.type) {
    case "text": {
      const text = (o.text ?? "").trim();
      if (opts.resultText && text && text === opts.resultText) return `- text ${label}: (same as the result above)`;
      return `- text ${label}: ${text}`;
    }
    case "url":
      return `- url ${label}: ${o.url ?? ""}`;
    case "json": {
      let data = "";
      try { data = JSON.stringify(o.data); } catch { data = String(o.data); }
      return `- json ${label}: ${data ?? ""}`;
    }
    default: {
      const computer = lastComputer(task);
      const meta = [o.mimeType, o.size !== undefined ? humanSize(o.size) : undefined].filter(Boolean).join(", ");
      const where = o.path ? `path ${o.path}${computer && computer !== "host" ? ` (on computer "${computer}")` : ""}` : "no path";
      return `- ${o.type} ${label}${meta ? ` (${meta})` : ""}: ${where} · outcome id ${o.id} · task id ${task.id}`;
    }
  }
}

/** The parts of a dependency's body: result, outcomes, error (empty parts left out). */
function bodyParts(task: Task): string[] {
  const result = taskResultText(task);
  const parts: string[] = [];
  if (result) parts.push(`Result:\n${result}`);
  const outcomes = task.outcomes ?? [];
  if (outcomes.length) parts.push(`Outcomes:\n${outcomes.map((o) => describeOutcome(o, task, { resultText: result })).join("\n")}`);
  const error = taskErrorText(task);
  if (error) parts.push(`Error:\n${error}`);
  if (parts.length === 0) parts.push(task.status === "done" ? "(no result text and no outcomes)" : "(no result yet)");
  return parts;
}

/**
 * The largest cap c such that sum(min(len_i, c)) <= budget ("water filling"): short items keep
 * all of their text, long ones share what is left equally.
 */
export function fairCap(lengths: readonly number[], budget: number): number {
  if (lengths.reduce((a, b) => a + b, 0) <= budget) return Math.max(0, ...lengths);
  const sorted = [...lengths].sort((a, b) => a - b);
  let remaining = Math.max(0, budget);
  for (let i = 0; i < sorted.length; i++) {
    const share = Math.floor(remaining / (sorted.length - i));
    if (sorted[i] > share) return share;
    remaining -= sorted[i];
  }
  return sorted[sorted.length - 1];
}

const TRUNCATED = " …[truncated]";

/** Text cut to `max` characters, with a marker when cut. */
function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - TRUNCATED.length)).trimEnd()}${TRUNCATED}`;
}

/** The parts within `max` characters altogether: the longest are cut first. */
function fitParts(parts: string[], max: number): { text: string; truncated: boolean } {
  const sep = "\n";
  const full = parts.join(sep);
  if (full.length <= max) return { text: full, truncated: false };
  const budget = max - sep.length * (parts.length - 1);
  const cap = fairCap(parts.map((p) => p.length), budget);
  return { text: parts.map((p) => cut(p, cap)).join(sep), truncated: true };
}

export interface RenderDependencyOptions {
  perTaskChars?: number;
  totalChars?: number;
  /** Deps that could not be found (by id or title). */
  missing?: string[];
  /** The tool the agent reads full results with (default task_result); "" when it has none. */
  toolName?: string;
}

/** The heading line of a dependency: title, agent, status, id. */
function heading(i: number, t: Task): string {
  return `### ${i + 1}. "${t.title}" — agent ${t.assignTo} — ${t.status} — task id ${t.id}`;
}

/**
 * The prompt section with the results of the given dependencies, within the budget, or "" when
 * there are none. Every dependency gets its heading; their bodies share the budget fairly; when
 * even a minimal share does not fit, the remaining dependencies are listed by title only.
 */
export function renderDependencyResults(deps: readonly Task[], opts: RenderDependencyOptions = {}): string {
  const missing = opts.missing ?? [];
  if (deps.length === 0 && missing.length === 0) return "";
  const per = Math.max(MIN_SHARE, opts.perTaskChars ?? DEFAULT_DEPENDENCY_PER_TASK_CHARS);
  const total = Math.max(MIN_SHARE * 2, opts.totalChars ?? DEFAULT_DEPENDENCY_TOTAL_CHARS);
  const tool = opts.toolName ?? TASK_RESULT_TOOL;

  const intro = [
    `The results of the ${deps.length === 1 ? "task" : `${deps.length} tasks`} this task depends on. They are your input: use them.`,
    ...(tool ? [`A part marked …[truncated] is shortened here: read a result in full with ${tool}({task: "<task id or title>"}).`] : []),
    `Files and media are references: their path is on the computer of the task that produced them.`,
  ].join("\n");

  const headings = deps.map((t, i) => heading(i, t));
  const bodies = deps.map((t) => bodyParts(t));
  // the wrapper tags, the intro, each heading with its separators ("\n" after it, "\n\n" between blocks), and room for the tail blocks
  const fixed = 48 + intro.length + headings.reduce((a, h) => a + h.length + 3, 0) + 64 + missing.reduce((a, m) => a + m.length + 5, 0);
  const room = Math.max(0, total - fixed);

  // how many dependencies get a body: all of them when a minimal share fits, else the first ones
  let shown = deps.length;
  while (shown > 0 && room / shown < MIN_SHARE) shown--;
  const lengths = bodies.slice(0, shown).map((parts) => Math.min(per, parts.join("\n").length));
  const cap = Math.min(per, fairCap(lengths, room));

  const blocks: string[] = [];
  for (let i = 0; i < shown; i++) {
    const { text } = fitParts(bodies[i], cap);
    blocks.push(`${headings[i]}\n${text}`);
  }
  if (shown < deps.length) {
    const rest = deps.slice(shown).map((t, j) => `- ${shown + j + 1}. "${t.title}" — ${t.status} — task id ${t.id}`);
    blocks.push(`### ${deps.length - shown} more (no room for their results here${tool ? `: read them with ${tool}` : ""})\n${rest.join("\n")}`);
  }
  if (missing.length) blocks.push(`### Not found\n${missing.map((m) => `- "${m}"`).join("\n")}`);
  return `<dependency-results>\n${intro}\n\n${blocks.join("\n\n")}\n</dependency-results>`;
}

/** One task in full for the task_result tool: status, agent, result (from `offset`, up to `maxChars`), outcomes, error. */
export function renderTaskResult(task: Task, opts: { offset?: number; maxChars?: number } = {}): string {
  const result = taskResultText(task);
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));
  const max = Math.max(1000, opts.maxChars ?? 50_000);
  const slice = result.slice(offset, offset + max);
  const more = offset + slice.length < result.length;
  const lines = [
    `"${task.title}" — agent ${task.assignTo} — ${task.status} — task id ${task.id}${task.missionId ? ` — mission ${task.missionId}` : ""}`,
    "",
    result
      ? `Result (${result.length} characters${offset || more ? `, showing ${offset}–${offset + slice.length}` : ""}):\n${slice}${more ? `\n…[more: call again with offset ${offset + slice.length}]` : ""}`
      : task.status === "done" ? "Result: (no result text)" : "Result: (no result yet)",
  ];
  const outcomes = task.outcomes ?? [];
  if (outcomes.length) lines.push("", "Outcomes:", ...outcomes.map((o) => describeOutcome(o, task)));
  const error = taskErrorText(task);
  if (error) lines.push("", `Error:\n${error}`);
  return lines.join("\n");
}
