/**
 * Answer generator: produces answers to agent questions using project context.
 * Used by the orchestrator to auto-resolve clarification requests.
 */

import { querySDKText } from "./query.js";
import type { Orchestrator } from "../orchestrator.js";
import type { Task } from "../core/types.js";

/**
 * Generate an answer to an agent's question using project memory,
 * sibling task results, and task context.
 */
export async function generateAnswer(
  orchestrator: Orchestrator,
  task: Task,
  question: string,
  cwd: string,
  model?: string,
): Promise<string> {
  const memory = orchestrator.getMemory();
  const state = orchestrator.getStore().getState();

  // Sibling tasks in the same plan group for additional context
  const siblings = task.group
    ? state.tasks.filter(t => t.group === task.group && t.id !== task.id)
    : [];

  const prompt = buildAnswerPrompt(memory, task, siblings, question);
  return querySDKText(prompt, cwd, model);
}

function buildAnswerPrompt(
  memory: string,
  task: Task,
  siblings: Task[],
  question: string,
): string {
  const parts = [
    `You are Polpo, an AI agent orchestration framework. An agent working on a task has asked a question instead of completing the work.`,
    `Your job is to answer the question concisely so the agent can proceed autonomously.`,
    ``,
    `## Task`,
    `Title: ${task.title}`,
    `Description: ${task.originalDescription || task.description}`,
  ];

  if (memory) {
    parts.push(``, `## Project Memory`, memory);
  }

  if (siblings.length > 0) {
    parts.push(``, `## Related tasks in the same plan`);
    for (const s of siblings) {
      parts.push(`- [${s.status}] ${s.title}`);
      if (s.result?.stdout && s.status === "done") {
        parts.push(`  Result: ${s.result.stdout.slice(0, 200)}`);
      }
    }
  }

  parts.push(
    ``,
    `## Agent's Question`,
    question,
    ``,
    `Answer the question directly and concisely. Provide specific, actionable information.`,
    `If you're unsure, give your best guidance based on available context.`,
    `Do NOT ask follow-up questions. Just answer.`,
  );

  return parts.join("\n");
}
