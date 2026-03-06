/**
 * Parses JSONL activity logs from agent runs and produces structured
 * execution summaries for LLM reviewers.
 *
 * The JSONL log format (written by RunActivityLog in runner.ts):
 * - Header:      { _run: true, runId, taskId, agentName, startedAt, pid }
 * - Transcript:  { ts, type: "assistant"|"tool_use"|"tool_result"|"error", ... }
 * - Activity:    { ts, event: "activity", data: AgentActivity }
 * - Lifecycle:   { ts, event: "spawning"|"spawned"|"sigterm"|"done"|"outcomes", data? }
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

// ── Types ──────────────────────────────────────────────────────────────

interface TranscriptEntry {
  ts?: string;
  _run?: boolean;
  type?: string;        // "assistant" | "tool_use" | "tool_result" | "error"
  event?: string;       // "activity" | "spawning" | "spawned" | "done" | "outcomes" | "sigterm"
  data?: Record<string, unknown>;
  text?: string;
  tool?: string;
  toolId?: string;
  input?: Record<string, unknown>;
  content?: string;
  isError?: boolean;
  // header fields
  runId?: string;
  taskId?: string;
  agentName?: string;
  startedAt?: string;
}

export interface ExecutionSummaryResult {
  /** Human-readable timeline of what the agent did. */
  summary: string;
  /** Tool name → call count. */
  toolCounts: Record<string, number>;
  /** Formatted "toolName(N), toolName(N)" string. */
  toolsSummary: string;
}

// ── JSONL Parsing ──────────────────────────────────────────────────────

function parseJSONLEntries(content: string): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch { /* skip malformed lines */ }
  }
  return entries;
}

// ── Log File Discovery ─────────────────────────────────────────────────

/**
 * Find the JSONL log file for a given task, either from a known runId or by
 * scanning log headers.
 */
export function findLogForTask(polpoDir: string, taskId: string, runId?: string): string | null {
  const logsDir = join(polpoDir, "logs");
  if (!existsSync(logsDir)) return null;

  // Fast path: we know the runId
  if (runId) {
    const logPath = join(logsDir, `run-${runId}.jsonl`);
    return existsSync(logPath) ? logPath : null;
  }

  // Slow path: scan headers to find the latest log for this taskId
  const files = readdirSync(logsDir).filter(f => f.startsWith("run-") && f.endsWith(".jsonl"));
  let bestPath: string | null = null;
  let bestTime = "";

  for (const file of files) {
    try {
      const filePath = join(logsDir, file);
      const firstLine = readFileSync(filePath, "utf-8").split("\n")[0];
      const header = JSON.parse(firstLine) as TranscriptEntry;
      if (header._run && header.taskId === taskId) {
        const startedAt = header.startedAt ?? "";
        if (startedAt > bestTime) {
          bestTime = startedAt;
          bestPath = filePath;
        }
      }
    } catch { /* skip malformed files */ }
  }

  return bestPath;
}

// ── Summary Builder ────────────────────────────────────────────────────

/** Max chars for tool arguments in the summary. */
const ARG_PREVIEW_LIMIT = 120;
/** Max chars for tool results in the summary. */
const RESULT_PREVIEW_LIMIT = 200;
/** Max chars for assistant text in the summary. */
const ASSISTANT_PREVIEW_LIMIT = 300;
/** Max total entries to include in the timeline. */
const MAX_TIMELINE_ENTRIES = 60;

function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + "...";
}

function formatTimestamp(ts: string | undefined, startedAt: string | undefined): string {
  if (!ts || !startedAt) return "[??:??]";
  try {
    const elapsed = new Date(ts).getTime() - new Date(startedAt).getTime();
    if (isNaN(elapsed) || elapsed < 0) return "[??:??]";
    const secs = Math.floor(elapsed / 1000);
    const mins = Math.floor(secs / 60);
    const remainSecs = secs % 60;
    return `[${String(mins).padStart(2, "0")}:${String(remainSecs).padStart(2, "0")}]`;
  } catch {
    return "[??:??]";
  }
}

function formatToolArgs(input: Record<string, unknown> | undefined): string {
  if (!input) return "";
  // For common tools, show the most relevant argument
  const keys = Object.keys(input);
  if (keys.length === 0) return "";

  // Priority: command, path, pattern, query, url, then first key
  const priority = ["command", "path", "pattern", "query", "url", "to", "subject", "content"];
  for (const k of priority) {
    if (input[k] !== undefined) {
      const val = String(input[k]);
      return truncate(val, ARG_PREVIEW_LIMIT);
    }
  }
  const firstVal = String(input[keys[0]]);
  return truncate(firstVal, ARG_PREVIEW_LIMIT);
}

/**
 * Build a structured execution summary from a JSONL activity log.
 *
 * Returns a timeline string suitable for inclusion in LLM reviewer prompts,
 * plus tool usage stats.
 */
export function buildExecutionSummary(logPath: string): ExecutionSummaryResult {
  const content = readFileSync(logPath, "utf-8");
  const entries = parseJSONLEntries(content);

  if (entries.length === 0) {
    return { summary: "(no execution log available)", toolCounts: {}, toolsSummary: "" };
  }

  // Extract header
  const header = entries.find(e => e._run);
  const startedAt = header?.startedAt;

  // Build timeline entries
  const timeline: string[] = [];
  const toolCounts: Record<string, number> = {};
  let lastToolId: string | undefined;
  let entryCount = 0;

  for (const entry of entries) {
    if (entryCount >= MAX_TIMELINE_ENTRIES) {
      timeline.push(`  ... (${entries.length - entryCount} more entries omitted)`);
      break;
    }

    const ts = formatTimestamp(entry.ts, startedAt);

    if (entry.type === "assistant" && entry.text) {
      const preview = truncate(entry.text.trim(), ASSISTANT_PREVIEW_LIMIT);
      if (preview) {
        timeline.push(`${ts} Agent: "${preview}"`);
        entryCount++;
      }
    } else if (entry.type === "tool_use") {
      const toolName = entry.tool ?? "unknown";
      toolCounts[toolName] = (toolCounts[toolName] ?? 0) + 1;
      lastToolId = entry.toolId;
      const args = formatToolArgs(entry.input);
      timeline.push(`${ts} Tool: ${toolName}(${args})`);
      entryCount++;
    } else if (entry.type === "tool_result") {
      const resultContent = entry.content ?? "";
      const isErr = entry.isError;
      if (isErr) {
        timeline.push(`${ts}   \u2192 ERROR: ${truncate(resultContent, RESULT_PREVIEW_LIMIT)}`);
        entryCount++;
      } else if (resultContent.length > 0) {
        // Only show result preview for non-file-read tools or errors
        // File reads produce lots of content that clutters the summary
        const isFileRead = entry.tool === "read_file" || entry.tool === "Read";
        if (!isFileRead) {
          timeline.push(`${ts}   \u2192 ${truncate(resultContent, RESULT_PREVIEW_LIMIT)}`);
          entryCount++;
        }
      }
    } else if (entry.type === "error") {
      const msg = (entry as any).message ?? entry.text ?? "unknown error";
      timeline.push(`${ts} ERROR: ${truncate(String(msg), RESULT_PREVIEW_LIMIT)}`);
      entryCount++;
    } else if (entry.event === "done") {
      const data = entry.data;
      if (data) {
        timeline.push(`${ts} Agent finished (exit code: ${data.exitCode ?? "?"}, duration: ${formatDuration(data.duration as number | undefined)})`);
        entryCount++;
      }
    }
    // Skip activity snapshots, spawning/spawned, sigterm — not useful for review
  }

  // Build tools summary string
  const toolsSummary = Object.entries(toolCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => `${name}(${count})`)
    .join(", ");

  const summary = timeline.length > 0
    ? `EXECUTION TIMELINE:\n${timeline.join("\n")}`
    : "(agent produced no recorded activity)";

  return { summary, toolCounts, toolsSummary };
}

function formatDuration(ms: number | undefined): string {
  if (ms === undefined || ms === null) return "?";
  if (ms < 1000) return `${ms}ms`;
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remainSecs = secs % 60;
  return `${mins}m${remainSecs}s`;
}
