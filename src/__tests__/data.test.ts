import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { OpenAPIHono } from "@hono/zod-openapi";
import { DataRuntime } from "../server/data-runtime.js";
import { dataRoutes } from "../server/routes/data.js";
import { dataViewRoutes } from "../server/routes/data-views.js";
import { createDataAgentTools, executeDataTool } from "../tools/data-tools.js";
import type { DataRegistryChangeEmitter } from "../stores/file-data-registry-store.js";

const roots: string[] = [];

async function fixture(emitChange?: DataRegistryChangeEmitter) {
  const root = await mkdtemp(join(tmpdir(), "polpo-data-"));
  roots.push(root);
  const polpoDir = join(root, ".polpo");
  const path = join(root, "business.sqlite");
  const db = new Database(path);
  db.exec(`
    CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, region TEXT, revenue REAL, secret TEXT);
    INSERT INTO customers (name, region, revenue, secret) VALUES
      ('Ada', 'EU', 1200, 'one'),
      ('Linus', 'US', 800, 'two'),
      ('Grace', 'US', 1600, 'three');
  `);
  db.close();
  const runtime = new DataRuntime(polpoDir, undefined, emitChange);
  const source = await runtime.store.createSource({
    name: "Business DB",
    slug: "business-db",
    kind: "sqlite",
    environment: "development",
    config: { location: path },
    tags: ["internal"],
    grants: [
      { id: "reader", agent: "analyst", capabilities: ["read"], datasets: ["customers"], excludedFields: ["secret"] },
      { id: "writer", agent: "operator", capabilities: ["write"], datasets: ["customers"] },
    ],
  });
  return { runtime, source };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("structured data runtime", () => {
  it("discovers schema and enforces field-level grants", async () => {
    const { runtime, source } = await fixture();
    const datasets = await runtime.discover(source.id, { agent: "analyst" });
    expect(datasets.map((item) => item.name)).toContain("customers");
    expect(datasets[0]?.columns.map((column) => column.name)).not.toContain("secret");
    await expect(runtime.query({ sourceId: source.id, dataset: "customers", fields: ["secret"] }, { agent: "analyst" }))
      .rejects.toThrow("excluded");
  });

  it("returns a bounded DataFrame from a portable query", async () => {
    const { runtime, source } = await fixture();
    const frame = await runtime.query({
      sourceId: source.id,
      dataset: "customers",
      fields: ["name", "revenue"],
      filters: [{ field: "region", operator: "eq", value: "US" }],
      sort: [{ field: "revenue", direction: "desc" }],
      limit: 1,
    }, { agent: "analyst" });
    expect(frame.rows).toEqual([{ name: "Grace", revenue: 1600 }]);
    expect(frame.meta.sourceId).toBe(source.id);
    expect(frame.meta.truncated).toBe(true);
  });

  it("separates read and write capabilities", async () => {
    const { runtime, source } = await fixture();
    await expect(runtime.mutate({ sourceId: source.id, dataset: "customers", operation: "update", values: { revenue: 10 }, filters: [{ field: "id", operator: "eq", value: 1 }] }, { agent: "analyst" }))
      .rejects.toThrow("Access denied");
    const result = await runtime.mutate({ sourceId: source.id, dataset: "customers", operation: "update", values: { revenue: 1400 }, filters: [{ field: "id", operator: "eq", value: 1 }] }, { agent: "operator" });
    expect(result.affectedRows).toBe(1);
    expect((await runtime.query({ sourceId: source.id, dataset: "customers", limit: 1 }, { agent: "operator" })).rows).toHaveLength(1);
  });

  it("rejects destructive raw SQL", async () => {
    const { runtime, source } = await fixture();
    await expect(runtime.rawSql(source.id, "DELETE FROM customers", { agent: "analyst" })).rejects.toThrow("Only SELECT");
  });

  it("persists independent generated views", async () => {
    const { runtime, source } = await fixture();
    const view = await runtime.store.createView({
      name: "Revenue",
      persistence: "saved",
      createdBy: "analyst",
      bindings: [{ id: "revenue", query: { sourceId: source.id, dataset: "customers", limit: 100 } }],
      widgets: [{ id: "metric", type: "metric", binding: "revenue", field: "revenue", aggregate: "sum" }],
    });
    expect((await runtime.store.getView(view.id))?.name).toBe("Revenue");
    expect(await runtime.store.listSources()).toHaveLength(1);
    await runtime.store.deleteSource(source.id);
    expect((await runtime.store.getView(view.id))?.name).toBe("Revenue");
  });

  it("emits live source, data, activity, and view changes", async () => {
    const events: Array<{ type: string; action: string }> = [];
    const { runtime, source } = await fixture((event) => events.push(event));
    const view = await runtime.store.createView({
      name: "Live revenue",
      persistence: "saved",
      bindings: [{ id: "revenue", query: { sourceId: source.id, dataset: "customers" } }],
      widgets: [],
    });
    await runtime.query({ sourceId: source.id, dataset: "customers" }, { agent: "analyst" });
    await runtime.mutate({ sourceId: source.id, dataset: "customers", operation: "update", values: { revenue: 900 }, filters: [{ field: "id", operator: "eq", value: 2 }] }, { agent: "operator" });
    await runtime.store.updateView(view.id, { description: "Updated live" });

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "source", action: "created" }),
      expect.objectContaining({ type: "source", action: "activity" }),
      expect.objectContaining({ type: "source", action: "data" }),
      expect.objectContaining({ type: "view", action: "created" }),
      expect.objectContaining({ type: "view", action: "updated" }),
    ]));
  });

  it("exposes registry primitives to the orchestrator and scoped agents", async () => {
    const root = await mkdtemp(join(tmpdir(), "polpo-data-tools-"));
    roots.push(root);
    const polpoDir = join(root, ".polpo");
    const path = join(root, "tool.sqlite");
    const db = new Database(path);
    db.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO items (name) VALUES ('one')");
    db.close();

    const created = JSON.parse(await executeDataTool("data_register_source", {
      name: "Tool DB", kind: "sqlite", config: { location: path }, tags: ["Internal"],
    }, polpoDir, { admin: true })) as { id: string };
    await expect(executeDataTool("data_update_source", { sourceId: created.id, description: "blocked" }, polpoDir, { agent: "worker" }))
      .rejects.toThrow("Access denied");
    await executeDataTool("data_set_source_grant", { sourceId: created.id, agent: "worker", role: "admin", datasets: ["*"] }, polpoDir, { admin: true });
    const updated = JSON.parse(await executeDataTool("data_update_source", { sourceId: created.id, description: "managed by worker" }, polpoDir, { agent: "worker" })) as { description: string };
    expect(updated.description).toBe("managed by worker");
    const tested = JSON.parse(await executeDataTool("data_test_source", { sourceId: created.id }, polpoDir, { agent: "worker" })) as { datasets: number };
    expect(tested.datasets).toBe(1);

    expect(createDataAgentTools(polpoDir, "worker", ["data_query"]).map((tool) => tool.name)).toEqual(["data_query"]);
    expect(createDataAgentTools(polpoDir, "worker", ["data_*"]).map((tool) => tool.name)).toContain("data_set_source_grant");
  });

  it("serves sources and views as separate top-level resources", async () => {
    const { runtime } = await fixture();
    const app = new OpenAPIHono();
    app.route("/data", dataRoutes(() => ({ runtime, store: runtime.store })));
    app.route("/views", dataViewRoutes(() => runtime.store));
    const sources = await app.request("/data");
    const views = await app.request("/views");
    expect(sources.status).toBe(200);
    expect((await sources.json()).data).toHaveLength(1);
    expect(views.status).toBe(200);
    expect((await views.json()).data).toEqual([]);
  });

  it("supports bounded inline views without a data source", async () => {
    const root = await mkdtemp(join(tmpdir(), "polpo-inline-view-"));
    roots.push(root);
    const polpoDir = join(root, ".polpo");
    const created = JSON.parse(await executeDataTool("data_create_view", {
      name: "Quarterly outlook",
      persistence: "ephemeral",
      bindings: [{ id: "forecast", inline: { label: "Forecast", rows: [{ quarter: "Q1", revenue: 120 }, { quarter: "Q2", revenue: 155 }] } }],
      widgets: [
        { type: "sparkline", binding: "forecast", x: "quarter", y: "revenue" },
        { type: "gauge", binding: "forecast", field: "revenue", aggregate: "max", target: 200 },
      ],
    }, polpoDir, { agent: "analyst" })) as { id: string };
    const views = JSON.parse(await executeDataTool("data_list_views", {}, polpoDir, { agent: "analyst" })) as Array<{ id: string; bindings: Array<{ inline?: unknown }> }>;
    expect(views[0]?.id).toBe(created.id);
    expect(views[0]?.bindings[0]?.inline).toBeDefined();
  });
});
