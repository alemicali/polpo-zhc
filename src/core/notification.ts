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

/**
 * A task run's agent talks to another agent (ask_agent, message_agent, escalate): the server
 * knows the agent and the task from the run, never from the request.
 */
export interface AgentTalkWireRequest {
  type: "agent_talk";
  op: "ask" | "send" | "escalate";
  runId: string;
  to?: string;
  text: string;
}

export type AgentTalkWireReply = { ok: true; to: string; answer?: string } | { ok: false; error: string };

/**
 * A task run's agent posts to a notification channel (send_notification): the server knows the
 * agent and the task from the run, never from the request, and checks the agent's allowlist.
 */
export interface AgentNotifyWireRequest {
  type: "agent_notify";
  runId: string;
  channel: string;
  to?: string;
  threadTs?: string;
  title?: string;
  body: string;
  severity?: "info" | "warning" | "critical";
}

export type AgentNotifyWireReply = { ok: true; id: string; channel: string; to?: string } | { ok: false; error: string };

type WireRequest = AgentTalkWireRequest | AgentNotifyWireRequest;
type WireReply<R extends WireRequest> = R extends AgentNotifyWireRequest ? AgentNotifyWireReply : AgentTalkWireReply;

/** Server-side: orchestrator listens for runner completion notifications. */
export function startNotificationServer(
  polpoDir: string,
  onRunComplete: (runId: string, taskId: string, status: string) => void,
  onNetworkDenied?: (msg: NetworkDeniedMessage) => void,
  onSandboxEvent?: (msg: SandboxEventMessage) => void,
  /** A task run's agent talking to another agent (a request: the reply is written back). */
  onAgentTalk?: (msg: AgentTalkWireRequest) => Promise<AgentTalkWireReply>,
  /** A task run's agent posting to a notification channel (a request: the reply is written back). */
  onAgentNotify?: (msg: AgentNotifyWireRequest) => Promise<AgentNotifyWireReply>,
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
      // a request (agent_talk) is one line and waits for its reply on the same connection
      const newline = buffer.indexOf("\n");
      if (answered || newline < 0) return;
      let msg: { type?: string } | undefined;
      try { msg = JSON.parse(buffer.slice(0, newline)); } catch { return; }
      if (msg?.type !== "agent_talk" && msg?.type !== "agent_notify") return;
      answered = true;
      const failed = (err: unknown) => ({ ok: false as const, error: err instanceof Error ? err.message : String(err) });
      const reply: Promise<AgentTalkWireReply | AgentNotifyWireReply> = msg.type === "agent_notify"
        ? (onAgentNotify
          ? onAgentNotify(msg as AgentNotifyWireRequest).catch(failed)
          : Promise.resolve({ ok: false as const, error: "notifications cannot be sent from here" }))
        : onAgentTalk
        ? onAgentTalk(msg as AgentTalkWireRequest).catch(failed)
        : Promise.resolve<AgentTalkWireReply>({ ok: false, error: "agents cannot be reached from here" });
      void reply.then((r) => { if (!conn.destroyed) conn.end(JSON.stringify(r) + "\n"); });
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

/** Client-side: a request (agent_talk, agent_notify) and its reply; an unreachable server or a timeout is an error reply. */
export function requestOverSocket<R extends WireRequest>(socketPath: string, msg: R, timeoutMs: number): Promise<WireReply<R>> {
  return new Promise((resolvePromise) => {
    let buffer = "";
    let settled = false;
    const done = (reply: AgentTalkWireReply | AgentNotifyWireReply) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      conn.destroy();
      resolvePromise(reply as WireReply<R>);
    };
    const conn = createConnection(socketPath);
    const timer = setTimeout(() => done({ ok: false, error: "no reply from Polpo in time" }), timeoutMs);
    conn.setEncoding("utf-8");
    conn.on("error", (err) => done({ ok: false, error: `Polpo cannot be reached from this run (${err.message})` }));
    conn.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try { done(JSON.parse(buffer.slice(0, newline)) as WireReply<R>); } catch { done({ ok: false, error: "malformed reply" }); }
    });
    conn.on("end", () => done({ ok: false, error: "Polpo closed the connection without a reply" }));
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
