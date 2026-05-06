import { timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import type { IncomingMessage } from "node:http";
import { join, relative, resolve, sep } from "node:path";
import type { Duplex } from "node:stream";
import { parse as parseUrl } from "node:url";
import type { IPty } from "node-pty";
import { WebSocketServer, type WebSocket } from "ws";
import { getPolpoDir } from "../core/constants.js";
import type { Orchestrator } from "../core/orchestrator.js";
import { AUTH_COOKIE_NAME, isInstanceAuthEnabled, validateSession } from "./auth/instance-auth.js";
import { getEffectiveAllowedRoots } from "./coding-config-store.js";

type NodePtyModule = typeof import("node-pty");
type UpgradeServer = {
  on(event: "upgrade", listener: (req: IncomingMessage, socket: Duplex, head: Buffer) => void): unknown;
  off(event: "upgrade", listener: (req: IncomingMessage, socket: Duplex, head: Buffer) => void): unknown;
};

export interface TerminalWebSocketOptions {
  apiKeys?: string[];
  workDir?: string;
}

export interface TerminalSessionSnapshot {
  id: string;
  pid: number;
  cwd: string;
  agentKind: "terminal" | "claude" | "codex";
  agentCommand?: string;
  startedAt: string;
  clients: number;
}

export interface TerminalWebSocketHandle {
  close: () => void;
  listSessions: () => TerminalSessionSnapshot[];
  killSession: (id: string) => boolean;
}

type RuntimeTerminalSession = {
  id: string;
  revision: number;
  shell: IPty;
  clients: Set<WebSocket>;
  buffer: string;
  cwd: string;
  agentKind: "terminal" | "claude" | "codex";
  agentCommand?: string;
  startedAt: string;
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
      const cwd = resolveTerminalCwd(agentWorkDir, firstValue(query.cwd), orchestrator.getPolpoDir());
      const shellPath = process.env.POLPO_TERMINAL_SHELL || process.env.SHELL || "/bin/bash";
      const cols = clampNumber(firstValue(query.cols), 20, 240, 100);
      const rows = clampNumber(firstValue(query.rows), 8, 80, 30);
      const agentKind = parseAgentKind(firstValue(query.agent));
      const agentSessionId = firstValue(query.agent_session_id) ?? "";
      const agentCommandOverride = firstValue(query.agent_command);
      const sessionId = normalizeSessionId(firstValue(query.session_id));
      const revision = clampNumber(firstValue(query.revision), 0, Number.MAX_SAFE_INTEGER, 0);
      const { command, args } = buildAgentInvocation(agentKind, shellPath, {
        override: agentCommandOverride,
        sessionId: agentSessionId,
        cwd,
      });

      let session = sessions.get(sessionId);
      if (session && session.revision !== revision) {
        session.shell.kill();
        sessions.delete(sessionId);
        session = undefined;
      }
      if (!session) {
        const shell = pty.spawn(command, args, {
          // xterm-256color is universally available in terminfo databases;
          // xterm-ghostty requires shipping ghostty's terminfo on the host
          // and trips up `less`, `vim`, and friends with "unknown terminal".
          name: "xterm-256color",
          cols,
          rows,
          cwd,
          env: {
            ...process.env,
            TERM: "xterm-256color",
            COLORTERM: "truecolor",
            POLPO_WORKDIR: orchestrator.getWorkDir(),
            POLPO_AGENT_WORKDIR: agentWorkDir,
            POLPO_TERMINAL_CWD: cwd,
            POLPO_AGENT_KIND: agentKind,
            POLPO_AGENT_SESSION_ID: agentSessionId,
          } as Record<string, string>,
        });
        session = {
          id: sessionId,
          revision,
          shell,
          clients: new Set(),
          buffer: "",
          cwd,
          agentKind,
          agentCommand: agentCommandOverride,
          startedAt: new Date().toISOString(),
        };
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
    listSessions: () => Array.from(sessions.values()).map((session) => ({
      id: session.id,
      pid: session.shell.pid,
      cwd: session.cwd,
      agentKind: session.agentKind,
      agentCommand: session.agentCommand,
      startedAt: session.startedAt,
      clients: session.clients.size,
    })),
    killSession: (id: string) => {
      const session = sessions.get(id);
      if (!session) return false;
      session.shell.kill();
      sessions.delete(id);
      return true;
    },
  };
}

function appendTerminalBuffer(buffer: string, data: string): string {
  const next = buffer + data;
  return next.length > TERMINAL_BUFFER_LIMIT ? next.slice(next.length - TERMINAL_BUFFER_LIMIT) : next;
}

function resolveTerminalCwd(agentWorkDir: string, requested: string | undefined, polpoDir: string): string {
  const root = resolve(agentWorkDir);
  const target = resolve(root, requested?.trim() || ".");
  if (!isInsideAnyRoot(target, [root, ...getEffectiveAllowedRoots(polpoDir)])) {
    throw new Error("Terminal cwd must be inside the agent workspace or a whitelisted root.");
  }
  mkdirSync(target, { recursive: true });
  return target;
}

function isInsideAnyRoot(target: string, roots: string[]): boolean {
  const t = resolve(target);
  for (const root of roots) {
    const r = resolve(root);
    if (t === r) return true;
    const rel = relative(r, t);
    if (rel && rel !== ".." && !rel.startsWith(`..${sep}`)) return true;
  }
  return false;
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
 * Builds the spawn command for the given agent kind.
 *
 * For Claude/Codex we also wire in transcript-based session resumption:
 *   - Claude has `--session-id <UUID>` so we control the id at first run,
 *     then `--resume <id>` on subsequent reattaches once the transcript
 *     file exists at `~/.claude/projects/<encoded-cwd>/<id>.jsonl`.
 *   - Codex doesn't accept a pre-chosen id at start, so we spawn plain on
 *     first run and `codex resume --last` on reattach (cwd-scoped, picks
 *     the most recent conversation tied to this directory).
 *
 * The whole command is still launched through a login shell so PATH/nvm/
 * aliases resolve identically to what the user would see in their own
 * terminal.
 */
function buildAgentInvocation(
  kind: AgentKind,
  shellPath: string,
  opts: { override?: string; sessionId?: string; cwd?: string } = {},
): { command: string; args: string[] } {
  // When the client provides a custom one-shot command (set via the coding
  // settings dialog — typically `claude -p ...` for the PR button) we
  // execute it as-is and skip session-resumption logic entirely; -p mode
  // doesn't persist anyway.
  const trimmed = opts.override?.trim();
  if (trimmed) {
    if (kind === "terminal") {
      // For a plain shell session we ignore the override — opening "the shell"
      // shouldn't silently morph into another binary.
      return { command: shellPath, args: [] };
    }
    return { command: shellPath, args: ["-l", "-c", trimmed] };
  }
  switch (kind) {
    case "claude":
      return { command: shellPath, args: ["-l", "-c", buildClaudeShellCmd(opts.sessionId)] };
    case "codex":
      return { command: shellPath, args: ["-l", "-c", buildCodexShellCmd(opts.cwd)] };
    case "terminal":
    default:
      return { command: shellPath, args: [] };
  }
}

function buildClaudeShellCmd(sessionId: string | undefined): string {
  if (!sessionId) return "claude";
  // If a transcript for this UUID already exists, resume; otherwise pin
  // the id at session start so future reattaches can `--resume`.
  return claudeTranscriptExists(sessionId)
    ? `claude --resume ${shellQuote(sessionId)}`
    : `claude --session-id ${shellQuote(sessionId)}`;
}

function buildCodexShellCmd(cwd: string | undefined): string {
  // Codex auto-generates ids and scopes `resume --last` to the cwd, so
  // we just rely on its own per-cwd transcript bookkeeping.
  if (!cwd || !codexHasSessionFor(cwd)) return "codex";
  return "codex resume --last";
}

/** Claude stores transcripts at ~/.claude/projects/<encoded>/<UUID>.jsonl
 * where `encoded` is the cwd with `/` and `.` collapsed to `-`. We don't
 * trust the encoding to stay stable across versions, so we just scan all
 * project dirs for the UUID file (UUIDs are unique across projects). */
function claudeTranscriptExists(sessionId: string): boolean {
  const projectsDir = join(homedir(), ".claude", "projects");
  if (!existsSync(projectsDir)) return false;
  let entries: string[];
  try { entries = readdirSync(projectsDir); } catch { return false; }
  for (const name of entries) {
    if (existsSync(join(projectsDir, name, `${sessionId}.jsonl`))) return true;
  }
  return false;
}

/** Has codex ever recorded a session whose `cwd` field matches ours? We
 * only need a yes/no, so a fast "is the sessions dir non-empty" check is
 * sufficient — `codex resume --last` itself does the cwd matching. */
function codexHasSessionFor(_cwd: string): boolean {
  const dir = join(homedir(), ".codex", "sessions");
  if (!existsSync(dir)) return false;
  try {
    const entries = readdirSync(dir);
    for (const name of entries) {
      const full = join(dir, name);
      try {
        const st = statSync(full);
        if (st.isFile() || st.isDirectory()) return true;
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  return false;
}

function shellQuote(value: string): string {
  // UUIDs only — but be safe in case anything else slips through.
  return `'${value.replace(/'/g, "'\\''")}'`;
}
