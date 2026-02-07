/**
 * Chat mode handler — queries Claude for Q&A about Orchestra state.
 */

import type { CommandContext } from "../context.js";
import { querySDKText } from "../llm.js";
import { buildChatSystemPrompt } from "../prompts.js";

export async function handleChatInput(ctx: CommandContext, input: string): Promise<void> {
  ctx.logAlways(`{magenta-fg}?{/magenta-fg} ${input}`);
  ctx.logAlways("");
  ctx.setProcessing(true, "Thinking");

  try {
    const response = await queryChatResponse(ctx, input);
    ctx.setProcessing(false);

    if (response) {
      for (const line of response.split("\n")) {
        ctx.logAlways(`  ${line}`);
      }
    } else {
      ctx.logAlways("{grey-fg}No response{/grey-fg}");
    }
    ctx.logAlways("");
  } catch (err: unknown) {
    ctx.setProcessing(false);
    const msg = err instanceof Error ? err.message : String(err);
    ctx.logAlways(`{red-fg}Chat error: ${msg}{/red-fg}`);
  }
}

async function queryChatResponse(ctx: CommandContext, input: string): Promise<string> {
  ctx.loadState();
  const prompt = [
    buildChatSystemPrompt(ctx.orchestrator, ctx.getState(), ctx.workDir),
    ``,
    `---`,
    ``,
    `User question: ${input}`,
    ``,
    `Answer concisely based on the current Orchestra state. Use plain text, no markdown.`,
  ].join("\n");

  return querySDKText(prompt, ctx.workDir);
}
