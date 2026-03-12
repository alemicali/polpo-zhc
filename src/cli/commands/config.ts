import { Command } from "commander";
import chalk from "chalk";
import { resolve } from "node:path";
import { Orchestrator } from "../../core/orchestrator.js";
import { parseConfig } from "../../core/config.js";
import { FileAgentStore } from "../../stores/file-agent-store.js";

async function initOrchestrator(workDir: string): Promise<Orchestrator> {
  const o = new Orchestrator(resolve(workDir));
  await o.init();
  return o;
}

export function registerConfigCommands(program: Command): void {
  const configCmd = program
    .command("config")
    .description("Configuration management");

  // polpo config show
  configCmd
    .command("show")
    .description("Show current configuration")
    .option("-d, --dir <path>", "Working directory", ".")
    .action(async (opts) => {
      try {
        const orchestrator = await initOrchestrator(opts.dir);
        const config = orchestrator.getConfig();

        if (!config) {
          console.log(chalk.yellow("No configuration loaded"));
          return;
        }

        console.log(chalk.bold("\n  Org:     ") + config.org);
        console.log(chalk.bold("  Version: ") + config.version);

        // Read teams and agents from stores
        const teamStore = orchestrator.getTeamStore();
        const agentStore = orchestrator.getAgentStore();
        const teams = await teamStore.getTeams();
        for (const t of teams) {
          const teamAgents = await agentStore.getAgents(t.name);
          console.log(
            chalk.bold("  Team:    ") +
              t.name +
              chalk.dim(` (${teamAgents.length} agents)`)
          );
        }

        // Settings
        const s = config.settings;
        console.log(chalk.bold("\n  Settings"));
        console.log(chalk.dim("  ────────────────────────────────────"));
        console.log(`  maxRetries              ${s.maxRetries}`);
        console.log(`  logLevel                ${s.logLevel}`);
        console.log(
          `  taskTimeout             ${s.taskTimeout ? `${Math.round(s.taskTimeout / 60000)}m` : chalk.dim("default")}`
        );
        console.log(
          `  staleThreshold          ${s.staleThreshold ? `${Math.round(s.staleThreshold / 60000)}m` : chalk.dim("default")}`
        );
        console.log(
          `  enableVolatileTeams     ${s.enableVolatileTeams ?? chalk.dim("default")}`
        );
        console.log(
          `  autoCorrectExpectations ${s.autoCorrectExpectations ?? chalk.dim("default")}`
        );
        console.log(
          `  orchestratorModel       ${typeof s.orchestratorModel === "string" ? s.orchestratorModel : s.orchestratorModel?.primary ?? chalk.dim("default")}`
        );

        // Agents table (from store)
        console.log(chalk.bold("\n  Agents"));
        console.log(chalk.dim("  ────────────────────────────────────"));
        const allAgents = await agentStore.getAgents();
        const nameWidth = Math.max(
          6,
          ...allAgents.map((a) => a.name.length)
        );
        const modelWidth = Math.max(
          6,
          ...allAgents.map((a) => (a.model ?? "-").length)
        );

        console.log(
          chalk.dim(
            `  ${"NAME".padEnd(nameWidth)}  ${"MODEL".padEnd(modelWidth)}  ROLE`
          )
        );
        for (const agent of allAgents) {
          const name = agent.name.padEnd(nameWidth);
          const model = (agent.model ?? "-").padEnd(modelWidth);
          const role = agent.role ?? "-";
          console.log(`  ${chalk.cyan(name)}  ${chalk.dim(model)}  ${chalk.dim(role)}`);
        }

        console.log();
      } catch (err: any) {
        console.error(chalk.red(`Error: ${err.message}`));
        process.exit(1);
      }
    });

  // polpo config validate
  configCmd
    .command("validate")
    .description("Validate configuration (.polpo/polpo.json)")
    .option("-d, --dir <path>", "Working directory", ".")
    .action(async (opts) => {
      const workDir = resolve(opts.dir);
      try {
        const config = await parseConfig(workDir);
        const polpoDir = resolve(workDir, ".polpo");
        const agentStore = new FileAgentStore(polpoDir);
        const allAgents = await agentStore.getAgents();
        console.log(chalk.green("\n  \u2713 Configuration valid"));
        console.log(chalk.dim(`    Org: ${config.org}`));
        console.log(chalk.dim(`    Agents:  ${allAgents.length}`));
        console.log();
        process.exit(0);
      } catch (err: any) {
        console.log(chalk.red("\n  \u2717 Configuration invalid"));
        console.log(chalk.red(`    ${err.message}`));
        console.log();
        process.exit(1);
      }
    });
}
