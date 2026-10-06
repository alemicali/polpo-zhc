/**
 * Network allowlist for sandboxed commands.
 *
 * A sandbox with "allowlist" networking has no network of its own (bwrap --unshare-net). It
 * reaches out only through this proxy: an HTTP proxy (CONNECT for HTTPS, absolute-form for
 * plain HTTP) listening on a Unix socket that is bound into the sandbox, where a tiny Node
 * bridge exposes it on 127.0.0.1 for programs that honour HTTP(S)_PROXY. Hosts outside the
 * allowlist get 403. The same scheme as Anthropic's sandbox-runtime.
 */
import { createServer, createConnection, type Server, type Socket } from "node:net";
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function hostAllowed(host: string, allow: string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return allow.some((raw) => {
    const pattern = raw.toLowerCase().trim();
    if (!pattern) return false;
    if (pattern.startsWith("*.")) return h === pattern.slice(2) || h.endsWith(pattern.slice(1));
    return h === pattern;
  });
}

/** Host and port from a CONNECT target or an absolute-form request line. */
function targetOf(requestLine: string): { method: string; host: string; port: number } | null {
  const [method, target] = requestLine.split(" ");
  if (!method || !target) return null;
  if (method === "CONNECT") {
    const m = /^\[?([^\]]+?)\]?:(\d+)$/.exec(target);
    return m ? { method, host: m[1]!, port: Number(m[2]) } : null;
  }
  try {
    const url = new URL(target);
    if (url.protocol !== "http:") return null;
    return { method, host: url.hostname, port: Number(url.port || 80) };
  } catch { return null; }
}

/** Node bridge run inside the sandbox: 127.0.0.1:<port> → the proxy's Unix socket. */
const BRIDGE_SOURCE = `const net = require("node:net");
const [port, socketPath] = process.argv.slice(2);
net.createServer((c) => { const u = net.createConnection(socketPath); c.pipe(u).pipe(c); u.on("error", () => c.destroy()); c.on("error", () => u.destroy()); })
  .listen(Number(port), "127.0.0.1", () => process.stdout.write("ready\\n"));
`;

export interface NetworkProxy {
  /** Directory to bind into the sandbox (contains proxy.sock and bridge.cjs). */
  dir: string;
  socketPath: string;
  bridgePath: string;
  /** Hosts refused so far (for diagnostics). */
  denied: Set<string>;
  close(): Promise<void>;
}

export async function startNetworkProxy(allow: string[], onDenied?: (host: string) => void): Promise<NetworkProxy> {
  const dir = mkdtempSync(join(tmpdir(), "polpo-net-"));
  chmodSync(dir, 0o700);
  const socketPath = join(dir, "proxy.sock");
  const bridgePath = join(dir, "bridge.cjs");
  writeFileSync(bridgePath, BRIDGE_SOURCE, { mode: 0o600 });
  const denied = new Set<string>();
  const sockets = new Set<Socket>();

  const server: Server = createServer((client) => {
    sockets.add(client);
    client.on("close", () => sockets.delete(client));
    client.on("error", () => client.destroy());
    let buffered = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      const end = buffered.indexOf("\r\n\r\n");
      if (end < 0) { if (buffered.length > 64 * 1024) client.destroy(); return; }
      client.off("data", onData);
      const head = buffered.subarray(0, end).toString("latin1");
      const target = targetOf(head.split("\r\n")[0] ?? "");
      if (!target || !hostAllowed(target.host, allow)) {
        if (target) { denied.add(target.host); onDenied?.(target.host); }
        client.end(`HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nPolpo sandbox: ${target?.host ?? "this request"} is not in the network allowlist.\n`);
        return;
      }
      const upstream = createConnection({ host: target.host, port: target.port });
      sockets.add(upstream);
      upstream.on("close", () => sockets.delete(upstream));
      upstream.on("error", () => { client.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n"); });
      upstream.on("connect", () => {
        if (target.method === "CONNECT") {
          client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          const rest = buffered.subarray(end + 4);
          if (rest.length) upstream.write(rest);
        } else {
          upstream.write(buffered);
        }
        client.pipe(upstream).pipe(client);
      });
    };
    client.on("data", onData);
  });
  await new Promise<void>((resolveListen, reject) => { server.once("error", reject); server.listen(socketPath, () => resolveListen()); });
  chmodSync(socketPath, 0o600);

  return {
    dir, socketPath, bridgePath, denied,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((done) => server.close(() => done()));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
