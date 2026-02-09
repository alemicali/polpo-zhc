import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { nanoid } from "nanoid";
import type { ServerEnv } from "../app.js";
import type { ProjectManager } from "../project-manager.js";
import type { SSEClient } from "../sse-bridge.js";

/**
 * SSE streaming + WebSocket event routes.
 */
export function eventRoutes(pm: ProjectManager): Hono<ServerEnv> {
  const app = new Hono<ServerEnv>();

  // GET /events — SSE event stream
  app.get("/", (c) => {
    const projectId = c.get("projectId");
    const sseBridge = pm.getSSEBridge(projectId);
    if (!sseBridge) {
      return c.json({ ok: false, error: "Project not found", code: "NOT_FOUND" }, 404);
    }

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
        } catch {
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
