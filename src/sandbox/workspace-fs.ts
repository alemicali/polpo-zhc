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
