/**
 * Network rules for sandboxed commands.
 *
 * A sandbox in "open" or "allowlist" network mode has no network of its own (bwrap
 * --unshare-net). It reaches out only through this proxy, which listens on a Unix socket bound
 * into the sandbox, where a tiny Node bridge exposes it on 127.0.0.1 for programs that honour
 * HTTP(S)_PROXY / ALL_PROXY. One port speaks two protocols, told apart by the first byte: HTTP
 * (CONNECT for HTTPS, absolute-form for plain HTTP) and SOCKS5 (CONNECT, no auth: ssh, git over
 * ssh, databases, anything TCP). The same scheme as Anthropic's sandbox-runtime.
 *
 * Rules: "allowlist" lets only the listed hosts through; "open" lets every public destination
 * through. Either way the proxy resolves the name itself, refuses when any address is loopback,
 * private, Tailscale/CGNAT, link-local or otherwise not public (the machine's own services must
 * stay unreachable), and connects to the very address it checked (no second lookup: no DNS
 * rebinding). An IP literal or "localhost" written explicitly in the allowlist is a person's
 * deliberate choice and skips the address check.
 */
import { createServer, createConnection, isIP, BlockList, type Server, type Socket } from "node:net";
import { lookup } from "node:dns/promises";
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { splitHostPort } from "@polpo-ai/core/sandbox";

export type NetworkDenialReason = "not-allowed" | "private-address";
export interface NetworkDenial { host: string; port?: number; reason: NetworkDenialReason }

/** Hostname → addresses (injected in tests). */
export type Resolver = (host: string) => Promise<string[]>;

const defaultResolver: Resolver = async (host) => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

function normalizeHost(host: string): string {
  return host.toLowerCase().trim().replace(/^\[(.*)\]$/, "$1").replace(/\.$/, "");
}

/** True when `host` (and `port`, for "host:port" entries) is covered by the allowlist. */
export function hostAllowed(host: string, allow: string[], port?: number): boolean {
  const h = normalizeHost(host);
  return allow.some((raw) => {
    const entry = splitHostPort(raw.toLowerCase());
    if (!entry.host) return false;
    if (entry.port !== undefined && entry.port !== port) return false;
    const pattern = normalizeHost(entry.host);
    if (pattern.startsWith("*.")) return h === pattern.slice(2) || h.endsWith(pattern.slice(1));
    return h === pattern;
  });
}

const NON_PUBLIC = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) NON_PUBLIC.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of [
  ["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8], ["2001:db8::", 32], ["100::", 64],
] as const) NON_PUBLIC.addSubnet(net, prefix, "ipv6");

/** True for every address a sandbox must not reach through "open": loopback, private, CGNAT/Tailscale, link-local/metadata, multicast, reserved. */
export function isNonPublicAddress(address: string): boolean {
  const ip = normalizeHost(address);
  const family = isIP(ip);
  if (!family) return true; // not an address at all: never trust it
  if (family === 4) return NON_PUBLIC.check(ip, "ipv4");
  // IPv4 inside IPv6 (::ffff:a.b.c.d, ::ffff:7f00:1, NAT64 64:ff9b::/96): judge the embedded IPv4
  const mapped = /^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return isNonPublicAddress(mapped[1]!);
  const hex = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(ip);
  if (hex) {
    const hi = parseInt(hex[1]!, 16), lo = parseInt(hex[2]!, 16);
    return isNonPublicAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  return NON_PUBLIC.check(ip, "ipv6");
}

export type NetworkRule = { mode: "open" } | { mode: "allowlist"; allow: string[] };

export type Authorization = { ok: true; address: string } | { ok: false; reason: NetworkDenialReason } | { ok: false; unreachable: true };

/**
 * Decide whether to connect to host:port, and to which address. The caller connects to the
 * returned address only.
 */
export async function authorizeDestination(rule: NetworkRule, host: string, port: number, resolve: Resolver = defaultResolver): Promise<Authorization> {
  const h = normalizeHost(host);
  if (rule.mode === "allowlist" && !hostAllowed(h, rule.allow, port)) return { ok: false, reason: "not-allowed" };
  // a literal IP or "localhost" the person wrote in the allowlist is a deliberate exception
  const explicit = rule.mode === "allowlist" && rule.allow.some((raw) => {
    const e = splitHostPort(raw.toLowerCase());
    const eh = normalizeHost(e.host);
    return (isIP(eh) || eh === "localhost") && eh === h && (e.port === undefined || e.port === port);
  });
  let addresses: string[];
  if (isIP(h)) addresses = [h];
  else {
    try { addresses = await resolve(h); } catch { return { ok: false, unreachable: true }; }
    if (!addresses.length) return { ok: false, unreachable: true };
  }
  if (!explicit && addresses.some(isNonPublicAddress)) return { ok: false, reason: "private-address" };
  // prefer IPv4: sandboxes and servers often have no working IPv6 route
  return { ok: true, address: addresses.find((a) => isIP(a) === 4) ?? addresses[0]! };
}

/** Node bridge run inside the sandbox: 127.0.0.1:<port> → the proxy's Unix socket. */
const BRIDGE_SOURCE = `const net = require("node:net");
const [port, socketPath] = process.argv.slice(2);
net.createServer((c) => { const u = net.createConnection(socketPath); c.pipe(u).pipe(c); u.on("error", () => c.destroy()); c.on("error", () => u.destroy()); })
  .listen(Number(port), "127.0.0.1", () => process.stdout.write("ready\\n"));
`;

/**
 * ProxyCommand helper for ssh (GIT_SSH_COMMAND): `node connect.cjs <host> <port>` tunnels
 * stdin/stdout to host:port through the proxy's Unix socket, with SOCKS5 (domain address type).
 */
const CONNECT_SOURCE = `const net = require("node:net");
const [host, port, socketPath = "/run/polpo-net/proxy.sock"] = process.argv.slice(2);
const fail = (msg) => { process.stderr.write("polpo-connect: " + msg + "\\n"); process.exit(1); };
if (!host || !port) fail("usage: connect.cjs <host> <port>");
const sock = net.createConnection(socketPath);
sock.on("error", (e) => fail(e.message));
sock.on("close", () => { process.stdin.destroy(); });
const name = Buffer.from(host);
let stage = 0;
let buf = Buffer.alloc(0);
sock.on("connect", () => sock.write(Buffer.from([5, 1, 0])));
sock.on("data", function onData(chunk) {
  buf = Buffer.concat([buf, chunk]);
  if (stage === 0) {
    if (buf.length < 2) return;
    if (buf[0] !== 5 || buf[1] !== 0) fail("proxy refused the handshake");
    buf = buf.subarray(2); stage = 1;
    const p = Buffer.alloc(2); p.writeUInt16BE(Number(port));
    sock.write(Buffer.concat([Buffer.from([5, 1, 0, 3, name.length]), name, p]));
  }
  if (stage === 1) {
    if (buf.length < 4) return;
    if (buf[1] !== 0) fail(host + ":" + port + " " + (buf[1] === 2 ? "is refused by the Polpo sandbox network rule" : "is unreachable (code " + buf[1] + ")"));
    const len = buf[3] === 1 ? 10 : buf[3] === 4 ? 22 : 7 + buf[4];
    if (buf.length < len) return;
    const rest = buf.subarray(len);
    stage = 2; sock.removeListener("data", onData);
    process.stdin.pipe(sock); sock.pipe(process.stdout);
    if (rest.length) process.stdout.write(rest);
  }
});
`;

export interface ProxyOptions {
  rule: NetworkRule;
  /** Called on every refused attempt (callers decide how to deduplicate). */
  onDenied?: (denial: NetworkDenial) => void;
  /** Hostname resolver (tests inject one). */
  resolve?: Resolver;
}

interface ProxyCore { server: Server; sockets: Set<Socket>; denied: Set<string> }

/** The proxy server itself, not yet listening. */
function createProxyCore(opts: ProxyOptions): ProxyCore {
  const denied = new Set<string>();
  const sockets = new Set<Socket>();
  const track = (s: Socket) => { sockets.add(s); s.on("close", () => sockets.delete(s)); };

  const check = async (host: string, port: number): Promise<Authorization> => {
    const result = await authorizeDestination(opts.rule, host, port, opts.resolve);
    if (!result.ok && "reason" in result) {
      denied.add(`${host}:${port}`);
      opts.onDenied?.({ host, port, reason: result.reason });
    }
    return result;
  };

  const handleHttp = (client: Socket, first: Buffer) => {
    let buffered = first;
    const onData = (chunk?: Buffer) => {
      if (chunk) buffered = Buffer.concat([buffered, chunk]);
      const end = buffered.indexOf("\r\n\r\n");
      if (end < 0) { if (buffered.length > 64 * 1024) client.destroy(); return; }
      client.off("data", onData);
      const target = targetOf(buffered.subarray(0, end).toString("latin1").split("\r\n")[0] ?? "");
      if (!target) { client.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"); return; }
      client.pause();
      void check(target.host, target.port).then((auth) => {
        if (!auth.ok) {
          if ("reason" in auth) {
            const why = auth.reason === "private-address" ? "is a local or private address, which the sandbox network never reaches" : "is not in the network allowlist";
            client.end(`HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nPolpo sandbox: ${target.host} ${why}.\n`);
          } else client.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
          return;
        }
        const upstream = createConnection({ host: auth.address, port: target.port });
        track(upstream);
        upstream.on("error", () => { client.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n"); });
        upstream.on("connect", () => {
          if (target.method === "CONNECT") {
            client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
            const rest = buffered.subarray(end + 4);
            if (rest.length) upstream.write(rest);
          } else upstream.write(buffered);
          client.pipe(upstream).pipe(client);
          client.resume();
        });
      });
    };
    client.on("data", onData);
    onData();
  };

  const handleSocks = (client: Socket, first: Buffer) => {
    let buffered = first;
    let stage: "greeting" | "request" = "greeting";
    const reply = (code: number) => client.end(Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0]));
    const onData = (chunk?: Buffer) => {
      if (chunk) buffered = Buffer.concat([buffered, chunk]);
      if (stage === "greeting") {
        if (buffered.length < 2) return;
        const total = 2 + buffered[1]!;
        if (buffered.length < total) return;
        const noAuth = buffered.subarray(2, total).includes(0);
        buffered = buffered.subarray(total);
        if (!noAuth) { client.end(Buffer.from([5, 0xff])); return; }
        client.write(Buffer.from([5, 0]));
        stage = "request";
      }
      if (buffered.length < 5) return;
      if (buffered[0] !== 5) { client.destroy(); return; }
      const atyp = buffered[3]!;
      const addrLen = atyp === 1 ? 4 : atyp === 4 ? 16 : atyp === 3 ? 1 + buffered[4]! : -1;
      if (addrLen < 0) { reply(8); return; }
      const total = 4 + addrLen + 2;
      if (buffered.length < total) return;
      client.off("data", onData);
      if (buffered[1] !== 1) { reply(7); return; } // only CONNECT
      const addr = buffered.subarray(4, 4 + addrLen);
      const host = atyp === 1 ? [...addr].join(".")
        : atyp === 4 ? Array.from({ length: 8 }, (_, i) => addr.readUInt16BE(i * 2).toString(16)).join(":")
        : addr.subarray(1).toString("latin1");
      const port = buffered.readUInt16BE(4 + addrLen);
      const rest = buffered.subarray(total);
      client.pause();
      void check(host, port).then((auth) => {
        if (!auth.ok) { reply("reason" in auth ? 2 : 4); return; }
        const upstream = createConnection({ host: auth.address, port });
        track(upstream);
        upstream.on("error", (e: NodeJS.ErrnoException) => reply(e.code === "ECONNREFUSED" ? 5 : 4));
        upstream.on("connect", () => {
          client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
          if (rest.length) upstream.write(rest);
          client.pipe(upstream).pipe(client);
          client.resume();
        });
      });
    };
    client.on("data", onData);
    onData();
  };

  const server: Server = createServer((client) => {
    track(client);
    client.on("error", () => client.destroy());
    client.once("data", (first: Buffer) => { if (first[0] === 0x05) handleSocks(client, first); else handleHttp(client, first); });
  });
  return { server, sockets, denied };
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
    return { method, host: url.hostname.replace(/^\[(.*)\]$/, "$1"), port: Number(url.port || 80) };
  } catch { return null; }
}

export interface NetworkProxy {
  /** Directory to bind into the sandbox (contains proxy.sock, bridge.cjs and connect.cjs). */
  dir: string;
  socketPath: string;
  bridgePath: string;
  connectPath: string;
  /** host:port pairs refused so far (for diagnostics). */
  denied: Set<string>;
  close(): Promise<void>;
}

/** The proxy a jail uses: on a Unix socket in a private directory, plus the helpers that run inside the jail. */
export async function startNetworkProxy(opts: ProxyOptions): Promise<NetworkProxy> {
  const dir = mkdtempSync(join(tmpdir(), "polpo-net-"));
  chmodSync(dir, 0o700);
  const socketPath = join(dir, "proxy.sock");
  const bridgePath = join(dir, "bridge.cjs");
  const connectPath = join(dir, "connect.cjs");
  writeFileSync(bridgePath, BRIDGE_SOURCE, { mode: 0o600 });
  writeFileSync(connectPath, CONNECT_SOURCE, { mode: 0o600 });
  const { server, sockets, denied } = createProxyCore(opts);
  await new Promise<void>((resolveListen, reject) => { server.once("error", reject); server.listen(socketPath, () => resolveListen()); });
  chmodSync(socketPath, 0o600);
  return {
    dir, socketPath, bridgePath, connectPath, denied,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((done) => server.close(() => done()));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export interface TcpNetworkProxy {
  /** Listening on 127.0.0.1:<port> (for host-side clients such as the browser). */
  port: number;
  url: string;
  denied: Set<string>;
  close(): Promise<void>;
}

/** The same proxy on a random local TCP port. It is only as private as the machine's loopback: use it for short-lived host-side sessions. */
export async function startTcpNetworkProxy(opts: ProxyOptions): Promise<TcpNetworkProxy> {
  const { server, sockets, denied } = createProxyCore(opts);
  await new Promise<void>((resolveListen, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolveListen()); });
  const port = (server.address() as { port: number }).port;
  return {
    port, url: `http://127.0.0.1:${port}`, denied,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}
