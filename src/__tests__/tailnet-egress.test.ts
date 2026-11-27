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
  TAILNET_FORWARDER_STOP_COMMAND, TAILNET_INSPECT_COMMAND, TAILNET_INSTALL_COMMAND, TAILNET_LOGOUT_COMMAND, TAILNET_RESTART_COMMAND,
  TAILSCALE_SHA256, TAILSCALE_VERSION,
  TailnetEgress, configureTailnetEgress, describeTailnet, goDurationMs, onComputerStarted, tailnetEgress, tailnetStaleReason, type TailnetHost,
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

type Kind = "inspect" | "install" | "daemon" | "up" | "rm-key" | "forwarder" | "logout" | "restart" | "fwd-stop" | "marker-test" | "marker-write" | "browser" | "other";

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
  /** The node was removed from the tailnet (ephemeral, while the VM slept): nothing goes through it. */
  removed = false;
  /** Self.Online in `tailscale status --json` (left out when undefined). */
  selfOnline?: boolean;
  health: string[] = [];
  /** The forwarder runs but does not relay (the tunnel itself works). */
  forwarderBroken = false;
  /** A `tailscale up` that fails only on a daemon from before a restart. */
  upFailsUntilRestart = false;

  kindOf(command: string): Kind {
    if (command === TAILNET_INSPECT_COMMAND) return "inspect";
    if (command === TAILNET_INSTALL_COMMAND) return "install";
    if (command === TAILNET_DAEMON_COMMAND) return "daemon";
    if (command === TAILNET_LOGOUT_COMMAND) return "logout";
    if (command === TAILNET_RESTART_COMMAND) return "restart";
    if (command === TAILNET_FORWARDER_STOP_COMMAND) return "fwd-stop";
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
        if (this.upFailsUntilRestart) return { exitCode: 1, stdout: "", stderr: "context deadline exceeded" };
        this.backend = "Running";
        this.removed = false; this.selfOnline = this.selfOnline === undefined ? undefined : true; this.health = [];
        return ok();
      }
      case "rm-key": this.files.delete(TAILNET_AUTH_KEY_FILE); return ok();
      case "forwarder": this.forwarder = true; this.target = /T='([^']+)'/.exec(command)?.[1] ?? ""; return ok();
      case "logout": this.backend = "NeedsLogin"; this.daemon = false; this.forwarder = false; return ok();
      case "restart":
        this.daemon = false; this.forwarder = false; this.forwarderBroken = false; this.target = ""; this.backend = "NoState";
        this.upFailsUntilRestart = false;
        return ok();
      case "fwd-stop": this.forwarder = false; this.forwarderBroken = false; this.target = ""; return ok();
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
    const script = this.files.get(TAILNET_FORWARDER_FILE);
    if (script !== undefined) lines.push(`fwdv2=${script.includes("probe-via") ? 1 : 0}`);
    // end to end: the proxy at home answers only through a node the tailnet still knows
    const through = this.proxyUp && this.backend === "Running" && !this.removed;
    if (this.forwarder) lines.push(`probe=${through && !this.forwarderBroken ? 1 : 0}`);
    if (this.target && this.daemon && script?.includes("probe-via")) lines.push(`tunnel=${through ? 1 : 0}`);
    lines.push("---status---");
    if (this.daemon) {
      lines.push(JSON.stringify({
        BackendState: this.backend,
        ...(this.health.length ? { Health: this.health } : {}),
        Self: {
          HostName: "polpo-sbx-p-nina", DNSName: this.backend === "Running" ? "polpo-sbx-p-nina.tail1234.ts.net." : "", TailscaleIPs: this.backend === "Running" ? ["100.80.1.2"] : null,
          ...(this.selfOnline !== undefined ? { Online: this.selfOnline } : {}),
        },
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

  test("a hibernated computer's egress reads well: checked again when it wakes, never 'proxy not reachable' (garbled live)", async () => {
    const { computerEgressStatus, describeComputerEgress } = await import("../sandbox/computers.js");
    const polpoDir = tmp("polpo-tailnet-hib-");
    writeFileSync(join(polpoDir, "computers-state.json"), JSON.stringify({ version: 1, computers: { nina: { provider: "daytona", status: "hibernated", uptimeMs: 0, updatedAt: new Date().toISOString() } } }));
    const m = new ComputerManager(polpoDir, { adapter: () => ({ list: async () => [] }) as any });
    const nina: ComputerConfig = { id: "nina", name: "Nina", kind: "daytona", egress: "home" };
    const s = (await computerEgressStatus(m, nina, { egressProxies: proxies, tailscale }, "p"))!;
    expect(s).toMatchObject({ tailnet: "off", machine: "hibernated", effective: "checked again when it wakes" });
    const line = describeComputerEgress(nina, s);
    expect(line).toBe("computer nina (daytona) → home: Hibernated: egress is checked again when it wakes");
    expect(line).not.toMatch(/not reachable|goes out comes up/);
    // stopped (not hibernated): the same idea
    expect(describeComputerEgress(nina, { ...s, machine: "stopped", effective: "checked again when it next starts (it is stopped)" }))
      .toBe("computer nina (daytona) → home: Stopped: egress is checked again when it next starts");
    // running: tailnet, path, proxy and where the browser goes out
    expect(describeComputerEgress(nina, { ...s, tailnet: "up", machine: "running", proxyReachable: true, effective: "via home", node: "n.ts.net", path: "direct" }))
      .toBe("computer nina (daytona) → home: tailnet up as n.ts.net, path direct, proxy reachable; its browser goes out via home");
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

// ── A stale node (restored from a snapshot, removed from the tailnet) ─────

describe("a stale tailnet node is re-joined", () => {
  /** The live incident: tailscaled back from a memory snapshot says Running, but its ephemeral node is gone. */
  const goStale = (vm: FakeTailnetVm) => {
    vm.removed = true;
    vm.selfOnline = false;
    vm.health = [
      "Unable to connect to the Tailscale coordination server to synchronize the state of your tailnet. Peer reachability might degrade over time.",
      "Tailscale hasn't received a network map from the coordination server in 63h.",
    ];
  };
  const healthy = async (rt: TailnetEgress) => {
    const vm = new FakeTailnetVm();
    vm.selfOnline = true;
    expect((await rt.ensure(vm, ref())).proxyReachable).toBe(true);
    return vm;
  };

  test("stale detection from tailscale status --json; Go durations", () => {
    expect(goDurationMs("63h")).toBe(63 * 3_600_000);
    expect(goDurationMs("1h2m3.5s")).toBe(3_723_500);
    expect(goDurationMs("250ms")).toBe(250);
    expect(goDurationMs("soon")).toBeUndefined();
    expect(tailnetStaleReason({ BackendState: "Running", Self: { Online: true } })).toBeUndefined();
    expect(tailnetStaleReason({ BackendState: "Running", Self: { Online: false } })).toMatch(/offline in the tailnet/);
    expect(tailnetStaleReason({ BackendState: "Running", Health: ["Tailscale hasn't received a network map from the coordination server in 63h."] })).toBe("no network map from the coordination server for 63h");
    // a short gap is not stale; a coordination server that does not answer is
    expect(tailnetStaleReason({ BackendState: "Running", Health: ["Tailscale hasn't received a network map from the coordination server in 2m0s."] })).toBeUndefined();
    expect(tailnetStaleReason({ BackendState: "Running", Health: ["Unable to connect to the Tailscale coordination server to synchronize the state of your tailnet."] })).toMatch(/cannot reach the Tailscale coordination server/);
    // other states go through `tailscale up` anyway
    expect(tailnetStaleReason({ BackendState: "NeedsLogin", Self: { Online: false } })).toBeUndefined();
  });

  test("Self offline and no network map, the proxy unreachable: restart tailscaled, up again, forwarder, probe", async () => {
    const progress: string[] = [];
    const rt = new TailnetEgress({ vaultStore, onProgress: (m) => progress.push(m) });
    const vm = await healthy(rt);
    goStale(vm);
    rt.invalidate("nina");
    const before = vm.events.length;
    const status = await rt.ensure(vm, ref());
    expect(vm.events.slice(before)).toEqual([
      "inspect", "restart", "inspect", "daemon", "inspect",
      "write:key", "up", "rm-key", "inspect",
      "write:forwarder", "forwarder", "inspect",
    ]);
    expect(status).toMatchObject({ tailnet: "up", proxyReachable: true });
    expect(status.error).toBeUndefined();
    expect(progress.join("\n")).toMatch(/re-joining the tailnet \(the node is offline in the tailnet.*no network map from the coordination server for 63h\)/);
    expect(vm.leaked()).toBe(false);
  });

  test("a healthy node is never restarted (nor one whose proxy is merely off)", async () => {
    const clock = { now: 1_000_000 };
    const egress = new TailnetEgress({ vaultStore, now: () => clock.now });
    const vm = await healthy(egress);
    clock.now += 31_000;
    expect((await egress.ensure(vm, ref())).proxyReachable).toBe(true);
    // the machine at home off: the node is fine, nothing to re-join
    vm.proxyUp = false;
    clock.now += 31_000;
    const off = await egress.ensure(vm, ref());
    expect(off).toMatchObject({ tailnet: "up", proxyReachable: false });
    expect(off.error).toMatch(/does not answer through the tailnet/);
    expect(vm.events).not.toContain("restart");
  });

  test("up fails after the restart: a clear error (key masked), one restart only", async () => {
    const rt = new TailnetEgress({ vaultStore });
    const vm = await healthy(rt);
    goStale(vm);
    vm.upError = "requested tags [tag:polpo-sandbox] are invalid or not permitted";
    rt.invalidate("nina");
    const status = await rt.ensure(vm, ref());
    expect(status).toMatchObject({ tailnet: "down", proxyReachable: false });
    expect(status.error).toMatch(/^Re-joining the tailnet \(the node is offline.*\) failed: tailscale up failed: requested tags .* not permitted \*\*\*.*ACL lets tag:polpo-sandbox join.*tried again on the browser's next use/s);
    expect(JSON.stringify(status)).not.toContain(KEY);
    expect(vm.events.filter((e) => e === "restart")).toHaveLength(1);
    expect(vm.files.has(TAILNET_AUTH_KEY_FILE)).toBe(false);
  });

  test("up fails on a daemon from before: one clean restart, then it joins", async () => {
    const rt = new TailnetEgress({ vaultStore });
    const vm = await healthy(rt);
    // a daemon that lost its login and cannot log in again in its old state
    vm.backend = "NeedsLogin"; vm.upFailsUntilRestart = true;
    rt.invalidate("nina");
    const before = vm.events.length;
    const status = await rt.ensure(vm, ref());
    expect(vm.events.slice(before)).toEqual([
      "inspect", "write:key", "up", "rm-key",
      "restart", "inspect", "daemon", "inspect", "write:key", "up", "rm-key", "inspect",
      "write:forwarder", "forwarder", "inspect",
    ]);
    expect(status.proxyReachable).toBe(true);
  });

  test("a resume: always looked at again (never the cached steady state), and a tailscaled back from the snapshot is restarted", async () => {
    const clock = { now: 1_000_000 };
    const rt = new TailnetEgress({ vaultStore, now: () => clock.now });
    const vm = await healthy(rt);
    // right after a resume from a memory snapshot everything still looks fine (old netmap)
    rt.invalidate("nina", { restored: true });
    const before = vm.events.length;
    const status = await rt.ensure(vm, ref());
    expect(vm.events.slice(before)).toEqual([
      "inspect", "restart", "inspect", "daemon", "inspect", "write:key", "up", "rm-key", "inspect", "write:forwarder", "forwarder", "inspect",
    ]);
    expect(status.proxyReachable).toBe(true);
    // once only: the next check (after the cache) does not restart again
    clock.now += 31_000;
    const after = vm.events.length;
    await rt.ensure(vm, ref());
    expect(vm.events.slice(after)).toEqual(["inspect"]);
    // a fresh start (no tailscaled alive yet): nothing to restart
    const fresh = new FakeTailnetVm();
    rt.invalidate("fresh", { restored: true });
    await rt.ensure(fresh, ref("fresh"));
    expect(fresh.events).not.toContain("restart");
  });

  test("onComputerStarted marks the computer restored: the background check restarts the daemon from the snapshot", async () => {
    configureTailnetEgress({ vaultStore, egressFor: (c) => tailnetEgressFor(c, { egressProxies: proxies, tailscale }, "p") });
    tailnetEgress.invalidate();
    const vm = new FakeTailnetVm();
    vm.selfOnline = true;
    const egressRef = tailnetEgressFor({ id: "woken", kind: "daytona", egress: "home" }, { egressProxies: proxies, tailscale }, "p")!.tailnet!;
    expect((await tailnetEgress.ensure(vm, egressRef)).proxyReachable).toBe(true);
    const before = vm.events.length;
    onComputerStarted({ id: "woken", kind: "daytona", egress: "home" }, vm);
    // the check in the background is shared with the browser's next use
    const status = await tailnetEgress.ensure(vm, egressRef);
    expect(vm.events.slice(before)).toContain("restart");
    expect(status.proxyReachable).toBe(true);
  });

  test("end to end: a forwarder that listens is not enough; a broken forwarder alone is restarted", async () => {
    const rt = new TailnetEgress({ vaultStore });
    const vm = await healthy(rt);
    // the forwarder listens and the tunnel works, but nothing is relayed: only the forwarder restarts
    vm.forwarderBroken = true;
    rt.invalidate("nina");
    let before = vm.events.length;
    expect((await rt.ensure(vm, ref())).proxyReachable).toBe(true);
    expect(vm.events.slice(before)).toEqual(["inspect", "fwd-stop", "write:forwarder", "forwarder", "inspect"]);
    // the proxy does not answer through the tunnel either: not reachable, whatever listens locally
    vm.proxyUp = false;
    const inspected = await rt.inspect(vm, ref());
    expect(inspected).toMatchObject({ tailnet: "up", proxyReachable: false });
    expect(inspected.rejoining).toBeUndefined();
    // an older forwarder.mjs in the VM (no tunnel probe) is replaced, even in the steady state
    vm.proxyUp = true;
    vm.files.set(TAILNET_FORWARDER_FILE, "// old forwarder");
    rt.invalidate("nina");
    before = vm.events.length;
    expect((await rt.ensure(vm, ref())).proxyReachable).toBe(true);
    expect(vm.events.slice(before)).toEqual(["inspect", "write:forwarder"]);
    expect(vm.files.get(TAILNET_FORWARDER_FILE)).toBe(TAILNET_FORWARDER_SCRIPT);
  });

  test("the status of a stale node says re-joining the tailnet, and re-joins it", async () => {
    const rt = new TailnetEgress({ vaultStore });
    const vm = await healthy(rt);
    goStale(vm);
    const status = await rt.inspect(vm, ref());
    expect(status).toMatchObject({ tailnet: "starting", proxyReachable: false, rejoining: true });
    expect(status.error).toMatch(/stale .*: re-joining the tailnet/);
    // while it runs, last() says so too
    expect(rt.last("nina")).toMatchObject({ rejoining: true, proxyReachable: false });
    // the background re-join ends with the proxy answering
    const done = await rt.ensure(vm, ref());
    expect(done.proxyReachable).toBe(true);
    expect(vm.events).toContain("restart");
    expect(rt.last("nina")?.rejoining).toBeUndefined();
  });

  test("a profile signed in through home pauses (never goes out directly) when re-joining fails, and says why", async () => {
    configureTailnetEgress({ vaultStore });
    tailnetEgress.invalidate();
    resetBrowserEgressSessions();
    const vm = new FakeTailnetVm();
    vm.selfOnline = true;
    const egress = { name: "home", url: proxies.home, tailnet: ref("stale-pc") };
    const tools = createBrowserTools("/vm/work", "growth-stale", ["browser_navigate"], "/host/.polpo/browser-profiles/growth-stale", "/vm/out", undefined, undefined, { shell: new VmShell(vm), fs: { writeFileBuffer: (p: string, d: Uint8Array) => vm.writeFile(p, d) } as any, egress });
    const navigate = tools.find((t) => t.name === "browser_navigate")!;
    await navigate.execute("1", { url: "https://example.com" });
    expect(vm.marker).toBe(true);
    goStale(vm);
    vm.upError = "auth key expired";
    tailnetEgress.invalidate("stale-pc", { restored: true });
    const before = vm.calls.filter((c) => c.kind === "browser").length;
    const paused = await navigate.execute("2", { url: "https://example.com" });
    expect(paused.content[0].text).toMatch(/"home" connection is unreachable.*stays paused.*Re-joining the tailnet \(.*\) failed: tailscale up failed: auth key expired/s);
    expect(vm.calls.filter((c) => c.kind === "browser").length).toBe(before);
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
    // nothing closed first: the agent's own Chrome is relaunched by its ensure script when its proxy changes
    expect(calls).toHaveLength(1);
    // the agent's own Chrome gets the forwarder as its proxy (agent-browser attaches over CDP)
    expect(calls[0]).toContain(`'--proxy-server=${TAILNET_BROWSER_PROXY}' '--proxy-bypass-list=<-loopback>'`);
    expect(calls[0]).toContain(`--cdp "$P"`);
    expect(calls[0]).toContain("'open' 'https://example.com'");
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
    expect(browserCalls(vm2).at(-1)).toContain("--proxy-server=");
    vm2.proxyUp = false;
    tailnetEgress.invalidate();
    await tool(direct, "browser_navigate").execute("2", { url: "https://example.com" });
    // the ensure script sees another proxy in Chrome's settings and relaunches it (no close first)
    const open = browserCalls(vm2).at(-1)!;
    expect(open).not.toContain("--proxy-server");
    expect(open).toContain(`[ "$(cat "$CF" 2>/dev/null)" = "$CONF" ]`);
  });

  test("a remote computer without a tailnet egress: the browser in the VM goes out from the VM", async () => {
    const vm = new FakeTailnetVm();
    // headless (headed by default on a remote computer: the display's commands are not this test's business)
    const tools = createBrowserTools("/vm/work", "growth4", ["browser_navigate"], undefined, "/vm/out", undefined, undefined, { shell: new VmShell(vm), egress: { name: "home", url: proxies.home }, headed: false });
    await tool(tools, "browser_navigate").execute("1", { url: "https://example.com" });
    expect(vm.calls.map((c) => c.kind)).toEqual(["browser"]);
    expect(browserCalls(vm)[0]).not.toContain("--proxy-server");
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
      // straight through "tailscaled" to the proxy (no forwarder): the tunnel probe
      expect(await run([script, "probe-via", String(tsd.port), "100.101.55.7", "1080"])).toBe(0);
      // the home proxy off: both probes fail
      await new Promise((r) => home.server.close(r));
      expect(await run([script, "probe", "127.0.0.1", String(port)])).not.toBe(0);
      expect(await run([script, "probe-via", String(tsd.port), "100.101.55.7", "1080"])).not.toBe(0);
      // a SOCKS5 server that refuses the CONNECT (a node the tailnet removed): the tunnel probe fails
      const refusing = await listen((s) => {
        let stage = 0;
        s.on("data", () => { if (stage++ === 0) s.write(Buffer.from([5, 0])); else s.write(Buffer.from([5, 4, 0, 1, 0, 0, 0, 0, 0, 0])); });
      });
      expect(await run([script, "probe-via", String(refusing.port), "100.101.55.7", "1080"])).not.toBe(0);
      refusing.server.close();
    } finally {
      child.kill();
      tsd.server.close();
    }
  }, 20_000);
});

// ── Task runs: the shared state file, no restart of a healthy node ─────────

describe("task runs share the last healthy check (first browser call of a run)", () => {
  const stateFile = () => join(tmp("polpo-tailnet-state-"), ".polpo", "tailnet-egress.json");
  const healthyVm = () => { const vm = new FakeTailnetVm(); vm.selfOnline = true; return vm; };

  test("a fresh healthy check by the server: a new runner process runs nothing in the VM", async () => {
    const file = stateFile();
    const clock = { now: 1_000_000 };
    const server = new TailnetEgress({ vaultStore, now: () => clock.now, stateFile: file });
    const vm = healthyVm();
    expect((await server.ensure(vm, ref())).proxyReachable).toBe(true);
    // a task run: its own process, its caches empty
    clock.now += 20_000;
    const runner = new TailnetEgress({ vaultStore, now: () => clock.now, stateFile: file, restoredRestart: "when-probe-fails" });
    const before = vm.events.length;
    const status = await runner.ensure(vm, ref());
    expect(status).toMatchObject({ tailnet: "up", proxyReachable: true });
    expect(vm.events.slice(before)).toEqual([]);
  });

  test("stale (older than the shared TTL), another proxy, or not healthy: looked at once, then cached", async () => {
    const file = stateFile();
    const clock = { now: 1_000_000 };
    const server = new TailnetEgress({ vaultStore, now: () => clock.now, stateFile: file });
    const vm = healthyVm();
    await server.ensure(vm, ref());
    clock.now += 121_000;
    const runner = new TailnetEgress({ vaultStore, now: () => clock.now, stateFile: file, restoredRestart: "when-probe-fails" });
    let before = vm.events.length;
    expect((await runner.ensure(vm, ref())).proxyReachable).toBe(true);
    expect(vm.events.slice(before)).toEqual(["inspect"]);
    before = vm.events.length;
    await runner.ensure(vm, ref());
    expect(vm.events.slice(before)).toEqual([]);
    // the runner's own check was shared: the next run trusts it
    clock.now += 10_000;
    const next = new TailnetEgress({ vaultStore, now: () => clock.now, stateFile: file, restoredRestart: "when-probe-fails" });
    before = vm.events.length;
    await next.ensure(vm, ref());
    expect(vm.events.slice(before)).toEqual([]);
    // another proxy: the shared check is not for it
    before = vm.events.length;
    await new TailnetEgress({ vaultStore, now: () => clock.now, stateFile: file }).ensure(vm, { ...ref(), proxyHost: "100.101.55.8" });
    expect(vm.events.slice(before)[0]).toBe("inspect");
    // an unhealthy check is never trusted
    const down = healthyVm();
    down.proxyUp = false;
    const downFile = stateFile();
    await new TailnetEgress({ vaultStore, now: () => clock.now, stateFile: downFile }).ensure(down, ref());
    before = down.events.length;
    await new TailnetEgress({ vaultStore, now: () => clock.now, stateFile: downFile }).ensure(down, ref());
    expect(down.events.slice(before)[0]).toBe("inspect");
  });

  test("a resume seen by the server voids the shared check until the server checked again after it", async () => {
    const file = stateFile();
    const clock = { now: 1_000_000 };
    const server = new TailnetEgress({ vaultStore, now: () => clock.now, stateFile: file });
    const vm = healthyVm();
    await server.ensure(vm, ref());
    clock.now += 1_000;
    server.invalidate("nina", { restored: true });
    const runner = new TailnetEgress({ vaultStore, now: () => clock.now, stateFile: file, restoredRestart: "when-probe-fails" });
    let before = vm.events.length;
    await runner.ensure(vm, ref());
    expect(vm.events.slice(before)).toEqual(["inspect"]);
    // the server's re-join after the resume is shared: the next run trusts it
    clock.now += 1_000;
    await server.ensure(vm, ref());
    clock.now += 1_000;
    const later = new TailnetEgress({ vaultStore, now: () => clock.now, stateFile: file, restoredRestart: "when-probe-fails" });
    before = vm.events.length;
    await later.ensure(vm, ref());
    expect(vm.events.slice(before)).toEqual([]);
  });

  test("a runner never restarts a healthy tailscaled after a resume; it does when the probe fails", async () => {
    const clock = { now: 1_000_000 };
    const runner = new TailnetEgress({ vaultStore, now: () => clock.now, restoredRestart: "when-probe-fails" });
    const vm = healthyVm();
    await runner.ensure(vm, ref());
    // the runner itself saw the computer start (it woke it): the node still answers end to end
    runner.invalidate("nina", { restored: true });
    let before = vm.events.length;
    expect((await runner.ensure(vm, ref())).proxyReachable).toBe(true);
    expect(vm.events.slice(before)).toEqual(["inspect"]);
    // the node came back from the snapshot removed from the tailnet: nothing answers, restart
    vm.removed = true;
    runner.invalidate("nina", { restored: true });
    before = vm.events.length;
    expect((await runner.ensure(vm, ref())).proxyReachable).toBe(true);
    expect(vm.events.slice(before)).toContain("restart");
    // the server (default "always") keeps restarting a tailscaled back from a snapshot
    const server = new TailnetEgress({ vaultStore, now: () => clock.now });
    await server.ensure(vm, ref());
    server.invalidate("nina", { restored: true });
    before = vm.events.length;
    await server.ensure(vm, ref());
    expect(vm.events.slice(before)).toContain("restart");
  });

  test("a runner's first browser call with a fresh healthy state file: no tailnet command, only the browser's own", async () => {
    const file = stateFile();
    const egress = { name: "home", url: proxies.home, tailnet: ref("first-call") };
    const vm = healthyVm();
    await new TailnetEgress({ vaultStore, stateFile: file }).ensure(vm, egress.tailnet);
    // this process's runtime reads the same state file (a task run configures it from its .polpo)
    configureTailnetEgress({ vaultStore, stateFile: file });
    tailnetEgress.invalidate();
    resetBrowserEgressSessions();
    try {
      vm.marker = true;
      const tools = createBrowserTools("/vm/work", "first", ["browser_navigate"], "/host/.polpo/browser-profiles/first", "/vm/out", undefined, undefined, { shell: new VmShell(vm), fs: { writeFileBuffer: (p: string, d: Uint8Array) => vm.writeFile(p, d) } as any, egress, headed: false });
      const before = vm.calls.length;
      await tools[0]!.execute("1", { url: "https://example.com" });
      const kinds = vm.calls.slice(before).map((c) => c.kind);
      expect(kinds).not.toContain("inspect");
      expect(kinds).not.toContain("restart");
      expect(kinds.filter((k) => k === "browser")).toHaveLength(1);
    } finally {
      configureTailnetEgress({ stateFile: null });
    }
  });
});
