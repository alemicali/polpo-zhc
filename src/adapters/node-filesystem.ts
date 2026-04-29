/**
 * Node.js FileSystem implementation — wraps node:fs.
 *
 * Default implementation for self-hosted mode. Reads/writes to the real filesystem.
 * Drop-in replacement pattern: swap with AgentFS, SandboxProxyFS, etc.
 */
import { readFile, writeFile, mkdir, rm, stat, readdir, rename, access } from "node:fs/promises";
import type { FileSystem, FileStat } from "@polpo-ai/core/filesystem";

export class NodeFileSystem implements FileSystem {
  async readFile(path: string): Promise<string> {
    return readFile(path, "utf-8");
  }

  /** Read file as raw binary buffer (for images, PDFs, etc.) */
  async readFileBuffer(path: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(path));
  }

  /** Write raw binary buffer to file */
  async writeFileBuffer(path: string, data: Uint8Array): Promise<void> {
    await writeFile(path, data);
  }

  async writeFile(path: string, content: string): Promise<void> {
    await writeFile(path, content, "utf-8");
  }

  async exists(path: string): Promise<boolean> {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  }

  async readdir(path: string): Promise<string[]> {
    return readdir(path);
  }

  /** Read directory with type info (file vs directory) for file manager UI */
  async readdirWithTypes(path: string): Promise<{ name: string; isDirectory: boolean; isFile: boolean }[]> {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.map((e) => ({ name: e.name, isDirectory: e.isDirectory(), isFile: e.isFile() }));
  }

  async mkdir(path: string): Promise<void> {
    await mkdir(path, { recursive: true });
  }

  async remove(path: string): Promise<void> {
    await rm(path, { recursive: true, force: true });
  }

  async stat(path: string): Promise<FileStat> {
    const s = await stat(path);
    return {
      size: s.size,
      isDirectory: s.isDirectory(),
      isFile: s.isFile(),
      modifiedAt: s.mtime,
    };
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    await rename(oldPath, newPath);
  }
}
