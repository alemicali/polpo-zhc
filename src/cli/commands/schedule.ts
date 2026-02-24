import type { Command } from "commander";

/**
 * Schedule CLI commands — manage cron-based plan scheduling.
 * TODO: Implement schedule list, create, delete, enable, disable.
 */
export function registerScheduleCommands(program: Command): void {
  const cmd = program
    .command("schedule")
    .description("Manage scheduled plan executions");

  cmd
    .command("list")
    .description("List all schedules")
    .action(() => {
      console.log("No schedules configured.");
    });
}
