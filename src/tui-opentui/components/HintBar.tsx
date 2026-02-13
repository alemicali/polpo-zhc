import { useTUIStore } from "../../tui/store.js";

/**
 * 1-line hint bar at the bottom.
 * Shows current mode, shortcuts, and working directory.
 */
export function HintBar({ width }: { width: number }) {
  const inputMode = useTUIStore((s) => s.inputMode);
  const workDir = useTUIStore((s) => s.workDir);
  const orchestrator = useTUIStore((s) => s.orchestrator);

  const modeColors: Record<string, string> = {
    task: "#00FFFF",
    plan: "#FFFF00",
    chat: "#FF00FF",
  };
  const modeNames: Record<string, string> = {
    task: "Task",
    plan: "Plan",
    chat: "Chat",
  };

  // Show active plan name when in plan mode
  let planTag = "";
  if (inputMode === "plan" && orchestrator) {
    const active = orchestrator.getResumablePlans().find((p) => p.status === "active");
    if (active) {
      planTag = active.name;
    }
  }

  // Truncate workDir
  const maxCwd = 30;
  const cwd = workDir.length > maxCwd ? "…" + workDir.slice(-(maxCwd - 1)) : workDir;

  return (
    <box style={{ width, height: 1 }}>
      <text>
        {" "}
        <span fg={modeColors[inputMode]}>{modeNames[inputMode]}</span>
        {planTag ? (
          <span fg="#FFFF00"> [{planTag}]</span>
        ) : inputMode === "plan" ? (
          <span fg="#888888"> [no active plan]</span>
        ) : null}
        <span fg="#888888">  │  </span>
        <span fg="#00FFFF">Alt+T</span>
        <span fg="#888888"> mode  </span>
        <span fg="#00FFFF">/</span>
        <span fg="#888888"> cmds  </span>
        <span fg="#00FFFF">Ctrl+O</span>
        <span fg="#888888"> tasks  </span>
        <span fg="#00FFFF">Ctrl+C</span>
        <span fg="#888888"> quit</span>
        {"".padEnd(Math.max(1, width - 65 - cwd.length))}
        <span fg="#888888">{cwd}</span>
        {" "}
      </text>
    </box>
  );
}
