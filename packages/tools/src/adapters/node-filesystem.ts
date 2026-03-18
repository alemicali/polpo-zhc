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

  async readdirWithTypes(path: string): Promise<{ name: string; isDirectory: boolean; isFile: boolean }[]> {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.map((e) => ({
      name: e.name,
      isDirectory: e.isDirectory(),
      isFile: e.isFile(),
    }));
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

  async readFileBuffer(path: string): Promise<Uint8Array> {
    return readFile(path);
  }

  async writeFileBuffer(path: string, data: Uint8Array): Promise<void> {
    await writeFile(path, data);
  }
}
