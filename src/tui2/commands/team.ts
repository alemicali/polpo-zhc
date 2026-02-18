import chalk from "chalk";
import type { Orchestrator } from "../../core/orchestrator.js";
import type { CommandAPI, TUIContext } from "../types.js";
import { theme } from "../theme.js";
import { PickerOverlay } from "../overlays/picker.js";
import { EditorOverlay } from "../overlays/editor-page.js";
import { ViewerOverlay } from "../overlays/viewer.js";
import { ConfirmOverlay } from "../overlays/confirm.js";
import type { PlanTeamData } from "../../llm/plan-generator.js";

export async function cmdTeam(api: CommandAPI): Promise<void> {
  const { polpo, tui, args } = api;
  const sub = args[0]?.toLowerCase();
  const agents = polpo.getAgents();

  if (!sub || sub === "list") {
    const lines = agents.map((a) => {
      const model = a.model ? theme.dim(` (${a.model})`) : "";
      const role = a.role ? theme.dim(` [${a.role}]`) : "";
      return `  ${theme.info(a.name)}${model}${role}`;
    });
    tui.logSystem(
      theme.bold("Team:") +
        "\n" +
        (lines.length > 0 ? lines.join("\n") : theme.dim("  No agents")),
    );
    tui.requestRender();
    return;
  }

  if (sub === "add") {
    const overlay = new EditorOverlay({
      title: "Add Agent — enter name",
      initialText: "",
      tui: tui.tuiInstance,
      onSave: (name) => {
        tui.hideOverlay();
        const trimmed = name.trim();
        if (!trimmed) {
          tui.logSystem("Agent name cannot be empty");
          tui.requestRender();
          return;
        }
        if (agents.some((a) => a.name === trimmed)) {
          tui.logSystem(`Agent "${trimmed}" already exists`);
          tui.requestRender();
          return;
        }
        polpo.addAgent({ name: trimmed, role: "developer" });
        tui.logSystem(`Added agent: ${trimmed}`);
        tui.requestRender();
      },
      onCancel: () => tui.hideOverlay(),
    });
    tui.showOverlay(overlay);
    return;
  }

  if (sub === "remove" || sub === "rm") {
    const confirmRemove = (agentName: string) => {
      const confirm = new ConfirmOverlay({
        message: `Remove agent "${agentName}"?`,
        onConfirm: () => {
          tui.hideOverlay();
          polpo.removeAgent(agentName);
          tui.logSystem(`Removed agent: ${agentName}`);
          tui.requestRender();
        },
        onCancel: () => tui.hideOverlay(),
      });
      tui.showOverlay(confirm);
    };
    const name = args.slice(1).join(" ").trim();
    if (name) {
      confirmRemove(name);
      return;
    }
    const picker = new PickerOverlay({
      title: "Remove Agent",
      items: agents.map((a) => ({
        value: a.name,
        label: a.name,
        description: a.role,
      })),
      onSelect: (item) => {
        tui.hideOverlay();
        confirmRemove(item.value);
      },
      onCancel: () => tui.hideOverlay(),
    });
    tui.showOverlay(picker);
    return;
  }

  if (sub === "edit") {
    const targetName = args.slice(1).join(" ").trim();
    const editAgent = (agentName: string) => {
      const agent = agents.find((a) => a.name === agentName);
      if (!agent) {
        tui.logSystem(`Agent not found: ${agentName}`);
        tui.requestRender();
        return;
      }
      const fields = [
        { value: "model", label: "Model", description: agent.model ?? "(not set)" },
        { value: "role", label: "Role", description: agent.role ?? "(not set)" },
        { value: "systemPrompt", label: "System Prompt", description: agent.systemPrompt ? `${agent.systemPrompt.slice(0, 40)}…` : "(not set)" },
        { value: "maxTurns", label: "Max Turns", description: String(agent.maxTurns ?? "(not set)") },
      ];
      const fieldPicker = new PickerOverlay({
        title: `Edit ${agentName}`,
        items: fields,
        onSelect: (fieldItem) => {
          tui.hideOverlay();
          const fieldName = fieldItem.value as keyof typeof agent;
          const currentValue = agent[fieldName] ?? "";
          const editorOvl = new EditorOverlay({
            title: `Edit ${agentName} — ${fieldItem.label}`,
            initialText: String(currentValue),
            tui: tui.tuiInstance,
            onSave: (newValue) => {
              tui.hideOverlay();
              // Update agent by removing and re-adding with new field value
              const updated = { ...agent };
              if (fieldName === "maxTurns") {
                const parsed = parseInt(newValue.trim(), 10);
                if (!isNaN(parsed)) (updated as any)[fieldName] = parsed;
              } else {
                (updated as any)[fieldName] = newValue.trim();
              }
              polpo.removeAgent(agentName);
              polpo.addAgent(updated);
              tui.logSystem(`Updated ${agentName}.${fieldItem.label}: ${newValue.trim()}`);
              tui.requestRender();
            },
            onCancel: () => tui.hideOverlay(),
          });
          tui.showOverlay(editorOvl);
        },
        onCancel: () => tui.hideOverlay(),
      });
      tui.showOverlay(fieldPicker);
    };

    if (targetName) {
      editAgent(targetName);
    } else {
      const picker = new PickerOverlay({
        title: "Edit Agent",
        items: agents.map((a) => ({
          value: a.name,
          label: a.name,
          description: a.role,
        })),
        onSelect: (item) => {
          tui.hideOverlay();
          editAgent(item.value);
        },
        onCancel: () => tui.hideOverlay(),
      });
      tui.showOverlay(picker);
    }
    return;
  }

  if (sub === "rename") {
    const newName = args.slice(1).join(" ").trim();
    if (newName) {
      polpo.renameTeam(newName);
      tui.logSystem(`Team renamed to: ${newName}`);
      tui.requestRender();
      return;
    }
    const currentTeam = polpo.getTeam();
    const overlay = new EditorOverlay({
      title: "Rename Team",
      initialText: currentTeam.name,
      tui: tui.tuiInstance,
      onSave: (name) => {
        tui.hideOverlay();
        const trimmed = name.trim();
        if (trimmed) {
          polpo.renameTeam(trimmed);
          tui.logSystem(`Team renamed to: ${trimmed}`);
        }
        tui.requestRender();
      },
      onCancel: () => tui.hideOverlay(),
    });
    tui.showOverlay(overlay);
    return;
  }

  if (sub === "generate" || sub === "gen") {
    const description = args.slice(1).join(" ").trim();
    if (description) {
      void generateTeamAction(description, polpo, tui);
    } else {
      // Open editor to type a description
      const overlay = new EditorOverlay({
        title: "Describe the team you need",
        initialText: "",
        tui: tui.tuiInstance,
        onSave: (text) => {
          tui.hideOverlay();
          const trimmed = text.trim();
          if (!trimmed) {
            tui.logSystem("Description cannot be empty");
            tui.requestRender();
            return;
          }
          void generateTeamAction(trimmed, polpo, tui);
        },
        onCancel: () => tui.hideOverlay(),
      });
      tui.showOverlay(overlay);
    }
    return;
  }

  tui.logSystem(`Usage: /team [list|add|remove|edit|rename|generate]`);
  tui.requestRender();
}

// ── AI Team Generation ───────────────────────────────────────────────

function formatTeamPreview(team: PlanTeamData[]): string {
  const lines: string[] = [];
  lines.push(chalk.bold(`Team (${team.length} agents)`));
  lines.push("");
  for (const agent of team) {
    lines.push(theme.info(chalk.bold(agent.name)));
    if (agent.role) lines.push(`  Role: ${agent.role}`);
    if (agent.model) lines.push(`  Model: ${theme.dim(agent.model)}`);
    if (agent.skills?.length) lines.push(`  Skills: ${agent.skills.join(", ")}`);
    if (agent.systemPrompt) {
      const preview = agent.systemPrompt.length > 120
        ? agent.systemPrompt.slice(0, 120) + "…"
        : agent.systemPrompt;
      lines.push(`  Prompt: ${theme.dim(preview)}`);
    }
    const flags: string[] = [];
    if (agent.enableBrowser) flags.push("browser");
    if (agent.enableHttp) flags.push("http");
    if (agent.enableGit) flags.push("git");
    if (agent.enableMultifile) flags.push("multifile");
    if (agent.enableDeps) flags.push("deps");
    if (flags.length) lines.push(`  Flags: ${theme.dim(flags.join(", "))}`);
    if (agent.maxTurns) lines.push(`  Max turns: ${agent.maxTurns}`);
    lines.push("");
  }
  return lines.join("\n");
}

async function generateTeamAction(
  description: string,
  polpo: Orchestrator,
  tui: TUIContext,
): Promise<void> {
  tui.setStreaming(true);
  tui.setProcessing(true, "Generating team…");
  tui.requestRender();

  try {
    const { generateTeam } = await import("../../llm/plan-generator.js");
    const { buildTeamGenPrompt } = await import("../../llm/prompts.js");
    const { resolveModelSpec } = await import("../../llm/pi-client.js");

    const systemPrompt = buildTeamGenPrompt(polpo, polpo.getWorkDir(), description);
    const model = resolveModelSpec(polpo.getConfig()?.settings?.orchestratorModel);

    const team = await generateTeam(systemPrompt, description, model);

    tui.setProcessing(false);
    tui.setStreaming(false);

    showTeamPreview(team, description, polpo, tui);
  } catch (err: unknown) {
    tui.setProcessing(false);
    tui.setStreaming(false);
    const msg = err instanceof Error ? err.message : String(err);
    tui.logSystem(`${theme.error("✗")} Team generation failed: ${msg}`);
    tui.requestRender();
  }
}

function showTeamPreview(
  team: PlanTeamData[],
  description: string,
  polpo: Orchestrator,
  tui: TUIContext,
): void {
  const content = formatTeamPreview(team);
  const viewer = new ViewerOverlay({
    title: "Generated Team",
    content,
    actions: [
      {
        label: "Apply",
        handler: () => {
          tui.hideOverlay();
          applyTeam(team, polpo, tui);
        },
      },
      {
        label: "Refine",
        handler: () => {
          tui.hideOverlay();
          const editor = new EditorOverlay({
            title: "What should be changed?",
            initialText: "",
            tui: tui.tuiInstance,
            onSave: (feedback) => {
              tui.hideOverlay();
              if (!feedback.trim()) {
                showTeamPreview(team, description, polpo, tui);
                return;
              }
              void refineTeamAction(team, description, feedback.trim(), polpo, tui);
            },
            onCancel: () => showTeamPreview(team, description, polpo, tui),
          });
          tui.showOverlay(editor);
        },
      },
      {
        label: "Cancel",
        handler: () => {
          tui.hideOverlay();
          tui.logSystem(theme.warning("Team generation cancelled"));
          tui.requestRender();
        },
      },
    ],
    onClose: () => {
      tui.hideOverlay();
      tui.logSystem(theme.warning("Team generation cancelled"));
      tui.requestRender();
    },
  });
  tui.showOverlay(viewer);
}

function applyTeam(team: PlanTeamData[], polpo: Orchestrator, tui: TUIContext): void {
  const existing = polpo.getAgents();
  const doApply = () => {
    // Remove all existing agents
    for (const agent of existing) {
      polpo.removeAgent(agent.name);
    }
    // Add new agents
    for (const agent of team) {
      polpo.addAgent({
        name: agent.name,
        role: agent.role,
        model: agent.model,
        systemPrompt: agent.systemPrompt,
        maxTurns: agent.maxTurns,
        skills: agent.skills,
        allowedTools: agent.allowedTools,
      });
    }
    tui.logSystem(`${theme.done("✓")} Applied team: ${team.map(a => a.name).join(", ")}`);
    tui.requestRender();
  };

  if (existing.length > 0) {
    const confirm = new ConfirmOverlay({
      message: `Replace ${existing.length} existing agent(s) with ${team.length} new agent(s)?`,
      onConfirm: () => {
        tui.hideOverlay();
        doApply();
      },
      onCancel: () => tui.hideOverlay(),
    });
    tui.showOverlay(confirm);
  } else {
    doApply();
  }
}

async function refineTeamAction(
  currentTeam: PlanTeamData[],
  description: string,
  feedback: string,
  polpo: Orchestrator,
  tui: TUIContext,
): Promise<void> {
  tui.setStreaming(true);
  tui.setProcessing(true, "Refining team…");
  tui.requestRender();

  try {
    const { refineTeam } = await import("../../llm/plan-generator.js");
    const { buildTeamGenPrompt } = await import("../../llm/prompts.js");
    const { resolveModelSpec } = await import("../../llm/pi-client.js");

    const systemPrompt = buildTeamGenPrompt(polpo, polpo.getWorkDir(), description);
    const model = resolveModelSpec(polpo.getConfig()?.settings?.orchestratorModel);
    const currentJson = JSON.stringify(currentTeam, null, 2);

    const refined = await refineTeam(systemPrompt, currentJson, feedback, model);

    tui.setProcessing(false);
    tui.setStreaming(false);

    showTeamPreview(refined, description, polpo, tui);
  } catch (err: unknown) {
    tui.setProcessing(false);
    tui.setStreaming(false);
    const msg = err instanceof Error ? err.message : String(err);
    tui.logSystem(`${theme.error("✗")} Team refinement failed: ${msg}`);
    tui.requestRender();
  }
}
