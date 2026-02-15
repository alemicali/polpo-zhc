/**
 * Push notification via Unix Domain Socket.
 *
 * Server (orchestrator): listens on .polpo/orchestrator.sock for runner
 * completion notifications and triggers immediate result collection.
 *
 * Client (runner): connects, sends a single JSON message, disconnects.
 * Fire-and-forget — if the socket is unreachable, the orchestrator's
 * polling fallback will pick up the result.
 */

import { createServer, createConnection, type Server } from "node:net";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const SOCKET_NAME = "orchestrator.sock";

export interface RunCompleteMessage {
  type: "run_complete";
  runId: string;
  taskId: string;
  status: string;
}

/** Server-side: orchestrator listens for runner completion notifications. */
export function startNotificationServer(
  polpoDir: string,
  onRunComplete: (runId: string, taskId: string, status: string) => void,
): Server {
  const socketPath = join(polpoDir, SOCKET_NAME);

  // Clean up stale socket from previous crash
  if (existsSync(socketPath)) {
    try { unlinkSync(socketPath); } catch { /* race — another process removed it */ }
  }

  const server = createServer((conn) => {
    let buffer = "";
    conn.setEncoding("utf-8");
    conn.on("data", (chunk) => { buffer += chunk; });
    conn.on("end", () => {
      try {
        const msg = JSON.parse(buffer.trim()) as RunCompleteMessage;
        if (msg.type === "run_complete") {
          onRunComplete(msg.runId, msg.taskId, msg.status);
        }
      } catch { /* malformed message — ignore */ }
    });
    conn.on("error", () => { /* broken pipe — ignore */ });
  });

  server.on("error", (err) => {
    console.warn(`[notification] Server error: ${err.message}`);
  });

  server.listen(socketPath);
  return server;
}

/** Client-side: runner sends completion notification (fire-and-forget). */
export function notifyRunComplete(
  socketPath: string,
  runId: string,
  taskId: string,
  status: string,
): void {
  try {
    const conn = createConnection(socketPath);
    conn.on("error", () => { /* orchestrator not listening — it will poll */ });
    conn.end(JSON.stringify({ type: "run_complete", runId, taskId, status } satisfies RunCompleteMessage) + "\n");
  } catch { /* orchestrator not listening — it will poll */ }
}

/** Get the UDS path for the notification socket. */
export function getSocketPath(polpoDir: string): string {
  return join(polpoDir, SOCKET_NAME);
}
