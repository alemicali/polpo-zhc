/**
 * Task result tools: a task reads the results of other tasks.
 *
 * - task_result({task}): one task in full (result text, outcomes with file references, status,
 *   error), by id or title.
 * - dependency_results(): the results of every task this task depends on.
 *
 * Scope (decided in @polpo-ai/core taskReadScope): the task's own dependencies and the tasks of
 * its own mission (itself included). Tasks of other missions or other agents' standalone tasks
 * are refused. Given to a task run whose task has dependencies or belongs to a mission, on
 * Polpo's engine and, as host tools, on the agent harnesses (Claude Code, Codex).
 */

import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  DEPENDENCY_RESULTS_TOOL, TASK_RESULT_TOOL, findTaskInScope, renderDependencyResults, renderTaskResult, resolveDependencies, taskReadScope,
  type Task,
} from "@polpo-ai/core";

export const TASK_RESULT_TOOL_NAMES = [TASK_RESULT_TOOL, DEPENDENCY_RESULTS_TOOL] as const;

const TaskResultSchema = Type.Object({
  task: Type.String({ description: "The task's id or its exact title (a task this task depends on, or a task of the same mission)" }),
  offset: Type.Optional(Type.Number({ description: "Character offset into a long result (to read the part after a previous call)" })),
});

const DependencyResultsSchema = Type.Object({});

/** Whether a task gets these tools: it depends on other tasks or belongs to a mission. */
export function wantsTaskResultTools(task: Pick<Task, "dependsOn" | "missionId" | "group"> | undefined): boolean {
  return !!task && ((task.dependsOn?.length ?? 0) > 0 || !!task.missionId || !!task.group);
}

function text(t: string, details: Record<string, unknown> = {}) {
  return { content: [{ type: "text" as const, text: t }], details };
}

/**
 * The tools for the run of `task`. `loadTasks` reads every task fresh (the task store), so a
 * dependency's result is the current one.
 */
export function createTaskResultTools(task: Task, loadTasks: () => Promise<Task[]>): AgentTool<any>[] {
  const current = async (): Promise<{ me: Task; all: Task[] }> => {
    const all = await loadTasks();
    // the stored task (dependsOn may have changed, e.g. a failed dependency removed); else the run's copy
    const stored = all.find((t) => t.id === task.id);
    return { me: stored ? { ...stored, dependsOn: stored.dependsOn ?? task.dependsOn } : task, all };
  };

  const taskResult: AgentTool<typeof TaskResultSchema> = {
    name: TASK_RESULT_TOOL,
    label: "Read Task Result",
    description:
      "Read another task's result in full: its final result text, its registered outcomes (text inline; files and media "
      + "as references: path on the producing task's computer, outcome id), its status and its error if it failed. "
      + "Allowed: the tasks this task depends on and the tasks of the same mission, by id or exact title.",
    parameters: TaskResultSchema,
    async execute(_id, params) {
      const { me, all } = await current();
      const scope = taskReadScope(me, all);
      const { task: found, ambiguous } = findTaskInScope(String(params.task ?? ""), scope);
      if (ambiguous) {
        throw new Error(`More than one task is titled "${params.task}": use the id (${ambiguous.map((t) => `${t.id} [${t.status}]`).join(", ")})`);
      }
      if (!found) {
        const exists = all.some((t) => t.id === params.task || t.title === params.task);
        throw new Error(exists
          ? `Task "${params.task}" is not one this task depends on, nor of its mission: you cannot read it.`
          : `No task "${params.task}" among this task's dependencies and its mission's tasks.`);
      }
      return text(renderTaskResult(found, { offset: params.offset }), { taskId: found.id, status: found.status });
    },
  };

  const dependencyResults: AgentTool<typeof DependencyResultsSchema> = {
    name: DEPENDENCY_RESULTS_TOOL,
    label: "Read Dependency Results",
    description:
      "The results of every task this task depends on (result text, outcomes, errors), longer than in your prompt. "
      + "For one result in full use task_result.",
    parameters: DependencyResultsSchema,
    async execute() {
      const { me, all } = await current();
      const { tasks, missing } = resolveDependencies(me, all);
      if (tasks.length === 0 && missing.length === 0) return text("This task depends on no other task.", { count: 0 });
      return text(renderDependencyResults(tasks, { missing, perTaskChars: 8_000, totalChars: 80_000 }), { count: tasks.length });
    },
  };

  return [taskResult, dependencyResults];
}
