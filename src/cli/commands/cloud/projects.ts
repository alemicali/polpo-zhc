/**
 * polpo-cloud projects — manage projects (session auth, limited CLI support).
 *
 * NOTE: Projects API uses session auth (Better Auth), not API key auth.
 * These commands are stubs that use API key auth — they may not work
 * with the current control plane auth model.
 */
import type { Command } from "commander";
import { loadCredentials } from "./config.js";
import { createApiClient } from "./api.js";

export function registerProjectsCommand(program: Command): void {
  const projects = program
    .command("projects")
    .description("Manage projects (limited — uses API key auth)");

  projects
    .command("list")
    .description("List projects")
    .action(async () => {
      const creds = loadCredentials();
      if (!creds) {
        console.error(
          "Not logged in. Run: polpo-cloud login --api-key <key>",
        );
        process.exit(1);
      }

      const client = createApiClient(creds);

      try {
        const res = await client.get<any>("/v1/projects");
        if (res.status === 200) {
          const projects = res.data?.data ?? [];
          if (projects.length === 0) {
            console.log("No projects found.");
          } else {
            for (const p of projects) {
              const status = p.status ? ` [${p.status}]` : "";
              console.log(`  ${p.name ?? p.id}${status}`);
            }
          }
        } else if (res.status === 401) {
          console.error(
            "Error: Projects API requires session auth. Use the web dashboard to manage projects.",
          );
          process.exit(1);
        } else {
          console.error("Error: status " + res.status);
          process.exit(1);
        }
      } catch (err: any) {
        console.error("Error: " + err.message);
        process.exit(1);
      }
    });

  projects
    .command("create <name>")
    .description("Create a project")
    .option("--org <org-id>", "Organization ID")
    .action(async (name: string, opts) => {
      const creds = loadCredentials();
      if (!creds) {
        console.error(
          "Not logged in. Run: polpo-cloud login --api-key <key>",
        );
        process.exit(1);
      }

      const client = createApiClient(creds);

      try {
        const res = await client.post<any>("/v1/projects", {
          name,
          orgId: opts.org,
        });

        if (res.status >= 200 && res.status < 300) {
          const project = res.data?.data ?? res.data;
          console.log(`Project "${name}" created.`);
          if (project?.id) {
            console.log(`  ID: ${project.id}`);
          }
        } else if (res.status === 401) {
          console.error(
            "Error: Projects API requires session auth. Use the web dashboard to manage projects.",
          );
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
