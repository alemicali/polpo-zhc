/**
 * A computer's live view: WebSocket /api/v1/computers/:id/desktop/vnc → the VM's websockify
 * (desktop.ts) through the provider's preview link, with the Polpo server in the RFB protocol's
 * middle (rfb-proxy.ts).
 *
 * - Authorized like the terminal (API key, or the instance session cookie): rejected with 401
 *   before the upgrade otherwise.
 * - Only while the live view runs (started here, or re-attached after a restart with the password
 *   kept in the vault): 409 otherwise.
 * - The server answers the VM's VNC Authentication itself: the VNC password never reaches the
 *   browser, which sees security type None.
 * - Every viewer watches; input (keys, pointer, clipboard) passes only for the person holding the
 *   computer, decided for each message when it arrives (computer-control.ts): take control and
 *   give back are instant, nobody reconnects.
 * - While a viewer is connected the computer is in use (no idle hibernation under a person).
 */
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { parse as parseUrl } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import type { ComputerConfig } from "@polpo-ai/core";
import type { ComputerDesktops } from "../sandbox/desktop.js";
import { desktopUnsupported } from "../sandbox/desktop.js";
import { RfbProxy } from "./rfb-proxy.js";

type UpgradeServer = {
  on(event: "upgrade", listener: (req: IncomingMessage, socket: Duplex, head: Buffer) => void): unknown;
  off(event: "upgrade", listener: (req: IncomingMessage, socket: Duplex, head: Buffer) => void): unknown;
};

export const DESKTOP_VNC_PATH = /^\/api\/v1\/computers\/([a-z0-9][a-z0-9-]{0,39})\/desktop\/vnc\/?$/;

/** What a viewer may have unsent before it is dropped (it reconnects). */
const MAX_BUFFERED = 8 * 1024 * 1024;
/** How long who holds a computer is trusted between two control changes (they also clear it). */
const HOLDER_TTL_MS = 1_000;

export interface ComputerDesktopWsDeps {
  /** The upgrade comes from a signed-in person (see isTerminalRequestAuthorized). */
  authorize: (req: IncomingMessage, query: Record<string, string | string[] | undefined>) => boolean;
  ready: () => boolean;
  computer: (id: string) => ComputerConfig | undefined;
  desktops: () => ComputerDesktops;
  /** Who is connecting: their member email, else "someone" (as the REST routes see them). */
  person?: (req: IncomingMessage) => string | undefined;
  /** The person holding the computer now (undefined: the agent holds it). */
  holder?: (computerId: string) => string | undefined;
  /** Tests: the upstream socket (default: a WebSocket to the endpoint). */
  connectUpstream?: (url: string, headers: Record<string, string>) => WebSocket;
}

function reject(socket: Duplex, status: number, message: string): void {
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

const toBuffer = (data: Buffer | ArrayBuffer | Buffer[]) => (Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data));

export function attachComputerDesktopWebSocket(server: UpgradeServer, deps: ComputerDesktopWsDeps): { close: () => void; controlChanged: (computerId?: string) => void } {
  const wss = new WebSocketServer({ noServer: true });
  const holders = new Map<string, { person: string | undefined; at: number }>();
  const holderOf = (computerId: string): string | undefined => {
    const cached = holders.get(computerId);
    if (cached && Date.now() - cached.at < HOLDER_TTL_MS) return cached.person;
    const person = deps.holder?.(computerId)?.toLowerCase();
    holders.set(computerId, { person, at: Date.now() });
    return person;
  };

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
    const person = deps.person?.(req)?.toLowerCase() || "someone";
    void desktops.attached(computer).then(async (attached) => {
      const password = attached ? desktops.password(computer.id) : undefined;
      if (!password) { reject(socket, 409, "The live view is not started"); return; }
      const endpoint = await desktops.endpoint(computer);
      wss.handleUpgrade(req, socket, head, (client) => pipe(client, endpoint, computer, desktops, password, person));
    }).catch(() => reject(socket, 502, "The computer's live view cannot be reached"));
  };

  const pipe = (
    client: WebSocket, endpoint: { url: string; headers?: Record<string, string> }, computer: ComputerConfig,
    desktops: ComputerDesktops, password: string, person: string,
  ) => {
    const release = desktops.hold(computer);
    const upstream = deps.connectUpstream?.(endpoint.url, endpoint.headers ?? {}) ?? new WebSocket(endpoint.url, { headers: endpoint.headers ?? {}, perMessageDeflate: false });
    const pending: Buffer[] = [];
    let closed = false;
    const closeBoth = (code = 1000, reason = "") => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      release();
      if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) client.close(code, reason.slice(0, 120));
      if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) upstream.terminate();
    };
    const sendUp = (b: Buffer) => {
      if (upstream.readyState === WebSocket.OPEN) upstream.send(b, { binary: true });
      else if (upstream.readyState === WebSocket.CONNECTING) pending.push(b);
    };
    const proxy = new RfbProxy({
      password,
      canControl: () => holderOf(computer.id) === person,
      toClient: (b) => {
        if (client.readyState !== WebSocket.OPEN) return;
        // a viewer that cannot keep up is dropped (it reconnects) rather than buffering without end
        if (client.bufferedAmount >= MAX_BUFFERED) { closeBoth(1013, "The viewer is too slow"); return; }
        client.send(b, { binary: true });
      },
      toServer: sendUp,
      fail: (why, message) => {
        // a password the VNC server no longer takes: forgotten, the next start sets a new one
        if (why === "auth") desktops.invalidate(computer.id);
        closeBoth(why === "protocol" ? 1002 : 1011, message);
      },
    });
    upstream.on("open", () => {
      for (const b of pending.splice(0)) upstream.send(b, { binary: true });
    });
    upstream.on("message", (data: Buffer | ArrayBuffer | Buffer[]) => proxy.fromServer(toBuffer(data)));
    client.on("message", (data: Buffer | ArrayBuffer | Buffer[]) => proxy.fromClient(toBuffer(data)));
    proxy.start();
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
    upstream.on("close", () => closeBoth(1011, "The live view closed"));
    upstream.on("error", () => closeBoth(1011, "The live view cannot be reached"));
  };

  server.on("upgrade", onUpgrade);
  return {
    close: () => { server.off("upgrade", onUpgrade); wss.close(); },
    /** Control changed hands (computer:takeover): the next input message asks again. */
    controlChanged: (computerId) => { if (computerId) holders.delete(computerId); else holders.clear(); },
  };
}
