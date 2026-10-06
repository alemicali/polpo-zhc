import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createServer, createConnection, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSandbox, normalizeSandboxSettings, type EffectiveSandbox } from "@polpo-ai/core/sandbox";
import {
  authorizeDestination, hostAllowed, isNonPublicAddress, startNetworkProxy, startTcpNetworkProxy, type NetworkDenial,
} from "../sandbox/net-proxy.js";
import { BwrapWorkspace, bwrapAvailable } from "../sandbox/workspaces.js";
import { NetworkDeniedLog } from "../sandbox/denied-log.js";
import { browserRuleFor, createBrowserNetworkGuard } from "../tools/browser-network-guard.js";
import { sandboxPromptNote } from "../adapters/engine.js";
import { startNotificationServer, notifyNetworkDenied, type NetworkDeniedMessage } from "../core/notification.js";

const all = new Set(["local", "bwrap", "docker", "daytona", "e2b"] as const);
const sandbox = (network: EffectiveSandbox["network"], provider: EffectiveSandbox["provider"] = "bwrap"): EffectiveSandbox =>
  ({ provider, network, resources: {}, providerOptions: {}, denied: [] });

describe("network modes in the cascade", () => {
  test("unrestricted < open < allowlist < deny", () => {
    const base = { provider: "bwrap" as const };
    const tighten = (from: string, to: string) => resolveSandbox(
      { instance: { ...base, network: { mode: from as any } }, task: { network: { mode: to as any } } }, { scope: "task", available: all }).network.mode;
    expect(tighten("unrestricted", "open")).toBe("open");
    expect(tighten("unrestricted", "deny")).toBe("deny");
    expect(tighten("open", "deny")).toBe("deny");
    expect(tighten("open", "unrestricted")).toBe("open");
    expect(tighten("allowlist", "open")).toBe("allowlist");
    expect(tighten("deny", "allowlist")).toBe("deny");
  });

  test("an allowlist under open or unrestricted is accepted as is", () => {
    for (const mode of ["open", "unrestricted"] as const) {
      const out = resolveSandbox({ instance: { provider: "bwrap", network: { mode } }, task: { network: { mode: "allowlist", allow: ["a.com", "b.com:22"] } } }, { scope: "task", available: all });
      expect(out.network).toEqual({ mode: "allowlist", allow: ["a.com", "b.com:22"] });
      expect(out.denied).toEqual([]);
    }
  });

  test("an allowlist below an allowlist keeps what the upper level covers, ports included", () => {
    const out = resolveSandbox({
      instance: { provider: "bwrap", network: { mode: "allowlist", allow: ["github.com", "*.npmjs.org", "db.example.com:5432"] } },
      task: { network: { mode: "allowlist", allow: ["github.com:22", "registry.npmjs.org", "db.example.com", "db.example.com:5432", "evil.com"] } },
    }, { scope: "task", available: all });
    expect(out.network.allow).toEqual(["github.com:22", "registry.npmjs.org", "db.example.com:5432"]);
  });

  test("the default stays open, and unrestricted is a valid setting", () => {
    expect(resolveSandbox({}, { scope: "task" }).network).toEqual({ mode: "open" });
    expect(normalizeSandboxSettings({ network: { mode: "unrestricted" } })).toEqual({ network: { mode: "unrestricted" } });
    expect(normalizeSandboxSettings({ network: { mode: "everything" } })).toBeUndefined();
  });
});

describe("addresses and the allowlist", () => {
  test.each([
    "127.0.0.1", "127.8.9.1", "::1", "0.0.0.0", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "100.64.0.1", "100.127.255.255",
    "169.254.169.254", "fe80::1", "fc00::1", "fd12:3456::1", "224.0.0.1", "255.255.255.255", "::", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.1", "ff02::1", "not-an-ip",
  ])("%s is not public", (ip) => expect(isNonPublicAddress(ip)).toBe(true));

  test.each(["8.8.8.8", "1.1.1.1", "172.15.0.1", "172.32.0.1", "100.63.0.1", "100.128.0.1", "93.184.216.34", "2606:4700:4700::1111", "::ffff:8.8.8.8"])(
    "%s is public", (ip) => expect(isNonPublicAddress(ip)).toBe(false));

  test("allowlist entries with a port", () => {
    expect(hostAllowed("github.com", ["github.com:22"], 22)).toBe(true);
    expect(hostAllowed("github.com", ["github.com:22"], 443)).toBe(false);
    expect(hostAllowed("github.com", ["github.com"], 443)).toBe(true);
    expect(hostAllowed("ssh.github.com", ["*.github.com:443"], 443)).toBe(true);
    expect(hostAllowed("::1", ["[::1]:8080"], 8080)).toBe(true);
  });
});

describe("destination rule", () => {
  const resolver = (table: Record<string, string[]>) => async (host: string) => { if (!table[host]) throw new Error("ENOTFOUND"); return table[host]!; };
  const dns = resolver({
    "good.test": ["93.184.216.34"], "lan.test": ["192.168.1.10"], "mixed.test": ["93.184.216.34", "10.0.0.5"],
    "rebind.test": ["127.0.0.1"], "localhost": ["127.0.0.1", "::1"], "v6.test": ["2606:4700:4700::1111"],
  });

  test("open: public names pass and are connected by the address that was checked", async () => {
    expect(await authorizeDestination({ mode: "open" }, "good.test", 443, dns)).toEqual({ ok: true, address: "93.184.216.34" });
    expect(await authorizeDestination({ mode: "open" }, "8.8.8.8", 53, dns)).toEqual({ ok: true, address: "8.8.8.8" });
    expect(await authorizeDestination({ mode: "open" }, "v6.test", 443, dns)).toEqual({ ok: true, address: "2606:4700:4700::1111" });
  });

  test("open: local, private and mixed answers are refused", async () => {
    for (const host of ["lan.test", "mixed.test", "rebind.test", "localhost", "127.0.0.1", "10.0.0.1", "169.254.169.254", "[::1]", "100.100.100.100"]) {
      expect(await authorizeDestination({ mode: "open" }, host, 80, dns), host).toEqual({ ok: false, reason: "private-address" });
    }
  });

  test("an unknown name is unreachable, not a refusal", async () => {
    expect(await authorizeDestination({ mode: "open" }, "nope.test", 80, dns)).toEqual({ ok: false, unreachable: true });
  });

  test("allowlist: names outside the list are not allowed; listed names still get the address check", async () => {
    const rule = { mode: "allowlist" as const, allow: ["good.test", "*.corp.test", "rebind.test", "good.test:22"] };
    expect(await authorizeDestination(rule, "other.test", 443, dns)).toEqual({ ok: false, reason: "not-allowed" });
    expect(await authorizeDestination(rule, "good.test", 443, dns)).toMatchObject({ ok: true });
    expect(await authorizeDestination(rule, "rebind.test", 443, dns)).toEqual({ ok: false, reason: "private-address" });
    expect(await authorizeDestination({ mode: "allowlist", allow: ["good.test:22"] }, "good.test", 443, dns)).toEqual({ ok: false, reason: "not-allowed" });
  });

  test("allowlist: an IP literal or localhost written in the list is a deliberate exception", async () => {
    expect(await authorizeDestination({ mode: "allowlist", allow: ["127.0.0.1"] }, "127.0.0.1", 80, dns)).toMatchObject({ ok: true, address: "127.0.0.1" });
    expect(await authorizeDestination({ mode: "allowlist", allow: ["10.0.0.7:5432"] }, "10.0.0.7", 5432, dns)).toMatchObject({ ok: true });
    expect(await authorizeDestination({ mode: "allowlist", allow: ["10.0.0.7:5432"] }, "10.0.0.7", 22, dns)).toEqual({ ok: false, reason: "not-allowed" });
    expect(await authorizeDestination({ mode: "allowlist", allow: ["localhost"] }, "localhost", 3000, dns)).toMatchObject({ ok: true, address: "127.0.0.1" });
    // the exception covers only what was written
    expect(await authorizeDestination({ mode: "allowlist", allow: ["127.0.0.1"] }, "10.0.0.1", 80, dns)).toEqual({ ok: false, reason: "not-allowed" });
  });
});

/** Minimal SOCKS5 / HTTP CONNECT clients to talk to the proxy in tests. */
function socksConnect(port: number, host: string, destPort: number): Promise<{ code: number; socket: import("node:net").Socket }> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("error", reject);
    let stage = 0;
    let buf = Buffer.alloc(0);
    socket.on("connect", () => socket.write(Buffer.from([5, 1, 0])));
    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (stage === 0 && buf.length >= 2) {
        stage = 1; buf = buf.subarray(2);
        const name = Buffer.from(host);
        const p = Buffer.alloc(2); p.writeUInt16BE(destPort);
        socket.write(Buffer.concat([Buffer.from([5, 1, 0, 3, name.length]), name, p]));
      }
      if (stage === 1 && buf.length >= 10) { stage = 2; socket.removeAllListeners("data"); resolve({ code: buf[1]!, socket }); }
    });
  });
}

function httpConnect(port: number, target: string): Promise<{ status: string; body: string; socket: import("node:net").Socket }> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("error", reject);
    let buf = "";
    socket.on("connect", () => socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
    socket.on("data", (chunk) => {
      buf += chunk.toString("latin1");
      if (buf.includes("\r\n\r\n")) { socket.removeAllListeners("data"); resolve({ status: buf.split("\r\n")[0]!, body: buf.split("\r\n\r\n")[1] ?? "", socket }); }
    });
  });
}

describe("the proxy on a real socket", () => {
  let echo: Server;
  let echoPort = 0;
  beforeAll(async () => {
    echo = createServer((s) => s.on("data", (d) => s.write(`echo:${d}`)));
    await new Promise<void>((r) => echo.listen(0, "127.0.0.1", () => r()));
    echoPort = (echo.address() as { port: number }).port;
  });
  afterAll(async () => { await new Promise<void>((r) => echo.close(() => r())); });

  const resolve = async (host: string) => { if (host === "rebind.test") return ["127.0.0.1"]; throw new Error("ENOTFOUND"); };

  test("SOCKS5 and HTTP CONNECT reach an allowed destination", async () => {
    const proxy = await startTcpNetworkProxy({ rule: { mode: "allowlist", allow: [`127.0.0.1:${echoPort}`] }, resolve });
    const socks = await socksConnect(proxy.port, "127.0.0.1", echoPort);
    expect(socks.code).toBe(0);
    const reply = new Promise<string>((r) => socks.socket.once("data", (d) => r(d.toString())));
    socks.socket.write("ping");
    expect(await reply).toBe("echo:ping");
    socks.socket.destroy();

    const connect = await httpConnect(proxy.port, `127.0.0.1:${echoPort}`);
    expect(connect.status).toContain("200");
    const reply2 = new Promise<string>((r) => connect.socket.once("data", (d) => r(d.toString())));
    connect.socket.write("pong");
    expect(await reply2).toBe("echo:pong");
    connect.socket.destroy();
    await proxy.close();
  });

  test("refusals: other ports, other hosts, rebinding and local addresses in open mode", async () => {
    const denied: NetworkDenial[] = [];
    const proxy = await startTcpNetworkProxy({ rule: { mode: "allowlist", allow: [`127.0.0.1:${echoPort}`, "rebind.test"] }, resolve, onDenied: (d) => denied.push(d) });
    expect((await socksConnect(proxy.port, "127.0.0.1", echoPort + 1)).code).toBe(2);
    expect((await socksConnect(proxy.port, "elsewhere.test", 443)).code).toBe(2);
    expect((await socksConnect(proxy.port, "rebind.test", echoPort)).code).toBe(2);
    expect((await httpConnect(proxy.port, "elsewhere.test:443")).status).toContain("403");
    expect(denied.map((d) => `${d.host}:${d.port}:${d.reason}`)).toEqual([
      `127.0.0.1:${echoPort + 1}:not-allowed`, "elsewhere.test:443:not-allowed", `rebind.test:${echoPort}:private-address`, "elsewhere.test:443:not-allowed",
    ]);
    await proxy.close();

    const open = await startTcpNetworkProxy({ rule: { mode: "open" }, resolve, onDenied: (d) => denied.push(d) });
    expect((await socksConnect(open.port, "127.0.0.1", echoPort)).code).toBe(2);
    const refused = await httpConnect(open.port, `rebind.test:${echoPort}`);
    expect(refused.status).toContain("403");
    expect(refused.body).toContain("local or private address");
    expect(denied.at(-1)).toMatchObject({ host: "rebind.test", reason: "private-address" });
    await open.close();
  });

  test("an unsupported SOCKS command or a bad handshake is rejected", async () => {
    const proxy = await startTcpNetworkProxy({ rule: { mode: "open" } });
    const bind = await new Promise<number>((resolveCode, reject) => {
      const s = createConnection({ host: "127.0.0.1", port: proxy.port });
      s.once("error", reject);
      s.on("connect", () => s.write(Buffer.from([5, 1, 0, 5, 2, 0, 1, 1, 1, 1, 1, 1, 0, 80].slice(0, 3))));
      let n = 0;
      s.on("data", (d) => { if (++n === 1) s.write(Buffer.from([5, 2, 0, 1, 1, 1, 1, 1, 0, 80])); else resolveCode(d[1]!); });
    });
    expect(bind).toBe(7);
    await proxy.close();
  });
});

describe.skipIf(!bwrapAvailable())("network rules inside a real jail", () => {
  let root: string;
  let web: HttpServer;
  let webPort = 0;
  let echo: Server;
  let echoPort = 0;
  let otherPort = 0;
  let other: Server;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "polpo-net-root-"));
    web = createHttpServer((_req, res) => res.end("local service"));
    await new Promise<void>((r) => web.listen(0, "127.0.0.1", () => r()));
    webPort = (web.address() as { port: number }).port;
    echo = createServer((s) => s.on("data", (d) => s.end(`echo:${d}`)));
    await new Promise<void>((r) => echo.listen(0, "127.0.0.1", () => r()));
    echoPort = (echo.address() as { port: number }).port;
    other = createServer((s) => s.end("other"));
    await new Promise<void>((r) => other.listen(0, "127.0.0.1", () => r()));
    otherPort = (other.address() as { port: number }).port;
  });
  afterAll(async () => {
    rmSync(root, { recursive: true, force: true });
    for (const s of [web, echo, other]) await new Promise<void>((r) => s.close(() => r()));
  });
  const env = { NO_PROXY: "", no_proxy: "" };

  test("open: no route to this machine's services, directly or through the proxy", async () => {
    const denied: NetworkDenial[] = [];
    const ws = new BwrapWorkspace({ root, sandbox: sandbox({ mode: "open" }), onNetworkDenied: (d) => denied.push(d) });
    const direct = await ws.exec(`curl -s -m 3 --noproxy '*' http://127.0.0.1:${webPort}/ || echo NO-ROUTE`);
    expect(direct.stdout).toContain("NO-ROUTE");
    const viaProxy = await ws.exec(`curl -s -m 5 http://127.0.0.1:${webPort}/; echo`, { env });
    expect(viaProxy.stdout).toContain("local or private address");
    expect(viaProxy.stdout).not.toContain("local service");
    const socks = await ws.exec(`curl -s -m 5 --socks5-hostname 127.0.0.1:3128 http://127.0.0.1:${webPort}/ || echo SOCKS-REFUSED`, { env });
    expect(socks.stdout).toContain("SOCKS-REFUSED");
    expect(denied.length).toBeGreaterThanOrEqual(2);
    expect(denied[0]).toMatchObject({ host: "127.0.0.1", port: webPort, reason: "private-address" });
    await ws.dispose();
  });

  test("unrestricted: the old behaviour, the machine's own network", async () => {
    const ws = new BwrapWorkspace({ root, sandbox: sandbox({ mode: "unrestricted" }) });
    const argv = await ws.argv("true");
    expect(argv).toContain("--share-net");
    const r = await ws.exec(`curl -s -m 5 http://127.0.0.1:${webPort}/`);
    expect(r.stdout).toBe("local service");
    expect((await ws.exec("echo $HTTP_PROXY$ALL_PROXY")).stdout.trim()).toBe("");
    await ws.dispose();
  });

  test("open and allowlist have no network of their own", async () => {
    for (const network of [{ mode: "open" as const }, { mode: "allowlist" as const, allow: ["x.test"] }]) {
      const ws = new BwrapWorkspace({ root, sandbox: sandbox(network) });
      expect(await ws.argv("true")).not.toContain("--share-net");
      await ws.dispose();
    }
  });

  test("allowlist: SOCKS5 and the ssh ProxyCommand helper reach an allowed host:port, others are refused", async () => {
    const denied: NetworkDenial[] = [];
    const ws = new BwrapWorkspace({ root, sandbox: sandbox({ mode: "allowlist", allow: [`127.0.0.1:${echoPort}`, `127.0.0.1:${webPort}`] }), onNetworkDenied: (d) => denied.push(d) });
    const socks = await ws.exec(`curl -s -m 5 --socks5-hostname 127.0.0.1:3128 http://127.0.0.1:${webPort}/`, { env });
    expect(socks.stdout).toBe("local service");
    const viaEnv = await ws.exec(`curl -s -m 5 http://127.0.0.1:${webPort}/`, { env });
    expect(viaEnv.stdout).toBe("local service");

    const tunnel = await ws.exec(`echo hello | node /run/polpo-net/connect.cjs 127.0.0.1 ${echoPort}`);
    expect(tunnel.stdout.trim()).toBe("echo:hello");
    const refused = await ws.exec(`echo hello | node /run/polpo-net/connect.cjs 127.0.0.1 ${otherPort}`);
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr).toContain("refused");
    expect(refused.stdout).toBe("");
    expect(denied).toContainEqual({ host: "127.0.0.1", port: otherPort, reason: "not-allowed" });

    const ssh = await ws.exec("echo $GIT_SSH_COMMAND; echo $ALL_PROXY");
    expect(ssh.stdout).toContain("ProxyCommand='node /run/polpo-net/connect.cjs %h %p'");
    expect(ssh.stdout).toContain("socks5h://127.0.0.1:3128");
    await ws.dispose();
  });

  test("git over ssh goes through the helper (a refused host fails with the proxy's message)", async () => {
    const ws = new BwrapWorkspace({ root, sandbox: sandbox({ mode: "allowlist", allow: [`127.0.0.1:${echoPort}`] }) });
    const viaGit = await ws.exec(`GIT_SSH_COMMAND="$POLPO_SSH -p ${otherPort}" git ls-remote ssh://nobody@127.0.0.1/repo 2>&1 | head -5; true`, { env: { POLPO_SSH: "ssh -o BatchMode=yes -o ProxyCommand='node /run/polpo-net/connect.cjs %h %p'" } });
    expect(viaGit.stdout).toContain("refused by the Polpo sandbox network rule");
    await ws.dispose();
  });
});

describe("the helper script and the proxy on a Unix socket", () => {
  test("startNetworkProxy writes bridge.cjs and connect.cjs next to the socket", async () => {
    const proxy = await startNetworkProxy({ rule: { mode: "open" } });
    expect(proxy.connectPath).toMatch(/connect\.cjs$/);
    expect(proxy.bridgePath).toMatch(/bridge\.cjs$/);
    await proxy.close();
  });
});

describe("refused destinations are recorded", () => {
  test("the log counts every attempt, reports a workspace's first one, and merges per agent", () => {
    const log = new NetworkDeniedLog();
    const base = { provider: "bwrap", scope: "task" as const, agentName: "dev", host: "a.com", port: 443, reason: "not-allowed" as const };
    expect(log.record({ ...base, workspaceId: "w1" }, new Date("2026-01-01T10:00:00Z"))).toBe(true);
    expect(log.record({ ...base, workspaceId: "w1" }, new Date("2026-01-01T10:01:00Z"))).toBe(false);
    expect(log.record({ ...base, workspaceId: "w2" }, new Date("2026-01-01T10:02:00Z"))).toBe(true);
    log.record({ ...base, workspaceId: "w1", host: "b.com", reason: "private-address" }, new Date("2026-01-01T10:03:00Z"));
    const list = log.list();
    expect(list.map((e) => `${e.host}:${e.count}`)).toEqual(["b.com:1", "a.com:3"]);
    expect(list[1]).toMatchObject({ agentName: "dev", port: 443, reason: "not-allowed", lastAt: "2026-01-01T10:02:00.000Z" });
  });

  test("keeps about the last 100", () => {
    const log = new NetworkDeniedLog();
    for (let i = 0; i < 150; i++) log.record({ provider: "bwrap", scope: "chat", agentName: "a", host: `h${i}.com`, reason: "not-allowed" });
    const list = log.list();
    expect(list).toHaveLength(100);
    expect(list.some((e) => e.host === "h0.com")).toBe(false);
    expect(list.some((e) => e.host === "h149.com")).toBe(true);
  });

  test("a runner reports a refusal to the orchestrator over the notification socket", async () => {
    const dir = mkdtempSync(join(tmpdir(), "polpo-notify-"));
    const got = new Promise<NetworkDeniedMessage>((r) => {
      const server = startNotificationServer(dir, () => undefined, (m) => { r(m); server.close(); });
    });
    await new Promise((r) => setTimeout(r, 100));
    notifyNetworkDenied(join(dir, "orchestrator.sock"), { runId: "r1", taskId: "t1", agentName: "dev", provider: "bwrap", host: "x.com", port: 22, reason: "not-allowed" });
    expect(await got).toMatchObject({ type: "network_denied", runId: "r1", taskId: "t1", host: "x.com", port: 22 });
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("the browser follows the network rule", () => {
  const resolve = async (host: string) => (host === "lan.test" ? ["192.168.1.5"] : ["93.184.216.34"]);

  test("the rule applies only to isolating providers and restricted networks", () => {
    expect(browserRuleFor(undefined)).toBeUndefined();
    expect(browserRuleFor(sandbox({ mode: "deny" }, "local"))).toBeUndefined();
    expect(browserRuleFor(sandbox({ mode: "unrestricted" }))).toBeUndefined();
    expect(browserRuleFor(sandbox({ mode: "open" }))).toEqual({ mode: "open" });
    expect(browserRuleFor(sandbox({ mode: "deny" }))).toEqual({ mode: "allowlist", allow: [] });
    expect(browserRuleFor(sandbox({ mode: "allowlist", allow: ["a.com"] }, "docker"))).toEqual({ mode: "allowlist", allow: ["a.com"] });
  });

  test("navigations are checked and refusals reported", async () => {
    const denied: NetworkDenial[] = [];
    const open = createBrowserNetworkGuard({ sandbox: sandbox({ mode: "open" }), resolve, onDenied: (d) => denied.push(d) })!;
    expect(await open.checkUrl("https://example.com/page")).toBeUndefined();
    expect(await open.checkUrl("example.com")).toBeUndefined();
    expect(await open.checkUrl("http://127.0.0.1:3000/")).toContain("local or private address");
    expect(await open.checkUrl("http://lan.test/")).toContain("local or private address");
    expect(await open.checkUrl("about:blank")).toBeUndefined();
    expect(denied).toEqual([{ host: "127.0.0.1", port: 3000, reason: "private-address" }, { host: "lan.test", port: 80, reason: "private-address" }]);

    const list = createBrowserNetworkGuard({ sandbox: sandbox({ mode: "allowlist", allow: ["*.github.com"] }), resolve, onDenied: (d) => denied.push(d) })!;
    expect(await list.checkUrl("https://gist.github.com/x")).toBeUndefined();
    expect(await list.checkUrl("https://example.com/")).toContain("not in this agent's allowed hosts");
    expect(denied.at(-1)).toEqual({ host: "example.com", port: 443, reason: "not-allowed" });

    const none = createBrowserNetworkGuard({ sandbox: sandbox({ mode: "deny" }), resolve })!;
    expect(await none.checkUrl("https://example.com/")).toContain("no network");
    expect(createBrowserNetworkGuard({ sandbox: sandbox({ mode: "open" }, "local") })).toBeUndefined();
  });

  test("the browser's proxy enforces the same rule on page traffic", async () => {
    const denied: NetworkDenial[] = [];
    const guard = createBrowserNetworkGuard({ sandbox: sandbox({ mode: "allowlist", allow: ["allowed.test"] }), resolve: async () => ["127.0.0.1"], onDenied: (d) => denied.push(d) })!;
    const url = new URL(await guard.proxyUrl());
    expect(url.hostname).toBe("127.0.0.1");
    expect((await httpConnect(Number(url.port), "other.test:443")).status).toContain("403");
    expect((await httpConnect(Number(url.port), "allowed.test:443")).status).toContain("403"); // resolves to loopback
    expect(denied.map((d) => d.reason)).toEqual(["not-allowed", "private-address"]);
    await guard.close();
  });
});

describe("what agents are told", () => {
  test("every network mode is described", () => {
    const note = (network: EffectiveSandbox["network"]) => sandboxPromptNote(sandbox(network), []);
    expect(note({ mode: "open" })).toContain("every public destination");
    expect(note({ mode: "open" })).toContain("SOCKS5");
    expect(note({ mode: "open" })).toContain("Tailscale");
    expect(note({ mode: "allowlist", allow: ["github.com:22"] })).toContain("limited to: github.com:22");
    expect(note({ mode: "unrestricted" })).toContain("unrestricted");
    expect(note({ mode: "deny" })).toContain("disabled");
  });
});
