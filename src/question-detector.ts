/**
 * Question detection: identifies when an agent asks a question instead of completing work.
 * Hybrid approach: cheap sync heuristic pre-filter + async LLM classifier.
 */

import { querySDKText } from "./llm/query.js";
import type { TaskResult, AgentActivity } from "./core/types.js";

/**
 * Sync heuristic pre-filter: cheap check for likely question outputs.
 * Returns true if the output looks like a question (short, ends with ?, low tool usage).
 */
export function looksLikeQuestion(result: TaskResult, activity?: AgentActivity): boolean {
  const text = result.stdout.trim();
  // No output or long output → probably real work
  if (!text || text.length > 2000) return false;

  // Must contain "?" in the last 3 non-empty lines
  const lines = text.split("\n").filter(l => l.trim());
  const tail = lines.slice(-3).join(" ");
  if (!tail.includes("?")) return false;

  // If we have activity data, check for real work indicators
  if (activity) {
    // Many tool calls → agent did significant work
    if (activity.toolCalls >= 5) return false;
    // Files created or edited → agent produced output
    if (activity.filesCreated.length > 0 || activity.filesEdited.length > 0) return false;
  }

  return true;
}

/**
 * Async LLM classifier: confirms whether the output is truly a question.
 * Only called after heuristic pre-filter passes.
 */
export async function classifyAsQuestion(
  stdout: string,
  cwd: string,
  model?: string,
): Promise<{ isQuestion: boolean; question: string }> {
  const prompt = [
    `Analyze this AI coding agent output. Did the agent COMPLETE the assigned task, or is it asking a question / requesting clarification instead of working?`,
    ``,
    `Agent output:`,
    `"""`,
    stdout.slice(-1500),
    `"""`,
    ``,
    `Respond with ONLY a JSON object (no markdown fences):`,
    `{"isQuestion": true, "question": "the extracted question"}`,
    `or`,
    `{"isQuestion": false, "question": ""}`,
  ].join("\n");

  const response = await querySDKText(prompt, cwd, model);
  try {
    const cleaned = response.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
    const parsed = JSON.parse(cleaned);
    return { isQuestion: !!parsed.isQuestion, question: parsed.question || "" };
  } catch {
    // Parse failure → assume not a question (safe fallback)
    return { isQuestion: false, question: "" };
  }
}
