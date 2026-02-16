/**
 * LLM integration: query wrappers and structured extraction.
 *
 * Backend: pi-ai (multi-provider, works with any LLM).
 */

import { withRetry } from "./retry.js";
import { queryText, queryStream } from "./pi-client.js";

/** Progress callback for querySDK */
export type OnProgress = (event: string) => void;

/**
 * Query LLM for text-only response (no tools).
 * Uses pi-ai multi-provider backend. Model can be "provider:model" or bare model ID.
 */
export async function querySDKText(prompt: string, _cwd: string, model?: string): Promise<string> {
  return withRetry(async () => {
    return queryText(prompt, model);
  }, { maxRetries: 2 });
}

/**
 * Query with tool access.
 * Currently falls back to text-only query via pi-ai.
 */
export async function querySDK(
  prompt: string,
  allowedTools: string[],
  cwd: string,
  onProgress?: OnProgress,
  model?: string,
): Promise<string> {
  // Tools are handled by the built-in engine at spawn time;
  // for orchestrator-level queries, use text-only.
  return querySDKText(prompt, cwd, model);
}

/**
 * Streaming text query with progress callback.
 * Each delta chunk is passed to onChunk as it arrives.
 */
export async function querySDKStream(
  prompt: string,
  _cwd: string,
  model?: string,
  onChunk?: (delta: string) => void,
): Promise<string> {
  return withRetry(async () => {
    return queryStream(prompt, model, onChunk);
  }, { maxRetries: 2 });
}
