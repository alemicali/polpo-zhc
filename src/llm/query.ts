/**
 * LLM integration: query wrappers and YAML extraction.
 *
 * Primary backend: pi-ai (multi-provider, works with any LLM).
 * Fallback: Claude Agent SDK for tool-using queries (queryWithTools).
 */

import { withRetry } from "./retry.js";
import { queryText } from "./pi-client.js";

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
 * Query with tool access via Claude Agent SDK.
 * Used for operations that need Claude Code built-in tools (Skill, Bash, etc.)
 * Falls back to text-only query if Claude SDK is not available.
 */
export async function querySDK(
  prompt: string,
  allowedTools: string[],
  cwd: string,
  onProgress?: OnProgress,
  model?: string,
): Promise<string> {
  // If no tools needed, use pi-ai directly
  if (!allowedTools || allowedTools.length === 0) {
    return querySDKText(prompt, cwd, model);
  }

  // Try Claude SDK for tool-using queries
  return withRetry(async () => {
    let query: any;
    try {
      const sdk = await import("@anthropic-ai/claude-agent-sdk");
      query = sdk.query;
    } catch {
      // Claude SDK not available — fall back to pi-ai text-only
      return queryText(prompt, model);
    }

    let resultText = "";
    const q = query({
      prompt,
      options: {
        cwd,
        permissionMode: "bypassPermissions" as any,
        allowDangerouslySkipPermissions: true,
        persistSession: false,
        allowedTools,
        model,
      },
    });

    for await (const message of q) {
      if (message.type === "assistant" && "message" in message) {
        const assistantMsg = message as { type: "assistant"; message: { content: Array<{ type: string; text?: string; name?: string; input?: Record<string, unknown> }> } };
        const content = assistantMsg.message.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "text" && block.text) {
              resultText = block.text;
              if (onProgress) {
                const firstLine = block.text.split("\n").find((l: string) => l.trim()) ?? "";
                if (firstLine.trim()) onProgress(firstLine.trim().slice(0, 120));
              }
            }
            if (block.type === "tool_use" && onProgress) {
              const toolName = block.name ?? "tool";
              const toolInput = block.input;
              if (toolName === "Bash") {
                const cmd = (toolInput?.command as string)?.slice(0, 80) ?? "";
                onProgress(`[${toolName}] ${cmd}`);
              } else if (toolName === "Skill") {
                const skill = (toolInput?.skill as string) ?? "";
                onProgress(`[Skill] ${skill}`);
              } else {
                onProgress(`[${toolName}]`);
              }
            }
          }
        }
      }
      if (message.type === "result" && "subtype" in message) {
        const resultMsg = message as { type: "result"; subtype: string; result?: string };
        if (resultMsg.subtype === "success" && resultMsg.result) {
          resultText = resultMsg.result;
        }
      }
    }

    return resultText.trim();
  }, { maxRetries: 2 });
}

/** Extract YAML block from LLM response (handles markdown fences) */
export function extractYaml(text: string): string {
  let yaml = text.trim();
  const fenceMatch = yaml.match(/```(?:ya?ml)?\n([\s\S]*?)\n```/i);
  if (fenceMatch) {
    yaml = fenceMatch[1].trim();
  }
  if (!yaml.startsWith("tasks:") && !yaml.startsWith("team:")) {
    const teamIdx = yaml.indexOf("team:");
    const tasksIdx = yaml.indexOf("tasks:");
    if (teamIdx >= 0 && (tasksIdx < 0 || teamIdx < tasksIdx)) {
      yaml = yaml.slice(teamIdx);
    } else if (tasksIdx >= 0) {
      yaml = yaml.slice(tasksIdx);
    }
  }
  return yaml;
}

/** Extract team YAML block from LLM response */
export function extractTeamYaml(text: string): string {
  let yaml = text.trim();
  const fenceMatch = yaml.match(/```(?:ya?ml)?\n([\s\S]*?)\n```/i);
  if (fenceMatch) yaml = fenceMatch[1].trim();
  if (!yaml.startsWith("team:")) {
    const idx = yaml.indexOf("team:");
    if (idx >= 0) yaml = yaml.slice(idx);
  }
  return yaml;
}
