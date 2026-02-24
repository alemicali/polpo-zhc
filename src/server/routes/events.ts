import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { streamSSE } from "hono/streaming";
import { nanoid } from "nanoid";
import type { ServerEnv } from "../app.js";
import type { SSEBridge, SSEClient } from "../sse-bridge.js";

// ── Route definitions ─────────────────────────────────────────────────

// Document the SSE endpoint for OpenAPI (actual handler uses regular app.get)
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
 */
export function eventRoutes(sseBridge: SSEBridge): OpenAPIHono<ServerEnv> {
  const app = new OpenAPIHono<ServerEnv>();

  // GET /events — SSE event stream
  // NOTE: SSE streaming cannot use app.openapi() because it returns a streaming response, not JSON.
  app.get("/", (c) => {
    const lastEventId = c.req.header("last-event-id");
    const filterParam = c.req.query("filter");
    const filters = filterParam ? filterParam.split(",").map(f => f.trim()) : null;

    return streamSSE(c, async (stream) => {
      const clientId = nanoid();

      const client: SSEClient = {
        id: clientId,
        send(event: string, data: unknown, eventId: string) {
          // Apply event filter if specified
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

      sseBridge.addClient(client, lastEventId ?? undefined);

      // Keep connection alive with periodic comments
      const heartbeat = setInterval(() => {
        try {
          stream.writeSSE({ event: "heartbeat", data: "" });
        } catch { /* client disconnected */
          clearInterval(heartbeat);
          sseBridge.removeClient(clientId);
        }
      }, 30_000);

      // Clean up when stream closes
      stream.onAbort(() => {
        clearInterval(heartbeat);
        sseBridge.removeClient(clientId);
      });

      // Block to keep stream open
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
      const prefix = filter.slice(0, -1); // "task:"
      if (event.startsWith(prefix)) return true;
    }
    if (filter === "*") return true;
  }
  return false;
}
