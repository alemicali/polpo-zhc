import { OpenAPIHono } from "@hono/zod-openapi";
import { nanoid } from "nanoid";
import { z } from "zod";
import type { VaultStore } from "../../core/vault-store.js";
import { normalizeDataTags, type DataRegistryStore } from "../../core/data-registry.js";
import type { DataRuntime } from "../data-runtime.js";

const GrantSchema = z.object({
  id: z.string().optional(),
  agent: z.string().trim().min(1),
  capabilities: z.array(z.enum(["read", "write", "admin"])).min(1),
  datasets: z.array(z.string().trim().min(1)).default(["*"]),
  excludedFields: z.array(z.string().trim().min(1)).optional(),
});

const SourceSchema = z.object({
  name: z.string().trim().min(1),
  slug: z.string().trim().min(1).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  description: z.string().trim().optional(),
  kind: z.enum(["sqlite", "postgres", "rest", "json", "csv"]),
  environment: z.enum(["development", "staging", "production"]).default("development"),
  config: z.object({
    location: z.string().trim().min(1),
    port: z.number().int().min(1).max(65535).optional(),
    database: z.string().trim().optional(),
    username: z.string().trim().optional(),
    ssl: z.boolean().optional(),
    defaultDataset: z.string().trim().optional(),
  }),
  credentials: z.record(z.string(), z.string()).optional(),
  tags: z.array(z.string()).default([]),
  grants: z.array(GrantSchema).default([]),
});

const FilterSchema = z.object({
  field: z.string().min(1),
  operator: z.enum(["eq", "neq", "gt", "gte", "lt", "lte", "contains", "startsWith", "in", "isNull"]),
  value: z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))]).optional(),
});

const QuerySchema = z.object({
  sourceId: z.string().min(1),
  dataset: z.string().min(1),
  fields: z.array(z.string()).optional(),
  filters: z.array(FilterSchema).optional(),
  sort: z.array(z.object({ field: z.string().min(1), direction: z.enum(["asc", "desc"]) })).optional(),
  groupBy: z.array(z.string()).optional(),
  aggregates: z.array(z.object({
    field: z.string(), operation: z.enum(["count", "sum", "avg", "min", "max"]), as: z.string().optional(),
  })).optional(),
  limit: z.number().int().positive().max(1000).optional(),
  offset: z.number().int().nonnegative().optional(),
});

export function dataRoutes(getDeps: () => { runtime: DataRuntime; store: DataRegistryStore; vaultStore?: VaultStore }): OpenAPIHono {
  const app = new OpenAPIHono();

  app.get("/", async (c) => c.json({ ok: true, data: await getDeps().runtime.listSources() }));

  app.post("/", async (c) => {
    const parsed = SourceSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return invalid(c, parsed.error.issues[0]?.message);
    const { credentials, ...input } = parsed.data;
    try {
      const created = await getDeps().store.createSource({
        ...input,
        tags: normalizeDataTags(input.tags),
        grants: input.grants.map((grant) => ({ ...grant, id: grant.id ?? nanoid() })),
      });
      if (credentials && Object.keys(credentials).length) await saveCredentials(getDeps().vaultStore, created.id, credentials);
      return c.json({ ok: true, data: created }, 201);
    } catch (error) { return failure(c, error); }
  });

  app.post("/query", async (c) => {
    const parsed = QuerySchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return invalid(c, parsed.error.issues[0]?.message);
    try { return c.json({ ok: true, data: await getDeps().runtime.query(parsed.data) }); }
    catch (error) { return failure(c, error); }
  });

  app.post("/sql", async (c) => {
    const parsed = z.object({ sourceId: z.string().min(1), sql: z.string().min(1) }).safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return invalid(c, parsed.error.issues[0]?.message);
    try { return c.json({ ok: true, data: await getDeps().runtime.rawSql(parsed.data.sourceId, parsed.data.sql, { admin: true }) }); }
    catch (error) { return failure(c, error); }
  });

  app.post("/mutate", async (c) => {
    const parsed = z.object({
      sourceId: z.string().min(1), dataset: z.string().min(1),
      operation: z.enum(["insert", "update", "delete"]),
      values: z.record(z.string(), z.unknown()).optional(), filters: z.array(FilterSchema).optional(),
    }).safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return invalid(c, parsed.error.issues[0]?.message);
    try { return c.json({ ok: true, data: await getDeps().runtime.mutate(parsed.data, { admin: true }) }); }
    catch (error) { return failure(c, error); }
  });

  app.get("/:id", async (c) => {
    const source = await getDeps().store.getSource(c.req.param("id"));
    return source ? c.json({ ok: true, data: source }) : c.json({ ok: false, error: "Data source not found" }, 404);
  });

  app.put("/:id", async (c) => {
    const parsed = SourceSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return invalid(c, parsed.error.issues[0]?.message);
    const { credentials, ...input } = parsed.data;
    try {
      const current = await getDeps().store.getSource(c.req.param("id"));
      if (!current) return c.json({ ok: false, error: "Data source not found" }, 404);
      const updated = await getDeps().store.updateSource(current.id, {
        ...input, tags: normalizeDataTags(input.tags),
        grants: input.grants.map((grant) => ({ ...grant, id: grant.id ?? nanoid() })),
      });
      if (credentials && Object.keys(credentials).length) await saveCredentials(getDeps().vaultStore, current.id, credentials);
      return c.json({ ok: true, data: updated! });
    } catch (error) { return failure(c, error); }
  });

  app.delete("/:id", async (c) => {
    const current = await getDeps().store.getSource(c.req.param("id"));
    if (!current) return c.json({ ok: false, error: "Data source not found" }, 404);
    await getDeps().store.deleteSource(current.id);
    await getDeps().vaultStore?.remove("$data", `data:${current.id}`).catch(() => undefined);
    return c.json({ ok: true });
  });

  app.post("/:id/test", async (c) => {
    try { return c.json({ ok: true, data: await getDeps().runtime.test(c.req.param("id")) }); }
    catch (error) { return failure(c, error); }
  });

  app.get("/:id/schema", async (c) => {
    try { return c.json({ ok: true, data: await getDeps().runtime.discover(c.req.param("id")) }); }
    catch (error) { return failure(c, error); }
  });

  app.get("/:id/activity", async (c) => {
    const limit = Number(c.req.query("limit") ?? 100);
    return c.json({ ok: true, data: await getDeps().store.listActivity(c.req.param("id"), limit) });
  });

  return app;
}

async function saveCredentials(vaultStore: VaultStore | undefined, sourceId: string, credentials: Record<string, string>): Promise<void> {
  if (!vaultStore) throw new Error("Vault is unavailable; data source credentials could not be stored securely");
  const service = `data:${sourceId}`;
  const existing = await vaultStore.get("$data", service);
  await vaultStore.set("$data", service, {
    type: "custom", label: `Data source ${sourceId}`,
    credentials: { ...(existing?.credentials ?? {}), ...credentials },
  });
}

function invalid(c: any, error = "Invalid request") { return c.json({ ok: false, error }, 400); }
function failure(c: any, error: unknown) { return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 400); }
