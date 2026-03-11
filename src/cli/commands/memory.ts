import { Command } from "commander";
import chalk from "chalk";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { writeFile, readFile, unlink } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { Orchestrator } from "../../core/orchestrator.js";

async function initOrchestrator(configPath: string): Promise<Orchestrator> {
  const o = new Orchestrator(resolve(configPath));
  await o.init();
  return o;
}

export function registerMemoryCommands(program: Command): void {
  const mem = program
    .command("memory")
    .description("View and manage shared and agent-specific memory");

  // polpo memory show [--agent <name>]
  mem
    .command("show")
    .description("Display memory (shared by default, or agent-specific with --agent)")
    .option("-d, --dir <path>", "Working directory", ".")
    .option("-a, --agent <name>", "Show memory for a specific agent")
    .action(async (opts) => {
      try {
        const orchestrator = await initOrchestrator(opts.dir);
        if (opts.agent) {
          if (!(await orchestrator.hasAgentMemory(opts.agent))) {
            console.log(chalk.dim(`No memory for agent "${opts.agent}".`));
            return;
          }
          console.log(await orchestrator.getAgentMemory(opts.agent));
        } else {
          if (!(await orchestrator.hasMemory())) {
            console.log(chalk.dim("No shared memory."));
            return;
          }
          console.log(await orchestrator.getMemory());
        }
      } catch (err: any) {
        console.error(chalk.red(`Error: ${err.message}`));
        process.exit(1);
      }
    });

  // polpo memory set <content...> [--agent <name>]
  mem
    .command("set <content...>")
    .description("Replace memory with the given content (shared by default, or agent-specific with --agent)")
    .option("-d, --dir <path>", "Working directory", ".")
    .option("-a, --agent <name>", "Set memory for a specific agent")
    .action(async (content: string[], opts) => {
      try {
        const orchestrator = await initOrchestrator(opts.dir);
        const text = content.join(" ");
        if (opts.agent) {
          await orchestrator.saveAgentMemory(opts.agent, text);
          console.log(chalk.green(`Memory for agent "${opts.agent}" saved.`));
        } else {
          await orchestrator.saveMemory(text);
          console.log(chalk.green("Shared memory saved."));
        }
      } catch (err: any) {
        console.error(chalk.red(`Error: ${err.message}`));
        process.exit(1);
      }
    });

  // polpo memory append <line...> [--agent <name>]
  mem
    .command("append <line...>")
    .description("Append a line to memory (shared by default, or agent-specific with --agent)")
    .option("-d, --dir <path>", "Working directory", ".")
    .option("-a, --agent <name>", "Append to a specific agent's memory")
    .action(async (line: string[], opts) => {
      try {
        const orchestrator = await initOrchestrator(opts.dir);
        const text = line.join(" ");
        if (opts.agent) {
          await orchestrator.appendAgentMemory(opts.agent, text);
          console.log(chalk.green(`Memory for agent "${opts.agent}" updated.`));
        } else {
          await orchestrator.appendMemory(text);
          console.log(chalk.green("Shared memory updated."));
        }
      } catch (err: any) {
        console.error(chalk.red(`Error: ${err.message}`));
        process.exit(1);
      }
    });

  // polpo memory edit [--agent <name>]
  mem
    .command("edit")
    .description("Open memory in $EDITOR (shared by default, or agent-specific with --agent)")
    .option("-d, --dir <path>", "Working directory", ".")
    .option("-a, --agent <name>", "Edit a specific agent's memory")
    .action(async (opts) => {
      try {
        const orchestrator = await initOrchestrator(opts.dir);
        const editor = process.env.EDITOR || "vi";
        const agentName = opts.agent as string | undefined;

        let current: string;
        if (agentName) {
          current = (await orchestrator.hasAgentMemory(agentName)) ? await orchestrator.getAgentMemory(agentName) : "";
        } else {
          current = (await orchestrator.hasMemory()) ? await orchestrator.getMemory() : "";
        }

        const suffix = agentName ? `-${agentName}` : "";
        const tmpPath = resolve(tmpdir(), `polpo-memory${suffix}-` + Date.now() + ".md");

        await writeFile(tmpPath, current, "utf-8");
        const result = spawnSync(editor, [tmpPath], { stdio: "inherit" });

        if (result.status !== 0) {
          console.error(chalk.red(`Editor exited with code ${result.status}`));
          await unlink(tmpPath).catch(() => {});
          process.exit(1);
        }

        const newContent = await readFile(tmpPath, "utf-8");
        if (agentName) {
          await orchestrator.saveAgentMemory(agentName, newContent);
        } else {
          await orchestrator.saveMemory(newContent);
        }
        await unlink(tmpPath).catch(() => {});
        const target = agentName ? `Memory for agent "${agentName}"` : "Shared memory";
        console.log(chalk.green(`${target} saved.`));
      } catch (err: any) {
        console.error(chalk.red(`Error: ${err.message}`));
        process.exit(1);
      }
    });
}
