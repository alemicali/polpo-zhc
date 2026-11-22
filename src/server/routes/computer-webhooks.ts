/**
 * Provider webhooks for computers (see sandbox/computer-webhooks.ts).
 *
 * Public (no dashboard auth; the provider's signature is the authentication):
 *   POST /api/v1/computers/webhooks/:provider   a delivery from Daytona or E2B (signature-verified, 256 KB at most,
 *                                               rate limited, replays refused). Behind Tailscale Funnel, the path
 *                                               /<instance>/api/v1/computers/webhooks/ must be exposed too.
 *
 * Authenticated (/api/v1/computer-webhooks):
 *   GET    /                         each provider's status: secret set, registered (E2B), the URL to give the provider,
 *                                    last event, counts; never a secret
 *   PUT    /:provider/secret         { secret }: the signing secret (Daytona's whsec_…) into the vault (the dashboard only)
 *   DELETE /:provider/secret
 *   POST   /e2b/register             register this instance's endpoint at E2B (a fresh secret, kept in the vault)
 *   DELETE /e2b/register             unregister it
 */
import { Hono } from "hono";
import { COMPUTER_WEBHOOK_PROVIDERS, WEBHOOK_MAX_BODY_BYTES, type ComputerWebhookProviderId, type ComputerWebhooks } from "../../sandbox/computer-webhooks.js";

export interface ComputerWebhookRouteDeps {
  webhooks: () => ComputerWebhooks | undefined;
}

/** The note on exposing the endpoint (Tailscale Funnel exposes only listed paths). */
export const COMPUTER_WEBHOOK_FUNNEL_NOTE = "The provider must reach POLPO_PUBLIC_URL + /api/v1/computers/webhooks/<provider>: "
  + "behind Tailscale Funnel, expose the path /<instance>/api/v1/computers/webhooks/ as well (not only /mcp).";

export function computerWebhookInboundRoutes(deps: ComputerWebhookRouteDeps): Hono {
  const app = new Hono();
  app.post("/:provider", async (c) => {
    const w = deps.webhooks();
    if (!w) return c.json({ ok: false, error: "Polpo is not initialized" }, 503);
    const length = Number(c.req.header("content-length") ?? "0");
    if (length > WEBHOOK_MAX_BODY_BYTES) return c.json({ ok: false, error: "Body too large" }, 413);
    const raw = await c.req.text();
    const r = await w.handle(c.req.param("provider"), raw, (name) => c.req.header(name));
    return c.json(r.body, r.status);
  });
  return app;
}

export function computerWebhookAdminRoutes(deps: ComputerWebhookRouteDeps): Hono {
  const app = new Hono();
  const known = (p: string): p is ComputerWebhookProviderId => p in COMPUTER_WEBHOOK_PROVIDERS;
  const need = () => {
    const w = deps.webhooks();
    if (!w) throw new Error("Polpo is not initialized");
    return w;
  };

  app.get("/", async (c) => c.json({ ok: true, data: { providers: await need().status(), note: COMPUTER_WEBHOOK_FUNNEL_NOTE, reconcileOnly: ["vercel"] } }));

  app.put("/:provider/secret", async (c) => {
    const p = c.req.param("provider");
    if (!known(p)) return c.json({ ok: false, error: `No webhooks for provider "${p}"`, code: "NOT_FOUND" }, 404);
    if (COMPUTER_WEBHOOK_PROVIDERS[p].registration === "api") return c.json({ ok: false, error: `${COMPUTER_WEBHOOK_PROVIDERS[p].label}'s secret is made by Polpo when it registers the webhook (POST /computer-webhooks/${p}/register)`, code: "VALIDATION_ERROR" }, 400);
    const body = await c.req.json().catch(() => ({})) as { secret?: unknown };
    if (typeof body.secret !== "string") return c.json({ ok: false, error: "Send { secret }", code: "VALIDATION_ERROR" }, 400);
    try {
      await need().setSecret(p, body.secret);
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message, code: "VALIDATION_ERROR" }, 400);
    }
    return c.json({ ok: true, data: (await need().status()).find((s) => s.provider === p) });
  });

  app.delete("/:provider/secret", async (c) => {
    const p = c.req.param("provider");
    if (!known(p)) return c.json({ ok: false, error: `No webhooks for provider "${p}"`, code: "NOT_FOUND" }, 404);
    await need().setSecret(p, null);
    return c.json({ ok: true, data: (await need().status()).find((s) => s.provider === p) });
  });

  app.post("/e2b/register", async (c) => {
    try {
      return c.json({ ok: true, data: await need().registerE2b() });
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message, code: "PROVIDER_ERROR" }, 502);
    }
  });

  app.delete("/e2b/register", async (c) => {
    try {
      await need().unregisterE2b();
      return c.json({ ok: true, data: (await need().status()).find((s) => s.provider === "e2b") });
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message, code: "PROVIDER_ERROR" }, 502);
    }
  });

  return app;
}
