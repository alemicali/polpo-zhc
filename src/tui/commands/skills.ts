/**
 * /skills — browse, install, and assign skills.
 * /skills              → picker with all available skills
 * /skills list         → inline summary
 * /skills add <source> → install skills from GitHub/local
 * /skills assign <skill> <agent> → assign skill to agent
 * /skills remove <name> → remove from pool
 */

import type { CommandAPI } from "./types.js";
import { seg } from "../format.js";
import {
  discoverSkills,
  installSkills,
  removeSkill,
  assignSkillToAgent,
  listSkillsWithAssignments,
} from "../../llm/skills.js";
import { resolve } from "node:path";
import { existsSync, readdirSync } from "node:fs";

export function cmdSkills({ polpo, store, args }: CommandAPI) {
  const sub = args[0]?.toLowerCase();

  if (sub === "list" || sub === "ls") {
    skillsListInline(polpo, store);
  } else if (sub === "add" && args[1]) {
    skillsAdd(polpo, store, args[1], args.slice(2));
  } else if (sub === "assign" && args[1] && args[2]) {
    skillsAssign(polpo, store, args[1], args[2]);
  } else if (sub === "remove" || sub === "rm") {
    if (args[1]) {
      skillsRemove(polpo, store, args[1]);
    } else {
      store.log("Usage: /skills remove <name>", [seg("Usage: /skills remove <name>", "gray")]);
    }
  } else if (sub && sub !== "help") {
    store.log("Unknown skills subcommand", [
      seg(`Unknown subcommand: ${sub}. `, "red"),
      seg("Use: list, add, assign, remove", "gray"),
    ]);
  } else {
    skillsPicker(polpo, store);
  }
}

function getPolpoPaths(polpo: import("../../core/orchestrator.js").Orchestrator) {
  return {
    cwd: polpo.getWorkDir(),
    polpoDir: polpo.getPolpoDir?.() ?? resolve(polpo.getWorkDir(), ".polpo"),
  };
}

function getAgentNames(polpoDir: string): string[] {
  const agentsDir = resolve(polpoDir, "agents");
  if (!existsSync(agentsDir)) return [];
  try {
    return readdirSync(agentsDir, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name);
  } catch { return []; }
}

function skillsListInline(
  polpo: import("../../core/orchestrator.js").Orchestrator,
  store: import("../store.js").TUIStore,
) {
  const { cwd, polpoDir } = getPolpoPaths(polpo);
  const agentNames = getAgentNames(polpoDir);
  const skills = listSkillsWithAssignments(cwd, polpoDir, agentNames);

  if (skills.length === 0) {
    store.log("No skills installed", [
      seg("No skills. ", "gray"),
      seg("Install with: /skills add <owner/repo>", "gray"),
    ]);
    return;
  }

  for (const skill of skills) {
    const sourceTag = skill.source === "global" ? " [global]" : "";
    const agents = skill.assignedTo.length > 0
      ? ` → ${skill.assignedTo.join(", ")}`
      : " (unassigned)";

    store.log(`${skill.name}${sourceTag}${agents}`, [
      seg(skill.name, undefined, true),
      seg(sourceTag, "gray"),
      seg(agents, skill.assignedTo.length > 0 ? "cyan" : "gray"),
      skill.description ? seg(` — ${skill.description}`, "gray") : seg("", "gray"),
    ]);
  }
}

function skillsPicker(
  polpo: import("../../core/orchestrator.js").Orchestrator,
  store: import("../store.js").TUIStore,
) {
  const { cwd, polpoDir } = getPolpoPaths(polpo);
  const agentNames = getAgentNames(polpoDir);
  const skills = listSkillsWithAssignments(cwd, polpoDir, agentNames);

  if (skills.length === 0) {
    store.log("No skills installed", [
      seg("No skills. ", "gray"),
      seg("Install with: /skills add <owner/repo>", "gray"),
    ]);
    return;
  }

  store.navigate({
    id: "picker",
    title: `Skills (${skills.length})`,
    items: skills.map(s => ({
      label: s.name,
      value: s.name,
      description: `${s.description || "no description"}${s.assignedTo.length > 0 ? ` [→ ${s.assignedTo.join(", ")}]` : ""}`,
    })),
    hint: "Enter view details  Esc back",
    onSelect: (_idx, skillName) => {
      const skill = skills.find(s => s.name === skillName);
      if (skill) showSkillDetail(skill, polpo, store);
    },
    onCancel: () => store.goMain(),
  });
}

function showSkillDetail(
  skill: import("../../llm/skills.js").SkillWithAssignment,
  polpo: import("../../core/orchestrator.js").Orchestrator,
  store: import("../store.js").TUIStore,
) {
  type Seg = import("../store.js").Seg;
  const sg = (text: string, color?: string, bold?: boolean): Seg =>
    ({ text, color, bold });

  const richContent: Seg[][] = [
    [sg(skill.description || "No description", "white")],
    [],
    [sg("Source: ", "gray", true), sg(skill.source, "white")],
    [sg("Path: ", "gray", true), sg(skill.path, "white")],
  ];

  if (skill.assignedTo.length > 0) {
    richContent.push([sg("Agents: ", "gray", true), sg(skill.assignedTo.join(", "), "cyan")]);
  } else {
    richContent.push([sg("Agents: ", "gray", true), sg("none (unassigned)", "gray")]);
  }

  if (skill.allowedTools && skill.allowedTools.length > 0) {
    richContent.push([sg("Tools: ", "gray", true), sg(skill.allowedTools.join(", "), "white")]);
  }

  richContent.push([]);
  richContent.push([sg("Assign: ", "gray", true), sg(`/skills assign ${skill.name} <agent>`, "cyan")]);
  richContent.push([sg("Remove: ", "gray", true), sg(`/skills remove ${skill.name}`, "cyan")]);

  const plainContent = richContent.map(segs => segs.map(s => s.text).join("")).join("\n");

  store.navigate({
    id: "viewer",
    title: skill.name,
    content: plainContent,
    richContent,
    actions: ["Close"],
    onAction: () => store.goMain(),
    onClose: () => store.goMain(),
  });
}

function skillsAdd(
  polpo: import("../../core/orchestrator.js").Orchestrator,
  store: import("../store.js").TUIStore,
  source: string,
  extraArgs: string[],
) {
  const { polpoDir } = getPolpoPaths(polpo);

  // Parse optional --skill names from extra args
  const skillNames: string[] = [];
  for (const arg of extraArgs) {
    if (arg.startsWith("--")) continue; // skip flags
    skillNames.push(arg);
  }

  store.log(`Installing skills from ${source}...`, [
    seg("Installing from ", "gray"),
    seg(source, undefined, true),
    seg("...", "gray"),
  ]);

  try {
    const result = installSkills(source, polpoDir, {
      skillNames: skillNames.length > 0 ? skillNames : undefined,
    });

    for (const skill of result.installed) {
      store.log(`Installed: ${skill.name}`, [
        seg("✓ ", "green", true),
        seg(skill.name, undefined, true),
        seg(` — ${skill.description || "no description"}`, "gray"),
      ]);
    }

    for (const skill of result.skipped) {
      store.log(`Skipped: ${skill.name}`, [
        seg("⊘ ", "yellow"),
        seg(skill.name, undefined, true),
        seg(" (already installed)", "gray"),
      ]);
    }

    for (const err of result.errors) {
      store.log(`Error: ${err}`, [seg(`✗ ${err}`, "red")]);
    }

    if (result.installed.length > 0) {
      store.log(`${result.installed.length} skill(s) installed`, [
        seg(`${result.installed.length} skill(s) installed. `, "green"),
        seg("Assign with: /skills assign <skill> <agent>", "gray"),
      ]);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    store.log(`Error: ${msg}`, [seg(`Error: ${msg}`, "red")]);
  }
}

function skillsAssign(
  polpo: import("../../core/orchestrator.js").Orchestrator,
  store: import("../store.js").TUIStore,
  skillName: string,
  agentName: string,
) {
  const { cwd, polpoDir } = getPolpoPaths(polpo);
  const pool = discoverSkills(cwd, polpoDir);
  const skill = pool.find(s => s.name === skillName);

  if (!skill) {
    store.log(`Skill not found: ${skillName}`, [
      seg(`Skill not found: ${skillName}`, "red"),
      pool.length > 0
        ? seg(` (available: ${pool.map(s => s.name).join(", ")})`, "gray")
        : seg(" (no skills installed)", "gray"),
    ]);
    return;
  }

  try {
    assignSkillToAgent(polpoDir, agentName, skillName, skill.path);
    store.log(`Assigned "${skillName}" → ${agentName}`, [
      seg("✓ ", "green", true),
      seg(skillName, undefined, true),
      seg(` → ${agentName}`, "cyan"),
    ]);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    store.log(`Error: ${msg}`, [seg(`Error: ${msg}`, "red")]);
  }
}

function skillsRemove(
  polpo: import("../../core/orchestrator.js").Orchestrator,
  store: import("../store.js").TUIStore,
  name: string,
) {
  const { polpoDir } = getPolpoPaths(polpo);
  const removed = removeSkill(polpoDir, name);

  if (removed) {
    store.log(`Removed skill: ${name}`, [
      seg("✓ Removed: ", "green"),
      seg(name, undefined, true),
    ]);
  } else {
    store.log(`Skill not found: ${name}`, [seg(`Skill not found: ${name}`, "red")]);
  }
}
