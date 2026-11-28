/**
 * Polpo's tools on a remote computer take the computer's paths: an agent working in its own
 * folders (home, /tmp, a mounted /volumes/<name>) points image_analyze, image_edit and
 * register_outcome at its files there, without copying them into the server's working directory
 * first. Paths outside those folders are refused with the folders listed; runs on this server keep
 * their rules. The fake FileSystem keeps files in memory (what the VM looks like to the tools).
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { FileEntry, FileStat, FileSystem } from "@polpo-ai/core/filesystem";
import { createImageTools } from "../tools/image-tools.js";
import { MediaService, registerMediaService } from "../media/service.js";
import { createOutcomeTools } from "../tools/outcome-tools.js";
import { createAttachmentTools } from "../tools/attachment-tools.js";
import { createAllTools } from "../tools/system-tools.js";
import { isPathAllowed, isRemoteRoots, remoteAllowedRoots, resolveAllowedPaths, withAllowedPaths } from "../tools/path-sandbox.js";
import { buildSystemPrompt, remoteRunRoots } from "../adapters/engine.js";
import { buildHarnessInstructions } from "../adapters/harness-engine.js";

class MemoryFs implements FileSystem {
  files = new Map<string, Uint8Array>();
  dirs = new Set<string>(["/"]);
  async readFile(path: string) { return new TextDecoder().decode(await this.readFileBuffer(path)); }
  async writeFile(path: string, content: string) { await this.writeFileBuffer(path, new TextEncoder().encode(content)); }
  async readFileBuffer(path: string) {
    const data = this.files.get(path);
    if (!data) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
    return data;
  }
  async writeFileBuffer(path: string, data: Uint8Array) {
    await this.mkdir(dirname(path));
    this.files.set(path, new Uint8Array(data));
  }
  async exists(path: string) { return this.files.has(path) || this.dirs.has(path); }
  async readdir(path: string) { return (await this.readdirWithTypes(path)).map((e) => e.name); }
  async readdirWithTypes(path: string): Promise<FileEntry[]> {
    return [...this.files.keys()].filter((f) => dirname(f) === path).map((f) => ({ name: f.slice(path.length + 1), isDirectory: false, isFile: true }));
  }
  async mkdir(path: string) { for (let p = path; p !== "/"; p = dirname(p)) this.dirs.add(p); }
  async remove(path: string) { this.files.delete(path); }
  async stat(path: string): Promise<FileStat> {
    const data = this.files.get(path);
    if (data) return { size: data.byteLength, isFile: true, isDirectory: false };
    if (this.dirs.has(path)) return { size: 0, isFile: false, isDirectory: true };
    throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
  }
  async rename(a: string, b: string) { this.files.set(b, this.files.get(a)!); this.files.delete(a); }
}

const text = (r: any) => r.content.map((c: any) => c.text ?? "").join("\n");
const tool = (tools: any[], name: string) => {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
};
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
/** The server's working directory as the computer sees it (a path that does not exist here). */
const CWD = "/srv-polpo-test/inst";

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("the roots of a remote computer", () => {
  test("working and output directories, home, /tmp and the run's volumes (only under /volumes)", () => {
    const roots = remoteAllowedRoots({ cwd: CWD, outputDir: `${CWD}/out`, volumes: [{ mountPath: "/volumes/research" }, { mountPath: "/volumes" }, { mountPath: "/srv/bucket" }] });
    expect(roots).toEqual([CWD, `${CWD}/out`, "/home", "/tmp", "/volumes/research"]);
    expect(isRemoteRoots(roots)).toBe(true);
    expect(resolveAllowedPaths("/elsewhere", roots)).toBe(roots);
    expect(isPathAllowed("/home/daytona/a.png", roots)).toBe(true);
    expect(isPathAllowed("/volumes/research/deep/x.pdf", roots)).toBe(true);
    expect(isPathAllowed("/volumes/research-2/x.pdf", roots)).toBe(false);
    expect(isPathAllowed("/volumes/other/x.pdf", roots)).toBe(false);
    expect(isPathAllowed("/home/../etc/passwd", roots)).toBe(false);
    expect(isPathAllowed("/etc/passwd", roots)).toBe(false);
    // extended, they stay the computer's
    expect(isRemoteRoots(withAllowedPaths(roots, "/opt/skills"))).toBe(true);
  });

  test("a run's roots come from its attached volumes only (a volume without remote keys is not in the VM)", () => {
    const roots = remoteRunRoots(CWD, `${CWD}/out`, { volumes: [
      { name: "research", mountPath: "/volumes/research", remote: { bucket: "b", credentials: { accessKeyId: "k", secretAccessKey: "s" } } },
      { name: "local", mountPath: "/volumes/local" },
    ] as any });
    expect(roots).toContain("/volumes/research");
    expect(roots).not.toContain("/volumes/local");
    expect(remoteRunRoots(CWD, undefined, undefined, roots)).toBe(roots);
  });

  test("this server's runs keep their rules: the working directory only, symlinks resolved", () => {
    const sandbox = resolveAllowedPaths(CWD);
    expect(isRemoteRoots(sandbox)).toBe(false);
    expect(isPathAllowed("/home/daytona/a.png", sandbox)).toBe(false);
    expect(isPathAllowed("/tmp/a.png", sandbox)).toBe(false);
    expect(isPathAllowed(`${CWD}/a.png`, sandbox)).toBe(true);
  });
});

describe("image tools on a remote computer", () => {
  const media = () => {
    const visionTurn = vi.fn(async () => ({ text: "a tiny png" }));
    const polpoDir = "/tmp/polpo-remote-paths-media";
    registerMediaService(polpoDir, new MediaService({ polpoDir: () => polpoDir, settings: () => undefined, vault: () => undefined, visionTurn }));
    return { visionTurn, polpoDir };
  };

  test("image_analyze reads a file of the computer (home, a mounted volume) through its workspace", async () => {
    const fs = new MemoryFs();
    await fs.writeFileBuffer("/volumes/research/pic.png", PNG);
    await fs.writeFileBuffer("/home/daytona/shot.png", PNG);
    const { visionTurn, polpoDir } = media();
    const roots = remoteAllowedRoots({ cwd: CWD, volumes: [{ mountPath: "/volumes/research" }] });
    const tools = createImageTools(CWD, roots, ["image_analyze"], undefined, fs, { polpoDir, agent: "nina" });
    expect(text(await tool(tools, "image_analyze").execute("1", { path: "/volumes/research/pic.png" }))).toContain("a tiny png");
    expect(text(await tool(tools, "image_analyze").execute("2", { path: "/home/daytona/shot.png" }))).toContain("a tiny png");
    expect(visionTurn).toHaveBeenCalledWith(expect.objectContaining({ image: { data: Buffer.from(PNG).toString("base64"), mimeType: "image/png" } }));
    expect(existsSync("/volumes/research/pic.png")).toBe(false);
  });

  test("image_analyze and image_edit refuse a path outside the computer's folders, listing them", async () => {
    const fs = new MemoryFs();
    await fs.writeFileBuffer("/etc/pic.png", PNG);
    const { visionTurn, polpoDir } = media();
    const roots = remoteAllowedRoots({ cwd: CWD, volumes: [{ mountPath: "/volumes/research" }] });
    const tools = createImageTools(CWD, roots, ["image_analyze", "image_edit"], undefined, fs, { polpoDir, agent: "nina" });
    await expect(tool(tools, "image_analyze").execute("1", { path: "/etc/pic.png" }))
      .rejects.toThrow(`Use a path under one of: ${CWD}, /home, /tmp, /volumes/research`);
    await expect(tool(tools, "image_edit").execute("2", { image: "/home/daytona/a.png", prompt: "x", path: "/var/out.png" })).rejects.toThrow(/image_edit: "\/var\/out\.png" is outside/);
    expect(visionTurn).not.toHaveBeenCalled();
  });

  test("the tool descriptions say paths are the computer's", () => {
    const tools = createImageTools(CWD, undefined, ["image_analyze", "image_edit"], undefined, new MemoryFs(), {});
    for (const t of tools) expect(t.description).toContain("on a remote computer, files of that computer");
  });

  test("on this server image_analyze still refuses paths outside the working directory", async () => {
    const tools = createImageTools("/srv-polpo-test/host", undefined, ["image_analyze"], undefined, undefined, {});
    await expect(tool(tools, "image_analyze").execute("1", { path: "/home/someone/a.png" })).rejects.toThrow(/outside allowed directories \[\/srv-polpo-test\/host\]/);
  });
});

describe("register_outcome on a remote computer", () => {
  const outDir = () => {
    const d = mkdtempSync(join(tmpdir(), "polpo-remote-outcome-"));
    dirs.push(d);
    return d;
  };

  test("a file on a mounted volume is copied into the task output on the server", async () => {
    const fs = new MemoryFs();
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    await fs.writeFileBuffer("/volumes/research/report.pdf", bytes);
    const out = outDir();
    const roots = remoteAllowedRoots({ cwd: CWD, outputDir: out, volumes: [{ mountPath: "/volumes/research" }] });
    const [outcome] = createOutcomeTools(CWD, roots, undefined, out, fs, { remote: true });
    expect(outcome!.description).toContain("You work on a remote computer");
    const r = await outcome!.execute("1", { type: "file", label: "Report", path: "/volumes/research/report.pdf" });
    expect(r.details).toMatchObject({ path: join(out, "report.pdf"), copiedFrom: "/volumes/research/report.pdf", outcomeSize: 5, outcomeMimeType: "application/pdf" });
    expect([...readFileSync(join(out, "report.pdf"))]).toEqual([1, 2, 3, 4, 5]);
    expect(text(r)).toContain("Copied from your computer: /volumes/research/report.pdf");
  });

  test("a file of the computer's home is accepted too; one outside its folders is refused with them listed", async () => {
    const fs = new MemoryFs();
    await fs.writeFileBuffer("/home/daytona/work/shot.png", PNG);
    await fs.writeFileBuffer("/opt/app/secret.txt", new Uint8Array([9]));
    const out = outDir();
    const roots = remoteAllowedRoots({ cwd: CWD, outputDir: out, volumes: [] });
    const [outcome] = createOutcomeTools(CWD, roots, undefined, out, fs, { remote: true });
    expect((await outcome!.execute("1", { type: "media", label: "Shot", path: "/home/daytona/work/shot.png" })).details).toMatchObject({ path: join(out, "shot.png"), outcomeMimeType: "image/png" });
    const refused = await outcome!.execute("2", { type: "file", label: "x", path: "/opt/app/secret.txt" });
    expect(refused.details).toMatchObject({ error: "path_not_allowed", allowedRoots: [CWD, out, "/home", "/tmp"] });
    expect(text(refused)).toContain(`on your computer (${CWD}, ${out}, /home, /tmp:`);
    expect(existsSync(join(out, "secret.txt"))).toBe(false);
  });

  test("createAllTools with a remote computer's roots: register_outcome takes a /volumes file", async () => {
    const fs = new MemoryFs();
    await fs.writeFileBuffer("/volumes/research/data.csv", new TextEncoder().encode("a,b"));
    const out = outDir();
    const roots = remoteAllowedRoots({ cwd: CWD, outputDir: out, volumes: [{ mountPath: "/volumes/research" }] });
    const tools = await createAllTools({ cwd: CWD, allowedPaths: roots, allowedTools: ["register_outcome"], outputDir: out, fs });
    const r = await tool(tools, "register_outcome").execute("1", { type: "file", label: "Data", path: "/volumes/research/data.csv" });
    expect(r.details).toMatchObject({ path: join(out, "data.csv"), copiedFrom: "/volumes/research/data.csv" });
  });

  test("on this server the rules are unchanged: outside the working and output directories is refused", async () => {
    const out = outDir();
    const [outcome] = createOutcomeTools("/srv-polpo-test/host", undefined, undefined, out);
    const r = await outcome!.execute("1", { type: "file", label: "x", path: "/home/someone/x.pdf" });
    expect(r.details).toMatchObject({ error: "path_not_allowed" });
    expect(text(r)).toContain("outside the folders deliverables can come from (/srv-polpo-test/host,");
    expect(outcome!.description).not.toContain("remote computer");
  });
});

describe("read_attachment on a remote computer", () => {
  test("reads the computer's file; never falls back to this server outside the working directory", async () => {
    const fs = new MemoryFs();
    await fs.writeFile("/home/daytona/notes.txt", "from the VM");
    const roots = remoteAllowedRoots({ cwd: CWD });
    const [read] = createAttachmentTools(CWD, roots, ["read_attachment"], fs);
    expect(text(await read!.execute("1", { path: "/home/daytona/notes.txt" }))).toBe("from the VM");
    // a file of this server's /tmp, not in the VM: /tmp is the computer's, nothing of the server is read
    const d = mkdtempSync("/tmp/polpo-remote-leak-");
    dirs.push(d);
    writeFileSync(join(d, "server.txt"), "server secret");
    const r = await read!.execute("2", { path: join(d, "server.txt") });
    expect(text(r)).not.toContain("server secret");
  });
});

describe("prompts", () => {
  test("a harness on a remote computer is told Polpo's tools take its own paths", () => {
    const roots = remoteAllowedRoots({ cwd: CWD, outputDir: `${CWD}/out`, volumes: [{ mountPath: "/volumes/research" }] });
    const text = buildHarnessInstructions({
      agent: { name: "nina", role: "researcher" } as any, cwd: CWD, outputDir: `${CWD}/out`, hostTools: ["browser_screenshot", "image_analyze", "register_outcome"], harness: "claude-code", remoteRoots: roots,
    });
    expect(text).toContain("are paths of your computer");
    expect(text).toContain(`${CWD}, ${CWD}/out, /home, /tmp, /volumes/research`);
    expect(text).toContain("register_outcome copies the file into the task output");
    const host = buildHarnessInstructions({ agent: { name: "nina" } as any, cwd: CWD, hostTools: ["image_analyze"], harness: "codex" });
    expect(host).not.toContain("paths of your computer");
  });

  test("Polpo's engine on a remote computer lists the computer's folders instead of 'do not use /tmp, /home'", () => {
    const roots = remoteAllowedRoots({ cwd: CWD, outputDir: `${CWD}/out`, volumes: [{ mountPath: "/volumes/research" }] });
    const remote = buildSystemPrompt({ name: "nina" } as any, CWD, undefined, `${CWD}/out`, roots);
    expect(remote).toContain("You work on a remote computer");
    expect(remote).toContain("- /volumes/research");
    expect(remote).not.toContain("Do NOT use /tmp, /home");
    expect(buildSystemPrompt({ name: "nina" } as any, CWD, undefined, `${CWD}/out`)).toContain("Do NOT use /tmp, /home");
  });
});

describe("buildAgentToolset (harness, CLI and Polpo's engine runs)", () => {
  test("a run on a remote computer gets the computer's roots: register_outcome takes a /volumes file, the roots are reported for the prompt", async () => {
    const { buildAgentToolset } = await import("../adapters/engine.js");
    const fs = new MemoryFs();
    await fs.writeFileBuffer("/volumes/research/brief.pdf", new Uint8Array([7, 7]));
    const out = mkdtempSync(join(tmpdir(), "polpo-remote-toolset-"));
    dirs.push(out);
    const volumes = [{ name: "research", mountPath: "/volumes/research", strategy: "mounted", access: "read-write", driver: "rclone", remote: { bucket: "b", credentials: { accessKeyId: "k", secretAccessKey: "s" } } }];
    const toolset = await buildAgentToolset({
      agentConfig: { name: "nina" } as any, cwd: CWD, ctx: { outputDir: out, volumes } as any, outputDir: out, remoteFs: fs as any,
      sandboxProvider: "daytona", browserProfileDir: join(out, "profile"), hasExtendedTools: false,
    });
    expect(toolset.remoteRoots).toEqual([CWD, out, "/home", "/tmp", "/volumes/research"]);
    const r = await tool(toolset.tools, "register_outcome").execute("1", { type: "file", label: "Brief", path: "/volumes/research/brief.pdf" });
    expect(r.details).toMatchObject({ path: join(out, "brief.pdf"), copiedFrom: "/volumes/research/brief.pdf" });
  });

  test("a run on this server keeps the paths it was given (no computer roots)", async () => {
    const { buildAgentToolset } = await import("../adapters/engine.js");
    const out = mkdtempSync(join(tmpdir(), "polpo-host-toolset-"));
    dirs.push(out);
    const toolset = await buildAgentToolset({
      agentConfig: { name: "nina" } as any, cwd: out, ctx: { outputDir: out } as any, effectiveAllowedPaths: [out], outputDir: out,
      sandboxProvider: "local", browserProfileDir: join(out, "profile"), hasExtendedTools: false,
    });
    expect(toolset.remoteRoots).toBeUndefined();
    const r = await tool(toolset.tools, "register_outcome").execute("1", { type: "file", label: "x", path: "/home/x.pdf" });
    expect(r.details).toMatchObject({ error: "path_not_allowed" });
  });
});
