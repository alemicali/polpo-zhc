/**
 * Event system for Polpo.
 *
 * Type definitions (PolpoEventMap, PolpoEvent) come from @polpo/core.
 * TypedEmitter (extends Node.js EventEmitter) lives here in the shell.
 */
import { EventEmitter } from "node:events";
export type { PolpoEventMap, PolpoEvent } from "@polpo/core/events";
import type { PolpoEvent, PolpoEventMap } from "@polpo/core/events";
import type { LogStore } from "@polpo/core/log-store";

/** Events to exclude from persistent logging (too frequent or internal). */
const LOG_EXCLUDED = new Set<string>(["orchestrator:tick", "newListener", "removeListener"]);

export class TypedEmitter extends EventEmitter {
  private logSink?: LogStore;

  /** Attach a persistent log store. All emitted events will be written to it. */
  setLogSink(store: LogStore): void {
    this.logSink = store;
  }

  override emit<K extends PolpoEvent>(event: K, payload: PolpoEventMap[K]): boolean;
  override emit(event: string | symbol, ...args: unknown[]): boolean;
  override emit(event: string | symbol, ...args: unknown[]): boolean {
    if (this.logSink && typeof event === "string" && !LOG_EXCLUDED.has(event)) {
      try {
        this.logSink.append({
          ts: new Date().toISOString(),
          event,
          data: args[0],
        });
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
