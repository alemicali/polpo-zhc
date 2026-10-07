// Copied from lumea-labs/polpo (packages/node/src/sandbox/shell-backed-fs.ts) at 8ef8e9c.
// Copyright 2026-present Lumea Labs. Licensed under the Apache License, Version 2.0:
// http://www.apache.org/licenses/LICENSE-2.0
// Unmodified: keep it in sync with upstream rather than editing it here.
/**
 * ShellBackedFileSystem — a {@link FileSystem} implemented entirely over a
 * {@link Shell}. Metadata ops map to coreutils (`test`, `mkdir`, `rm`, `mv`,
 * `ls`, `find`, `stat`); data ops move bytes through `base64` so binary content
 * survives the shell round-trip.
 *
 * This is the reusable core of any shell-only sandbox backend (Docker `exec`,
 * a remote VM's `run`, …): give it a Shell and it becomes a full FileSystem,
 * no backend-specific file API required. Backends with a native file-transfer
 * primitive (Daytona `fs.uploadFile`, Arker `sync`) should override the data
 * ops for efficiency; this class is the portable fallback.
 *
 * Assumes GNU coreutils (`find -printf`, `stat -c`) — i.e. a Linux container,
 * which is the case for every sandbox backend. `base64`-over-argv also caps the
 * practical single-file size at the shell's ARG_MAX; large binaries want a
 * native transfer primitive.
 */
import type { FileSystem, FileEntry, FileStat, Shell } from "@polpo-ai/core";

/** Single-quote a string for safe interpolation into a shell command. */
function shq(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

export class ShellBackedFileSystem implements FileSystem {
  constructor(private readonly shell: Shell) {}

  async readFile(path: string): Promise<string> {
    return new TextDecoder().decode(await this.readFileBuffer(path));
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    const r = await this.shell.execute(`base64 ${shq(path)}`);
    if (r.exitCode !== 0) throw new Error(`readFile ${path}: ${r.stderr.trim() || "failed"}`);
    return Uint8Array.from(Buffer.from(r.stdout, "base64"));
  }

  async writeFile(path: string, content: string): Promise<void> {
    await this.writeFileBuffer(path, new TextEncoder().encode(content));
  }

  async writeFileBuffer(path: string, data: Uint8Array): Promise<void> {
    const b64 = Buffer.from(data).toString("base64");
    const r = await this.shell.execute(`printf '%s' ${shq(b64)} | base64 -d > ${shq(path)}`);
    if (r.exitCode !== 0) throw new Error(`writeFile ${path}: ${r.stderr.trim() || "failed"}`);
  }

  async exists(path: string): Promise<boolean> {
    return (await this.shell.execute(`test -e ${shq(path)}`)).exitCode === 0;
  }

  async mkdir(path: string): Promise<void> {
    const r = await this.shell.execute(`mkdir -p ${shq(path)}`);
    if (r.exitCode !== 0) throw new Error(`mkdir ${path}: ${r.stderr.trim() || "failed"}`);
  }

  async remove(path: string): Promise<void> {
    await this.shell.execute(`rm -rf ${shq(path)}`);
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const r = await this.shell.execute(`mv ${shq(oldPath)} ${shq(newPath)}`);
    if (r.exitCode !== 0) throw new Error(`rename ${oldPath} → ${newPath}: ${r.stderr.trim() || "failed"}`);
  }

  async readdir(path: string): Promise<string[]> {
    const r = await this.shell.execute(`ls -1A ${shq(path)}`);
    return r.exitCode === 0 ? r.stdout.split("\n").filter(Boolean) : [];
  }

  async readdirWithTypes(path: string): Promise<FileEntry[]> {
    // `find` one level deep with a type marker: "d\t<name>" or "f\t<name>".
    const r = await this.shell.execute(
      `find ${shq(path)} -mindepth 1 -maxdepth 1 -printf '%y\\t%f\\n' 2>/dev/null`,
    );
    if (r.exitCode !== 0) return [];
    return r.stdout.split("\n").filter(Boolean).map((line) => {
      const [ty, name] = line.split("\t");
      const isDirectory = ty === "d";
      return { name: name ?? "", isDirectory, isFile: !isDirectory };
    });
  }

  async stat(path: string): Promise<FileStat> {
    // Numeric size + mtime (locale-independent), then a d/f type marker via
    // `test -d`. `stat -c`'s `%F` is localized ("regular file" / "file
    // regolare") and `-c` does not interpret `\n`, so avoid both. The `&&`
    // makes a missing path fail (stat's non-zero exit propagates).
    const p = shq(path);
    const r = await this.shell.execute(
      `stat --printf='%s %Y ' ${p} && ( [ -d ${p} ] && echo d || echo f )`,
    );
    if (r.exitCode !== 0) throw new Error(`stat ${path}: not found`);
    const [sizeStr, mtimeStr, kind] = r.stdout.trim().split(/\s+/);
    const isDirectory = kind === "d";
    const mtime = Number(mtimeStr);
    return {
      size: Number(sizeStr) || 0,
      isDirectory,
      isFile: !isDirectory,
      modifiedAt: Number.isFinite(mtime) ? new Date(mtime * 1000) : undefined,
    };
  }
}
