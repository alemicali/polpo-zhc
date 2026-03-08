/**
 * Schedule CLI commands — manage cron-based plan scheduling.
 * Subcommands: list, create, delete, enable, disable.
 */

import type { Command } from "commander";
import chalk from "chalk";
import { withOrchestrator } from "../helpers.js";

export function registerScheduleCommands(program: Command): void {
  const cmd = program
    .command("schedule")
    .description("Manage scheduled plan executions");

  // ── schedule list ─────────────────────────────────────────────────────
  cmd
    .command("list")
    .description("List all schedules")
    .option("-d, --dir <path>", "Working directory", ".")
    .option("--active", "Show only active (enabled) schedules")
    .action(async (opts) => {
      await withOrchestrator(opts.dir, async (orchestrator) => {
        const scheduler = orchestrator.getScheduler();
        if (!scheduler) {
          console.log(chalk.yellow("Scheduler is not available. Start the server first."));
          return;
        }

        const schedules = opts.active
          ? scheduler.getActiveSchedules()
          : scheduler.getAllSchedules();

        if (schedules.length === 0) {
          console.log(chalk.dim("  No schedules configured."));
          return;
        }

        console.log(chalk.bold(`\n  Schedules (${schedules.length})\n`));

        for (const entry of schedules) {
          const status = entry.enabled
            ? chalk.green("enabled")
            : chalk.dim("disabled");
          const type = entry.recurring
            ? chalk.magenta("recurring")
            : chalk.blue("one-shot");
          const next = entry.nextRunAt
            ? chalk.cyan(new Date(entry.nextRunAt).toLocaleString())
            : chalk.dim("—");
          const last = entry.lastRunAt
            ? chalk.dim(new Date(entry.lastRunAt).toLocaleString())
            : chalk.dim("never");

          console.log(`  ${chalk.bold(entry.missionId)}`);
          console.log(`    Expression: ${chalk.yellow(entry.expression)}  ${type}  ${status}`);
          console.log(`    Next run:   ${next}`);
          console.log(`    Last run:   ${last}`);
          console.log();
        }
      });
    });

  // ── schedule create ───────────────────────────────────────────────────
  cmd
    .command("create <missionId> <expression>")
    .description("Create a schedule for a mission (cron expression or ISO timestamp)")
    .option("-d, --dir <path>", "Working directory", ".")
    .option("-r, --recurring", "Make the schedule recurring (default for cron expressions)")
    .option("--end-date <date>", "End date for the schedule (ISO format)")
    .action(async (missionId: string, expression: string, opts) => {
      await withOrchestrator(opts.dir, async (orchestrator) => {
        const scheduler = orchestrator.getScheduler();
        if (!scheduler) {
          console.error(chalk.red("Scheduler is not available. Start the server first."));
          process.exit(1);
        }

        const mission = await orchestrator.getMission(missionId);
        if (!mission) {
          console.error(chalk.red(`Mission "${missionId}" not found.`));
          process.exit(1);
        }

        // Determine if recurring: explicit flag, or auto-detect from cron-like expression
        const isRecurring = opts.recurring ?? expression.includes(" ");
        const newStatus = isRecurring ? "recurring" : "scheduled";

        const missionUpdate: Record<string, unknown> = {
          schedule: expression,
          status: newStatus,
        };
        if (opts.endDate) {
          missionUpdate.endDate = opts.endDate;
        }

        const updated = await orchestrator.updateMission(missionId, missionUpdate as any);
        const entry = scheduler.registerMission(updated);

        if (!entry) {
          console.error(chalk.red("Could not create schedule. Expression may be invalid or timestamp is in the past."));
          process.exit(1);
        }

        console.log(chalk.green(`Schedule created for mission "${missionId}".`));
        console.log(`  Expression: ${chalk.yellow(expression)}`);
        console.log(`  Type:       ${isRecurring ? chalk.magenta("recurring") : chalk.blue("one-shot")}`);
        if (entry.nextRunAt) {
          console.log(`  Next run:   ${chalk.cyan(new Date(entry.nextRunAt).toLocaleString())}`);
        }
      });
    });

  // ── schedule delete ───────────────────────────────────────────────────
  cmd
    .command("delete <missionId>")
    .description("Delete a schedule for a mission")
    .option("-d, --dir <path>", "Working directory", ".")
    .action(async (missionId: string, opts) => {
      await withOrchestrator(opts.dir, async (orchestrator) => {
        const scheduler = orchestrator.getScheduler();
        if (!scheduler) {
          console.error(chalk.red("Scheduler is not available. Start the server first."));
          process.exit(1);
        }

        const deleted = scheduler.unregisterMission(missionId);
        if (!deleted) {
          console.error(chalk.red(`No schedule found for mission "${missionId}".`));
          process.exit(1);
        }

        // Clear schedule from mission and reset to draft
        orchestrator.updateMission(missionId, { schedule: undefined, status: "draft" } as any);
        console.log(chalk.green(`Schedule deleted for mission "${missionId}". Mission reset to draft.`));
      });
    });

  // ── schedule enable ───────────────────────────────────────────────────
  cmd
    .command("enable <missionId>")
    .description("Enable a schedule")
    .option("-d, --dir <path>", "Working directory", ".")
    .action(async (missionId: string, opts) => {
      await withOrchestrator(opts.dir, async (orchestrator) => {
        const scheduler = orchestrator.getScheduler();
        if (!scheduler) {
          console.error(chalk.red("Scheduler is not available. Start the server first."));
          process.exit(1);
        }

        const entry = scheduler.getScheduleByMissionId(missionId);
        if (!entry) {
          console.error(chalk.red(`No schedule found for mission "${missionId}".`));
          process.exit(1);
        }

        entry.enabled = true;
        console.log(chalk.green(`Schedule enabled for mission "${missionId}".`));
        if (entry.nextRunAt) {
          console.log(`  Next run: ${chalk.cyan(new Date(entry.nextRunAt).toLocaleString())}`);
        }
      });
    });

  // ── schedule disable ──────────────────────────────────────────────────
  cmd
    .command("disable <missionId>")
    .description("Disable a schedule (without deleting it)")
    .option("-d, --dir <path>", "Working directory", ".")
    .action(async (missionId: string, opts) => {
      await withOrchestrator(opts.dir, async (orchestrator) => {
        const scheduler = orchestrator.getScheduler();
        if (!scheduler) {
          console.error(chalk.red("Scheduler is not available. Start the server first."));
          process.exit(1);
        }

        const entry = scheduler.getScheduleByMissionId(missionId);
        if (!entry) {
          console.error(chalk.red(`No schedule found for mission "${missionId}".`));
          process.exit(1);
        }

        entry.enabled = false;
        console.log(chalk.yellow(`Schedule disabled for mission "${missionId}".`));
      });
    });
}
