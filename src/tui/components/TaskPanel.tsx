/**
 * TaskPanel — right sidebar: progress bar, plan tree, scores, agent activity.
 */

import { Box, Text } from "ink";
import { useStore } from "../store.js";
import { statusIcon, statusColor } from "../format.js";
import type { Task } from "../../core/types.js";

const SPINNER = ["\u28CB", "\u28D9", "\u28F9", "\u28F8", "\u28FC", "\u28F4", "\u28E6", "\u28E7", "\u28C7", "\u28CF"];

export function TaskPanel({ width, height }: { width: number; height: number }) {
  const tasks = useStore((s) => s.tasks);
  const processes = useStore((s) => s.processes);

  const done = tasks.filter((t) => t.status === "done").length;
  const running = tasks.filter((t) => t.status === "in_progress" || t.status === "review").length;
  const total = tasks.length;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  // Progress bar
  const barWidth = Math.max(8, width - 10); // reserve space for pct text
  const filled = total > 0 ? Math.round((done / total) * barWidth) : 0;
  const bar = "\u2588".repeat(filled) + "\u2591".repeat(barWidth - filled);

  // Group tasks by planGroup
  const grouped = new Map<string, Task[]>();
  const ungrouped: Task[] = [];
  for (const t of tasks) {
    if (t.group) {
      const list = grouped.get(t.group) ?? [];
      list.push(t);
      grouped.set(t.group, list);
    } else {
      ungrouped.push(t);
    }
  }

  // Build renderable lines
  const lines: React.ReactNode[] = [];
  const tick = Math.floor(Date.now() / 80) % SPINNER.length;
  const maxTitle = width - 8;

  // Plan groups
  for (const [group, groupTasks] of grouped) {
    const gDone = groupTasks.filter((t) => t.status === "done").length;
    lines.push(
      <Text key={`g-${group}`}>
        <Text color="blue" bold>{group}</Text>
        <Text color="gray"> ({gDone}/{groupTasks.length})</Text>
      </Text>,
    );
    for (const task of groupTasks) {
      lines.push(
        <TaskRow key={task.id} task={task} processes={processes} tick={tick} maxTitle={maxTitle - 2} indent />
      );
    }
  }

  // Ungrouped tasks
  for (const task of ungrouped) {
    lines.push(
      <TaskRow key={task.id} task={task} processes={processes} tick={tick} maxTitle={maxTitle} indent={false} />
    );
  }

  // Fit in available height (title 1 + stats 1 + bar 1 + blank 1 + hint 1 = 5)
  const headerLines = 5;
  const available = Math.max(0, height - headerLines);
  const visible = lines.slice(0, available);
  const overflow = lines.length - available;

  return (
    <Box
      flexDirection="column"
      width={width}
      height={height}
      borderStyle="single"
      borderColor="gray"
      paddingX={1}
    >
      {/* Title + stats */}
      <Text bold>Tasks</Text>
      <Text>
        <Text color="green">{done} done</Text>
        <Text color="gray"> | </Text>
        <Text color="#FFA500">{running} running</Text>
      </Text>

      {/* Progress bar */}
      {total > 0 && (
        <Text>
          <Text color="green">{bar}</Text>
          <Text color="gray"> {pct}%</Text>
        </Text>
      )}

      {/* Task list */}
      {visible.length > 0 && <Text> </Text>}
      {visible}

      {overflow > 0 && <Text color="gray">+{overflow} more</Text>}

      {/* Bottom hint */}
      <Box flexGrow={1} />
      <Text color="gray">Ctrl+O to hide</Text>
    </Box>
  );
}

function TaskRow({
  task,
  processes,
  tick,
  maxTitle,
  indent,
}: {
  task: Task;
  processes: { taskId?: string; agentName: string; activity: { lastTool?: string; lastFile?: string } }[];
  tick: number;
  maxTitle: number;
  indent: boolean;
}) {
  const icon =
    task.status === "in_progress" ? SPINNER[tick] : statusIcon(task.status);
  const color = statusColor(task.status);
  const prefix = indent ? "  " : "";
  const title = task.title.slice(0, maxTitle);
  const score = task.result?.assessment?.globalScore;
  const agent = processes.find((p) => p.taskId === task.id);

  return (
    <Box flexDirection="column">
      <Text>
        <Text>{prefix}</Text>
        <Text color={color}>{icon} </Text>
        <Text>{title}</Text>
        {score !== undefined && <Text color="green"> {score.toFixed(1)}</Text>}
      </Text>
      {agent && task.status === "in_progress" && agent.activity.lastTool && (
        <Text color="green" dimColor>
          {prefix}  {"↳ "}
          {agent.activity.lastTool}
          {agent.activity.lastFile ? ` → ${agent.activity.lastFile}` : ""}
        </Text>
      )}
    </Box>
  );
}
