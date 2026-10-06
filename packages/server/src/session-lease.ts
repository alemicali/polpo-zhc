/**
 * Session leases — at most one chat turn per session at a time.
 *
 * Every turn (streaming or not, started by a client, the turn scheduler, a messaging channel or a
 * background-wait continuation) holds its session's lease from the moment it is accepted until it
 * is over. Claiming is synchronous, so two requests can never both win; the loser is refused (409)
 * or waits, depending on the caller.
 *
 * The scheduler claims the lease before taking a queued prompt and hands it to the turn it starts
 * (`transfer`), so nothing can slip in between. A lease older than MAX_LEASE_MS is considered
 * abandoned and can be taken over, so a lost release never blocks a session forever.
 *
 * In-memory and single-process, like the stream registry.
 */

export const MAX_LEASE_MS = 30 * 60 * 1000;

interface Lease {
  owner: string;
  acquiredAt: number;
  /** What holds it, for diagnostics ("turn", "dispatch"…). */
  kind: string;
}

const LEASES = new Map<string, Lease>();
const waiters = new Map<string, Array<() => void>>();
const releaseListeners = new Set<(sessionId: string, kind: string) => void>();

function wakeOne(sessionId: string) {
  const queue = waiters.get(sessionId);
  const next = queue?.shift();
  if (queue && queue.length === 0) waiters.delete(sessionId);
  next?.();
}

export const sessionLeases = {
  /** Claim the session's lease now; false when someone else holds a live one. */
  tryAcquire(sessionId: string, owner: string, kind = "turn"): boolean {
    const current = LEASES.get(sessionId);
    if (current && current.owner !== owner && Date.now() - current.acquiredAt < MAX_LEASE_MS) return false;
    LEASES.set(sessionId, { owner, kind, acquiredAt: current?.owner === owner ? current.acquiredAt : Date.now() });
    return true;
  },

  /** Claim the lease, waiting up to `waitMs` for the current holder to finish. */
  async acquire(sessionId: string, owner: string, opts: { waitMs: number; kind?: string }): Promise<boolean> {
    const deadline = Date.now() + opts.waitMs;
    while (!sessionLeases.tryAcquire(sessionId, owner, opts.kind)) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(remaining, 1000));
        const list = waiters.get(sessionId) ?? [];
        list.push(() => { clearTimeout(timer); resolve(); });
        waiters.set(sessionId, list);
      });
    }
    return true;
  },

  /** Hand a lease over to a new owner (scheduler → the turn it started). */
  transfer(sessionId: string, from: string, to: string, kind = "turn"): boolean {
    const current = LEASES.get(sessionId);
    if (!current || current.owner !== from) return false;
    LEASES.set(sessionId, { owner: to, kind, acquiredAt: Date.now() });
    return true;
  },

  /** Release the lease if `owner` still holds it. */
  release(sessionId: string, owner: string): void {
    const current = LEASES.get(sessionId);
    if (!current || current.owner !== owner) return;
    LEASES.delete(sessionId);
    wakeOne(sessionId);
    for (const listener of releaseListeners) {
      try { listener(sessionId, current.kind); } catch { /* listeners must not break releases */ }
    }
  },

  isHeld(sessionId: string): boolean {
    const current = LEASES.get(sessionId);
    return !!current && Date.now() - current.acquiredAt < MAX_LEASE_MS;
  },

  holder(sessionId: string): { owner: string; kind: string } | undefined {
    const current = LEASES.get(sessionId);
    return current && Date.now() - current.acquiredAt < MAX_LEASE_MS ? { owner: current.owner, kind: current.kind } : undefined;
  },

  /** Called after every release (the scheduler looks for work then). */
  onRelease(listener: (sessionId: string, kind: string) => void): () => void {
    releaseListeners.add(listener);
    return () => { releaseListeners.delete(listener); };
  },
};
