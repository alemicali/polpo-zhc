import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildPreview,
  cleanupToolOutputDir,
  offloadToolOutput,
  resolveToolOutputDir,
  saveToolOutput,
  withToolOutputOffload,
  TOOL_OUTPUT_RETENTION_MS,
} from "../tools/tool-output.js";
import { createSystemTools } from "../tools/system-tools.js";
import { createHttpTools } from "../tools/http-tools.js";

const PATH_RE = /Full output saved to (\S+?)\. Read it with `read` using offset\/limit, or search it with `grep`; do not read it all at once\./;

function savedPath(text: string): string {
  const m = text.match(PATH_RE);
  if (!m) throw new Error(`no saved path in: ${text.slice(-400)}`);
  return m[1];
}

function textOf(result: any): string {
  return result.content.map((c: any) => c.text ?? "").join("");
}

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "polpo-offload-test-"));
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(root, { recursive: true, force: true });
});

describe("resolveToolOutputDir", () => {
  it("uses <outputDir>/tool-output for task runs", () => {
    expect(resolveToolOutputDir({ outputDir: "/x/.polpo/output/t1", polpoDir: "/x/.polpo", agentName: "a" }))
      .toBe("/x/.polpo/output/t1/tool-output");
  });

  it("uses a per-agent dir under <polpoDir>/tmp without an outputDir", () => {
    expect(resolveToolOutputDir({ polpoDir: "/x/.polpo", agentName: "sales bot/../x" }))
      .toBe("/x/.polpo/tmp/tool-output/sales_bot_.._x");
  });

  it("falls back to a per-user temp dir", () => {
    expect(resolveToolOutputDir({ agentName: "a" }).startsWith(tmpdir())).toBe(true);
  });
});

describe("offloadToolOutput", () => {
  it("returns small outputs unchanged and writes nothing", async () => {
    const dir = join(root, "out");
    const r = await offloadToolOutput("hello\nworld\n", { tool: "bash", dir, maxChars: 100 });
    expect(r).toMatchObject({ text: "hello\nworld\n", offloaded: false });
    expect(() => readdirSync(dir)).toThrow();
  });

  it("saves the full output (0600 in a 0700 dir) and returns head + tail + path + hint", async () => {
    const dir = join(root, "out");
    const lines = Array.from({ length: 5000 }, (_, i) => `line ${i + 1}`);
    const full = lines.join("\n") + "\n";
    const r = await offloadToolOutput(full, { tool: "bash", dir, maxChars: 2000 });

    expect(r.offloaded).toBe(true);
    expect(r.totalLines).toBe(5000);
    expect(r.text.startsWith("line 1\nline 2\n")).toBe(true);
    expect(r.text).toContain("line 5000");
    expect(r.text).toMatch(/… \d+ lines \(\d+ bytes\) omitted …/);
    expect(r.text).not.toContain("line 2500\n");
    expect(r.text.length).toBeLessThan(2600);

    const path = savedPath(r.text);
    expect(path).toBe(r.path);
    expect(path.startsWith(dir)).toBe(true);
    expect(path).toMatch(/\/bash-\d+-[0-9a-f]{8}\.txt$/);
    expect(readFileSync(path, "utf-8")).toBe(full);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("cuts a single huge line mid-line", () => {
    const { head, tail, omitted } = buildPreview("x".repeat(10_000), 1000, 0.5);
    expect(head.length).toBe(500);
    expect(tail.length).toBe(500);
    expect(omitted.length).toBe(9000);
  });

  it("still answers with a preview when the file cannot be written", async () => {
    const blocker = join(root, "file");
    writeFileSync(blocker, "not a dir");
    const r = await offloadToolOutput("y".repeat(5000), { tool: "bash", dir: join(blocker, "sub"), maxChars: 1000 });
    expect(r.offloaded).toBe(true);
    expect(r.path).toBeUndefined();
    expect(r.text).toContain("the full output could not be saved");
  });
});

describe("retention", () => {
  it("deletes our files older than 7 days on write, keeps fresh and foreign files", async () => {
    const dir = join(root, "out");
    mkdirSync(dir, { recursive: true });
    const now = Date.now();
    const old = join(dir, `bash-${now - TOOL_OUTPUT_RETENTION_MS - 60_000}-0123abcd.txt`);
    const fresh = join(dir, `http_fetch-${now - 60_000}-89abcdef.txt`);
    const foreign = join(dir, "notes.txt");
    for (const f of [old, fresh, foreign]) writeFileSync(f, "x");
    const oldTime = new Date(now - TOOL_OUTPUT_RETENTION_MS - 60_000);
    utimesSync(old, oldTime, oldTime);
    utimesSync(foreign, oldTime, oldTime);

    const saved = await saveToolOutput("data", "grep", dir, now);
    const names = readdirSync(dir);
    expect(names).not.toContain(old.split("/").pop());
    expect(names).toContain(fresh.split("/").pop());
    expect(names).toContain("notes.txt");
    expect(names).toContain(saved.split("/").pop());
  });

  it("cleanup of a missing dir is a no-op", async () => {
    expect(await cleanupToolOutputDir(join(root, "missing"))).toBe(0);
  });
});

describe("withToolOutputOffload", () => {
  const fakeTool = (text: string, details: any) => ({
    name: "browser_snapshot",
    label: "x",
    description: "x",
    parameters: {} as any,
    execute: async () => ({ content: [{ type: "text" as const, text }, { type: "image" as const, data: "AAA", mimeType: "image/png" }], details }),
  });

  it("returns the same result object below the limit", async () => {
    const dir = join(root, "out");
    const tool = fakeTool("small", { a: 1 });
    const wrapped = withToolOutputOffload(tool as any, { dir, maxChars: 100 });
    const r = await wrapped.execute("id", {} as any);
    expect(r.content[0]).toEqual({ type: "text", text: "small" });
    expect(r.details).toEqual({ a: 1 });
  });

  it("offloads large text, keeps images and shrinks large details", async () => {
    const dir = join(root, "out");
    const big = "z".repeat(5000);
    const wrapped = withToolOutputOffload(fakeTool(big, { raw: big }) as any, { dir, maxChars: 1000 });
    const r = await wrapped.execute("id", {} as any);
    const text = (r.content[0] as any).text as string;
    expect(readFileSync(savedPath(text), "utf-8")).toBe(big);
    expect(r.content[1]).toMatchObject({ type: "image" });
    expect(r.details).toMatchObject({ truncated: true, outputBytes: 5000 });
    expect(r.details.raw).toBeUndefined();
  });
});

describe("system tools offload", () => {
  it("bash: small output is byte-identical", async () => {
    const tools = createSystemTools(root, undefined, undefined, join(root, "output"));
    const bash = tools.find((t) => t.name === "bash")!;
    const r = await bash.execute("id", { command: "printf 'hello\\n'" });
    expect(textOf(r)).toBe("Exit code: 0\nhello");
    expect(r.details).toEqual({ command: "printf 'hello\\n'", exitCode: 0 });
  });

  it("bash: large output → preview + full file under <outputDir>/tool-output, readable by read and grep", async () => {
    const outputDir = join(root, "output");
    const tools = createSystemTools(root, undefined, undefined, outputDir);
    const bash = tools.find((t) => t.name === "bash")!;
    const r = await bash.execute("id", { command: "seq 1 20000" });
    const text = textOf(r);
    expect(text.startsWith("Exit code: 0\n1\n2\n")).toBe(true);
    expect(text).toContain("\n20000\n");
    expect(text).toMatch(/lines \(\d+ bytes\) omitted/);
    expect(text.length).toBeLessThan(31_000);

    const path = savedPath(text);
    expect(path.startsWith(join(outputDir, "tool-output"))).toBe(true);
    const expected = Array.from({ length: 20000 }, (_, i) => String(i + 1)).join("\n");
    expect(readFileSync(path, "utf-8")).toBe(expected);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(r.details).toMatchObject({ outputPath: path, outputLines: 20000 });

    const read = tools.find((t) => t.name === "read")!;
    const page = await read.execute("id", { path, offset: 10001, limit: 3 });
    expect(textOf(page)).toBe("10001\t10001\n10002\t10002\n10003\t10003\n... (9997 more lines)");

    const grep = tools.find((t) => t.name === "grep")!;
    const hit = await grep.execute("id", { pattern: "^12345$", path });
    expect(textOf(hit)).toBe("12345:12345");
  });

  it("offload dir outside the sandbox is added read-only (read ok, write denied)", async () => {
    const work = join(root, "work");
    const polpoDir = join(root, "polpo");
    mkdirSync(work, { recursive: true });
    const tools = createSystemTools(work, undefined, [work], undefined, undefined, undefined, undefined, { polpoDir, agentName: "bob" });
    const bash = tools.find((t) => t.name === "bash")!;
    const r = await bash.execute("id", { command: "seq 1 20000" });
    const path = savedPath(textOf(r));
    expect(path.startsWith(join(polpoDir, "tmp", "tool-output", "bob"))).toBe(true);

    const read = tools.find((t) => t.name === "read")!;
    expect(textOf(await read.execute("id", { path, limit: 1 }))).toBe("1\t1\n... (19999 more lines)");
    const write = tools.find((t) => t.name === "write")!;
    await expect(write.execute("id", { path: join(polpoDir, "tmp", "tool-output", "bob", "x.txt"), content: "x" }))
      .rejects.toThrow(/sandbox/);
  });

  it("read: results above 30,000 chars stop on a line boundary and say where to continue", async () => {
    const file = join(root, "wide.txt");
    writeFileSync(file, Array.from({ length: 500 }, (_, i) => `${i}:${"a".repeat(200)}`).join("\n"));
    const read = createSystemTools(root).find((t) => t.name === "read")!;
    const r = await read.execute("id", { path: file });
    const text = textOf(r);
    expect(text.length).toBeLessThan(30_300);
    const m = text.match(/showing lines 1-(\d+) of 500\. Continue with offset=(\d+)/);
    expect(m).not.toBeNull();
    expect(Number(m![2])).toBe(Number(m![1]) + 1);
    expect(r.details).toMatchObject({ capped: true, total: 500 });
  });

  it("read: small files are unchanged", async () => {
    const file = join(root, "small.txt");
    writeFileSync(file, "a\nb");
    const read = createSystemTools(root).find((t) => t.name === "read")!;
    expect(textOf(await read.execute("id", { path: file }))).toBe("1\ta\n2\tb");
  });

  it("grep: omitted matches are saved in full", async () => {
    const src = join(root, "src");
    mkdirSync(src);
    writeFileSync(join(src, "many.txt"), Array.from({ length: 300 }, (_, i) => `match ${i}`).join("\n"));
    const tools = createSystemTools(root, undefined, undefined, join(root, "output"));
    const grep = tools.find((t) => t.name === "grep")!;
    const r = await grep.execute("id", { pattern: "match", path: src });
    const text = textOf(r);
    expect(text).toContain("200 more matches truncated");
    const saved = readFileSync(savedPath(text), "utf-8");
    expect(saved.trimEnd().split("\n")).toHaveLength(300);
    expect(saved).toContain("many.txt:300:match 299");
  });
});

describe("http_fetch offload", () => {
  const stubFetch = (body: string) =>
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 200, statusText: "OK", headers: { "content-type": "application/json" } })));

  it("small bodies are byte-identical", async () => {
    stubFetch('{"ok":true}');
    const [fetchTool] = createHttpTools(root, undefined, ["http_fetch"], join(root, "out"));
    const r = await fetchTool.execute("id", { url: "https://example.com/small" });
    expect(textOf(r)).toBe('Status: 200 OK\nHeaders: {"content-type":"application/json"}\n\n{"ok":true}');
    expect(r.details.outputPath).toBeUndefined();
  });

  it("bodies above 30 KB are saved to a file (limit lowered from 100 KB)", async () => {
    const body = JSON.stringify(Array.from({ length: 2000 }, (_, i) => ({ id: i, name: `item-${i}` })), null, 1);
    expect(body.length).toBeGreaterThan(30_000);
    expect(body.length).toBeLessThan(100_000);
    stubFetch(body);
    const dir = join(root, "out");
    const [fetchTool] = createHttpTools(root, undefined, ["http_fetch"], dir);
    const r = await fetchTool.execute("id", { url: "https://example.com/big" });
    const text = textOf(r);
    expect(text.startsWith('Status: 200 OK\nHeaders: {"content-type":"application/json"}\n\n[\n {\n  "id": 0,')).toBe(true);
    expect(text).toContain('"name": "item-1999"');
    const path = savedPath(text);
    expect(path.startsWith(dir)).toBe(true);
    expect(readFileSync(path, "utf-8")).toBe(body);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(r.details).toMatchObject({ outputPath: path, outputBytes: body.length });
  });
});
