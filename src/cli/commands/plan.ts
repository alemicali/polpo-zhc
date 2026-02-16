/**
 * CLI plan subcommands — create, list, show, execute, resume, delete, abort.
 */

import { Command } from "commander";
import chalk from "chalk";
import { resolve } from "node:path";
import { Orchestrator } from "../../core/orchestrator.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function initOrchestrator(configPath: string): Promise<Orchestrator> {
  const o = new Orchestrator(resolve(configPath));
  await o.init();
  return o;
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30) || "plan";
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerPlanCommands(program: Command): void {
  const plan = program
    .command("plan")
    .description("Manage execution plans");

  // ---- plan list ---------------------------------------------------------
  plan
    .command("list")
    .description("List all plans")
    .option("-d, --dir <path>", "Working directory", ".")
    .action(async (opts) => {
      try {
        const orchestrator = await initOrchestrator(opts.dir);
        const plans = orchestrator.getAllPlans();

        if (plans.length === 0) {
          console.log(chalk.dim("  No plans found."));
          return;
        }

        for (const p of plans) {
          const prompt = p.prompt
            ? p.prompt.length > 60
              ? p.prompt.slice(0, 57) + "..."
              : p.prompt
            : "";
          const status = p.status === "active"
            ? chalk.yellow(p.status)
            : p.status === "completed"
              ? chalk.green(p.status)
              : p.status === "failed"
                ? chalk.red(p.status)
                : chalk.dim(p.status);
          console.log(
            `  ${chalk.bold(p.name)} [${status}]` +
            (prompt ? chalk.dim(` — ${prompt}`) : ""),
          );
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`Error: ${msg}`));
        process.exit(1);
      }
    });

  // ---- plan show <planId> ------------------------------------------------
  plan
    .command("show <planId>")
    .description("Show details of a plan")
    .option("-d, --dir <path>", "Working directory", ".")
    .action(async (planId: string, opts) => {
      try {
        const orchestrator = await initOrchestrator(opts.dir);
        const p = orchestrator.getPlan(planId) ?? orchestrator.getPlanByName(planId);

        if (!p) {
          console.error(chalk.red(`Plan not found: ${planId}`));
          process.exit(1);
        }

        console.log(chalk.bold(`  Name:      `) + p.name);
        console.log(chalk.bold(`  Status:    `) + p.status);
        if (p.prompt) {
          console.log(chalk.bold(`  Prompt:    `) + p.prompt);
        }
        console.log(chalk.bold(`  Created:   `) + p.createdAt);
        console.log(chalk.bold(`  Updated:   `) + p.updatedAt);
        console.log();
        console.log(chalk.dim("  --- Plan Data ---"));
        console.log();
        try {
          const parsed = JSON.parse(p.data);
          console.log(JSON.stringify(parsed, null, 2));
        } catch {
          console.log(p.data);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`Error: ${msg}`));
        process.exit(1);
      }
    });

  // ---- plan create <prompt...> -------------------------------------------
  plan
    .command("create <prompt...>")
    .description("Generate a new plan from a prompt using the LLM")
    .option("-d, --dir <path>", "Working directory", ".")
    .option("--execute", "Immediately execute the plan after creating")
    .option("--save", "Save as draft (default if --execute not given)")
    .action(async (promptArgs: string[], opts) => {
      try {
        const orchestrator = await initOrchestrator(opts.dir);
        const prompt = promptArgs.join(" ");

        const { buildPlanSystemPrompt } = await import("../../llm/prompts.js");
        const { generatePlan, planDataToJson } = await import("../../llm/plan-generator.js");

        const state = (() => {
          try { return orchestrator.getStore()?.getState() ?? null; }
          catch { return null; }
        })();

        const systemPrompt = buildPlanSystemPrompt(orchestrator, state, orchestrator.getWorkDir());
        const userPrompt = `Generate a task plan for:\n"${prompt}"`;
        const model = orchestrator.getConfig()?.settings?.orchestratorModel;

        console.log(chalk.dim("  Generating plan..."));
        const planData = await generatePlan(systemPrompt, userPrompt, model);
        const json = planDataToJson(planData);

        const planName = slugify(planData.name);
        const plan = orchestrator.savePlan({
          data: json,
          prompt,
          name: planName,
          status: opts.execute ? undefined : "draft",
        });

        if (opts.execute) {
          const result = orchestrator.executePlan(plan.id);
          console.log(
            chalk.green(`  Plan "${plan.name}" created and executed — ${result.tasks.length} task(s), group: ${result.group}`),
          );
        } else {
          console.log(
            chalk.green(`  Plan "${plan.name}" saved as draft.`),
          );
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`Error: ${msg}`));
        process.exit(1);
      }
    });

  // ---- plan execute <planId> ---------------------------------------------
  plan
    .command("execute <planId>")
    .description("Execute a saved plan")
    .option("-d, --dir <path>", "Working directory", ".")
    .action(async (planId: string, opts) => {
      try {
        const orchestrator = await initOrchestrator(opts.dir);
        const p = orchestrator.getPlan(planId) ?? orchestrator.getPlanByName(planId);

        if (!p) {
          console.error(chalk.red(`Plan not found: ${planId}`));
          process.exit(1);
        }

        const result = orchestrator.executePlan(p.id);
        console.log(
          chalk.green(`  Plan "${p.name}" executed — ${result.tasks.length} task(s), group: ${result.group}`),
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`Error: ${msg}`));
        process.exit(1);
      }
    });

  // ---- plan resume <planId> ----------------------------------------------
  plan
    .command("resume <planId>")
    .description("Resume a plan (retry failed tasks)")
    .option("-d, --dir <path>", "Working directory", ".")
    .option("--no-retry-failed", "Do not retry failed tasks")
    .action(async (planId: string, opts) => {
      try {
        const orchestrator = await initOrchestrator(opts.dir);
        const p = orchestrator.getPlan(planId) ?? orchestrator.getPlanByName(planId);

        if (!p) {
          console.error(chalk.red(`Plan not found: ${planId}`));
          process.exit(1);
        }

        const retryFailed = opts.retryFailed !== false;
        const result = orchestrator.resumePlan(p.id, { retryFailed });
        console.log(
          chalk.green(`  Plan "${p.name}" resumed — ${result.retried} retried, ${result.pending} pending`),
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`Error: ${msg}`));
        process.exit(1);
      }
    });

  // ---- plan delete <planId> ----------------------------------------------
  plan
    .command("delete <planId>")
    .description("Delete a plan")
    .option("-d, --dir <path>", "Working directory", ".")
    .action(async (planId: string, opts) => {
      try {
        const orchestrator = await initOrchestrator(opts.dir);
        const p = orchestrator.getPlan(planId) ?? orchestrator.getPlanByName(planId);

        if (!p) {
          console.error(chalk.red(`Plan not found: ${planId}`));
          process.exit(1);
        }

        orchestrator.deletePlan(p.id);
        console.log(chalk.green(`  Plan "${p.name}" deleted.`));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`Error: ${msg}`));
        process.exit(1);
      }
    });

  // ---- plan abort <group> ------------------------------------------------
  plan
    .command("abort <group>")
    .description("Abort all tasks in a plan group")
    .option("-d, --dir <path>", "Working directory", ".")
    .action(async (group: string, opts) => {
      try {
        const orchestrator = await initOrchestrator(opts.dir);
        const count = orchestrator.abortGroup(group);
        console.log(chalk.green(`  Aborted ${count} task(s) in group "${group}".`));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`Error: ${msg}`));
        process.exit(1);
      }
    });
}
