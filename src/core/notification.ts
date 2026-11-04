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
 *
 * Pipeline human steps are request/response instead: the runner half-closes
 * after sending, the orchestrator writes one JSON reply and closes.
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

/** A pipeline `human` step asks for a decision (creates an approval request). */
export interface PipelineHumanRequestMessage {
  type: "pipeline_human_request";
  /** Chosen by the runner so that retries are idempotent. */
  requestId: string;
  runId: string;
  taskId: string;
  agentName: string;
  step: string;
  notify?: string[];
  context: Record<string, unknown>;
}

/** The runner polls the decision of a pipeline `human` step. */
export interface PipelineHumanStatusMessage {
  type: "pipeline_human_status";
  requestId: string;
}

/** The pipeline no longer waits for this decision (run cancelled, parallel join decided). */
export interface PipelineHumanCancelMessage {
  type: "pipeline_human_cancel";
  requestId: string;
}

export type PipelineHumanMessage = PipelineHumanRequestMessage | PipelineHumanStatusMessage | PipelineHumanCancelMessage;

export interface PipelineHumanReply {
  ok: boolean;
  error?: string;
  status?: "pending" | "approved" | "rejected" | "timeout";
  note?: string;
}

/** Server-side: orchestrator listens for runner completion notifications. */
export function startNotificationServer(
  polpoDir: string,
  onRunComplete: (runId: string, taskId: string, status: string) => void,
  onNetworkDenied?: (msg: NetworkDeniedMessage) => void,
  onSandboxEvent?: (msg: SandboxEventMessage) => void,
  onPipelineHuman?: (msg: PipelineHumanMessage) => Promise<PipelineHumanReply>,
): Server {
  const socketPath = getSocketPath(polpoDir);

  // Clean up stale socket from previous crash (named pipes vanish with their process)
  if (process.platform !== "win32" && existsSync(socketPath)) {
    try { unlinkSync(socketPath); } catch { /* race — another process removed it */ }
  }

  const server = createServer((conn) => {
    let buffer = "";
    let answered = false;
    conn.setEncoding("utf-8");
    conn.on("data", (chunk) => {
      buffer += chunk;
      // Request/response messages arrive as one line on an open connection
      // (named pipes on Windows cannot half-close): answer and close.
      const newline = buffer.indexOf("\n");
      if (answered || newline < 0) return;
      let msg: { type?: string };
      try { msg = JSON.parse(buffer.slice(0, newline)); } catch { return; }
      if (msg.type !== "pipeline_human_request" && msg.type !== "pipeline_human_status" && msg.type !== "pipeline_human_cancel") return;
      answered = true;
      const reply = onPipelineHuman
        ? onPipelineHuman(msg as PipelineHumanMessage).catch((err): PipelineHumanReply => ({ ok: false, error: err instanceof Error ? err.message : String(err) }))
        : Promise.resolve<PipelineHumanReply>({ ok: false, error: "Pipeline human steps are not supported by this server" });
      void reply.then((r) => conn.end(JSON.stringify(r) + "\n"));
    });
    conn.on("end", () => {
      if (answered) return;
      try {
        const msg = JSON.parse(buffer.trim()) as RunCompleteMessage | NetworkDeniedMessage | SandboxEventMessage;
        if (msg.type === "run_complete") {
          onRunComplete(msg.runId, msg.taskId, msg.status);
        } else if (msg.type === "network_denied") {
          onNetworkDenied?.(msg);
        } else if (msg.type === "sandbox_event") {
          onSandboxEvent?.(msg);
        }
      } catch { /* handler error — ignore */ }
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
 * Client-side: send a pipeline human-step message and wait for the reply.
 * Rejects when the orchestrator is unreachable or does not answer in time.
 */
export function askPipelineHuman(socketPath: string, msg: PipelineHumanMessage, timeoutMs = 10_000): Promise<PipelineHumanReply> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    let done = false;
    const finish = (fn: () => void) => { if (!done) { done = true; clearTimeout(timer); fn(); } };
    const conn = createConnection(socketPath);
    const timer = setTimeout(() => finish(() => { conn.destroy(); reject(new Error("Orchestrator did not answer")); }), timeoutMs);
    const settle = () => finish(() => {
      conn.destroy();
      try { resolve(JSON.parse(buffer.trim()) as PipelineHumanReply); }
      catch { reject(new Error(buffer ? "Malformed reply from orchestrator" : "Orchestrator closed the connection without answering")); }
    });
    conn.setEncoding("utf-8");
    conn.on("data", (chunk) => {
      buffer += chunk;
      if (buffer.includes("\n")) settle();
    });
    conn.on("end", settle);
    conn.on("error", (err) => finish(() => reject(err)));
    // Keep the connection open (no end()): the reply comes back on it.
    conn.write(JSON.stringify(msg) + "\n");
  });
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
