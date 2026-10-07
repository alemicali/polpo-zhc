/**
 * Push notification via Unix Domain Socket (a named pipe on Windows).
 *
 * Server (orchestrator): listens on .polpo/orchestrator.sock (on Windows,
 * \\.\pipe\polpo-<hash of the .polpo path>) for runner completion
 * notifications and triggers immediate result collection.
 *
 * Client (runner): connects, sends a single JSON message, disconnects.
 * Fire-and-forget — if the socket is unreachable, the orchestrator's
 * polling fallback will pick up the result.
 */

import { createServer, createConnection, type Server } from "node:net";
import { createHash } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";

const SOCKET_NAME = "orchestrator.sock";

export interface RunCompleteMessage {
  type: "run_complete";
  runId: string;
  taskId: string;
  status: string;
}

/** A destination the network rule refused inside a task run's sandbox. */
export interface NetworkDeniedMessage {
  type: "network_denied";
  runId: string;
  taskId: string;
  agentName?: string;
  provider: string;
  host: string;
  port?: number;
  reason: "not-allowed" | "private-address";
}

/** A remote sandbox lifecycle step inside a task run (ready, suspended, resumed, released). */
export interface SandboxEventMessage {
  type: "sandbox_event";
  runId: string;
  taskId: string;
  agentName?: string;
  provider: string;
  event: Record<string, unknown> & { kind: string };
}

/** Server-side: orchestrator listens for runner completion notifications. */
export function startNotificationServer(
  polpoDir: string,
  onRunComplete: (runId: string, taskId: string, status: string) => void,
  onNetworkDenied?: (msg: NetworkDeniedMessage) => void,
  onSandboxEvent?: (msg: SandboxEventMessage) => void,
): Server {
  const socketPath = getSocketPath(polpoDir);

  // Clean up stale socket from previous crash (named pipes vanish with their process)
  if (process.platform !== "win32" && existsSync(socketPath)) {
    try { unlinkSync(socketPath); } catch { /* race — another process removed it */ }
  }

  const server = createServer((conn) => {
    let buffer = "";
    conn.setEncoding("utf-8");
    conn.on("data", (chunk) => { buffer += chunk; });
    conn.on("end", () => {
      try {
        const msg = JSON.parse(buffer.trim()) as RunCompleteMessage | NetworkDeniedMessage | SandboxEventMessage;
        if (msg.type === "run_complete") {
          onRunComplete(msg.runId, msg.taskId, msg.status);
        } else if (msg.type === "network_denied") {
          onNetworkDenied?.(msg);
        } else if (msg.type === "sandbox_event") {
          onSandboxEvent?.(msg);
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

/** Client-side: runner reports a refused destination (fire-and-forget). */
export function notifyNetworkDenied(socketPath: string, msg: Omit<NetworkDeniedMessage, "type">): void {
  try {
    const conn = createConnection(socketPath);
    conn.on("error", () => { /* orchestrator not listening — the refusal is still logged by the run */ });
    conn.end(JSON.stringify({ type: "network_denied", ...msg } satisfies NetworkDeniedMessage) + "\n");
  } catch { /* ignore */ }
}

/** Client-side: runner reports a remote sandbox lifecycle step (fire-and-forget). */
export function notifySandboxEvent(socketPath: string, msg: Omit<SandboxEventMessage, "type">): void {
  try {
    const conn = createConnection(socketPath);
    conn.on("error", () => { /* orchestrator not listening */ });
    conn.end(JSON.stringify({ type: "sandbox_event", ...msg } satisfies SandboxEventMessage) + "\n");
  } catch { /* ignore */ }
}

/**
 * Get the path for the notification socket. Windows cannot listen on a file path
 * (EACCES), only on a named pipe, so there the pipe name is derived from the .polpo path.
 */
export function getSocketPath(polpoDir: string): string {
  if (process.platform === "win32") {
    const id = createHash("sha256").update(resolve(polpoDir).toLowerCase()).digest("hex").slice(0, 16);
    return `\\\\.\\pipe\\polpo-${id}`;
  }
  return join(polpoDir, SOCKET_NAME);
}
