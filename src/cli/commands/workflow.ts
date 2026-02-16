/**
 * CLI workflow subcommands — list, show, run, validate.
 */

import { Command } from "commander";
import chalk from "chalk";
import { resolve } from "node:path";
import { Orchestrator } from "../../core/orchestrator.js";
import { discoverWorkflows, loadWorkflow, validateParams, instantiateWorkflow } from "../../core/workflow.js";
import "../../adapters/claude-sdk.js";

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

export function registerWorkflowCommands(program: Command): void {
  const wf = program
    .command("workflow")
    .description("Manage reusable workflow templates");

  // ---- workflow list ------------------------------------------------------
  wf
    .command("list")
    .description("List available workflows")
    .option("-d, --dir <path>", "Working directory", ".")
    .action((opts) => {
      try {
        const cwd = resolve(opts.dir);
        const workflows = discoverWorkflows(cwd, getPolpoDir(opts.dir));

        if (workflows.length === 0) {
          console.log(chalk.dim("  No workflows found."));
          console.log(chalk.dim("  Create workflows in .polpo/workflows/<name>/workflow.json"));
          return;
        }

        for (const w of workflows) {
          const paramList = w.parameters.length > 0
            ? chalk.dim(` (${w.parameters.map(p => p.required ? p.name : `${p.name}?`).join(", ")})`)
            : "";
          console.log(
            `  ${chalk.bold(w.name)}${paramList}`,
          );
          console.log(
            `    ${chalk.dim(w.description)}`,
          );
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`Error: ${msg}`));
        process.exit(1);
      }
    });

  // ---- workflow show <name> -----------------------------------------------
  wf
    .command("show <name>")
    .description("Show workflow details and parameters")
    .option("-d, --dir <path>", "Working directory", ".")
    .action((name: string, opts) => {
      try {
        const cwd = resolve(opts.dir);
        const workflow = loadWorkflow(cwd, getPolpoDir(opts.dir), name);

        if (!workflow) {
          console.error(chalk.red(`Workflow not found: ${name}`));
          process.exit(1);
        }

        console.log(chalk.bold(`  Name:        `) + workflow.name);
        console.log(chalk.bold(`  Description: `) + workflow.description);

        if (workflow.parameters && workflow.parameters.length > 0) {
          console.log();
          console.log(chalk.bold(`  Parameters:`));
          for (const p of workflow.parameters) {
            const req = p.required ? chalk.red("*") : " ";
            const type = chalk.dim(`(${p.type ?? "string"})`);
            const def = p.default !== undefined ? chalk.dim(` default: ${p.default}`) : "";
            const enumStr = p.enum ? chalk.dim(` [${p.enum.join("|")}]`) : "";
            console.log(`    ${req} ${chalk.cyan(p.name)} ${type}${def}${enumStr}`);
            console.log(`      ${chalk.dim(p.description)}`);
          }
        }

        console.log();
        console.log(chalk.dim("  --- Plan Template ---"));
        console.log();
        console.log(JSON.stringify(workflow.plan, null, 2));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`Error: ${msg}`));
        process.exit(1);
      }
    });

  // ---- workflow run <name> [--param key=value ...] -------------------------
  wf
    .command("run <name>")
    .description("Execute a workflow with parameters")
    .option("-d, --dir <path>", "Working directory", ".")
    .option("-p, --param <params...>", "Parameters as key=value pairs")
    .option("--dry-run", "Show the instantiated plan without executing")
    .action(async (name: string, opts) => {
      try {
        const cwd = resolve(opts.dir);
        const polpoDir = getPolpoDir(opts.dir);
        const workflow = loadWorkflow(cwd, polpoDir, name);

        if (!workflow) {
          console.error(chalk.red(`Workflow not found: ${name}`));
          const available = discoverWorkflows(cwd, polpoDir);
          if (available.length > 0) {
            console.log(chalk.dim(`\n  Available workflows: ${available.map(w => w.name).join(", ")}`));
          }
          process.exit(1);
        }

        // Parse parameters
        const rawParams = parseParamFlags(opts.param ?? []);

        // Validate
        const validation = validateParams(workflow, rawParams);
        if (!validation.valid) {
          console.error(chalk.red("  Parameter errors:"));
          for (const err of validation.errors) {
            console.error(chalk.red(`    - ${err}`));
          }
          process.exit(1);
        }

        // Instantiate
        const instance = instantiateWorkflow(workflow, validation.resolved);

        if (opts.dryRun) {
          console.log(chalk.dim("  --- Dry Run: Instantiated Plan ---"));
          console.log();
          console.log(JSON.stringify(JSON.parse(instance.data), null, 2));
          return;
        }

        // Init orchestrator, save & execute
        const orchestrator = await initOrchestrator(opts.dir);

        const plan = orchestrator.savePlan({
          data: instance.data,
          prompt: instance.prompt,
          name: instance.name,
        });

        const result = orchestrator.executePlan(plan.id);
        console.log(
          chalk.green(`  Workflow "${workflow.name}" executed — ${result.tasks.length} task(s), group: ${result.group}`),
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`Error: ${msg}`));
        process.exit(1);
      }
    });

  // ---- workflow validate <name> -------------------------------------------
  wf
    .command("validate <name>")
    .description("Validate a workflow definition")
    .option("-d, --dir <path>", "Working directory", ".")
    .action((name: string, opts) => {
      try {
        const cwd = resolve(opts.dir);
        const workflow = loadWorkflow(cwd, getPolpoDir(opts.dir), name);

        if (!workflow) {
          console.error(chalk.red(`Workflow not found: ${name}`));
          process.exit(1);
        }

        const errors: string[] = [];

        // Check required fields
        if (!workflow.name) errors.push("Missing field: name");
        if (!workflow.description) errors.push("Missing field: description");
        if (!workflow.plan) errors.push("Missing field: plan");

        // Check plan has tasks
        const plan = workflow.plan as { tasks?: unknown[] };
        if (!plan.tasks || !Array.isArray(plan.tasks) || plan.tasks.length === 0) {
          errors.push("Plan must have at least one task");
        }

        // Check all placeholders have matching parameters
        const json = JSON.stringify(workflow.plan);
        const placeholders = json.match(/\{\{([^}]+)\}\}/g) ?? [];
        const paramNames = new Set((workflow.parameters ?? []).map(p => p.name));
        const undeclared = [...new Set(placeholders.map(m => m.slice(2, -2)))]
          .filter(name => !paramNames.has(name));
        if (undeclared.length > 0) {
          errors.push(`Undeclared placeholders: ${undeclared.join(", ")}`);
        }

        // Check parameters with no matching placeholder
        for (const p of workflow.parameters ?? []) {
          if (!json.includes(`{{${p.name}}}`)) {
            errors.push(`Parameter "${p.name}" is declared but never used in the plan template`);
          }
        }

        if (errors.length > 0) {
          console.error(chalk.red("  Validation errors:"));
          for (const err of errors) {
            console.error(chalk.red(`    - ${err}`));
          }
          process.exit(1);
        }

        console.log(chalk.green(`  Workflow "${workflow.name}" is valid.`));
        console.log(chalk.dim(`    ${(workflow.parameters ?? []).length} parameter(s)`));
        console.log(chalk.dim(`    ${(plan.tasks as unknown[]).length} task(s)`));
        const teamSize = (workflow.plan as { team?: unknown[] }).team?.length ?? 0;
        if (teamSize > 0) console.log(chalk.dim(`    ${teamSize} volatile agent(s)`));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`Error: ${msg}`));
        process.exit(1);
      }
    });
}
