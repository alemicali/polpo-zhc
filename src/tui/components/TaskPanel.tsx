/**
 * TaskPanel — compact right sidebar showing task status and agent activity.
 */

import { Box, Text } from "ink";
import { useStore } from "../store.js";
import { statusIcon, statusColor } from "../format.js";
import type { Task } from "../../core/types.js";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function TaskPanel({ width, height }: { width: number; height: number }) {
  const tasks = useStore((s) => s.tasks);
  const processes = useStore((s) => s.processes);

  if (tasks.length === 0) {
    return (
      <Box
        flexDirection="column"
        width={width}
        height={height}
        borderStyle="single"
        borderColor="gray"
        paddingX={1}
      >
        <Text bold color="gray">Tasks</Text>
        <Text color="gray" dimColor>No tasks yet</Text>
      </Box>
    );
  }

  // Counts
  const done = tasks.filter((t) => t.status === "done").length;
  const failed = tasks.filter((t) => t.status === "failed").length;
  const running = tasks.filter((t) => t.status === "in_progress" || t.status === "review").length;
  const pending = tasks.filter((t) => t.status === "pending" || t.status === "assigned").length;

  // Visible tasks (fit in available height minus header + summary)
  const available = Math.max(0, height - 4);
  const visible = tasks.slice(0, available);

  const tick = Math.floor(Date.now() / 80) % SPINNER.length;

  return (
    <Box
      flexDirection="column"
      width={width}
      height={height}
      borderStyle="single"
      borderColor="gray"
      paddingX={1}
    >
      {/* Summary line */}
      <Text>
        <Text bold>Tasks </Text>
        <Text color="green">{done}✓</Text>
        <Text> </Text>
        {failed > 0 && <Text color="red">{failed}✗ </Text>}
        {running > 0 && <Text color="cyan">{running}● </Text>}
        {pending > 0 && <Text color="gray">{pending}○</Text>}
      </Text>

      {/* Task list */}
      {visible.map((task) => (
        <TaskRow
          key={task.id}
          task={task}
          agent={processes.find((p) => p.taskId === task.id)}
          tick={tick}
          maxWidth={width - 4}
        />
      ))}

      {tasks.length > available && (
        <Text color="gray" dimColor>
          +{tasks.length - available} more
        </Text>
      )}
    </Box>
  );
}

function TaskRow({
  task,
  agent,
  tick,
  maxWidth,
}: {
  task: Task;
  agent?: { agentName: string; activity: { lastTool?: string; lastFile?: string } };
  tick: number;
  maxWidth: number;
}) {
  const icon =
    task.status === "in_progress" ? SPINNER[tick] : statusIcon(task.status);
  const color = statusColor(task.status);
  const title = task.title.slice(0, maxWidth - 4);

  return (
    <Box flexDirection="column">
      <Text>
        <Text color={color}>{icon} </Text>
        <Text>{title}</Text>
      </Text>
      {agent && task.status === "in_progress" && (
        <Text color="gray" dimColor>
          {"  "}
          {agent.agentName}
          {agent.activity.lastTool ? ` ${agent.activity.lastTool}` : ""}
        </Text>
      )}
    </Box>
  );
}
