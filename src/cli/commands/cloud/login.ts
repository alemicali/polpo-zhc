/**
 * polpo-cloud login — authenticate with the cloud API.
 */
import type { Command } from "commander";
import { saveCredentials } from "./config.js";
import { createApiClient } from "./api.js";
import { isTTY, promptMasked } from "./prompt.js";

export function registerLoginCommand(program: Command): void {
  program
    .command("login")
    .description("Authenticate with the Polpo Cloud API")
    .option("--api-key <key>", "API key")
    .option("--url <base-url>", "API base URL")
    .action(async (opts) => {
      let apiKey: string | undefined = opts.apiKey;
      const baseUrl: string | undefined = opts.url;

      if (!apiKey) {
        if (isTTY()) {
          apiKey = await promptMasked("API key: ");
          if (!apiKey) {
            console.error("Error: API key is required.");
            process.exit(1);
          }
        } else {
          console.error(
            "Error: --api-key is required. Usage: polpo-cloud login --api-key <key>",
          );
          process.exit(1);
        }
      }

      // Save credentials
      saveCredentials(apiKey, baseUrl);

      // Verify by hitting /health
      const client = createApiClient({
        apiKey,
        baseUrl: baseUrl ?? "https://polpo-cloud-production.up.railway.app",
      });

      try {
        const res = await client.get("/health");
        if (res.status === 200) {
          console.log("Logged in successfully.");
        } else {
          console.log(
            "Credentials saved, but health check returned status " + res.status,
          );
        }
      } catch (err: any) {
        console.log(
          "Credentials saved, but could not reach the API: " + err.message,
        );
      }
    });
}
