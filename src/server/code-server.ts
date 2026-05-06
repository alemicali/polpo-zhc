import { timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { relative, resolve, sep, join } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { Duplex } from "node:stream";
import { parse as parseUrl } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { getPolpoDir } from "../core/constants.js";
import type { Orchestrator } from "../core/orchestrator.js";
import { AUTH_COOKIE_NAME, isInstanceAuthEnabled, validateSession } from "./auth/instance-auth.js";
import { getEffectiveAllowedRoots } from "./coding-config-store.js";

type UpgradeServer = {
  on(event: "upgrade", listener: (req: IncomingMessage, socket: Duplex, head: Buffer) => void): unknown;
  off(event: "upgrade", listener: (req: IncomingMessage, socket: Duplex, head: Buffer) => void): unknown;
};

export interface CodeServerOptions {
  apiKeys?: string[];
  workDir?: string;
}

export interface CodeServerSessionInfo {
  id: string;
  port: number;
  cwd: string;
  url: string;
  directUrl: string;
  running: boolean;
  theme: CodeServerTheme;
  pid?: number;
  startedAt?: string;
}

export type CodeServerTheme = "light" | "dark";

export interface CodeServerSessionOptions {
  force?: boolean;
  theme?: CodeServerTheme;
}

type RuntimeSession = {
  id: string;
  port: number;
  cwd: string;
  theme: CodeServerTheme;
  process: ChildProcessWithoutNullStreams;
  startedAt: string;
};

type FetchInitWithDuplex = RequestInit & { duplex?: "half" };

export function isCodeServerEnabled(): boolean {
  const value = process.env.POLPO_CODE_SERVER_ENABLED;
  return value === undefined || (value !== "0" && value.toLowerCase() !== "false");
}

/*
 * Runtime process handles stay in memory by design: a ChildProcess and its
 * bound port cannot be serialized into the coding session store. The store is
 * the durable registry; this manager owns the live process lifecycle.
 */
export class CodeServerManager {
  private sessions = new Map<string, RuntimeSession>();

  constructor(private readonly orchestrator: Orchestrator) {}

  async ensureSession(
    id: string,
    requestedCwd: string | undefined,
    options: CodeServerSessionOptions = {},
  ): Promise<CodeServerSessionInfo> {
    if (!isCodeServerEnabled()) throw new Error("code-server is disabled.");
    if (!this.orchestrator.isInitialized) throw new Error("Polpo is not initialized.");

    const theme = options.theme ?? "dark";
    const existing = this.sessions.get(id);
    if (existing && existing.process.exitCode == null) {
      if (options.force) {
        await this.stopSession(id);
      } else {
        const baseDir = join(this.orchestrator.getPolpoDir(), "code-server", id);
        prepareCodeServerUserData(baseDir, theme);
        existing.theme = theme;
        return this.info(existing);
      }
    } else if (existing) {
      this.sessions.delete(id);
    }

    const aliveAfterStop = this.sessions.get(id);
    if (aliveAfterStop && aliveAfterStop.process.exitCode == null) {
      return this.info(aliveAfterStop);
    }

    const cwd = resolveWorkspaceCwd(this.orchestrator.getAgentWorkDir(), requestedCwd, this.orchestrator.getPolpoDir());
    const port = await getFreePort(serverReservedPorts(), codeServerPortRange());
    const baseDir = join(this.orchestrator.getPolpoDir(), "code-server", id);
    const userDataDir = prepareCodeServerUserData(baseDir, theme);
    const extensionsDir = join(baseDir, "extensions");
    mkdirSync(extensionsDir, { recursive: true });

    const bin = resolveCodeServerBin();
    const child = spawn(bin, [
      cwd,
      "--bind-addr", `127.0.0.1:${port}`,
      "--auth", "none",
      "--disable-telemetry",
      "--disable-update-check",
      "--disable-workspace-trust",
      "--disable-getting-started-override",
      "--ignore-last-opened",
      "--user-data-dir", userDataDir,
      "--extensions-dir", extensionsDir,
    ], {
      cwd,
      env: {
        ...codeServerEnv(),
        POLPO_WORKDIR: this.orchestrator.getWorkDir(),
        POLPO_AGENT_WORKDIR: this.orchestrator.getAgentWorkDir(),
      },
    });

    child.once("exit", () => {
      const current = this.sessions.get(id);
      if (current?.process === child) this.sessions.delete(id);
    });
    child.stderr.on("data", (chunk) => {
      const text = String(chunk).trim();
      if (text) console.warn(`[code-server:${id}] ${text}`);
    });

    const session: RuntimeSession = { id, port, cwd, theme, process: child, startedAt: new Date().toISOString() };
    this.sessions.set(id, session);
    try {
      await waitForCodeServer(child, port, 8_000);
    } catch (err) {
      this.sessions.delete(id);
      child.kill();
      throw err;
    }
    return this.info(session);
  }

  getSession(id: string): RuntimeSession | undefined {
    const session = this.sessions.get(id);
    if (!session || session.process.exitCode != null) return undefined;
    return session;
  }

  listSessions(): CodeServerSessionInfo[] {
    return Array.from(this.sessions.values())
      .filter((session) => session.process.exitCode == null)
      .map((session) => this.info(session));
  }

  async stopSession(id: string): Promise<boolean> {
    const session = this.sessions.get(id);
    if (!session) return false;
    this.sessions.delete(id);
    if (session.process.exitCode != null) return true;

    await new Promise<void>((resolveStop) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolveStop();
      };
      const timeout = setTimeout(() => {
        if (session.process.exitCode == null) session.process.kill("SIGKILL");
        finish();
      }, 1_500);
      session.process.once("exit", finish);
      session.process.kill();
    });
    return true;
  }

  close(): void {
    for (const session of this.sessions.values()) session.process.kill();
    this.sessions.clear();
  }

  private info(session: RuntimeSession): CodeServerSessionInfo {
    return {
      id: session.id,
      port: session.port,
      cwd: session.cwd,
      url: `/api/v1/coding/code-server/${encodeURIComponent(session.id)}/`,
      directUrl: makeDirectUrl(session.port),
      running: session.process.exitCode == null,
      theme: session.theme,
      pid: session.process.pid,
      startedAt: session.startedAt,
    };
  }
}

export function attachCodeServerWebSocket(
  server: UpgradeServer,
  manager: CodeServerManager,
  orchestrator: Orchestrator,
  opts: CodeServerOptions = {},
): { close: () => void } {
  const wss = new WebSocketServer({ noServer: true });

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = parseUrl(req.url ?? "", true);
    const match = (url.pathname ?? "").match(/^\/api\/v1\/coding\/code-server\/([^/]+)\/?(.*)$/);
    if (!match) return;

    if (!isCodeServerRequestAuthorized(req, activePolpoDir(orchestrator, opts), opts.apiKeys ?? [], url.query.api_key)) {
      rejectUpgrade(socket, 401, "Login required");
      return;
    }

    const sessionId = decodeURIComponent(match[1]);
    const session = manager.getSession(sessionId);
    if (!session) {
      rejectUpgrade(socket, 404, "code-server session not found");
      return;
    }

    wss.handleUpgrade(req, socket, head, (client) => {
      const rest = match[2] || "";
      const upstreamUrl = `ws://127.0.0.1:${session.port}/${rest}${url.search ?? ""}`;
      const upstream = new WebSocket(upstreamUrl);
      upstream.on("open", () => {
        client.on("message", (data, isBinary) => upstream.readyState === WebSocket.OPEN && upstream.send(data, { binary: isBinary }));
        upstream.on("message", (data, isBinary) => client.readyState === WebSocket.OPEN && client.send(data, { binary: isBinary }));
      });
      const closeBoth = () => {
        if (client.readyState === WebSocket.OPEN) client.close();
        if (upstream.readyState === WebSocket.OPEN) upstream.close();
      };
      client.on("close", closeBoth);
      upstream.on("close", closeBoth);
      upstream.on("error", closeBoth);
    });
  };

  server.on("upgrade", onUpgrade);
  return { close: () => { server.off("upgrade", onUpgrade); wss.close(); } };
}

export async function proxyCodeServerRequest(session: CodeServerSessionInfo, path: string, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const target = `http://127.0.0.1:${session.port}/${path}${url.search}`;
  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("cookie");
  headers.set("x-forwarded-host", url.host);
  headers.set("x-forwarded-proto", url.protocol.replace(":", ""));

  const init: FetchInitWithDuplex = {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
    redirect: "manual",
    duplex: request.method === "GET" || request.method === "HEAD" ? undefined : "half",
  };

  const upstream = await fetch(target, init);
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: new Headers(upstream.headers),
  });
}

function resolveWorkspaceCwd(agentWorkDir: string, requested: string | undefined, polpoDir: string): string {
  const root = resolve(agentWorkDir);
  const target = resolve(root, requested?.trim() || ".");
  if (!isInsideAnyRoot(target, [root, ...getEffectiveAllowedRoots(polpoDir)])) {
    throw new Error("code-server cwd must be inside the agent workspace or a whitelisted root.");
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

function prepareCodeServerUserData(baseDir: string, theme: CodeServerTheme): string {
  const userDataDir = join(baseDir, "user-data-compact");
  const userDir = join(userDataDir, "User");
  mkdirSync(userDir, { recursive: true });
  writeFileSync(join(userDir, "settings.json"), JSON.stringify({
    "workbench.colorTheme": theme === "light" ? "Default Light Modern" : "Default Dark Modern",
    "window.autoDetectColorScheme": false,
    "workbench.startupEditor": "none",
    "workbench.activityBar.location": "hidden",
    "workbench.secondarySideBar.defaultVisibility": "hidden",
    "workbench.sideBar.location": "left",
    "workbench.statusBar.visible": false,
    "workbench.layoutControl.enabled": false,
    "window.commandCenter": false,
    "window.menuBarVisibility": "hidden",
    "editor.minimap.enabled": false,
    "workbench.editor.empty.hint": "hidden",
    "workbench.tips.enabled": false,
    "workbench.welcomePage.walkthroughs.openOnInstall": false,
    "telemetry.telemetryLevel": "off",
  }, null, 2), "utf-8");
  return userDataDir;
}

function resolveCodeServerBin(): string {
  if (process.env.POLPO_CODE_SERVER_BIN?.trim()) return process.env.POLPO_CODE_SERVER_BIN.trim();

  const candidates = [
    process.platform === "win32" ? "" : "/usr/bin/code-server",
    join(process.cwd(), "node_modules", ".bin", process.platform === "win32" ? "code-server.cmd" : "code-server"),
    join(process.cwd(), "..", "node_modules", ".bin", process.platform === "win32" ? "code-server.cmd" : "code-server"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  return "code-server";
}

function makeDirectUrl(port: number): string {
  const protocol = process.env.POLPO_CODE_SERVER_PUBLIC_PROTOCOL || "http";
  const host = process.env.POLPO_CODE_SERVER_PUBLIC_HOST || "localhost";
  return `${protocol}://${host}:${port}/`;
}

function codeServerEnv(): NodeJS.ProcessEnv {
  const { PORT: _port, ...env } = process.env;
  return env;
}

function serverReservedPorts(): Set<number> {
  const ports = new Set<number>();
  const raw = process.env.PORT;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  if (Number.isInteger(parsed) && parsed > 0 && parsed < 65536) ports.add(parsed);
  return ports;
}

async function getFreePort(
  reserved = new Set<number>(),
  range?: { min: number; max: number },
): Promise<number> {
  if (range) {
    // Try each port in the range in randomized order. Allows the operator to
    // restrict code-server to a port window that is pre-exposed via the
    // public reverse proxy / tailnet (so the iframe can target it directly).
    const candidates: number[] = [];
    for (let p = range.min; p <= range.max; p++) if (!reserved.has(p)) candidates.push(p);
    for (let i = candidates.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [candidates[i], candidates[j]] = [candidates[j]!, candidates[i]!];
    }
    for (const port of candidates) if (await isPortFree(port)) return port;
    throw new Error(`Could not allocate a code-server port in range ${range.min}-${range.max}.`);
  }
  for (let attempt = 0; attempt < 40; attempt++) {
    const port = await getEphemeralPort();
    if (!reserved.has(port)) return port;
  }
  throw new Error("Could not allocate a code-server port.");
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolvePort) => {
    const server = createServer();
    server.once("error", () => resolvePort(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolvePort(true)));
  });
}

function codeServerPortRange(): { min: number; max: number } | undefined {
  const raw = process.env.POLPO_CODE_SERVER_PORT_RANGE?.trim();
  if (!raw) return undefined;
  const m = raw.match(/^(\d+)\s*-\s*(\d+)$/);
  if (!m) return undefined;
  const min = Number.parseInt(m[1]!, 10);
  const max = Number.parseInt(m[2]!, 10);
  if (!Number.isInteger(min) || !Number.isInteger(max) || min < 1 || max > 65535 || min > max) return undefined;
  return { min, max };
}

function getEphemeralPort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === "object") resolvePort(address.port);
        else reject(new Error("Could not allocate a code-server port."));
      });
    });
    server.on("error", reject);
  });
}

async function waitForHttp(port: number, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await canConnect(port)) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  }
  throw new Error("code-server did not become ready in time.");
}

async function waitForCodeServer(child: ChildProcessWithoutNullStreams, port: number, timeoutMs: number): Promise<void> {
  await Promise.race([
    waitForHttp(port, timeoutMs),
    new Promise<never>((_, reject) => {
      child.once("error", (err) => reject(new Error(`Could not start code-server: ${err.message}`)));
      child.once("exit", (code, signal) => reject(new Error(`code-server exited before it was ready (${signal ?? code ?? "unknown"}).`)));
    }),
  ]);
}

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolveReady) => {
    const req = httpRequest({ host: "127.0.0.1", port, path: "/", method: "GET", timeout: 500 }, (res) => {
      res.resume();
      resolveReady(true);
    });
    req.on("error", () => resolveReady(false));
    req.on("timeout", () => { req.destroy(); resolveReady(false); });
    req.end();
  });
}

function activePolpoDir(orchestrator: Orchestrator, opts: CodeServerOptions): string {
  return orchestrator.isInitialized ? orchestrator.getPolpoDir() : getPolpoDir(opts.workDir ?? process.cwd());
}

function isCodeServerRequestAuthorized(
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

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
