import chalk from "chalk";
import type { CommandAPI } from "../types.js";
import { theme } from "../theme.js";
import { kickRun } from "../format.js";
import { PickerOverlay } from "../overlays/picker.js";
import { ViewerOverlay } from "../overlays/viewer.js";
import { EditorOverlay } from "../overlays/editor-page.js";
import { ConfirmOverlay } from "../overlays/confirm.js";

export function cmdMissions(api: CommandAPI): void {
  const { polpo, tui, args } = api;
  const missions = polpo.getAllMissions();

  if (args[0] === "list") {
    if (missions.length === 0) {
      tui.logSystem("No missions");
    } else {
      const lines = missions.map((p) => {
        const status =
          p.status === "active"
            ? theme.inProgress("active")
            : p.status === "completed"
              ? theme.done("completed")
              : p.status === "failed"
                ? theme.failed("failed")
                : theme.dim(p.status);
        return `  ${status} ${p.name}`;
      });
      tui.logSystem(theme.bold("Missions:") + "\n" + lines.join("\n"));
    }
    tui.requestRender();
    return;
  }

  if (args[0] === "new") {
    const template = JSON.stringify(
      {
        group: "new-mission",
        tasks: [
          { title: "Task 1", description: "Description", assignTo: "" },
        ],
      },
      null,
      2,
    );
    const editor = new EditorOverlay({
      title: "New Mission (JSON)",
      initialText: template,
      tui: tui.tuiInstance,
      onSave: (text) => {
        tui.hideOverlay();
        try {
          const data = JSON.parse(text);
          polpo.saveMission({ data: JSON.stringify(data), name: data.group });
          tui.logSystem(`Mission saved: ${data.group ?? "unnamed"}`);
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          tui.logSystem(`Invalid JSON: ${msg}`);
        }
        tui.requestRender();
      },
      onCancel: () => tui.hideOverlay(),
    });
    tui.showOverlay(editor);
    return;
  }

  if (missions.length === 0) {
    tui.logSystem("No missions. Use /missions new to create one.");
    tui.requestRender();
    return;
  }

  const items = missions.map((p) => ({
    value: p.id,
    label: p.name,
    description: p.status,
  }));

  const picker = new PickerOverlay({
    title: "Missions",
    items,
    hint: "Enter: view · e: edit · x: execute · d: delete",
    onSelect: (item) => {
      tui.hideOverlay();
      showMissionDetail(api, item.value);
    },
    onCancel: () => tui.hideOverlay(),
  });
  tui.showOverlay(picker);
}

function showMissionDetail(api: CommandAPI, missionId: string): void {
  const { polpo, tui } = api;
  const mission = polpo.getMission(missionId);
  if (!mission) {
    tui.logSystem(`Mission not found: ${missionId}`);
    tui.requestRender();
    return;
  }

  const lines: string[] = [];
  lines.push(chalk.bold(mission.name));
  lines.push(`Status: ${mission.status}`);
  if (mission.prompt) lines.push(`Prompt: ${mission.prompt}`);
  lines.push("");
  lines.push(chalk.bold("Mission data:"));
  try {
    const parsed = JSON.parse(mission.data);
    lines.push(JSON.stringify(parsed, null, 2));
  } catch {
    lines.push(mission.data ?? "[no data]");
  }

  const actions = [];
  if (mission.status === "draft") {
    actions.push({
      label: "Execute",
      handler: () => {
        tui.hideOverlay();
        polpo.executeMission(mission.id);
        kickRun(polpo);
        tui.logSystem(`Executing mission: ${mission.name}`);
        tui.requestRender();
      },
    });
  }
  if (mission.status === "failed" || mission.status === "active") {
    actions.push({
      label: "Resume",
      handler: () => {
        tui.hideOverlay();
        polpo.resumeMission(mission.id);
        kickRun(polpo);
        tui.logSystem(`Resuming mission: ${mission.name}`);
        tui.requestRender();
      },
    });
  }
  actions.push({
    label: "Edit",
    handler: () => {
      tui.hideOverlay();
      const editor = new EditorOverlay({
        title: `Edit Mission: ${mission.name}`,
        initialText: mission.data ?? "{}",
        tui: tui.tuiInstance,
        onSave: (text) => {
          tui.hideOverlay();
          try {
            JSON.parse(text); // validate
            polpo.updateMission(mission.id, { data: text });
            tui.logSystem(`Mission updated: ${mission.name}`);
          } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            tui.logSystem(`Invalid JSON: ${msg}`);
          }
          tui.requestRender();
        },
        onCancel: () => tui.hideOverlay(),
      });
      tui.showOverlay(editor);
    },
  });
  actions.push({
    label: "Delete",
    handler: () => {
      tui.hideOverlay();
      const confirm = new ConfirmOverlay({
        message: `Delete mission "${mission.name}"?`,
        onConfirm: () => {
          tui.hideOverlay();
          polpo.deleteMission(mission.id);
          tui.logSystem(`Deleted mission: ${mission.name}`);
          tui.requestRender();
        },
        onCancel: () => tui.hideOverlay(),
      });
      tui.showOverlay(confirm);
    },
  });
  actions.push({ label: "Close", handler: () => tui.hideOverlay() });

  const viewer = new ViewerOverlay({
    title: `Mission: ${mission.name}`,
    content: lines.join("\n"),
    actions,
    onClose: () => tui.hideOverlay(),
  });
  tui.showOverlay(viewer);
}
