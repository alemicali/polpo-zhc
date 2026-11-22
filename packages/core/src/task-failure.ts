/**
 * Why a task failed, in a line: the labelled reason its last run gave (a harness runtime's error
 * says what to change: "Bedrock: model … not enabled for this account — …", "Anthropic:
 * authentication failed — …"), whether an automatic retry could help (`result.retryable`), and a
 * kind for badges. The dashboard, the MCP tools and cards, Polpo's own tools and the REST list
 * (slim projection) all show the same thing.
 */
import type { Task } from "./types.js";

/** model_access: the model is not enabled for the account; auth: credentials refused; budget: a spend limit; killed: stopped or timed out. */
export type TaskFailureKind = "model_access" | "auth" | "budget" | "killed" | "assessment" | "error";

export interface TaskFailure {
  /** The reason in a line (the first line of the error, at most 300 characters). */
  reason: string;
  /** false: a re-run of the same agent fails the same way (not retried automatically). */
  retryable: boolean;
  kind: TaskFailureKind;
}

const MODEL_ACCESS = /model[^\n]{0,120}not enabled for this account|not available for this account|model access/i;
const AUTH = /authentication failed|invalid (?:x-)?api[ -]?key|credentials? (?:are |were )?(?:invalid|expired|missing)/i;
const BUDGET = /spend limit|maxBudgetUsd|over budget/i;
const KILLED = /killed by sigterm|timed? ?out|was killed|stopped by/i;

/** The kind of a failure message (the labels harness errors carry; see src/harness/errors.ts). */
export function failureKind(message: string): TaskFailureKind {
  if (MODEL_ACCESS.test(message)) return "model_access";
  if (AUTH.test(message)) return "auth";
  if (BUDGET.test(message)) return "budget";
  if (KILLED.test(message)) return "killed";
  return "error";
}

const firstLine = (s: string, max = 300) => {
  const line = s.trim().split("\n").find((l) => l.trim())?.trim() ?? "";
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
};

/**
 * The failure of a failed task (or of a run that did not exit cleanly), else undefined. A task
 * that failed its review has the assessment's verdict as its reason.
 */
export function taskFailure(task: Pick<Task, "status" | "result">): TaskFailure | undefined {
  const r = task.result;
  if (task.status !== "failed" || !r) return undefined;
  const retryable = r.retryable !== false;
  const err = r.stderr?.trim();
  if (err) return { reason: firstLine(err), retryable, kind: failureKind(err) };
  const a = r.assessment;
  if (a && !a.passed) {
    const why = a.llmReview?.trim() || (typeof a.globalScore === "number" ? `assessment score ${a.globalScore}` : "the assessment did not pass");
    return { reason: firstLine(`Assessment: ${why}`), retryable, kind: "assessment" };
  }
  if (typeof r.exitCode === "number" && r.exitCode !== 0) return { reason: `exit code ${r.exitCode}`, retryable, kind: "error" };
  return undefined;
}

/** "Bedrock: model … not enabled … (not retried)" — a failure as one line of text. */
export function describeTaskFailure(f: TaskFailure): string {
  return `${f.reason}${f.retryable ? "" : " (not retried: a re-run would fail the same way)"}`;
}
