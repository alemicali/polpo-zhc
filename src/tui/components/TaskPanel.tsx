/**
 * TaskPanel — right sidebar: dashboard stats, mission tree, scores, agent activity.
 */

import { Box, Text } from "ink";
import { useState, useEffect } from "react";
import { useStore } from "../store.js";
import { statusIcon, statusColor, formatDuration } from "../format.js";
import type { Task } from "../../core/types.js";

const SPINNER = ["\u28CB", "\u28D9", "\u28F9", "\u28F8", "\u28FC", "\u28F4", "\u28E6", "\u28E7", "\u28C7", "\u28CF"];

export function TaskPanel({ width, height }: { width: number; height: number }) {
  const tasks = useStore((s) => s.tasks);
  const processes = useStore((s) => s.processes);
  const missions = useStore((s) => s.missions);
  const orchestratorStartedAt = useStore((s) => s.orchestratorStartedAt);
  const tuiStartedAt = useStore((s) => s.tuiStartedAt);

  // Live timer — re-render every second
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Task counts
  const pending = tasks.filter((t) => t.status === "pending").length;
  const assigned = tasks.filter((t) => t.status === "assigned").length;
  const running = tasks.filter((t) => t.status === "in_progress").length;
  const review = tasks.filter((t) => t.status === "review").length;
  const done = tasks.filter((t) => t.status === "done").length;
  const failed = tasks.filter((t) => t.status === "failed").length;
  const total = tasks.length;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  // Durations
  const sessionMs = now - new Date(tuiStartedAt).getTime();
  const orchestratorMs = orchestratorStartedAt
    ? now - new Date(orchestratorStartedAt).getTime()
    : 0;
  const totalTaskDurationMs = tasks.reduce((acc, t) => acc + (t.result?.duration ?? 0), 0);

  // Progress bar
  const barWidth = Math.max(8, width - 10);
  const filled = total > 0 ? Math.round((done / total) * barWidth) : 0;
  const bar = "\u2588".repeat(filled) + "\u2591".repeat(barWidth - filled);

  // Mission counts
  const draftMissions = missions.filter((p) => p.status === "draft").length;
  const activeMissions = missions.filter((p) => p.status === "active").length;
  const completedMissions = missions.filter((p) => p.status === "completed").length;
  const failedMissions = missions.filter((p) => p.status === "failed").length;

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

  // Build renderable task lines
  const lines: React.ReactNode[] = [];
  const tick = Math.floor(Date.now() / 80) % SPINNER.length;
  const maxTitle = width - 8;

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
        <TaskRow key={task.id} task={task} processes={processes} tick={tick} maxTitle={maxTitle - 2} indent={true} now={now} />
      );
    }
  }

  for (const task of ungrouped) {
    lines.push(
      <TaskRow key={task.id} task={task} processes={processes} tick={tick} maxTitle={maxTitle} indent={false} now={now} />
    );
  }

  // Space budget: border(2) + dashboard(~6) + missions(~4) + hint(1) = ~13
  const dashboardLines = 6 + (missions.length > 0 ? 3 + draftMissions + activeMissions : 0);
  const available = Math.max(0, height - dashboardLines - 3);
  const visible = lines.slice(0, available);
  const overflow = lines.length - available;

  return (
    <Box flexDirection="column" width={width} height={height} borderStyle="single" borderColor="gray" paddingX={1}>
      {/* ── Dashboard ── */}
      <Text bold color="cyan">Dashboard</Text>

      {/* Task counts row */}
      <Text>
        <Text color="white" bold>{total}</Text><Text color="gray"> total  </Text>
        {pending > 0 && <><Text color="gray">○ {pending}</Text><Text color="gray">  </Text></>}
        {(assigned > 0) && <><Text color="yellow">◎ {assigned}</Text><Text color="gray">  </Text></>}
        {running > 0 && <><Text color="cyan">● {running}</Text><Text color="gray">  </Text></>}
        {review > 0 && <><Text color="magenta">◉ {review}</Text><Text color="gray">  </Text></>}
        {done > 0 && <><Text color="green">✓ {done}</Text><Text color="gray">  </Text></>}
        {failed > 0 && <><Text color="red">✗ {failed}</Text></>}
      </Text>

      {/* Progress bar */}
      {total > 0 && (
        <Text>
          <Text color="green">{bar}</Text>
          <Text color="gray"> {pct}%</Text>
        </Text>
      )}

      {/* Timers */}
      <Text>
        <Text color="gray">Session </Text>
        <Text color="white">{formatDuration(sessionMs)}</Text>
        {orchestratorMs > 0 && (
          <>
            <Text color="gray">  Run </Text>
            <Text color="cyan">{formatDuration(orchestratorMs)}</Text>
          </>
        )}
      </Text>
      {totalTaskDurationMs > 0 && (
        <Text>
          <Text color="gray">Compute </Text>
          <Text color="yellow">{formatDuration(totalTaskDurationMs)}</Text>
        </Text>
      )}

      {/* ── Missions ── */}
      {missions.length > 0 && (
        <>
          <Text> </Text>
          <Text bold color="cyan">Missions</Text>
          <Text>
            {draftMissions > 0 && <><Text color="yellow">□ {draftMissions} draft</Text><Text color="gray">  </Text></>}
            {activeMissions > 0 && <><Text color="cyan">● {activeMissions} active</Text><Text color="gray">  </Text></>}
            {completedMissions > 0 && <><Text color="green">✓ {completedMissions} done</Text><Text color="gray">  </Text></>}
            {failedMissions > 0 && <Text color="red">✗ {failedMissions} failed</Text>}
          </Text>
          {missions.filter(p => p.status === "draft").map(p => (
            <Text key={p.id}>
              <Text color="yellow">  □ </Text>
              <Text>{p.name.length > maxTitle - 4 ? p.name.slice(0, maxTitle - 7) + "..." : p.name}</Text>
            </Text>
          ))}
          {missions.filter(p => p.status === "active").map(p => (
            <Text key={p.id}>
              <Text color="cyan">  ● </Text>
              <Text bold>{p.name.length > maxTitle - 4 ? p.name.slice(0, maxTitle - 7) + "..." : p.name}</Text>
            </Text>
          ))}
        </>
      )}

      {/* ── Tasks ── */}
      {visible.length > 0 && (
        <>
          <Text> </Text>
          <Text bold color="cyan">Tasks</Text>
        </>
      )}
      {visible}
      {overflow > 0 && <Text color="gray">+{overflow} more</Text>}

      {/* Bottom hint */}
      <Box flexGrow={1} />
      <Text color="gray">Ctrl+O to hide</Text>
    </Box>
  );
}

interface ProcessInfo {
  taskId?: string;
  agentName: string;
  startedAt: string;
  activity: { lastTool?: string; lastFile?: string; toolCalls: number; totalTokens: number };
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** Build inline activity text: includes tool/file + stats for running tasks */
function getActivityText(task: Task, process: ProcessInfo | undefined, now: number): string | null {
  // Running — show tool/file + elapsed + tokens + calls (all inline)
  if (task.status === "in_progress" && process) {
    const { lastTool, lastFile, totalTokens, toolCalls } = process.activity;
    const elapsed = now - new Date(process.startedAt).getTime();
    const parts: string[] = [];

    // Tool/file
    if (lastTool) parts.push(lastFile ? `${lastTool} → ${lastFile}` : lastTool);
    else parts.push("Running...");

    // Stats inline
    parts.push(formatDuration(elapsed));
    if (totalTokens > 0) parts.push(`↓ ${formatTokens(totalTokens)}`);
    if (toolCalls > 0) parts.push(`${toolCalls} calls`);

    return parts.join(" · ");
  }
  // Done
  if (task.status === "done" && task.result) {
    const parts = ["Completed"];
    if (task.result.duration > 0) parts.push(formatDuration(task.result.duration));
    if (task.result.assessment?.globalScore != null) parts.push(`${task.result.assessment.globalScore.toFixed(1)}/5`);
    return parts.join(" · ");
  }
  // Failed
  if (task.status === "failed") {
    const stderr = task.result?.stderr?.trim();
    if (stderr) return stderr.split("\n")[0]!.slice(0, 50);
    return "Failed";
  }
  // Review
  if (task.status === "review") return "Under review";
  // Assigned
  if (task.status === "assigned") return `Assigned to ${task.assignTo}`;
  // Pending with deps
  if (task.status === "pending" && task.dependsOn.length > 0) {
    return `Waiting for ${task.dependsOn.length} dep${task.dependsOn.length > 1 ? "s" : ""}`;
  }
  return null;
}

function TaskRow({
  task,
  processes,
  tick,
  maxTitle,
  indent,
  now,
}: {
  task: Task;
  processes: ProcessInfo[];
  tick: number;
  maxTitle: number;
  indent: boolean;
  now: number;
}) {
  const icon =
    task.status === "in_progress" ? SPINNER[tick] : statusIcon(task.status);
  const color = statusColor(task.status);
  const prefix = indent ? "  " : "";
  const title = task.title.slice(0, maxTitle);
  const score = task.result?.assessment?.globalScore;
  const dur = task.result?.duration;
  const agent = processes.find((p) => p.taskId === task.id);
  const activity = getActivityText(task, agent, now);
  const activityMax = maxTitle - 2; // account for "↳ " prefix

  // Activity text color based on status
  const activityColor = task.status === "in_progress" ? "cyan" :
                        task.status === "done" ? "green" :
                        task.status === "failed" ? "red" :
                        task.status === "review" ? "magenta" :
                        task.status === "assigned" ? "yellow" :
                        "gray";

  return (
    <Box flexDirection="column">
      <Text>
        <Text>{prefix}</Text>
        <Text color={color}>{icon} </Text>
        <Text>{title}</Text>
        {score !== undefined && <Text color="green"> {score.toFixed(1)}</Text>}
        {dur !== undefined && dur > 0 && <Text color="gray"> {formatDuration(dur)}</Text>}
      </Text>
      {activity && (
        <Text color={activityColor}>
          {prefix}  {"↳ "}{activity.slice(0, activityMax)}
        </Text>
      )}
    </Box>
  );
}
