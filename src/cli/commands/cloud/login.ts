/**
 * polpo login — authenticate with the Polpo Cloud API.
 *
 * Default: browser-based flow (opens browser, user approves, CLI gets API key).
 * Fallback: --api-key for CI/CD and headless environments.
 */
import type { Command } from "commander";
import { saveCredentials } from "./config.js";
import { isTTY, promptMasked } from "./prompt.js";

const DEFAULT_API_URL = "https://polpo-cloud-production.up.railway.app";
const DEFAULT_DASHBOARD_URL = "https://cloud.polpo.sh";

async function openBrowser(url: string): Promise<void> {
  const { platform } = await import("node:os");
  const { exec } = await import("node:child_process");
  const os = platform();
  const cmd = os === "darwin" ? "open" : os === "win32" ? "start" : "xdg-open";
  exec(`${cmd} "${url}"`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function registerLoginCommand(program: Command): void {
  program
    .command("login")
    .description("Authenticate with the Polpo Cloud API")
    .option("--api-key <key>", "API key (skip browser flow)")
    .option("--url <base-url>", "API base URL")
    .option("--dashboard-url <url>", "Dashboard URL")
    .option("--no-browser", "Print URL instead of opening browser")
    .action(async (opts) => {
      const baseUrl: string = opts.url ?? DEFAULT_API_URL;
      const dashboardUrl: string = opts.dashboardUrl ?? DEFAULT_DASHBOARD_URL;

      // --- Direct API key flow ---
      if (opts.apiKey) {
        saveCredentials(opts.apiKey, baseUrl);
        console.log("Credentials saved.");
        return;
      }

      // --- Non-TTY: require --api-key ---
      if (!isTTY()) {
        // Try interactive prompt as last resort
        const key = await promptMasked("API key: ").catch(() => null);
        if (key) {
          saveCredentials(key, baseUrl);
          console.log("Credentials saved.");
          return;
        }
        console.error("Error: --api-key is required in non-interactive mode.");
        console.error("Usage: polpo login --api-key <key>");
        process.exit(1);
      }

      // --- Browser-based flow ---
      console.log("\n  Logging in to Polpo Cloud...\n");

      // 1. Request a code
      let code: string;
      let expiresAt: string;
      try {
        const res = await fetch(`${baseUrl}/v1/cli-auth/request`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        });
        if (!res.ok) {
          console.error(`  Error: Server returned ${res.status}.`);
          process.exit(1);
        }
        const data = (await res.json()) as { code: string; expiresAt: string };
        code = data.code;
        expiresAt = data.expiresAt;
      } catch (err: any) {
        console.error(`  Error: Could not reach the API at ${baseUrl}`);
        console.error(`  ${err.message}`);
        process.exit(1);
      }

      // 2. Display the code
      console.log(`  Your authorization code:\n`);
      console.log(`    ${code}\n`);

      // 3. Open browser
      const authUrl = `${dashboardUrl}/cli-auth?code=${code}`;

      if (opts.browser !== false) {
        console.log("  Opening browser...");
        console.log(`  If it doesn't open, visit: ${authUrl}\n`);
        await openBrowser(authUrl);
      } else {
        console.log(`  Open this URL to authorize:\n  ${authUrl}\n`);
      }

      // 4. Poll for approval
      process.stdout.write("  Waiting for authorization...");

      const expiry = new Date(expiresAt).getTime();
      const POLL_MS = 2000;

      while (Date.now() < expiry) {
        await sleep(POLL_MS);

        try {
          const res = await fetch(`${baseUrl}/v1/cli-auth/poll/${code}`);

          if (res.status === 404) {
            console.log("\n\n  Code expired. Run `polpo login` again.");
            process.exit(1);
          }

          const data = (await res.json()) as { status: string; token?: string };

          if (data.status === "approved" && data.token) {
            saveCredentials(data.token, baseUrl);
            console.log("\n\n  Logged in successfully.\n");
            return;
          }

          if (data.status === "expired") {
            console.log("\n\n  Code expired. Run `polpo login` again.");
            process.exit(1);
          }

          // Still pending — show a dot
          process.stdout.write(".");
        } catch {
          // Network blip — retry
        }
      }

      console.log("\n\n  Timed out. Run `polpo login` again.");
      process.exit(1);
    });
}
