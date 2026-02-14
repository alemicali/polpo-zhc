/**
 * /logs — view persistent event log from LogStore.
 * /inspect — view current session events live.
 */

import type { CommandAPI } from "./types.js";
import { seg } from "../format.js";

export function cmdLogs({ polpo, store, args }: CommandAPI) {
  const logStore = polpo.getLogStore();
  if (!logStore) {
    store.log("No log store available", [seg("No log store", "gray")]);
    return;
  }

  const sub = args[0];

  // /logs sessions — list all log sessions
  if (sub === "sessions") {
    const sessions = logStore.listSessions();
    if (sessions.length === 0) {
      store.log("No log sessions found", [seg("No log sessions", "gray")]);
      return;
    }
    store.navigate({
      id: "picker",
      title: "Log Sessions",
      items: sessions.map((s) => ({
        label: `${s.startedAt.slice(0, 19)} (${s.entries} entries)`,
        value: s.sessionId,
      })),
      hint: "Select a session to view",
      onSelect: (_idx, sessionId) => {
        store.goMain();
        showSessionLogs(logStore, sessionId, store);
      },
      onCancel: () => store.goMain(),
    });
    return;
  }

  // Default: show current session logs
  const sessionId = logStore.getSessionId();
  if (!sessionId) {
    store.log("No active log session", [seg("No active session", "gray")]);
    return;
  }
  showSessionLogs(logStore, sessionId, store);
}

export function cmdInspect({ polpo, store }: CommandAPI) {
  const logStore = polpo.getLogStore();
  if (!logStore) {
    store.log("No log store available", [seg("No log store", "gray")]);
    return;
  }
  const sessionId = logStore.getSessionId();
  if (!sessionId) {
    store.log("No active log session", [seg("No active session", "gray")]);
    return;
  }
  showSessionLogs(logStore, sessionId, store);
}

function showSessionLogs(
  logStore: import("../../core/log-store.js").LogStore,
  sessionId: string,
  store: import("../store.js").TUIStore,
) {
  const entries = logStore.getSessionEntries(sessionId);
  if (entries.length === 0) {
    store.log("No entries in this session", [seg("No entries", "gray")]);
    return;
  }

  const lines = entries.map((e) => {
    const time = e.ts.slice(11, 19);
    const data = typeof e.data === "object" && e.data !== null
      ? summarizePayload(e.data as Record<string, unknown>)
      : "";
    return `${time}  ${e.event.padEnd(24)} ${data}`;
  });

  store.navigate({
    id: "viewer",
    title: `Log: ${sessionId.slice(0, 8)} (${entries.length} entries)`,
    content: lines.join("\n"),
    actions: ["Close"],
    onClose: () => store.goMain(),
  });
}

/** Produce a short one-line summary of an event payload. */
function summarizePayload(data: Record<string, unknown>): string {
  const parts: string[] = [];
  if (data.taskId) parts.push(`task:${String(data.taskId).slice(0, 8)}`);
  if (data.agentName) parts.push(String(data.agentName));
  if (data.title) parts.push(String(data.title));
  if (data.group) parts.push(`group:${data.group}`);
  if (data.passed !== undefined) parts.push(data.passed ? "passed" : "failed");
  if (data.message) parts.push(String(data.message).slice(0, 50));
  return parts.join(" | ");
}
