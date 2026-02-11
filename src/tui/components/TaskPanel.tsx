import { Box, Text } from "ink";
import { useTUIStore } from "../store.js";
import type { Task, TaskStatus } from "../../core/types.js";
import { formatElapsed } from "../formatters.js";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** A colored segment within a line */
type Seg = { text: string; color?: string; bold?: boolean; dim?: boolean };
/** A line is an array of colored segments */
type Line = Seg[];

function seg(text: string, color?: string, bold?: boolean, dim?: boolean): Seg {
  return { text, color, bold, dim };
}

function getStatusIcon(status: TaskStatus): string {
  switch (status) {
    case "pending": return "○";
    case "assigned": return "◉";
    case "in_progress": return "●";
    case "review": return "●";
    case "done": return "●";
    case "failed": return "✗";
  }
}

function getStatusColor(status: TaskStatus): string {
  switch (status) {
    case "pending": return "gray";
    case "assigned": return "cyan";
    case "in_progress": return "yellow";
    case "review": return "magenta";
    case "done": return "green";
    case "failed": return "red";
  }
}

/**
 * Task panel — bordered, label "Tasks", detailed rendering matching old blessed TUI.
 * Shows summary, progress bar, plan groups, activity lines, blinking icons with colors.
 */
export function TaskPanel({ width, height }: { width: number; height: number }) {
  const state = useTUIStore((s) => s.state);
  const frame = useTUIStore((s) => s.frame);

  const tasks = state?.tasks ?? [];
  const processes = state?.processes ?? [];
  const innerW = Math.max(1, width - 2);
  const innerH = Math.max(1, height - 2);

  // Build top border with label
  const labelText = " Tasks ";
  const topRight = Math.max(0, innerW - labelText.length - 1);
  const topBorder = `┌${labelText}${"─".repeat(topRight)}┐`;
  const bottomBorder = `└${"─".repeat(innerW)}┘`;

  // Build content lines as arrays of colored segments
  const lines: Line[] = [];

  if (tasks.length === 0) {
    lines.push([seg("No tasks", "gray")]);
  } else {
    const spin = SPINNER[frame % SPINNER.length]!;
    const blinkPhase = frame % 3;

    // Count by status
    const counts: Record<string, number> = {};
    for (const t of tasks) counts[t.status] = (counts[t.status] || 0) + 1;

    // Summary line with colored counts
    const summarySegs: Seg[] = [];
    if (counts["done"]) {
      if (summarySegs.length > 0) summarySegs.push(seg(" | ", "gray"));
      summarySegs.push(seg(`${counts["done"]} done`, "green"));
    }
    const running = (counts["in_progress"] || 0) + (counts["assigned"] || 0) + (counts["review"] || 0);
    if (running) {
      if (summarySegs.length > 0) summarySegs.push(seg(" | ", "gray"));
      summarySegs.push(seg(`${running} running`, "yellow"));
    }
    if (counts["pending"]) {
      if (summarySegs.length > 0) summarySegs.push(seg(" | ", "gray"));
      summarySegs.push(seg(`${counts["pending"]} pending`, "gray"));
    }
    if (counts["failed"]) {
      if (summarySegs.length > 0) summarySegs.push(seg(" | ", "gray"));
      summarySegs.push(seg(`${counts["failed"]} failed`, "red"));
    }
    lines.push(summarySegs);
    lines.push([seg("")]);

    // Progress bar with colored fills
    const total = tasks.length;
    const doneN = counts["done"] || 0;
    const failN = counts["failed"] || 0;
    const pct = Math.round(((doneN + failN) / total) * 100);
    const barLen = Math.max(8, innerW - 5);
    const greenFill = Math.round((doneN / total) * barLen);
    const redFill = Math.round((failN / total) * barLen);
    const grayFill = Math.max(0, barLen - greenFill - redFill);
    const barSegs: Seg[] = [];
    if (greenFill > 0) barSegs.push(seg("█".repeat(greenFill), "green"));
    if (redFill > 0) barSegs.push(seg("█".repeat(redFill), "red"));
    if (grayFill > 0) barSegs.push(seg("░".repeat(grayFill), "gray"));
    barSegs.push(seg(` ${pct}%`, undefined, false, true));
    lines.push(barSegs);
    lines.push([seg("")]);

    // Build chronological entries: standalone tasks + plan groups
    type Entry =
      | { type: "task"; task: Task; ts: string }
      | { type: "group"; name: string; tasks: Task[]; ts: string };
    const entries: Entry[] = [];
    const groups = new Map<string, Task[]>();

    for (const t of tasks) {
      if (t.group) {
        if (!groups.has(t.group)) groups.set(t.group, []);
        groups.get(t.group)!.push(t);
      } else {
        entries.push({ type: "task", task: t, ts: t.createdAt });
      }
    }
    for (const [name, grpTasks] of groups) {
      const earliest = grpTasks.reduce(
        (min, t) => (t.createdAt < min ? t.createdAt : min),
        grpTasks[0]!.createdAt,
      );
      entries.push({ type: "group", name, tasks: grpTasks, ts: earliest });
    }
    entries.sort((a, b) => a.ts.localeCompare(b.ts));

    const taskIcon = (task: Task): { icon: string; color: string } => {
      const isRunning = ["in_progress", "assigned", "review"].includes(task.status);
      if (isRunning) {
        const icon = blinkPhase === 2 ? "○" : "●";
        const color = blinkPhase === 0 ? "#ff8800" : blinkPhase === 1 ? "#cc6600" : "#884400";
        return { icon, color };
      }
      return { icon: getStatusIcon(task.status), color: getStatusColor(task.status) };
    };

    const truncTitle = (title: string, avail: number) => {
      const max = Math.max(6, avail);
      return title.length > max ? title.slice(0, max - 1) + "…" : title;
    };

    const renderTaskLine = (task: Task, indent: string) => {
      const { icon, color: iconColor } = taskIcon(task);
      const segs: Seg[] = [];

      // Indent (cyan for plan group borders)
      if (indent) {
        segs.push(seg(indent, "cyan"));
      }

      // Colored icon
      segs.push(seg(icon, iconColor));
      segs.push(seg(" "));

      // Title
      const score = task.result?.assessment?.globalScore;
      let phaseTag = "";
      if (task.phase === "fix") phaseTag = ` fix ${task.fixAttempts ?? 1}`;
      else if (task.phase === "review") phaseTag = " review";

      const overhead = indent.length + 2 + (score !== undefined ? 5 : 0) + phaseTag.length;
      const title = truncTitle(task.title, innerW - overhead);
      segs.push(seg(title));

      // Phase tag
      if (task.phase === "fix") {
        segs.push(seg(` fix ${task.fixAttempts ?? 1}`, "magenta"));
      } else if (task.phase === "review") {
        segs.push(seg(" review", "yellow"));
      }

      // Score
      if (score !== undefined) {
        const scoreColor = score >= 4 ? "green" : score >= 3 ? "yellow" : "red";
        segs.push(seg(` ${score.toFixed(1)}`, scoreColor));
      }

      lines.push(segs);

      // Activity line for running tasks
      const proc = processes.find((p) => p.taskId === task.id);
      if (proc?.alive && proc.activity) {
        const act = proc.activity;
        const actParts: string[] = [];
        if (act.lastTool) {
          const file = act.lastFile ? ` ${act.lastFile.split("/").pop() ?? ""}` : "";
          actParts.push(`${act.lastTool}${file}`);
        }
        if (act.toolCalls > 0) actParts.push(`${act.toolCalls} calls`);
        const fCount = (act.filesCreated?.length || 0) + (act.filesEdited?.length || 0);
        if (fCount > 0) actParts.push(`${fCount} files`);
        if (actParts.length > 0) {
          const actSegs: Seg[] = [];
          if (indent) actSegs.push(seg(indent, "cyan"));
          actSegs.push(seg("  "));
          actSegs.push(seg(spin, "cyan"));
          actSegs.push(seg(` ${actParts.join(" · ")}`, "gray"));
          lines.push(actSegs);
        }
      }
    };

    const renderTaskList = (taskList: Task[], baseIndent: string) => {
      const order: Record<string, number> = {
        in_progress: 0, assigned: 0, review: 0,
        pending: 1, done: 2, failed: 3,
      };
      const sorted = [...taskList].sort(
        (a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9),
      );

      for (const task of sorted) {
        renderTaskLine(task, baseIndent);
        const localDeps = (task.dependsOn || []).filter((d) =>
          taskList.some((t) => t.id === d && t.status !== "done"),
        );
        if (localDeps.length > 0 && task.status === "pending") {
          const depNames = localDeps.map((d) => {
            const dep = taskList.find((t) => t.id === d);
            return dep ? dep.title.slice(0, 15) : d.slice(0, 6);
          });
          lines.push([
            seg(baseIndent, "cyan"),
            seg(`  ⏳ after: ${depNames.join(", ")}`, "gray"),
          ]);
        }
      }
    };

    // Render entries in chronological order
    for (const entry of entries) {
      if (entry.type === "task") {
        renderTaskLine(entry.task, "");
      } else {
        const groupTasks = entry.tasks;
        if (lines.length > 4) lines.push([seg("")]);
        const gDone = groupTasks.filter((t) => t.status === "done").length;
        const gFailed = groupTasks.filter((t) => t.status === "failed").length;
        const gTotal = groupTasks.length;
        const allTerminal = gDone + gFailed === gTotal;

        const endTime = allTerminal
          ? groupTasks.reduce(
              (max, t) => (t.updatedAt > max ? t.updatedAt : max),
              groupTasks[0]!.updatedAt,
            )
          : new Date().toISOString();
        const elapsedMs =
          new Date(endTime).getTime() - new Date(entry.ts).getTime();
        const elapsedStr = formatElapsed(elapsedMs);

        const groupStatus = allTerminal
          ? gFailed > 0 ? "FAILED" : "DONE"
          : "RUNNING";
        const statusColor = groupStatus === "DONE" ? "green" : groupStatus === "FAILED" ? "red" : "yellow";

        lines.push([
          seg("┌", "cyan"),
          seg(" "),
          seg(entry.name, undefined, true),
          seg(` ${gDone}/${gTotal} `, "gray"),
          seg(groupStatus, statusColor),
          seg(` ${elapsedStr}`, "gray"),
        ]);
        renderTaskList(groupTasks, "│ ");
        lines.push([seg(`└${"─".repeat(Math.max(1, innerW - 1))}`, "cyan")]);
      }
    }

    lines.push([seg("")]);
    lines.push([seg("Ctrl+O to hide", "gray")]);
  }

  // Truncate to fit
  const visibleLines = lines.slice(0, innerH);

  return (
    <Box flexDirection="column" width={width} height={height}>
      <Text dimColor>{topBorder}</Text>
      <Box flexDirection="column" height={innerH}>
        {visibleLines.map((segs, i) => (
          <Text key={i}>
            <Text dimColor>│</Text>
            <RenderSegments segs={segs} maxW={innerW} />
            <Text dimColor>│</Text>
          </Text>
        ))}
        {/* Fill remaining empty lines */}
        {Array.from({ length: Math.max(0, innerH - visibleLines.length) }).map(
          (_, i) => (
            <Text key={`empty-${i}`}>
              <Text dimColor>│</Text>
              {" ".repeat(innerW)}
              <Text dimColor>│</Text>
            </Text>
          ),
        )}
      </Box>
      <Text dimColor>{bottomBorder}</Text>
    </Box>
  );
}

/** Render an array of colored segments, padding to maxW */
function RenderSegments({ segs, maxW }: { segs: Seg[]; maxW: number }) {
  // Calculate total visible length
  const totalLen = segs.reduce((sum, s) => sum + s.text.length, 0);
  const pad = Math.max(0, maxW - totalLen);

  return (
    <>
      {segs.map((s, i) => (
        <Text key={i} color={s.color} bold={s.bold} dimColor={s.dim}>
          {s.text}
        </Text>
      ))}
      {pad > 0 ? <Text>{" ".repeat(pad)}</Text> : null}
    </>
  );
}
