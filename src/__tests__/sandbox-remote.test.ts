import { afterEach, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RemoteWorkspace, type RemoteDriver } from "../sandbox/remote.js";
import type { RemoteAdapter, RemoteVmSummary } from "../sandbox/remote-adapters.js";
import { WorkspaceFileSystem } from "../sandbox/workspace-fs.js";
import {
  configureRemoteProviders, configuredRemoteProviders, remoteProviderCredentials, remoteProviderStatus,
} from "../sandbox/remote-providers.js";
import { availableProviders, createWorkspace, isRemoteWorkspace } from "../sandbox/manager.js";

const sandbox = { provider: "e2b" as const, network: { mode: "open" as const }, resources: {}, providerOptions: {}, denied: [] };

/** A "VM" that is a directory on this machine: commands run with bash, paths are prefixed. */
class DirDriver implements RemoteDriver {
  destroyed = false;
  suspended = false;
  suspends = 0;
  resumes = 0;
  backTarball?: Uint8Array;
  constructor(readonly vmRoot: string, readonly remoteId = "fake-vm") {}
  async suspend() { this.suspended = true; this.suspends++; }
  async resume() { this.suspended = false; this.resumes++; }
  private p(path: string) { return join(this.vmRoot, path); }
  async exec(command: string, opts: { cwd?: string; env?: Record<string, string> }) {
    // run inside the fake VM: rewrite absolute paths of the test's tmp dir to the VM's copy
    const rewritten = command.replaceAll(tmpdir() + "/", this.p(tmpdir()) + "/");
    try {
      const stdout = execFileSync("bash", ["-c", rewritten], { cwd: opts.cwd ? this.p(opts.cwd) : this.vmRoot, env: { ...process.env, ...opts.env }, encoding: "utf8" });
      return { exitCode: 0, stdout, stderr: "" };
    } catch (err: any) {
      return { exitCode: err.status ?? 1, stdout: String(err.stdout ?? ""), stderr: String(err.stderr ?? "") || String(err.message) };
    }
  }
  async readFile(path: string) {
    if (this.backTarball && path.includes(".polpo-back-")) return this.backTarball;
    return new Uint8Array(readFileSync(this.p(path)));
  }
  async writeFile(path: string, data: Uint8Array) {
    mkdirSync(join(this.p(path), ".."), { recursive: true });
    writeFileSync(this.p(path), data);
  }
  async destroy() { this.destroyed = true; }
}

/** An adapter that always hands out the same driver. */
function singleAdapter(driver: DirDriver): RemoteAdapter {
  return {
    provider: "e2b",
    fastSuspend: false,
    suspendById: async () => { await driver.suspend(); },
    create: async () => driver,
    connect: async () => { await driver.resume(); return driver; },
    list: async () => [],
    remove: async () => { driver.destroyed = true; },
  };
}
const dirs: string[] = [];
const tmp = (prefix: string) => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("remote workspace", () => {
  test("the working directory starts empty; read-only context goes over without ignored files; only the output directory comes back", async () => {
    const root = tmp("polpo-remote-root-");
    writeFileSync(join(root, "project.txt"), "stays here");
    const skills = tmp("polpo-remote-skills-");
    writeFileSync(join(skills, "keep.txt"), "keep");
    writeFileSync(join(skills, ".gitignore"), "secret.env\n");
    writeFileSync(join(skills, "secret.env"), "TOKEN=x");
    mkdirSync(join(skills, "node_modules", "dep"), { recursive: true });
    writeFileSync(join(skills, "node_modules", "dep", "index.js"), "x");
    execFileSync("git", ["init", "-q"], { cwd: skills }); // --exclude-vcs-ignores reads .gitignore in a repo
    const out = tmp("polpo-remote-out-");
    const vm = tmp("polpo-remote-vm-");
    const driver = new DirDriver(vm);
    const warnings: string[] = [];
    const ws = new RemoteWorkspace("e2b", { root, readable: [skills], writable: [out], sandbox, adapter: singleAdapter(driver), onEvent: (e) => { if (e.kind === "warning") warnings.push(e.message); } });

    expect((await ws.exec(`ls -a ${root}`)).stdout).not.toContain("project.txt");
    const r = await ws.exec(`ls -a ${skills}`);
    expect(r.stdout).toContain("keep.txt");
    expect(r.stdout).not.toContain("secret.env");
    expect(r.stdout).not.toContain("node_modules");

    // the VM answers the sync-back with a deliverable in the output directory: it lands here
    const staging = tmp("polpo-remote-staging-");
    mkdirSync(join(staging, out.slice(1)), { recursive: true });
    writeFileSync(join(staging, out.slice(1), "report.md"), "report");
    driver.backTarball = new Uint8Array(execFileSync("tar", ["-czf", "-", "-C", staging, `${out.slice(1)}/report.md`]));
    await ws.syncNow();
    expect(readFileSync(join(out, "report.md"), "utf8")).toBe("report");

    // a malicious VM answers with a tarball that writes outside the output directory
    const evil = tmp("polpo-remote-evil-");
    mkdirSync(join(evil, "etc"), { recursive: true });
    writeFileSync(join(evil, "etc", "evil"), "x");
    driver.backTarball = new Uint8Array(execFileSync("tar", ["-czf", "-", "-C", evil, "etc/evil"]));
    await ws.dispose();
    expect(warnings.join(" ")).toMatch(/outside the writable paths/);
    expect(existsSync("/etc/evil")).toBe(false);
    expect(existsSync(join(root, "project.txt"))).toBe(true);
    expect(driver.destroyed).toBe(true);
  });

  test("the file tools' FileSystem goes through the workspace", async () => {
    const root = tmp("polpo-remote-root-");
    const vm = tmp("polpo-remote-vm-");
    const ws = new RemoteWorkspace("e2b", { root, sandbox, adapter: singleAdapter(new DirDriver(vm)) });
    const fs = new WorkspaceFileSystem(ws);
    await fs.writeFile(join(root, "a", "b.txt"), "hello");
    expect(await fs.readFile(join(root, "a", "b.txt"))).toBe("hello");
    expect(await fs.exists(join(root, "a", "b.txt"))).toBe(true);
    expect(await fs.exists(join(root, "nope"))).toBe(false);
    expect((await fs.stat(join(root, "a"))).isDirectory).toBe(true);
    expect(await fs.readdir(join(root, "a"))).toEqual(["b.txt"]);
    await fs.rename(join(root, "a", "b.txt"), join(root, "c.txt"));
    expect(await fs.readFile(join(root, "c.txt"))).toBe("hello");
    await expect(fs.stat(join(root, "a", "b.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    // nothing was written on this machine: the files live in the "VM"
    expect(existsSync(join(root, "c.txt"))).toBe(false);
    await ws.dispose();
  });
});

describe("remote provider credentials", () => {
  // A vault with one agent's entries; the providers reference them (owner + service).
  const entries = new Map<string, any>();
  const vault = {
    get: async (owner: string, service: string) => entries.get(`${owner}/${service}`),
  } as any;
  let providers: Record<string, unknown> = {};
  afterEach(() => configureRemoteProviders(undefined, () => undefined));

  test("the key comes from the referenced vault entry, is never returned, and makes the provider available", async () => {
    configureRemoteProviders(vault, () => providers);
    expect(configuredRemoteProviders()).toEqual([]);
    expect(availableProviders().has("daytona")).toBe(false);

    // chosen, but the entry does not exist yet: configured, no key found
    providers = { daytona: { credential: { owner: "alice", service: "daytona" }, target: "eu" } };
    expect(availableProviders().has("daytona")).toBe(true);
    expect(await remoteProviderCredentials("daytona")).toBeUndefined();
    let status = (await remoteProviderStatus()).find((p) => p.id === "daytona")!;
    expect(status).toMatchObject({ configured: true, keyFound: false, target: "eu" });

    // any common key name works ("API_KEY" → apiKey)
    entries.set("alice/daytona", { type: "api_key", credentials: { API_KEY: "dtn_secret" } });
    status = (await remoteProviderStatus()).find((p) => p.id === "daytona")!;
    expect(status).toMatchObject({ configured: true, keyFound: true, credential: { owner: "alice", service: "daytona" } });
    expect(JSON.stringify(await remoteProviderStatus())).not.toContain("dtn_secret");

    providers = { daytona: { credential: { owner: "alice", service: "daytona" }, apiUrl: "https://example.test/api", target: "eu" } };
    expect(await remoteProviderCredentials("daytona")).toEqual({ apiKey: "dtn_secret", apiUrl: "https://example.test/api", target: "eu" });
    const ws = createWorkspace({ ...sandbox, provider: "daytona" }, { root: tmpdir() });
    expect(isRemoteWorkspace(ws)).toBe(true);

    // disconnect: the setting is removed, the vault entry stays
    providers = {};
    expect(availableProviders().has("daytona")).toBe(false);
    expect(entries.has("alice/daytona")).toBe(true);
  });

  test("system \"$\" owners and malformed references are ignored", async () => {
    entries.set("$sandbox/sandbox-provider:e2b", { credentials: { apiKey: "e2b_secret" } });
    providers = { e2b: { credential: { owner: "$sandbox", service: "sandbox-provider:e2b" } }, daytona: { credential: "alice/daytona" } };
    configureRemoteProviders(vault, () => providers);
    expect(configuredRemoteProviders()).toEqual([]);
    expect(await remoteProviderCredentials("e2b")).toBeUndefined();
  });
});

describe("task runner processes", () => {
  test("configured from the resolved sandbox's provider options and the vault (as runner.ts does)", async () => {
    const { resolveSandbox } = await import("@polpo-ai/core/sandbox");
    const settings = { provider: "daytona" as const, providers: { daytona: { credential: { owner: "alessio", service: "daytona" }, target: "eu" } } };
    const sandbox = resolveSandbox({ instance: settings }, { scope: "task", available: new Set(["local", "bwrap", "daytona"] as const) });
    expect(sandbox.providerOptions).toMatchObject({ credential: { owner: "alessio", service: "daytona" }, target: "eu" });
    const vault = { get: async (o: string, s: string) => (o === "alessio" && s === "daytona" ? { type: "api_key", credentials: { apiKey: "k" } } : undefined) } as any;
    configureRemoteProviders(vault, () => ({ [sandbox.provider]: sandbox.providerOptions }));
    expect(configuredRemoteProviders()).toEqual(["daytona"]);
    expect(await remoteProviderCredentials("daytona")).toMatchObject({ apiKey: "k", target: "eu" });
    const ws = createWorkspace(sandbox, { root: tmpdir() });
    expect(isRemoteWorkspace(ws)).toBe(true);
  });

  test("a remote provider that is not configured falls back to bubblewrap and says so", () => {
    configureRemoteProviders(undefined, () => undefined);
    const warnings: string[] = [];
    const ws = createWorkspace({ provider: "daytona", network: { mode: "open" }, resources: {}, providerOptions: {}, denied: [] }, {
      root: tmpdir(), onRemoteEvent: (e) => { if (e.kind === "warning") warnings.push(e.message); },
    });
    expect(ws.provider).toBe("bwrap");
    expect(warnings[0]).toMatch(/not configured.*bubblewrap/);
  });
});
