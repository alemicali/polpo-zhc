/**
 * TaskPanel — right sidebar: Mission Control with tasks, plans, and agent activity.
 */

import { Box, Text } from "ink";
import { useStore } from "../store.js";
import { usePolpo } from "../app.js";
import { statusIcon, statusColor } from "../format.js";
import type { Task } from "../../core/types.js";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function TaskPanel({ width, height }: { width: number; height: number }) {
  const tasks = useStore((s) => s.tasks);
  const processes = useStore((s) => s.processes);
  const polpo = usePolpo();

  // Task counts
  const done = tasks.filter((t) => t.status === "done").length;
  const failed = tasks.filter((t) => t.status === "failed").length;
  const running = tasks.filter((t) => t.status === "in_progress" || t.status === "review").length;

  // Plan counts
  let plans: { status: string }[] = [];
  try { plans = polpo.getAllPlans?.() ?? []; } catch { /* */ }
  const plansActive = plans.filter((p) => p.status === "active").length;
  const plansTotal = plans.length;

  // Visible tasks (fit in available height minus header lines)
  const headerLines = 3; // title + stats line + blank
  const available = Math.max(0, height - headerLines);
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
      {/* Title */}
      <Text color="cyan" bold>🐙 Mission Control</Text>

      {/* Stats — inline */}
      <Text>
        <Text color="gray">tasks </Text>
        <Text color="blue" bold>{running > 0 ? `${done}/${tasks.length}` : `${done}/${tasks.length}`}</Text>
        {running > 0 && <Text color="cyan"> {running}●</Text>}
        {failed > 0 && <Text color="red"> {failed}✗</Text>}
        <Text color="gray">  plans </Text>
        <Text color="yellow" bold>{plansActive > 0 ? `${plansActive}/${plansTotal}` : `${plansTotal}`}</Text>
      </Text>

      {/* Task list */}
      {visible.length > 0 && <Text> </Text>}
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
        <Text color="gray">
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
