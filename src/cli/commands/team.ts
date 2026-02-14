import { Command } from "commander";
import chalk from "chalk";
import { resolve } from "node:path";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { AgentConfig, AdapterType } from "../../core/types.js";

/** Resolve the polpo.yml path from a config dir. */
function resolveConfigFile(configPath: string): string {
  const dir = resolve(configPath);
  const candidate = resolve(dir, "polpo.yml");
  if (existsSync(candidate)) return candidate;
  // fallback: polpo.yaml
  const alt = resolve(dir, "polpo.yaml");
  if (existsSync(alt)) return alt;
  return candidate; // will fail on read — that's fine
}

/** Read, parse, mutate, write back polpo.yml. */
function updateConfigFile(
  configPath: string,
  mutate: (doc: Record<string, unknown>) => void,
): void {
  const filePath = resolveConfigFile(configPath);
  const raw = readFileSync(filePath, "utf-8");
  const doc = parseYaml(raw) as Record<string, unknown>;
  mutate(doc);
  writeFileSync(filePath, stringifyYaml(doc, { lineWidth: 120 }), "utf-8");
}

/** Serialize an AgentConfig to a plain object for YAML (omit undefined fields). */
function agentToYaml(agent: AgentConfig): Record<string, unknown> {
  const obj: Record<string, unknown> = {
    name: agent.name,
    adapter: agent.adapter,
  };
  if (agent.model) obj.model = agent.model;
  if (agent.role) obj.role = agent.role;
  if (agent.command) obj.command = agent.command;
  if (agent.systemPrompt) obj.systemPrompt = agent.systemPrompt;
  if (agent.maxTurns) obj.maxTurns = agent.maxTurns;
  if (agent.skills?.length) obj.skills = agent.skills;
  return obj;
}

export function registerTeamCommands(program: Command): void {
  const team = program
    .command("team")
    .description("Manage the agent team");

  // polpo team list
  team
    .command("list")
    .description("List all agents in the team")
    .option("-c, --config <path>", "Path to working directory", ".")
    .action(async (opts) => {
      try {
        const filePath = resolveConfigFile(opts.config);
        const raw = readFileSync(filePath, "utf-8");
        const doc = parseYaml(raw) as Record<string, unknown>;
        const teamSection = doc.team as Record<string, unknown> | undefined;
        const teamName = (teamSection?.name as string) ?? "default";
        const agents = (teamSection?.agents ?? []) as Record<string, unknown>[];

        console.log(chalk.bold(`Team: ${teamName}`) + chalk.dim(` (${agents.length} agent${agents.length !== 1 ? "s" : ""})`));
        console.log();

        if (agents.length === 0) {
          console.log(chalk.dim("  No agents configured."));
          return;
        }

        for (const agent of agents) {
          console.log(`  ${chalk.cyan(agent.name as string)}`);
          console.log(chalk.dim(`    adapter: ${agent.adapter as string}`));
          if (agent.model) console.log(chalk.dim(`    model:   ${agent.model as string}`));
          if (agent.role) console.log(chalk.dim(`    role:    ${agent.role as string}`));
          if (agent.command) console.log(chalk.dim(`    command: ${agent.command as string}`));
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
    .option("-c, --config <path>", "Path to working directory", ".")
    .option("-A, --adapter <type>", "Adapter type", "pi")
    .option("-m, --model <model>", "Model ID")
    .option("-r, --role <role>", "Agent role description")
    .action(async (name: string, opts) => {
      try {
        const agent: AgentConfig = {
          name,
          adapter: opts.adapter as AdapterType,
        };
        if (opts.model) agent.model = opts.model;
        if (opts.role) agent.role = opts.role;

        updateConfigFile(opts.config, (doc) => {
          const teamSection = doc.team as Record<string, unknown> | undefined;
          if (!teamSection) {
            doc.team = { name: "default", agents: [agentToYaml(agent)] };
            return;
          }
          const agents = (teamSection.agents ?? []) as Record<string, unknown>[];
          if (agents.find((a) => a.name === name)) {
            throw new Error(`Agent "${name}" already exists`);
          }
          agents.push(agentToYaml(agent));
          teamSection.agents = agents;
        });

        console.log(chalk.green(`Added agent "${name}" (adapter: ${agent.adapter})`));
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
    .option("-c, --config <path>", "Path to working directory", ".")
    .action(async (name: string, opts) => {
      try {
        updateConfigFile(opts.config, (doc) => {
          const teamSection = doc.team as Record<string, unknown> | undefined;
          if (!teamSection) throw new Error("No team section in config");
          const agents = (teamSection.agents ?? []) as Record<string, unknown>[];
          const idx = agents.findIndex((a) => a.name === name);
          if (idx === -1) throw new Error(`Agent "${name}" not found`);
          agents.splice(idx, 1);
          teamSection.agents = agents;
        });

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
    .option("-c, --config <path>", "Path to working directory", ".")
    .action(async (newName: string, opts) => {
      try {
        updateConfigFile(opts.config, (doc) => {
          const teamSection = doc.team as Record<string, unknown> | undefined;
          if (!teamSection) {
            doc.team = { name: newName, agents: [] };
            return;
          }
          teamSection.name = newName;
        });

        console.log(chalk.green(`Team renamed to "${newName}"`));
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`Error: ${message}`));
        process.exit(1);
      }
    });
}
