/**
 * Live harness sessions of this process, by computer: what the ComputerManager tells before its
 * VM goes away. No AI SDK import here (the sandbox layer imports this module).
 *
 * - "memory": a hibernation or a rotation (memory and disk snapshot; the bridge process in the VM
 *   survives): each session detaches (its resume state is persisted, encrypted) and re-attaches on
 *   its next turn against the new VM (new id, new preview URL).
 * - "disk": the VM's processes are lost (a reset, a delete, a disk-only restore): each session
 *   stops, so its next turn takes the rerun path (a new bridge resuming the runtime's conversation
 *   from the files it keeps in the VM, when the disk is kept).
 */
export type HarnessSuspendMode = "memory" | "disk";

export interface LiveHarnessSession {
  /** A stable key (agent + task or chat session) for the status views. */
  readonly key: string;
  readonly agent: string;
  readonly computerId: string;
  /** Park the session before the VM goes away (never throws). */
  suspend(mode: HarnessSuspendMode, reason: string): Promise<void>;
}

const byComputer = new Map<string, Set<LiveHarnessSession>>();

export const liveHarnessSessions = {
  register(session: LiveHarnessSession): () => void {
    let set = byComputer.get(session.computerId);
    if (!set) byComputer.set(session.computerId, (set = new Set()));
    set.add(session);
    return () => {
      set!.delete(session);
      if (set!.size === 0 && byComputer.get(session.computerId) === set) byComputer.delete(session.computerId);
    };
  },
  list(computerId?: string): LiveHarnessSession[] {
    if (computerId) return [...(byComputer.get(computerId) ?? [])];
    return [...byComputer.values()].flatMap((s) => [...s]);
  },
  /** Every live session on the computer parks itself (in parallel); errors never block the VM operation. */
  async beforeVmGoes(computerId: string, mode: HarnessSuspendMode, reason: string): Promise<number> {
    const sessions = [...(byComputer.get(computerId) ?? [])];
    await Promise.all(sessions.map((s) => s.suspend(mode, reason).catch(() => undefined)));
    return sessions.length;
  },
  /** Tests. */
  clear(): void {
    byComputer.clear();
  },
};
