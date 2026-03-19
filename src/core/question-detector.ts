/**
 * Re-export shim: question-detector from @polpo-ai/core.
 * Source of truth is packages/core/src/question-detector.ts.
 *
 * The core version's classifyAsQuestion takes queryLLM as a parameter.
 * This shim preserves the old signature (queryOrchestratorText imported directly)
 * for backward compatibility with root-level code and tests.
 */

import { queryOrchestratorText } from "../llm/query.js";
import type { TaskResult, AgentActivity, ModelConfig } from "./types.js";

// Re-export looksLikeQuestion unchanged (same signature in core)
export { looksLikeQuestion } from "@polpo-ai/core/question-detector";

/**
 * Async LLM classifier: confirms whether the output is truly a question.
 * Only called after heuristic pre-filter passes.
 *
 * Shell-compatible signature: uses queryOrchestratorText directly (legacy behavior).
 */
export async function classifyAsQuestion(
  stdout: string,
  model?: string | ModelConfig,
): Promise<{ isQuestion: boolean; question: string }> {
  const { classifyAsQuestion: coreClassify } = await import("@polpo-ai/core/question-detector");
  return coreClassify(stdout, (prompt, m) => queryOrchestratorText(prompt, m), model);
}
