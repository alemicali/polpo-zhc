import type { Orchestrator } from "../orchestrator.js";
import type { OrchestraEvent } from "../core/events.js";

/** All Orchestra events to subscribe to. */
const ALL_EVENTS: OrchestraEvent[] = [
  "task:created", "task:transition", "task:updated", "task:removed",
  "agent:spawned", "agent:finished", "agent:activity",
  "assessment:started", "assessment:progress", "assessment:complete", "assessment:corrected",
  "orchestrator:started", "orchestrator:tick", "orchestrator:deadlock", "orchestrator:shutdown",
  "task:retry", "task:fix", "task:maxRetries",
  "task:question", "task:answered",
  "deadlock:detected", "deadlock:resolving", "deadlock:resolved", "deadlock:unresolvable",
  "task:timeout", "agent:stale",
  "task:recovered",
  "plan:saved", "plan:executed", "plan:completed", "plan:resumed", "plan:deleted",
  "log",
];

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
  /** Listeners for new events (used by WS bridge). */
  private externalListeners = new Set<(event: string, data: unknown, eventId: string) => void>();

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
          } catch {
            this.removeClient(client.id);
          }
        }

        // Notify external listeners (WS bridge)
        for (const listener of this.externalListeners) {
          try {
            listener(event, data, eventId);
          } catch { /* ignore */ }
        }
      };
      this.orchestrator.on(event, fn);
      handlers.push({ event, fn });
    }

    this.disposeFn = () => {
      for (const { event, fn } of handlers) {
        this.orchestrator.off(event as OrchestraEvent, fn);
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
        } catch {
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

  /** Register an external listener for all events (used by WS bridge). */
  onEvent(listener: (event: string, data: unknown, eventId: string) => void): void {
    this.externalListeners.add(listener);
  }

  /** Unregister an external listener. */
  offEvent(listener: (event: string, data: unknown, eventId: string) => void): void {
    this.externalListeners.delete(listener);
  }

  /** Get recent buffered events (for initial WS sync). */
  getBufferedEvents(sinceId?: string): BufferedEvent[] {
    if (!sinceId) return [...this.eventBuffer];
    const idx = this.eventBuffer.findIndex(e => e.id === sinceId);
    return idx >= 0 ? this.eventBuffer.slice(idx + 1) : [...this.eventBuffer];
  }

  get clientCount(): number {
    return this.clients.size;
  }

  /** Cleanup: remove all handlers and close all clients. */
  dispose(): void {
    this.disposeFn?.();
    for (const client of this.clients.values()) {
      try { client.close(); } catch { /* ignore */ }
    }
    this.clients.clear();
    this.externalListeners.clear();
  }
}
