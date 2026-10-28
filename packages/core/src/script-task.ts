/**
 * Script tasks: a mission task that runs a shell command instead of an agent.
 *
 * Polpo runs the command itself, in the task's sandbox and working directory, with no model.
 * The task has its own output folder (POLPO_OUTPUT_DIR), its log and its status: done when the
 * command exits with 0 and its expectations pass, otherwise retried or failed like any task.
 */

/** `assignTo` of a script task: it names no agent. */
export const SCRIPT_ASSIGNEE = "@script";

/** The `script` section of a mission task. */
export interface MissionTaskScript {
  /** Shell command (bash; Git bash or cmd.exe on Windows), run in the working directory. */
  command: string;
}

export function isScriptTask(task: { assignTo?: string }): boolean {
  return task.assignTo === SCRIPT_ASSIGNEE;
}

/** The script of task `title` in a mission document (JSON), if it has a command. */
export function missionTaskScript(missionData: string | undefined, title: string): MissionTaskScript | undefined {
  if (!missionData) return undefined;
  try {
    const doc = JSON.parse(missionData) as { tasks?: Array<{ title?: string; script?: { command?: unknown } }> };
    const command = doc.tasks?.find((t) => t.title === title)?.script?.command;
    return typeof command === "string" && command.trim() ? { command } : undefined;
  } catch {
    return undefined;
  }
}

/** What a script task shows as its description when the mission gives none. */
export function scriptTaskDescription(command: string): string {
  const firstLine = command.trim().split(/\r?\n/)[0] ?? "";
  return `Run: ${firstLine}${command.trim().includes("\n") ? " …" : ""}`;
}
