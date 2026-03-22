/**
 * polpo cloud projects — manage projects via session token auth.
 */
import type { Command } from "commander";
import { loadCredentials } from "./config.js";
import { createApiClient, type ApiClient } from "./api.js";

/**
 * Fetch the user's first org ID. The server requires an orgId for
 * project list/create, so we resolve it automatically.
 */
async function resolveOrgId(client: ApiClient): Promise<string> {
  const res = await client.get<any[]>("/v1/orgs");
  if (res.status !== 200) {
    console.error(
      `Failed to fetch organizations (status ${res.status}). Are you logged in?`,
    );
    process.exit(1);
  }

  const orgs = Array.isArray(res.data) ? res.data : [];
  if (orgs.length === 0) {
    console.error(
      "No organizations found. Create one in the dashboard first.",
    );
    process.exit(1);
  }

  return orgs[0].id;
}

export function registerProjectsCommand(program: Command): void {
  const projects = program
    .command("projects")
    .description("Manage cloud projects");

  projects
    .command("list")
    .description("List projects")
    .option("--org <org-id>", "Organization ID (auto-detected if omitted)")
    .action(async (opts) => {
      const creds = loadCredentials();
      if (!creds) {
        console.error("Not logged in. Run: polpo login --api-key <key>");
        process.exit(1);
      }

      const client = createApiClient(creds);

      try {
        const orgId = opts.org ?? (await resolveOrgId(client));
        const res = await client.get<any[]>(
          `/v1/projects?orgId=${encodeURIComponent(orgId)}`,
        );

        if (res.status === 200) {
          const list = Array.isArray(res.data) ? res.data : [];
          if (list.length === 0) {
            console.log("No projects found.");
          } else {
            for (const p of list) {
              const status = p.status ? ` [${p.status}]` : "";
              console.log(`  ${p.name ?? p.id}${status}`);
            }
          }
        } else {
          const data = res.data as any;
          console.error(
            "Error: " + (data?.error ?? `status ${res.status}`),
          );
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
    .option("--org <org-id>", "Organization ID (auto-detected if omitted)")
    .action(async (name: string, opts) => {
      const creds = loadCredentials();
      if (!creds) {
        console.error("Not logged in. Run: polpo login --api-key <key>");
        process.exit(1);
      }

      const client = createApiClient(creds);

      try {
        const orgId = opts.org ?? (await resolveOrgId(client));

        // Derive slug from name: lowercase, replace non-alphanumeric with dashes
        const slug = name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "");

        const res = await client.post<any>("/v1/projects", {
          orgId,
          name,
          slug,
        });

        if (res.status >= 200 && res.status < 300) {
          const project = res.data;
          console.log(`Project "${name}" created.`);
          if (project?.id) {
            console.log(`  ID: ${project.id}`);
          }
          if (project?.slug) {
            console.log(`  Slug: ${project.slug}`);
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
}
