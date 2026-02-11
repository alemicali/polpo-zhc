import { Box, Text } from "ink";
import { useTUIStore } from "../store.js";

/**
 * 1-line hint bar at the bottom — matches old blessed TUI exactly.
 * Format: ` Mode  │  Alt+T mode  / cmds  Ctrl+O tasks  Ctrl+C quit          cwd `
 */
export function HintBar({ width }: { width: number }) {
  const inputMode = useTUIStore((s) => s.inputMode);
  const workDir = useTUIStore((s) => s.workDir);
  const orchestrator = useTUIStore((s) => s.orchestrator);

  const modeColors: Record<string, string> = {
    task: "cyan",
    plan: "yellow",
    chat: "magenta",
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
  const cwd =
    workDir.length > maxCwd ? "…" + workDir.slice(-(maxCwd - 1)) : workDir;

  return (
    <Box width={width} height={1}>
      <Text>
        {" "}
        <Text color={modeColors[inputMode]}>{modeNames[inputMode]}</Text>
        {planTag ? <Text color="yellow"> [{planTag}]</Text> : inputMode === "plan" ? <Text dimColor> [no active plan]</Text> : null}
        <Text dimColor>  │  </Text>
        <Text color="cyan">Alt+T</Text>
        <Text dimColor> mode  </Text>
        <Text color="cyan">/</Text>
        <Text dimColor> cmds  </Text>
        <Text color="cyan">Ctrl+O</Text>
        <Text dimColor> tasks  </Text>
        <Text color="cyan">Ctrl+C</Text>
        <Text dimColor> quit</Text>
        {/* Right-align cwd using padding */}
        {"".padEnd(Math.max(1, width - 65 - cwd.length))}
        <Text dimColor>{cwd}</Text>
        {" "}
      </Text>
    </Box>
  );
}
