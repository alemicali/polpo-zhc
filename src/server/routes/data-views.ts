import { OpenAPIHono } from "@hono/zod-openapi";
import { nanoid } from "nanoid";
import { z } from "zod";
import type { DataRegistryStore } from "../../core/data-registry.js";

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

const WidgetSchema = z.object({
  id: z.string().optional(),
  type: z.enum(["metric", "table", "record", "bar", "line", "area", "pie", "timeline", "status", "markdown", "list", "progress", "gauge", "sparkline", "comparison", "ranking", "scatter", "donut", "radar", "heatmap", "funnel", "histogram", "treemap"]),
  title: z.string().optional(), description: z.string().optional(), binding: z.string().optional(),
  field: z.string().optional(), x: z.string().optional(), y: z.string().optional(),
  category: z.string().optional(), value: z.string().optional(),
  aggregate: z.enum(["count", "sum", "avg", "min", "max"]).optional(),
  target: z.number().optional(), min: z.number().optional(), max: z.number().optional(),
  format: z.enum(["number", "currency", "percent", "compact"]).optional(), currency: z.string().optional(),
  showLegend: z.boolean().optional(),
  markdown: z.string().optional(), width: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).optional(),
  height: z.enum(["compact", "standard", "tall"]).optional(),
});

const BindingSchema = z.union([
  z.object({ id: z.string().min(1), query: QuerySchema }),
  z.object({ id: z.string().min(1), inline: z.object({ label: z.string().optional(), rows: z.array(z.record(z.string(), z.unknown())).max(500) }) }),
]);

const ViewSchema = z.object({
  name: z.string().trim().min(1),
  description: z.string().optional(),
  persistence: z.enum(["ephemeral", "saved", "pinned"]).default("saved"),
  sessionId: z.string().optional(), createdBy: z.string().optional(),
  refreshSeconds: z.number().int().min(5).max(86400).optional(),
  bindings: z.array(BindingSchema).default([]),
  widgets: z.array(WidgetSchema).default([]),
});

export function dataViewRoutes(getStore: () => DataRegistryStore): OpenAPIHono {
  const app = new OpenAPIHono();

  app.get("/", async (c) => c.json({ ok: true, data: await getStore().listViews() }));

  app.post("/", async (c) => {
    const parsed = ViewSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return invalid(c, parsed.error.issues[0]?.message);
    const inlineError = validateInlineBindings(parsed.data.bindings);
    if (inlineError) return invalid(c, inlineError);
    const created = await getStore().createView({
      ...parsed.data,
      widgets: parsed.data.widgets.map((widget) => ({ ...widget, id: widget.id ?? nanoid() })),
    });
    return c.json({ ok: true, data: created }, 201);
  });

  app.get("/:id", async (c) => {
    const view = await getStore().getView(c.req.param("id"));
    return view ? c.json({ ok: true, data: view }) : c.json({ ok: false, error: "Data view not found" }, 404);
  });

  app.put("/:id", async (c) => {
    const parsed = ViewSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return invalid(c, parsed.error.issues[0]?.message);
    const inlineError = validateInlineBindings(parsed.data.bindings);
    if (inlineError) return invalid(c, inlineError);
    const updated = await getStore().updateView(c.req.param("id"), {
      ...parsed.data,
      widgets: parsed.data.widgets.map((widget) => ({ ...widget, id: widget.id ?? nanoid() })),
    });
    return updated ? c.json({ ok: true, data: updated }) : c.json({ ok: false, error: "Data view not found" }, 404);
  });

  app.delete("/:id", async (c) => {
    const deleted = await getStore().deleteView(c.req.param("id"));
    return deleted ? c.json({ ok: true }) : c.json({ ok: false, error: "Data view not found" }, 404);
  });

  return app;
}

function invalid(c: any, error = "Invalid request") { return c.json({ ok: false, error }, 400); }
function validateInlineBindings(bindings: Array<{ id: string; inline?: { rows: Record<string, unknown>[] } }>): string | undefined {
  for (const binding of bindings) {
    if (binding.inline && Buffer.byteLength(JSON.stringify(binding.inline), "utf8") > 512 * 1024) return `Inline binding "${binding.id}" exceeds the 512 KB limit`;
  }
  return undefined;
}
