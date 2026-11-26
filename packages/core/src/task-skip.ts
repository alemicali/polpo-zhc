/**
 * Tasks a mission decision node did not reach. When a decision node takes a branch, the tasks of
 * the other branches (and the tasks whose dependencies are all skipped) are closed without running:
 * their status is `done` (so joins, mission completion, retries and every status filter keep
 * working exactly as before) and `result.skipped` says it was a skip — which node, the branch it
 * took, its answer. Every surface reads it through `taskSkip()` to show them as "Not reached"
 * instead of done, and to leave them out of the done counts.
 *
 * Tasks skipped before the marker existed only have the result text
 * (`Skipped: the decision "<node>" took the branch "<branch>" (<answer>)`): `taskSkip()` reads it too.
 *
 * Pure and dependency-free: the dashboard imports it as `@polpo-ai/core/task-skip`.
 */

/** Why a task did not run: a decision node took another branch. Stored at `Task.result.skipped`. */
export interface TaskSkip {
  reason: "decision";
  /** The decision node's name. */
  node: string;
  /** The branch the node took (null: no branch, none of its tasks run). */
  branch: string | null;
  /** The node's answer in words (`team: billing (0.81)`), when there was one. */
  answer?: string;
  /** The answer's confidence (0..1), when the model gave one. */
  confidence?: number;
  /** Who chose the branch: "model", "onUncertain" or a person. */
  decidedBy?: string;
  /** When the task was skipped. */
  at?: string;
}

/** The result text of a skipped task (also what tasks skipped before `result.skipped` existed carry). */
export function taskSkipText(s: Pick<TaskSkip, "node" | "branch" | "answer">): string {
  return `Skipped: the decision "${s.node}" took ${s.branch ? `the branch "${s.branch}"` : "no branch"} (${s.answer ?? "no answer"})`;
}

const LEGACY = /^Skipped: the decision "([^"]+)" took (?:the branch "([^"]*)"|no branch) \(([\s\S]*)\)\s*$/;

/** Read a task's skip marker: `result.skipped`, else the legacy result text of a done task. */
export function taskSkip(task: { status?: string; result?: { stdout?: string; skipped?: unknown } | null } | null | undefined): TaskSkip | undefined {
  const r = task?.result;
  if (!r) return undefined;
  const s = r.skipped as Partial<TaskSkip> | undefined;
  if (s && typeof s === "object" && typeof s.node === "string") {
    return {
      reason: "decision", node: s.node, branch: typeof s.branch === "string" ? s.branch : null,
      ...(typeof s.answer === "string" ? { answer: s.answer } : {}),
      ...(typeof s.confidence === "number" ? { confidence: s.confidence } : {}),
      ...(typeof s.decidedBy === "string" ? { decidedBy: s.decidedBy } : {}),
      ...(typeof s.at === "string" ? { at: s.at } : {}),
    };
  }
  if (task?.status !== undefined && task.status !== "done") return undefined;
  const m = typeof r.stdout === "string" ? LEGACY.exec(r.stdout.trim()) : null;
  if (!m) return undefined;
  const answer = m[3] && m[3] !== "no answer" ? m[3] : undefined;
  const conf = answer ? /\((\d(?:\.\d+)?)\)/.exec(answer) : null;
  return {
    reason: "decision", node: m[1], branch: m[2] ?? null,
    ...(answer ? { answer } : {}),
    ...(conf ? { confidence: Number(conf[1]) } : {}),
  };
}

/** Did a decision node leave this task out (done without running)? */
export function isTaskNotReached(task: Parameters<typeof taskSkip>[0]): boolean {
  return taskSkip(task) !== undefined;
}

/** "Not reached: the decision route chose billing" — the line every surface shows. */
export function taskSkipLabel(s: TaskSkip): string {
  return `Not reached: the decision "${s.node}" chose ${s.branch ? `"${s.branch}"` : "no branch"}`;
}

/**
 * Status counts that keep "not reached" tasks apart from done ones: `done` counts only the tasks
 * that really ran, `notReached` the skipped ones; `total` is every task.
 */
export function countTaskOutcomes<T extends { status: string; result?: { stdout?: string; skipped?: unknown } | null }>(tasks: readonly T[]): { total: number; done: number; failed: number; notReached: number; active: number } {
  let done = 0, failed = 0, notReached = 0, active = 0;
  for (const t of tasks) {
    if (t.status === "done") { if (taskSkip(t)) notReached++; else done++; }
    else if (t.status === "failed") failed++;
    else if (t.status !== "pending" && t.status !== "draft") active++;
  }
  return { total: tasks.length, done, failed, notReached, active };
}
