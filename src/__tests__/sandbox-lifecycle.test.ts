import { afterEach, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSandbox, toolPlacement, type EffectiveSandbox } from "@polpo-ai/core/sandbox";
import { RemoteWorkspace } from "../sandbox/remote.js";
import type { CreateSpec, RemoteAdapter, RemoteDriver, RemoteVmSummary } from "../sandbox/remote-adapters.js";
import { SandboxPool, instanceLabel, poolFilePath, poolKey } from "../sandbox/pool.js";
import { SandboxReaper } from "../sandbox/reaper.js";

const dirs: string[] = [];
const tmp = (prefix: string) => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const all = new Set(["local", "bwrap", "docker", "daytona", "e2b"] as const);
const remoteSandbox = (lifecycle: Partial<NonNullable<EffectiveSandbox["lifecycle"]>> = {}): EffectiveSandbox => ({
  provider: "e2b", network: { mode: "open" }, resources: {}, providerOptions: {}, denied: [],
  lifecycle: { isolation: "reuse", onRelease: "pool", suspendAfterIdleSeconds: 0, deleteAfterStopMinutes: 30, ...lifecycle },
});

/** A VM that is a directory: commands run with bash inside it, absolute tmp paths are prefixed. */
class DirVm implements RemoteDriver {
  suspended = false;
  suspends = 0;
  resumes = 0;
  destroyed = false;
  constructor(readonly vmRoot: string, readonly remoteId: string) {}
  private p(path: string) { return join(this.vmRoot, path); }
  async exec(command: string, opts: { cwd?: string; env?: Record<string, string> }) {
    if (this.suspended) throw new Error("VM is suspended");
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
  async suspend() { this.suspended = true; this.suspends++; }
  async resume() { this.suspended = false; this.resumes++; }
  async destroy() { this.destroyed = true; }
}

/** A provider of DirVms that remembers what it created and deleted. */
class FakeProvider implements RemoteAdapter {
  readonly provider = "e2b" as const;
  vms = new Map<string, DirVm>();
  labels = new Map<string, Record<string, string>>();
  created: CreateSpec[] = [];
  removed: string[] = [];
  private n = 0;
  async create(spec: CreateSpec) {
    const id = `vm-${++this.n}`;
    const vm = new DirVm(tmp("polpo-fakevm-"), id);
    this.vms.set(id, vm);
    this.labels.set(id, spec.labels);
    this.created.push(spec);
    return vm;
  }
  async connect(id: string) {
    const vm = this.vms.get(id);
    if (!vm || vm.destroyed) throw new Error("not found");
    if (vm.suspended) await vm.resume();
    return vm;
  }
  async list(labels: Record<string, string>): Promise<RemoteVmSummary[]> {
    return [...this.vms.values()].filter((vm) => !vm.destroyed && Object.entries(labels).every(([k, v]) => this.labels.get(vm.remoteId)?.[k] === v))
      .map((vm) => ({ remoteId: vm.remoteId, state: vm.suspended ? "paused" : "running", labels: this.labels.get(vm.remoteId)!, createdAt: new Date(Date.now() - 3600_000).toISOString() }));
  }
  async remove(id: string) { const vm = this.vms.get(id); if (vm) vm.destroyed = true; this.removed.push(id); }
}

describe("lifecycle cascade", () => {
  test("instance and agent set reuse/pool; missions and tasks can only tighten", () => {
    const out = resolveSandbox({
      instance: { provider: "e2b", lifecycle: { isolation: "reuse", onRelease: "pool", deleteAfterStopMinutes: 30 } },
      mission: { lifecycle: { deleteAfterStopMinutes: 120 } },
      task: { lifecycle: { isolation: "fresh", onRelease: "destroy" } },
    }, { scope: "task", available: all });
    expect(out.lifecycle).toMatchObject({ isolation: "fresh", onRelease: "destroy", deleteAfterStopMinutes: 30 });
    expect(out.denied.map((d) => `${d.level}.${d.field}`)).toEqual(["mission.lifecycle.deleteAfterStopMinutes"]);
    const loose = resolveSandbox({ agent: { provider: "e2b", lifecycle: { isolation: "fresh" } }, task: { lifecycle: { isolation: "reuse" } } }, { scope: "task", available: all });
    expect(loose.lifecycle?.isolation).toBe("fresh");
  });

  test("chats stay here unless the agent (or instance) opted in to Cowork", () => {
    expect(resolveSandbox({ agent: { provider: "daytona" } }, { scope: "chat", available: all }).provider).not.toBe("daytona");
    expect(resolveSandbox({ agent: { provider: "daytona", chatRemote: true } }, { scope: "chat", available: all }).provider).toBe("daytona");
    expect(resolveSandbox({ instance: { chatRemote: true }, agent: { provider: "e2b" } }, { scope: "chat", available: all }).provider).toBe("e2b");
  });

  test("tool placement", () => {
    expect(toolPlacement("bash")).toBe("sandbox");
    expect(toolPlacement("read")).toBe("sandbox");
    expect(toolPlacement("pdf_read")).toBe("sandbox");
    expect(toolPlacement("http_download")).toBe("sandbox");
    expect(toolPlacement("email_send")).toBe("host");
    expect(toolPlacement("vault_get")).toBe("host");
    expect(toolPlacement("storage_list")).toBe("host");
  });
});

describe("pool", () => {
  test("a run's VM goes back suspended and the same agent reuses it, its working directory reset", async () => {
    const polpoDir = tmp("polpo-dir-");
    const root = tmp("polpo-root-");
    writeFileSync(join(root, "a.txt"), "first");
    const provider = new FakeProvider();
    const mk = (owner: string, lifecycle = {}) => new RemoteWorkspace("e2b", { root, sandbox: remoteSandbox(lifecycle), adapter: provider, pool: { polpoDir, owner, scope: "task" } });

    const events: string[] = [];
    const first = new RemoteWorkspace("e2b", { root, sandbox: remoteSandbox(), adapter: provider, pool: { polpoDir, owner: "dev", scope: "task" }, onEvent: (e) => events.push(e.kind === "ready" ? `ready:${e.source}` : e.kind === "released" ? `released:${e.outcome}` : e.kind) });
    await first.exec("echo leftover > old.txt; mkdir -p node_modules && echo dep > node_modules/dep.txt");
    await first.dispose();
    expect(events).toContain("ready:created");
    expect(events).toContain("released:pooled");
    const vm = provider.vms.get("vm-1")!;
    expect(vm.suspended).toBe(true);
    expect(new SandboxPool(poolFilePath(polpoDir)).list()).toMatchObject([{ remoteId: "vm-1", state: "idle", owner: "dev" }]);

    // same agent: reused, reset (old.txt gone, node_modules kept, fresh context)
    writeFileSync(join(root, "a.txt"), "second");
    const second = mk("dev");
    const r = await second.exec("cat a.txt; ls; cat node_modules/dep.txt");
    expect(provider.created).toHaveLength(1);
    expect(r.stdout).toContain("second");
    expect(r.stdout).not.toContain("old.txt");
    expect(r.stdout).toContain("dep");
    await second.dispose();

    // another agent never gets it
    const other = mk("ops");
    await other.exec("true");
    expect(provider.created).toHaveLength(2);
    await other.dispose();

    // fresh: always new, destroy: deleted at the end and gone from the registry
    const fresh = mk("dev", { isolation: "fresh", onRelease: "destroy" });
    await fresh.exec("true");
    expect(provider.created).toHaveLength(3);
    await fresh.dispose();
    expect(provider.vms.get("vm-3")!.destroyed).toBe(true);
    expect(new SandboxPool(poolFilePath(polpoDir)).list().some((e) => e.remoteId === "vm-3")).toBe(false);
  });

  test("the VM is labelled with the project, the agent and the scope", async () => {
    const polpoDir = tmp("polpo-dir-");
    const provider = new FakeProvider();
    const ws = new RemoteWorkspace("e2b", { root: tmp("polpo-root-"), sandbox: remoteSandbox(), adapter: provider, pool: { polpoDir, owner: "dev", scope: "chat", sessionKey: "s1" } });
    await ws.exec("true");
    expect(provider.created[0]!.labels).toEqual({ polpo: "1", "polpo-instance": instanceLabel(polpoDir), "polpo-agent": "dev", "polpo-scope": "chat" });
    expect(provider.created[0]!.keep).toBe(true);
    await ws.dispose();
  });

  test("concurrent takers never get the same VM", async () => {
    const file = join(tmp("polpo-dir-"), "sandbox-pool.json");
    const pool = new SandboxPool(file);
    const key = poolKey("e2b", remoteSandbox());
    await pool.addLeased({ remoteId: "a", provider: "e2b", key, owner: "dev" });
    await pool.release("a", 30);
    const takes = await Promise.all(Array.from({ length: 6 }, () => new SandboxPool(file).takeIdle("e2b", key, "dev")));
    expect(takes.filter(Boolean)).toHaveLength(1);
  });

  test("network rules are part of the key: a VM is never reused with another rule", () => {
    const open = poolKey("e2b", remoteSandbox());
    const allow = poolKey("e2b", { ...remoteSandbox(), network: { mode: "allowlist", allow: ["github.com"] } });
    expect(open).not.toBe(allow);
  });
});

describe("lease", () => {
  test("suspends while no tool runs and resumes on the next call; measures running time", async () => {
    const provider = new FakeProvider();
    const events: string[] = [];
    const ws = new RemoteWorkspace("e2b", {
      root: tmp("polpo-root-"), sandbox: remoteSandbox({ suspendAfterIdleSeconds: 0.05 } as any), adapter: provider,
      onEvent: (e) => events.push(e.kind),
    });
    await ws.exec("true");
    await new Promise((r) => setTimeout(r, 150));
    const vm = provider.vms.get("vm-1")!;
    expect(vm.suspended).toBe(true);
    const r = await ws.exec("echo again");
    expect(r.stdout.trim()).toBe("again");
    expect(vm.resumes).toBe(1);
    expect(events).toContain("suspended");
    expect(events).toContain("resumed");
    expect(ws.runningTimeMs).toBeGreaterThanOrEqual(0);
    await ws.dispose();
  });
});

describe("reaper", () => {
  test("deletes expired and orphaned VMs, and unknown labelled ones; tops up warm VMs", async () => {
    const polpoDir = tmp("polpo-dir-");
    const provider = new FakeProvider();
    const pool = new SandboxPool(poolFilePath(polpoDir));
    const key = poolKey("e2b", remoteSandbox());
    // expired idle VM
    await provider.create({ sandbox: remoteSandbox(), labels: { "polpo-instance": instanceLabel(polpoDir) }, lifetimeMinutes: 60, keep: true });
    await pool.addLeased({ remoteId: "vm-1", provider: "e2b", key, owner: "dev" });
    await pool.release("vm-1", -1);
    // VM leased by a dead process
    await provider.create({ sandbox: remoteSandbox(), labels: { "polpo-instance": instanceLabel(polpoDir) }, lifetimeMinutes: 60, keep: true });
    await pool.addLeased({ remoteId: "vm-2", provider: "e2b", key, owner: "dev", pid: 999_999_999 });
    // labelled VM nobody knows (a crash between creation and bookkeeping)
    await provider.create({ sandbox: remoteSandbox(), labels: { "polpo-instance": instanceLabel(polpoDir) }, lifetimeMinutes: 60, keep: true });
    // someone else's VM: never touched
    await provider.create({ sandbox: remoteSandbox(), labels: { "polpo-instance": "another-project" }, lifetimeMinutes: 60, keep: true });

    const deleted: string[] = [];
    const reaper = new SandboxReaper({
      polpoDir, settings: () => ({ warm: { e2b: 2 } }), adapter: () => provider, configured: () => ["e2b"],
      isAlive: (pid) => pid !== 999_999_999, onDeleted: (e) => deleted.push(`${e.remoteId}:${e.reason}`),
    });
    await reaper.tick(true);
    expect(deleted).toEqual(expect.arrayContaining(["vm-1:expired", "vm-2:orphan", "vm-3:orphan"]));
    expect(provider.removed).not.toContain("vm-4");
    const warm = pool.list().filter((e) => e.state === "warm");
    expect(warm).toHaveLength(2);
    expect(warm.every((e) => provider.vms.get(e.remoteId)!.suspended)).toBe(true);

    // a later run takes a warm VM instead of creating one
    const before = provider.created.length;
    const ws = new RemoteWorkspace("e2b", { root: tmp("polpo-root-"), sandbox: { ...remoteSandbox(), lifecycle: { ...remoteSandbox().lifecycle!, isolation: "fresh" } }, adapter: provider, pool: { polpoDir, owner: "dev", scope: "task" } });
    const sources: string[] = [];
    (ws as any).opts.onEvent = (e: any) => { if (e.kind === "ready") sources.push(e.source); };
    await ws.exec("true");
    expect(provider.created.length).toBe(before);
    expect(sources).toEqual(["warm"]);
    await ws.dispose();
  });
});

