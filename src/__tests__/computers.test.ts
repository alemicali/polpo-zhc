import { afterEach, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  COMPUTER_LABEL, agentEgressName, computerContext, normalizeSandboxSettings, parseComputer, parseComputers, resolveSandbox,
  type ComputerConfig, type EffectiveSandbox,
} from "@polpo-ai/core/sandbox";
import { ComputerManager, computerStatusOf, uptimeMinutes } from "../sandbox/computers.js";
import { RemoteWorkspace } from "../sandbox/remote.js";
import type { CreateSpec, RemoteAdapter, RemoteDriver, RemoteVmSummary } from "../sandbox/remote-adapters.js";
import { SandboxReaper } from "../sandbox/reaper.js";

const dirs: string[] = [];
const tmp = (prefix: string) => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const all = new Set(["local", "bwrap", "docker", "daytona", "e2b"] as const);

const nina: ComputerConfig = { id: "nina", name: "Nina", kind: "daytona", lifecycle: { idleStopMinutes: 15, autoArchiveDays: 7 } };
const box: ComputerConfig = { id: "box", name: "Box", kind: "e2b", network: { mode: "allowlist", allow: ["example.com"] } };

/** A Daytona-like machine that is a directory: started or stopped, commands run with bash inside. */
class DirVm implements RemoteDriver {
  state: "started" | "stopped" | "archived" = "started";
  destroyed = false;
  constructor(readonly vmRoot: string, readonly remoteId: string) {}
  private p(path: string) { return join(this.vmRoot, path); }
  async exec(command: string, opts: { cwd?: string; env?: Record<string, string> }) {
    if (this.state !== "started" || this.destroyed) throw new Error("machine not running");
    const rewritten = command.replaceAll(tmpdir() + "/", this.p(tmpdir()) + "/");
    mkdirSync(this.p(tmpdir()), { recursive: true });
    try {
      const stdout = execFileSync("bash", ["-c", rewritten], { cwd: opts.cwd && existsSync(this.p(opts.cwd)) ? this.p(opts.cwd) : this.vmRoot, env: { ...process.env, ...opts.env }, encoding: "utf8" });
      return { exitCode: 0, stdout, stderr: "" };
    } catch (err: any) {
      return { exitCode: err.status ?? 1, stdout: String(err.stdout ?? ""), stderr: String(err.stderr ?? "") || String(err.message) };
    }
  }
  async readFile(path: string) { return new Uint8Array(readFileSync(this.p(path))); }
  async writeFile(path: string, data: Uint8Array) { mkdirSync(join(this.p(path), ".."), { recursive: true }); writeFileSync(this.p(path), data); }
  async suspend() { this.state = "stopped"; }
  async resume() { this.state = "started"; }
  keepAlives = 0;
  async keepAlive() { this.keepAlives++; }
  async destroy() { this.destroyed = true; }
}

class FakeDaytona implements RemoteAdapter {
  readonly provider = "daytona" as const;
  readonly fastSuspend = false;
  vms = new Map<string, DirVm>();
  labels = new Map<string, Record<string, string>>();
  created: CreateSpec[] = [];
  removed: string[] = [];
  starts = 0;
  suspended: string[] = [];
  createDelayMs = 0;
  private n = 0;
  async create(spec: CreateSpec) {
    if (this.createDelayMs) await new Promise((r) => setTimeout(r, this.createDelayMs));
    const id = `dt-${++this.n}`;
    const vm = new DirVm(tmp("polpo-computer-vm-"), id);
    this.vms.set(id, vm);
    this.labels.set(id, spec.labels);
    this.created.push(spec);
    return vm;
  }
  async connect(id: string) {
    const vm = this.vms.get(id);
    if (!vm || vm.destroyed) throw new Error("not found");
    if (vm.state !== "started") { this.starts++; vm.state = "started"; }
    return vm;
  }
  async list(labels: Record<string, string>): Promise<RemoteVmSummary[]> {
    return [...this.vms.values()].filter((vm) => !vm.destroyed && Object.entries(labels).every(([k, v]) => this.labels.get(vm.remoteId)?.[k] === v))
      .map((vm) => ({ remoteId: vm.remoteId, state: vm.state, labels: this.labels.get(vm.remoteId)!, createdAt: new Date(Date.now() - 3600_000).toISOString() }));
  }
  async remove(id: string) { const vm = this.vms.get(id); if (vm) vm.destroyed = true; this.removed.push(id); }
  async suspendById(id: string) { this.suspended.push(id); const vm = this.vms.get(id); if (vm) vm.state = "stopped"; }
}

const computerSandbox = (c: ComputerConfig = nina): EffectiveSandbox =>
  resolveSandbox({}, { scope: "task", available: all, computers: { computers: [c], defaultComputer: c.id, allowed: [c.id] } });

function manager(adapter: RemoteAdapter, clock?: { now: number }) {
  const polpoDir = tmp("polpo-dir-");
  return new ComputerManager(polpoDir, { adapter: () => adapter, ...(clock ? { now: () => clock.now } : {}) });
}

// ── model ────────────────────────────────────────────────────────────────

describe("computer config", () => {
  test("valid computers parse; defaults and reserved ids", () => {
    expect(parseComputer({ id: "nina", kind: "daytona" })).toEqual({ id: "nina", name: "nina", kind: "daytona" });
    expect(parseComputer({ id: "box", name: "Box", kind: "e2b", template: "polpo-runner", lifecycle: { idleStopMinutes: 30 }, network: { mode: "deny" } }))
      .toEqual({ id: "box", name: "Box", kind: "e2b", template: "polpo-runner", lifecycle: { idleStopMinutes: 30 }, network: { mode: "deny" } });
    expect(() => parseComputer({ id: "host", kind: "daytona" })).toThrow(/reserved/);
    expect(() => parseComputer({ id: "Nina!", kind: "daytona" })).toThrow(/slug/);
    expect(() => parseComputer({ id: "x", kind: "vm" })).toThrow(/kind/);
    expect(() => parseComputer({ id: "x", kind: "e2b", snapshot: "s" })).toThrow(/Daytona/);
    expect(() => parseComputer({ id: "x", kind: "daytona", image: "a", snapshot: "b" })).toThrow(/not both/);
    expect(() => parseComputer({ id: "x", kind: "e2b", lifecycle: { autoArchiveDays: 3 } })).toThrow(/Daytona/);
    expect(() => parseComputer({ id: "x", kind: "daytona", lifecycle: { idleStopMinutes: 0 } })).toThrow(/idleStopMinutes/);
    // egress: host computers only for now (remote egress through a home proxy is phase 2)
    expect(parseComputer({ id: "home", kind: "host", egress: "home" }).egress).toBe("home");
    expect(() => parseComputer({ id: "x", kind: "daytona", egress: "home" })).toThrow(/host/);
    expect(() => parseComputers([{ id: "a", kind: "e2b" }, { id: "a", kind: "e2b" }])).toThrow(/twice/);
  });

  test("a task's sandbox may name a computer", () => {
    expect(normalizeSandboxSettings({ computer: "ephemeral" })).toEqual({ computer: "ephemeral" });
    expect(normalizeSandboxSettings({ computer: "nina" })).toEqual({ computer: "nina" });
  });

  test("egress: the agent's own, else its host computer's", () => {
    const settings = { computers: [{ id: "home", name: "Home", kind: "host", egress: "home" }, nina] };
    expect(agentEgressName({ defaultComputer: "home" }, settings)).toBe("home");
    expect(agentEgressName({ defaultComputer: "home", browserEgress: "office" }, settings)).toBe("office");
    expect(agentEgressName({ defaultComputer: "nina" }, settings)).toBeUndefined();
  });
});

// ── precedence ───────────────────────────────────────────────────────────

describe("which machine a run uses", () => {
  const settings = { computers: [nina, box] };
  const agent = { computers: ["box"], defaultComputer: "nina" };
  const ctx = computerContext(agent, settings);

  test("the agent's default computer, for chats and tasks alike", () => {
    const task = resolveSandbox({ instance: { provider: "bwrap" } }, { scope: "task", available: all, computers: ctx });
    expect(task.provider).toBe("daytona");
    expect(task.computer?.id).toBe("nina");
    // no chatRemote needed: assigning a computer is the opt-in
    const chat = resolveSandbox({ instance: { provider: "bwrap" } }, { scope: "chat", available: all, computers: ctx });
    expect(chat.provider).toBe("daytona");
    expect(chat.computer?.id).toBe("nina");
  });

  test("no default (or host): the cascade as before", () => {
    const none = resolveSandbox({ agent: { provider: "docker" } }, { scope: "task", available: all, computers: computerContext({}, settings) });
    expect(none.provider).toBe("docker");
    expect(none.computer).toBeUndefined();
    const host = resolveSandbox({ agent: { provider: "docker" } }, { scope: "task", available: all, computers: computerContext({ defaultComputer: "host" }, settings) });
    expect(host.provider).toBe("docker");
    expect(host.computer).toBeUndefined();
  });

  test("a task or mission asking for an ephemeral sandbox gets one", () => {
    for (const task of [{ computer: "ephemeral" }, { provider: "e2b" as const }, { isolation: "fresh" as const }]) {
      const out = resolveSandbox({ instance: { provider: "bwrap" }, task }, { scope: "task", available: all, computers: ctx });
      expect(out.computer).toBeUndefined();
    }
    expect(resolveSandbox({ instance: { provider: "bwrap" }, mission: { computer: "ephemeral" } }, { scope: "task", available: all, computers: ctx }).computer).toBeUndefined();
  });

  test("a task may name another of the agent's computers; one it may not use is reported", () => {
    expect(resolveSandbox({ task: { computer: "box" } }, { scope: "task", available: all, computers: ctx }).computer?.id).toBe("box");
    const other = resolveSandbox({ task: { computer: "zed" } }, { scope: "task", available: all, computers: ctx });
    expect(other.computer?.id).toBe("nina");
    expect(other.denied).toContainEqual({ level: "task", field: "computer", requested: "zed", applied: "nina" });
    expect(resolveSandbox({ task: { computer: "host" } }, { scope: "task", available: all, computers: ctx }).computer).toBeUndefined();
  });

  test("a stricter network than the computer's: an ephemeral sandbox with it", () => {
    const strict = resolveSandbox({ task: { network: { mode: "deny" } } }, { scope: "task", available: all, computers: ctx });
    expect(strict.computer).toBeUndefined();
    expect(strict.network.mode).toBe("deny");
    // the same or looser: the computer
    const boxCtx = computerContext({ defaultComputer: "box" }, settings);
    expect(resolveSandbox({ task: { network: { mode: "allowlist", allow: ["example.com"] } } }, { scope: "task", available: all, computers: boxCtx }).computer?.id).toBe("box");
  });

  test("the computer's image, network and volumes; the instance's provider options", () => {
    const withImage: ComputerConfig = { ...nina, image: "node:22", resources: { cpus: 2 }, volumes: [{ name: "data" }] };
    const out = resolveSandbox(
      { instance: { network: { mode: "allowlist", allow: ["a.com"] }, providers: { daytona: { snapshot: "polpo-runner", target: "eu" } } } },
      { scope: "task", available: all, computers: { computers: [withImage], defaultComputer: "nina", allowed: ["host", "nina"] } },
    );
    expect(out.providerOptions).toEqual({ target: "eu", image: "node:22" });
    expect(out.network).toEqual({ mode: "allowlist", allow: ["a.com"] });
    expect(out.resources).toEqual({ cpus: 2 });
    expect(out.volumes).toEqual([{ name: "data" }]);
  });

  test("a provider without an API key here: the cascade (and its fallback)", () => {
    const out = resolveSandbox({ instance: { provider: "bwrap" } }, { scope: "task", available: new Set(["local", "bwrap"]), computers: ctx });
    expect(out.provider).toBe("bwrap");
    expect(out.computer).toBeUndefined();
  });

  test("a host computer keeps the cascade's provider and brings its network", () => {
    const home: ComputerConfig = { id: "home", name: "Home", kind: "host", network: { mode: "deny" } };
    const out = resolveSandbox({ agent: { provider: "bwrap", network: { mode: "open" } } }, { scope: "task", available: all, computers: { computers: [home], defaultComputer: "home", allowed: ["host", "home"] } });
    expect(out.provider).toBe("bwrap");
    expect(out.network.mode).toBe("deny");
    expect(out.computer?.id).toBe("home");
  });
});

// ── lifecycle ────────────────────────────────────────────────────────────

describe("computer lifecycle", () => {
  test("provider states map to statuses", () => {
    expect(computerStatusOf("daytona", "started")).toBe("running");
    expect(computerStatusOf("daytona", "archived")).toBe("archived");
    expect(computerStatusOf("daytona", "pulling_snapshot")).toBe("creating");
    expect(computerStatusOf("daytona", "destroyed")).toBe("missing");
    expect(computerStatusOf("e2b", "paused")).toBe("paused");
    expect(computerStatusOf("e2b", undefined)).toBe("missing");
  });

  test("created once with its label, never ephemeral; found again by label afterwards", async () => {
    const provider = new FakeDaytona();
    const m = manager(provider);
    const first = await m.ensure(nina, computerSandbox());
    expect(provider.created).toHaveLength(1);
    const spec = provider.created[0]!;
    expect(spec.labels[COMPUTER_LABEL]).toBe(m.labelValue("nina"));
    expect(spec.labels["polpo-instance"]).toBeUndefined(); // the pool reaper never sees it
    expect(spec.persistent).toEqual({ idleStopMinutes: 15, autoArchiveDays: 7 });
    expect(spec.keep).toBe(true);
    // a new manager (another process, the pool file gone): found by its label, not created again
    const other = new ComputerManager(m.polpoDir, { adapter: () => provider });
    const again = await other.ensure(nina, computerSandbox());
    expect(again.remoteId).toBe(first.remoteId);
    expect(provider.created).toHaveLength(1);
    expect(other.live("nina").status).toBe("running");
  });

  test("a stopped or archived machine is started, not recreated", async () => {
    const provider = new FakeDaytona();
    const m = manager(provider);
    const d = await m.ensure(nina, computerSandbox());
    provider.vms.get(d.remoteId)!.state = "archived";
    await m.ensure(nina, computerSandbox());
    expect(provider.starts).toBe(1);
    expect(provider.created).toHaveLength(1);
    expect(provider.vms.get(d.remoteId)!.state).toBe("started");
  });

  test("concurrent first uses create one machine (create/start serialized per computer)", async () => {
    const provider = new FakeDaytona();
    provider.createDelayMs = 50;
    const m = manager(provider);
    const drivers = await Promise.all([1, 2, 3, 4].map(() => m.ensure(nina, computerSandbox())));
    expect(provider.created).toHaveLength(1);
    expect(new Set(drivers.map((d) => d.remoteId)).size).toBe(1);
  });

  test("commands run concurrently on an attached computer", async () => {
    const provider = new FakeDaytona();
    const m = manager(provider);
    const driver = await m.attach(nina, computerSandbox());
    const vm = provider.vms.get(driver.remoteId)!;
    let inFlight = 0;
    let most = 0;
    vm.exec = async (command: string) => {
      most = Math.max(most, ++inFlight);
      await new Promise((r) => setTimeout(r, 30));
      inFlight--;
      return { exitCode: 0, stdout: command, stderr: "" };
    };
    const results = await Promise.all(["a", "b", "c"].map((c) => driver.exec(c, {})));
    expect(results.map((r) => r.stdout)).toEqual(["a", "b", "c"]);
    expect(most).toBe(3);
  });

  test("idle: stopped after idleStopMinutes without use, never deleted; used: kept warm", async () => {
    const provider = new FakeDaytona();
    const clock = { now: Date.parse("2026-11-21T10:00:00Z") };
    const m = manager(provider, clock);
    const driver = await m.attach(nina, computerSandbox());
    await driver.exec("true", {});
    expect(provider.vms.get(driver.remoteId)!.keepAlives).toBeGreaterThan(0);

    clock.now += 10 * 60_000;
    await m.idleTick([nina]);
    expect(provider.suspended).toEqual([]);

    await driver.exec("true", {}); // used again: the idle time starts over
    await new Promise((r) => setTimeout(r, 20)); // the touch is written in the background
    clock.now += 10 * 60_000;
    await m.idleTick([nina]);
    expect(provider.suspended).toEqual([]);

    clock.now += 6 * 60_000;
    await m.idleTick([nina]);
    expect(provider.suspended).toEqual([driver.remoteId]);
    expect(provider.removed).toEqual([]);
    expect(m.live("nina").status).toBe("stopped");
    // uptime counted while it ran (26 minutes), not while stopped
    clock.now += 60 * 60_000;
    expect(m.live("nina").uptimeMinutes).toBe(26);

    // the next command finds it stopped and starts it again (same machine)
    clock.now += 2 * 60_000;
    const r = await driver.exec("echo back", {});
    expect(r.stdout.trim()).toBe("back");
    expect(provider.created).toHaveLength(1);
    expect(provider.starts).toBe(1);
  });

  test("the pool reaper never deletes a computer's machine", async () => {
    const provider = new FakeDaytona();
    const m = manager(provider);
    const d = await m.ensure(nina, computerSandbox());
    // even labelled with the instance (as an older build might have), a computer is skipped
    provider.labels.get(d.remoteId)!["polpo-instance"] = "x";
    const reaper = new SandboxReaper({ polpoDir: m.polpoDir, settings: () => undefined, adapter: () => provider, configured: () => ["daytona"], now: () => Date.now() + 3600_000 });
    (reaper as any).instance = "x";
    await reaper.reconcile();
    expect(provider.removed).toEqual([]);
  });

  test("stop, start, restart; reset deletes and recreates; delete removes the machine", async () => {
    const provider = new FakeDaytona();
    const m = manager(provider);
    const changes: string[] = [];
    m.onChange = (id, live) => changes.push(`${id}:${live.status}`);
    await m.start(nina, computerSandbox());
    expect(changes).toEqual(["nina:creating", "nina:running"]);
    expect((await m.stop(nina)).status).toBe("stopped");
    expect((await m.start(nina, computerSandbox())).status).toBe("running");
    const restarted = await m.restart(nina, computerSandbox());
    expect(restarted.status).toBe("running");
    expect(provider.created).toHaveLength(1);
    const before = restarted.remoteId;
    const reset = await m.reset(nina, computerSandbox());
    expect(provider.removed).toEqual([before]);
    expect(reset.remoteId).not.toBe(before);
    expect(provider.created).toHaveLength(2);
    await m.delete(nina);
    expect(provider.removed).toEqual([before, reset.remoteId]);
    expect(m.read().nina).toBeUndefined();
    expect((await m.refresh(nina)).status).toBe("missing");
  });

  test("uptime", () => {
    expect(uptimeMinutes({ uptimeMs: 90 * 60_000, status: "stopped" })).toBe(90);
    expect(uptimeMinutes({ uptimeMs: 0, status: "running", runningSince: new Date(1000).toISOString() }, 1000 + 30 * 60_000)).toBe(30);
  });
});

// ── workspaces on a computer ─────────────────────────────────────────────

describe("runs on a computer", () => {
  test("the working directory is kept between runs; the machine is never destroyed by a run", async () => {
    const provider = new FakeDaytona();
    const m = manager(provider);
    const root = tmp("polpo-root-");
    const sandbox = computerSandbox();
    const events: string[] = [];
    const open = () => new RemoteWorkspace("daytona", {
      root, sandbox, computers: m, pool: { polpoDir: m.polpoDir, owner: "sitoinchat", scope: "task" },
      onEvent: (e) => events.push(e.kind === "ready" ? `ready:${e.source}` : e.kind === "released" ? `released:${e.outcome}` : e.kind),
    });
    const first = open();
    await first.exec("echo hello > notes.txt && mkdir -p site && echo x > site/index.html");
    const id = first.remoteId;
    await first.dispose();
    expect(provider.vms.get(id!)!.destroyed).toBe(false);

    const second = open();
    const r = await second.exec("cat notes.txt site/index.html");
    expect(r.stdout).toBe("hello\nx\n");
    expect(second.remoteId).toBe(id);
    await second.dispose();
    expect(provider.created).toHaveLength(1);
    expect(provider.removed).toEqual([]);
    expect(events.filter((e) => e.startsWith("ready") || e.startsWith("released"))).toEqual(["ready:computer", "released:kept", "ready:computer", "released:kept"]);
  });

  test("a chat and a task share the computer at the same time", async () => {
    const provider = new FakeDaytona();
    const m = manager(provider);
    const root = tmp("polpo-root-");
    const sandbox = computerSandbox();
    const chat = new RemoteWorkspace("daytona", { root, sandbox, computers: m, pool: { polpoDir: m.polpoDir, owner: "sitoinchat", scope: "chat", sessionKey: "s1" }, syncEachExec: true });
    const task = new RemoteWorkspace("daytona", { root, sandbox, computers: m, pool: { polpoDir: m.polpoDir, owner: "sitoinchat", scope: "task" } });
    await Promise.all([chat.exec("echo from-chat > a.txt"), task.exec("echo from-task > b.txt")]);
    expect((await task.exec("cat a.txt b.txt")).stdout).toBe("from-chat\nfrom-task\n");
    await chat.dispose();
    expect((await task.exec("cat a.txt")).stdout).toBe("from-chat\n");
    await task.dispose();
    expect(provider.created).toHaveLength(1);
  });
});
