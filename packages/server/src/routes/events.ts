import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { streamSSE } from "hono/streaming";
import { nanoid } from "nanoid";

/** SSE client interface — implemented by the consumer's bridge. */
export interface EventClient {
  id: string;
  send(event: string, data: unknown, eventId: string): void;
  close(): void;
}

/** Event bridge interface — the consumer provides the event source. */
export interface EventBridge {
  addClient(client: EventClient, lastEventId?: string): void;
  removeClient(id: string): void;
}

// ── Route definitions ─────────────────────────────────────────────────

const _sseEventStreamRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Events"],
  summary: "SSE event stream",
  description: "Server-Sent Events stream for real-time events. Supports Last-Event-ID header for replay and ?filter= query parameter for event filtering.",
  request: {
    query: z.object({
      filter: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: "SSE event stream (text/event-stream)",
    },
  },
});

// ── Route handlers ────────────────────────────────────────────────────

/**
 * SSE streaming event routes.
 * Accepts any EventBridge implementation (self-hosted SSEBridge, cloud EventEmitter adapter, etc.)
 */
export function eventRoutes(bridge: EventBridge): OpenAPIHono {
  const app = new OpenAPIHono();

  app.get("/", (c) => {
    const lastEventId = c.req.header("last-event-id");
    const filterParam = c.req.query("filter");
    const filters = filterParam ? filterParam.split(",").map(f => f.trim()) : null;

    return streamSSE(c, async (stream) => {
      const clientId = nanoid();

      const client: EventClient = {
        id: clientId,
        send(event: string, data: unknown, eventId: string) {
          if (filters && !matchesFilter(event, filters)) return;
          stream.writeSSE({
            event,
            data: JSON.stringify(data),
            id: eventId,
          });
        },
        close() {
          stream.close();
        },
      };

      bridge.addClient(client, lastEventId ?? undefined);

      const heartbeat = setInterval(() => {
        try {
          stream.writeSSE({ event: "heartbeat", data: "" });
        } catch {
          clearInterval(heartbeat);
          bridge.removeClient(clientId);
        }
      }, 30_000);

      stream.onAbort(() => {
        clearInterval(heartbeat);
        bridge.removeClient(clientId);
      });

      await new Promise<void>((resolve) => {
        stream.onAbort(() => resolve());
      });
    });
  });

  return app;
}

/** Check if an event name matches any of the filter patterns. */
function matchesFilter(event: string, filters: string[]): boolean {
  for (const filter of filters) {
    if (filter === event) return true;
    if (filter.endsWith(":*")) {
      const prefix = filter.slice(0, -1);
      if (event.startsWith(prefix)) return true;
    }
    if (filter === "*") return true;
  }
  return false;
}
