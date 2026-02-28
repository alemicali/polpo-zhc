import { Command } from "commander";
import chalk from "chalk";
import { resolve, join } from "node:path";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import type { AgentConfig, PolpoConfig } from "../../core/types.js";

/** Resolve .polpo/polpo.json path from a working directory. */
function resolvePolpoJson(workDir: string): string {
  return join(resolve(workDir), ".polpo", "polpo.json");
}

/** Read .polpo/polpo.json. */
function readPolpoConfig(workDir: string): PolpoConfig {
  const filePath = resolvePolpoJson(workDir);
  if (!existsSync(filePath)) {
    throw new Error(`.polpo/polpo.json not found. Run 'polpo init' first.`);
  }
  return JSON.parse(readFileSync(filePath, "utf-8")) as PolpoConfig;
}

/** Write .polpo/polpo.json. */
function writePolpoConfig(workDir: string, config: PolpoConfig): void {
  const filePath = resolvePolpoJson(workDir);
  const dir = resolve(workDir, ".polpo");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(filePath, JSON.stringify(config, null, 2), "utf-8");
}

export function registerTeamCommands(program: Command): void {
  const team = program
    .command("team")
    .description("Manage the agent team");

  // polpo team list
  team
    .command("list")
    .description("List all agents in the team")
    .option("-d, --dir <path>", "Working directory", ".")
    .action(async (opts) => {
      try {
        const config = readPolpoConfig(opts.dir);
        const teamName = config.teams?.[0]?.name ?? "default";
        const agents = config.teams?.[0]?.agents ?? [];

        console.log(chalk.bold(`Team: ${teamName}`) + chalk.dim(` (${agents.length} agent${agents.length !== 1 ? "s" : ""})`));
        console.log();

        if (agents.length === 0) {
          console.log(chalk.dim("  No agents configured."));
          return;
        }

        for (const agent of agents) {
          console.log(`  ${chalk.cyan(agent.name)}`);
          if (agent.model) console.log(chalk.dim(`    model:      ${agent.model}`));
          if (agent.role) console.log(chalk.dim(`    role:       ${agent.role}`));
          if (agent.reportsTo) console.log(chalk.dim(`    reportsTo:  ${agent.reportsTo}`));
          if (agent.createdAt) console.log(chalk.dim(`    createdAt:  ${agent.createdAt}`));
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`Error: ${message}`));
        process.exit(1);
      }
    });

  // polpo team add <name>
  team
    .command("add <name>")
    .description("Add an agent to the team")
    .option("-d, --dir <path>", "Working directory", ".")
    .option("-m, --model <model>", "Model ID")
    .option("-r, --role <role>", "Agent role description")
    .option("--reports-to <agent>", "Agent this one reports to (org chart hierarchy)")
    .action(async (name: string, opts) => {
      try {
        const agent: AgentConfig = {
          name,
        };
        if (opts.model) agent.model = opts.model;
        if (opts.role) agent.role = opts.role;
        if (opts.reportsTo) agent.reportsTo = opts.reportsTo;
        agent.createdAt = new Date().toISOString();

        const config = readPolpoConfig(opts.dir);
        if (!config.teams || config.teams.length === 0) {
          config.teams = [{ name: "default", agents: [] }];
        }
        if (config.teams[0].agents.find(a => a.name === name)) {
          throw new Error(`Agent "${name}" already exists`);
        }
        config.teams[0].agents.push(agent);
        writePolpoConfig(opts.dir, config);

        console.log(chalk.green(`Added agent "${name}"`));
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`Error: ${message}`));
        process.exit(1);
      }
    });

  // polpo team remove <name>
  team
    .command("remove <name>")
    .description("Remove an agent from the team")
    .option("-d, --dir <path>", "Working directory", ".")
    .action(async (name: string, opts) => {
      try {
        const config = readPolpoConfig(opts.dir);
        if (!config.teams?.[0]?.agents) throw new Error("No team in config");
        const idx = config.teams[0].agents.findIndex(a => a.name === name);
        if (idx === -1) throw new Error(`Agent "${name}" not found`);
        config.teams[0].agents.splice(idx, 1);
        writePolpoConfig(opts.dir, config);

        console.log(chalk.green(`Removed agent "${name}"`));
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`Error: ${message}`));
        process.exit(1);
      }
    });

  // polpo team rename <newName>
  team
    .command("rename <newName>")
    .description("Rename the team")
    .option("-d, --dir <path>", "Working directory", ".")
    .action(async (newName: string, opts) => {
      try {
        const config = readPolpoConfig(opts.dir);
        if (!config.teams || config.teams.length === 0) {
          config.teams = [{ name: newName, agents: [] }];
        } else {
          config.teams[0].name = newName;
        }
        writePolpoConfig(opts.dir, config);

        console.log(chalk.green(`Team renamed to "${newName}"`));
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`Error: ${message}`));
        process.exit(1);
      }
    });
}
