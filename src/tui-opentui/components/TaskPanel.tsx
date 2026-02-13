import { useTUIStore } from "../../tui/store.js";
import type { Task, TaskStatus } from "../../core/types.js";
import { formatElapsed } from "../../tui/formatters.js";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

// Blessed TUI color scheme (hex for OpenTUI)
const C = {
  grey: "#888888",
  dimGrey: "#888888",
  cyan: "#00FFFF",
  green: "#00FF00",
  red: "#FF0000",
  yellow: "#FFFF00",
  magenta: "#FF00FF",
  blue: "#0088FF",
  white: "#FFFFFF",
} as const;

/** A colored segment within a line */
type Seg = { text: string; fg?: string; bold?: boolean };
/** A line is an array of colored segments */
type Line = Seg[];

function seg(text: string, fg?: string, bold?: boolean): Seg {
  return { text, fg, bold };
}

function getStatusIcon(status: TaskStatus): string {
  switch (status) {
    case "pending": return "○";
    case "assigned": return "◉";
    case "in_progress": return "●";
    case "review": return "◎";
    case "done": return "●";
    case "failed": return "✗";
  }
}

function getStatusColor(status: TaskStatus): string {
  switch (status) {
    case "pending": return C.grey;
    case "assigned": return C.cyan;
    case "in_progress": return C.yellow;
    case "review": return C.blue;
    case "done": return C.green;
    case "failed": return C.red;
  }
}

/**
 * Task panel — grey-bordered (matching blessed TUI), with plan groups, activity, blinking icons.
 */
export function TaskPanel({ width, height }: { width: number; height: number }) {
  const state = useTUIStore((s) => s.state);
  const frame = useTUIStore((s) => s.frame);

  const tasks = state?.tasks ?? [];
  const processes = state?.processes ?? [];
  const innerW = Math.max(1, width - 2);
  const innerH = Math.max(1, height - 2);

  // Build borders
  const labelText = " Tasks ";
  const topRight = Math.max(0, innerW - labelText.length - 1);
  const bottomBorder = `└${"─".repeat(innerW)}┘`;

  // Build content lines as arrays of colored segments
  const lines: Line[] = [];

  if (tasks.length === 0) {
    lines.push([seg("  No tasks yet", C.grey)]);
    lines.push([seg("")]);
    lines.push([seg("  Type a task description", C.grey)]);
    lines.push([seg("  below and press Enter.", C.grey)]);
  } else {
    const spin = SPINNER[frame % SPINNER.length]!;
    const blinkPhase = frame % 3;

    // Count by status
    const counts: Record<string, number> = {};
    for (const t of tasks) counts[t.status] = (counts[t.status] || 0) + 1;

    // Summary line
    const summarySegs: Seg[] = [seg(" ")];
    if (counts["done"]) {
      if (summarySegs.length > 1) summarySegs.push(seg("  ", C.grey));
      summarySegs.push(seg(`${counts["done"]}`, C.green, true));
      summarySegs.push(seg(" done", C.grey));
    }
    const running = (counts["in_progress"] || 0) + (counts["assigned"] || 0) + (counts["review"] || 0);
    if (running) {
      if (summarySegs.length > 1) summarySegs.push(seg("  ", C.grey));
      summarySegs.push(seg(`${running}`, C.yellow, true));
      summarySegs.push(seg(" running", C.grey));
    }
    if (counts["pending"]) {
      if (summarySegs.length > 1) summarySegs.push(seg("  ", C.grey));
      summarySegs.push(seg(`${counts["pending"]}`, C.grey));
      summarySegs.push(seg(" pending", C.grey));
    }
    if (counts["failed"]) {
      if (summarySegs.length > 1) summarySegs.push(seg("  ", C.grey));
      summarySegs.push(seg(`${counts["failed"]}`, C.red, true));
      summarySegs.push(seg(" failed", C.grey));
    }
    lines.push(summarySegs);

    // Progress bar
    const total = tasks.length;
    const doneN = counts["done"] || 0;
    const failN = counts["failed"] || 0;
    const pct = Math.round(((doneN + failN) / total) * 100);
    const barLen = Math.max(8, innerW - 8);
    const greenFill = Math.round((doneN / total) * barLen);
    const redFill = Math.round((failN / total) * barLen);
    const grayFill = Math.max(0, barLen - greenFill - redFill);
    const barSegs: Seg[] = [seg(" ")];
    if (greenFill > 0) barSegs.push(seg("█".repeat(greenFill), C.green));
    if (redFill > 0) barSegs.push(seg("█".repeat(redFill), C.red));
    if (grayFill > 0) barSegs.push(seg("░".repeat(grayFill), C.grey));
    barSegs.push(seg(` ${pct}%`, C.dimGrey));
    lines.push(barSegs);
    lines.push([seg("")]);

    // Build entries: standalone tasks + plan groups
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

    const renderTaskLine = (task: Task, indent: string, indentColor: string = C.grey) => {
      const { icon, color: iconColor } = taskIcon(task);
      const segs: Seg[] = [];

      if (indent) {
        segs.push(seg(indent, indentColor));
      }

      segs.push(seg(icon, iconColor));
      segs.push(seg(" "));

      const score = task.result?.assessment?.globalScore;
      let phaseTag = "";
      if (task.phase === "fix") phaseTag = ` fix ${task.fixAttempts ?? 1}`;
      else if (task.phase === "review") phaseTag = " review";

      const overhead = indent.length + 2 + (score !== undefined ? 5 : 0) + phaseTag.length;
      const title = truncTitle(task.title, innerW - overhead);
      segs.push(seg(title));

      if (task.phase === "fix") {
        segs.push(seg(` fix ${task.fixAttempts ?? 1}`, C.magenta));
      } else if (task.phase === "review") {
        segs.push(seg(" review", C.yellow));
      }

      if (score !== undefined) {
        const scoreColor = score >= 4 ? C.green : score >= 3 ? C.yellow : C.red;
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
          if (indent) actSegs.push(seg(indent, indentColor));
          actSegs.push(seg("  "));
          actSegs.push(seg(spin, C.cyan));
          actSegs.push(seg(` ${actParts.join(" · ")}`, C.grey));
          lines.push(actSegs);
        }
      }
    };

    const renderTaskList = (taskList: Task[], baseIndent: string, indentColor: string = C.grey) => {
      const order: Record<string, number> = {
        in_progress: 0, assigned: 0, review: 0,
        pending: 1, done: 2, failed: 3,
      };
      const sorted = [...taskList].sort(
        (a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9),
      );

      for (const task of sorted) {
        renderTaskLine(task, baseIndent, indentColor);
        const localDeps = (task.dependsOn || []).filter((d) =>
          taskList.some((t) => t.id === d && t.status !== "done"),
        );
        if (localDeps.length > 0 && task.status === "pending") {
          const depNames = localDeps.map((d) => {
            const dep = taskList.find((t) => t.id === d);
            return dep ? dep.title.slice(0, 15) : d.slice(0, 6);
          });
          lines.push([
            seg(baseIndent, indentColor),
            seg(`  ⏳ after: ${depNames.join(", ")}`, C.grey),
          ]);
        }
      }
    };

    for (const entry of entries) {
      if (entry.type === "task") {
        renderTaskLine(entry.task, " ");
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
        const statusColor = groupStatus === "DONE" ? C.green : groupStatus === "FAILED" ? C.red : C.yellow;

        lines.push([
          seg(" ┌", C.cyan),
          seg(" "),
          seg(entry.name, undefined, true),
          seg(` ${gDone}/${gTotal} `, C.grey),
          seg(groupStatus, statusColor),
          seg(` ${elapsedStr}`, C.grey),
        ]);
        renderTaskList(groupTasks, " │ ", C.cyan);
        lines.push([seg(` └${"─".repeat(Math.max(1, innerW - 2))}`, C.cyan)]);
      }
    }
  }

  // Auto-scroll: keep bottom visible, show scroll indicator
  const totalLines = lines.length;
  const canScroll = totalLines > innerH;
  const scrollOffset = canScroll ? Math.max(0, totalLines - innerH) : 0;
  const visibleLines = lines.slice(scrollOffset, scrollOffset + innerH);

  // Scrollbar calculations
  const scrollbarH = canScroll ? Math.max(1, Math.round((innerH / totalLines) * innerH)) : 0;
  const scrollbarPos = canScroll ? Math.round((scrollOffset / (totalLines - innerH)) * (innerH - scrollbarH)) : 0;

  return (
    <box style={{ flexDirection: "column", width, height }}>
      {/* Top border with label — grey border, bold white label */}
      <text>
        <span fg={C.grey}>┌</span>
        <span bold>{labelText}</span>
        <span fg={C.grey}>{"─".repeat(topRight)}┐</span>
      </text>
      {/* Content rows */}
      {visibleLines.map((segs, i) => {
        const showScrollbar = canScroll && i >= scrollbarPos && i < scrollbarPos + scrollbarH;
        return (
          <text key={i}>
            <span fg={C.grey}>│</span>
            <RenderSegments segs={segs} maxW={innerW - (canScroll ? 1 : 0)} />
            {canScroll ? (
              <span fg={C.grey}>{showScrollbar ? "┃" : " "}</span>
            ) : null}
            <span fg={C.grey}>│</span>
          </text>
        );
      })}
      {/* Fill remaining empty lines */}
      {Array.from({ length: Math.max(0, innerH - visibleLines.length) }).map(
        (_, i) => {
          const row = visibleLines.length + i;
          const showScrollbar = canScroll && row >= scrollbarPos && row < scrollbarPos + scrollbarH;
          return (
            <text key={`empty-${i}`}>
              <span fg={C.grey}>│</span>
              {" ".repeat(innerW - (canScroll ? 1 : 0))}
              {canScroll ? (
                <span fg={C.grey}>{showScrollbar ? "┃" : " "}</span>
              ) : null}
              <span fg={C.grey}>│</span>
            </text>
          );
        },
      )}
      {/* Bottom border */}
      <text fg={C.grey}>{bottomBorder}</text>
    </box>
  );
}

/** Render an array of colored segments, padding to maxW */
function RenderSegments({ segs, maxW }: { segs: Seg[]; maxW: number }) {
  const totalLen = segs.reduce((sum, s) => sum + s.text.length, 0);
  const pad = Math.max(0, maxW - totalLen);

  return (
    <>
      {segs.map((s, i) => (
        <span key={i} fg={s.fg} bold={s.bold}>{s.text}</span>
      ))}
      {pad > 0 ? <span>{" ".repeat(pad)}</span> : null}
    </>
  );
}
