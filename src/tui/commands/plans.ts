/**
 * /plans — manage plans (list, create, execute, resume).
 */

import type { CommandAPI } from "./types.js";
import { seg } from "../format.js";

export function cmdPlans({ polpo, store, args }: CommandAPI) {
  const plans = polpo.getAllPlans();

  if (plans.length === 0) {
    store.log("No plans", [seg("No plans", "gray")]);
    store.log("Type a task description to create one, or use plan mode", [
      seg("Type a description or switch to ", "gray"),
      seg("plan", "blue", true),
      seg(" mode", "gray"),
    ]);
    return;
  }

  for (const plan of plans) {
    const color =
      plan.status === "completed" ? "green" :
      plan.status === "failed" ? "red" :
      plan.status === "active" ? "cyan" : "gray";
    store.log(`${plan.name} [${plan.status}]`, [
      seg(plan.name, undefined, true),
      seg(` [${plan.status}]`, color),
    ]);
  }

  // TODO: implement plan detail, execute, resume, edit via pages
}
