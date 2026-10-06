/**
 * Serializes the operations that decide whether an attachment file is still referenced:
 * copying attachment rows into a branch, and deleting a row then its file when no row is left.
 * Without it, a branch could copy a row while its parent's row is deleted and the file removed.
 * In-process, like the other chat coordination state.
 */
let tail: Promise<unknown> = Promise.resolve();

export function withAttachmentLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = tail.then(fn, fn);
  tail = run.catch(() => undefined);
  return run;
}
