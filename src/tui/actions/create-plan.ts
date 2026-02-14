/**
 * Plan creation action — generates a YAML plan from user prompt via LLM.
 * Shows preview in viewer with Execute/Edit/Save/Refine actions.
 */

import { parse as parseYaml } from "yaml";
import type { Orchestrator } from "../../core/orchestrator.js";
import type { TUIStore } from "../store.js";
import { seg } from "../format.js";
import { querySDKText, extractYaml } from "../../llm/query.js";
import { buildPlanSystemPrompt } from "../../llm/prompts.js";

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30) || "plan";
}

function extractPlanName(yaml: string): string | undefined {
  try {
    const doc = parseYaml(yaml);
    if (doc?.name && typeof doc.name === "string") return slugify(doc.name);
  } catch { /* ignore */ }
  return undefined;
}

export async function createPlan(
  prompt: string,
  polpo: Orchestrator,
  store: TUIStore,
): Promise<void> {
  const agents = polpo.getAgents();
  if (agents.length === 0) {
    store.log("No agents configured. Use /team to add agents.", [
      seg("No agents configured. ", "red"),
      seg("Use ", "gray"),
      seg("/team", "cyan"),
      seg(" to add agents.", "gray"),
    ]);
    return;
  }

  store.setProcessing(true, "Generating plan...");

  try {
    const state = (() => {
      try { return polpo.getStore()?.getState() ?? null; }
      catch { return null; }
    })();

    const systemPrompt = buildPlanSystemPrompt(polpo, state, polpo.getWorkDir());
    const fullPrompt = [
      systemPrompt,
      "", "---", "",
      `Generate a task plan for:`,
      `"${prompt}"`,
    ].join("\n");

    const model = polpo.getConfig()?.settings?.orchestratorModel;
    const result = await querySDKText(fullPrompt, polpo.getWorkDir(), model);
    const yaml = extractYaml(result);

    store.setProcessing(false);

    if (!yaml?.trim()) {
      store.log("Plan generation returned empty result", [
        seg("Plan generation returned empty result", "red"),
      ]);
      return;
    }

    // Validate YAML
    let doc: any;
    try {
      doc = parseYaml(yaml);
      if (!doc?.tasks || !Array.isArray(doc.tasks) || doc.tasks.length === 0) {
        store.log("Plan has no tasks. Try a more specific prompt.", [
          seg("Plan has no tasks. Try a more specific prompt.", "red"),
        ]);
        return;
      }
    } catch (parseErr: unknown) {
      const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
      store.log(`Invalid YAML: ${msg}`, [seg(`Invalid YAML: ${msg}`, "red")]);
      return;
    }

    showPlanPreview(yaml, doc, prompt, polpo, store);
  } catch (err: unknown) {
    store.setProcessing(false);
    const msg = err instanceof Error ? err.message : String(err);
    store.log(`Plan generation failed: ${msg}`, [seg(`Plan error: ${msg}`, "red")]);
  }
}

function showPlanPreview(
  yaml: string,
  doc: any,
  originalPrompt: string,
  polpo: Orchestrator,
  store: TUIStore,
): void {
  const tasks = doc.tasks as any[];
  const volatileTeam = doc.team as any[] | undefined;

  // Build readable preview
  const lines: string[] = [];

  if (volatileTeam?.length) {
    lines.push("Volatile team (plan-only agents):");
    for (const a of volatileTeam) {
      lines.push(`  ${a.name} (${a.adapter || "claude-sdk"})${a.role ? ` — ${a.role}` : ""}`);
    }
    lines.push("");
  }

  lines.push(`${tasks.length} task${tasks.length !== 1 ? "s" : ""} in plan:`);
  lines.push("");

  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    const deps = t.dependsOn?.length
      ? ` ⟵ ${t.dependsOn.join(", ")}`
      : "";
    lines.push(`  ${i + 1}. ${t.title}`);
    lines.push(`     → ${t.assignTo || "default"}${deps}`);
    if (t.description && t.description !== t.title) {
      const desc = t.description.length > 120 ? t.description.slice(0, 117) + "..." : t.description;
      lines.push(`     ${desc}`);
    }
    if (t.expectations?.length) {
      const exps = t.expectations.map((e: any) => {
        if (e.type === "test") return `test: ${e.command || ""}`;
        if (e.type === "file_exists") return `files: ${(e.paths || []).join(", ")}`;
        if (e.type === "script") return `script: ${(e.command || "").split("\n")[0]}`;
        if (e.type === "llm_review") return `review: ${(e.criteria || "").slice(0, 60)}`;
        return e.type;
      });
      lines.push(`     [${exps.join("] [")}]`);
    }
    lines.push("");
  }

  store.navigate({
    id: "viewer",
    title: `Plan: ${doc.name || "generated"}`,
    content: lines.join("\n"),
    actions: ["Execute", "Save draft", "Edit YAML", "Refine", "Cancel"],
    onAction: (idx) => {
      switch (idx) {
        case 0: // Execute
          store.goMain();
          executePlanFromYaml(yaml, originalPrompt, polpo, store);
          break;
        case 1: // Save draft
          store.goMain();
          saveDraft(yaml, originalPrompt, polpo, store);
          break;
        case 2: // Edit YAML
          store.navigate({
            id: "editor",
            title: "Edit Plan YAML",
            initial: yaml,
            onSave: (edited) => {
              try {
                const newDoc = parseYaml(edited);
                if (newDoc?.tasks?.length) {
                  showPlanPreview(edited, newDoc, originalPrompt, polpo, store);
                } else {
                  store.goMain();
                  store.log("Edited plan has no tasks", [seg("Edited plan has no tasks", "red")]);
                }
              } catch {
                store.goMain();
                store.log("Invalid YAML in edited plan", [seg("Invalid YAML in edited plan", "red")]);
              }
            },
            onCancel: () => showPlanPreview(yaml, doc, originalPrompt, polpo, store),
          });
          break;
        case 3: // Refine
          store.navigate({
            id: "editor",
            title: "Refine — What should be changed?",
            initial: "",
            onSave: (feedback) => {
              if (!feedback.trim()) {
                showPlanPreview(yaml, doc, originalPrompt, polpo, store);
                return;
              }
              store.goMain();
              refinePlan(yaml, originalPrompt, feedback.trim(), polpo, store);
            },
            onCancel: () => showPlanPreview(yaml, doc, originalPrompt, polpo, store),
          });
          break;
        case 4: // Cancel
          store.goMain();
          store.log("Plan cancelled", [seg("Plan cancelled", "yellow")]);
          break;
      }
    },
    onClose: () => {
      store.goMain();
      store.log("Plan cancelled", [seg("Plan cancelled", "yellow")]);
    },
  });
}

function executePlanFromYaml(
  yaml: string,
  prompt: string,
  polpo: Orchestrator,
  store: TUIStore,
): void {
  try {
    const plan = polpo.savePlan({ yaml, prompt, name: extractPlanName(yaml) });
    const result = polpo.executePlan(plan.id);
    store.log(`Plan executed: ${plan.name} (${result.tasks.length} tasks)`, [
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

function saveDraft(
  yaml: string,
  prompt: string,
  polpo: Orchestrator,
  store: TUIStore,
): void {
  try {
    const plan = polpo.savePlan({ yaml, prompt, status: "draft", name: extractPlanName(yaml) });
    store.log(`Draft saved: ${plan.name}`, [
      seg("■ ", "blue"),
      seg(plan.name, undefined, true),
      seg(" (draft)", "gray"),
    ]);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    store.log(`Save error: ${msg}`, [seg(`Error: ${msg}`, "red")]);
  }
}

async function refinePlan(
  currentYaml: string,
  originalPrompt: string,
  feedback: string,
  polpo: Orchestrator,
  store: TUIStore,
): Promise<void> {
  store.setProcessing(true, "Refining plan...");

  try {
    const state = (() => {
      try { return polpo.getStore()?.getState() ?? null; }
      catch { return null; }
    })();

    const systemPrompt = buildPlanSystemPrompt(polpo, state, polpo.getWorkDir());
    const fullPrompt = [
      systemPrompt,
      "", "---", "",
      `Original request: "${originalPrompt}"`,
      "",
      "Current plan:",
      currentYaml,
      "",
      `User feedback: "${feedback}"`,
      "",
      "Revise the plan based on the feedback. Output ONLY valid YAML.",
    ].join("\n");

    const model = polpo.getConfig()?.settings?.orchestratorModel;
    const result = await querySDKText(fullPrompt, polpo.getWorkDir(), model);
    const newYaml = extractYaml(result);

    store.setProcessing(false);

    if (!newYaml?.trim()) {
      store.log("Refine returned empty result", [seg("Refine returned empty result", "red")]);
      return;
    }

    try {
      const doc = parseYaml(newYaml);
      if (doc?.tasks?.length) {
        showPlanPreview(newYaml, doc, originalPrompt, polpo, store);
      } else {
        store.log("Refined plan has no tasks", [seg("Refined plan has no tasks", "red")]);
      }
    } catch {
      store.log("Refined plan has invalid YAML", [seg("Refined plan has invalid YAML", "red")]);
    }
  } catch (err: unknown) {
    store.setProcessing(false);
    const msg = err instanceof Error ? err.message : String(err);
    store.log(`Refine error: ${msg}`, [seg(`Error: ${msg}`, "red")]);
  }
}
