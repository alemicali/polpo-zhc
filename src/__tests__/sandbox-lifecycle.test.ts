import { afterEach, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeSandboxSettings, resolveSandbox, SandboxVolumeGrantError, toolPlacement, type EffectiveSandbox, type ResolvedSandboxVolume } from "@polpo-ai/core/sandbox";
import { RemoteWorkspace } from "../sandbox/remote.js";
import type { CreateSpec, RemoteAdapter, RemoteDriver, RemoteVmSummary } from "../sandbox/remote-adapters.js";
import { SandboxPool, instanceLabel, poolFilePath, poolKey } from "../sandbox/pool.js";
import { SandboxReaper } from "../sandbox/reaper.js";

const dirs: string[] = [];
const tmp = (prefix: string) => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const all = new Set(["local", "bwrap", "docker", "daytona", "e2b"] as const);
const remoteSandbox = (lifecycle: Partial<NonNullable<EffectiveSandbox["lifecycle"]>> = {}, isolation: EffectiveSandbox["isolation"] = "reuse"): EffectiveSandbox => ({
  provider: "e2b", network: { mode: "open" }, resources: {}, providerOptions: {}, denied: [],
  isolation, lifecycle: { onRelease: "pool", stopAfterIdleMinutes: 5, deleteAfterStopMinutes: 30, ...lifecycle },
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
  fastSuspend = false;
  stopped: string[] = [];
  async suspendById(id: string) { this.stopped.push(id); const vm = this.vms.get(id); if (vm) await vm.suspend(); }
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
  test("isolation and lifecycle: later levels override (open Polpo); destroy resets the times", () => {
    const out = resolveSandbox({
      instance: { provider: "e2b", isolation: "reuse", lifecycle: { onRelease: "pool", deleteAfterStopMinutes: 30 } },
      mission: { lifecycle: { stopAfterIdleMinutes: 10 } },
      task: { isolation: "fresh" },
    }, { scope: "task", available: all });
    expect(out.isolation).toBe("fresh");
    expect(out.lifecycle).toEqual({ onRelease: "pool", stopAfterIdleMinutes: 10, deleteAfterStopMinutes: 30 });
    const destroy = resolveSandbox({ agent: { provider: "e2b", lifecycle: { stopAfterIdleMinutes: 20 } }, task: { lifecycle: { onRelease: "destroy" } } }, { scope: "task", available: all });
    expect(destroy.lifecycle).toEqual({ onRelease: "destroy", stopAfterIdleMinutes: 5, deleteAfterStopMinutes: 30 });
    expect(resolveSandbox({ agent: { provider: "e2b" } }, { scope: "task", available: all }).isolation).toBe("reuse");
    // legacy idleTtlMinutes: stop after it, delete right away
    expect(resolveSandbox({ agent: { provider: "e2b", lifecycle: { idleTtlMinutes: 7 } } }, { scope: "task", available: all }).lifecycle)
      .toEqual({ onRelease: "pool", stopAfterIdleMinutes: 7, deleteAfterStopMinutes: 0 });
  });

  test("volumes: the first level that sets them defines the list, later ones only narrow", () => {
    const out = resolveSandbox({
      agent: { provider: "e2b", volumes: [{ name: "data", access: "read-write" }, { name: "refs" }] },
      task: { volumes: [{ name: "data", writeBack: "manual" }] },
    }, { scope: "task", available: all });
    expect(out.volumes).toEqual([{ name: "data", access: "read-write", writeBack: "manual" }]);
    const ro = resolveSandbox({ agent: { volumes: [{ name: "data", access: "read-only" }] }, task: { volumes: [{ name: "data", access: "read-write" }] } }, { scope: "task", available: all });
    expect(ro.volumes).toEqual([{ name: "data", access: "read-only" }]);
    expect(() => resolveSandbox({ agent: { volumes: [{ name: "data" }] }, mission: { volumes: [{ name: "other" }] } }, { scope: "task", available: all }))
      .toThrow(SandboxVolumeGrantError);
  });

  test("settings saved with the old names still load", () => {
    expect(normalizeSandboxSettings({ lifecycle: { isolation: "fresh", onRelease: "destroy" } })).toEqual({ isolation: "fresh", lifecycle: { onRelease: "destroy" } });
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
  test("a run's VM goes back to the pool and the same agent reuses it, its working directory reset", async () => {
    const polpoDir = tmp("polpo-dir-");
    const root = tmp("polpo-root-");
    writeFileSync(join(root, "a.txt"), "on the host");
    const provider = new FakeProvider();
    const mk = (owner: string, lifecycle = {}, isolation: EffectiveSandbox["isolation"] = "reuse") =>
      new RemoteWorkspace("e2b", { root, sandbox: remoteSandbox(lifecycle, isolation), adapter: provider, pool: { polpoDir, owner, scope: "task" } });

    const events: string[] = [];
    const first = new RemoteWorkspace("e2b", { root, sandbox: remoteSandbox(), adapter: provider, pool: { polpoDir, owner: "dev", scope: "task" }, onEvent: (e) => events.push(e.kind === "ready" ? `ready:${e.source}` : e.kind === "released" ? `released:${e.outcome}` : e.kind) });
    // the working directory starts empty: nothing is copied from the host
    expect((await first.exec("ls")).stdout).not.toContain("a.txt");
    await first.exec("echo leftover > old.txt; mkdir -p node_modules && echo dep > node_modules/dep.txt");
    await first.dispose();
    expect(events).toContain("ready:created");
    expect(events).toContain("released:pooled");
    // the scratch working directory is not copied back
    expect(existsSync(join(root, "old.txt"))).toBe(false);
    const [entry] = new SandboxPool(poolFilePath(polpoDir)).list();
    expect(entry).toMatchObject({ remoteId: "vm-1", state: "idle", owner: "dev", deleteAfterStopMinutes: 30 });
    expect(Date.parse(entry!.stopAt!) - Date.parse(entry!.idleSince!)).toBe(5 * 60_000);

    // same agent: reused, reset (old.txt gone, node_modules kept)
    const second = mk("dev");
    const r = await second.exec("ls; cat node_modules/dep.txt");
    expect(provider.created).toHaveLength(1);
    expect(r.stdout).not.toContain("old.txt");
    expect(r.stdout).toContain("dep");
    await second.dispose();

    // another agent never gets it
    const other = mk("ops");
    await other.exec("true");
    expect(provider.created).toHaveLength(2);
    await other.dispose();

    // fresh: always new; destroy: deleted at the end and gone from the registry
    const fresh = mk("dev", { onRelease: "destroy" }, "fresh");
    await fresh.exec("true");
    expect(provider.created).toHaveLength(3);
    await fresh.dispose();
    expect(provider.vms.get("vm-3")!.destroyed).toBe(true);
    expect(new SandboxPool(poolFilePath(polpoDir)).list().some((e) => e.remoteId === "vm-3")).toBe(false);
  });

  test("shared: concurrent runs use one VM; it waits like an idle VM when the last one leaves", async () => {
    const polpoDir = tmp("polpo-dir-");
    const provider = new FakeProvider();
    const mk = (owner: string) => new RemoteWorkspace("e2b", { root: tmp("polpo-root-"), sandbox: remoteSandbox({}, "shared"), adapter: provider, pool: { polpoDir, owner, scope: "task" } });
    const a = mk("dev");
    const b = mk("ops");
    await a.exec("echo from-a > /tmp/shared-marker-test || true");
    await b.exec("true");
    expect(provider.created).toHaveLength(1);
    const pool = new SandboxPool(poolFilePath(polpoDir));
    expect(pool.list()).toMatchObject([{ state: "shared" }]);
    await a.dispose();
    expect(pool.list()[0]!.holders).toHaveLength(1);
    expect(provider.vms.get("vm-1")!.destroyed).toBe(false);
    await b.dispose();
    expect(pool.list()[0]).toMatchObject({ state: "shared", holders: [] });
    expect(pool.list()[0]!.stopAt).toBeTruthy();
    // a later shared run joins it again
    const c = mk("dev");
    await c.exec("true");
    expect(provider.created).toHaveLength(1);
    await c.dispose();
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
    await pool.release("a", { stopAfterIdleMinutes: 5, deleteAfterStopMinutes: 30 });
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
  test("where suspending is cheap, suspends while no tool runs and resumes on the next call; measures running time", async () => {
    const provider = new FakeProvider();
    provider.fastSuspend = true;
    const events: string[] = [];
    const ws = new RemoteWorkspace("e2b", {
      root: tmp("polpo-root-"), sandbox: remoteSandbox(), adapter: provider, idleSuspendMs: 50,
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

  test("where suspending is slow (Daytona), the VM keeps running between tools", async () => {
    const provider = new FakeProvider();
    const ws = new RemoteWorkspace("e2b", { root: tmp("polpo-root-"), sandbox: remoteSandbox(), adapter: provider });
    await ws.exec("true");
    await new Promise((r) => setTimeout(r, 1700));
    expect(provider.vms.get("vm-1")!.suspends).toBe(0);
    await ws.dispose();
  });
});

describe("volumes in remote VMs", () => {
  /** A stand-in for rclone in the VM: "polpo:<bucket>/<path>" is a directory under $FAKE_S3. */
  const FAKE_RCLONE = `#!/bin/bash
map() { if [[ "$1" == polpo:* ]]; then echo "$FAKE_S3/\${1#polpo:}"; else echo "$1"; fi; }
cmd=$1; shift
case $cmd in
  cat) cat "$(map "$1")" ;;
  copy) src=$(map "$1"); dst=$(map "$2"); mkdir -p "$dst"; [ -d "$src" ] && (cd "$src" && find . -type f ! -name .polpo-volume.json ! -path './.conflicts/*' -exec cp --parents {} "$dst" \\;) ; true ;;
  sync) src=$(map "$1"); dst=$(map "$2"); mkdir -p "$dst"; find "$dst" -mindepth 1 -maxdepth 1 ! -name .polpo-volume.json ! -name .conflicts -exec rm -rf {} +; (cd "$src" && cp -a . "$dst"/) ;;
  rcat) f=$(map "$1"); mkdir -p "$(dirname "$f")"; cat > "$f" ;;
  *) exit 1 ;;
esac
`;
  const saved = { PATH: process.env.PATH, FAKE_S3: process.env.FAKE_S3 };
  afterEach(() => { process.env.PATH = saved.PATH; if (saved.FAKE_S3 === undefined) delete process.env.FAKE_S3; else process.env.FAKE_S3 = saved.FAKE_S3; });

  const setup = () => {
    const bin = tmp("polpo-bin-");
    writeFileSync(join(bin, "rclone"), FAKE_RCLONE, { mode: 0o755 });
    process.env.PATH = `${bin}:${process.env.PATH}`;
    const s3 = tmp("polpo-s3-");
    process.env.FAKE_S3 = s3;
    mkdirSync(join(s3, "bkt", "data"), { recursive: true });
    writeFileSync(join(s3, "bkt", "data", "hello.txt"), "v0");
    const volume = (writeBack: "auto" | "manual" = "auto"): ResolvedSandboxVolume => ({
      name: "data", strategy: "hydrated", mountPath: join(tmpdir(), `polpo-vol-${Math.random().toString(36).slice(2)}`), access: "read-write", writeBack, driver: "rclone",
      remote: { bucket: "bkt", prefix: "data/", credentials: { accessKeyId: "AK", secretAccessKey: "SK" } },
    });
    const revision = () => existsSync(join(s3, "bkt", "data", ".polpo-volume.json")) ? JSON.parse(readFileSync(join(s3, "bkt", "data", ".polpo-volume.json"), "utf8")).revision : 0;
    return { s3, volume, revision };
  };

  test("hydrated: copied in at start, checkpointed on demand, written back at the end with a new revision", async () => {
    const { s3, volume, revision } = setup();
    const provider = new FakeProvider();
    const events: string[] = [];
    const v = volume("manual");
    const ws = new RemoteWorkspace("e2b", { root: tmp("polpo-root-"), volumes: [v], sandbox: remoteSandbox(), adapter: provider, onEvent: (e) => { if (e.kind === "volume") events.push(`${e.step}:${e.revision}`); } });
    expect((await ws.exec(`cat ${v.mountPath}/hello.txt`)).stdout).toBe("v0");
    await ws.exec(`echo v1 > ${v.mountPath}/hello.txt; echo new > ${v.mountPath}/new.txt`);
    await ws.checkpointVolume("data");
    expect(revision()).toBe(1);
    expect(readFileSync(join(s3, "bkt", "data", "new.txt"), "utf8").trim()).toBe("new");
    await expect(ws.checkpointVolume("nope")).rejects.toThrow(/No hydrated read-write volume/);
    // manual write-back: nothing more at the end
    await ws.exec(`echo v2 > ${v.mountPath}/hello.txt`);
    await ws.dispose();
    expect(readFileSync(join(s3, "bkt", "data", "hello.txt"), "utf8").trim()).toBe("v1");
    expect(events).toEqual(["prepared:0", "checkpointed:1"]);
  });

  test("hydrated: a concurrent writer produces a conflict copy, not a loss", async () => {
    const { s3, volume, revision } = setup();
    const provider = new FakeProvider();
    const conflicts: string[] = [];
    const a = new RemoteWorkspace("e2b", { root: tmp("polpo-root-"), volumes: [volume()], sandbox: remoteSandbox(), adapter: provider });
    const bVol = volume();
    const b = new RemoteWorkspace("e2b", { root: tmp("polpo-root-"), volumes: [bVol], sandbox: remoteSandbox(), adapter: provider, onEvent: (e) => { if (e.kind === "volume" && e.step === "conflict") conflicts.push(e.message ?? ""); } });
    await a.exec("true");
    await b.exec(`echo from-b > ${bVol.mountPath}/hello.txt`);
    await a.exec(`echo from-a > ${(a as any).opts.volumes[0].mountPath}/hello.txt`);
    await a.dispose();
    expect(revision()).toBe(1);
    await b.dispose();
    expect(revision()).toBe(1);
    expect(readFileSync(join(s3, "bkt", "data", "hello.txt"), "utf8").trim()).toBe("from-a");
    expect(readFileSync(join(s3, "bkt", "data", ".conflicts", b.id, "hello.txt"), "utf8").trim()).toBe("from-b");
    expect(conflicts[0]).toMatch(/changed elsewhere/);
  });

  test("read-only hydrated volumes are never written back", async () => {
    const { s3, volume, revision } = setup();
    const v = { ...volume(), access: "read-only" as const, writeBack: undefined };
    const ws = new RemoteWorkspace("e2b", { root: tmp("polpo-root-"), volumes: [v], sandbox: remoteSandbox(), adapter: new FakeProvider() });
    const r = await ws.exec(`echo x > ${v.mountPath}/hello.txt`);
    expect(r.exitCode).not.toBe(0);
    await ws.dispose();
    expect(revision()).toBe(0);
    expect(readFileSync(join(s3, "bkt", "data", "hello.txt"), "utf8")).toBe("v0");
  });
});

describe("reaper", () => {
  test("stops idle pooled VMs, deletes them later; deletes orphaned and unknown labelled VMs; tops up warm VMs", async () => {
    const polpoDir = tmp("polpo-dir-");
    const provider = new FakeProvider();
    const pool = new SandboxPool(poolFilePath(polpoDir));
    const key = poolKey("e2b", remoteSandbox());
    // idle VM past its stop time, deleted right after stopping
    await provider.create({ sandbox: remoteSandbox(), labels: { "polpo-instance": instanceLabel(polpoDir) }, lifetimeMinutes: 60, keep: true });
    await pool.addLeased({ remoteId: "vm-1", provider: "e2b", key, owner: "dev" });
    await pool.release("vm-1", { stopAfterIdleMinutes: -1, deleteAfterStopMinutes: 0 });
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
    // first pass: stopped (deleteAt set); the next pass deletes it
    expect(provider.stopped).toContain("vm-1");
    expect(deleted).toEqual(expect.arrayContaining(["vm-2:orphan", "vm-3:orphan"]));
    await reaper.tick(true);
    expect(deleted).toContain("vm-1:expired");
    expect(provider.removed).not.toContain("vm-4");
    const warm = pool.list().filter((e) => e.state === "warm");
    expect(warm).toHaveLength(2);
    expect(warm.every((e) => provider.vms.get(e.remoteId)!.suspended)).toBe(true);

    // a later run takes a warm VM instead of creating one
    const before = provider.created.length;
    const ws = new RemoteWorkspace("e2b", { root: tmp("polpo-root-"), sandbox: remoteSandbox({}, "fresh"), adapter: provider, pool: { polpoDir, owner: "dev", scope: "task" } });
    const sources: string[] = [];
    (ws as any).opts.onEvent = (e: any) => { if (e.kind === "ready") sources.push(e.source); };
    await ws.exec("true");
    expect(provider.created.length).toBe(before);
    expect(sources).toEqual(["warm"]);
    await ws.dispose();
  });
});

