/**
 * polpo-cloud byok — manage BYOK (Bring Your Own Key) API keys.
 */
import type { Command } from "commander";
import { loadCredentials } from "./config.js";
import { createApiClient } from "./api.js";
import { isTTY, promptMasked } from "./prompt.js";

export function registerByokCommand(program: Command): void {
  const byok = program
    .command("byok")
    .description("Manage BYOK (Bring Your Own Key) API keys");

  byok
    .command("set <provider>")
    .description("Set a BYOK key for a provider")
    .option("--key <key>", "API key for the provider")
    .option("--label <label>", "Optional label")
    .option("--project <project-id>", "Project ID (if not in credentials)")
    .action(async (provider: string, opts) => {
      const creds = loadCredentials();
      if (!creds) {
        console.error(
          "Not logged in. Run: polpo-cloud login --api-key <key>",
        );
        process.exit(1);
      }

      let key: string | undefined = opts.key;

      if (!key) {
        if (isTTY()) {
          key = await promptMasked(`API key for ${provider}: `);
          if (!key) {
            console.error("Error: API key is required.");
            process.exit(1);
          }
        } else {
          console.error("Error: --key is required.");
          process.exit(1);
        }
      }

      const client = createApiClient(creds);

      try {
        const res = await client.post("/v1/byok", {
          provider,
          key,
          label: opts.label,
        });

        if (res.status >= 200 && res.status < 300) {
          console.log(`BYOK key set for provider "${provider}".`);
        } else {
          const data = res.data as any;
          console.error(
            "Error: " + (data?.error ?? JSON.stringify(data)),
          );
          process.exit(1);
        }
      } catch (err: any) {
        console.error("Error: " + err.message);
        process.exit(1);
      }
    });

  byok
    .command("list")
    .description("List BYOK keys")
    .option("--project <project-id>", "Project ID (if not in credentials)")
    .action(async (opts) => {
      const creds = loadCredentials();
      if (!creds) {
        console.error(
          "Not logged in. Run: polpo-cloud login --api-key <key>",
        );
        process.exit(1);
      }

      const client = createApiClient(creds);

      try {
        const res = await client.get("/v1/byok");

        if (res.status >= 200 && res.status < 300) {
          const data = res.data as any;
          const keys = data?.data ?? [];
          if (keys.length === 0) {
            console.log("No BYOK keys configured.");
          } else {
            console.log("BYOK keys:");
            for (const k of keys) {
              const label = k.label ? ` (${k.label})` : "";
              console.log(`  ${k.provider}: ${k.maskedKey}${label}`);
            }
          }
        } else {
          const data = res.data as any;
          console.error(
            "Error: " + (data?.error ?? JSON.stringify(data)),
          );
          process.exit(1);
        }
      } catch (err: any) {
        console.error("Error: " + err.message);
        process.exit(1);
      }
    });

  byok
    .command("remove <provider>")
    .description("Remove a BYOK key")
    .option("--project <project-id>", "Project ID (if not in credentials)")
    .action(async (provider: string, opts) => {
      const creds = loadCredentials();
      if (!creds) {
        console.error(
          "Not logged in. Run: polpo-cloud login --api-key <key>",
        );
        process.exit(1);
      }

      const client = createApiClient(creds);

      try {
        const res = await client.delete(`/v1/byok/${provider}`);

        if (res.status >= 200 && res.status < 300) {
          console.log(`BYOK key removed for provider "${provider}".`);
        } else if (res.status === 404) {
          console.error(`No BYOK key found for provider "${provider}".`);
          process.exit(1);
        } else {
          const data = res.data as any;
          console.error(
            "Error: " + (data?.error ?? JSON.stringify(data)),
          );
          process.exit(1);
        }
      } catch (err: any) {
        console.error("Error: " + err.message);
        process.exit(1);
      }
    });
}
