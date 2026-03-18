/**
 * FileSystem abstraction for agent tools and server routes.
 *
 * Decouples tools from node:fs so they can work on any backend:
 *   - NodeFileSystem:     node:fs (self-hosted, default)
 *   - AgentFS:            SQLite virtual filesystem (future)
 *   - SandboxProxyFS:     Daytona sandbox.fs proxy (cloud)
 *   - S3/R2:              Object storage (future)
 */

export interface FileSystem {
  /** Read file contents as UTF-8 string. */
  readFile(path: string): Promise<string>;

  /** Write string content to a file (creates or overwrites). */
  writeFile(path: string, content: string): Promise<void>;

  /** Check if a path exists. */
  exists(path: string): Promise<boolean>;

  /** List entries in a directory (names only). */
  readdir(path: string): Promise<string[]>;

  /** List entries in a directory with type metadata. */
  readdirWithTypes?(path: string): Promise<FileEntry[]>;

  /** Create a directory (recursive). */
  mkdir(path: string): Promise<void>;

  /** Delete a file or directory. */
  remove(path: string): Promise<void>;

  /** Get file/directory metadata. */
  stat(path: string): Promise<FileStat>;

  /** Rename/move a file or directory. */
  rename(oldPath: string, newPath: string): Promise<void>;

  /** Read file as raw bytes (for binary files: images, PDFs, audio, etc.). */
  readFileBuffer?(path: string): Promise<Uint8Array>;

  /** Write raw bytes to a file (for uploads, binary content). */
  writeFileBuffer?(path: string, data: Uint8Array): Promise<void>;
}

export interface FileEntry {
  name: string;
  isDirectory: boolean;
  isFile: boolean;
}

export interface FileStat {
  size: number;
  isDirectory: boolean;
  isFile: boolean;
  modifiedAt?: Date;
}
