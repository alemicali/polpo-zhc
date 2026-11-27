/**
 * A computer's live view: WebSocket /api/v1/computers/:id/desktop/vnc → the VM's websockify
 * (desktop.ts) through the provider's preview link, bytes both ways (noVNC speaks RFB over it).
 *
 * - Authorized like the terminal (API key, or the instance session cookie): rejected with 401
 *   before the upgrade otherwise.
 * - Only while this server started the live view (it holds the VNC passwords): 409 otherwise.
 * - The VNC server still asks its password: full control only for the person holding the computer
 *   (GET /computers/:id/desktop?viewer=1 hands each viewer the one their role allows). When control
 *   changes hands the passwords change and x11vnc restarts, so open viewers are cut and reconnect.
 * - While a viewer is connected the computer is in use (no idle hibernation under a person).
 */
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { parse as parseUrl } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import type { ComputerConfig } from "@polpo-ai/core";
import type { ComputerDesktops } from "../sandbox/desktop.js";
import { desktopUnsupported } from "../sandbox/desktop.js";

type UpgradeServer = {
  on(event: "upgrade", listener: (req: IncomingMessage, socket: Duplex, head: Buffer) => void): unknown;
  off(event: "upgrade", listener: (req: IncomingMessage, socket: Duplex, head: Buffer) => void): unknown;
};

export const DESKTOP_VNC_PATH = /^\/api\/v1\/computers\/([a-z0-9][a-z0-9-]{0,39})\/desktop\/vnc\/?$/;

/** What a viewer may have unsent before it is dropped (it reconnects). */
const MAX_BUFFERED = 8 * 1024 * 1024;

export interface ComputerDesktopWsDeps {
  /** The upgrade comes from a signed-in person (see isTerminalRequestAuthorized). */
  authorize: (req: IncomingMessage, query: Record<string, string | string[] | undefined>) => boolean;
  ready: () => boolean;
  computer: (id: string) => ComputerConfig | undefined;
  desktops: () => ComputerDesktops;
  /** Tests: the upstream socket (default: a WebSocket to the endpoint). */
  connectUpstream?: (url: string, headers: Record<string, string>) => WebSocket;
}

function reject(socket: Duplex, status: number, message: string): void {
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

export function attachComputerDesktopWebSocket(server: UpgradeServer, deps: ComputerDesktopWsDeps): { close: () => void } {
  const wss = new WebSocketServer({ noServer: true });

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = parseUrl(req.url ?? "", true);
    const m = DESKTOP_VNC_PATH.exec(url.pathname ?? "");
    if (!m) return;
    if (!deps.ready()) { reject(socket, 503, "Polpo is not initialized"); return; }
    if (!deps.authorize(req, url.query)) { reject(socket, 401, "Login required"); return; }
    const computer = deps.computer(m[1]!);
    if (!computer) { reject(socket, 404, "No such computer"); return; }
    if (desktopUnsupported(computer)) { reject(socket, 400, "This computer has no live view"); return; }
    const desktops = deps.desktops();
    if (!desktops.started(computer.id)) { reject(socket, 409, "The live view is not started"); return; }
    void desktops.endpoint(computer).then((endpoint) => {
      wss.handleUpgrade(req, socket, head, (client) => pipe(client, endpoint, computer, desktops));
    }).catch(() => reject(socket, 502, "The computer's live view cannot be reached"));
  };

  const pipe = (client: WebSocket, endpoint: { url: string; headers?: Record<string, string> }, computer: ComputerConfig, desktops: ComputerDesktops) => {
    const release = desktops.hold(computer);
    const upstream = deps.connectUpstream?.(endpoint.url, endpoint.headers ?? {}) ?? new WebSocket(endpoint.url, { headers: endpoint.headers ?? {}, perMessageDeflate: false });
    const pending: Buffer[] = [];
    let closed = false;
    const closeBoth = (code = 1000, reason = "") => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      release();
      if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) client.close(code, reason);
      if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) upstream.terminate();
    };
    upstream.on("open", () => {
      for (const b of pending.splice(0)) upstream.send(b, { binary: true });
    });
    upstream.on("message", (data: Buffer | ArrayBuffer | Buffer[]) => {
      if (client.readyState !== WebSocket.OPEN) return;
      const payload = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
      // a viewer that cannot keep up is dropped (it reconnects) rather than buffering without end
      if (client.bufferedAmount >= MAX_BUFFERED) { closeBoth(1013, "The viewer is too slow"); return; }
      client.send(payload, { binary: true });
    });
    client.on("message", (data: Buffer | ArrayBuffer | Buffer[]) => {
      const payload = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (upstream.readyState === WebSocket.OPEN) upstream.send(payload, { binary: true });
      else if (upstream.readyState === WebSocket.CONNECTING) pending.push(payload);
    });
    let alive = true;
    client.on("pong", () => { alive = true; });
    const heartbeat = setInterval(() => {
      if (client.readyState !== WebSocket.OPEN) return;
      if (!alive) { client.terminate(); return; }
      alive = false;
      client.ping();
    }, 15_000);
    heartbeat.unref?.();
    client.on("close", () => closeBoth());
    client.on("error", () => closeBoth());
    upstream.on("close", () => closeBoth(1011, "The live view closed (control may have changed hands)"));
    upstream.on("error", () => closeBoth(1011, "The live view cannot be reached"));
  };

  server.on("upgrade", onUpgrade);
  return { close: () => { server.off("upgrade", onUpgrade); wss.close(); } };
}
