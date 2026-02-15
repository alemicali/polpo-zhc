import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { resolveAllowedPaths, isPathAllowed, assertPathAllowed } from "../tools/path-sandbox.js";
import { createCodingTools } from "../tools/coding-tools.js";

// ── resolveAllowedPaths ──

describe("resolveAllowedPaths", () => {
  it("defaults to [cwd] when no allowedPaths given", () => {
    const result = resolveAllowedPaths("/project");
    expect(result).toEqual(["/project"]);
  });

  it("defaults to [cwd] when empty array given", () => {
    const result = resolveAllowedPaths("/project", []);
    expect(result).toEqual(["/project"]);
  });

  it("resolves relative paths against cwd", () => {
    const result = resolveAllowedPaths("/project", ["src", "lib"]);
    expect(result).toEqual(["/project/src", "/project/lib"]);
  });

  it("keeps absolute paths as-is", () => {
    const result = resolveAllowedPaths("/project", ["/tmp/shared", "src"]);
    expect(result).toEqual(["/tmp/shared", "/project/src"]);
  });
});

// ── isPathAllowed ──

describe("isPathAllowed", () => {
  const allowed = ["/project/src", "/project/lib", "/tmp/shared"];

  it("allows exact match", () => {
    expect(isPathAllowed("/project/src", allowed)).toBe(true);
  });

  it("allows files inside allowed directory", () => {
    expect(isPathAllowed("/project/src/index.ts", allowed)).toBe(true);
    expect(isPathAllowed("/project/src/utils/helper.ts", allowed)).toBe(true);
  });

  it("allows files in any allowed directory", () => {
    expect(isPathAllowed("/project/lib/core.ts", allowed)).toBe(true);
    expect(isPathAllowed("/tmp/shared/data.json", allowed)).toBe(true);
  });

  it("rejects paths outside allowed directories", () => {
    expect(isPathAllowed("/etc/passwd", allowed)).toBe(false);
    expect(isPathAllowed("/project/dist/bundle.js", allowed)).toBe(false);
    expect(isPathAllowed("/home/user/.ssh/id_rsa", allowed)).toBe(false);
  });

  it("rejects parent traversal that escapes sandbox", () => {
    // resolve() normalizes ".." so /project/src/../dist becomes /project/dist
    expect(isPathAllowed(resolve("/project/src/../dist/bundle.js"), allowed)).toBe(false);
  });

  it("prevents partial directory name matches", () => {
    // /project/src-evil should NOT match /project/src
    expect(isPathAllowed("/project/src-evil/malicious.ts", allowed)).toBe(false);
    expect(isPathAllowed("/project/srcx/file.ts", allowed)).toBe(false);
  });

  it("allows when only cwd is in the sandbox (default behavior)", () => {
    const defaultSandbox = ["/project"];
    expect(isPathAllowed("/project/anything/deep.ts", defaultSandbox)).toBe(true);
    expect(isPathAllowed("/other-project/file.ts", defaultSandbox)).toBe(false);
  });
});

// ── assertPathAllowed ──

describe("assertPathAllowed", () => {
  const allowed = ["/project/src"];

  it("does not throw for allowed paths", () => {
    expect(() => assertPathAllowed("/project/src/index.ts", allowed, "read")).not.toThrow();
  });

  it("throws for disallowed paths with descriptive message", () => {
    expect(() => assertPathAllowed("/etc/passwd", allowed, "read")).toThrow(
      /\[sandbox\] read: access denied/,
    );
    expect(() => assertPathAllowed("/etc/passwd", allowed, "read")).toThrow(
      /\/etc\/passwd/,
    );
    expect(() => assertPathAllowed("/etc/passwd", allowed, "read")).toThrow(
      /\/project\/src/,
    );
  });

  it("includes tool name in error", () => {
    expect(() => assertPathAllowed("/etc/passwd", allowed, "write")).toThrow(
      /\[sandbox\] write:/,
    );
  });
});

// ── createCodingTools integration ──

describe("createCodingTools with allowedPaths", () => {
  const tmpDir = join(process.cwd(), ".test-sandbox-" + Date.now());
  const srcDir = join(tmpDir, "src");
  const outsideDir = join(tmpDir, "outside");

  beforeAll(() => {
    mkdirSync(srcDir, { recursive: true });
    mkdirSync(outsideDir, { recursive: true });
    writeFileSync(join(srcDir, "hello.ts"), "export const x = 1;\n");
    writeFileSync(join(outsideDir, "secret.ts"), "export const secret = 'password';\n");
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("read tool allows files inside sandbox", async () => {
    const tools = createCodingTools(tmpDir, undefined, ["src"]);
    const readTool = tools.find(t => t.name === "read")!;
    const result = await readTool.execute("tc1", { path: "src/hello.ts" });
    expect((result.content[0] as any).text).toContain("export const x = 1");
  });

  it("read tool rejects files outside sandbox", async () => {
    const tools = createCodingTools(tmpDir, undefined, ["src"]);
    const readTool = tools.find(t => t.name === "read")!;
    await expect(readTool.execute("tc2", { path: "outside/secret.ts" })).rejects.toThrow(
      /\[sandbox\] read: access denied/,
    );
  });

  it("read tool rejects absolute escape paths", async () => {
    const tools = createCodingTools(tmpDir, undefined, ["src"]);
    const readTool = tools.find(t => t.name === "read")!;
    await expect(readTool.execute("tc3", { path: "/etc/hostname" })).rejects.toThrow(
      /\[sandbox\] read: access denied/,
    );
  });

  it("read tool rejects parent traversal", async () => {
    const tools = createCodingTools(tmpDir, undefined, ["src"]);
    const readTool = tools.find(t => t.name === "read")!;
    await expect(readTool.execute("tc4", { path: "src/../outside/secret.ts" })).rejects.toThrow(
      /\[sandbox\] read: access denied/,
    );
  });

  it("write tool rejects writes outside sandbox", async () => {
    const tools = createCodingTools(tmpDir, undefined, ["src"]);
    const writeTool = tools.find(t => t.name === "write")!;
    await expect(writeTool.execute("tc5", { path: "outside/evil.ts", content: "hacked" })).rejects.toThrow(
      /\[sandbox\] write: access denied/,
    );
  });

  it("edit tool rejects edits outside sandbox", async () => {
    const tools = createCodingTools(tmpDir, undefined, ["src"]);
    const editTool = tools.find(t => t.name === "edit")!;
    await expect(
      editTool.execute("tc6", { path: "outside/secret.ts", old_text: "password", new_text: "hacked" }),
    ).rejects.toThrow(/\[sandbox\] edit: access denied/);
  });

  it("ls tool rejects listing outside sandbox", async () => {
    const tools = createCodingTools(tmpDir, undefined, ["src"]);
    const lsTool = tools.find(t => t.name === "ls")!;
    await expect(lsTool.execute("tc7", { path: "outside" })).rejects.toThrow(
      /\[sandbox\] ls: access denied/,
    );
  });

  it("glob tool rejects searching outside sandbox", async () => {
    const tools = createCodingTools(tmpDir, undefined, ["src"]);
    const globTool = tools.find(t => t.name === "glob")!;
    await expect(globTool.execute("tc8", { pattern: "*.ts", path: "outside" })).rejects.toThrow(
      /\[sandbox\] glob: access denied/,
    );
  });

  it("grep tool rejects searching outside sandbox", async () => {
    const tools = createCodingTools(tmpDir, undefined, ["src"]);
    const grepTool = tools.find(t => t.name === "grep")!;
    await expect(grepTool.execute("tc9", { pattern: "secret", path: "outside" })).rejects.toThrow(
      /\[sandbox\] grep: access denied/,
    );
  });

  it("allows everything when no allowedPaths (defaults to cwd)", async () => {
    const tools = createCodingTools(tmpDir);
    const readTool = tools.find(t => t.name === "read")!;
    // Both src and outside are under tmpDir, so both should work
    const r1 = await readTool.execute("tc10", { path: "src/hello.ts" });
    expect((r1.content[0] as any).text).toContain("export const x = 1");
    const r2 = await readTool.execute("tc11", { path: "outside/secret.ts" });
    expect((r2.content[0] as any).text).toContain("secret");
  });

  it("supports multiple allowed paths", async () => {
    const tools = createCodingTools(tmpDir, undefined, ["src", "outside"]);
    const readTool = tools.find(t => t.name === "read")!;
    // Both should work
    const r1 = await readTool.execute("tc12", { path: "src/hello.ts" });
    expect((r1.content[0] as any).text).toContain("export const x = 1");
    const r2 = await readTool.execute("tc13", { path: "outside/secret.ts" });
    expect((r2.content[0] as any).text).toContain("secret");
  });

  it("bash tool is still accessible (not path-sandboxed)", async () => {
    const tools = createCodingTools(tmpDir, undefined, ["src"]);
    const bashTool = tools.find(t => t.name === "bash")!;
    // Bash runs with cwd=tmpDir, not sandboxed at path level
    const result = await bashTool.execute("tc14", { command: "echo hello" });
    expect((result.content[0] as any).text).toContain("hello");
  });
});
