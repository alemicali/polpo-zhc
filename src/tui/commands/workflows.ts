/**
 * /workflow — discover, inspect, and execute reusable workflow templates.
 * /workflow              → picker with all available workflows
 * /workflow list         → inline summary
 * /workflow <name> [k=v] → execute workflow with parameters
 */

import type { CommandAPI } from "./types.js";
import { seg, kickRun } from "../format.js";
import {
  discoverWorkflows,
  loadWorkflow,
  validateParams,
  instantiateWorkflow,
} from "../../core/workflow.js";

export function cmdWorkflows({ polpo, store, args }: CommandAPI) {
  const sub = args[0]?.toLowerCase();

  if (sub === "list" || sub === "ls") {
    workflowListInline(polpo, store);
  } else if (sub && sub !== "help") {
    // Treat first arg as workflow name, rest as key=value params
    workflowRun(polpo, store, sub, args.slice(1));
  } else {
    workflowPicker(polpo, store);
  }
}

function getWorkflowPaths(polpo: import("../../core/orchestrator.js").Orchestrator) {
  return {
    cwd: polpo.getWorkDir(),
    polpoDir: polpo.getPolpoDir?.() ?? undefined,
  };
}

function workflowListInline(
  polpo: import("../../core/orchestrator.js").Orchestrator,
  store: import("../store.js").TUIStore,
) {
  const { cwd, polpoDir } = getWorkflowPaths(polpo);
  const workflows = discoverWorkflows(cwd, polpoDir);

  if (workflows.length === 0) {
    store.log("No workflows available", [
      seg("No workflows. ", "gray"),
      seg("Create them in .polpo/workflows/<name>/workflow.json", "gray"),
    ]);
    return;
  }

  for (const wf of workflows) {
    const params = wf.parameters.length > 0
      ? ` (${wf.parameters.map(p => p.required ? p.name : `${p.name}?`).join(", ")})`
      : "";
    store.log(`${wf.name}${params}`, [
      seg(wf.name, undefined, true),
      seg(params, "gray"),
      seg(` — ${wf.description}`, "gray"),
    ]);
  }
}

function workflowPicker(
  polpo: import("../../core/orchestrator.js").Orchestrator,
  store: import("../store.js").TUIStore,
) {
  const { cwd, polpoDir } = getWorkflowPaths(polpo);
  const workflows = discoverWorkflows(cwd, polpoDir);

  if (workflows.length === 0) {
    store.log("No workflows available", [
      seg("No workflows. ", "gray"),
      seg("Create them in .polpo/workflows/<name>/workflow.json", "gray"),
    ]);
    return;
  }

  store.navigate({
    id: "picker",
    title: `Workflows (${workflows.length})`,
    items: workflows.map((w) => ({
      label: w.name,
      value: w.name,
      description: w.description + (w.parameters.length > 0
        ? ` [${w.parameters.map(p => p.required ? p.name : `${p.name}?`).join(", ")}]`
        : ""),
    })),
    hint: "Enter view details  Esc back",
    onSelect: (_idx, wfName) => {
      const wf = workflows.find(w => w.name === wfName);
      if (wf) showWorkflowDetail(wf, polpo, store);
    },
    onCancel: () => store.goMain(),
  });
}

function showWorkflowDetail(
  wf: import("../../core/workflow.js").WorkflowInfo,
  polpo: import("../../core/orchestrator.js").Orchestrator,
  store: import("../store.js").TUIStore,
) {
  const { cwd, polpoDir } = getWorkflowPaths(polpo);
  const full = loadWorkflow(cwd, polpoDir, wf.name);
  if (!full) {
    store.log(`Failed to load workflow: ${wf.name}`, [seg(`Failed to load: ${wf.name}`, "red")]);
    return;
  }

  type Seg = import("../store.js").Seg;
  const sg = (text: string, color?: string, bold?: boolean, dim?: boolean): Seg =>
    ({ text, color, bold, dim });

  const richContent: Seg[][] = [
    [sg(wf.description, "white")],
    [],
  ];

  if (wf.parameters.length > 0) {
    richContent.push([sg("Parameters:", "gray", true)]);
    for (const p of wf.parameters) {
      const req = p.required ? sg("* ", "red") : sg("  ", "gray");
      const defStr = p.default !== undefined ? ` (default: ${p.default})` : "";
      const enumStr = p.enum ? ` [${p.enum.join("|")}]` : "";
      richContent.push([req, sg(p.name, "cyan", true), sg(` ${p.type ?? "string"}${defStr}${enumStr}`, "gray")]);
      richContent.push([sg(`    ${p.description}`, "gray")]);
    }
    richContent.push([]);
  }

  richContent.push([sg("Plan Template:", "gray", true)]);
  const planJson = JSON.stringify(full.plan, null, 2);
  for (const line of planJson.split("\n")) {
    richContent.push([sg(line, "gray")]);
  }

  const plainContent = richContent.map(segs => segs.map(s => s.text).join("")).join("\n");

  const usage = wf.parameters.length > 0
    ? `/workflow ${wf.name} ${wf.parameters.map(p => `${p.name}=${p.default ?? "..."}`).join(" ")}`
    : `/workflow ${wf.name}`;

  richContent.push([]);
  richContent.push([sg("Usage: ", "gray", true), sg(usage, "cyan")]);

  store.navigate({
    id: "viewer",
    title: wf.name,
    content: plainContent,
    richContent,
    actions: ["Close"],
    onAction: () => store.goMain(),
    onClose: () => store.goMain(),
  });
}

function workflowRun(
  polpo: import("../../core/orchestrator.js").Orchestrator,
  store: import("../store.js").TUIStore,
  name: string,
  paramArgs: string[],
) {
  const { cwd, polpoDir } = getWorkflowPaths(polpo);
  const workflow = loadWorkflow(cwd, polpoDir, name);

  if (!workflow) {
    const available = discoverWorkflows(cwd, polpoDir);
    store.log(`Workflow not found: ${name}`, [
      seg(`Workflow not found: ${name}`, "red"),
      available.length > 0
        ? seg(` (available: ${available.map(w => w.name).join(", ")})`, "gray")
        : seg(" (no workflows available)", "gray"),
    ]);
    return;
  }

  // Parse key=value params
  const params: Record<string, string> = {};
  for (const arg of paramArgs) {
    const eq = arg.indexOf("=");
    if (eq === -1) {
      params[arg] = "true";
    } else {
      params[arg.slice(0, eq)] = arg.slice(eq + 1);
    }
  }

  // Validate
  const validation = validateParams(workflow, params);
  if (!validation.valid) {
    store.log(`Parameter errors for ${name}`, [
      seg("Parameter errors: ", "red"),
      seg(validation.errors.join("; "), "red"),
    ]);
    return;
  }

  // Instantiate
  try {
    const instance = instantiateWorkflow(workflow, validation.resolved);

    const plan = polpo.savePlan({
      data: instance.data,
      prompt: instance.prompt,
      name: instance.name,
    });

    const result = polpo.executePlan(plan.id);
    store.log(`Workflow "${workflow.name}" executed`, [
      seg("▶ ", "blue", true),
      seg(workflow.name, undefined, true),
      seg(` → ${result.tasks.length} task(s)`, "gray"),
    ]);
    kickRun(polpo, store);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    store.log(`Workflow error: ${msg}`, [seg(`Error: ${msg}`, "red")]);
  }
}
