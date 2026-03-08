import { Command } from "commander";
import chalk from "chalk";
import { resolve } from "node:path";
import { Orchestrator } from "../../core/orchestrator.js";
import { buildChatSystemPrompt } from "../../llm/prompts.js";
import { queryOrchestratorText } from "../../llm/query.js";
import type { SessionStore } from "../../core/session-store.js";

const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 min
const MAX_HISTORY = 20;

async function initOrchestrator(configPath: string): Promise<Orchestrator> {
  const o = new Orchestrator(resolve(configPath));
  await o.init();
  return o;
}

/**
 * Resolve an existing recent session or create a new one.
 * Returns null only when no SessionStore is available.
 */
async function resolveSession(sessionStore: SessionStore | undefined, timeout = SESSION_TIMEOUT_MS): Promise<string | null> {
  if (!sessionStore) return null;
  const latest = await sessionStore.getLatestSession();
  if (latest) {
    const age = Date.now() - new Date(latest.updatedAt).getTime();
    if (age < timeout) return latest.id;
  }
  return await sessionStore.create();
}

export function registerChatCommands(program: Command): void {
  program
    .command("chat <message...>")
    .description("Chat with the Polpo assistant about your project")
    .option("-d, --dir <path>", "Working directory", ".")
    .action(async (messageArgs: string[], opts) => {
      const message = messageArgs.join(" ");

      try {
        const orchestrator = await initOrchestrator(opts.dir);
        const sessionStore = orchestrator.getSessionStore();
        const sessionId = await resolveSession(sessionStore);

        // Persist user message
        if (sessionStore && sessionId) {
          await sessionStore.addMessage(sessionId, "user", message);
        }

        // Build system prompt with current state
        const state = await (async () => {
          try { return await orchestrator.getStore()?.getState() ?? null; }
          catch { return null; }
        })();
        const systemPrompt = await buildChatSystemPrompt(orchestrator, state);

        // Assemble full prompt with conversation history
        const history = sessionStore && sessionId
          ? await sessionStore.getRecentMessages(sessionId, MAX_HISTORY)
          : [];

        const parts: string[] = [systemPrompt];

        // Inject conversation history (skip current message)
        const past = history.filter((m) => !(m.role === "user" && m.content === message));
        if (past.length > 0) {
          parts.push("", "## Conversation History", "");
          for (const m of past) {
            parts.push(`${m.role === "user" ? "User" : "Assistant"}: ${m.content}`);
          }
        }

        parts.push(
          "", "---", "",
          `User question: ${message}`,
          "",
          "Answer concisely based on the current Polpo state.",
        );

        const fullPrompt = parts.join("\n");
        const response = (await queryOrchestratorText(fullPrompt, orchestrator.getConfig()?.settings?.orchestratorModel)).text;

        if (response) {
          // Persist assistant response
          if (sessionStore && sessionId) {
            await sessionStore.addMessage(sessionId, "assistant", response);
          }
          console.log(response);
        } else {
          console.log(chalk.dim("No response."));
        }
      } catch (err: any) {
        console.error(chalk.red(`Error: ${err.message}`));
        process.exit(1);
      }
    });
}
