/**
 * polpo-cloud logout — clear stored credentials.
 */
import type { Command } from "commander";
import { clearCredentials } from "./config.js";

export function registerLogoutCommand(program: Command): void {
  program
    .command("logout")
    .description("Clear stored credentials")
    .action(() => {
      clearCredentials();
      console.log("Logged out.");
    });
}
