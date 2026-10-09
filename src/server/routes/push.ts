// Web Push subscription routes. Subscriptions live in the project's database, or in
// .polpo/push.json when the project runs on files.
import { OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";
import { pushSubscriptionStoreFor } from "../../stores/notification-device-stores.js";

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

  app.get("/public-key", async (c) => {
    const store = pushSubscriptionStoreFor(getDeps().polpoDir);
    const vapid = await store.ensureVapid();
    return c.json({ ok: true, data: { publicKey: vapid.publicKey } });
  });

  app.get("/status", async (c) => {
    const store = pushSubscriptionStoreFor(getDeps().polpoDir);
    const vapid = await store.ensureVapid();
    return c.json({
      ok: true,
      data: {
        supported: true,
        publicKey: vapid.publicKey,
        subscriptions: await store.count(),
      },
    });
  });

  app.post("/subscribe", async (c) => {
    const parsed = PushSubscriptionSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      return c.json({ ok: false, error: "Invalid push subscription" }, 400);
    }
    const store = pushSubscriptionStoreFor(getDeps().polpoDir);
    await store.ensureVapid();
    const record = await store.upsert(parsed.data, c.req.header("user-agent") ?? undefined);
    return c.json({
      ok: true,
      data: {
        endpoint: record.endpoint,
        subscriptions: await store.count(),
      },
    });
  });

  app.post("/unsubscribe", async (c) => {
    const parsed = UnsubscribeSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      return c.json({ ok: false, error: "Invalid push unsubscribe request" }, 400);
    }
    const store = pushSubscriptionStoreFor(getDeps().polpoDir);
    const removed = await store.remove(parsed.data.endpoint);
    return c.json({ ok: true, data: { removed, subscriptions: await store.count() } });
  });

  return app;
}
