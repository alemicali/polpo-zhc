/**
 * Event system for Polpo.
 *
 * Type definitions (PolpoEventMap, PolpoEvent) come from @polpo-ai/core.
 * TypedEmitter (extends Node.js EventEmitter) lives here in the shell.
 */
import { EventEmitter } from "node:events";
import { AsyncLocalStorage } from "node:async_hooks";
export type { PolpoEventMap, PolpoEvent } from "@polpo-ai/core/events";
export type { EventBus } from "@polpo-ai/core/event-bus";
import type { PolpoEvent, PolpoEventMap } from "@polpo-ai/core/events";
import type { EventBus } from "@polpo-ai/core/event-bus";
import type { LogStore } from "@polpo-ai/core/log-store";
import type { EventOrigin } from "@polpo-ai/core/events";

/** Events to exclude from persistent logging (too frequent or internal). */
const LOG_EXCLUDED = new Set<string>(["orchestrator:tick", "newListener", "removeListener"]);

/** Events that never carry an origin: too frequent, or not about a change someone made. */
const NO_ORIGIN = new Set<string>(["orchestrator:tick", "agent:activity", "room:typing", "assessment:progress", "log"]);

const originStore = new AsyncLocalStorage<EventOrigin>();

/**
 * Run `fn` on behalf of `origin`: every event emitted inside it (awaits included) carries
 * `source` and `by`, unless the emitter set them. The innermost origin wins.
 */
export function withEventOrigin<T>(origin: EventOrigin, fn: () => T): T {
  // A nested origin keeps the outer person when it names none (a person → Polpo's tools).
  const outer = originStore.getStore();
  const by = origin.by ?? outer?.by;
  return originStore.run({ source: origin.source ?? outer?.source, ...(by ? { by } : {}) }, fn);
}

/** The origin of the code running now, if any. */
export function currentEventOrigin(): EventOrigin | undefined {
  return originStore.getStore();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** The payload with the current origin added, when it has none of its own. */
function withOrigin(event: string, payload: unknown): unknown {
  const origin = originStore.getStore();
  if (!origin || NO_ORIGIN.has(event) || !isPlainObject(payload) || "source" in payload) return payload;
  return { ...payload, source: origin.source, ...(origin.by ? { by: origin.by } : {}) };
}

/**
 * What the event log keeps of a payload: tasks reduced to who/what/where (the full task, with
 * its results, stays available from the task store), agent/team snapshots dropped (they are
 * the whole team, sent so live clients can refresh).
 */
export function compactForLog(payload: unknown): unknown {
  if (!isPlainObject(payload)) return payload;
  let out: Record<string, unknown> | undefined;
  const task = payload.task;
  if (isPlainObject(task)) {
    out = { ...payload, task: { id: task.id, title: task.title, status: task.status, assignTo: task.assignTo, group: task.group, missionId: task.missionId } };
  }
  if (Array.isArray(payload.agents) && Array.isArray(payload.teams)) {
    const { agents: _agents, teams: _teams, ...rest } = out ?? payload;
    out = rest;
  }
  return out ?? payload;
}

export class TypedEmitter extends EventEmitter implements EventBus {
  private logSink?: LogStore;

  /** Attach a persistent log store (undefined detaches it). All emitted events will be written to it. */
  setLogSink(store: LogStore | undefined): void {
    this.logSink = store;
  }

  override emit<K extends PolpoEvent>(event: K, payload: PolpoEventMap[K]): boolean;
  override emit(event: string | symbol, ...args: unknown[]): boolean {
    if (typeof event === "string" && args.length > 0) args[0] = withOrigin(event, args[0]);
    if (this.logSink && typeof event === "string" && !LOG_EXCLUDED.has(event)) {
      try {
        // append is async: a failed write (e.g. the database is down or already closed) must not
        // become an unhandled rejection. The rejection handler logs it, which appends again,
        // which fails again: an endless microtask loop that starves timers and blocks shutdown.
        void Promise.resolve(this.logSink.append({
          ts: new Date().toISOString(),
          event,
          data: compactForLog(args[0]),
        })).catch(() => { /* never let logging break the system */ });
      } catch { /* never let logging break the system */ }
    }
    return super.emit(event, ...args);
  }

  override on<K extends PolpoEvent>(event: K, listener: (payload: PolpoEventMap[K]) => void): this;
  override on(event: string | symbol, listener: (...args: unknown[]) => void): this;
  override on(event: string | symbol, listener: (...args: unknown[]) => void): this {
    return super.on(event, listener);
  }

  override once<K extends PolpoEvent>(event: K, listener: (payload: PolpoEventMap[K]) => void): this;
  override once(event: string | symbol, listener: (...args: unknown[]) => void): this;
  override once(event: string | symbol, listener: (...args: unknown[]) => void): this {
    return super.once(event, listener);
  }

  override off<K extends PolpoEvent>(event: K, listener: (payload: PolpoEventMap[K]) => void): this;
  override off(event: string | symbol, listener: (...args: unknown[]) => void): this;
  override off(event: string | symbol, listener: (...args: unknown[]) => void): this {
    return super.off(event, listener);
  }
}
