import chalk from "chalk";
import type { CommandAPI } from "../types.js";
import { theme } from "../theme.js";
import { PickerOverlay } from "../overlays/picker.js";
import { ViewerOverlay } from "../overlays/viewer.js";

export async function cmdSkills(api: CommandAPI): Promise<void> {
  const { polpo, tui, args } = api;
  const sub = args[0]?.toLowerCase();
  const polpoDir = polpo.getPolpoDir();
  const workDir = polpo.getWorkDir();

  // Dynamic imports to avoid circular deps
  const { installSkills, removeSkill, listSkillsWithAssignments } =
    await import("../../llm/skills.js");

  if (sub === "add" && args.length > 1) {
    const source = args.slice(1).join(" ").trim();
    tui.logSystem(`Installing skills from: ${source}`);
    tui.requestRender();
    try {
      const result = installSkills(source, polpoDir);
      for (const s of result.installed) {
        tui.logSystem(theme.done(`  Installed: ${s.name}`));
      }
      for (const s of result.skipped) {
        tui.logSystem(theme.dim(`  Skipped: ${s.name}`));
      }
      for (const e of result.errors) {
        tui.logSystem(theme.error(`  Error: ${e}`));
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      tui.logSystem(theme.error(`Install failed: ${msg}`));
    }
    tui.requestRender();
    return;
  }

  if (sub === "assign" && args.length > 2) {
    const skillName = args[1]!;
    const agentName = args.slice(2).join(" ").trim();
    const agentNames = polpo.getAgents().map((a) => a.name);
    const allSkills = listSkillsWithAssignments(workDir, polpoDir, agentNames);
    const skill = allSkills.find((s) => s.name === skillName);
    if (!skill) {
      tui.logSystem(theme.error(`Skill not found: ${skillName}`));
      tui.requestRender();
      return;
    }
    if (!agentNames.includes(agentName)) {
      tui.logSystem(theme.error(`Agent not found: ${agentName}`));
      tui.requestRender();
      return;
    }
    try {
      const { assignSkillToAgent } = await import("../../llm/skills.js");
      assignSkillToAgent(polpoDir, agentName, skillName, skill.path ?? "");
      tui.logSystem(theme.done(`Assigned "${skillName}" to ${agentName}`));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      tui.logSystem(theme.error(`Assign failed: ${msg}`));
    }
    tui.requestRender();
    return;
  }

  if (sub === "remove" && args.length > 1) {
    const name = args.slice(1).join(" ").trim();
    try {
      const removed = removeSkill(polpoDir, name);
      if (removed) {
        tui.logSystem(theme.done(`Removed skill: ${name}`));
      } else {
        tui.logSystem(theme.dim(`Skill not found: ${name}`));
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      tui.logSystem(theme.error(`Remove failed: ${msg}`));
    }
    tui.requestRender();
    return;
  }

  // List / picker
  const agentNames = polpo.getAgents().map((a) => a.name);
  const skills = listSkillsWithAssignments(workDir, polpoDir, agentNames);
  if (skills.length === 0) {
    tui.logSystem(
      "No skills installed. Use /skills add <source> to install.",
    );
    tui.requestRender();
    return;
  }

  if (sub === "list") {
    for (const skill of skills) {
      const agents = skill.assignedTo?.length
        ? theme.dim(` → ${skill.assignedTo.join(", ")}`)
        : "";
      tui.logSystem(`  ${theme.info(skill.name)}${agents}`);
    }
    tui.requestRender();
    return;
  }

  const items = skills.map((s) => ({
    value: s.name,
    label: s.name,
    description: s.description ?? "",
  }));

  const picker = new PickerOverlay({
    title: "Skills",
    items,
    onSelect: (item) => {
      tui.hideOverlay();
      const skill = skills.find((s) => s.name === item.value);
      if (!skill) return;

      const lines: string[] = [];
      lines.push(chalk.bold(skill.name));
      if (skill.description) lines.push(skill.description);
      if (skill.source) lines.push(`Source: ${skill.source}`);
      if (skill.assignedTo?.length)
        lines.push(`Assigned to: ${skill.assignedTo.join(", ")}`);
      if (skill.path) lines.push(`Path: ${skill.path}`);

      const viewer = new ViewerOverlay({
        title: `Skill: ${skill.name}`,
        content: lines.join("\n"),
        onClose: () => tui.hideOverlay(),
      });
      tui.showOverlay(viewer);
    },
    onCancel: () => tui.hideOverlay(),
  });
  tui.showOverlay(picker);
}
