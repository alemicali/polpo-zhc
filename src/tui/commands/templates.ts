/**
 * /template — discover, inspect, and execute reusable mission templates.
 * /template              → picker with all available templates
 * /template list         → inline summary
 * /template <name> [k=v] → execute template with parameters
 */

import type { CommandAPI } from "./types.js";
import { seg, kickRun } from "../format.js";
import {
  discoverTemplates,
  loadTemplate,
  validateParams,
  instantiateTemplate,
} from "../../core/template.js";

export function cmdTemplates({ polpo, store, args }: CommandAPI) {
  const sub = args[0]?.toLowerCase();

  if (sub === "list" || sub === "ls") {
    templateListInline(polpo, store);
  } else if (sub && sub !== "help") {
    // Treat first arg as template name, rest as key=value params
    templateRun(polpo, store, sub, args.slice(1));
  } else {
    templatePicker(polpo, store);
  }
}

function getTemplatePaths(polpo: import("../../core/orchestrator.js").Orchestrator) {
  return {
    cwd: polpo.getWorkDir(),
    polpoDir: polpo.getPolpoDir?.() ?? undefined,
  };
}

function templateListInline(
  polpo: import("../../core/orchestrator.js").Orchestrator,
  store: import("../store.js").TUIStore,
) {
  const { cwd, polpoDir } = getTemplatePaths(polpo);
  const templates = discoverTemplates(cwd, polpoDir);

  if (templates.length === 0) {
    store.log("No templates available", [
      seg("No templates. ", "gray"),
      seg("Create them in .polpo/templates/<name>/template.json", "gray"),
    ]);
    return;
  }

  for (const tpl of templates) {
    const params = tpl.parameters.length > 0
      ? ` (${tpl.parameters.map(p => p.required ? p.name : `${p.name}?`).join(", ")})`
      : "";
    store.log(`${tpl.name}${params}`, [
      seg(tpl.name, undefined, true),
      seg(params, "gray"),
      seg(` — ${tpl.description}`, "gray"),
    ]);
  }
}

function templatePicker(
  polpo: import("../../core/orchestrator.js").Orchestrator,
  store: import("../store.js").TUIStore,
) {
  const { cwd, polpoDir } = getTemplatePaths(polpo);
  const templates = discoverTemplates(cwd, polpoDir);

  if (templates.length === 0) {
    store.log("No templates available", [
      seg("No templates. ", "gray"),
      seg("Create them in .polpo/templates/<name>/template.json", "gray"),
    ]);
    return;
  }

  store.navigate({
    id: "picker",
    title: `Templates (${templates.length})`,
    items: templates.map((t) => ({
      label: t.name,
      value: t.name,
      description: t.description + (t.parameters.length > 0
        ? ` [${t.parameters.map(p => p.required ? p.name : `${p.name}?`).join(", ")}]`
        : ""),
    })),
    hint: "Enter view details  Esc back",
    onSelect: (_idx, tplName) => {
      const tpl = templates.find(t => t.name === tplName);
      if (tpl) showTemplateDetail(tpl, polpo, store);
    },
    onCancel: () => store.goMain(),
  });
}

function showTemplateDetail(
  tpl: import("../../core/template.js").TemplateInfo,
  polpo: import("../../core/orchestrator.js").Orchestrator,
  store: import("../store.js").TUIStore,
) {
  const { cwd, polpoDir } = getTemplatePaths(polpo);
  const full = loadTemplate(cwd, polpoDir, tpl.name);
  if (!full) {
    store.log(`Failed to load template: ${tpl.name}`, [seg(`Failed to load: ${tpl.name}`, "red")]);
    return;
  }

  type Seg = import("../store.js").Seg;
  const sg = (text: string, color?: string, bold?: boolean, dim?: boolean): Seg =>
    ({ text, color, bold, dim });

  const richContent: Seg[][] = [
    [sg(tpl.description, "white")],
    [],
  ];

  if (tpl.parameters.length > 0) {
    richContent.push([sg("Parameters:", "gray", true)]);
    for (const p of tpl.parameters) {
      const req = p.required ? sg("* ", "red") : sg("  ", "gray");
      const defStr = p.default !== undefined ? ` (default: ${p.default})` : "";
      const enumStr = p.enum ? ` [${p.enum.join("|")}]` : "";
      richContent.push([req, sg(p.name, "cyan", true), sg(` ${p.type ?? "string"}${defStr}${enumStr}`, "gray")]);
      richContent.push([sg(`    ${p.description}`, "gray")]);
    }
    richContent.push([]);
  }

  richContent.push([sg("Mission Template:", "gray", true)]);
  const missionJson = JSON.stringify(full.mission, null, 2);
  for (const line of missionJson.split("\n")) {
    richContent.push([sg(line, "gray")]);
  }

  const plainContent = richContent.map(segs => segs.map(s => s.text).join("")).join("\n");

  const usage = tpl.parameters.length > 0
    ? `/template ${tpl.name} ${tpl.parameters.map(p => `${p.name}=${p.default ?? "..."}`).join(" ")}`
    : `/template ${tpl.name}`;

  richContent.push([]);
  richContent.push([sg("Usage: ", "gray", true), sg(usage, "cyan")]);

  store.navigate({
    id: "viewer",
    title: tpl.name,
    content: plainContent,
    richContent,
    actions: ["Close"],
    onAction: () => store.goMain(),
    onClose: () => store.goMain(),
  });
}

function templateRun(
  polpo: import("../../core/orchestrator.js").Orchestrator,
  store: import("../store.js").TUIStore,
  name: string,
  paramArgs: string[],
) {
  const { cwd, polpoDir } = getTemplatePaths(polpo);
  const template = loadTemplate(cwd, polpoDir, name);

  if (!template) {
    const available = discoverTemplates(cwd, polpoDir);
    store.log(`Template not found: ${name}`, [
      seg(`Template not found: ${name}`, "red"),
      available.length > 0
        ? seg(` (available: ${available.map(t => t.name).join(", ")})`, "gray")
        : seg(" (no templates available)", "gray"),
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
  const validation = validateParams(template, params);
  if (!validation.valid) {
    store.log(`Parameter errors for ${name}`, [
      seg("Parameter errors: ", "red"),
      seg(validation.errors.join("; "), "red"),
    ]);
    return;
  }

  // Instantiate
  try {
    const instance = instantiateTemplate(template, validation.resolved);

    const mission = polpo.saveMission({
      data: instance.data,
      prompt: instance.prompt,
      name: instance.name,
    });

    const result = polpo.executeMission(mission.id);
    store.log(`Template "${template.name}" executed`, [
      seg("▶ ", "blue", true),
      seg(template.name, undefined, true),
      seg(` → ${result.tasks.length} task(s)`, "gray"),
    ]);
    kickRun(polpo, store);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    store.log(`Template error: ${msg}`, [seg(`Error: ${msg}`, "red")]);
  }
}
