/**
 * CLI template subcommands — list, show, run, validate.
 */

import { Command } from "commander";
import chalk from "chalk";
import { resolve } from "node:path";
import { Orchestrator } from "../../core/orchestrator.js";
import { discoverTemplates, loadTemplate, validateParams, instantiateTemplate } from "../../core/template.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function initOrchestrator(configPath: string): Promise<Orchestrator> {
  const o = new Orchestrator(resolve(configPath));
  await o.init();
  return o;
}

function getPolpoDir(dir: string): string {
  return resolve(dir, ".polpo");
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

export function registerTemplateCommands(program: Command): void {
  const tpl = program
    .command("template")
    .description("Manage reusable mission templates");

  // ---- template list ------------------------------------------------------
  tpl
    .command("list")
    .description("List available templates")
    .option("-d, --dir <path>", "Working directory", ".")
    .action((opts) => {
      try {
        const cwd = resolve(opts.dir);
        const templates = discoverTemplates(cwd, getPolpoDir(opts.dir));

        if (templates.length === 0) {
          console.log(chalk.dim("  No templates found."));
          console.log(chalk.dim("  Create templates in .polpo/templates/<name>/template.json"));
          return;
        }

        for (const t of templates) {
          const paramList = t.parameters.length > 0
            ? chalk.dim(` (${t.parameters.map(p => p.required ? p.name : `${p.name}?`).join(", ")})`)
            : "";
          console.log(
            `  ${chalk.bold(t.name)}${paramList}`,
          );
          console.log(
            `    ${chalk.dim(t.description)}`,
          );
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`Error: ${msg}`));
        process.exit(1);
      }
    });

  // ---- template show <name> -----------------------------------------------
  tpl
    .command("show <name>")
    .description("Show template details and parameters")
    .option("-d, --dir <path>", "Working directory", ".")
    .action((name: string, opts) => {
      try {
        const cwd = resolve(opts.dir);
        const template = loadTemplate(cwd, getPolpoDir(opts.dir), name);

        if (!template) {
          console.error(chalk.red(`Template not found: ${name}`));
          process.exit(1);
        }

        console.log(chalk.bold(`  Name:        `) + template.name);
        console.log(chalk.bold(`  Description: `) + template.description);

        if (template.parameters && template.parameters.length > 0) {
          console.log();
          console.log(chalk.bold(`  Parameters:`));
          for (const p of template.parameters) {
            const req = p.required ? chalk.red("*") : " ";
            const type = chalk.dim(`(${p.type ?? "string"})`);
            const def = p.default !== undefined ? chalk.dim(` default: ${p.default}`) : "";
            const enumStr = p.enum ? chalk.dim(` [${p.enum.join("|")}]`) : "";
            console.log(`    ${req} ${chalk.cyan(p.name)} ${type}${def}${enumStr}`);
            console.log(`      ${chalk.dim(p.description)}`);
          }
        }

        console.log();
        console.log(chalk.dim("  --- Mission Template ---"));
        console.log();
        console.log(JSON.stringify(template.mission, null, 2));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`Error: ${msg}`));
        process.exit(1);
      }
    });

  // ---- template run <name> [--param key=value ...] -------------------------
  tpl
    .command("run <name>")
    .description("Execute a template with parameters")
    .option("-d, --dir <path>", "Working directory", ".")
    .option("-p, --param <params...>", "Parameters as key=value pairs")
    .option("--dry-run", "Show the instantiated mission without executing")
    .action(async (name: string, opts) => {
      try {
        const cwd = resolve(opts.dir);
        const polpoDir = getPolpoDir(opts.dir);
        const template = loadTemplate(cwd, polpoDir, name);

        if (!template) {
          console.error(chalk.red(`Template not found: ${name}`));
          const available = discoverTemplates(cwd, polpoDir);
          if (available.length > 0) {
            console.log(chalk.dim(`\n  Available templates: ${available.map(t => t.name).join(", ")}`));
          }
          process.exit(1);
        }

        // Parse parameters
        const rawParams = parseParamFlags(opts.param ?? []);

        // Validate
        const validation = validateParams(template, rawParams);
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
        const instance = instantiateTemplate(template, validation.resolved);

        if (opts.dryRun) {
          console.log(chalk.dim("  --- Dry Run: Instantiated Mission ---"));
          console.log();
          console.log(JSON.stringify(JSON.parse(instance.data), null, 2));
          return;
        }

        // Init orchestrator, save & execute
        const orchestrator = await initOrchestrator(opts.dir);

        const mission = orchestrator.saveMission({
          data: instance.data,
          prompt: instance.prompt,
          name: instance.name,
        });

        const result = orchestrator.executeMission(mission.id);
        console.log(
          chalk.green(`  Template "${template.name}" executed — ${result.tasks.length} task(s), group: ${result.group}`),
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`Error: ${msg}`));
        process.exit(1);
      }
    });

  // ---- template validate <name> -------------------------------------------
  tpl
    .command("validate <name>")
    .description("Validate a template definition")
    .option("-d, --dir <path>", "Working directory", ".")
    .action((name: string, opts) => {
      try {
        const cwd = resolve(opts.dir);
        const template = loadTemplate(cwd, getPolpoDir(opts.dir), name);

        if (!template) {
          console.error(chalk.red(`Template not found: ${name}`));
          process.exit(1);
        }

        const errors: string[] = [];

        // Check required fields
        if (!template.name) errors.push("Missing field: name");
        if (!template.description) errors.push("Missing field: description");
        if (!template.mission) errors.push("Missing field: mission");

        // Check mission has tasks
        const mission = template.mission as { tasks?: unknown[] };
        if (!mission.tasks || !Array.isArray(mission.tasks) || mission.tasks.length === 0) {
          errors.push("Mission must have at least one task");
        }

        // Check all placeholders have matching parameters
        const json = JSON.stringify(template.mission);
        const placeholders = json.match(/\{\{([^}]+)\}\}/g) ?? [];
        const paramNames = new Set((template.parameters ?? []).map(p => p.name));
        const undeclared = [...new Set(placeholders.map(m => m.slice(2, -2)))]
          .filter(name => !paramNames.has(name));
        if (undeclared.length > 0) {
          errors.push(`Undeclared placeholders: ${undeclared.join(", ")}`);
        }

        // Check parameters with no matching placeholder
        for (const p of template.parameters ?? []) {
          if (!json.includes(`{{${p.name}}}`)) {
            errors.push(`Parameter "${p.name}" is declared but never used in the mission template`);
          }
        }

        if (errors.length > 0) {
          console.error(chalk.red("  Validation errors:"));
          for (const err of errors) {
            console.error(chalk.red(`    - ${err}`));
          }
          process.exit(1);
        }

        console.log(chalk.green(`  Template "${template.name}" is valid.`));
        console.log(chalk.dim(`    ${(template.parameters ?? []).length} parameter(s)`));
        console.log(chalk.dim(`    ${(mission.tasks as unknown[]).length} task(s)`));
        const teamSize = (template.mission as { team?: unknown[] }).team?.length ?? 0;
        if (teamSize > 0) console.log(chalk.dim(`    ${teamSize} volatile agent(s)`));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`Error: ${msg}`));
        process.exit(1);
      }
    });
}
