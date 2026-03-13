/**
 * CLI playbook subcommands — list, show, run, validate.
 */

import { Command } from "commander";
import chalk from "chalk";
import { resolve } from "node:path";
import { getPolpoDir } from "../../core/constants.js";
import { Orchestrator } from "../../core/orchestrator.js";
import { validateParams, instantiatePlaybook, validatePlaybookDefinition } from "../../core/playbook.js";
import { FilePlaybookStore } from "../../stores/file-playbook-store.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function initOrchestrator(configPath: string): Promise<Orchestrator> {
  const o = new Orchestrator(resolve(configPath));
  await o.init();
  return o;
}

/**
 * Parse --param key=value flags into a Record.
 * Accepts repeated --param flags or comma-separated values.
 */
function parseParamFlags(raw: string[]): Record<string, string> {
  const params: Record<string, string> = {};
  for (const item of raw) {
    const eq = item.indexOf("=");
    if (eq === -1) {
      // Could be a boolean flag: --param verbose → verbose=true
      params[item] = "true";
    } else {
      params[item.slice(0, eq)] = item.slice(eq + 1);
    }
  }
  return params;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerPlaybookCommands(program: Command): void {
  const pb = program
    .command("playbook")
    .description("Manage reusable mission playbooks");

  // Also register "template" as a hidden alias for backward compat
  const tplAlias = program
    .command("template", { hidden: true })
    .description("(deprecated) Alias for 'playbook'");

  for (const cmd of [pb, tplAlias]) {
    // ---- playbook list ------------------------------------------------------
    cmd
      .command("list")
      .description("List available playbooks")
      .option("-d, --dir <path>", "Working directory", ".")
      .action(async (opts) => {
        try {
          const cwd = resolve(opts.dir);
          const store = new FilePlaybookStore(cwd, getPolpoDir(opts.dir));
          const playbooks = await store.list();

          if (playbooks.length === 0) {
            console.log(chalk.dim("  No playbooks found."));
            console.log(chalk.dim("  Create playbooks in .polpo/playbooks/<name>/playbook.json"));
            return;
          }

          for (const p of playbooks) {
            const paramList = p.parameters.length > 0
              ? chalk.dim(` (${p.parameters.map(pr => pr.required ? pr.name : `${pr.name}?`).join(", ")})`)
              : "";
            console.log(
              `  ${chalk.bold(p.name)}${paramList}`,
            );
            console.log(
              `    ${chalk.dim(p.description)}`,
            );
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(chalk.red(`Error: ${msg}`));
          process.exit(1);
        }
      });

    // ---- playbook show <name> -----------------------------------------------
    cmd
      .command("show <name>")
      .description("Show playbook details and parameters")
      .option("-d, --dir <path>", "Working directory", ".")
      .action(async (name: string, opts) => {
        try {
          const cwd = resolve(opts.dir);
          const store = new FilePlaybookStore(cwd, getPolpoDir(opts.dir));
          const playbook = await store.get(name);

          if (!playbook) {
            console.error(chalk.red(`Playbook not found: ${name}`));
            process.exit(1);
          }

          console.log(chalk.bold(`  Name:        `) + playbook.name);
          console.log(chalk.bold(`  Description: `) + playbook.description);

          if (playbook.parameters && playbook.parameters.length > 0) {
            console.log();
            console.log(chalk.bold(`  Parameters:`));
            for (const p of playbook.parameters) {
              const req = p.required ? chalk.red("*") : " ";
              const type = chalk.dim(`(${p.type ?? "string"})`);
              const def = p.default !== undefined ? chalk.dim(` default: ${p.default}`) : "";
              const enumStr = p.enum ? chalk.dim(` [${p.enum.join("|")}]`) : "";
              console.log(`    ${req} ${chalk.cyan(p.name)} ${type}${def}${enumStr}`);
              console.log(`      ${chalk.dim(p.description)}`);
            }
          }

          console.log();
          console.log(chalk.dim("  --- Mission Playbook ---"));
          console.log();
          console.log(JSON.stringify(playbook.mission, null, 2));
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(chalk.red(`Error: ${msg}`));
          process.exit(1);
        }
      });

    // ---- playbook run <name> [--param key=value ...] -------------------------
    cmd
      .command("run <name>")
      .description("Execute a playbook with parameters")
      .option("-d, --dir <path>", "Working directory", ".")
      .option("-p, --param <params...>", "Parameters as key=value pairs")
      .option("--dry-run", "Show the instantiated mission without executing")
      .action(async (name: string, opts) => {
        try {
          const cwd = resolve(opts.dir);
          const polpoDir = getPolpoDir(opts.dir);
          const store = new FilePlaybookStore(cwd, polpoDir);
          const playbook = await store.get(name);

          if (!playbook) {
            console.error(chalk.red(`Playbook not found: ${name}`));
            const available = await store.list();
            if (available.length > 0) {
              console.log(chalk.dim(`\n  Available playbooks: ${available.map(p => p.name).join(", ")}`));
            }
            process.exit(1);
          }

          // Parse parameters
          const rawParams = parseParamFlags(opts.param ?? []);

          // Validate
          const validation = validateParams(playbook, rawParams);
          if (!validation.valid) {
            console.error(chalk.red("  Parameter errors:"));
            for (const err of validation.errors) {
              console.error(chalk.red(`    - ${err}`));
            }
            process.exit(1);
          }
          if (validation.warnings.length > 0) {
            for (const w of validation.warnings) {
              console.warn(chalk.yellow(`    ⚠ ${w}`));
            }
          }

          // Instantiate
          const instance = instantiatePlaybook(playbook, validation.resolved);

          if (opts.dryRun) {
            console.log(chalk.dim("  --- Dry Run: Instantiated Mission ---"));
            console.log();
            console.log(JSON.stringify(JSON.parse(instance.data), null, 2));
            return;
          }

          // Init orchestrator, save & execute
          const orchestrator = await initOrchestrator(opts.dir);

          const mission = await orchestrator.saveMission({
            data: instance.data,
            prompt: instance.prompt,
            name: instance.name,
          });

          const result = await orchestrator.executeMission(mission.id);
          console.log(
            chalk.green(`  Playbook "${playbook.name}" executed — ${result.tasks.length} task(s), group: ${result.group}`),
          );
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(chalk.red(`Error: ${msg}`));
          process.exit(1);
        }
      });

    // ---- playbook validate <name> -------------------------------------------
    cmd
      .command("validate <name>")
      .description("Validate a playbook definition")
      .option("-d, --dir <path>", "Working directory", ".")
      .action(async (name: string, opts) => {
        try {
          const cwd = resolve(opts.dir);
          const store = new FilePlaybookStore(cwd, getPolpoDir(opts.dir));
          const playbook = await store.get(name);

          if (!playbook) {
            console.error(chalk.red(`Playbook not found: ${name}`));
            process.exit(1);
          }

          const errors = validatePlaybookDefinition(playbook);

          if (errors.length > 0) {
            console.error(chalk.red("  Validation errors:"));
            for (const err of errors) {
              console.error(chalk.red(`    - ${err}`));
            }
            process.exit(1);
          }

          const mission = playbook.mission as { tasks?: unknown[]; team?: unknown[] };
          const taskCount = Array.isArray(mission.tasks) ? mission.tasks.length : 0;
          const teamSize = Array.isArray(mission.team) ? mission.team.length : 0;

          console.log(chalk.green(`  Playbook "${playbook.name}" is valid.`));
          console.log(chalk.dim(`    ${(playbook.parameters ?? []).length} parameter(s)`));
          console.log(chalk.dim(`    ${taskCount} task(s)`));
          if (teamSize > 0) console.log(chalk.dim(`    ${teamSize} volatile agent(s)`));
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(chalk.red(`Error: ${msg}`));
          process.exit(1);
        }
      });
  }
}
