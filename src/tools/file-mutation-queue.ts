/**
 * One mutation at a time per file. pi-agent-core runs the tool calls of one turn in parallel, so
 * two `edit` calls on the same file both read the original and the second write dropped the first
 * edit. `edit` and `write` run their read-modify-write inside this lock; calls on different files
 * still run in parallel.
 *
 * Adapted from Pi's file mutation queue (`@earendil-works/pi-coding-agent`,
 * src/core/tools/file-mutation-queue.ts, MIT License, Copyright (c) Mario Zechner). Polpo's key
 * is the sandbox's canonical path (symlinks resolved; a path that does not exist here, such as one
 * in a remote VM, is keyed by its resolved form), computed synchronously, so no registration queue
 * is needed.
 */

import { canonicalPath } from "./path-sandbox.js";

const queues = new Map<string, Promise<void>>();

/** The key `path` is locked under (for tests and diagnostics). */
export function fileMutationKey(path: string): string {
  return canonicalPath(path);
}

/** Run `fn` once every earlier mutation of the same file has finished. */
export async function withFileMutationLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const key = fileMutationKey(path);
  const previous = queues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const chained = previous.then(() => current);
  queues.set(key, chained);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (queues.get(key) === chained) queues.delete(key);
  }
}
