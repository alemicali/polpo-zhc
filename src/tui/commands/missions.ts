/**
 * /missions — manage missions (list, view, execute, resume, edit, delete).
 * /missions          → picker with all missions
 * /missions list     → inline summary
 * /missions execute  → pick a draft mission and execute
 * /missions resume   → pick a resumable mission and resume
 * /missions new      → open editor for new mission JSON
 */

import type { CommandAPI } from "./types.js";
import type { Mission } from "../../core/types.js";
import { seg, kickRun } from "../format.js";
import { formatMissionReadable, formatMissionRich, type MissionData } from "../../llm/mission-generator.js";

const STATUS_COLORS: Record<string, string> = {
  draft: "gray",
  active: "cyan",
  completed: "green",
  failed: "red",
  cancelled: "yellow",
};

export function cmdMissions({ polpo, store, args }: CommandAPI) {
  const sub = args[0]?.toLowerCase();

  if (sub === "new" || sub === "create") {
    missionNew(polpo, store);
  } else if (sub === "execute" || sub === "exec") {
    missionExecute(polpo, store, args[1]);
  } else if (sub === "resume") {
    missionResume(polpo, store, args[1]);
  } else if (sub === "list" || sub === "ls") {
    missionListInline(polpo, store);
  } else {
    missionPicker(polpo, store);
  }
}

function missionListInline(
  polpo: import("../../core/orchestrator.js").Orchestrator,
  store: import("../store.js").TUIStore,
) {
  const missions = polpo.getAllMissions();
  if (missions.length === 0) {
    store.log("No missions", [seg("No missions", "gray")]);
    return;
  }
  for (const mission of missions) {
    const color = STATUS_COLORS[mission.status] ?? "gray";
    store.log(`${mission.name} [${mission.status}]`, [
      seg(mission.name, undefined, true),
      seg(` [${mission.status}]`, color),
    ]);
  }
}

function missionPicker(
  polpo: import("../../core/orchestrator.js").Orchestrator,
  store: import("../store.js").TUIStore,
) {
  const missions = polpo.getAllMissions();
  if (missions.length === 0) {
    store.log("No missions. Use /missions new to create one.", [
      seg("No missions. ", "gray"),
      seg("/missions new", "cyan"),
      seg(" to create one.", "gray"),
    ]);
    return;
  }

  store.navigate({
    id: "picker",
    title: `Missions (${missions.length})`,
    items: missions.map((p) => ({
      label: p.name,
      value: p.id,
      description: `${p.status}${p.prompt ? ` — ${p.prompt.slice(0, 40)}` : ""}`,
    })),
    hint: "Enter view  e edit  x execute  r resume  d delete  Esc back",
    onSelect: (_idx, missionId) => {
      const mission = missions.find((p) => p.id === missionId);
      if (mission) showMissionDetail(mission, polpo, store);
    },
    onCancel: () => store.goMain(),
    onKey: (input, _idx, missionId) => {
      const mission = missions.find((p) => p.id === missionId);
      if (!mission) return;

      if (input === "e") {
        missionEdit(mission, polpo, store);
      } else if (input === "x") {
        store.goMain();
        executeMission(mission, polpo, store);
      } else if (input === "r") {
        store.goMain();
        resumeMissionAction(mission, polpo, store);
      } else if (input === "d") {
        store.navigate({
          id: "confirm",
          message: `Delete mission "${mission.name}"?`,
          onConfirm: () => {
            polpo.deleteMission(mission.id);
            store.goMain();
            store.log(`Deleted mission: ${mission.name}`, [
              seg("- ", "red"),
              seg(mission.name, undefined, true),
            ]);
          },
          onCancel: () => missionPicker(polpo, store),
        });
      }
    },
  });
}

/** Human-readable mission detail view */
function showMissionDetail(
  mission: Mission,
  polpo: import("../../core/orchestrator.js").Orchestrator,
  store: import("../store.js").TUIStore,
) {
  type Seg = import("../store.js").Seg;
  const sg = (text: string, color?: string, bold?: boolean, dim?: boolean): Seg =>
    ({ text, color, bold, dim });

  // Build rich metadata header
  const statusColor = STATUS_COLORS[mission.status] ?? "gray";
  const headerLines: Seg[][] = [
    [sg("Status  ", "gray", false, true), sg(mission.status, statusColor, true)],
  ];
  if (mission.prompt) {
    headerLines.push([sg("Prompt  ", "gray", false, true), sg(mission.prompt, "white")]);
  }
  headerLines.push([sg("Created ", "gray", false, true), sg(mission.createdAt, "gray")]);
  headerLines.push([sg("Updated ", "gray", false, true), sg(mission.updatedAt, "gray")]);
  headerLines.push([]);

  // Build rich mission content
  let richContent: Seg[][];
  let plainContent: string;
  try {
    const data = JSON.parse(mission.data) as MissionData;
    richContent = [...headerLines, ...formatMissionRich(data, process.stdout.columns) as Seg[][]];
    plainContent = headerLines.map(segs => segs.map(s => s.text).join("")).join("\n")
      + "\n" + formatMissionReadable(data);
  } catch {
    richContent = [...headerLines, [sg(mission.data)]];
    plainContent = headerLines.map(segs => segs.map(s => s.text).join("")).join("\n")
      + "\n" + mission.data;
  }

  const actions: string[] = [];
  if (mission.status === "draft") actions.push("Execute", "Edit");
  if (mission.status === "failed" || mission.status === "active") actions.push("Resume");
  actions.push("Edit", "Delete", "Close");
  // Deduplicate
  const uniqueActions = [...new Set(actions)];

  store.navigate({
    id: "viewer",
    title: mission.name,
    content: plainContent,
    richContent,
    actions: uniqueActions,
    onAction: (idx) => {
      const action = uniqueActions[idx];
      if (action === "Execute") {
        store.goMain();
        executeMission(mission, polpo, store);
      } else if (action === "Resume") {
        store.goMain();
        resumeMissionAction(mission, polpo, store);
      } else if (action === "Edit") {
        missionEdit(mission, polpo, store);
      } else if (action === "Delete") {
        store.navigate({
          id: "confirm",
          message: `Delete mission "${mission.name}"?`,
          onConfirm: () => {
            polpo.deleteMission(mission.id);
            store.goMain();
            store.log(`Deleted mission: ${mission.name}`, [
              seg("- ", "red"),
              seg(mission.name, undefined, true),
            ]);
          },
          onCancel: () => showMissionDetail(mission, polpo, store),
        });
      } else {
        store.goMain();
      }
    },
    onClose: () => store.goMain(),
  });
}

function missionNew(
  polpo: import("../../core/orchestrator.js").Orchestrator,
  store: import("../store.js").TUIStore,
) {
  const template = JSON.stringify({
    name: "my-mission",
    tasks: [
      {
        title: "Task 1",
        description: "Description here",
        assignTo: "agent-name",
      },
    ],
  }, null, 2);

  store.navigate({
    id: "editor",
    title: "New Mission (JSON)",
    initial: template,
    onSave: (json) => {
      try {
        JSON.parse(json); // validate
      } catch {
        store.goMain();
        store.log("Invalid JSON", [seg("Invalid JSON", "red")]);
        return;
      }
      const mission = polpo.saveMission({ data: json });
      store.goMain();
      store.log(`Mission created: ${mission.name}`, [
        seg("+ ", "green"),
        seg(mission.name, undefined, true),
        seg(" (draft)", "gray"),
      ]);
    },
    onCancel: () => store.goMain(),
  });
}

function missionEdit(
  mission: Mission,
  polpo: import("../../core/orchestrator.js").Orchestrator,
  store: import("../store.js").TUIStore,
) {
  // Pretty-print JSON for editing
  let editContent: string;
  try {
    editContent = JSON.stringify(JSON.parse(mission.data), null, 2);
  } catch {
    editContent = mission.data;
  }

  store.navigate({
    id: "editor",
    title: `Edit: ${mission.name}`,
    initial: editContent,
    onSave: (json) => {
      try {
        JSON.parse(json); // validate
      } catch {
        store.goMain();
        store.log("Invalid JSON", [seg("Invalid JSON", "red")]);
        return;
      }
      polpo.updateMission(mission.id, { data: json });
      store.goMain();
      store.log(`Updated mission: ${mission.name}`, [
        seg("✎ ", "cyan"),
        seg(mission.name, undefined, true),
      ]);
    },
    onCancel: () => store.goMain(),
  });
}

function executeMission(
  mission: Mission,
  polpo: import("../../core/orchestrator.js").Orchestrator,
  store: import("../store.js").TUIStore,
) {
  try {
    const result = polpo.executeMission(mission.id);
    store.log(`Executing mission: ${mission.name} (${result.tasks.length} tasks)`, [
      seg("▶ ", "blue", true),
      seg(mission.name, undefined, true),
      seg(` → ${result.tasks.length} tasks`, "gray"),
    ]);
    kickRun(polpo, store);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    store.log(`Execute error: ${msg}`, [seg(`Error: ${msg}`, "red")]);
  }
}

function missionExecute(
  polpo: import("../../core/orchestrator.js").Orchestrator,
  store: import("../store.js").TUIStore,
  missionIdOrName?: string,
) {
  if (missionIdOrName) {
    const mission = polpo.getMission(missionIdOrName) ?? polpo.getMissionByName(missionIdOrName);
    if (!mission) {
      store.log(`Mission not found: ${missionIdOrName}`, [seg(`Mission not found: ${missionIdOrName}`, "red")]);
      return;
    }
    executeMission(mission, polpo, store);
    return;
  }

  const drafts = polpo.getAllMissions().filter((p) => p.status === "draft");
  if (drafts.length === 0) {
    store.log("No draft missions to execute", [seg("No draft missions to execute", "gray")]);
    return;
  }

  store.navigate({
    id: "picker",
    title: "Execute mission",
    items: drafts.map((p) => ({ label: p.name, value: p.id })),
    onSelect: (_idx, missionId) => {
      store.goMain();
      const mission = polpo.getMission(missionId);
      if (mission) executeMission(mission, polpo, store);
    },
    onCancel: () => store.goMain(),
  });
}

function resumeMissionAction(
  mission: Mission,
  polpo: import("../../core/orchestrator.js").Orchestrator,
  store: import("../store.js").TUIStore,
) {
  try {
    const result = polpo.resumeMission(mission.id, { retryFailed: true });
    store.log(`Resumed mission: ${mission.name}`, [
      seg("⟳ ", "blue"),
      seg(mission.name, undefined, true),
      seg(` (${result.retried} retried, ${result.pending} pending)`, "gray"),
    ]);
    kickRun(polpo, store);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    store.log(`Resume error: ${msg}`, [seg(`Error: ${msg}`, "red")]);
  }
}

function missionResume(
  polpo: import("../../core/orchestrator.js").Orchestrator,
  store: import("../store.js").TUIStore,
  missionIdOrName?: string,
) {
  if (missionIdOrName) {
    const mission = polpo.getMission(missionIdOrName) ?? polpo.getMissionByName(missionIdOrName);
    if (!mission) {
      store.log(`Mission not found: ${missionIdOrName}`, [seg(`Mission not found: ${missionIdOrName}`, "red")]);
      return;
    }
    resumeMissionAction(mission, polpo, store);
    return;
  }

  const resumable = polpo.getResumableMissions();
  if (resumable.length === 0) {
    store.log("No resumable missions", [seg("No resumable missions", "gray")]);
    return;
  }

  store.navigate({
    id: "picker",
    title: "Resume mission",
    items: resumable.map((p) => ({
      label: p.name,
      value: p.id,
      description: p.status,
    })),
    onSelect: (_idx, missionId) => {
      store.goMain();
      const mission = polpo.getMission(missionId);
      if (mission) resumeMissionAction(mission, polpo, store);
    },
    onCancel: () => store.goMain(),
  });
}
