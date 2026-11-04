import { describe, expect, test, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { globToRegExp } from "../tools/glob-files.js";
import { createSystemTools } from "../tools/system-tools.js";

describe("glob patterns", () => {
  test("names, paths, ** and alternatives", () => {
    expect(globToRegExp("*.md").test("a/b/note.md")).toBe(true);      // no "/": any depth, as find -name
    expect(globToRegExp("*.md").test("note.txt")).toBe(false);
    expect(globToRegExp("docs/report.md").test("docs/report.md")).toBe(true);
    expect(globToRegExp("docs/report.md").test("x/docs/report.md")).toBe(false);
    expect(globToRegExp("src/**/*.ts").test("src/a.ts")).toBe(true);
    expect(globToRegExp("src/**/*.ts").test("src/a/b/c.ts")).toBe(true);
    expect(globToRegExp("src/*.ts").test("src/a/b.ts")).toBe(false);
    expect(globToRegExp("**/*.{md,txt}").test("a/b.txt")).toBe(true);
    expect(globToRegExp("file-0[1-3].txt").test("r/file-02.txt")).toBe(true);
    expect(globToRegExp("file-0[1-3].txt").test("r/file-07.txt")).toBe(false);
    expect(globToRegExp("a.b").test("axb")).toBe(false);                 // "." is literal
  });
});

describe("glob tool", () => {
  let dir: string;
  const glob = async (pattern: string, path?: string) => {
    const tool = createSystemTools(dir).find((t) => t.name === "glob")!;
    const r: any = await tool.execute("t", { pattern, ...(path ? { path } : {}) } as any);
    return r.content[0].text as string;
  };
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "polpo-glob-"));
    mkdirSync(join(dir, "test-agenti", "dati", "ricerca"), { recursive: true });
    mkdirSync(join(dir, "node_modules", "x"), { recursive: true });
    writeFileSync(join(dir, "test-agenti", "dati", "testo.md"), "x");
    writeFileSync(join(dir, "test-agenti", "dati", "ricerca", "file-01.txt"), "x");
    writeFileSync(join(dir, "test-agenti", "dati", "ricerca", "file-02.txt"), "x");
    writeFileSync(join(dir, "node_modules", "x", "readme.md"), "x");
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("a path pattern finds the file (seen: 'No files found', and the agent gave up)", async () => {
    expect(await glob("test-agenti/dati/testo.md")).toBe("test-agenti/dati/testo.md");
  });

  test("names at any depth, ** patterns, a search folder; node_modules only when named", async () => {
    expect(await glob("*.txt")).toBe("test-agenti/dati/ricerca/file-01.txt\ntest-agenti/dati/ricerca/file-02.txt");
    expect(await glob("**/*.md")).toBe("test-agenti/dati/testo.md");
    expect(await glob("*.txt", "test-agenti/dati/ricerca")).toBe("test-agenti/dati/ricerca/file-01.txt\ntest-agenti/dati/ricerca/file-02.txt");
    expect(await glob("node_modules/**/*.md")).toBe("node_modules/x/readme.md");
    expect(await glob("*.pdf")).toBe("No files found");
  });
});
