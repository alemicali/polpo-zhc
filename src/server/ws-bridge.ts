import type { OrchestraEvent } from "../core/events.js";
import type { SSEBridge } from "./sse-bridge.js";
import type { WSClientMessage, WSServerEvent, WSServerError } from "./types.js";

interface WSClient {
  id: string;
  ws: WebSocket;
  subscribedEvents: Set<string>;
  subscribeAll: boolean;
}

/**
 * WebSocket bridge for bidirectional communication.
 * Reuses the SSEBridge event buffer and listener system.
 *
 * Protocol:
 * Client → Server:
 *   { type: "subscribe", events: ["task:*", "agent:*"] }  // glob patterns
 *   { type: "unsubscribe", events: ["task:*"] }
 *   { type: "command", action: "killTask", params: { taskId: "..." } }
 *
 * Server → Client:
 *   { type: "event", event: "task:created", data: {...}, id: "1", timestamp: "..." }
 *   { type: "error", error: "...", code: "..." }
 */
export class WSBridge {
  private clients = new Map<string, WSClient>();
  private clientCounter = 0;
  private eventListener: ((event: string, data: unknown, eventId: string) => void) | null = null;

  constructor(private sseBridge: SSEBridge) {}

  /** Start listening for events from the SSE bridge. */
  start(): void {
    this.eventListener = (event: string, data: unknown, eventId: string) => {
      const msg: WSServerEvent = {
        type: "event",
        event: event as OrchestraEvent,
        data,
        id: eventId,
        timestamp: new Date().toISOString(),
      };
      const serialized = JSON.stringify(msg);

      for (const client of this.clients.values()) {
        if (this.matchesSubscription(client, event)) {
          try {
            (client.ws as any).send(serialized);
          } catch { /* client disconnected */
            this.removeClient(client.id);
          }
        }
      }
    };

    this.sseBridge.onEvent(this.eventListener);
  }

  /** Handle a new WebSocket connection. */
  addClient(ws: WebSocket): string {
    const id = String(++this.clientCounter);
    const client: WSClient = {
      id,
      ws,
      subscribedEvents: new Set(),
      subscribeAll: true, // subscribe to all by default
    };
    this.clients.set(id, client);

    // Handle incoming messages
    (ws as any).on("message", (raw: Buffer | string) => {
      try {
        const msg: WSClientMessage = JSON.parse(raw.toString());
        this.handleMessage(client, msg);
      } catch { /* malformed JSON message */
        this.sendError(client, "Invalid JSON message", "VALIDATION_ERROR");
      }
    });

    (ws as any).on("close", () => {
      this.removeClient(id);
    });

    (ws as any).on("error", () => {
      this.removeClient(id);
    });

    return id;
  }

  private handleMessage(client: WSClient, msg: WSClientMessage): void {
    switch (msg.type) {
      case "subscribe":
        if (msg.events && msg.events.length > 0) {
          client.subscribeAll = false;
          for (const event of msg.events) {
            client.subscribedEvents.add(event);
          }
        } else {
          client.subscribeAll = true;
        }
        break;

      case "unsubscribe":
        if (msg.events) {
          for (const event of msg.events) {
            client.subscribedEvents.delete(event);
          }
        } else {
          client.subscribedEvents.clear();
          client.subscribeAll = false;
        }
        break;

      case "command":
        // Commands are handled via REST API — WS is events-only for now
        this.sendError(client, "Commands should use REST API", "VALIDATION_ERROR");
        break;
    }
  }

  private matchesSubscription(client: WSClient, event: string): boolean {
    if (client.subscribeAll) return true;
    if (client.subscribedEvents.has(event)) return true;

    // Support glob patterns: "task:*" matches "task:created"
    for (const pattern of client.subscribedEvents) {
      if (pattern.endsWith(":*")) {
        const prefix = pattern.slice(0, -1); // "task:"
        if (event.startsWith(prefix)) return true;
      }
    }
    return false;
  }

  private sendError(client: WSClient, error: string, code: string): void {
    const msg: WSServerError = { type: "error", error, code: code as WSServerError["code"] };
    try {
      (client.ws as any).send(JSON.stringify(msg));
    } catch { /* client disconnected */ }
  }

  /** Remove a WS client. */
  removeClient(clientId: string): void {
    const client = this.clients.get(clientId);
    if (client) {
      try { (client.ws as any).close(); } catch { /* already closed */ }
      this.clients.delete(clientId);
    }
  }

  get clientCount(): number {
    return this.clients.size;
  }

  /** Cleanup: remove event listener, close all clients. */
  dispose(): void {
    if (this.eventListener) {
      this.sseBridge.offEvent(this.eventListener);
    }
    for (const client of this.clients.values()) {
      try { (client.ws as any).close(); } catch { /* already closed */ }
    }
    this.clients.clear();
  }
}
