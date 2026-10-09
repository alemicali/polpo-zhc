/**
 * The FileSystem the file tools (read, write, edit, ls) use, backed by a Workspace — for remote
 * sandboxes, where the agent's files live in the VM rather than on this server's disk.
 */
import type { FileEntry, FileStat, FileSystem } from "@polpo-ai/core/filesystem";
import type { Workspace } from "@polpo-ai/core/sandbox";

const decoder = new TextDecoder();

export class WorkspaceFileSystem implements FileSystem {
  constructor(private readonly workspace: Workspace) {}

  async readFile(path: string): Promise<string> {
    return decoder.decode(await this.workspace.readFile(path));
  }

  async writeFile(path: string, content: string): Promise<void> {
    await this.workspace.writeFile(path, content);
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    return this.workspace.readFile(path);
  }

  async writeFileBuffer(path: string, data: Uint8Array): Promise<void> {
    await this.workspace.writeFile(path, data);
  }

  async exists(path: string): Promise<boolean> {
    return (await this.workspace.stat(path)) !== null;
  }

  async readdir(path: string): Promise<string[]> {
    return (await this.readdirWithTypes(path)).map((e) => e.name);
  }

  async readdirWithTypes(path: string): Promise<FileEntry[]> {
    const entries = await this.workspace.list(path);
    return entries.map((e) => ({
      name: e.path.slice(e.path.lastIndexOf("/") + 1),
      isDirectory: e.type === "dir",
      isFile: e.type === "file",
    }));
  }

  async mkdir(path: string): Promise<void> {
    await this.workspace.mkdir(path);
  }

  async remove(path: string): Promise<void> {
    await this.workspace.remove(path, { recursive: true });
  }

  async stat(path: string): Promise<FileStat> {
    const s = await this.workspace.stat(path);
    if (!s) throw Object.assign(new Error(`ENOENT: no such file or directory, stat '${path}'`), { code: "ENOENT" });
    return { size: s.size, isDirectory: s.type === "dir", isFile: s.type === "file", modifiedAt: new Date(s.mtimeMs) };
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
    const r = await this.workspace.exec(`mkdir -p "$(dirname ${q(newPath)})" && mv -- ${q(oldPath)} ${q(newPath)}`);
    if (r.exitCode !== 0) throw new Error(r.stderr.trim() || `mv failed (${r.exitCode})`);
  }
}

/**
 * Reads look in the VM first, then on this machine (where the run's output directory is copied
 * back); writes and listings stay on this machine. For host actions that act on files a remote
 * run referred to (an email confirmed after its preview).
 */
export function remoteThenLocal(remote: FileSystem, local: FileSystem): FileSystem {
  const inVm = (path: string) => remote.exists(path).catch(() => false);
  const either = <K extends "readFile" | "readFileBuffer" | "stat">(name: K) =>
    (async (path: string) => ((await inVm(path)) ? (remote[name] as any)(path) : (local[name] as any)(path))) as NonNullable<FileSystem[K]>;
  return {
    exists: async (path) => (await inVm(path)) || local.exists(path),
    readFile: either("readFile"),
    readFileBuffer: either("readFileBuffer"),
    stat: either("stat"),
    readdir: (path) => local.readdir(path),
    mkdir: (path) => local.mkdir(path),
    remove: (path) => local.remove(path),
    rename: (from, to) => local.rename(from, to),
    writeFile: (path, content) => local.writeFile(path, content),
    ...(local.writeFileBuffer ? { writeFileBuffer: (path: string, data: Uint8Array) => local.writeFileBuffer!(path, data) } : {}),
  };
}
