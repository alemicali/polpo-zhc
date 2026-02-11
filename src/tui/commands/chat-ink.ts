/**
 * Chat mode handler for Ink TUI — queries Claude for Q&A about Polpo state.
 * Same as chat.ts but uses chalk instead of blessed tags.
 */

import chalk from "chalk";
import type { CommandContext } from "../context.js";
import { querySDKText } from "../../llm/query.js";
import { buildChatSystemPrompt } from "../../llm/prompts.js";
import { useTUIStore } from "../store.js";

export async function handleChatInput(ctx: CommandContext, input: string): Promise<void> {
  const store = useTUIStore.getState();
  store.logAlways(`  ${chalk.cyan(">")} ${input}`);
  store.logAlways("");
  ctx.setProcessing(true, "Thinking");

  try {
    const response = await queryChatResponse(ctx, input);
    ctx.setProcessing(false);

    if (response) {
      for (const line of response.split("\n")) {
        store.logAlways(`  ${line}`);
      }
    } else {
      store.logAlways(chalk.gray("No response"));
    }
    store.logAlways("");
  } catch (err: unknown) {
    ctx.setProcessing(false);
    const msg = err instanceof Error ? err.message : String(err);
    store.logAlways(chalk.red(`Chat error: ${msg}`));
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
    `Answer concisely based on the current Polpo state. Use plain text, no markdown.`,
  ].join("\n");

  return querySDKText(prompt, ctx.workDir, ctx.orchestrator.getConfig()?.settings?.orchestratorModel);
}
