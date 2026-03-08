/**
 * EventBus — pure interface for typed event emission.
 *
 * TypedEmitter (extends Node.js EventEmitter) implements this in the shell.
 * Other runtimes (Convex, Workers) can provide their own implementations.
 */
import type { PolpoEvent, PolpoEventMap } from "./events.js";

export interface EventBus {
  emit<K extends PolpoEvent>(event: K, payload: PolpoEventMap[K]): boolean;
  emit(event: string | symbol, ...args: unknown[]): boolean;

  on<K extends PolpoEvent>(event: K, listener: (payload: PolpoEventMap[K]) => void): unknown;
  on(event: string | symbol, listener: (...args: unknown[]) => void): unknown;

  off<K extends PolpoEvent>(event: K, listener: (payload: PolpoEventMap[K]) => void): unknown;
  off(event: string | symbol, listener: (...args: unknown[]) => void): unknown;

  once?<K extends PolpoEvent>(event: K, listener: (payload: PolpoEventMap[K]) => void): unknown;
  once?(event: string | symbol, listener: (...args: unknown[]) => void): unknown;
}
