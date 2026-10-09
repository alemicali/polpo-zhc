/**
 * File I/O for the tools that work on the agent's files (pdf, excel, docx, images, audio,
 * downloads, attachments…). Everything goes through the FileSystem the tools are given, so the
 * bytes live where the agent's files live: this machine's disk, or a remote sandbox VM. Without
 * one, the node filesystem is used (same behaviour as before).
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { FileSystem } from "@polpo-ai/core/filesystem";
import { NodeFileSystem } from "../adapters/node-filesystem.js";

/** The FileSystem a tool uses: the one it was given, or the node filesystem. */
export function toolFs(fs?: FileSystem): FileSystem {
  return fs ?? new NodeFileSystem();
}

/** A file's bytes. */
export async function readBytes(fs: FileSystem, path: string): Promise<Buffer> {
  if (!fs.readFileBuffer) throw new Error("This file system cannot read binary files");
  const data = await fs.readFileBuffer(path);
  return Buffer.isBuffer(data) ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

/** Write bytes, creating the parent directories. */
export async function writeBytes(fs: FileSystem, path: string, data: Uint8Array): Promise<void> {
  if (!fs.writeFileBuffer) throw new Error("This file system cannot write binary files");
  await fs.mkdir(dirname(path));
  await fs.writeFileBuffer(path, data);
}

/** Write text, creating the parent directories. */
export async function writeText(fs: FileSystem, path: string, text: string): Promise<void> {
  await fs.mkdir(dirname(path));
  await fs.writeFile(path, text);
}

/** Size in bytes, or undefined when the file does not exist. */
export async function fileSize(fs: FileSystem, path: string): Promise<number | undefined> {
  try {
    const s = await fs.stat(path);
    return s.isFile ? s.size : undefined;
  } catch {
    return undefined;
  }
}

/**
 * For libraries and programs that only take a path on this machine: the bytes (read through
 * `fs`) go to a private temporary file, `fn` runs on it, and the file is removed afterwards.
 */
export async function withHostCopy<T>(bytes: Uint8Array, name: string, fn: (hostPath: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "polpo-tool-"));
  const hostPath = join(dir, basename(name) || "file");
  try {
    await writeFile(hostPath, bytes, { mode: 0o600 });
    return await fn(hostPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** A private temporary directory on this machine for a program's output, removed after `fn`. */
export async function withHostTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "polpo-tool-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
