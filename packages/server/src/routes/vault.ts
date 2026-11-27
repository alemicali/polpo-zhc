/**
 * Vault REST API — direct CRUD for encrypted vault entries.
 *
 * POST /vault/entries — Save a vault entry (used by UI after vault_preview confirm)
 * POST /vault/entries/:agent/:service/generate — A login with a generated password (never returned)
 * DELETE /vault/entries/:agent/:service — Remove a vault entry
 *
 * This bypasses the LLM entirely — credentials go straight to the encrypted store.
 * No credentials are logged, persisted in session history, or returned in responses.
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { VaultEntry } from "@polpo-ai/core/types";
import {
  isReservedVaultOwner, generateVaultLogin, vaultLoginFillHint,
  VAULT_PASSWORD_DEFAULT_LENGTH, VAULT_PASSWORD_MAX_LENGTH, VAULT_PASSWORD_MIN_LENGTH,
} from "@polpo-ai/core/vault-store";

const provenanceSchema = z.object({
  kind: z.enum(["agent", "person"]).describe("agent: the agent made it (vault_create_login); person: someone through the dashboard or the API"),
  agent: z.string().optional(),
  taskId: z.string().optional(),
  sessionId: z.string().optional(),
  runId: z.string().optional(),
  by: z.string().optional().describe("The person, when known"),
});

/** The person behind a request, when the instance knows it (signed-in member). */
function personOf(c: { get(key: never): unknown }): string | undefined {
  const v = c.get("polpoUserEmail" as never);
  return typeof v === "string" && v ? v.toLowerCase() : undefined;
}

/**
 * Owners starting with "$" ("$data", "$providers", ...) are system namespaces
 * written only by internal code. They are not addressable through this API,
 * and cannot be granted access via allowedAgents.
 */
const RESERVED_OWNER_ERROR = 'Vault owners starting with "$" are reserved for system use';

export function vaultRoutes(getDeps: () => {
  vaultStore?: any;
  /** The agent's display name (default label "<Service> – <display name>"). */
  agentDisplayName?: (agent: string) => string | undefined | Promise<string | undefined>;
}): OpenAPIHono {
  const app = new OpenAPIHono();

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
              agent: z.string().min(1).describe("Agent name (owner)"),
              service: z.string().min(1).describe("Service name (vault key)"),
              type: z.enum(["smtp", "imap", "oauth", "api_key", "login", "custom"]).describe("Credential type"),
              label: z.string().optional().describe("Human-readable label"),
              account: z.string().optional().describe("Logical mailbox account (groups SMTP+IMAP of the same mailbox). Optional — defaults to `service` for grouping purposes."),
              allowedAgents: z.array(z.string()).optional().describe("Other agent names allowed to use this credential (shared). Owner is always implicit and never in this list. Empty/omitted = owner-private."),
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
      400: {
        content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string() }) } },
        description: "Reserved vault owner",
      },
      503: {
        content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string() }) } },
        description: "Vault store not available",
      },
    },
  });

  app.openapi(saveEntryRoute, async (c) => {
    const { vaultStore } = getDeps();
    if (!vaultStore) {
      return c.json({ ok: false, error: "Vault store not available. Check POLPO_VAULT_KEY or ~/.polpo/vault.key." }, 503);
    }

    const body = c.req.valid("json");
    if (isReservedVaultOwner(body.agent) || (body.allowedAgents ?? []).some(isReservedVaultOwner)) {
      return c.json({ ok: false, error: RESERVED_OWNER_ERROR }, 400);
    }
    // Defensive: owner can't list themselves in allowedAgents (it would
    // be a no-op anyway since the owner is always implicit).
    const allowedAgents = (body.allowedAgents ?? []).filter((n: string) => n && n !== body.agent);
    // provenance: a new entry is a person's; a replaced one keeps who made it (its values are no longer generated)
    const existing: VaultEntry | undefined = await vaultStore.get(body.agent, body.service).catch(() => undefined);
    const by = personOf(c);
    const { generated: _generated, ...kept } = existing?.metadata ?? {};
    const metadata = existing?.metadata
      ? kept
      : { createdBy: { kind: "person" as const, ...(by ? { by } : {}) }, createdAt: new Date().toISOString() };
    const entry: VaultEntry = {
      type: body.type,
      ...(body.label ? { label: body.label } : {}),
      ...(body.account ? { account: body.account } : {}),
      ...(allowedAgents.length > 0 ? { allowedAgents } : {}),
      credentials: body.credentials,
      ...(Object.keys(metadata).length ? { metadata } : {}),
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
                account: z.string().optional(),
                allowedAgents: z.array(z.string()).optional(),
                sharedFrom: z.string().optional().describe("Set when this entry is inherited via shared credentials. Identifies the owner agent."),
                readOnly: z.boolean().optional().describe("True for inherited entries — UI should disable edit/delete."),
                keys: z.array(z.string()),
                createdBy: provenanceSchema.optional().describe("Who created the entry (absent on entries older than provenance)"),
                createdAt: z.string().optional().describe("When it was created (ISO)"),
                rotatedAt: z.string().optional().describe("When its generated password was last rotated (ISO)"),
                rotatedBy: provenanceSchema.optional(),
                generated: z.array(z.string()).optional().describe("Keys whose values Polpo generated (never shown to a model)"),
              })),
            }),
          },
        },
        description: "Vault entries metadata for the agent",
      },
      400: {
        content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string() }) } },
        description: "Reserved vault owner",
      },
      503: {
        content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string() }) } },
        description: "Vault store not available",
      },
    },
  });

  app.openapi(listEntriesRoute, async (c) => {
    const { vaultStore } = getDeps();
    if (!vaultStore) {
      return c.json({ ok: false, error: "Vault store not available. Check POLPO_VAULT_KEY or ~/.polpo/vault.key." }, 503);
    }

    const { agent } = c.req.valid("param");
    if (isReservedVaultOwner(agent)) {
      return c.json({ ok: false, error: RESERVED_OWNER_ERROR }, 400);
    }
    const entries = await vaultStore.list(agent);
    return c.json({ ok: true, data: entries }, 200);
  });

  // POST /vault/entries/:agent/:service/generate — a login with a generated password
  const generateRoute = createRoute({
    method: "post",
    path: "/entries/{agent}/{service}/generate",
    tags: ["Vault"],
    summary: "Generate a login",
    description: "Create a login entry in an agent's vault with a password Polpo generates (CSPRNG; at least one lowercase, uppercase, digit and, "
      + "with symbols, one symbol without quotes, backslashes or spaces). The password is never returned: the agent fills it with "
      + "browser_fill { from_vault: \"<service>.password\" }. An existing entry is refused unless rotate is true (then only the password "
      + "changes and rotatedAt is recorded).",
    request: {
      params: z.object({ agent: z.string(), service: z.string() }),
      body: {
        content: {
          "application/json": {
            schema: z.object({
              username: z.string().optional(),
              email: z.string().optional(),
              url: z.string().optional().describe("The site (http/https)"),
              label: z.string().optional().describe("Default: \"<Service> – <agent display name>\""),
              length: z.number().int().min(VAULT_PASSWORD_MIN_LENGTH).max(VAULT_PASSWORD_MAX_LENGTH).optional().describe(`Default ${VAULT_PASSWORD_DEFAULT_LENGTH}`),
              symbols: z.boolean().optional().describe("Include symbols (default true)"),
              rotate: z.boolean().optional().describe("Replace the password of an existing login (keeps username, email and url)"),
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
                action: z.enum(["created", "rotated"]),
                keys: z.array(z.string()).describe("Credential key names (never values)"),
                label: z.string().optional(),
                fill: z.string().describe("How the agent uses the password"),
                createdBy: provenanceSchema.optional(),
                createdAt: z.string().optional(),
                rotatedAt: z.string().optional(),
              }),
            }),
          },
        },
        description: "Login generated (the password is not in the response)",
      },
      400: { content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string() }) } }, description: "Invalid request or reserved vault owner" },
      404: { content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string() }) } }, description: "Nothing to rotate" },
      409: { content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string() }) } }, description: "The entry exists (pass rotate: true)" },
      503: { content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string() }) } }, description: "Vault store not available" },
    },
  });

  app.openapi(generateRoute, async (c) => {
    const { vaultStore, agentDisplayName } = getDeps();
    if (!vaultStore) {
      return c.json({ ok: false, error: "Vault store not available. Check POLPO_VAULT_KEY or ~/.polpo/vault.key." }, 503);
    }
    const { agent, service } = c.req.valid("param");
    if (isReservedVaultOwner(agent)) return c.json({ ok: false, error: RESERVED_OWNER_ERROR }, 400);
    const body = c.req.valid("json");
    const by = personOf(c);
    const displayName = await Promise.resolve(agentDisplayName?.(agent)).catch(() => undefined);
    const r = await generateVaultLogin(vaultStore, agent, { ...body, service }, { kind: "person", ...(by ? { by } : {}) }, {
      ...(displayName ? { ownerDisplayName: displayName } : {}),
    });
    if (!r.ok) {
      const status = r.code === "exists" ? 409 : r.code === "not_found" ? 404 : 400;
      return c.json({ ok: false, error: r.error }, status);
    }
    // only names and provenance: NEVER the password
    return c.json({
      ok: true,
      data: {
        agent, service: r.service, action: r.action, keys: r.keys, ...(r.label ? { label: r.label } : {}), fill: vaultLoginFillHint(r.service),
        ...(r.metadata.createdBy ? { createdBy: r.metadata.createdBy } : {}),
        ...(r.metadata.createdAt ? { createdAt: r.metadata.createdAt } : {}),
        ...(r.metadata.rotatedAt ? { rotatedAt: r.metadata.rotatedAt } : {}),
      },
    }, 200);
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
              account: z.string().optional().describe("Update logical mailbox account name. Pass empty string to clear."),
              allowedAgents: z.array(z.string()).optional().describe("Replace the list of agents allowed to use this credential. Pass [] to revoke all shares (turn back into owner-private)."),
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
      400: {
        content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string() }) } },
        description: "Reserved vault owner",
      },
      503: {
        content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string() }) } },
        description: "Vault store not available",
      },
    },
  });

  app.openapi(patchEntryRoute, async (c) => {
    const { vaultStore } = getDeps();
    if (!vaultStore) {
      return c.json({ ok: false, error: "Vault store not available. Check POLPO_VAULT_KEY or ~/.polpo/vault.key." }, 503);
    }

    const { agent, service } = c.req.valid("param");
    if (isReservedVaultOwner(agent)) {
      return c.json({ ok: false, error: RESERVED_OWNER_ERROR }, 400);
    }
    const existing = await vaultStore.get(agent, service);
    if (!existing) {
      return c.json({ ok: false, error: `No vault entry "${service}" for agent "${agent}".` }, 404);
    }

    const body = c.req.valid("json");
    if ((body.allowedAgents ?? []).some(isReservedVaultOwner)) {
      return c.json({ ok: false, error: RESERVED_OWNER_ERROR }, 400);
    }
    const allowedAgents = body.allowedAgents
      ? body.allowedAgents.filter((n: string) => n && n !== agent)
      : undefined;
    const mergedKeys = await vaultStore.patch(agent, service, {
      type: body.type,
      label: body.label,
      account: body.account,
      allowedAgents,
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
      400: {
        content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string() }) } },
        description: "Reserved vault owner",
      },
      503: {
        content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string() }) } },
        description: "Vault store not available",
      },
    },
  });

  app.openapi(deleteEntryRoute, async (c) => {
    const { vaultStore } = getDeps();
    if (!vaultStore) {
      return c.json({ ok: false, error: "Vault store not available." }, 503);
    }

    const { agent, service } = c.req.valid("param");
    if (isReservedVaultOwner(agent)) {
      return c.json({ ok: false, error: RESERVED_OWNER_ERROR }, 400);
    }
    const removed = await vaultStore.remove(agent, service);
    return c.json({ ok: true, data: { removed } }, 200);
  });

  return app;
}
