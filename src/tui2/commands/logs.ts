import type { CommandAPI } from "../types.js";
import { theme } from "../theme.js";
import { ViewerOverlay } from "../overlays/viewer.js";
import { PickerOverlay } from "../overlays/picker.js";

export function cmdLogs(api: CommandAPI): void {
  const { polpo, tui, args } = api;

  const logStore = polpo.getLogStore();
  if (!logStore) {
    tui.logSystem("No log store available");
    tui.requestRender();
    return;
  }

  const sub = args[0]?.toLowerCase();

  // /logs sessions — list all log sessions
  if (sub === "sessions") {
    const sessions = logStore.listSessions();
    if (sessions.length === 0) {
      tui.logSystem("No log sessions");
      tui.requestRender();
      return;
    }
    const items = sessions.map((s) => ({
      value: s.sessionId,
      label: s.sessionId,
      description: `${s.entries} entries · ${new Date(s.startedAt).toLocaleString()}`,
    }));
    const picker = new PickerOverlay({
      title: "Log Sessions",
      items,
      onSelect: (item) => {
        tui.hideOverlay();
        showLogEntries(api, logStore.getSessionEntries(item.value));
      },
      onCancel: () => tui.hideOverlay(),
    });
    tui.showOverlay(picker);
    return;
  }

  // Default: show current session entries
  const entries = logStore.getSessionEntries();
  if (entries.length === 0) {
    tui.logSystem("No log entries in current session");
    tui.requestRender();
    return;
  }
  showLogEntries(api, entries);
}

function showLogEntries(api: CommandAPI, entries: Array<{ ts: string; event: string; data: unknown }>): void {
  const { tui } = api;
  const content = entries
    .map((e) => {
      const time = new Date(e.ts).toLocaleTimeString();
      const summary = summarizePayload(e.data);
      return `${theme.dim(time)} ${e.event} ${summary}`;
    })
    .join("\n");

  const viewer = new ViewerOverlay({
    title: "Event Logs",
    content,
    onClose: () => tui.hideOverlay(),
  });
  tui.showOverlay(viewer);
}

export function cmdInspect(api: CommandAPI): void {
  cmdLogs(api);
}

function summarizePayload(data: unknown): string {
  if (!data || typeof data !== "object") return "";
  const rec = data as Record<string, unknown>;
  const parts: string[] = [];
  if (rec.taskId) parts.push(`task:${rec.taskId}`);
  if (rec.agentName) parts.push(`agent:${rec.agentName}`);
  if (rec.title) parts.push(`"${rec.title}"`);
  if (rec.group) parts.push(`group:${rec.group}`);
  if (typeof rec.passed === "boolean")
    parts.push(rec.passed ? "passed" : "failed");
  return parts.join(" ");
}
