/**
 * A task's runs as a chat conversation (Tasks → Execution → Chat). Pure mapping, no React:
 *
 * - the task's instructions (its description) open the conversation as the first user message;
 * - assistant text, reasoning and tool calls (tool_use + its tool_result, matched by id) become an
 *   assistant message's segments, in order, the same shape the chat page draws;
 * - a direction (steer, follow-up, continue) is a user turn: placed where the run logged it applied
 *   (direction:applied), a continuation opening the run it started, anything still queued at the end;
 * - errors and a failed run's reason close the assistant message as text;
 * - each run (retry, continuation) is its own section, as the log view groups them.
 */
import type { RunActivityEntry, TaskDirection, TaskRunContext } from "@polpo-ai/react";
import type { MessageSegment, ToolCallInfo } from "@/hooks/use-polpo";

export interface ActivityRunGroup {
  header?: RunActivityEntry;
  entries: RunActivityEntry[];
  attempt: number;
}

/** Split a task's activity log into runs: each run starts at its header line (`_run`). */
export function groupActivityRuns(entries: RunActivityEntry[]): ActivityRunGroup[] {
  const groups: Array<Omit<ActivityRunGroup, "attempt">> = [];
  let current: Omit<ActivityRunGroup, "attempt"> | undefined;

  for (const entry of entries) {
    if (entry._run) {
      if (current && (current.header || current.entries.length > 0)) groups.push(current);
      current = { header: entry, entries: [] };
      continue;
    }
    if (!current) current = { entries: [] };
    current.entries.push(entry);
  }
  if (current && (current.header || current.entries.length > 0)) groups.push(current);

  return groups.map((group, index) => ({ ...group, attempt: index + 1 }));
}

export type TaskChatUserKind = "prompt" | TaskDirection["mode"];

export interface TaskChatMessage {
  id: string;
  role: "user" | "assistant";
  /** The text (user) or the assistant's text joined: what Copy copies. */
  content: string;
  /** Assistant only: text, reasoning and tool calls in order. */
  segments: MessageSegment[];
  ts?: string;
  /** User turns: the task's instructions, or a direction's mode. */
  kind?: TaskChatUserKind;
  /** Directions: queued, delivered, applied or failed. */
  directionStatus?: TaskDirection["status"];
}

export type TaskRunKind = "first" | "retry" | "continuation";

export interface TaskTranscriptRun {
  key: string;
  attempt: number;
  runId?: string;
  kind: TaskRunKind;
  /** running, completed, failed, killed (when known). */
  status?: string;
  startedAt?: string;
  agentName?: string;
  messages: TaskChatMessage[];
}

export interface BuildTaskTranscriptInput {
  /** The task's instructions: the first user message. */
  prompt: string;
  createdAt?: string;
  entries: RunActivityEntry[];
  directions?: TaskDirection[];
  runs?: TaskRunContext[];
  /** The latest run is still going (its last tool call may still be running). */
  isActive?: boolean;
}

const time = (ts?: string) => (ts ? Date.parse(ts) || 0 : 0);
const directionTime = (d: TaskDirection) => time(d.appliedAt ?? d.deliveredAt ?? d.createdAt);

function userMessage(direction: TaskDirection): TaskChatMessage {
  return {
    id: `direction-${direction.id}`,
    role: "user",
    content: direction.message,
    segments: [],
    ts: direction.appliedAt ?? direction.deliveredAt ?? direction.createdAt,
    kind: direction.mode,
    directionStatus: direction.status,
  };
}

function doneData(entry: RunActivityEntry): { status?: string; error?: string } | undefined {
  return entry.data && typeof entry.data === "object" ? entry.data as { status?: string; error?: string } : undefined;
}

function textOfSegments(segments: MessageSegment[]): string {
  return segments.filter((s) => s.type === "text").map((s) => (s as { content: string }).content).join("\n\n");
}

/** Map one run's entries to chat messages; direction:applied places those directions as user turns. */
function runMessages(
  group: ActivityRunGroup,
  directionsById: Map<string, TaskDirection>,
  placed: Set<string>,
  stillRunning: boolean,
): { messages: TaskChatMessage[]; status?: string } {
  const messages: TaskChatMessage[] = [];
  const tools = new Map<string, ToolCallInfo>();
  let assistant: TaskChatMessage | undefined;
  let status: string | undefined;
  const keyBase = group.header?.runId ?? `run-${group.attempt}`;

  const ensureAssistant = (ts?: string): TaskChatMessage => {
    if (!assistant) {
      assistant = { id: `${keyBase}-a${messages.length}`, role: "assistant", content: "", segments: [], ts };
      messages.push(assistant);
    }
    return assistant;
  };
  const closeAssistant = () => {
    if (assistant) assistant.content = textOfSegments(assistant.segments);
    assistant = undefined;
  };

  group.entries.forEach((entry, index) => {
    if (entry.event === "direction:applied") {
      const ids = (entry.data as { directionIds?: unknown } | undefined)?.directionIds;
      const list = Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
      const known = list.map((id) => directionsById.get(id)).filter((d): d is TaskDirection => !!d && !placed.has(d.id));
      if (known.length === 0) return;
      closeAssistant();
      for (const direction of known) {
        placed.add(direction.id);
        messages.push(userMessage(direction));
      }
      return;
    }
    if (entry.event === "done") {
      const data = doneData(entry);
      status = data?.status ?? status;
      if (data?.status && data.status !== "completed" && data.error) {
        ensureAssistant(entry.ts).segments.push({ type: "text", content: `**Run ${data.status}:** ${data.error}` });
      }
      return;
    }
    if (entry.event === "error" || entry.type === "error") {
      const message = entry.message ?? (entry.data as { message?: string } | undefined)?.message ?? entry.text;
      if (message) ensureAssistant(entry.ts).segments.push({ type: "text", content: `**Error:** ${message}` });
      return;
    }
    if (entry.type === "assistant" && entry.text?.trim()) {
      ensureAssistant(entry.ts).segments.push({ type: "text", content: entry.text });
      return;
    }
    if (entry.type === "reasoning" && entry.text?.trim()) {
      ensureAssistant(entry.ts).segments.push({ type: "thinking", content: entry.text });
      return;
    }
    if (entry.type === "tool_use") {
      const id = entry.toolId ?? `${keyBase}-tool-${index}`;
      const tool: ToolCallInfo = {
        id,
        name: entry.tool ?? "tool",
        arguments: entry.input,
        state: "calling",
      };
      tools.set(id, tool);
      ensureAssistant(entry.ts).segments.push({ type: "tool", tool });
      return;
    }
    if (entry.type === "tool_result") {
      const result = entry.content ?? entry.text;
      const tool = entry.toolId ? tools.get(entry.toolId) : undefined;
      if (tool) {
        tool.result = result;
        tool.state = entry.isError ? "error" : "completed";
        return;
      }
      const orphan: ToolCallInfo = {
        id: entry.toolId ?? `${keyBase}-result-${index}`,
        name: entry.tool ?? "tool",
        result,
        state: entry.isError ? "error" : "completed",
      };
      ensureAssistant(entry.ts).segments.push({ type: "tool", tool: orphan });
      return;
    }
    if (entry.type === "result" && entry.text?.trim()) {
      const target = ensureAssistant(entry.ts);
      // the final result often repeats the last reply: draw it once
      if (!textOfSegments(target.segments).includes(entry.text.trim())) target.segments.push({ type: "text", content: entry.text });
    }
  });
  closeAssistant();

  // A run that ended (or stopped logging) leaves no tool "running" forever.
  if (!stillRunning) {
    for (const tool of tools.values()) if (tool.state === "calling") tool.state = "interrupted";
  }
  return { messages, status: stillRunning ? "running" : status };
}

/** Insert a user turn among a run's messages by time (stable: equal times go after). */
function insertByTime(messages: TaskChatMessage[], message: TaskChatMessage) {
  const at = time(message.ts);
  const index = messages.findIndex((m) => time(m.ts) > at);
  if (index === -1) messages.push(message);
  else messages.splice(index, 0, message);
}

export function buildTaskTranscript({
  prompt,
  createdAt,
  entries,
  directions = [],
  runs = [],
  isActive = false,
}: BuildTaskTranscriptInput): TaskTranscriptRun[] {
  const groups = groupActivityRuns(entries);
  const directionsById = new Map(directions.map((d) => [d.id, d]));
  const placed = new Set<string>();
  const runContext = new Map(runs.map((r) => [r.runId, r]));

  const transcript: TaskTranscriptRun[] = groups.map((group, index) => {
    const isLatest = index === groups.length - 1;
    const { messages, status } = runMessages(group, directionsById, placed, isLatest && isActive);
    const runId = group.header?.runId;
    const ctx = runId ? runContext.get(runId) : undefined;
    const continued = ctx?.continuation
      || directions.some((d) => d.mode === "continue" && !!runId && d.runId === runId);
    return {
      key: runId ?? `run-${group.attempt}`,
      attempt: group.attempt,
      runId,
      kind: group.attempt === 1 ? "first" : continued ? "continuation" : "retry",
      status: status ?? ctx?.status,
      startedAt: group.header?.startedAt ?? ctx?.startedAt,
      agentName: group.header?.agentName ?? ctx?.agent,
      messages,
    };
  });

  if (transcript.length === 0) {
    transcript.push({ key: "run-0", attempt: 0, kind: "first", messages: [] });
  }

  // The task's instructions open the conversation.
  transcript[0].messages.unshift({
    id: "task-prompt",
    role: "user",
    content: prompt,
    segments: [],
    ts: createdAt ?? transcript[0].startedAt,
    kind: "prompt",
  });

  // Directions the log did not place: a continuation opens the run it started; a direction of a
  // known run goes there by time; anything else (still queued, failed) at the end, by time.
  const rest = directions
    .filter((d) => !placed.has(d.id))
    .sort((a, b) => directionTime(a) - directionTime(b));
  for (const direction of rest) {
    const message = userMessage(direction);
    let target: TaskTranscriptRun | undefined = direction.runId
      ? transcript.find((r) => r.runId === direction.runId)
      : undefined;
    if (!target && direction.mode === "continue" && direction.status === "applied") {
      target = transcript.find((r) => r.attempt > 1 && time(r.startedAt) >= time(direction.createdAt));
      if (target) {
        target.kind = "continuation";
        target.messages.unshift(message);
        continue;
      }
    }
    target ??= [...transcript].reverse().find((r) => !r.startedAt || time(r.startedAt) <= directionTime(direction))
      ?? transcript[transcript.length - 1];
    if (direction.status === "queued" || direction.status === "failed") target = transcript[transcript.length - 1];
    if (direction.status === "queued" || direction.status === "failed") target.messages.push(message);
    else insertByTime(target.messages, message);
  }

  return transcript;
}

/** "Run 2 · retry", "Run 3 · continuation". */
export function runLabel(run: Pick<TaskTranscriptRun, "attempt" | "kind">): string {
  if (run.attempt <= 1) return "Run 1";
  return `Run ${run.attempt} · ${run.kind === "continuation" ? "continuation" : "retry"}`;
}
