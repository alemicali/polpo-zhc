/**
 * polpo-cloud status — show project status summary.
 */
import type { Command } from "commander";
import { loadCredentials } from "./config.js";
import { createApiClient } from "./api.js";

export function registerStatusCommand(program: Command): void {
  program
    .command("cloud-status")
    .description("Show project status summary")
    .action(async () => {
      const creds = loadCredentials();
      if (!creds) {
        console.error(
          "Not logged in. Run: polpo-cloud login --api-key <key>",
        );
        process.exit(1);
      }

      const client = createApiClient(creds);

      // Fetch tasks
      let taskSummary = "";
      try {
        const res = await client.get<any>("/v1/tasks");
        if (res.status === 200) {
          const tasks = res.data?.data ?? res.data ?? [];
          const byStatus: Record<string, number> = {};
          for (const t of Array.isArray(tasks) ? tasks : []) {
            const s = t.status ?? "unknown";
            byStatus[s] = (byStatus[s] ?? 0) + 1;
          }
          const total = Array.isArray(tasks) ? tasks.length : 0;
          const parts = Object.entries(byStatus)
            .map(([s, c]) => `${s}: ${c}`)
            .join(", ");
          taskSummary = `Tasks: ${total}${parts ? " (" + parts + ")" : ""}`;
        } else {
          taskSummary = "Tasks: error fetching";
        }
      } catch {
        taskSummary = "Tasks: unavailable";
      }

      // Fetch agents
      let agentSummary = "";
      try {
        const res = await client.get<any>("/v1/agents");
        if (res.status === 200) {
          const agents = res.data?.data ?? res.data ?? [];
          const count = Array.isArray(agents) ? agents.length : 0;
          agentSummary = `Agents: ${count}`;
        } else {
          agentSummary = "Agents: error fetching";
        }
      } catch {
        agentSummary = "Agents: unavailable";
      }

      // Fetch missions
      let missionSummary = "";
      try {
        const res = await client.get<any>("/v1/missions");
        if (res.status === 200) {
          const missions = res.data?.data ?? res.data ?? [];
          const count = Array.isArray(missions) ? missions.length : 0;
          missionSummary = `Missions: ${count}`;
        } else {
          missionSummary = "Missions: error fetching";
        }
      } catch {
        missionSummary = "Missions: unavailable";
      }

      console.log("Project Status");
      console.log("==============");
      console.log(taskSummary);
      console.log(agentSummary);
      console.log(missionSummary);
    });
}
