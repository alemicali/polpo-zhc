import { afterEach, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RemoteWorkspace, type RemoteDriver } from "../sandbox/remote.js";
import { WorkspaceFileSystem } from "../sandbox/workspace-fs.js";
import {
  configuredRemoteProviders, loadRemoteProviders, remoteProviderCredentials, remoteProviderStatus, removeRemoteProvider, saveRemoteProvider,
} from "../sandbox/remote-providers.js";
import { availableProviders, createWorkspace, isRemoteWorkspace } from "../sandbox/manager.js";

const sandbox = { provider: "e2b" as const, network: { mode: "open" as const }, resources: {}, providerOptions: {}, denied: [] };

/** A "VM" that is a directory on this machine: commands run with bash, paths are prefixed. */
class DirDriver implements RemoteDriver {
  readonly remoteId = "fake-vm";
  destroyed = false;
  backTarball?: Uint8Array;
  constructor(readonly vmRoot: string) {}
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

class FakeRemote extends RemoteWorkspace {
  readonly provider = "e2b" as const;
  constructor(opts: ConstructorParameters<typeof RemoteWorkspace>[0], readonly fake: DirDriver) { super(opts); }
  protected async createDriver() { return this.fake; }
}

const dirs: string[] = [];
const tmp = (prefix: string) => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("remote workspace", () => {
  test("context goes over without ignored files; refuses to copy back paths outside the writable ones", async () => {
    const root = tmp("polpo-remote-root-");
    writeFileSync(join(root, "keep.txt"), "keep");
    writeFileSync(join(root, ".gitignore"), "secret.env\n");
    writeFileSync(join(root, "secret.env"), "TOKEN=x");
    mkdirSync(join(root, "node_modules", "dep"), { recursive: true });
    writeFileSync(join(root, "node_modules", "dep", "index.js"), "x");
    const vm = tmp("polpo-remote-vm-");
    execFileSync("git", ["init", "-q"], { cwd: root }); // --exclude-vcs-ignores reads .gitignore in a repo
    const driver = new DirDriver(vm);
    const warnings: string[] = [];
    const ws = new FakeRemote({ root, sandbox, onEvent: (e) => { if (e.kind === "warning") warnings.push(e.message); } }, driver);

    const r = await ws.exec("ls -a");
    expect(r.stdout).toContain("keep.txt");
    expect(r.stdout).not.toContain("secret.env");
    expect(r.stdout).not.toContain("node_modules");

    // a malicious VM answers the sync-back with a tarball that writes outside the working directory
    const evil = tmp("polpo-remote-evil-");
    mkdirSync(join(evil, "etc"), { recursive: true });
    writeFileSync(join(evil, "etc", "evil"), "x");
    driver.backTarball = new Uint8Array(execFileSync("tar", ["-czf", "-", "-C", evil, "etc/evil"]));
    await ws.dispose();
    expect(warnings.join(" ")).toMatch(/outside the writable paths/);
    expect(existsSync("/etc/evil")).toBe(false);
    expect(driver.destroyed).toBe(true);
  });

  test("the file tools' FileSystem goes through the workspace", async () => {
    const root = tmp("polpo-remote-root-");
    const vm = tmp("polpo-remote-vm-");
    const ws = new FakeRemote({ root, sandbox }, new DirDriver(vm));
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
  const entries = new Map<string, any>();
  const vault = {
    get: async (_o: string, s: string) => entries.get(s),
    set: async (_o: string, s: string, e: any) => { entries.set(s, e); },
    remove: async (_o: string, s: string) => { entries.delete(s); return true; },
  } as any;

  test("keys are stored in the vault, never returned, and make the provider available", async () => {
    await loadRemoteProviders(vault);
    expect(configuredRemoteProviders()).toEqual([]);
    expect(availableProviders().has("daytona")).toBe(false);
    await saveRemoteProvider("daytona", { apiKey: "dtn_secret", target: "eu" });
    expect(availableProviders().has("daytona")).toBe(true);
    const status = remoteProviderStatus().find((p) => p.id === "daytona")!;
    expect(status).toMatchObject({ configured: true, apiKey: "set", target: "eu" });
    expect(JSON.stringify(remoteProviderStatus())).not.toContain("dtn_secret");
    // an empty key keeps the stored one
    await saveRemoteProvider("daytona", { apiKey: "", apiUrl: "https://example.test/api" });
    expect(remoteProviderCredentials("daytona")).toMatchObject({ apiKey: "dtn_secret", apiUrl: "https://example.test/api", target: "eu" });
    // reload from the vault
    await loadRemoteProviders(vault);
    expect(remoteProviderCredentials("daytona")?.apiKey).toBe("dtn_secret");
    const ws = createWorkspace({ ...sandbox, provider: "daytona" }, { root: tmpdir() });
    expect(isRemoteWorkspace(ws)).toBe(true);
    await removeRemoteProvider("daytona");
    expect(availableProviders().has("daytona")).toBe(false);
    await expect(saveRemoteProvider("e2b", {})).rejects.toThrow(/API key is required/);
  });
});
