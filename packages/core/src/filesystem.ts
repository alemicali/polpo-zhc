/**
 * FileSystem abstraction for agent tools.
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

  /** List entries in a directory. */
  readdir(path: string): Promise<string[]>;

  /** Create a directory (recursive). */
  mkdir(path: string): Promise<void>;

  /** Delete a file or directory. */
  remove(path: string): Promise<void>;

  /** Get file/directory metadata. */
  stat(path: string): Promise<FileStat>;

  /** Rename/move a file or directory. */
  rename(oldPath: string, newPath: string): Promise<void>;
}

export interface FileStat {
  size: number;
  isDirectory: boolean;
  isFile: boolean;
  modifiedAt?: Date;
}
