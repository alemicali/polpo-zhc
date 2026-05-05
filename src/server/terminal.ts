import { timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { relative, resolve, sep } from "node:path";
import type { Duplex } from "node:stream";
import { parse as parseUrl } from "node:url";
import type { IPty } from "node-pty";
import { WebSocketServer, type WebSocket } from "ws";
import { getPolpoDir } from "../core/constants.js";
import type { Orchestrator } from "../core/orchestrator.js";
import { AUTH_COOKIE_NAME, isInstanceAuthEnabled, validateSession } from "./auth/instance-auth.js";

type NodePtyModule = typeof import("node-pty");
type UpgradeServer = {
  on(event: "upgrade", listener: (req: IncomingMessage, socket: Duplex, head: Buffer) => void): unknown;
  off(event: "upgrade", listener: (req: IncomingMessage, socket: Duplex, head: Buffer) => void): unknown;
};

export interface TerminalWebSocketOptions {
  apiKeys?: string[];
  workDir?: string;
}

export interface TerminalWebSocketHandle {
  close: () => void;
}

type RuntimeTerminalSession = {
  id: string;
  revision: number;
  shell: IPty;
  clients: Set<WebSocket>;
  buffer: string;
};

const TERMINAL_BUFFER_LIMIT = 200_000;

export function isTerminalEnabled(): boolean {
  const value = process.env.POLPO_TERMINAL_ENABLED;
  return value === undefined || (value !== "0" && value.toLowerCase() !== "false");
}

export function attachTerminalWebSocket(
  server: UpgradeServer,
  orchestrator: Orchestrator,
  opts: TerminalWebSocketOptions = {},
): TerminalWebSocketHandle {
  const wss = new WebSocketServer({ noServer: true });
  const sessions = new Map<string, RuntimeTerminalSession>();

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = parseUrl(req.url ?? "", true);
    if (url.pathname !== "/ws/terminal") return;

    if (!isTerminalEnabled()) {
      rejectUpgrade(socket, 403, "Terminal disabled");
      return;
    }

    if (!orchestrator.isInitialized) {
      rejectUpgrade(socket, 503, "Polpo is not initialized");
      return;
    }

    if (!isTerminalRequestAuthorized(req, activePolpoDir(orchestrator, opts), opts.apiKeys ?? [], url.query.api_key)) {
      rejectUpgrade(socket, 401, "Login required");
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req, url.query);
    });
  };

  server.on("upgrade", onUpgrade);

  wss.on("connection", async (ws: WebSocket, _req: IncomingMessage, query: Record<string, string | string[] | undefined>) => {
    try {
      const pty = await loadNodePty();
      const agentWorkDir = orchestrator.getAgentWorkDir();
      const cwd = resolveTerminalCwd(agentWorkDir, firstValue(query.cwd));
      const shellPath = process.env.POLPO_TERMINAL_SHELL || process.env.SHELL || "/bin/bash";
      const cols = clampNumber(firstValue(query.cols), 20, 240, 100);
      const rows = clampNumber(firstValue(query.rows), 8, 80, 30);
      const agentKind = parseAgentKind(firstValue(query.agent));
      const agentSessionId = firstValue(query.agent_session_id) ?? "";
      const sessionId = normalizeSessionId(firstValue(query.session_id));
      const revision = clampNumber(firstValue(query.revision), 0, Number.MAX_SAFE_INTEGER, 0);
      const { command, args } = buildAgentInvocation(agentKind, shellPath);

      let session = sessions.get(sessionId);
      if (session && session.revision !== revision) {
        session.shell.kill();
        sessions.delete(sessionId);
        session = undefined;
      }
      if (!session) {
        const shell = pty.spawn(command, args, {
          name: "xterm-ghostty",
          cols,
          rows,
          cwd,
          env: {
            ...process.env,
            TERM: "xterm-ghostty",
            COLORTERM: "truecolor",
            POLPO_WORKDIR: orchestrator.getWorkDir(),
            POLPO_AGENT_WORKDIR: agentWorkDir,
            POLPO_TERMINAL_CWD: cwd,
            POLPO_AGENT_KIND: agentKind,
            POLPO_AGENT_SESSION_ID: agentSessionId,
          } as Record<string, string>,
        });
        session = { id: sessionId, revision, shell, clients: new Set(), buffer: "" };
        sessions.set(sessionId, session);

        const dataDisposable = shell.onData((data) => {
          const current = sessions.get(sessionId);
          if (!current || current.shell !== shell) return;
          current.buffer = appendTerminalBuffer(current.buffer, data);
          for (const client of current.clients) {
            if (client.readyState === client.OPEN) client.send(data);
          }
        });
        const exitDisposable = shell.onExit(({ exitCode, signal }) => {
          const current = sessions.get(sessionId);
          if (!current || current.shell !== shell) return;
          const message = `\r\n[terminal exited: ${signal ?? exitCode}]\r\n`;
          current.buffer = appendTerminalBuffer(current.buffer, message);
          for (const client of current.clients) {
            if (client.readyState === client.OPEN) {
              client.send(message);
              client.close(1000, "terminal exited");
            }
          }
          current.clients.clear();
          dataDisposable.dispose();
          exitDisposable.dispose();
          sessions.delete(sessionId);
        });
      }

      session.clients.add(ws);
      if (session.buffer) ws.send(session.buffer);
      session.shell.resize(cols, rows);

      ws.on("message", (payload) => {
        const current = sessions.get(sessionId);
        if (!current) return;
        const message = parseClientMessage(payload);
        if (!message) return;
        if (message.type === "input") {
          current.shell.write(message.data);
        } else {
          current.shell.resize(message.cols, message.rows);
        }
      });

      ws.on("close", () => {
        sessions.get(sessionId)?.clients.delete(ws);
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Terminal failed to start";
      if (ws.readyState === ws.OPEN) {
        ws.send(`Terminal unavailable: ${message}\r\n`);
        ws.close(1011, "terminal unavailable");
      }
    }
  });

  return {
    close: () => {
      server.off("upgrade", onUpgrade);
      for (const session of sessions.values()) session.shell.kill();
      sessions.clear();
      wss.close();
    },
  };
}

function appendTerminalBuffer(buffer: string, data: string): string {
  const next = buffer + data;
  return next.length > TERMINAL_BUFFER_LIMIT ? next.slice(next.length - TERMINAL_BUFFER_LIMIT) : next;
}

function resolveTerminalCwd(agentWorkDir: string, requested: string | undefined): string {
  const root = resolve(agentWorkDir);
  const target = resolve(root, requested?.trim() || ".");
  const rel = relative(root, target);
  if (rel === ".." || rel.startsWith(`..${sep}`) || resolve(target) !== target) {
    throw new Error("Terminal cwd must be inside the agent workspace.");
  }
  mkdirSync(target, { recursive: true });
  return target;
}

function activePolpoDir(orchestrator: Orchestrator, opts: TerminalWebSocketOptions): string {
  return orchestrator.isInitialized ? orchestrator.getPolpoDir() : getPolpoDir(opts.workDir ?? process.cwd());
}

async function loadNodePty(): Promise<NodePtyModule> {
  return import("node-pty");
}

function isTerminalRequestAuthorized(
  req: IncomingMessage,
  polpoDir: string,
  apiKeys: string[],
  queryApiKey: string | string[] | undefined,
): boolean {
  if (hasValidApiKey(req, apiKeys, firstValue(queryApiKey))) return true;
  if (!isInstanceAuthEnabled()) return apiKeys.length === 0;
  const token = parseCookie(req.headers.cookie ?? "")[AUTH_COOKIE_NAME];
  return !!validateSession(polpoDir, token);
}

function hasValidApiKey(req: IncomingMessage, apiKeys: string[], queryApiKey?: string): boolean {
  if (apiKeys.length === 0) return false;
  const xApiKey = singleHeader(req.headers["x-api-key"]);
  const auth = singleHeader(req.headers.authorization);
  const bearer = auth?.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : undefined;
  const key = xApiKey ?? bearer ?? queryApiKey;
  return !!key && apiKeys.some((expected) => safeCompare(expected, key));
}

function parseClientMessage(payload: WebSocket.RawData):
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number }
  | null {
  const text = rawDataToString(payload);
  try {
    const parsed = JSON.parse(text) as { type?: unknown; data?: unknown; cols?: unknown; rows?: unknown };
    if (parsed.type === "input" && typeof parsed.data === "string") {
      return { type: "input", data: parsed.data };
    }
    if (parsed.type === "resize") {
      return {
        type: "resize",
        cols: clampNumber(parsed.cols, 20, 240, 100),
        rows: clampNumber(parsed.rows, 8, 80, 30),
      };
    }
  } catch {
    return null;
  }
  return null;
}

function rawDataToString(payload: WebSocket.RawData): string {
  if (typeof payload === "string") return payload;
  if (Array.isArray(payload)) return Buffer.concat(payload).toString("utf8");
  if (payload instanceof ArrayBuffer) return Buffer.from(new Uint8Array(payload)).toString("utf8");
  return Buffer.from(payload as Uint8Array).toString("utf8");
}

function parseCookie(header: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) cookies[key] = decodeURIComponent(value);
  }
  return cookies;
}

function rejectUpgrade(socket: Duplex, status: number, message: string): void {
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function normalizeSessionId(value: string | undefined): string {
  const raw = value?.trim() || `terminal_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
  return raw.replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, 160);
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

type AgentKind = "terminal" | "claude" | "codex";

function parseAgentKind(value: string | undefined): AgentKind {
  if (value === "claude" || value === "codex") return value;
  return "terminal";
}

/**
 * Builds the spawn command for the given agent kind. Always launches
 * through a login shell so:
 * - PATH/aliases/nvm are available
 * - claude/codex find their auth state in the user's home dir
 *
 * For agent kinds, we let the user `--continue` themselves rather than
 * forcing flags — claude/codex have rich resume semantics that vary by
 * version. The agent kind + session id are exposed via env vars so the
 * agent CLI (or the shell rc) can react if desired.
 */
function buildAgentInvocation(kind: AgentKind, shellPath: string): { command: string; args: string[] } {
  switch (kind) {
    case "claude":
      return { command: shellPath, args: ["-l", "-c", "claude"] };
    case "codex":
      return { command: shellPath, args: ["-l", "-c", "codex"] };
    case "terminal":
    default:
      return { command: shellPath, args: [] };
  }
}
