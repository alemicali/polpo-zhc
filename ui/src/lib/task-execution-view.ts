/**
 * Tasks → Execution shows a task's run as a Log (the event list) or as a Chat. The choice is a
 * per-person preference kept on this device; a deep link (?view=chat|log) wins over it.
 */
export type TaskExecutionView = "log" | "chat";

export const TASK_EXECUTION_VIEW_KEY = "polpo-task-execution-view";

export function parseExecutionView(value: string | null | undefined): TaskExecutionView | undefined {
  return value === "chat" || value === "log" ? value : undefined;
}

/** The saved view, "log" when none (or storage is blocked). */
export function readExecutionView(): TaskExecutionView {
  try {
    return parseExecutionView(localStorage.getItem(TASK_EXECUTION_VIEW_KEY)) ?? "log";
  } catch {
    return "log";
  }
}

export function writeExecutionView(view: TaskExecutionView): void {
  try {
    localStorage.setItem(TASK_EXECUTION_VIEW_KEY, view);
  } catch {
    // storage blocked (private mode, policy): the choice lasts for this page only
  }
}

/** Tabs of the task page, as ?tab= takes them (older links: detail, activity). */
export type TaskDetailTab = "assessment" | "details" | "execution" | "rules";

export function parseTaskTab(value: string | null | undefined): TaskDetailTab | undefined {
  if (value === "details" || value === "detail") return "details";
  if (value === "execution" || value === "activity") return "execution";
  if (value === "assessment" || value === "rules") return value;
  return undefined;
}
