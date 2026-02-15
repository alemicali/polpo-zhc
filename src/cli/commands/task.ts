/**
 * CLI task subcommands — manage tasks from the command line.
 *
 *   polpo task list       — list all tasks
 *   polpo task show <id>  — show task details
 *   polpo task add <desc> — create a new task
 *   polpo task retry <id> — retry a failed task
 *   polpo task kill <id>  — kill a running task
 *   polpo task reassess   — re-run assessment
 *   polpo task delete <id>— remove a task
 */

import { Command } from "commander";
import chalk from "chalk";
import { resolve } from "node:path";
import { Orchestrator } from "../../core/orchestrator.js";
import type { Task, TaskStatus, TaskExpectation } from "../../core/types.js";

// Register external adapters (side-effect imports)
import "../../adapters/claude-sdk.js";

// ── Helpers ──

function findTask(tasks: Task[], idPrefix: string): Task | undefined {
  return tasks.find(t => t.id === idPrefix) ?? tasks.find(t => t.id.startsWith(idPrefix));
}

async function initOrchestrator(configPath: string): Promise<Orchestrator> {
  const o = new Orchestrator(resolve(configPath));
  await o.init();
  return o;
}

function statusIcon(status: TaskStatus): string {
  switch (status) {
    case "pending":            return chalk.gray("\u25CB");   // ○
    case "awaiting_approval":  return chalk.yellow("\u23F3"); // ⏳
    case "assigned":           return chalk.cyan("\u25CE");    // ◎
    case "in_progress":        return chalk.yellow("\u25D4");  // ◔
    case "review":             return chalk.magenta("\u25D4"); // ◔
    case "done":               return chalk.green("\u25CF");   // ●
    case "failed":             return chalk.red("\u2717");     // ✗
    default:                   return chalk.gray("?");
  }
}

function formatDuration(ms: number): string {
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const s = sec % 60;
  if (min < 60) return `${min}m${s}s`;
  const hr = Math.floor(min / 60);
  const m = min % 60;
  return `${hr}h${m}m`;
}

// ── Command registration ──

export function registerTaskCommands(program: Command): void {
  const task = program
    .command("task")
    .description("Manage tasks");

  // ── task list ──

  task
    .command("list")
    .description("List all tasks")
    .option("-d, --dir <path>", "Working directory", ".")
    .option("--status <status>", "Filter by status")
    .option("--group <group>", "Filter by group")
    .action(async (opts) => {
      try {
        const orchestrator = await initOrchestrator(opts.dir);
        let tasks = orchestrator.getStore().getAllTasks();

        if (opts.status) {
          tasks = tasks.filter(t => t.status === opts.status);
        }
        if (opts.group) {
          tasks = tasks.filter(t => t.group === opts.group);
        }

        if (tasks.length === 0) {
          console.log(chalk.dim("  No tasks found."));
          return;
        }

        for (const t of tasks) {
          const icon = statusIcon(t.status);
          const title = chalk.bold(t.title);
          const agent = chalk.dim(`[${t.assignTo}]`);
          const group = t.group ? chalk.cyan(` (${t.group})`) : "";
          const retries = t.retries > 0 ? chalk.yellow(` retry ${t.retries}/${t.maxRetries}`) : "";
          console.log(`  ${icon} ${title} ${agent}${group}${retries}`);
        }

        // Summary counts
        const counts: Record<string, number> = {};
        for (const t of tasks) counts[t.status] = (counts[t.status] || 0) + 1;
        const parts = Object.entries(counts)
          .map(([s, n]) => `${s}: ${n}`)
          .join(", ");
        console.log(chalk.dim(`\n  Total: ${tasks.length} (${parts})`));
      } catch (err: unknown) {
        console.error(chalk.red(`Error: ${err instanceof Error ? err.message : String(err)}`));
        process.exit(1);
      }
    });

  // ── task show ──

  task
    .command("show <taskId>")
    .description("Show task details")
    .option("-d, --dir <path>", "Working directory", ".")
    .action(async (taskId: string, opts) => {
      try {
        const orchestrator = await initOrchestrator(opts.dir);
        const tasks = orchestrator.getStore().getAllTasks();
        const t = findTask(tasks, taskId);

        if (!t) {
          console.error(chalk.red(`Task not found: ${taskId}`));
          process.exit(1);
        }

        console.log();
        console.log(`  ${chalk.bold("Title:")}       ${t.title}`);
        console.log(`  ${chalk.bold("ID:")}          ${t.id}`);
        console.log(`  ${chalk.bold("Status:")}      ${statusIcon(t.status)} ${t.status}`);
        console.log(`  ${chalk.bold("Agent:")}       ${t.assignTo}`);
        if (t.group) {
          console.log(`  ${chalk.bold("Group:")}       ${t.group}`);
        }
        if (t.dependsOn.length > 0) {
          console.log(`  ${chalk.bold("Depends on:")}  ${t.dependsOn.join(", ")}`);
        }
        console.log(`  ${chalk.bold("Retries:")}     ${t.retries}/${t.maxRetries}`);

        if (t.description && t.description !== t.title) {
          console.log();
          console.log(`  ${chalk.bold("Description:")}`);
          for (const line of t.description.split("\n")) {
            console.log(`    ${chalk.dim(line)}`);
          }
        }

        if (t.result) {
          console.log();
          console.log(`  ${chalk.bold("Result:")}`);
          console.log(`    Duration:  ${formatDuration(t.result.duration)}`);
          console.log(`    Exit code: ${t.result.exitCode === 0 ? chalk.green(String(t.result.exitCode)) : chalk.red(String(t.result.exitCode))}`);

          if (t.result.stdout) {
            console.log();
            console.log(`  ${chalk.bold("Stdout")} ${chalk.dim("(first 2000 chars)")}:`);
            console.log(chalk.dim(t.result.stdout.slice(0, 2000)));
          }

          if (t.result.stderr) {
            console.log();
            console.log(`  ${chalk.bold("Stderr")} ${chalk.dim("(first 1000 chars)")}:`);
            console.log(chalk.red(t.result.stderr.slice(0, 1000)));
          }

          if (t.result.assessment) {
            const a = t.result.assessment;
            console.log();
            console.log(`  ${chalk.bold("Assessment:")}`);
            console.log(`    Passed:       ${a.passed ? chalk.green("YES") : chalk.red("NO")}`);

            if (a.globalScore !== undefined) {
              const scoreColor = a.globalScore >= 4 ? chalk.green : a.globalScore >= 3 ? chalk.yellow : chalk.red;
              console.log(`    Global score: ${scoreColor(`${a.globalScore.toFixed(1)}/5`)}`);
            }

            if (a.checks.length > 0) {
              console.log();
              console.log(`    ${chalk.bold("Checks:")}`);
              for (const c of a.checks) {
                const icon = c.passed ? chalk.green("\u2713") : chalk.red("\u2717");
                console.log(`      ${icon} [${c.type}] ${c.message}`);
              }
            }

            if (a.scores && a.scores.length > 0) {
              console.log();
              console.log(`    ${chalk.bold("Dimension scores:")}`);
              for (const s of a.scores) {
                const stars = "\u2605".repeat(Math.round(s.score)) + "\u2606".repeat(5 - Math.round(s.score));
                const color = s.score >= 4 ? chalk.green : s.score >= 3 ? chalk.yellow : chalk.red;
                console.log(`      ${color(stars)} ${s.dimension} (${s.score.toFixed(1)}, weight: ${s.weight})`);
              }
            }
          }
        }

        console.log();
      } catch (err: unknown) {
        console.error(chalk.red(`Error: ${err instanceof Error ? err.message : String(err)}`));
        process.exit(1);
      }
    });

  // ── task add ──

  task
    .command("add <description...>")
    .description("Create a new task")
    .option("-d, --dir <path>", "Working directory", ".")
    .option("-a, --agent <name>", "Assign to specific agent")
    .option("--no-prep", "Skip LLM task-prep, create directly")
    .action(async (descParts: string[], opts) => {
      try {
        const description = descParts.join(" ");
        const orchestrator = await initOrchestrator(opts.dir);
        const agents = orchestrator.getAgents();

        if (agents.length === 0) {
          console.error(chalk.red("No agents configured. Edit .polpo/polpo.json to add agents."));
          process.exit(1);
        }

        // Resolve agent
        let agentName: string;
        if (opts.agent) {
          const found = agents.find(a => a.name === opts.agent);
          if (!found) {
            console.error(chalk.red(`Agent not found: ${opts.agent}`));
            console.error(chalk.dim(`Available agents: ${agents.map(a => a.name).join(", ")}`));
            process.exit(1);
          }
          agentName = found.name;
        } else if (agents.length === 1) {
          agentName = agents[0]!.name;
        } else {
          console.error(chalk.red("Multiple agents available. Specify one with --agent <name>"));
          console.error(chalk.dim(`Available agents: ${agents.map(a => a.name).join(", ")}`));
          process.exit(1);
        }

        // Prep or direct creation
        if (opts.prep === false) {
          // --no-prep: create directly
          const title = description.length > 80 ? description.slice(0, 77) + "..." : description;
          const t = orchestrator.addTask({ title, description, assignTo: agentName });
          console.log(chalk.green(`  + Task created: ${t.title}`));
          console.log(chalk.dim(`    ID: ${t.id}  Agent: ${agentName}`));
          console.log(chalk.dim(`\n  Run ${chalk.white("polpo run")} to execute.`));
        } else {
          // LLM task-prep (default) — tool-based structured output
          try {
            const { buildTaskPrepPrompt } = await import("../../llm/prompts.js");
            const { generateTaskPrep } = await import("../../llm/plan-generator.js");

            const state = (() => {
              try { return orchestrator.getStore()?.getState() ?? null; }
              catch { return null; }
            })();

            console.log(chalk.dim("  Preparing task with AI..."));

            const systemPrompt = buildTaskPrepPrompt(orchestrator, state, orchestrator.getWorkDir(), description, agentName);
            const model = orchestrator.getConfig()?.settings?.orchestratorModel;
            const prepTask = await generateTaskPrep(systemPrompt, description, model);

            // Build expectations from validated data
            const expectations: TaskExpectation[] = [];
            if (prepTask.expectations) {
              for (const e of prepTask.expectations) {
                if (e.type === "test" && e.command) {
                  expectations.push({ type: "test", command: e.command });
                } else if (e.type === "file_exists" && Array.isArray(e.paths) && e.paths.length > 0) {
                  expectations.push({ type: "file_exists", paths: e.paths, confidence: "estimated" });
                } else if (e.type === "script" && e.command) {
                  expectations.push({ type: "script", command: e.command });
                } else if (e.type === "llm_review" && (e.criteria || e.dimensions)) {
                  expectations.push({
                    type: "llm_review",
                    criteria: e.criteria,
                    dimensions: e.dimensions,
                    threshold: e.threshold,
                  });
                }
              }
            }

            const t = orchestrator.addTask({
              title: prepTask.title,
              description: prepTask.description || description,
              assignTo: agentName,
              expectations,
            });

            console.log(chalk.green(`  + Task prepared: ${t.title}`));
            console.log(chalk.dim(`    ID: ${t.id}  Agent: ${agentName}`));
            if (expectations.length > 0) {
              const types = expectations.map(e => e.type).join(", ");
              console.log(chalk.dim(`    Expectations: ${types}`));
            }
            console.log(chalk.dim(`\n  Run ${chalk.white("polpo run")} to execute.`));
          } catch (err: unknown) {
            // Fallback to direct creation on any prep error
            const msg = err instanceof Error ? err.message : String(err);
            console.log(chalk.yellow(`  Task prep failed: ${msg}`));
            console.log(chalk.dim("  Creating task directly..."));
            const title = description.length > 80 ? description.slice(0, 77) + "..." : description;
            const t = orchestrator.addTask({ title, description, assignTo: agentName });
            console.log(chalk.green(`  + Task created: ${t.title}`));
            console.log(chalk.dim(`    ID: ${t.id}  Agent: ${agentName}`));
            console.log(chalk.dim(`\n  Run ${chalk.white("polpo run")} to execute.`));
          }
        }
      } catch (err: unknown) {
        console.error(chalk.red(`Error: ${err instanceof Error ? err.message : String(err)}`));
        process.exit(1);
      }
    });

  // ── task retry ──

  task
    .command("retry <taskId>")
    .description("Retry a failed task")
    .option("-d, --dir <path>", "Working directory", ".")
    .action(async (taskId: string, opts) => {
      try {
        const orchestrator = await initOrchestrator(opts.dir);
        const tasks = orchestrator.getStore().getAllTasks();
        const t = findTask(tasks, taskId);

        if (!t) {
          console.error(chalk.red(`Task not found: ${taskId}`));
          process.exit(1);
        }

        orchestrator.retryTask(t.id);
        console.log(chalk.green(`  Task "${t.title}" queued for retry.`));
      } catch (err: unknown) {
        console.error(chalk.red(`Error: ${err instanceof Error ? err.message : String(err)}`));
        process.exit(1);
      }
    });

  // ── task kill ──

  task
    .command("kill <taskId>")
    .description("Kill a running task")
    .option("-d, --dir <path>", "Working directory", ".")
    .action(async (taskId: string, opts) => {
      try {
        const orchestrator = await initOrchestrator(opts.dir);
        const tasks = orchestrator.getStore().getAllTasks();
        const t = findTask(tasks, taskId);

        if (!t) {
          console.error(chalk.red(`Task not found: ${taskId}`));
          process.exit(1);
        }

        const killed = orchestrator.killTask(t.id);
        if (killed) {
          console.log(chalk.green(`  Task "${t.title}" killed.`));
        } else {
          console.log(chalk.yellow(`  Could not kill task "${t.title}" (not running or no active process).`));
        }
      } catch (err: unknown) {
        console.error(chalk.red(`Error: ${err instanceof Error ? err.message : String(err)}`));
        process.exit(1);
      }
    });

  // ── task reassess ──

  task
    .command("reassess <taskId>")
    .description("Re-run assessment on a completed task")
    .option("-d, --dir <path>", "Working directory", ".")
    .action(async (taskId: string, opts) => {
      try {
        const orchestrator = await initOrchestrator(opts.dir);
        const tasks = orchestrator.getStore().getAllTasks();
        const t = findTask(tasks, taskId);

        if (!t) {
          console.error(chalk.red(`Task not found: ${taskId}`));
          process.exit(1);
        }

        console.log(chalk.dim(`  Re-assessing "${t.title}"...`));
        await orchestrator.reassessTask(t.id);
        console.log(chalk.green(`  Assessment complete for "${t.title}".`));
      } catch (err: unknown) {
        console.error(chalk.red(`Error: ${err instanceof Error ? err.message : String(err)}`));
        process.exit(1);
      }
    });

  // ── task delete ──

  task
    .command("delete <taskId>")
    .description("Delete a task")
    .option("-d, --dir <path>", "Working directory", ".")
    .action(async (taskId: string, opts) => {
      try {
        const orchestrator = await initOrchestrator(opts.dir);
        const tasks = orchestrator.getStore().getAllTasks();
        const t = findTask(tasks, taskId);

        if (!t) {
          console.error(chalk.red(`Task not found: ${taskId}`));
          process.exit(1);
        }

        const removed = orchestrator.deleteTask(t.id);
        if (removed) {
          console.log(chalk.green(`  Task "${t.title}" deleted.`));
        } else {
          console.log(chalk.red(`  Failed to delete task "${t.title}".`));
        }
      } catch (err: unknown) {
        console.error(chalk.red(`Error: ${err instanceof Error ? err.message : String(err)}`));
        process.exit(1);
      }
    });
}
