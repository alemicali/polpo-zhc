/**
 * CLI commands for OAuth authentication.
 *
 * polpo auth login [provider]   — login to a provider via OAuth
 * polpo auth status             — show all stored auth profiles
 * polpo auth logout [provider]  — remove stored credentials
 */

import { Command } from "commander";
import chalk from "chalk";
import * as readline from "node:readline";

export function registerAuthCommands(parent: Command): void {
  const auth = parent
    .command("auth")
    .description("Manage OAuth authentication for LLM providers");

  // ── polpo auth login ──────────────────────────────

  auth
    .command("login [provider]")
    .description("Login to an OAuth-enabled LLM provider")
    .action(async (providerArg?: string) => {
      const { oauthLogin, OAUTH_PROVIDERS } = await import("../../auth/index.js");
      type OAuthProviderName = (typeof OAUTH_PROVIDERS)[number]["id"];

      // If no provider specified, show picker
      let provider: OAuthProviderName;
      if (!providerArg) {
        console.log(chalk.bold("Available OAuth providers:\n"));
        for (let i = 0; i < OAUTH_PROVIDERS.length; i++) {
          const p = OAUTH_PROVIDERS[i];
          console.log(`  ${chalk.cyan(`${i + 1}.`)} ${chalk.bold(p.name)} ${chalk.dim(`(${p.id})`)}`);
          console.log(`     ${chalk.dim(p.flow)}`);
        }
        console.log();

        const answer = await promptUser("Select provider (1-5): ");
        const idx = parseInt(answer, 10) - 1;
        if (idx < 0 || idx >= OAUTH_PROVIDERS.length) {
          console.error(chalk.red("Invalid selection."));
          process.exit(1);
        }
        provider = OAUTH_PROVIDERS[idx].id;
      } else {
        // Validate provider
        const match = OAUTH_PROVIDERS.find(p => p.id === providerArg);
        if (!match) {
          console.error(chalk.red(`Unknown OAuth provider: "${providerArg}"`));
          console.log(`Available: ${OAUTH_PROVIDERS.map(p => p.id).join(", ")}`);
          process.exit(1);
        }
        provider = match.id;
      }

      const providerInfo = OAUTH_PROVIDERS.find(p => p.id === provider)!;
      console.log(`\n${chalk.bold(`Logging in to ${providerInfo.name}...`)}\n`);

      try {
        const profileId = await oauthLogin(provider, {
          onAuthUrl: (url, instructions) => {
            if (instructions) {
              console.log(chalk.yellow(instructions));
            }
            console.log(`\n${chalk.bold("Open this URL in your browser:")}`);
            console.log(chalk.cyan(url));
            console.log();
          },
          onPrompt: async (message, placeholder) => {
            return promptUser(`${message}${placeholder ? chalk.dim(` (${placeholder})`) : ""}: `);
          },
          onProgress: (message) => {
            console.log(chalk.dim(`  ${message}`));
          },
        });

        console.log(`\n${chalk.green("Login successful!")}`);
        console.log(`Profile saved as: ${chalk.bold(profileId)}`);
        console.log(chalk.dim(`Stored in ~/.polpo/auth-profiles.json`));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        // Don't log raw error — it may contain token endpoint details
        console.error(`\n${chalk.red(`Login failed: ${msg}`)}`);
        process.exit(1);
      }
    });

  // ── polpo auth status ─────────────────────────────

  auth
    .command("status")
    .description("Show all stored OAuth profiles and their status")
    .action(async () => {
      const { getAllProfiles, getProfilesPath } = await import("../../auth/index.js");
      const profiles = getAllProfiles();

      if (profiles.length === 0) {
        console.log(chalk.dim("No auth profiles stored."));
        console.log(chalk.dim(`Run ${chalk.bold("polpo auth login")} to add one.`));
        return;
      }

      console.log(chalk.bold(`Auth Profiles`) + chalk.dim(` (${getProfilesPath()})`));
      console.log();

      for (const { id, profile } of profiles) {
        const isExpired = profile.expires ? Date.now() >= profile.expires : false;
        const hasRefresh = !!profile.refresh;
        const expiryStr = profile.expires
          ? new Date(profile.expires).toLocaleString()
          : "no expiry";

        const statusIcon = isExpired
          ? (hasRefresh ? chalk.yellow("~") : chalk.red("x"))
          : chalk.green("*");

        const statusText = isExpired
          ? (hasRefresh ? chalk.yellow("expired (auto-refresh available)") : chalk.red("expired"))
          : chalk.green("active");

        console.log(`  ${statusIcon} ${chalk.bold(id)}`);
        console.log(`    Provider: ${profile.provider}`);
        console.log(`    Type: ${profile.type}`);
        console.log(`    Status: ${statusText}`);
        console.log(`    Expires: ${expiryStr}`);
        if (profile.email) {
          console.log(`    Email: ${profile.email}`);
        }
        if (profile.lastUsed) {
          console.log(`    Last used: ${new Date(profile.lastUsed).toLocaleString()}`);
        }
        console.log();
      }
    });

  // ── polpo auth logout ─────────────────────────────

  auth
    .command("logout [provider]")
    .description("Remove stored OAuth credentials")
    .option("--all", "Remove all stored credentials")
    .action(async (providerArg: string | undefined, opts: { all?: boolean }) => {
      const { deleteProviderProfiles, getAllProfiles, deleteProfile } = await import("../../auth/index.js");

      if (opts.all) {
        const profiles = getAllProfiles();
        let count = 0;
        for (const { id } of profiles) {
          deleteProfile(id);
          count++;
        }
        console.log(chalk.green(`Removed ${count} auth profile(s).`));
        return;
      }

      if (!providerArg) {
        console.error(chalk.red("Specify a provider or use --all."));
        console.log(`Usage: ${chalk.bold("polpo auth logout <provider>")} or ${chalk.bold("polpo auth logout --all")}`);
        process.exit(1);
      }

      const count = deleteProviderProfiles(providerArg);
      if (count === 0) {
        console.log(chalk.dim(`No profiles found for "${providerArg}".`));
      } else {
        console.log(chalk.green(`Removed ${count} profile(s) for "${providerArg}".`));
      }
    });
}

// ── Helpers ──────────────────────────────────────────

function promptUser(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}
