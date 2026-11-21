/**
 * Remote computers going out through a tailnet-only proxy (Tailscale inside the VM): settings and
 * validation, the runtime in the VM (mocked exec and file API: bootstrap order, the auth key never
 * on a command line or in a log, idempotency, resume, fallback), the browser in the VM (proxy,
 * restart when it changes, the signed-in profile that pauses), the computer's start hook and its
 * logout on delete, and the forwarder script itself (run with node against fake SOCKS servers).
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computerEgressProblem, isTailnetHost, parseComputer, parseTailscaleSettings, remoteEgressProblem, tailnetEgressFor, tailnetHostname,
  type ComputerConfig, type TailnetEgressRef,
} from "@polpo-ai/core/sandbox";
import type { Shell, ShellOptions, ShellResult } from "@polpo-ai/core/shell";
import {
  TAILNET_AUTH_KEY_FILE, TAILNET_BROWSER_PROXY, TAILNET_DAEMON_COMMAND, TAILNET_FORWARDER_FILE, TAILNET_FORWARDER_SCRIPT,
  TAILNET_INSPECT_COMMAND, TAILNET_INSTALL_COMMAND, TAILNET_LOGOUT_COMMAND, TAILSCALE_SHA256, TAILSCALE_VERSION,
  TailnetEgress, configureTailnetEgress, describeTailnet, tailnetEgress, type TailnetHost,
} from "../sandbox/tailnet-egress.js";
import { ComputerManager } from "../sandbox/computers.js";
import type { RemoteAdapter, RemoteDriver, RemoteVmSummary } from "../sandbox/remote-adapters.js";
import { createBrowserTools } from "../tools/browser-tools.js";
import { resetBrowserEgressSessions } from "../tools/browser-tools.js";

const KEY = "tskey-auth-kSECRET123-abcdefghijklmnopqrstuvwxyz";
const vaultStore = { get: async (owner: string, service: string) => (owner === "ops" && service === "tailscale" ? { credentials: { authKey: KEY } } : undefined) } as any;
const tailscale = { authKey: { owner: "ops", service: "tailscale" } };
const proxies = { home: "socks5://100.101.55.7:1080" };

const dirs: string[] = [];
const tmp = (prefix: string) => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const ref = (computerId = "nina"): TailnetEgressRef => ({
  computerId, hostname: `polpo-sbx-p-${computerId}`, tags: ["tag:polpo-sandbox"], authKey: { owner: "ops", service: "tailscale" },
  proxyHost: "100.101.55.7", proxyPort: 1080,
});

type Kind = "inspect" | "install" | "daemon" | "up" | "rm-key" | "forwarder" | "logout" | "marker-test" | "marker-write" | "browser" | "other";

/** A VM with Tailscale's moving parts as flags: commands change them as they would. */
class FakeTailnetVm implements TailnetHost {
  calls: { kind: Kind; command: string; env?: Record<string, string> }[] = [];
  events: string[] = [];
  files = new Map<string, string>();
  bin = false;
  daemon = false;
  backend = "NoState";
  forwarder = false;
  target = "";
  proxyUp = true;
  upError?: string;
  keyAtUp?: string;
  marker = false;
  profileExists = true;

  kindOf(command: string): Kind {
    if (command === TAILNET_INSPECT_COMMAND) return "inspect";
    if (command === TAILNET_INSTALL_COMMAND) return "install";
    if (command === TAILNET_DAEMON_COMMAND) return "daemon";
    if (command === TAILNET_LOGOUT_COMMAND) return "logout";
    if (command === `rm -f ${TAILNET_AUTH_KEY_FILE}`) return "rm-key";
    if (command.includes(" up --reset ")) return "up";
    if (command.includes(`forwarder.mjs" serve`)) return "forwarder";
    if (command.startsWith("test -f ") && command.includes(".polpo-egress")) return "marker-test";
    if (command.includes(".polpo-egress") && command.includes("printf")) return "marker-write";
    if (command.includes("agent-browser")) return "browser";
    return "other";
  }

  async exec(command: string, opts: { timeoutMs?: number; env?: Record<string, string> } = {}) {
    const kind = this.kindOf(command);
    this.calls.push({ kind, command, ...(opts.env ? { env: opts.env } : {}) });
    this.events.push(kind);
    const ok = (stdout = "") => ({ exitCode: 0, stdout, stderr: "" });
    switch (kind) {
      case "inspect": return ok(this.inspection());
      case "install": this.bin = true; return ok(`${TAILSCALE_VERSION}\n`);
      case "daemon": this.daemon = true; this.backend = "NeedsLogin"; return ok();
      case "up": {
        this.keyAtUp = this.files.get(TAILNET_AUTH_KEY_FILE);
        this.files.delete(TAILNET_AUTH_KEY_FILE);
        // a failing up whose output (wrongly) echoes the key: it must be masked
        if (this.upError) return { exitCode: 1, stdout: "", stderr: `${this.upError} ${this.keyAtUp}` };
        this.backend = "Running";
        return ok();
      }
      case "rm-key": this.files.delete(TAILNET_AUTH_KEY_FILE); return ok();
      case "forwarder": this.forwarder = true; this.target = /T='([^']+)'/.exec(command)?.[1] ?? ""; return ok();
      case "logout": this.backend = "NeedsLogin"; this.daemon = false; this.forwarder = false; return ok();
      case "marker-test": return { exitCode: this.marker ? 0 : 1, stdout: "", stderr: "" };
      case "marker-write": if (this.profileExists) { this.marker = true; return ok("marked\n"); } return ok();
      case "browser": return ok(JSON.stringify({ success: true, data: { ran: command } }));
      default: return ok();
    }
  }

  async writeFile(path: string, data: Uint8Array) {
    this.files.set(path, new TextDecoder().decode(data));
    this.events.push(`write:${path === TAILNET_AUTH_KEY_FILE ? "key" : path === TAILNET_FORWARDER_FILE ? "forwarder" : path}`);
  }

  inspection(): string {
    const lines = [`bin=${this.bin ? 1 : 0}`, `daemon=${this.daemon ? 1 : 0}`, `forwarder=${this.forwarder ? 1 : 0}`, `target=${this.target}`];
    if (this.forwarder) lines.push(`probe=${this.proxyUp && this.backend === "Running" ? 1 : 0}`);
    lines.push("---status---");
    if (this.daemon) {
      lines.push(JSON.stringify({
        BackendState: this.backend,
        Self: { HostName: "polpo-sbx-p-nina", DNSName: this.backend === "Running" ? "polpo-sbx-p-nina.tail1234.ts.net." : "", TailscaleIPs: this.backend === "Running" ? ["100.80.1.2"] : null },
        Peer: { k1: { HostName: "ahp0", DNSName: "ahp0.tail1234.ts.net.", TailscaleIPs: ["100.101.55.7"], CurAddr: "", Relay: "fra" } },
      }, null, 2));
    }
    return lines.join("\n");
  }

  /** Nothing in a command line or an environment holds the key. */
  leaked(): boolean {
    return this.calls.some((c) => c.command.includes(KEY) || JSON.stringify(c.env ?? {}).includes(KEY));
  }
}

// ── Settings and validation ─────────────────────────────────────────────

describe("settings.tailscale and remote egress rules", () => {
  test("the auth key is only a vault reference; tags and prefix are checked", () => {
    expect(parseTailscaleSettings(tailscale)).toEqual({ authKey: { owner: "ops", service: "tailscale" } });
    expect(() => parseTailscaleSettings({ authKey: KEY })).toThrow(/vault reference.*never the key itself/);
    expect(() => parseTailscaleSettings({})).toThrow(/vault reference/);
    expect(() => parseTailscaleSettings({ authKey: { owner: "$sandbox", service: "x" } })).toThrow(/vault reference/);
    expect(parseTailscaleSettings({ ...tailscale, tags: ["tag:Polpo-Sandbox", "tag:polpo-sandbox"], hostnamePrefix: "Lumea" }))
      .toEqual({ authKey: tailscale.authKey, tags: ["tag:polpo-sandbox"], hostnamePrefix: "lumea" });
    expect(() => parseTailscaleSettings({ ...tailscale, tags: ["polpo"] })).toThrow(/tags/);
    expect(() => parseTailscaleSettings({ ...tailscale, hostnamePrefix: "no spaces" })).toThrow(/hostnamePrefix/);
  });

  test("tailnet hosts: 100.64.0.0/10 and MagicDNS names", () => {
    for (const h of ["100.101.55.7", "100.64.0.1", "100.127.255.254", "ahp0", "ahp0.tail1234.ts.net"]) expect(isTailnetHost(h)).toBe(true);
    for (const h of ["100.63.0.1", "100.128.0.1", "10.0.0.1", "example.com", "localhost", "1080"]) expect(isTailnetHost(h)).toBe(false);
  });

  test("remote computers: Tailscale set up, SOCKS5 proxy on a tailnet address, and a network", () => {
    const remote: ComputerConfig = parseComputer({ id: "nina", kind: "daytona", egress: "home" });
    expect(computerEgressProblem(remote, { egressProxies: proxies })).toMatch(/Tailscale.*settings\.tailscale/);
    expect(computerEgressProblem(remote, { egressProxies: proxies, tailscale })).toBeNull();
    expect(computerEgressProblem({ ...remote, egress: "nope" }, { egressProxies: proxies, tailscale })).toMatch(/no egress proxy "nope"/);
    expect(computerEgressProblem(remote, { egressProxies: { home: "http://100.101.55.7:3128" }, tailscale })).toMatch(/SOCKS5 proxies only/);
    expect(computerEgressProblem(remote, { egressProxies: { home: "socks5://203.0.113.9:1080" }, tailscale })).toMatch(/not a tailnet address/);
    expect(computerEgressProblem({ ...remote, network: { mode: "deny" } }, { egressProxies: proxies, tailscale })).toMatch(/no network/);
    expect(computerEgressProblem(remote, { egressProxies: { home: "socks5h://ahp0.tail1234.ts.net:1080" }, tailscale })).toBeNull();
    // a host computer needs only the proxy
    expect(computerEgressProblem({ id: "h", kind: "host", egress: "home" }, { egressProxies: { home: "http://10.0.0.1:3128" } })).toBeNull();
    expect(remoteEgressProblem("home", proxies.home, { tailscale: { authKey: "x" } })).toMatch(/vault reference/);
  });

  test("a run's tailnet egress: node name, tags, the key's reference (never the key)", () => {
    expect(tailnetHostname(undefined, "lumea", "nina")).toBe("polpo-sbx-lumea-nina");
    expect(tailnetHostname("polpo", "My Project!", "nina")).toBe("polpo-my-project-nina");
    expect(tailnetHostname("p", "x".repeat(80), "nina").length).toBeLessThanOrEqual(63);
    const e = tailnetEgressFor({ id: "nina", kind: "daytona", egress: "home" }, { egressProxies: proxies, tailscale }, "lumea");
    expect(e).toEqual({
      name: "home", url: proxies.home,
      tailnet: { computerId: "nina", hostname: "polpo-sbx-lumea-nina", tags: ["tag:polpo-sandbox"], authKey: tailscale.authKey, proxyHost: "100.101.55.7", proxyPort: 1080 },
    });
    expect(JSON.stringify(e)).not.toContain("tskey");
    expect(tailnetEgressFor({ id: "h", kind: "host", egress: "home" }, { egressProxies: proxies, tailscale })).toBeUndefined();
    expect(tailnetEgressFor({ id: "nina", kind: "e2b", egress: "home" }, { egressProxies: proxies })).toBeUndefined();
  });

  test("the config file refuses a remote computer's egress that cannot work", async () => {
    const { parseConfig } = await import("../core/config.js");
    const workDir = tmp("polpo-tailnet-config-");
    mkdirSync(join(workDir, ".polpo"), { recursive: true });
    const write = (settings: unknown) => writeFileSync(join(workDir, ".polpo", "polpo.json"), JSON.stringify({ project: "p", settings }));
    const computers = [{ id: "nina", name: "Nina", kind: "daytona", egress: "home" }];
    write({ egressProxies: proxies, computers });
    await expect(parseConfig(workDir)).rejects.toThrow(/settings\.tailscale/);
    write({ egressProxies: proxies, computers, tailscale: { authKey: KEY } });
    await expect(parseConfig(workDir)).rejects.toThrow(/never the key itself/);
    write({ egressProxies: proxies, computers, tailscale });
    const parsed = await parseConfig(workDir);
    expect(parsed.settings.tailscale).toEqual(tailscale);
    expect(parsed.settings.computers?.[0]?.egress).toBe("home");
  });

  test("PATCH /config/settings: tailscale as a vault reference; nothing that breaks a computer's egress", async () => {
    const { configRoutes } = await import("@polpo-ai/server");
    let config: any = { project: "p", teams: [], settings: { egressProxies: proxies, computers: [{ id: "nina", name: "Nina", kind: "daytona", egress: "home" }] } };
    const app = configRoutes(() => ({ getConfig: () => config, reloadConfig: async () => true, saveConfig: async (c: any) => { config = c; }, getNotificationRouter: () => null } as any));
    const patch = (body: unknown) => app.request("/settings", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await patch({ tailscale: { authKey: { owner: "ops" } } })).status).toBe(400);
    const ok = await patch({ tailscale: { authKey: tailscale.authKey, tags: ["tag:polpo-sandbox"] } });
    expect(ok.status).toBe(200);
    expect(config.settings.tailscale).toEqual({ authKey: tailscale.authKey, tags: ["tag:polpo-sandbox"] });
    // removing Tailscale, or pointing the proxy outside the tailnet, would break nina's egress
    const off = await patch({ tailscale: null });
    expect(off.status).toBe(400);
    expect((await off.json()).error).toMatch(/nina.*settings\.tailscale.*Change the computer's egress first/s);
    expect((await patch({ egressProxies: { home: "socks5://203.0.113.9:1080" } })).status).toBe(400);
    expect(config.settings.tailscale).toBeDefined();
  });

  test("POST /computers: a remote computer's egress needs Tailscale", async () => {
    const { computerRoutes } = await import("../server/routes/computers.js");
    let settings: any = { egressProxies: proxies };
    const state = { computers: [] as ComputerConfig[] };
    const polpoDir = tmp("polpo-tailnet-routes-");
    const app = computerRoutes({
      computers: () => state.computers, settings: () => settings, agents: async () => [],
      manager: () => new ComputerManager(polpoDir, { adapter: () => ({ list: async () => [] }) as any }),
      save: async (list) => { state.computers = list; }, sandboxFor: () => ({ error: "no key" }), emit: () => {},
    });
    const post = (body: unknown) => app.request("/", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const refused = await post({ id: "nina", kind: "daytona", egress: "home" });
    expect(refused.status).toBe(400);
    expect((await refused.json()).error).toMatch(/Tailscale/);
    settings = { egressProxies: proxies, tailscale };
    expect((await post({ id: "nina", kind: "daytona", egress: "home" })).status).toBe(201);
    // not running: the status says so without starting it
    const status = await (await app.request("/nina/egress")).json();
    expect(status.data).toMatchObject({ computerId: "nina", proxy: "home", tailnet: "off", proxyReachable: false });
  });

  test("the runner images install the same pinned Tailscale", async () => {
    // @ts-expect-error untyped .mjs
    const script = await import("../../scripts/build-sandbox-images.mjs");
    expect(script.TAILSCALE_VERSION).toBe(TAILSCALE_VERSION);
    expect(script.TAILSCALE_SHA256).toEqual(TAILSCALE_SHA256);
    expect(script.ROOT_STEPS.some((s: string) => s.includes(`F=tailscale_${TAILSCALE_VERSION}_$A`) && s.includes(TAILSCALE_SHA256.arm64))).toBe(true);
    expect(TAILNET_INSTALL_COMMAND).toContain(TAILSCALE_SHA256.amd64);
    expect(TAILNET_INSTALL_COMMAND).toContain("sha256sum -c");
  });
});

// ── The runtime in the VM ───────────────────────────────────────────────

describe("Tailscale in the VM", () => {
  const runtime = (clock = { now: 1_000_000 }) => ({ clock, rt: new TailnetEgress({ vaultStore, now: () => clock.now }) });

  test("bootstrap order: install, daemon, up with the key file, forwarder, probe; the key never on a command line", async () => {
    const vm = new FakeTailnetVm();
    const { rt } = runtime();
    const status = await rt.ensure(vm, ref());
    expect(vm.events).toEqual([
      "inspect", "install", "daemon", "inspect",
      "write:key", "up", "rm-key", "inspect",
      "write:forwarder", "forwarder", "inspect",
    ]);
    expect(status).toMatchObject({
      computerId: "nina", tailnet: "up", node: "polpo-sbx-p-nina.tail1234.ts.net", tailnetIp: "100.80.1.2",
      path: "derp", relay: "fra", proxyReachable: true,
    });
    expect(status.error).toBeUndefined();
    // the key reached the VM only as a file, and that file is gone
    expect(vm.keyAtUp).toBe(KEY);
    expect(vm.files.has(TAILNET_AUTH_KEY_FILE)).toBe(false);
    expect(vm.leaked()).toBe(false);
    const up = vm.calls.find((c) => c.kind === "up")!.command;
    expect(up).toContain(`--auth-key=file:"$D/authkey"`);
    expect(up).toContain("--hostname='polpo-sbx-p-nina'");
    expect(up).toContain("--advertise-tags='tag:polpo-sandbox'");
    expect(up).toContain("--accept-dns=false");
    expect(up).toMatch(/rm -f "\$D\/authkey"/);
    expect(vm.calls.find((c) => c.kind === "forwarder")!.command).toContain("T='100.101.55.7:1080'");
    expect(vm.files.get(TAILNET_FORWARDER_FILE)).toBe(TAILNET_FORWARDER_SCRIPT);
    expect(TAILNET_DAEMON_COMMAND).toContain("--tun=userspace-networking --socks5-server=127.0.0.1:1055 --state=mem:");
  });

  test("a failing up: the key is masked in the error and its file removed", async () => {
    const vm = new FakeTailnetVm();
    vm.upError = "backend error: invalid key";
    const { rt } = runtime();
    const status = await rt.ensure(vm, ref());
    expect(status).toMatchObject({ tailnet: "down", proxyReachable: false });
    expect(status.error).toMatch(/tailscale up failed: backend error: invalid key \*\*\*/);
    expect(JSON.stringify(status)).not.toContain(KEY);
    expect(vm.events.slice(-2)).toEqual(["up", "rm-key"]);
    expect(vm.files.has(TAILNET_AUTH_KEY_FILE)).toBe(false);
  });

  test("no key in the vault entry: a clear error, nothing uploaded", async () => {
    const vm = new FakeTailnetVm();
    const rt = new TailnetEgress({ vaultStore: { get: async () => ({ credentials: { note: "x" } }) } as any });
    const status = await rt.ensure(vm, ref());
    expect(status.error).toMatch(/No Tailscale auth key in the vault entry ops \/ tailscale/);
    expect(vm.events.some((e) => e === "write:key" || e === "up")).toBe(false);
  });

  test("idempotent: cached for a while, then one look when everything runs; concurrent calls share one bootstrap", async () => {
    const vm = new FakeTailnetVm();
    const { rt, clock } = runtime();
    const [a, b] = await Promise.all([rt.ensure(vm, ref()), rt.ensure(vm, ref())]);
    expect(a).toBe(b);
    expect(vm.events.filter((e) => e === "up")).toHaveLength(1);
    const before = vm.events.length;
    await rt.ensure(vm, ref());
    expect(vm.events.length).toBe(before);
    clock.now += 31_000;
    const again = await rt.ensure(vm, ref());
    expect(vm.events.slice(before)).toEqual(["inspect"]);
    expect(again.proxyReachable).toBe(true);
  });

  test("after a resume or a restart the daemons are checked and brought back", async () => {
    const vm = new FakeTailnetVm();
    const { rt } = runtime();
    await rt.ensure(vm, ref());
    // a container restart: processes gone, binaries still there
    vm.daemon = false; vm.forwarder = false; vm.backend = "NoState";
    rt.invalidate("nina");
    const before = vm.events.length;
    const status = await rt.ensure(vm, ref());
    expect(vm.events.slice(before)).toEqual(["inspect", "daemon", "inspect", "write:key", "up", "rm-key", "inspect", "write:forwarder", "forwarder", "inspect"]);
    expect(status.proxyReachable).toBe(true);
    expect(vm.leaked()).toBe(false);
  });

  test("the proxy does not answer: tailnet up, proxy unreachable (the browser falls back)", async () => {
    const vm = new FakeTailnetVm();
    vm.proxyUp = false;
    const { rt } = runtime();
    const status = await rt.ensure(vm, ref());
    expect(status).toMatchObject({ tailnet: "up", proxyReachable: false });
    expect(status.error).toMatch(/does not answer through the tailnet/);
  });

  test("a changed proxy restarts the forwarder", async () => {
    const vm = new FakeTailnetVm();
    const { rt } = runtime();
    await rt.ensure(vm, ref());
    const other = { ...ref(), proxyHost: "100.101.55.8", proxyPort: 1081 };
    const before = vm.events.length;
    await rt.ensure(vm, other);
    expect(vm.events.slice(before)).toEqual(["inspect", "write:forwarder", "forwarder", "inspect"]);
    expect(vm.target).toBe("100.101.55.8:1081");
  });

  test("tailscale status: direct or DERP path to the proxy's machine", () => {
    const status = { BackendState: "Running", Self: { DNSName: "n.ts.net." }, Peer: { a: { HostName: "ahp0", TailscaleIPs: ["100.101.55.7"], CurAddr: "203.0.113.1:41641", Relay: "fra" } } };
    expect(describeTailnet(status, "100.101.55.7")).toMatchObject({ tailnet: "up", node: "n.ts.net", path: "direct" });
    expect(describeTailnet(status, "ahp0")).toMatchObject({ path: "direct" });
    expect(describeTailnet({ BackendState: "NeedsLogin", Self: { HostName: "vm" } }, "ahp0")).toEqual({ tailnet: "down" });
  });
});

// ── The browser in the VM ───────────────────────────────────────────────

/** The run's shell in the VM: tailnet and marker commands go to the fake VM; agent-browser answers. */
class VmShell implements Shell {
  constructor(readonly vm: FakeTailnetVm) {}
  async isRemote() { return true; }
  async execute(command: string, opts: ShellOptions = {}): Promise<ShellResult> {
    if (command.startsWith("command -v agent-browser")) return { stdout: "/usr/bin/agent-browser", stderr: "", exitCode: 0 };
    return this.vm.exec(command, { timeoutMs: opts.timeout, env: opts.env });
  }
}

describe("the browser of a remote computer going out through the tailnet", () => {
  const egress = { name: "home", url: proxies.home, tailnet: ref("browser-pc") };
  const fs = (vm: FakeTailnetVm) => ({ writeFileBuffer: (p: string, d: Uint8Array) => vm.writeFile(p, d) }) as any;
  const tool = (tools: any[], name: string) => tools.find((t) => t.name === name)!;
  const browserCalls = (vm: FakeTailnetVm) => vm.calls.filter((c) => c.kind === "browser").map((c) => c.command);

  beforeEach(() => {
    configureTailnetEgress({ vaultStore });
    tailnetEgress.invalidate();
    resetBrowserEgressSessions();
  });

  test("reachable: the browser restarts behind the forwarder and the profile is marked", async () => {
    const vm = new FakeTailnetVm();
    const tools = createBrowserTools("/vm/work", "growth", ["browser_navigate"], "/host/.polpo/browser-profiles/growth", "/vm/out", undefined, undefined, { shell: new VmShell(vm), fs: fs(vm), egress });
    await tool(tools, "browser_navigate").execute("1", { url: "https://example.com" });
    const calls = browserCalls(vm);
    expect(calls[0]).toBe("agent-browser --session 'growth' 'close' --json");
    expect(calls[1]).toContain(`'--proxy' '${TAILNET_BROWSER_PROXY}' '--proxy-bypass' '<-loopback>'`);
    expect(calls[1]).toContain("'open' 'https://example.com'");
    expect(vm.marker).toBe(true);
    expect(vm.calls.find((c) => c.kind === "marker-write")!.command).toContain(`"$HOME"/'.polpo/browser-profiles/growth'/.polpo-egress`);
    expect(vm.leaked()).toBe(false);
    // the next call: same proxy, no restart, no new tailnet look (cached)
    const before = vm.calls.length;
    await tool(tools, "browser_navigate").execute("2", { url: "https://example.org" });
    expect(vm.calls.slice(before).map((c) => c.kind)).toEqual(["browser"]);
  });

  test("unreachable: a profile signed in through it pauses; a fresh one goes out directly (and restarts)", async () => {
    const vm = new FakeTailnetVm();
    const shell = new VmShell(vm);
    const tools = createBrowserTools("/vm/work", "growth2", ["browser_navigate"], "/host/.polpo/browser-profiles/growth2", "/vm/out", undefined, undefined, { shell, fs: fs(vm), egress });
    await tool(tools, "browser_navigate").execute("1", { url: "https://example.com" });
    expect(vm.marker).toBe(true);
    // home goes off
    vm.proxyUp = false;
    tailnetEgress.invalidate();
    const before = browserCalls(vm).length;
    const paused = await tool(tools, "browser_navigate").execute("2", { url: "https://example.com" });
    expect(paused.content[0].text).toMatch(/"home" connection is unreachable.*stays paused/s);
    expect(browserCalls(vm).length).toBe(before);

    // another agent whose profile never went through it: directly from the VM, browser restarted without the proxy
    const vm2 = new FakeTailnetVm();
    vm2.profileExists = false;
    const direct = createBrowserTools("/vm/work", "growth3", ["browser_navigate"], "/host/.polpo/browser-profiles/growth3", "/vm/out", undefined, undefined, { shell: new VmShell(vm2), fs: fs(vm2), egress: { ...egress, tailnet: ref("browser-pc-2") } });
    await tool(direct, "browser_navigate").execute("1", { url: "https://example.com" });
    expect(browserCalls(vm2).at(-1)).toContain("'--proxy'");
    vm2.proxyUp = false;
    tailnetEgress.invalidate();
    await tool(direct, "browser_navigate").execute("2", { url: "https://example.com" });
    const [close, open] = browserCalls(vm2).slice(-2);
    expect(close).toBe("agent-browser --session 'growth3' 'close' --json");
    expect(open).not.toContain("--proxy");
  });

  test("a remote computer without a tailnet egress: the browser in the VM goes out from the VM", async () => {
    const vm = new FakeTailnetVm();
    const tools = createBrowserTools("/vm/work", "growth4", ["browser_navigate"], undefined, "/vm/out", undefined, undefined, { shell: new VmShell(vm), egress: { name: "home", url: proxies.home } });
    await tool(tools, "browser_navigate").execute("1", { url: "https://example.com" });
    expect(vm.calls.map((c) => c.kind)).toEqual(["browser"]);
    expect(browserCalls(vm)[0]).not.toContain("--proxy");
  });
});

// ── The computer's lifecycle ────────────────────────────────────────────

class OneMachine implements RemoteAdapter {
  readonly provider = "daytona" as const;
  readonly fastSuspend = false;
  state = "started";
  removed: string[] = [];
  vm = new FakeTailnetVm();
  order: string[] = [];
  async create(): Promise<RemoteDriver> { throw new Error("not in this test"); }
  async connect(): Promise<RemoteDriver> {
    this.state = "started";
    const vm = this.vm;
    return {
      remoteId: "dt-1",
      exec: async (command, o) => { this.order.push(vm.kindOf(command)); return vm.exec(command, { timeoutMs: o.timeoutMs, env: o.env }); },
      readFile: async () => new Uint8Array(),
      writeFile: (p, d) => vm.writeFile(p, d),
      suspend: async () => {}, resume: async () => {}, destroy: async () => {},
    };
  }
  async list(labels: Record<string, string>): Promise<RemoteVmSummary[]> {
    return this.removed.length ? [] : [{ remoteId: "dt-1", state: this.state, labels }];
  }
  async remove(id: string) { this.order.push("remove"); this.removed.push(id); }
  async suspendById() { this.state = "stopped"; }
}

describe("computers and their tailnet", () => {
  const sandbox = { provider: "daytona", network: { mode: "open" }, resources: {}, providerOptions: {}, denied: [] } as any;

  test("delete: a running machine leaves the tailnet first; without egress nothing is run", async () => {
    const adapter = new OneMachine();
    const m = new ComputerManager(tmp("polpo-tailnet-cm-"), { adapter: () => adapter });
    await m.delete({ id: "nina", name: "Nina", kind: "daytona", egress: "home" });
    expect(adapter.order).toEqual(["logout", "remove"]);
    const plain = new OneMachine();
    await new ComputerManager(tmp("polpo-tailnet-cm-"), { adapter: () => plain }).delete({ id: "box", name: "Box", kind: "daytona" });
    expect(plain.order).toEqual(["remove"]);
  });

  test("start or resume: the tailnet is checked again and brought up in the background", async () => {
    const adapter = new OneMachine();
    adapter.state = "stopped";
    const computer: ComputerConfig = { id: "pc-start", name: "PC", kind: "daytona", egress: "home" };
    configureTailnetEgress({ vaultStore, egressFor: (c) => tailnetEgressFor(c, { egressProxies: proxies, tailscale }, "p") });
    const m = new ComputerManager(tmp("polpo-tailnet-cm-"), { adapter: () => adapter });
    await m.ensure(computer, sandbox);
    await new Promise((r) => setTimeout(r, 50));
    expect(adapter.order).toEqual(["inspect", "install", "daemon", "inspect", "up", "rm-key", "inspect", "forwarder", "inspect"]);
    expect(tailnetEgress.last("pc-start")).toMatchObject({ tailnet: "up", proxyReachable: true, node: "polpo-sbx-p-nina.tail1234.ts.net" });
    expect(adapter.vm.leaked()).toBe(false);
    // running: the status looks inside without starting anything
    const { computerEgressStatus } = await import("../sandbox/computers.js");
    const s = await computerEgressStatus(m, computer, { egressProxies: proxies, tailscale }, "p");
    expect(s).toMatchObject({ computerId: "pc-start", proxy: "home", tailnet: "up", path: "derp", relay: "fra", proxyReachable: true, effective: "via home", machine: "running" });
  });
});

// ── The forwarder script ────────────────────────────────────────────────

describe("the forwarder (node, in the VM)", () => {
  /** A server on a free port. */
  const listen = async (handler: (s: net.Socket) => void) => {
    const server = net.createServer((s) => { s.on("error", () => {}); handler(s); });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    return { server, port: (server.address() as net.AddressInfo).port };
  };
  const freePort = async () => { const { server, port } = await listen(() => {}); await new Promise((r) => server.close(r)); return port; };
  const run = (args: string[]) => new Promise<number>((resolve) => { const c = spawn(process.execPath, args, { stdio: "ignore" }); c.on("close", (code) => resolve(code ?? 1)); });

  test("1081 behaves as the proxy: SOCKS5 CONNECT to it through tailscaled's SOCKS server, then raw bytes", async () => {
    const dir = tmp("polpo-forwarder-");
    const script = join(dir, "forwarder.mjs");
    writeFileSync(script, TAILNET_FORWARDER_SCRIPT);
    // the "home proxy": answers a SOCKS5 greeting
    const home = await listen((s) => s.on("data", (d) => { if (d[0] === 5) s.write(Buffer.from([5, 0])); }));
    // "tailscaled": a SOCKS5 server that CONNECTs (to the home proxy, whatever address is asked)
    const asked: Buffer[] = [];
    const tsd = await listen((s) => {
      let stage = 0;
      s.on("data", (d) => {
        if (stage === 0) { stage = 1; s.write(Buffer.from([5, 0])); return; }
        if (stage === 1) {
          stage = 2;
          asked.push(Buffer.from(d));
          const up = net.connect({ host: "127.0.0.1", port: home.port }, () => {
            up.on("close", () => s.destroy());
            s.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
            s.pipe(up); up.pipe(s);
          });
          up.on("error", () => s.destroy());
        }
      });
    });
    const port = await freePort();
    const child = spawn(process.execPath, [script, "serve", String(port), String(tsd.port), "100.101.55.7", "1080"], { stdio: "ignore" });
    try {
      // wait for it to listen
      for (let i = 0; i < 50; i++) {
        const ok = await new Promise<boolean>((r) => { const s = net.connect({ host: "127.0.0.1", port }, () => { s.destroy(); r(true); }); s.on("error", () => r(false)); });
        if (ok) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(await run([script, "probe", "127.0.0.1", String(port)])).toBe(0);
      // CONNECT 100.101.55.7:1080 (IPv4 form)
      expect([...asked[0]!]).toEqual([5, 1, 0, 1, 100, 101, 55, 7, 1080 >> 8, 1080 & 255]);
      // the home proxy off: the probe fails
      await new Promise((r) => home.server.close(r));
      expect(await run([script, "probe", "127.0.0.1", String(port)])).not.toBe(0);
    } finally {
      child.kill();
      tsd.server.close();
    }
  }, 20_000);
});
