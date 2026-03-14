import { Command } from "commander";
import chalk from "chalk";
import { resolve } from "node:path";
import { getPolpoDir } from "../../core/constants.js";
import type { AgentConfig } from "../../core/types.js";
import { createCliTeamAndAgentStores } from "../stores.js";

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
        const polpoDir = getPolpoDir(resolve(opts.dir));
        const { teamStore, agentStore } = await createCliTeamAndAgentStores(polpoDir);

        const teams = await teamStore.getTeams();
        const teamName = teams[0]?.name ?? "default";
        const agents = await agentStore.getAgents(teamName);

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
        const polpoDir = getPolpoDir(resolve(opts.dir));
        const { teamStore, agentStore } = await createCliTeamAndAgentStores(polpoDir);

        // Ensure default team exists
        const teams = await teamStore.getTeams();
        let teamName: string;
        if (teams.length === 0) {
          await teamStore.createTeam({ name: "default", agents: [] });
          teamName = "default";
        } else {
          teamName = teams[0].name;
        }

        const agent: AgentConfig = { name };
        if (opts.model) agent.model = opts.model;
        if (opts.role) agent.role = opts.role;
        if (opts.reportsTo) agent.reportsTo = opts.reportsTo;
        agent.createdAt = new Date().toISOString();

        await agentStore.createAgent(agent, teamName);
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
        const polpoDir = getPolpoDir(resolve(opts.dir));
        const { agentStore } = await createCliTeamAndAgentStores(polpoDir);

        const deleted = await agentStore.deleteAgent(name);
        if (!deleted) throw new Error(`Agent "${name}" not found`);

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
        const polpoDir = getPolpoDir(resolve(opts.dir));
        const { teamStore } = await createCliTeamAndAgentStores(polpoDir);

        const teams = await teamStore.getTeams();
        if (teams.length === 0) {
          await teamStore.createTeam({ name: newName, agents: [] });
        } else {
          await teamStore.renameTeam(teams[0].name, newName);
        }

        console.log(chalk.green(`Team renamed to "${newName}"`));
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`Error: ${message}`));
        process.exit(1);
      }
    });
}
