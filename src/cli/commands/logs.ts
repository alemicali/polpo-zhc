/**
 * CLI logs subcommands — view persistent event logs from LogStore.
 */

import { Command } from "commander";
import chalk from "chalk";
import { resolve } from "node:path";
import { Orchestrator } from "../../core/orchestrator.js";
import "../../adapters/claude-sdk.js";
import "../../adapters/generic.js";

async function initOrchestrator(configPath: string): Promise<Orchestrator> {
  const o = new Orchestrator(resolve(configPath));
  await o.init();
  return o;
}

/** Produce a short one-line summary of an event payload. */
function summarize(data: Record<string, unknown>): string {
  const parts: string[] = [];
  if (data.taskId) parts.push(`task:${String(data.taskId).slice(0, 8)}`);
  if (data.agentName) parts.push(String(data.agentName));
  if (data.title) parts.push(String(data.title));
  if (data.group) parts.push(`group:${data.group}`);
  if (data.passed !== undefined) parts.push(data.passed ? "passed" : "failed");
  if (data.message) parts.push(String(data.message).slice(0, 50));
  return parts.join(" | ");
}

export function registerLogsCommands(program: Command): void {
  const logs = program
    .command("logs")
    .description("View persistent event logs");

  // polpo logs list
  logs
    .command("list")
    .description("List all log sessions")
    .option("-c, --config <path>", "Path to working directory", ".")
    .action(async (opts) => {
      const orchestrator = await initOrchestrator(opts.config);
      const logStore = orchestrator.getLogStore();
      if (!logStore) {
        console.error(chalk.red("No log store available. Run 'polpo init' first."));
        process.exit(1);
      }

      const sessions = logStore.listSessions();
      if (sessions.length === 0) {
        console.log(chalk.dim("No log sessions found."));
        return;
      }

      console.log(chalk.bold("Log Sessions:\n"));
      for (const s of sessions) {
        const shortId = s.sessionId.slice(0, 8);
        console.log(
          `  ${chalk.cyan(shortId)}  ${chalk.dim(s.startedAt)}  ${chalk.yellow(`${s.entries} entries`)}`,
        );
      }
      console.log();
    });

  // polpo logs show [sessionId]
  logs
    .command("show [sessionId]")
    .description("Show log entries for a session")
    .option("-c, --config <path>", "Path to working directory", ".")
    .option("-n, --limit <n>", "Limit number of entries", "50")
    .option("--event <pattern>", "Filter by event name (substring match)")
    .action(async (sessionId: string | undefined, opts) => {
      const orchestrator = await initOrchestrator(opts.config);
      const logStore = orchestrator.getLogStore();
      if (!logStore) {
        console.error(chalk.red("No log store available. Run 'polpo init' first."));
        process.exit(1);
      }

      const resolvedId = sessionId ?? logStore.getSessionId();
      if (!resolvedId) {
        console.error(chalk.red("No session ID provided and no active session found."));
        process.exit(1);
      }

      let entries = logStore.getSessionEntries(resolvedId);

      // Apply event filter
      if (opts.event) {
        const pattern = opts.event.toLowerCase();
        entries = entries.filter((e) => e.event.toLowerCase().includes(pattern));
      }

      // Apply limit
      const limit = parseInt(opts.limit, 10);
      if (entries.length > limit) {
        entries = entries.slice(-limit);
      }

      if (entries.length === 0) {
        console.log(chalk.dim("No matching entries."));
        return;
      }

      console.log(chalk.bold(`Session ${resolvedId.slice(0, 8)} — ${entries.length} entries:\n`));

      for (const entry of entries) {
        const time = entry.ts.slice(11, 19); // HH:MM:SS from ISO timestamp
        const eventName = entry.event.padEnd(24);
        const data =
          typeof entry.data === "object" && entry.data !== null
            ? summarize(entry.data as Record<string, unknown>)
            : "";
        console.log(`  ${chalk.dim(time)}  ${chalk.cyan(eventName)} ${data}`);
      }
      console.log();
    });
}
