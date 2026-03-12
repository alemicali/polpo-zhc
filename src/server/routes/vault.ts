/**
 * Vault REST API — direct CRUD for encrypted vault entries.
 *
 * POST /vault/entries — Save a vault entry (used by UI after vault_preview confirm)
 * DELETE /vault/entries/:agent/:service — Remove a vault entry
 *
 * This bypasses the LLM entirely — credentials go straight to the encrypted store.
 * No credentials are logged, persisted in session history, or returned in responses.
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { ServerEnv } from "../app.js";
import type { VaultEntry } from "../../core/types.js";

export function vaultRoutes(): OpenAPIHono<ServerEnv> {
  const app = new OpenAPIHono<ServerEnv>();

  // POST /vault/entries — save a vault entry
  const saveEntryRoute = createRoute({
    method: "post",
    path: "/entries",
    tags: ["Vault"],
    summary: "Save vault entry",
    description: "Save credentials to the encrypted vault store. Credentials are encrypted at rest (AES-256-GCM) and never logged or persisted in chat history.",
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({
              agent: z.string().min(1).describe("Agent name"),
              service: z.string().min(1).describe("Service name (vault key)"),
              type: z.enum(["smtp", "imap", "oauth", "api_key", "login", "custom"]).describe("Credential type"),
              label: z.string().optional().describe("Human-readable label"),
              credentials: z.record(z.string(), z.string()).describe("Key-value credential fields"),
            }),
          },
        },
      },
    },
    responses: {
      200: {
        content: {
          "application/json": {
            schema: z.object({
              ok: z.boolean(),
              data: z.object({
                agent: z.string(),
                service: z.string(),
                type: z.string(),
                keys: z.array(z.string()),
              }),
            }),
          },
        },
        description: "Vault entry saved successfully",
      },
      503: {
        content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string() }) } },
        description: "Vault store not available",
      },
    },
  });

  app.openapi(saveEntryRoute, async (c) => {
    const orchestrator = c.get("orchestrator");
    const vaultStore = orchestrator.getVaultStore();
    if (!vaultStore) {
      return c.json({ ok: false, error: "Vault store not available. Check POLPO_VAULT_KEY or ~/.polpo/vault.key." }, 503);
    }

    const body = c.req.valid("json");
    const entry: VaultEntry = {
      type: body.type,
      ...(body.label ? { label: body.label } : {}),
      credentials: body.credentials,
    };

    await vaultStore.set(body.agent, body.service, entry);

    // Return only metadata — NEVER return credential values
    return c.json({
      ok: true,
      data: {
        agent: body.agent,
        service: body.service,
        type: body.type,
        keys: Object.keys(body.credentials),
      },
    }, 200);
  });

  // GET /vault/entries/:agent — list vault entries (metadata only, no credential values)
  const listEntriesRoute = createRoute({
    method: "get",
    path: "/entries/{agent}",
    tags: ["Vault"],
    summary: "List vault entries",
    description: "Returns metadata (service name, type, label, credential key names) without any secret values.",
    request: {
      params: z.object({
        agent: z.string(),
      }),
    },
    responses: {
      200: {
        content: {
          "application/json": {
            schema: z.object({
              ok: z.boolean(),
              data: z.array(z.object({
                service: z.string(),
                type: z.enum(["smtp", "imap", "oauth", "api_key", "login", "custom"]),
                label: z.string().optional(),
                keys: z.array(z.string()),
              })),
            }),
          },
        },
        description: "Vault entries metadata for the agent",
      },
      503: {
        content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string() }) } },
        description: "Vault store not available",
      },
    },
  });

  app.openapi(listEntriesRoute, async (c) => {
    const orchestrator = c.get("orchestrator");
    const vaultStore = orchestrator.getVaultStore();
    if (!vaultStore) {
      return c.json({ ok: false, error: "Vault store not available. Check POLPO_VAULT_KEY or ~/.polpo/vault.key." }, 503);
    }

    const { agent } = c.req.valid("param");
    const entries = await vaultStore.list(agent);
    return c.json({ ok: true, data: entries }, 200);
  });

  // PATCH /vault/entries/:agent/:service — partially update credentials
  const patchEntryRoute = createRoute({
    method: "patch",
    path: "/entries/{agent}/{service}",
    tags: ["Vault"],
    summary: "Update vault credentials",
    description: "Partially update credential fields in an existing vault entry. Only the provided fields are merged — existing fields are preserved. Optionally update type and label.",
    request: {
      params: z.object({
        agent: z.string(),
        service: z.string(),
      }),
      body: {
        content: {
          "application/json": {
            schema: z.object({
              type: z.enum(["smtp", "imap", "oauth", "api_key", "login", "custom"]).optional().describe("Update credential type"),
              label: z.string().optional().describe("Update human-readable label"),
              credentials: z.record(z.string(), z.string()).optional().describe("Credential fields to add or update (merged with existing)"),
            }),
          },
        },
      },
    },
    responses: {
      200: {
        content: {
          "application/json": {
            schema: z.object({
              ok: z.boolean(),
              data: z.object({
                agent: z.string(),
                service: z.string(),
                type: z.string(),
                keys: z.array(z.string()),
              }),
            }),
          },
        },
        description: "Vault entry updated successfully",
      },
      404: {
        content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string() }) } },
        description: "Vault entry not found",
      },
      503: {
        content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string() }) } },
        description: "Vault store not available",
      },
    },
  });

  app.openapi(patchEntryRoute, async (c) => {
    const orchestrator = c.get("orchestrator");
    const vaultStore = orchestrator.getVaultStore();
    if (!vaultStore) {
      return c.json({ ok: false, error: "Vault store not available. Check POLPO_VAULT_KEY or ~/.polpo/vault.key." }, 503);
    }

    const { agent, service } = c.req.valid("param");
    const existing = await vaultStore.get(agent, service);
    if (!existing) {
      return c.json({ ok: false, error: `No vault entry "${service}" for agent "${agent}".` }, 404);
    }

    const body = c.req.valid("json");
    const mergedKeys = await vaultStore.patch(agent, service, {
      type: body.type,
      label: body.label,
      credentials: body.credentials,
    });

    const updated = (await vaultStore.get(agent, service))!;
    return c.json({
      ok: true,
      data: {
        agent,
        service,
        type: updated.type,
        keys: mergedKeys,
      },
    }, 200);
  });

  // DELETE /vault/entries/:agent/:service — remove a vault entry
  const deleteEntryRoute = createRoute({
    method: "delete",
    path: "/entries/{agent}/{service}",
    tags: ["Vault"],
    summary: "Remove vault entry",
    request: {
      params: z.object({
        agent: z.string(),
        service: z.string(),
      }),
    },
    responses: {
      200: {
        content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.object({ removed: z.boolean() }) }) } },
        description: "Result",
      },
      503: {
        content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string() }) } },
        description: "Vault store not available",
      },
    },
  });

  app.openapi(deleteEntryRoute, async (c) => {
    const orchestrator = c.get("orchestrator");
    const vaultStore = orchestrator.getVaultStore();
    if (!vaultStore) {
      return c.json({ ok: false, error: "Vault store not available." }, 503);
    }

    const { agent, service } = c.req.valid("param");
    const removed = await vaultStore.remove(agent, service);
    return c.json({ ok: true, data: { removed } }, 200);
  });

  return app;
}
