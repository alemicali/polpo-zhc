/**
 * /plans — manage plans (list, view, execute, resume, edit, delete).
 * /plans          → picker with all plans
 * /plans list     → inline summary
 * /plans execute  → pick a draft plan and execute
 * /plans resume   → pick a resumable plan and resume
 * /plans new      → open editor for new plan YAML
 */

import type { CommandAPI } from "./types.js";
import type { Plan } from "../../core/types.js";
import { seg } from "../format.js";

const STATUS_COLORS: Record<string, string> = {
  draft: "gray",
  active: "cyan",
  completed: "green",
  failed: "red",
  cancelled: "yellow",
};

export function cmdPlans({ polpo, store, args }: CommandAPI) {
  const sub = args[0]?.toLowerCase();

  if (sub === "new" || sub === "create") {
    planNew(polpo, store);
  } else if (sub === "execute" || sub === "exec") {
    planExecute(polpo, store, args[1]);
  } else if (sub === "resume") {
    planResume(polpo, store, args[1]);
  } else if (sub === "list" || sub === "ls") {
    planListInline(polpo, store);
  } else {
    planPicker(polpo, store);
  }
}

function planListInline(
  polpo: import("../../core/orchestrator.js").Orchestrator,
  store: import("../store.js").TUIStore,
) {
  const plans = polpo.getAllPlans();
  if (plans.length === 0) {
    store.log("No plans", [seg("No plans", "gray")]);
    return;
  }
  for (const plan of plans) {
    const color = STATUS_COLORS[plan.status] ?? "gray";
    store.log(`${plan.name} [${plan.status}]`, [
      seg(plan.name, undefined, true),
      seg(` [${plan.status}]`, color),
    ]);
  }
}

function planPicker(
  polpo: import("../../core/orchestrator.js").Orchestrator,
  store: import("../store.js").TUIStore,
) {
  const plans = polpo.getAllPlans();
  if (plans.length === 0) {
    store.log("No plans. Use /plans new to create one.", [
      seg("No plans. ", "gray"),
      seg("/plans new", "cyan"),
      seg(" to create one.", "gray"),
    ]);
    return;
  }

  store.navigate({
    id: "picker",
    title: `Plans (${plans.length})`,
    items: plans.map((p) => ({
      label: p.name,
      value: p.id,
      description: `${p.status}${p.prompt ? ` — ${p.prompt.slice(0, 40)}` : ""}`,
    })),
    hint: "Enter view  e edit  x execute  r resume  d delete  Esc back",
    onSelect: (_idx, planId) => {
      const plan = plans.find((p) => p.id === planId);
      if (plan) showPlanDetail(plan, polpo, store);
    },
    onCancel: () => store.goMain(),
    onKey: (input, _idx, planId) => {
      const plan = plans.find((p) => p.id === planId);
      if (!plan) return;

      if (input === "e") {
        planEdit(plan, polpo, store);
      } else if (input === "x") {
        store.goMain();
        executePlan(plan, polpo, store);
      } else if (input === "r") {
        store.goMain();
        resumePlanAction(plan, polpo, store);
      } else if (input === "d") {
        store.navigate({
          id: "confirm",
          message: `Delete plan "${plan.name}"?`,
          onConfirm: () => {
            polpo.deletePlan(plan.id);
            store.goMain();
            store.log(`Deleted plan: ${plan.name}`, [
              seg("- ", "red"),
              seg(plan.name, undefined, true),
            ]);
          },
          onCancel: () => planPicker(polpo, store),
        });
      }
    },
  });
}

function showPlanDetail(
  plan: Plan,
  polpo: import("../../core/orchestrator.js").Orchestrator,
  store: import("../store.js").TUIStore,
) {
  const lines = [
    `Name: ${plan.name}`,
    `Status: ${plan.status}`,
    plan.prompt ? `Prompt: ${plan.prompt}` : "",
    `Created: ${plan.createdAt}`,
    `Updated: ${plan.updatedAt}`,
    "",
    "── YAML ──",
    plan.yaml,
  ];

  const actions: string[] = [];
  if (plan.status === "draft") actions.push("Execute", "Edit");
  if (plan.status === "failed" || plan.status === "active") actions.push("Resume");
  actions.push("Edit", "Delete", "Close");
  // Deduplicate
  const uniqueActions = [...new Set(actions)];

  store.navigate({
    id: "viewer",
    title: plan.name,
    content: lines.filter(Boolean).join("\n"),
    actions: uniqueActions,
    onAction: (idx) => {
      const action = uniqueActions[idx];
      if (action === "Execute") {
        store.goMain();
        executePlan(plan, polpo, store);
      } else if (action === "Resume") {
        store.goMain();
        resumePlanAction(plan, polpo, store);
      } else if (action === "Edit") {
        planEdit(plan, polpo, store);
      } else if (action === "Delete") {
        store.navigate({
          id: "confirm",
          message: `Delete plan "${plan.name}"?`,
          onConfirm: () => {
            polpo.deletePlan(plan.id);
            store.goMain();
            store.log(`Deleted plan: ${plan.name}`, [
              seg("- ", "red"),
              seg(plan.name, undefined, true),
            ]);
          },
          onCancel: () => showPlanDetail(plan, polpo, store),
        });
      } else {
        store.goMain();
      }
    },
    onClose: () => store.goMain(),
  });
}

function planNew(
  polpo: import("../../core/orchestrator.js").Orchestrator,
  store: import("../store.js").TUIStore,
) {
  const template = [
    "# Plan tasks",
    "tasks:",
    "  - title: Task 1",
    "    description: Description here",
    "    assignTo: agent-name",
    "",
    "# Optional: team section for volatile agents",
    "# team:",
    "#   - name: temp-agent",
    "#     adapter: pi",
  ].join("\n");

  store.navigate({
    id: "editor",
    title: "New Plan (YAML)",
    initial: template,
    onSave: (yaml) => {
      const plan = polpo.savePlan({ yaml });
      store.goMain();
      store.log(`Plan created: ${plan.name}`, [
        seg("+ ", "green"),
        seg(plan.name, undefined, true),
        seg(" (draft)", "gray"),
      ]);
    },
    onCancel: () => store.goMain(),
  });
}

function planEdit(
  plan: Plan,
  polpo: import("../../core/orchestrator.js").Orchestrator,
  store: import("../store.js").TUIStore,
) {
  store.navigate({
    id: "editor",
    title: `Edit: ${plan.name}`,
    initial: plan.yaml,
    onSave: (yaml) => {
      polpo.updatePlan(plan.id, { yaml });
      store.goMain();
      store.log(`Updated plan: ${plan.name}`, [
        seg("✎ ", "cyan"),
        seg(plan.name, undefined, true),
      ]);
    },
    onCancel: () => store.goMain(),
  });
}

function executePlan(
  plan: Plan,
  polpo: import("../../core/orchestrator.js").Orchestrator,
  store: import("../store.js").TUIStore,
) {
  try {
    const result = polpo.executePlan(plan.id);
    store.log(`Executing plan: ${plan.name} (${result.tasks.length} tasks)`, [
      seg("▶ ", "blue", true),
      seg(plan.name, undefined, true),
      seg(` → ${result.tasks.length} tasks`, "gray"),
    ]);
    polpo.run().catch(() => {});
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    store.log(`Execute error: ${msg}`, [seg(`Error: ${msg}`, "red")]);
  }
}

function planExecute(
  polpo: import("../../core/orchestrator.js").Orchestrator,
  store: import("../store.js").TUIStore,
  planIdOrName?: string,
) {
  if (planIdOrName) {
    const plan = polpo.getPlan(planIdOrName) ?? polpo.getPlanByName(planIdOrName);
    if (!plan) {
      store.log(`Plan not found: ${planIdOrName}`, [seg(`Plan not found: ${planIdOrName}`, "red")]);
      return;
    }
    executePlan(plan, polpo, store);
    return;
  }

  const drafts = polpo.getAllPlans().filter((p) => p.status === "draft");
  if (drafts.length === 0) {
    store.log("No draft plans to execute", [seg("No draft plans to execute", "gray")]);
    return;
  }

  store.navigate({
    id: "picker",
    title: "Execute plan",
    items: drafts.map((p) => ({ label: p.name, value: p.id })),
    onSelect: (_idx, planId) => {
      store.goMain();
      const plan = polpo.getPlan(planId);
      if (plan) executePlan(plan, polpo, store);
    },
    onCancel: () => store.goMain(),
  });
}

function resumePlanAction(
  plan: Plan,
  polpo: import("../../core/orchestrator.js").Orchestrator,
  store: import("../store.js").TUIStore,
) {
  try {
    const result = polpo.resumePlan(plan.id, { retryFailed: true });
    store.log(`Resumed plan: ${plan.name}`, [
      seg("⟳ ", "blue"),
      seg(plan.name, undefined, true),
      seg(` (${result.retried} retried, ${result.pending} pending)`, "gray"),
    ]);
    polpo.run().catch(() => {});
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    store.log(`Resume error: ${msg}`, [seg(`Error: ${msg}`, "red")]);
  }
}

function planResume(
  polpo: import("../../core/orchestrator.js").Orchestrator,
  store: import("../store.js").TUIStore,
  planIdOrName?: string,
) {
  if (planIdOrName) {
    const plan = polpo.getPlan(planIdOrName) ?? polpo.getPlanByName(planIdOrName);
    if (!plan) {
      store.log(`Plan not found: ${planIdOrName}`, [seg(`Plan not found: ${planIdOrName}`, "red")]);
      return;
    }
    resumePlanAction(plan, polpo, store);
    return;
  }

  const resumable = polpo.getResumablePlans();
  if (resumable.length === 0) {
    store.log("No resumable plans", [seg("No resumable plans", "gray")]);
    return;
  }

  store.navigate({
    id: "picker",
    title: "Resume plan",
    items: resumable.map((p) => ({
      label: p.name,
      value: p.id,
      description: p.status,
    })),
    onSelect: (_idx, planId) => {
      store.goMain();
      const plan = polpo.getPlan(planId);
      if (plan) resumePlanAction(plan, polpo, store);
    },
    onCancel: () => store.goMain(),
  });
}
