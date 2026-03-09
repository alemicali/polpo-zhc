import { execSync } from "node:child_process";
import type { Command } from "commander";
import chalk from "chalk";

/**
 * Detect which package manager installed polpo globally.
 */
function detectPackageManager(): "pnpm" | "npm" {
  try {
    const out = execSync("pnpm list -g polpo-ai --depth=0 2>/dev/null", {
      encoding: "utf-8",
      timeout: 10_000,
    });
    if (out.includes("@polpo-ai/polpo")) return "pnpm";
  } catch { /* not pnpm */ }
  return "npm";
}

/**
 * Get the latest version from the npm registry.
 */
async function getLatestVersion(): Promise<string> {
  const res = await fetch("https://registry.npmjs.org/@polpo-ai%2fpolpo/latest", {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Registry returned ${res.status}`);
  const data = (await res.json()) as { version: string };
  return data.version;
}

export function registerUpdateCommand(program: Command): void {
  program
    .command("update")
    .alias("upgrade")
    .description("Update Polpo to the latest version")
    .option("--check", "Only check for updates, don't install")
    .action(async (opts) => {
      try {
        const currentVersion = program.version();
        console.log(chalk.dim(`  Current version: ${currentVersion}`));
        console.log(chalk.dim("  Checking for updates..."));

        const latest = await getLatestVersion();

        if (latest === currentVersion) {
          console.log(chalk.green(`\n  Already up to date (${currentVersion})`));
          return;
        }

        console.log(
          `\n  ${chalk.yellow("Update available:")} ${chalk.dim(currentVersion)} → ${chalk.cyan.bold(latest)}`,
        );

        if (opts.check) {
          console.log(chalk.dim(`\n  Run ${chalk.white("polpo update")} to install.`));
          return;
        }

        const pm = detectPackageManager();
        const cmd =
          pm === "pnpm"
            ? "pnpm add -g @polpo-ai/polpo@latest"
            : "npm install -g @polpo-ai/polpo@latest --force";

        console.log(chalk.dim(`\n  Updating via ${pm}...`));
        console.log(chalk.dim(`  $ ${cmd}\n`));

        execSync(cmd, { stdio: "inherit", timeout: 120_000 });

        // Verify
        try {
          const newVer = execSync("polpo --version", { encoding: "utf-8" }).trim();
          console.log(chalk.green(`\n  Updated to ${newVer}`));
        } catch {
          console.log(chalk.green(`\n  Update complete. Restart your shell to use the new version.`));
        }
      } catch (err: any) {
        console.error(chalk.red(`\n  Update failed: ${err.message}`));
        console.log(chalk.dim("  Try manually: npm install -g polpo-ai@latest"));
        process.exit(1);
      }
    });
}
