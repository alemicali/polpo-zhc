import type { Orchestrator } from "../core/orchestrator.js";
import type { PolpoEvent } from "../core/events.js";

/** All Polpo events to subscribe to. */
const ALL_EVENTS: PolpoEvent[] = [
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
  "session:created", "message:added",
  "approval:requested", "approval:resolved", "approval:rejected", "approval:timeout",
  "escalation:triggered", "escalation:resolved", "escalation:human",
  "sla:warning", "sla:violated", "sla:met",
  "quality:gate:passed", "quality:gate:failed", "quality:threshold:failed",
  "schedule:triggered", "schedule:created", "schedule:completed",
  "notification:sent", "notification:failed",
  "gateway:started", "gateway:stopped",
  "peer:paired", "peer:message", "peer:blocked", "peer:presence",
  "watcher:created", "watcher:fired", "watcher:removed",
  "action:triggered",
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
