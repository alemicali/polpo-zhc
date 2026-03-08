/**
 * CLI mission subcommands — create, list, show, execute, resume, delete, abort.
 */

import { Command } from "commander";
import chalk from "chalk";
import { resolve } from "node:path";
import { Orchestrator } from "../../core/orchestrator.js";
import { resolveModelSpec } from "../../llm/pi-client.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function initOrchestrator(configPath: string): Promise<Orchestrator> {
  const o = new Orchestrator(resolve(configPath));
  await o.init();
  return o;
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30) || "mission";
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerMissionCommands(program: Command): void {
  const mission = program
    .command("mission")
    .description("Manage execution missions");

  // ---- mission list ---------------------------------------------------------
  mission
    .command("list")
    .description("List all missions")
    .option("-d, --dir <path>", "Working directory", ".")
    .action(async (opts) => {
      try {
        const orchestrator = await initOrchestrator(opts.dir);
        const missions = await orchestrator.getAllMissions();

        if (missions.length === 0) {
          console.log(chalk.dim("  No missions found."));
          return;
        }

        for (const m of missions) {
          const prompt = m.prompt
            ? m.prompt.length > 60
              ? m.prompt.slice(0, 57) + "..."
              : m.prompt
            : "";
          const statusColors: Record<string, (s: string) => string> = {
            draft: chalk.dim,
            scheduled: chalk.blue,
            recurring: chalk.magenta,
            active: chalk.cyan,
            paused: chalk.yellow,
            completed: chalk.green,
            failed: chalk.red,
            cancelled: chalk.yellow,
          };
          const status = (statusColors[m.status] ?? chalk.dim)(m.status);
          console.log(
            `  ${chalk.bold(m.name)} [${status}]` +
            (prompt ? chalk.dim(` — ${prompt}`) : ""),
          );
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`Error: ${msg}`));
        process.exit(1);
      }
    });

  // ---- mission show <missionId> ------------------------------------------------
  mission
    .command("show <missionId>")
    .description("Show details of a mission")
    .option("-d, --dir <path>", "Working directory", ".")
    .action(async (missionId: string, opts) => {
      try {
        const orchestrator = await initOrchestrator(opts.dir);
        const m = await orchestrator.getMission(missionId) ?? await orchestrator.getMissionByName(missionId);

        if (!m) {
          console.error(chalk.red(`Mission not found: ${missionId}`));
          process.exit(1);
        }

        console.log(chalk.bold(`  Name:      `) + m.name);
        console.log(chalk.bold(`  Status:    `) + m.status);
        if (m.prompt) {
          console.log(chalk.bold(`  Prompt:    `) + m.prompt);
        }
        console.log(chalk.bold(`  Created:   `) + m.createdAt);
        console.log(chalk.bold(`  Updated:   `) + m.updatedAt);
        console.log();
        console.log(chalk.dim("  --- Mission Data ---"));
        console.log();
        try {
          const parsed = JSON.parse(m.data);
          console.log(JSON.stringify(parsed, null, 2));
        } catch {
          console.log(m.data);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`Error: ${msg}`));
        process.exit(1);
      }
    });

  // ---- mission create <prompt...> -------------------------------------------
  mission
    .command("create <prompt...>")
    .description("Generate a new mission from a prompt using the LLM")
    .option("-d, --dir <path>", "Working directory", ".")
    .option("--execute", "Immediately execute the mission after creating")
    .option("--save", "Save as draft (default if --execute not given)")
    .action(async (promptArgs: string[], opts) => {
      try {
        const orchestrator = await initOrchestrator(opts.dir);
        const prompt = promptArgs.join(" ");

        const { buildMissionSystemPrompt } = await import("../../llm/prompts.js");
        const { generateMission, missionDataToJson } = await import("../../llm/mission-generator.js");

        const state = await (async () => {
          try { return await orchestrator.getStore()?.getState() ?? null; }
          catch { return null; }
        })();

        const systemPrompt = await buildMissionSystemPrompt(orchestrator, state, orchestrator.getWorkDir());
        const userPrompt = `Generate a task mission for:\n"${prompt}"`;
        const settings = orchestrator.getConfig()?.settings;
        const model = resolveModelSpec(settings?.orchestratorModel);

        console.log(chalk.dim("  Generating mission..."));
        const missionData = await generateMission(systemPrompt, userPrompt, model, undefined, settings?.reasoning);
        const json = missionDataToJson(missionData);

        const missionName = slugify(missionData.name);
        const mission = await orchestrator.saveMission({
          data: json,
          prompt,
          name: missionName,
          status: opts.execute ? undefined : "draft",
        });

        if (opts.execute) {
          const result = await orchestrator.executeMission(mission.id);
          console.log(
            chalk.green(`  Mission "${mission.name}" created and executed — ${result.tasks.length} task(s), group: ${result.group}`),
          );
        } else {
          console.log(
            chalk.green(`  Mission "${mission.name}" saved as draft.`),
          );
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`Error: ${msg}`));
        process.exit(1);
      }
    });

  // ---- mission execute <missionId> ---------------------------------------------
  mission
    .command("execute <missionId>")
    .description("Execute a saved mission")
    .option("-d, --dir <path>", "Working directory", ".")
    .action(async (missionId: string, opts) => {
      try {
        const orchestrator = await initOrchestrator(opts.dir);
        const m = await orchestrator.getMission(missionId) ?? await orchestrator.getMissionByName(missionId);

        if (!m) {
          console.error(chalk.red(`Mission not found: ${missionId}`));
          process.exit(1);
        }

        const result = await orchestrator.executeMission(m.id);
        console.log(
          chalk.green(`  Mission "${m.name}" executed — ${result.tasks.length} task(s), group: ${result.group}`),
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`Error: ${msg}`));
        process.exit(1);
      }
    });

  // ---- mission resume <missionId> ----------------------------------------------
  mission
    .command("resume <missionId>")
    .description("Resume a mission (retry failed tasks)")
    .option("-d, --dir <path>", "Working directory", ".")
    .option("--no-retry-failed", "Do not retry failed tasks")
    .action(async (missionId: string, opts) => {
      try {
        const orchestrator = await initOrchestrator(opts.dir);
        const m = await orchestrator.getMission(missionId) ?? await orchestrator.getMissionByName(missionId);

        if (!m) {
          console.error(chalk.red(`Mission not found: ${missionId}`));
          process.exit(1);
        }

        const retryFailed = opts.retryFailed !== false;
        const result = await orchestrator.resumeMission(m.id, { retryFailed });
        console.log(
          chalk.green(`  Mission "${m.name}" resumed — ${result.retried} retried, ${result.pending} pending`),
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`Error: ${msg}`));
        process.exit(1);
      }
    });

  // ---- mission delete <missionId> ----------------------------------------------
  mission
    .command("delete <missionId>")
    .description("Delete a mission")
    .option("-d, --dir <path>", "Working directory", ".")
    .action(async (missionId: string, opts) => {
      try {
        const orchestrator = await initOrchestrator(opts.dir);
        const m = await orchestrator.getMission(missionId) ?? await orchestrator.getMissionByName(missionId);

        if (!m) {
          console.error(chalk.red(`Mission not found: ${missionId}`));
          process.exit(1);
        }

        await orchestrator.deleteMission(m.id);
        console.log(chalk.green(`  Mission "${m.name}" deleted.`));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`Error: ${msg}`));
        process.exit(1);
      }
    });

  // ---- mission abort <group> ------------------------------------------------
  mission
    .command("abort <group>")
    .description("Abort all tasks in a mission group")
    .option("-d, --dir <path>", "Working directory", ".")
    .action(async (group: string, opts) => {
      try {
        const orchestrator = await initOrchestrator(opts.dir);
        const count = await orchestrator.abortGroup(group);
        console.log(chalk.green(`  Aborted ${count} task(s) in group "${group}".`));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`Error: ${msg}`));
        process.exit(1);
      }
    });
}
