import type { Orchestrator } from "../core/orchestrator.js";
import type { PolpoEvent } from "../core/events.js";
import { POLPO_EVENT_NAMES } from "@polpo-ai/core";

/** All Polpo events to subscribe to: the whole bus, from the event catalog. */
const ALL_EVENTS: PolpoEvent[] = POLPO_EVENT_NAMES;

export interface SSEClient {
  id: string;
  send(event: string, data: unknown, eventId: string): void;
  close(): void;
}

export interface BufferedEvent {
  id: string;
  event: string;
  data: unknown;
  ts: number;
}

/**
 * Bridges Orchestrator TypedEmitter events to SSE clients.
 * Supports multiple concurrent clients per orchestrator.
 * Maintains a circular buffer for Last-Event-ID reconnection.
 */
export class SSEBridge {
  private clients = new Map<string, SSEClient>();
  private eventBuffer: BufferedEvent[] = [];
  private maxBufferSize = 1000;
  private eventCounter = 0;
  private disposeFn: (() => void) | null = null;

  constructor(private orchestrator: Orchestrator) {}

  /** Start listening to all orchestrator events. */
  start(): void {
    const handlers: Array<{ event: string; fn: (...args: unknown[]) => void }> = [];

    for (const event of ALL_EVENTS) {
      const fn = (data: unknown) => {
        const eventId = String(++this.eventCounter);

        // Buffer for reconnection
        this.eventBuffer.push({ id: eventId, event, data, ts: Date.now() });
        if (this.eventBuffer.length > this.maxBufferSize) {
          this.eventBuffer.shift();
        }

        // Broadcast to SSE clients
        for (const client of this.clients.values()) {
          try {
            client.send(event, data, eventId);
          } catch { /* client disconnected */
            this.removeClient(client.id);
          }
        }


      };
      this.orchestrator.on(event, fn);
      handlers.push({ event, fn });
    }

    this.disposeFn = () => {
      for (const { event, fn } of handlers) {
        this.orchestrator.off(event as PolpoEvent, fn);
      }
    };
  }

  /** Add an SSE client. Replays events since lastEventId if provided. */
  addClient(client: SSEClient, lastEventId?: string): void {
    this.clients.set(client.id, client);

    // Replay buffered events since lastEventId
    if (lastEventId) {
      const startIdx = this.eventBuffer.findIndex(e => e.id === lastEventId);
      const events = startIdx >= 0
        ? this.eventBuffer.slice(startIdx + 1)
        : this.eventBuffer; // unknown ID: send all buffered
      for (const e of events) {
        try {
          client.send(e.event, e.data, e.id);
        } catch { /* client disconnected */
          this.removeClient(client.id);
          return;
        }
      }
    }
  }

  /** Remove an SSE client. */
  removeClient(clientId: string): void {
    this.clients.delete(clientId);
  }


  get clientCount(): number {
    return this.clients.size;
  }

  /** Cleanup: remove all handlers and close all clients. */
  dispose(): void {
    this.disposeFn?.();
    for (const client of this.clients.values()) {
      try { client.close(); } catch { /* already closed */ }
    }
    this.clients.clear();
  }
}
