// Copied from lumea-labs/polpo (packages/node/src/sandbox/shell-backed-fs.test.ts) at 8ef8e9c.
// Copyright 2026-present Lumea Labs. Licensed under the Apache License, Version 2.0:
// http://www.apache.org/licenses/LICENSE-2.0
// Unmodified: keep it in sync with upstream rather than editing it here.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ShellBackedFileSystem } from "./shell-backed-fs.js";
import { NodeShell } from "../adapters/node-shell.js";

// Integration test: drive ShellBackedFileSystem over a real NodeShell in a
// temp dir. Exercises the actual base64/find/stat/mkdir coreutils path.
describe("ShellBackedFileSystem (over NodeShell)", () => {
  let dir: string;
  let fs: ShellBackedFileSystem;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "polpo-sbfs-"));
    fs = new ShellBackedFileSystem(new NodeShell());
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("round-trips text via writeFile/readFile", async () => {
    const p = join(dir, "note.txt");
    await fs.writeFile(p, "hello 'quoted' & $pecial\nlines");
    expect(await fs.readFile(p)).toBe("hello 'quoted' & $pecial\nlines");
  });

  it("round-trips binary via writeFileBuffer/readFileBuffer", async () => {
    const p = join(dir, "blob.bin");
    const data = new Uint8Array([0, 1, 2, 255, 254, 10, 13, 0]);
    await fs.writeFileBuffer(p, data);
    expect(Array.from(await fs.readFileBuffer(p))).toEqual(Array.from(data));
  });

  it("mkdir + exists", async () => {
    const sub = join(dir, "a/b/c");
    expect(await fs.exists(sub)).toBe(false);
    await fs.mkdir(sub);
    expect(await fs.exists(sub)).toBe(true);
  });

  it("readdir + readdirWithTypes report files and dirs", async () => {
    await fs.writeFile(join(dir, "f1.txt"), "x");
    await fs.mkdir(join(dir, "d1"));
    const names = (await fs.readdir(dir)).sort();
    expect(names).toEqual(["d1", "f1.txt"]);

    const typed = (await fs.readdirWithTypes(dir)).sort((a, b) => a.name.localeCompare(b.name));
    expect(typed).toEqual([
      { name: "d1", isDirectory: true, isFile: false },
      { name: "f1.txt", isDirectory: false, isFile: true },
    ]);
  });

  it("stat reports size + type", async () => {
    const p = join(dir, "sized.txt");
    await fs.writeFile(p, "12345"); // 5 bytes
    const s = await fs.stat(p);
    expect(s.size).toBe(5);
    expect(s.isFile).toBe(true);
    expect(s.isDirectory).toBe(false);

    const ds = await fs.stat(dir);
    expect(ds.isDirectory).toBe(true);
  });

  it("rename moves a file", async () => {
    const a = join(dir, "old.txt");
    const b = join(dir, "new.txt");
    await fs.writeFile(a, "data");
    await fs.rename(a, b);
    expect(await fs.exists(a)).toBe(false);
    expect(await fs.readFile(b)).toBe("data");
  });

  it("remove deletes recursively", async () => {
    const sub = join(dir, "tree");
    await fs.mkdir(join(sub, "inner"));
    await fs.writeFile(join(sub, "inner", "f.txt"), "x");
    await fs.remove(sub);
    expect(await fs.exists(sub)).toBe(false);
  });

  it("stat on a missing path throws", async () => {
    await expect(fs.stat(join(dir, "nope"))).rejects.toThrow();
  });
});
