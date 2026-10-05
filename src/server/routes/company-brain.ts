import { OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";
import type { CompanyBrainRuntime } from "../company-brain-runtime.js";

const Status = z.enum(["candidate", "confirmed", "rejected", "archived"]);
const Evidence = z.object({
  id: z.string().optional(),
  sourceType: z.enum(["data-source", "file", "chat", "task", "mission", "app", "manual"]),
  sourceId: z.string().min(1), dataset: z.string().optional(), recordId: z.string().optional(), excerpt: z.string().max(2_000).optional(),
  observedAt: z.string().optional(), confidence: z.number().min(0).max(1).default(1),
}).transform((value) => ({ ...value, id: value.id ?? crypto.randomUUID(), observedAt: value.observedAt ?? new Date().toISOString() }));
const EntityInput = z.object({
  id: z.string().optional(), type: z.string().trim().min(1), name: z.string().trim().min(1),
  aliases: z.array(z.string()).optional(), summary: z.string().optional(), properties: z.record(z.string(), z.unknown()).optional(),
  tags: z.array(z.string()).optional(), confidence: z.number().min(0).max(1).optional(), status: Status.optional(), evidence: z.array(Evidence).optional(),
});
const RelationInput = z.object({
  id: z.string().optional(), fromId: z.string().min(1), toId: z.string().min(1), type: z.string().trim().min(1),
  label: z.string().optional(), properties: z.record(z.string(), z.unknown()).optional(), confidence: z.number().min(0).max(1).optional(),
  status: Status.optional(), validFrom: z.string().optional(), validTo: z.string().optional(), evidence: z.array(Evidence).optional(),
});
const ClaimInput = z.object({
  id: z.string().optional(), entityId: z.string().min(1), predicate: z.string().trim().min(1), value: z.unknown(),
  confidence: z.number().min(0).max(1).optional(), status: Status.optional(), validFrom: z.string().optional(), validTo: z.string().optional(), evidence: z.array(Evidence).optional(),
});

export function companyBrainRoutes(getRuntime: () => CompanyBrainRuntime): OpenAPIHono {
  const app = new OpenAPIHono();

  app.get("/graph", async (c) => {
    try {
      const statuses = split(c.req.query("statuses")).filter((value): value is z.infer<typeof Status> => Status.safeParse(value).success);
      return c.json({ ok: true, data: await getRuntime().graph({
        query: c.req.query("q"), entityTypes: split(c.req.query("types")), statuses: statuses.length ? statuses : undefined,
        entityId: c.req.query("entityId"), depth: number(c.req.query("depth")), limit: number(c.req.query("limit")),
      }) });
    } catch (error) { return failure(c, error); }
  });
  app.get("/stats", async (c) => c.json({ ok: true, data: await getRuntime().stats() }));
  app.get("/search", async (c) => {
    const query = c.req.query("q")?.trim();
    if (!query) return invalid(c, "Search query is required");
    return c.json({ ok: true, data: await getRuntime().search(query, { admin: true }, number(c.req.query("limit")) ?? 20) });
  });
  app.get("/runs", async (c) => c.json({ ok: true, data: await getRuntime().runs({ admin: true }, number(c.req.query("limit")) ?? 50) }));
  app.get("/activity", async (c) => c.json({ ok: true, data: await getRuntime().activity({ admin: true }, number(c.req.query("limit")) ?? 100) }));
  app.get("/grants", async (c) => c.json({ ok: true, data: await getRuntime().grants() }));

  app.get("/entities/:id", async (c) => {
    try { return c.json({ ok: true, data: await getRuntime().getEntity(c.req.param("id")) }); }
    catch (error) { return failure(c, error, 404); }
  });
  app.post("/entities", async (c) => {
    const parsed = EntityInput.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return invalid(c, parsed.error.issues[0]?.message);
    try { return c.json({ ok: true, data: await getRuntime().upsertEntity(parsed.data) }, 201); }
    catch (error) { return failure(c, error); }
  });
  app.put("/entities/:id", async (c) => {
    const parsed = EntityInput.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return invalid(c, parsed.error.issues[0]?.message);
    try { return c.json({ ok: true, data: await getRuntime().upsertEntity({ ...parsed.data, id: c.req.param("id") }) }); }
    catch (error) { return failure(c, error); }
  });
  app.delete("/entities/:id", async (c) => {
    const deleted = await getRuntime().deleteSubject("entity", c.req.param("id"));
    return deleted ? c.json({ ok: true }) : c.json({ ok: false, error: "Brain entity not found" }, 404);
  });
  app.post("/relations", async (c) => {
    const parsed = RelationInput.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return invalid(c, parsed.error.issues[0]?.message);
    try { return c.json({ ok: true, data: await getRuntime().upsertRelation(parsed.data) }, 201); }
    catch (error) { return failure(c, error); }
  });
  app.put("/relations/:id", async (c) => {
    const parsed = RelationInput.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return invalid(c, parsed.error.issues[0]?.message);
    try { return c.json({ ok: true, data: await getRuntime().upsertRelation({ ...parsed.data, id: c.req.param("id") }) }); }
    catch (error) { return failure(c, error); }
  });
  app.delete("/relations/:id", async (c) => {
    const deleted = await getRuntime().deleteSubject("relation", c.req.param("id"));
    return deleted ? c.json({ ok: true }) : c.json({ ok: false, error: "Brain relation not found" }, 404);
  });
  app.post("/claims", async (c) => {
    const parsed = ClaimInput.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return invalid(c, parsed.error.issues[0]?.message);
    try { return c.json({ ok: true, data: await getRuntime().upsertClaim(parsed.data) }, 201); }
    catch (error) { return failure(c, error); }
  });
  app.delete("/claims/:id", async (c) => {
    const deleted = await getRuntime().deleteSubject("claim", c.req.param("id"));
    return deleted ? c.json({ ok: true }) : c.json({ ok: false, error: "Brain claim not found" }, 404);
  });
  app.post("/merge", async (c) => {
    const parsed = z.object({ keepId: z.string().min(1), mergeIds: z.array(z.string()).min(1) }).safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return invalid(c, parsed.error.issues[0]?.message);
    try { return c.json({ ok: true, data: await getRuntime().mergeEntities(parsed.data.keepId, parsed.data.mergeIds) }); }
    catch (error) { return failure(c, error); }
  });
  app.post("/ingest/data-source", async (c) => {
    const parsed = z.object({
      sourceId: z.string().min(1), dataset: z.string().min(1), entityType: z.string().optional(), idField: z.string().optional(),
      nameField: z.string().optional(), limit: z.number().int().min(1).max(500).optional(), semantic: z.boolean().default(true),
    }).safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return invalid(c, parsed.error.issues[0]?.message);
    try { return c.json({ ok: true, data: await getRuntime().ingestDataSource(parsed.data) }, 201); }
    catch (error) { return failure(c, error); }
  });
  app.post("/enrich/text", async (c) => {
    const parsed = z.object({
      text: z.string().trim().min(1).max(80_000), label: z.string().optional(),
      sourceType: z.enum(["data-source", "file", "chat", "task", "mission", "app", "manual"]).optional(),
      sourceId: z.string().optional(), dataset: z.string().optional(),
    }).safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return invalid(c, parsed.error.issues[0]?.message);
    try { return c.json({ ok: true, data: await getRuntime().enrichText(parsed.data) }, 201); }
    catch (error) { return failure(c, error); }
  });
  app.put("/grants/:agent", async (c) => {
    const parsed = z.object({ capability: z.enum(["none", "read", "write", "admin"]), entityTypes: z.array(z.string()).default(["*"]) })
      .safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return invalid(c, parsed.error.issues[0]?.message);
    try { return c.json({ ok: true, data: await getRuntime().setGrant(c.req.param("agent"), parsed.data.capability, parsed.data.entityTypes) }); }
    catch (error) { return failure(c, error); }
  });
  return app;
}

function split(value?: string): string[] { return value?.split(",").map((item) => item.trim()).filter(Boolean) ?? []; }
function number(value?: string): number | undefined { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : undefined; }
function invalid(c: any, error = "Invalid request") { return c.json({ ok: false, error }, 400); }
function failure(c: any, error: unknown, status: 400 | 404 = 400) { return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, status); }
