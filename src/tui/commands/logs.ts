/**
 * /logs command — browse persistent session logs.
 */

import blessed from "blessed";
import type { CommandContext } from "../context.js";
import type { LogEntry, SessionInfo } from "../../core/log-store.js";
import { createOverlay, addHintBar, showContentViewer } from "../widgets.js";
import { esc } from "../formatters.js";

export function cmdLogs(ctx: CommandContext): void {
  const logStore = ctx.orchestrator.getLogStore();
  if (!logStore) {
    ctx.log("{yellow-fg}Log store not initialized{/yellow-fg}");
    return;
  }

  const sessions = logStore.listSessions();
  if (sessions.length === 0) {
    ctx.log("{yellow-fg}No log sessions found{/yellow-fg}");
    return;
  }

  showSessionPicker(ctx, sessions);
}

function showSessionPicker(ctx: CommandContext, sessions: SessionInfo[]): void {
  const { overlay, cleanup, onKeypress } = createOverlay(ctx);

  const currentSessionId = ctx.orchestrator.getLogStore()?.getSessionId();

  const items = sessions.map(s => {
    const date = new Date(s.startedAt);
    const dateStr = date.toLocaleDateString("it-IT", {
      day: "2-digit", month: "2-digit", year: "numeric",
      hour: "2-digit", minute: "2-digit",
    });
    const current = s.sessionId === currentSessionId ? " {green-fg}(current){/green-fg}" : "";
    return `  ${dateStr}  {grey-fg}${s.entries} events{/grey-fg}${current}`;
  });

  const list = blessed.list({
    parent: overlay,
    top: "center",
    left: "center",
    width: 55,
    height: Math.min(items.length + 2, 20),
    items,
    tags: true,
    border: { type: "line" },
    label: ` {bold}Log Sessions{/bold} {grey-fg}(${sessions.length}){/grey-fg} `,
    style: {
      bg: "black",
      border: { fg: "cyan" },
      selected: { bg: "blue", fg: "white", bold: true },
      item: { bg: "black" },
    },
    keys: false,
    vi: false,
    mouse: true,
    scrollable: true,
    alwaysScroll: true,
    scrollbar: { ch: "│", style: { fg: "grey" } },
  });

  addHintBar(overlay, " {cyan-fg}Enter{/cyan-fg} {grey-fg}view{/grey-fg}  {cyan-fg}Escape{/cyan-fg} {grey-fg}close{/grey-fg}");

  list.select(0);
  list.focus();
  ctx.scheduleRender();

  let ready = false;
  setImmediate(() => { ready = true; });

  list.on("select", (_item: any, index: number) => {
    if (!ready) return;
    cleanup();
    showSessionEntries(ctx, sessions[index]);
  });

  onKeypress((_ch, key) => {
    if (!key) return;
    if (key.name === "escape") { cleanup(); return; }
    if (key.name === "up") { list.up(1); ctx.scheduleRender(); return; }
    if (key.name === "down") { list.down(1); ctx.scheduleRender(); return; }
    if (key.name === "return" || key.name === "enter") {
      if (!ready) return;
      cleanup();
      showSessionEntries(ctx, sessions[(list as any).selected ?? 0]);
    }
  });
}

function showSessionEntries(ctx: CommandContext, session: SessionInfo): void {
  const logStore = ctx.orchestrator.getLogStore();
  if (!logStore) return;

  const entries = logStore.getSessionEntries(session.sessionId);
  if (entries.length === 0) {
    ctx.log("{yellow-fg}No entries in this session{/yellow-fg}");
    return;
  }

  const content = formatLogEntries(entries);
  const date = new Date(session.startedAt);
  const dateStr = date.toLocaleDateString("it-IT", {
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });

  showContentViewer(ctx, {
    title: ` {bold}Session ${dateStr}{/bold} {grey-fg}(${entries.length} events){/grey-fg} `,
    content,
    borderColor: "cyan",
    actions: [],
  });
}

function formatLogEntries(entries: LogEntry[]): string {
  const lines: string[] = [];

  for (const entry of entries) {
    const time = new Date(entry.ts).toLocaleTimeString("it-IT", {
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });

    const eventColor = getEventColor(entry.event);
    const summary = summarizeEvent(entry.event, entry.data);
    lines.push(`{grey-fg}${time}{/grey-fg} {${eventColor}-fg}${entry.event}{/${eventColor}-fg} ${summary}`);
  }

  return lines.join("\n");
}

function getEventColor(event: string): string {
  if (event.startsWith("task:")) return "cyan";
  if (event.startsWith("agent:")) return "blue";
  if (event.startsWith("assessment:")) return "yellow";
  if (event.startsWith("plan:")) return "magenta";
  if (event.startsWith("orchestrator:")) return "grey";
  if (event === "log") return "white";
  return "white";
}

function summarizeEvent(event: string, data: unknown): string {
  const d = data as Record<string, any> | undefined;
  if (!d) return "";

  switch (event) {
    case "task:created":
      return esc(d.task?.title ?? "");
    case "task:transition":
      return `${esc(d.task?.title ?? d.taskId)} {grey-fg}${d.from} → ${d.to}{/grey-fg}`;
    case "agent:spawned":
      return `{bold}${esc(d.taskTitle ?? "")}{/bold} {grey-fg}→ ${esc(d.agentName ?? "")}{/grey-fg}`;
    case "agent:finished": {
      const secs = d.duration ? (d.duration / 1000).toFixed(1) : "?";
      const sid = d.sessionId ? ` {cyan-fg}${d.sessionId}{/cyan-fg}` : "";
      return `${esc(d.agentName ?? "")} {grey-fg}exit ${d.exitCode} (${secs}s){/grey-fg}${sid}`;
    }
    case "assessment:complete": {
      const score = d.globalScore !== undefined ? ` (${d.globalScore.toFixed(1)}/5)` : "";
      return `${d.passed ? "{green-fg}PASSED{/green-fg}" : "{red-fg}FAILED{/red-fg}"}${score}`;
    }
    case "task:retry":
      return `${d.taskId} {yellow-fg}${d.attempt}/${d.maxRetries}{/yellow-fg}`;
    case "task:fix":
      return `${d.taskId} {magenta-fg}fix ${d.attempt}/${d.maxFix}{/magenta-fg}`;
    case "plan:executed":
      return `${esc(d.group ?? "")} {grey-fg}(${d.taskCount} tasks){/grey-fg}`;
    case "plan:completed":
      return `${esc(d.group ?? "")} ${d.allPassed ? "{green-fg}all passed{/green-fg}" : "{red-fg}some failed{/red-fg}"}`;
    case "log":
      return esc(d.message ?? "");
    default:
      return d.taskId ?? d.planId ?? "";
  }
}
