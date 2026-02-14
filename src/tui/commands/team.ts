/**
 * /team — manage team agents (list, add, remove, edit).
 */

import type { CommandAPI } from "./types.js";
import { seg } from "../format.js";

export function cmdTeam({ polpo, store }: CommandAPI) {
  const team = polpo.getTeam();
  const agents = team.agents;

  store.log(`Team: ${team.name} (${agents.length} agents)`, [
    seg("Team: ", "gray"),
    seg(team.name, undefined, true),
    seg(` (${agents.length} agents)`, "gray"),
  ]);

  for (const agent of agents) {
    store.log(`  ${agent.name} (${agent.adapter})`, [
      seg("  "),
      seg(agent.name, "cyan", true),
      seg(` (${agent.adapter})`, "gray"),
      agent.model ? seg(` ${agent.model}`, "gray", false, true) : seg(""),
    ]);
  }

  // TODO: implement add/remove/edit via picker pages
}
