// Web Push subscription routes. The subscription store is always file-based
// (`.polpo/push.json`) regardless of the `storage` setting — same policy as
// the vault. The Drizzle equivalent in @polpo-ai/drizzle is unused at runtime
// (kept only so the schema stays in sync with what other stores look like).
// Single source of truth = the file; no migration runs for these rows.
import { OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";
import { FilePushSubscriptionStore } from "../../stores/file-push-subscription-store.js";

const PushSubscriptionSchema = z.object({
  endpoint: z.string().url(),
  expirationTime: z.number().nullable().optional(),
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1),
  }),
});

const UnsubscribeSchema = z.object({
  endpoint: z.string().url(),
});

export function pushRoutes(getDeps: () => { polpoDir: string }): OpenAPIHono {
  const app = new OpenAPIHono();

  app.get("/public-key", (c) => {
    const store = new FilePushSubscriptionStore(getDeps().polpoDir);
    const vapid = store.ensureVapid();
    return c.json({ ok: true, data: { publicKey: vapid.publicKey } });
  });

  app.get("/status", (c) => {
    const store = new FilePushSubscriptionStore(getDeps().polpoDir);
    const vapid = store.ensureVapid();
    return c.json({
      ok: true,
      data: {
        supported: true,
        publicKey: vapid.publicKey,
        subscriptions: store.count(),
      },
    });
  });

  app.post("/subscribe", async (c) => {
    const parsed = PushSubscriptionSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      return c.json({ ok: false, error: "Invalid push subscription" }, 400);
    }
    const store = new FilePushSubscriptionStore(getDeps().polpoDir);
    store.ensureVapid();
    const record = store.upsert(parsed.data, c.req.header("user-agent") ?? undefined);
    return c.json({
      ok: true,
      data: {
        endpoint: record.endpoint,
        subscriptions: store.count(),
      },
    });
  });

  app.post("/unsubscribe", async (c) => {
    const parsed = UnsubscribeSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      return c.json({ ok: false, error: "Invalid push unsubscribe request" }, 400);
    }
    const store = new FilePushSubscriptionStore(getDeps().polpoDir);
    const removed = store.remove(parsed.data.endpoint);
    return c.json({ ok: true, data: { removed, subscriptions: store.count() } });
  });

  return app;
}
