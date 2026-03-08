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
    .description("View and manage project memory");

  // polpo memory show
  mem
    .command("show")
    .description("Display the current project memory")
    .option("-d, --dir <path>", "Working directory", ".")
    .action(async (opts) => {
      try {
        const orchestrator = await initOrchestrator(opts.dir);
        if (!(await orchestrator.hasMemory())) {
          console.log(chalk.dim("No project memory."));
          return;
        }
        console.log(await orchestrator.getMemory());
      } catch (err: any) {
        console.error(chalk.red(`Error: ${err.message}`));
        process.exit(1);
      }
    });

  // polpo memory set <content...>
  mem
    .command("set <content...>")
    .description("Replace the entire project memory with the given content")
    .option("-d, --dir <path>", "Working directory", ".")
    .action(async (content: string[], opts) => {
      try {
        const orchestrator = await initOrchestrator(opts.dir);
        const text = content.join(" ");
        await orchestrator.saveMemory(text);
        console.log(chalk.green("Memory saved."));
      } catch (err: any) {
        console.error(chalk.red(`Error: ${err.message}`));
        process.exit(1);
      }
    });

  // polpo memory append <line...>
  mem
    .command("append <line...>")
    .description("Append a line to the project memory")
    .option("-d, --dir <path>", "Working directory", ".")
    .action(async (line: string[], opts) => {
      try {
        const orchestrator = await initOrchestrator(opts.dir);
        const text = line.join(" ");
        await orchestrator.appendMemory(text);
        console.log(chalk.green("Memory updated."));
      } catch (err: any) {
        console.error(chalk.red(`Error: ${err.message}`));
        process.exit(1);
      }
    });

  // polpo memory edit
  mem
    .command("edit")
    .description("Open project memory in $EDITOR")
    .option("-d, --dir <path>", "Working directory", ".")
    .action(async (opts) => {
      try {
        const orchestrator = await initOrchestrator(opts.dir);
        const editor = process.env.EDITOR || "vi";
        const current = (await orchestrator.hasMemory()) ? await orchestrator.getMemory() : "";
        const tmpPath = resolve(tmpdir(), "polpo-memory-" + Date.now() + ".md");

        await writeFile(tmpPath, current, "utf-8");
        const result = spawnSync(editor, [tmpPath], { stdio: "inherit" });

        if (result.status !== 0) {
          console.error(chalk.red(`Editor exited with code ${result.status}`));
          await unlink(tmpPath).catch(() => {});
          process.exit(1);
        }

        const newContent = await readFile(tmpPath, "utf-8");
        await orchestrator.saveMemory(newContent);
        await unlink(tmpPath).catch(() => {});
        console.log(chalk.green("Memory saved."));
      } catch (err: any) {
        console.error(chalk.red(`Error: ${err.message}`));
        process.exit(1);
      }
    });
}
