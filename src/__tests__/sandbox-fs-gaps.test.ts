import { afterEach, describe, expect, test } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { FileSystem } from "@polpo-ai/core/filesystem";
import { NodeFileSystem } from "../adapters/node-filesystem.js";
import { offloadToolOutput, withToolOutputOffload } from "../tools/tool-output.js";
import { createSystemTools } from "../tools/system-tools.js";
import { remoteThenLocal } from "../sandbox/workspace-fs.js";

const dirs: string[] = [];
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** A remote sandbox's files, in memory: nothing it writes may appear on this machine. */
class VmFs implements FileSystem {
  files = new Map<string, Uint8Array>();
  dirs = new Set<string>();
  async readFile(p: string) { const f = this.files.get(p); if (!f) throw Object.assign(new Error(`ENOENT ${p}`), { code: "ENOENT" }); return Buffer.from(f).toString("utf8"); }
  async readFileBuffer(p: string) { const f = this.files.get(p); if (!f) throw new Error(`ENOENT ${p}`); return f; }
  async writeFile(p: string, c: string) { this.files.set(p, Buffer.from(c)); }
  async writeFileBuffer(p: string, d: Uint8Array) { this.files.set(p, d); }
  async exists(p: string) { return this.files.has(p) || this.dirs.has(p); }
  async readdir(p: string) { return [...this.files.keys()].filter((k) => dirname(k) === p).map((k) => k.slice(p.length + 1)); }
  async mkdir(p: string) { this.dirs.add(p); }
  async remove(p: string) { this.files.delete(p); }
  async stat(p: string) { const f = this.files.get(p); if (!f) throw new Error("ENOENT"); return { size: f.length, isFile: true, isDirectory: false, modifiedAt: new Date() }; }
  async rename(a: string, b: string) { const f = this.files.get(a)!; this.files.delete(a); this.files.set(b, f); }
}

describe("large tool output in a remote sandbox (open Polpo: file I/O through the run's FileSystem)", () => {
  test("the full output is saved in the VM, where read/grep run; never on this machine", async () => {
    const vm = new VmFs();
    const dir = join(tmp("polpo-host-"), "tool-output");
    const big = "line\n".repeat(20_000);
    const off = await offloadToolOutput(big, { tool: "bash", dir, maxChars: 1000, fs: vm });
    expect(off.offloaded).toBe(true);
    expect(off.path!.startsWith(dir)).toBe(true);
    expect(await vm.readFile(off.path!)).toBe(big);
    expect(existsSync(off.path!)).toBe(false);
    expect(off.text).toContain(off.path!);
  });

  test("on this machine nothing changes (private file on disk)", async () => {
    const dir = join(tmp("polpo-host-"), "tool-output");
    const off = await offloadToolOutput("x".repeat(5000), { tool: "bash", dir, maxChars: 100, fs: new NodeFileSystem() });
    expect(existsSync(off.path!)).toBe(true);
  });

  test("bash and wrapped tools offload into the VM", async () => {
    const vm = new VmFs();
    const cwd = "/work";
    const outputDir = join(tmp("polpo-host-"), "out");
    const shell = { execute: async () => ({ stdout: "y\n".repeat(40_000), stderr: "", exitCode: 0 }) };
    const [bash] = createSystemTools(cwd, ["bash"], undefined, outputDir, undefined, vm, shell as any);
    const r: any = await bash!.execute("1", { command: "yes | head -40000" } as any);
    expect(r.details.outputPath).toBeTruthy();
    expect(vm.files.has(r.details.outputPath)).toBe(true);
    expect(existsSync(r.details.outputPath)).toBe(false);

    const tool = withToolOutputOffload({ name: "browser_get", label: "", description: "", parameters: {} as any, execute: async () => ({ content: [{ type: "text", text: "z".repeat(5000) }], details: {} }) } as any, { dir: join(outputDir, "tool-output"), maxChars: 100, fs: vm });
    const w: any = await tool.execute("2", {});
    expect(vm.files.has(w.details.outputPath)).toBe(true);
  });
});

describe("files a confirmed chat action refers to (email after its preview)", () => {
  test("the VM first, then this machine; writes stay here", async () => {
    const vm = new VmFs();
    const host = tmp("polpo-host-");
    vm.files.set("/work/report.pdf", Buffer.from("from-vm"));
    mkdirSync(join(host, "out"), { recursive: true });
    writeFileSync(join(host, "out", "synced.pdf"), "from-host");
    const fs = remoteThenLocal(vm, new NodeFileSystem());
    expect(Buffer.from(await fs.readFileBuffer!("/work/report.pdf")).toString()).toBe("from-vm");
    expect(Buffer.from(await fs.readFileBuffer!(join(host, "out", "synced.pdf"))).toString()).toBe("from-host");
    expect(await fs.exists("/work/report.pdf")).toBe(true);
    expect(await fs.exists(join(host, "nope.pdf"))).toBe(false);
    await fs.writeFile(join(host, "w.txt"), "here");
    expect(existsSync(join(host, "w.txt"))).toBe(true);
    expect(vm.files.has(join(host, "w.txt"))).toBe(false);
  });
});
