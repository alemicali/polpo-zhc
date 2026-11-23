/**
 * The coding tools (read, write, edit, bash, glob, grep, ls) after taking the best of Pi's tools:
 * grep never runs user input through a shell, parallel edits of one file all land, edit keeps
 * line endings and BOM and tolerates small differences, read streams and refuses what is not
 * text, and the errors say what to do.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { spawnSync, execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { FileEntry, FileStat, FileSystem } from "@polpo-ai/core/filesystem";
import type { Shell, ShellOptions, ShellResult } from "@polpo-ai/core/shell";
import { createSystemTools, bashTimeoutMs, prepareEditArguments } from "../tools/system-tools.js";
import { grepSearch, hasRipgrep } from "../tools/grep-search.js";
import { NodeShell } from "../adapters/node-shell.js";
import { applyEdits, closestLines } from "../tools/edit-text.js";
import { codingFileRules, describeToolsForAgent, buildPrompt } from "../adapters/engine.js";

const out = (r: any) => r.content.map((c: any) => c.text ?? "").join("\n");
const hasRg = spawnSync("rg", ["--version"]).status === 0;

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "polpo-coding-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function tools(opts: { fs?: FileSystem; shell?: Shell; cwd?: string } = {}) {
  const all = createSystemTools(opts.cwd ?? dir, undefined, undefined, join(dir, ".out"), undefined, opts.fs, opts.shell);
  return (name: string) => all.find((t) => t.name === name)!;
}

/** A remote VM's files in memory (paths under /vm, which does not exist here), optionally slow. */
class VmFs implements FileSystem {
  files = new Map<string, Uint8Array>();
  dirs = new Set<string>(["/", "/vm", "/vm/work"]);
  calls: string[] = [];
  constructor(private readonly delayMs = 0) {}
  private wait() { return this.delayMs ? new Promise((r) => setTimeout(r, this.delayMs)) : Promise.resolve(); }
  async readFile(p: string) { return new TextDecoder().decode(await this.readFileBuffer(p)); }
  async readFileBuffer(p: string) {
    this.calls.push(`read ${p}`);
    await this.wait();
    const f = this.files.get(p);
    if (!f) throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
    return new Uint8Array(f);
  }
  async writeFile(p: string, c: string) { await this.writeFileBuffer(p, new TextEncoder().encode(c)); }
  async writeFileBuffer(p: string, d: Uint8Array) {
    this.calls.push(`write ${p}`);
    await this.wait();
    this.files.set(p, new Uint8Array(d));
  }
  async exists(p: string) { return this.files.has(p) || this.dirs.has(p); }
  async readdir(p: string) { this.calls.push(`readdir ${p}`); return (await this.entries(p)).map((e) => e.name); }
  async readdirWithTypes(p: string): Promise<FileEntry[]> { this.calls.push(`readdirWithTypes ${p}`); return this.entries(p); }
  private async entries(p: string): Promise<FileEntry[]> {
    if (!this.dirs.has(p)) throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
    const files = [...this.files.keys()].filter((f) => dirname(f) === p).map((f) => ({ name: f.slice(p.length + 1), isDirectory: false, isFile: true }));
    const dirs = [...this.dirs].filter((d) => d !== p && dirname(d) === p).map((d) => ({ name: d.slice(p.length + 1), isDirectory: true, isFile: false }));
    return [...files, ...dirs];
  }
  async mkdir(p: string) { for (let x = p; x !== "/"; x = dirname(x)) this.dirs.add(x); }
  async remove(p: string) { this.files.delete(p); }
  async stat(p: string): Promise<FileStat> {
    this.calls.push(`stat ${p}`);
    const f = this.files.get(p);
    if (f) return { size: f.byteLength, isFile: true, isDirectory: false };
    if (this.dirs.has(p)) return { size: 0, isFile: false, isDirectory: true };
    throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
  }
  async rename(a: string, b: string) { this.files.set(b, this.files.get(a)!); this.files.delete(a); }
  text(p: string) { return Buffer.from(this.files.get(p)!).toString("utf8"); }
}

/**
 * A remote VM's shell: takes a command line only and runs it with a real POSIX `sh` (in a local
 * directory standing in for the VM), so quoting mistakes would really execute. `noRipgrep` makes
 * `rg` missing, as on a VM without it.
 */
class ShShell implements Shell {
  commands: string[] = [];
  constructor(private readonly noRipgrep = false) {}
  async execute(command: string, options: ShellOptions = {}): Promise<ShellResult> {
    this.commands.push(command);
    if (this.noRipgrep && /^'rg'/.test(command)) return { stdout: "", stderr: "sh: 1: rg: not found", exitCode: 127 };
    const r = spawnSync("sh", ["-c", command], { cwd: options.cwd, encoding: "utf8", timeout: options.timeout });
    return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", exitCode: r.status ?? 1 };
  }
}

describe("grep: user input never reaches a shell unquoted", () => {
  const payloads = ["$(touch PWNED)", "`touch PWNED`", "\"; touch PWNED; echo \"", "'; touch PWNED; echo '", "x\" $(touch PWNED) \""];

  test("local (NodeShell): the pattern, glob and path are plain arguments", async () => {
    writeFileSync(join(dir, "a.txt"), "hello $(touch PWNED) world\n");
    const grep = tools()("grep");
    for (const pattern of payloads) {
      await grep.execute("t", { pattern, literal: true, glob: "*.txt" });
      await grep.execute("t", { pattern: "hello", glob: pattern });
    }
    expect(existsSync(join(dir, "PWNED"))).toBe(false);
    const r = await grep.execute("t", { pattern: "$(touch PWNED)", literal: true });
    expect(out(r)).toBe("a.txt:1:hello $(touch PWNED) world");
    expect(existsSync(join(dir, "PWNED"))).toBe(false);
  });

  test.each([["rg"], ["grep"]] as const)("remote shell (%s): every argument single-quoted for sh", async (engine) => {
    if (engine === "rg" && !hasRg) return;
    writeFileSync(join(dir, "a.txt"), "it's \"quoted\" $(touch PWNED)\n");
    const shell = new ShShell(engine === "grep");
    const grep = tools({ shell })("grep");
    for (const pattern of payloads) {
      await grep.execute("t", { pattern, literal: true });
      await grep.execute("t", { pattern: "x", glob: pattern, path: "." });
    }
    expect(existsSync(join(dir, "PWNED"))).toBe(false);
    const r: any = await grep.execute("t", { pattern: "it's \"quoted\" $(touch PWNED)", literal: true });
    expect(out(r)).toBe("a.txt:1:it's \"quoted\" $(touch PWNED)");
    expect(r.details.engine).toBe(engine);
    expect(existsSync(join(dir, "PWNED"))).toBe(false);
    expect(shell.commands.some((c) => c.includes("'$(touch PWNED)'"))).toBe(true);
  });
});

describe("grep", () => {
  beforeEach(() => {
    mkdirSync(join(dir, "src", "deep"), { recursive: true });
    mkdirSync(join(dir, "node_modules", "lib"), { recursive: true });
    writeFileSync(join(dir, "src", "a.ts"), "const Alpha = 1;\nconst beta = 2;\n// alpha again\nconst gamma = 3;\n");
    writeFileSync(join(dir, "src", "deep", "b.md"), "Alpha in markdown\r\n");
    writeFileSync(join(dir, "node_modules", "lib", "c.ts"), "Alpha vendored\n");
    writeFileSync(join(dir, "bin.dat"), Buffer.from([0x41, 0x6c, 0x70, 0x68, 0x61, 0, 1, 2]));
  });

  test.each([["rg"], ["grep"]] as const)("%s: relative paths, options, binary and node_modules skipped", async (engine) => {
    if (engine === "rg" && !hasRg) return;
    const shell = new ShShell(engine === "grep");
    const grep = tools({ shell })("grep");
    if (engine === "rg") execFileSync("git", ["init", "-q"], { cwd: dir });
    if (engine === "rg") writeFileSync(join(dir, ".gitignore"), "node_modules\n");
    expect(out(await grep.execute("t", { pattern: "Alpha" }))).toBe("src/a.ts:1:const Alpha = 1;\nsrc/deep/b.md:1:Alpha in markdown");
    expect(out(await grep.execute("t", { pattern: "alpha", ignore_case: true, glob: "*.ts" }))).toBe("src/a.ts:1:const Alpha = 1;\nsrc/a.ts:3:// alpha again");
    expect(out(await grep.execute("t", { pattern: "beta", context: 1, path: "src" }))).toBe("src/a.ts-1-const Alpha = 1;\nsrc/a.ts:2:const beta = 2;\nsrc/a.ts-3-// alpha again");
    expect(out(await grep.execute("t", { pattern: "a.p", literal: true }))).toBe("No matches found");
    const limited: any = await grep.execute("t", { pattern: "const", limit: 2 });
    expect(out(limited)).toMatch(/^src\/a\.ts:1:const Alpha = 1;\nsrc\/a\.ts:2:const beta = 2;\n… 1 more match truncated \(3 in all\); use limit=4/);
    expect(limited.details).toMatchObject({ count: 3, shown: 2, truncated: true, engine });
    // a single file: no file name, as before
    expect(out(await grep.execute("t", { pattern: "gamma", path: "src/a.ts" }))).toBe("4:const gamma = 3;");
  });

  test("ripgrep respects .gitignore", async () => {
    if (!hasRg) return;
    execFileSync("git", ["init", "-q"], { cwd: dir });
    writeFileSync(join(dir, ".gitignore"), "src/deep\nnode_modules\n");
    expect(out(await tools()("grep").execute("t", { pattern: "Alpha" }))).toBe("src/a.ts:1:const Alpha = 1;");
  });

  test.each([["rg"], ["grep"]] as const)("%s: an invalid regex is an error, not 'No matches'", async (engine) => {
    if (engine === "rg" && !hasRg) return;
    const r: any = await tools({ shell: new ShShell(engine === "grep") })("grep").execute("t", { pattern: "foo(" });
    expect(r.isError).toBe(true);
    expect(out(r)).toMatch(/^Error: invalid regex "foo\(":/);
    expect(out(r)).toMatch(/literal: true/);
  });

  test("ripgrep when installed, grep otherwise (checked once per shell)", async () => {
    const vm = new ShShell(true);
    expect(await hasRipgrep(vm, dir)).toBe(false);
    const r = await grepSearch(vm, { pattern: "beta", path: ".", cwd: dir });
    expect(r).toMatchObject({ ok: true, engine: "grep", matches: 1 });
    expect(vm.commands.filter((c) => c.startsWith("'rg'"))).toHaveLength(1);
    if (hasRg) expect(await hasRipgrep(new NodeShell())).toBe(true);
  });
});

describe("edit", () => {
  const edit = (args: any, opts?: Parameters<typeof tools>[0]) => tools(opts)("edit").execute("t", args);
  const file = (name: string) => readFileSync(join(dir, name), "utf8");

  test("CRLF: matched on LF, written back with CRLF (new lines too)", async () => {
    writeFileSync(join(dir, "w.txt"), "one\r\ntwo\r\nthree\r\n");
    const r = await edit({ path: "w.txt", old_text: "two\nthree", new_text: "2\n2b\nthree" });
    expect(out(r)).toMatch(/^Edited .*w\.txt: 1 replacement, first change at line 2$/);
    expect(file("w.txt")).toBe("one\r\n2\r\n2b\r\nthree\r\n");
  });

  test("a byte order mark is kept", async () => {
    writeFileSync(join(dir, "b.txt"), "﻿hello\nworld\n");
    await edit({ path: "b.txt", old_text: "hello", new_text: "ciao" });
    expect(readFileSync(join(dir, "b.txt"))).toEqual(Buffer.from("﻿ciao\nworld\n"));
  });

  test("tabs vs spaces: not found, with the closest lines and the first difference", async () => {
    writeFileSync(join(dir, "t.ts"), "function f() {\n\treturn 1;\n}\n");
    const r: any = await edit({ path: "t.ts", old_text: "function f() {\n    return 1;\n}", new_text: "x" });
    expect(r.isError).toBe(true);
    expect(out(r)).toContain("old_text not found in");
    expect(out(r)).toContain("Closest match, lines 1-3:\n1\tfunction f() {\n2\t\treturn 1;\n3\t}");
    expect(out(r)).toContain('First difference: old_text line 2, column 1 has "    return 1", the file has "\\treturn 1;\\n}"');
    expect(file("t.ts")).toBe("function f() {\n\treturn 1;\n}\n");
  });

  test("smart quotes, dashes, trailing spaces: fuzzy match, only the touched lines change", async () => {
    writeFileSync(join(dir, "q.md"), "Title — “quoted”\nSay “hello”   \nKeep “these”\n");
    const r: any = await edit({ path: "q.md", old_text: "Say \"hello\"", new_text: "Say \"bye\"" });
    expect(r.details.fuzzy).toBe(true);
    expect(file("q.md")).toBe("Title — “quoted”\nSay \"bye\"\nKeep “these”\n");
  });

  test("repeated text: error with line numbers; replace_all replaces every one", async () => {
    writeFileSync(join(dir, "r.txt"), "x = 1\ny = 2\nx = 1\n");
    const r: any = await edit({ path: "r.txt", old_text: "x = 1", new_text: "x = 9" });
    expect(out(r)).toMatch(/old_text found 2 times in .*r\.txt \(lines 1, 3\)/);
    expect(r.details.error).toBe("not_unique");
    const all: any = await edit({ path: "r.txt", old_text: "x = 1", new_text: "x = 9", replace_all: true });
    expect(out(all)).toMatch(/2 replacements/);
    expect(file("r.txt")).toBe("x = 9\ny = 2\nx = 9\n");
  });

  test("edits[]: matched against the original, overlaps refused (nothing written)", async () => {
    writeFileSync(join(dir, "m.txt"), "a\nb\nc\nd\n");
    await edit({ path: "m.txt", edits: [{ old_text: "a", new_text: "b" }, { old_text: "b", new_text: "B" }, { old_text: "d", new_text: "D" }] });
    expect(file("m.txt")).toBe("b\nB\nc\nD\n");
    const r: any = await edit({ path: "m.txt", edits: [{ old_text: "B\nc", new_text: "x" }, { old_text: "c\nD", new_text: "y" }] });
    expect(out(r)).toMatch(/edits\[0\] and edits\[1\] overlap/);
    expect(file("m.txt")).toBe("b\nB\nc\nD\n");
    const missing: any = await edit({ path: "m.txt", edits: [{ old_text: "c", new_text: "C" }, { old_text: "zzz", new_text: "y" }] });
    expect(out(missing)).toMatch(/edits\[1\]\.old_text not found/);
    expect(file("m.txt")).toBe("b\nB\nc\nD\n");
  });

  test("edits as a JSON string, camelCase names, a single edit object", async () => {
    writeFileSync(join(dir, "j.txt"), "one two three\n");
    await edit({ path: "j.txt", edits: JSON.stringify([{ oldText: "one", newText: "1" }]) });
    await edit({ path: "j.txt", oldText: "two", newText: "2" });
    await edit({ path: "j.txt", edits: { old_string: "three", new_string: "3" } });
    expect(file("j.txt")).toBe("1 2 3\n");
    expect(prepareEditArguments({ path: "p", old_text: "a", new_text: "b", edits: [{ oldText: "c", newText: "d" }] }))
      .toEqual({ path: "p", edits: [{ old_text: "c", new_text: "d" }, { old_text: "a", new_text: "b" }] });
  });

  test("clear errors: empty old_text, no change, missing new_text, missing file", async () => {
    writeFileSync(join(dir, "e.txt"), "same\n");
    expect(out(await edit({ path: "e.txt", old_text: "", new_text: "x" }))).toMatch(/old_text is empty/);
    expect(out(await edit({ path: "e.txt", old_text: "same", new_text: "same" }))).toMatch(/no change made/);
    expect(out(await edit({ path: "e.txt", old_text: "same" }))).toMatch(/new_text is missing/);
    expect(out(await edit({ path: "nope.txt", old_text: "a", new_text: "b" }))).toMatch(/file not found: .*nope\.txt\. To create a file use write/);
  });

  test("old_text copied with read's line numbers: the hint is kept", async () => {
    writeFileSync(join(dir, "n.txt"), "alpha\nbeta\n");
    const r = await edit({ path: "n.txt", old_text: "1\talpha\n2\tbeta", new_text: "x" });
    expect(out(r)).toMatch(/not found.*line numbers like the ones the read tool shows/s);
  });

  test("parallel edits of one file all land (local disk)", async () => {
    writeFileSync(join(dir, "p.txt"), Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n") + "\n");
    const e = tools()("edit");
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => e.execute(`t${i}`, { path: "p.txt", old_text: `line ${i}\n`, new_text: `LINE ${i}\n` })));
    expect(results.every((r: any) => !r.isError)).toBe(true);
    expect(file("p.txt")).toBe(Array.from({ length: 20 }, (_, i) => `LINE ${i}`).join("\n") + "\n");
  });

  test("parallel edits and writes of one file all land (slow remote fs)", async () => {
    const vm = new VmFs(5);
    vm.files.set("/vm/work/f.txt", Buffer.from("a\nb\nc\n"));
    const t = tools({ fs: vm, cwd: "/vm/work" });
    await Promise.all([
      t("edit").execute("1", { path: "f.txt", old_text: "a", new_text: "A" }),
      t("edit").execute("2", { path: "f.txt", old_text: "b", new_text: "B" }),
      t("edit").execute("3", { path: "/vm/work/f.txt", old_text: "c", new_text: "C" }),
    ]);
    expect(vm.text("/vm/work/f.txt")).toBe("A\nB\nC\n");
    // write then edit, issued together: the edit sees the written content
    await Promise.all([
      t("write").execute("4", { path: "f.txt", content: "fresh\n" }),
      t("edit").execute("5", { path: "f.txt", old_text: "fresh", new_text: "edited" }),
    ]);
    expect(vm.text("/vm/work/f.txt")).toBe("edited\n");
    expect(existsSync("/vm")).toBe(false);
  });

  test("CRLF and BOM through a remote fs", async () => {
    const vm = new VmFs();
    vm.files.set("/vm/work/w.txt", Buffer.from("﻿a\r\nb\r\n"));
    await tools({ fs: vm, cwd: "/vm/work" })("edit").execute("t", { path: "w.txt", old_text: "b", new_text: "b\nc" });
    expect(vm.text("/vm/work/w.txt")).toBe("﻿a\r\nb\r\nc\r\n");
  });

  test("closest lines picks the window with most lines in common", () => {
    const content = "x\nfoo()\nbar()\ny\nfoo()\nbar ()\nbaz()\n";
    expect(closestLines(content, "foo()\nbar ()\nbaz ()")).toEqual({ start: 4, lines: ["foo()", "bar ()", "baz()"] });
    expect(() => applyEdits("abc", [{ oldText: "b", newText: "x" }, { oldText: "abc", newText: "y" }], "f")).toThrow(/overlap/);
  });
});

describe("read", () => {
  const read = (args: any, opts?: Parameters<typeof tools>[0]) => tools(opts)("read").execute("t", args);

  test("no phantom last line; CRLF lines shown plain; the BOM hidden", async () => {
    writeFileSync(join(dir, "a.txt"), "﻿a\r\nb\r\n");
    const r: any = await read({ path: "a.txt" });
    expect(out(r)).toBe("1\ta\n2\tb");
    expect(r.details).toMatchObject({ lines: 2, total: 2 });
  });

  test("offset past the end is an error with the line count; truncation says where to continue", async () => {
    writeFileSync(join(dir, "n.txt"), "1\n2\n3\n");
    const r: any = await read({ path: "n.txt", offset: 4 });
    expect(r.isError).toBe(true);
    expect(out(r)).toMatch(/offset 4 is past the end of .*n\.txt \(3 lines\)/);
    expect(out(await read({ path: "n.txt", limit: 1 }))).toBe("1\t1\n... (2 more lines; continue with offset=2)");
    expect(out(await read({ path: "n.txt", offset: 3 }))).toBe("3\t3");
  });

  test("empty file", async () => {
    writeFileSync(join(dir, "e.txt"), "");
    expect(out(await read({ path: "e.txt" }))).toBe("(empty file)");
  });

  test("a big file is streamed: the last lines and the total, 500 lines at most", async () => {
    writeFileSync(join(dir, "big.txt"), Array.from({ length: 100_000 }, (_, i) => `row ${i + 1}`).join("\n") + "\n");
    const r: any = await read({ path: "big.txt", offset: 99_999 });
    expect(out(r)).toBe("99999\trow 99999\n100000\trow 100000");
    const first: any = await read({ path: "big.txt" });
    expect(first.details).toMatchObject({ lines: 500, total: 100_000 });
    expect(out(first)).toMatch(/\(99500 more lines; continue with offset=501\)$/);
  });

  test("files over 20 MB are refused with a grep/sed hint", async () => {
    const path = join(dir, "huge.log");
    writeFileSync(path, "");
    truncateSync(path, 21 * 1024 * 1024);
    const r: any = await read({ path: "huge.log" });
    expect(r.isError).toBe(true);
    expect(out(r)).toMatch(/21\.0 MB, over the 20 MB read limit\. Search it with grep, or print a part with bash \(e\.g\. sed -n/);
  });

  test("binary files and images point elsewhere, never decoded", async () => {
    writeFileSync(join(dir, "x.bin"), Buffer.from([1, 2, 0, 3, 4]));
    expect(out(await read({ path: "x.bin" }))).toMatch(/is a binary file \(5 B\): read shows text only/);
    writeFileSync(join(dir, "pic.png"), Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100)]));
    const img: any = await read({ path: "pic.png" });
    expect(out(img)).toMatch(/is an image \(image\/png, 108 B\).*Use read_attachment to view it/);
    expect(img.content).toHaveLength(1);
    writeFileSync(join(dir, "doc.pdf"), "%PDF-1.7\nhello");
    expect(out(await read({ path: "doc.pdf" }))).toMatch(/is a PDF/);
  });

  test("through a remote fs: same rules", async () => {
    const vm = new VmFs();
    vm.files.set("/vm/work/r.txt", Buffer.from("x\r\ny\n"));
    vm.files.set("/vm/work/i.jpg", Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]));
    const t = (args: any) => read(args, { fs: vm, cwd: "/vm/work" });
    expect(out(await t({ path: "r.txt" }))).toBe("1\tx\n2\ty");
    expect(out(await t({ path: "r.txt", offset: 9 }))).toMatch(/past the end .* \(2 lines\)/);
    expect(out(await t({ path: "i.jpg" }))).toMatch(/image\/jpeg/);
    expect(out(await t({ path: "missing.txt" }))).toMatch(/file not found/);
  });
});

describe("write, glob, ls, bash", () => {
  test("write reports bytes, not characters", async () => {
    const r: any = await tools()("write").execute("t", { path: "u.txt", content: "è€😀" });
    expect(r.details.bytes).toBe(2 + 3 + 4);
    expect(out(r)).toMatch(/\(9 bytes\)$/);
  });

  test("glob: limit, and a notice when it cut the results", async () => {
    for (let i = 0; i < 5; i++) writeFileSync(join(dir, `f${i}.txt`), "x");
    const r: any = await tools()("glob").execute("t", { pattern: "*.txt", limit: 3 });
    expect(out(r)).toBe("f0.txt\nf1.txt\nf2.txt\n\n[3 files limit reached: there are more. Use limit=6, or a narrower pattern or path]");
    expect(r.details).toMatchObject({ count: 3, truncated: true });
    expect(out(await tools()("glob").execute("t", { pattern: "*.txt", limit: 5 }))).not.toMatch(/limit reached/);
  });

  test("ls: sorted, (empty directory), limit with notice", async () => {
    mkdirSync(join(dir, "Zdir"));
    mkdirSync(join(dir, "empty"));
    writeFileSync(join(dir, "b.txt"), "");
    writeFileSync(join(dir, "A.txt"), "");
    const ls = tools()("ls");
    expect(out(await ls.execute("t", {}))).toBe("A.txt\nb.txt\nempty/\nZdir/");
    expect(out(await ls.execute("t", { path: "empty" }))).toBe("(empty directory)");
    expect(out(await ls.execute("t", { limit: 2 }))).toBe("A.txt\nb.txt\n\n[2 of 4 entries shown. Use limit=4 for more, or glob to find files]");
    expect(out(await ls.execute("t", { path: "nope" }))).toMatch(/directory not found/);
  });

  test("ls on a remote fs: one call with the types, no stat per entry", async () => {
    const vm = new VmFs();
    vm.files.set("/vm/work/b.txt", Buffer.from(""));
    vm.files.set("/vm/work/a.txt", Buffer.from(""));
    await vm.mkdir("/vm/work/sub");
    const r = await tools({ fs: vm, cwd: "/vm/work" })("ls").execute("t", {});
    expect(out(r)).toBe("a.txt\nb.txt\nsub/");
    expect(vm.calls).toEqual(["readdirWithTypes /vm/work"]);
  });

  test("bash: (no output), and timeouts below 1000 are seconds", async () => {
    expect(out(await tools()("bash").execute("t", { command: "true" }))).toBe("Exit code: 0\n(no output)");
    expect(bashTimeoutMs(undefined)).toBe(120_000);
    expect(bashTimeoutMs(300)).toBe(300_000);
    expect(bashTimeoutMs(1500)).toBe(1500);
    let seen: number | undefined;
    const shell: Shell = { execute: async (_c, o) => { seen = o?.timeout; return { stdout: "ok", stderr: "", exitCode: 0 }; } };
    await tools({ shell })("bash").execute("t", { command: "x", timeout: 5 });
    expect(seen).toBe(5000);
  });

  test("bash: a timeout says so and suggests the background", async () => {
    const r: any = await tools()("bash").execute("t", { command: "echo started; sleep 3", timeout: 1500 });
    expect(r.isError).toBe(true);
    expect(out(r)).toMatch(/^Error: the command timed out after 1\.5 s and was stopped\. Run long-lived servers and watchers in the background/);
    expect(out(r)).toContain("started");
    expect(r.details).toMatchObject({ timedOut: true, timeoutMs: 1500 });
  }, 10_000);
});

describe("prompt", () => {
  test("file rules name only the tools the agent has", () => {
    const full = codingFileRules({ name: "a" } as any).join("\n");
    expect(full).toMatch(/`read`, not `cat`, `head` or `sed` in bash/);
    expect(full).toMatch(/`edits` \(a list of `\{ old_text, new_text \}`\)/);
    expect(full).toMatch(/`write` only for new files or complete rewrites/);
    const readOnly = codingFileRules({ name: "a", allowedTools: ["read", "grep"] } as any).join("\n");
    expect(readOnly).not.toMatch(/bash|edit|write|glob/);
    expect(readOnly).toMatch(/`grep` to search contents/);
    expect(codingFileRules({ name: "a", allowedTools: ["http_fetch"] } as any)).toEqual([]);
    expect(describeToolsForAgent({ name: "a" } as any)).toMatch(/120 s default timeout/);
  });

  test("the bash rules state the real default timeout", () => {
    const prompt = buildPrompt({ title: "t", description: "d", expectations: [] } as any);
    expect(prompt).toContain("default timeout of 120 seconds");
    expect(prompt).not.toContain("30 seconds");
  });
});
