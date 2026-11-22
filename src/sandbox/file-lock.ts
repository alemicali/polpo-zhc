/**
 * A lock file shared by the server and the task runners of one project (separate processes).
 * Held locks refresh their file's time, so a lock whose holder crashed is taken over after
 * `staleMs` without waiting for the longest operation a holder may run.
 */
import { closeSync, existsSync, mkdirSync, openSync, statSync, unlinkSync, utimesSync } from "node:fs";
import { dirname } from "node:path";

export interface FileLockOptions {
  /** A lock file not refreshed for this long belongs to a dead process (default 30 s). */
  staleMs?: number;
  /** Give up after waiting this long (default 10 s). */
  waitMs?: number;
  /** Refresh the file this often while held (default staleMs / 3). */
  heartbeatMs?: number;
  /** The error message when the wait times out. */
  busyMessage?: string;
}

export async function acquireFileLock(path: string, opts: FileLockOptions = {}): Promise<() => void> {
  const staleMs = opts.staleMs ?? 30_000;
  const deadline = Date.now() + (opts.waitMs ?? 10_000);
  mkdirSync(dirname(path), { recursive: true });
  for (;;) {
    try {
      const fd = openSync(path, "wx", 0o600);
      closeSync(fd);
      const beat = setInterval(() => { try { const now = new Date(); utimesSync(path, now, now); } catch { /* gone */ } }, opts.heartbeatMs ?? Math.max(1000, Math.floor(staleMs / 3)));
      beat.unref?.();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        clearInterval(beat);
        try { unlinkSync(path); } catch { /* already gone */ }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      try {
        if (existsSync(path) && Date.now() - statSync(path).mtimeMs > staleMs) unlinkSync(path);
      } catch { /* raced with its holder */ }
      if (Date.now() > deadline) throw new Error(opts.busyMessage ?? `Locked by another process: ${path}`);
      await new Promise((r) => setTimeout(r, 50 + Math.random() * 100));
    }
  }
}
