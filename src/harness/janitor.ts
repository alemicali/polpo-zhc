/**
 * Harness sessions follow what they belong to: when a task, an agent or a computer is deleted, its
 * harness sessions are reset (stopped, their status record and their resume state in the vault's
 * "$harness" namespace forgotten). A sweep at startup and every few minutes catches what the events
 * missed (a delete while the server was down, a session a task runner still held, a team removed
 * with its agents).
 *
 * Best effort throughout: a cleanup never blocks or fails the delete; failures are logged.
 */
import type { ComputerConfig, VaultStore } from "@polpo-ai/core";
import { driverHost, type ComputerManager } from "../sandbox/computers.js";
import { controlHarnessSession, harnessSessionViews, type HarnessSessionView } from "./control.js";

export type HarnessJanitorLog = (level: "info" | "warn", message: string) => void;

export interface HarnessJanitorDeps {
  polpoDir: () => string;
  vault: () => VaultStore | undefined;
  /** Runs a command on a computer when it is running (never starts it): ends a parked bridge. */
  onComputer?: (computerId: string, command: string) => Promise<boolean>;
  /** Whether the task exists; undefined when it cannot be told (that check is skipped). */
  taskExists: (taskId: string) => Promise<boolean | undefined>;
  /** The agents' names; undefined when they cannot be read (that check is skipped). */
  agentNames: () => Promise<string[] | undefined>;
  /** The computers' ids ("host" is implied); undefined when they cannot be read. */
  computerIds: () => string[] | undefined;
  log?: HarnessJanitorLog;
}

/** A sweep leaves alone sessions touched this recently (a run that is starting, a store catching up). */
export const HARNESS_SWEEP_GRACE_MS = 10 * 60_000;
export const HARNESS_SWEEP_INTERVAL_MS = 15 * 60_000;

/**
 * The parked-bridge killer for controlHarnessSession over the computer manager: runs the command
 * only on a computer that is configured and running right now.
 */
export function bridgeCommandRunner(manager: () => ComputerManager, computers: () => ComputerConfig[]) {
  return async (computerId: string, command: string): Promise<boolean> => {
    const computer = computers().find((x) => x.id === computerId);
    if (!computer) return false;
    const done = await manager().whenRunning(computer, async (driver) => {
      await driverHost(driver).exec(command, { timeoutMs: 15_000 });
      return true;
    });
    return done === true;
  };
}

/**
 * Reset every harness session that matches (best effort, never throws). A session a task runner
 * holds right now is left for the sweep (it is reset once that process is gone).
 */
export async function resetHarnessSessions(
  deps: Pick<HarnessJanitorDeps, "polpoDir" | "vault" | "onComputer" | "log">,
  match: (s: HarnessSessionView) => boolean,
  why: string,
): Promise<{ reset: string[]; failed: string[] }> {
  const out = { reset: [] as string[], failed: [] as string[] };
  let sessions: HarnessSessionView[];
  try {
    sessions = harnessSessionViews(deps.polpoDir()).filter(match);
  } catch (err) {
    deps.log?.("warn", `[harness] Could not read the harness sessions to clean up after ${why}: ${(err as Error).message ?? err}`);
    return out;
  }
  for (const s of sessions) {
    try {
      const r = await controlHarnessSession({ polpoDir: deps.polpoDir(), vault: deps.vault(), key: s.key, action: "reset", ...(deps.onComputer ? { onComputer: deps.onComputer } : {}) });
      if (r.ok || r.status === 404) {
        out.reset.push(s.key);
      } else {
        out.failed.push(s.key);
        deps.log?.("warn", `[harness] Harness session ${s.key} was not reset after ${why}: ${r.error}. It is retried later.`);
      }
    } catch (err) {
      out.failed.push(s.key);
      deps.log?.("warn", `[harness] Resetting harness session ${s.key} after ${why} failed: ${(err as Error).message ?? err}`);
    }
  }
  if (out.reset.length) deps.log?.("info", `[harness] Reset harness session${out.reset.length > 1 ? "s" : ""} ${out.reset.join(", ")} after ${why}`);
  return out;
}

/** Why a session is an orphan (its task, agent or computer is gone), or undefined. */
export async function orphanReason(
  s: HarnessSessionView,
  known: { agents?: Set<string>; computers?: Set<string>; taskExists: (taskId: string) => Promise<boolean | undefined> },
): Promise<string | undefined> {
  if (known.agents && !known.agents.has(s.agent)) return `agent "${s.agent}" no longer exists`;
  if (known.computers && s.computerId !== "host" && !known.computers.has(s.computerId)) return `computer "${s.computerId}" no longer exists`;
  if (s.scope === "task" && s.taskId && (await known.taskExists(s.taskId).catch(() => undefined)) === false) return `task ${s.taskId} no longer exists`;
  return undefined;
}

/** Reset the sessions whose task, agent or computer is gone (not live, not touched within the grace). */
export async function sweepOrphanHarnessSessions(deps: HarnessJanitorDeps, now = Date.now()): Promise<{ reset: string[]; failed: string[] }> {
  const total = { reset: [] as string[], failed: [] as string[] };
  let sessions: HarnessSessionView[];
  try {
    sessions = harnessSessionViews(deps.polpoDir());
  } catch {
    return total;
  }
  if (!sessions.length) return total;
  const names = await deps.agentNames().catch(() => undefined);
  let ids: string[] | undefined;
  try { ids = deps.computerIds(); } catch { ids = undefined; }
  const known = {
    // an empty agent list is more likely a store that did not load than a team with no agents
    agents: names?.length ? new Set(names) : undefined,
    computers: ids ? new Set(ids) : undefined,
    taskExists: deps.taskExists,
  };
  for (const s of sessions) {
    if (s.live) continue;
    const touched = Date.parse(s.updatedAt);
    if (Number.isFinite(touched) && now - touched < HARNESS_SWEEP_GRACE_MS) continue;
    const reason = await orphanReason(s, known);
    if (!reason) continue;
    const r = await resetHarnessSessions(deps, (x) => x.key === s.key, reason);
    total.reset.push(...r.reset);
    total.failed.push(...r.failed);
  }
  return total;
}

/** The janitor's event subscriptions and its periodic sweep (the server process). */
export interface HarnessJanitorEvents {
  on(event: "task:removed" | "agent:removed" | "computer:changed", fn: (e: any) => void): unknown;
  off(event: "task:removed" | "agent:removed" | "computer:changed", fn: (e: any) => void): unknown;
}

export class HarnessSessionJanitor {
  private timer: ReturnType<typeof setInterval> | undefined;
  private unsubscribe: Array<() => void> = [];
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: HarnessJanitorDeps, private readonly intervalMs = HARNESS_SWEEP_INTERVAL_MS) {}

  /** One cleanup at a time (events and sweeps touch the same records). */
  private queue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  onTaskRemoved(taskId: string) {
    return this.queue(() => resetHarnessSessions(this.deps, (s) => s.scope === "task" && s.taskId === taskId, `task ${taskId} was deleted`));
  }

  onAgentRemoved(agent: string) {
    return this.queue(() => resetHarnessSessions(this.deps, (s) => s.agent === agent, `agent "${agent}" was removed`));
  }

  onComputerDeleted(computerId: string) {
    return this.queue(() => resetHarnessSessions(this.deps, (s) => s.computerId === computerId, `computer "${computerId}" was deleted`));
  }

  sweep() {
    return this.queue(() => sweepOrphanHarnessSessions(this.deps));
  }

  start(events: HarnessJanitorEvents): void {
    this.stop();
    const task = (e: { taskId: string }) => { void this.onTaskRemoved(e.taskId); };
    const agent = (e: { agentName: string }) => { void this.onAgentRemoved(e.agentName); };
    const computer = (e: { id: string; action?: string }) => { if (e.action === "deleted") void this.onComputerDeleted(e.id); };
    events.on("task:removed", task);
    events.on("agent:removed", agent);
    events.on("computer:changed", computer);
    this.unsubscribe = [
      () => events.off("task:removed", task),
      () => events.off("agent:removed", agent),
      () => events.off("computer:changed", computer),
    ];
    void this.sweep();
    this.timer = setInterval(() => { void this.sweep(); }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const off of this.unsubscribe.splice(0)) off();
  }
}
