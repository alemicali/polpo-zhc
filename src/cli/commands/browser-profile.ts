/**
 * CLI commands for browser profile management.
 *
 * polpo browser login <agent> [url]  — Open a visible browser with the agent's profile for manual login
 * polpo browser list                  — List agents with browser profiles
 * polpo browser clear <agent>         — Delete an agent's browser profile (cookies, sessions)
 */

import { resolve, join } from "node:path";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { mkdirSync } from "node:fs";
import type { Command } from "commander";
import chalk from "chalk";
import { loadPolpoConfig } from "../../core/config.js";
import type { AgentConfig } from "../../core/types.js";

/** Resolve the browser profile directory for a given agent. */
function profileDir(polpoDir: string, agentName: string, agent?: AgentConfig): string {
  const profileName = agent?.browserProfile || agentName;
  return join(polpoDir, "browser-profiles", profileName);
}

/** Find an agent in the config by name. */
function findAgent(polpoDir: string, name: string): AgentConfig | undefined {
  try {
    const config = loadPolpoConfig(polpoDir);
    return config?.teams?.[0]?.agents?.find(
      (a: AgentConfig) => a.name.toLowerCase() === name.toLowerCase(),
    );
  } catch {
    return undefined;
  }
}

export function registerBrowserCommands(parent: Command): void {
  const browser = parent
    .command("browser")
    .description("Manage agent browser profiles (persistent sessions)");

  // ── polpo browser login <agent> [url] ──

  browser
    .command("login <agent> [url]")
    .description("Open a visible browser with the agent's profile for manual login")
    .option("-d, --dir <path>", "Working directory", ".")
    .option("--headless", "Run headless (for testing)", false)
    .action(async (agentName: string, url: string | undefined, opts: { dir: string; headless: boolean }) => {
      const polpoDir = resolve(opts.dir, ".polpo");
      const agent = findAgent(polpoDir, agentName);

      // Determine profile directory
      const profDir = profileDir(polpoDir, agentName, agent);
      mkdirSync(profDir, { recursive: true });

      const startUrl = url ?? "https://x.com/login";

      console.log();
      console.log(chalk.bold("  Browser Login"));
      console.log(chalk.dim(`  Agent:   ${agentName}`));
      console.log(chalk.dim(`  Profile: ${profDir}`));
      console.log(chalk.dim(`  URL:     ${startUrl}`));
      console.log();

      console.log(chalk.cyan("  Opening browser... Log in to any services you need."));
      console.log(chalk.cyan("  Close the browser window when done — your session will be saved."));
      console.log();

      try {
        // Use agent-browser with visible mode + persistent profile for login
        const { execSync } = await import("node:child_process");
        const session = agentName;

        console.log(chalk.dim("  Using agent-browser for login session..."));
        mkdirSync(profDir, { recursive: true });
        execSync(`agent-browser --session ${session} --profile ${profDir} --headed open ${startUrl}`, {
          encoding: "utf-8",
          timeout: 60_000,
          stdio: "inherit",
        });

        // Wait for user to confirm they're done
        const readline = await import("node:readline");
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        await new Promise<void>((res) => {
          rl.question(
            chalk.cyan("\n  Press Enter when you're done logging in... "),
            () => { rl.close(); res(); },
          );
        });

        // Close the session (profile data auto-saved by --profile)
        try {
          execSync(`agent-browser --session ${session} close`, {
            encoding: "utf-8",
            timeout: 10_000,
            stdio: ["ignore", "pipe", "pipe"],
          });
        } catch { /* already closed */ }

        console.log();
        console.log(chalk.green("  Session saved to profile."));
        console.log(chalk.dim(`  Profile: ${profDir}`));

        // Show helpful next step
        if (!agent) {
          console.log();
          console.log(chalk.yellow("  Note: no agent named \"" + agentName + "\" found in polpo.json."));
          console.log(chalk.yellow("  Add it with browser_* in allowedTools to use this profile:"));
          console.log();
          console.log(chalk.dim("    agents:"));
          console.log(chalk.dim(`      - name: ${agentName}`));
          console.log(chalk.dim("        allowedTools: [\"browser_*\"]"));
        }

        console.log();
      } catch (err: any) {
        if (err.message?.includes("Executable doesn't exist")) {
          console.error(chalk.red("  Chromium not installed. Run:"));
          console.error(chalk.cyan("    npx playwright install chromium"));
          process.exit(1);
        }
        if (err.message?.includes("agent-browser")) {
          console.error(chalk.red("  agent-browser not found. Install it:"));
          console.error(chalk.cyan("    npm install -g agent-browser && agent-browser install"));
          process.exit(1);
        }
        console.error(chalk.red(`  Error: ${err.message}`));
        process.exit(1);
      }
    });

  // ── polpo browser list ──

  browser
    .command("list")
    .description("List agents with browser profiles")
    .option("-d, --dir <path>", "Working directory", ".")
    .action((opts: { dir: string }) => {
      const profilesDir = resolve(opts.dir, ".polpo", "browser-profiles");

      if (!existsSync(profilesDir)) {
        console.log(chalk.dim("\n  No browser profiles found.\n"));
        return;
      }

      const entries = readdirSync(profilesDir, { withFileTypes: true })
        .filter(e => e.isDirectory());

      if (entries.length === 0) {
        console.log(chalk.dim("\n  No browser profiles found.\n"));
        return;
      }

      console.log(chalk.bold("\n  Browser Profiles\n"));

      for (const entry of entries) {
        const dir = join(profilesDir, entry.name);
        const stat = statSync(dir);
        const age = Date.now() - stat.mtimeMs;
        const ageStr = age < 3600_000
          ? `${Math.round(age / 60_000)}m ago`
          : age < 86400_000
            ? `${Math.round(age / 3600_000)}h ago`
            : `${Math.round(age / 86400_000)}d ago`;

        // Check if cookies exist (indicator of an active session)
        const hasCookies = existsSync(join(dir, "Default", "Cookies"))
          || existsSync(join(dir, "Cookies"));

        const statusIcon = hasCookies ? chalk.green("●") : chalk.dim("○");
        console.log(`  ${statusIcon} ${chalk.bold(entry.name)} ${chalk.dim(`— last used ${ageStr}`)}`);
      }

      console.log();
    });

  // ── polpo browser clear <agent> ──

  browser
    .command("clear <agent>")
    .description("Delete an agent's browser profile (removes all saved sessions)")
    .option("-d, --dir <path>", "Working directory", ".")
    .option("-f, --force", "Skip confirmation", false)
    .action(async (agentName: string, opts: { dir: string; force: boolean }) => {
      const polpoDir = resolve(opts.dir, ".polpo");
      const agent = findAgent(polpoDir, agentName);
      const profDir = profileDir(polpoDir, agentName, agent);

      if (!existsSync(profDir)) {
        console.log(chalk.dim(`\n  No profile found for "${agentName}".\n`));
        return;
      }

      if (!opts.force) {
        const readline = await import("node:readline");
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const answer = await new Promise<string>((res) => {
          rl.question(
            chalk.yellow(`  Delete browser profile for "${agentName}"? This removes all saved logins. (y/N): `),
            (a) => { rl.close(); res(a.trim()); },
          );
        });
        if (!answer.toLowerCase().startsWith("y")) {
          console.log(chalk.dim("  Cancelled.\n"));
          return;
        }
      }

      rmSync(profDir, { recursive: true, force: true });
      console.log(chalk.green(`\n  Profile deleted: ${profDir}\n`));
    });
}
