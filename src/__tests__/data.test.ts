import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

  it("raw SQL is read-only at the database too, not only by the text check", async () => {
    const { runtime, source } = await fixture();
    const executeRaw = (runtime as unknown as { executeRaw: (s: unknown, q: string) => Promise<unknown> }).executeRaw.bind(runtime);
    await expect(executeRaw(source, "UPDATE customers SET name = 'x' RETURNING id")).rejects.toThrow(/readonly/i);
    const rows = await executeRaw(source, "SELECT count(*) AS n FROM customers") as Array<{ n: number }>;
    expect(rows[0]!.n).toBe(3);
  });

  it("finds relative files in the agents' working directory, never creates empty databases", async () => {
    const root = await mkdtemp(join(tmpdir(), "polpo-data-rel-"));
    roots.push(root);
    const polpoDir = join(root, ".polpo");
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(polpoDir, { recursive: true });
    await writeFile(join(polpoDir, "polpo.json"), JSON.stringify({ project: "p", teams: [{ name: "t", agents: [] }], settings: { workDir: "./workspace" } }));
    await mkdir(join(root, "workspace", "exports"), { recursive: true });
    const db = new Database(join(root, "workspace", "exports", "plan.db"));
    db.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, title TEXT); INSERT INTO items (title) VALUES ('one')");
    db.close();
    const runtime = new DataRuntime(polpoDir);
    expect(runtime.resolveLocation("exports/plan.db")).toBe(join(root, "workspace", "exports", "plan.db"));
    expect(runtime.resolveLocation("/abs/x.db")).toBe("/abs/x.db");

    const source = await runtime.store.createSource({
      name: "Plan", slug: "plan", kind: "sqlite", environment: "development",
      config: { location: "exports/plan.db" }, tags: [], grants: [],
    });
    const frame = await runtime.query({ sourceId: source.id, dataset: "items" }, { admin: true });
    expect(frame.rows).toEqual([{ id: 1, title: "one" }]);

    const missing = await runtime.store.createSource({
      name: "Missing", slug: "missing", kind: "sqlite", environment: "development",
      config: { location: "nope/missing.db" }, tags: [], grants: [],
    });
    await expect(runtime.query({ sourceId: missing.id, dataset: "items" }, { admin: true })).rejects.toThrow();
    const { existsSync } = await import("node:fs");
    expect(existsSync(join(root, "workspace", "nope", "missing.db"))).toBe(false);
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

  it("counts every matching row for paging (includeTotal), ignoring limit and offset", async () => {
    const { runtime, source } = await fixture();
    const page = await runtime.query({ sourceId: source.id, dataset: "customers", filters: [{ field: "region", operator: "eq", value: "US" }], sort: [{ field: "id", direction: "asc" }], limit: 1, offset: 1, includeTotal: true });
    expect(page.rows.map((row) => row.name)).toEqual(["Grace"]);
    expect(page.meta.totalCount).toBe(2);
    const grouped = await runtime.query({ sourceId: source.id, dataset: "customers", groupBy: ["region"], aggregates: [{ field: "*", operation: "count" }], includeTotal: true });
    expect(grouped.meta.totalCount).toBe(2);
    // without includeTotal no count is run
    expect((await runtime.query({ sourceId: source.id, dataset: "customers", limit: 1 })).meta.totalCount).toBeUndefined();
    // the REST route passes it through
    const app = new OpenAPIHono();
    app.route("/data", dataRoutes(() => ({ runtime, store: runtime.store })));
    const response = await app.request("/data/query", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sourceId: source.id, dataset: "customers", limit: 2, includeTotal: true }) });
    expect((await response.json()).data.meta.totalCount).toBe(3);
  });

  it("counts JSON and CSV rows in memory with the same filters", async () => {
    const root = await mkdtemp(join(tmpdir(), "polpo-data-file-"));
    roots.push(root);
    const path = join(root, "orders.json");
    await writeFile(path, JSON.stringify([{ id: 1, status: "open" }, { id: 2, status: "open" }, { id: 3, status: "closed" }]));
    const runtime = new DataRuntime(join(root, ".polpo"));
    const source = await runtime.store.createSource({ name: "Orders", slug: "orders", kind: "json", environment: "development", config: { location: path }, tags: [], grants: [] });
    const frame = await runtime.query({ sourceId: source.id, dataset: "orders", filters: [{ field: "status", operator: "eq", value: "open" }], limit: 1, includeTotal: true });
    expect(frame.rows).toHaveLength(1);
    expect(frame.meta.totalCount).toBe(2);
  });

  it("describes indexes, foreign keys, defaults, native types and row counts of SQLite tables", async () => {
    const root = await mkdtemp(join(tmpdir(), "polpo-data-schema-"));
    roots.push(root);
    const path = join(root, "shop.sqlite");
    const db = new Database(path);
    db.exec(`
      CREATE TABLE customers (id INTEGER PRIMARY KEY, email VARCHAR(120) NOT NULL UNIQUE, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE, total REAL DEFAULT 0);
      CREATE INDEX orders_by_customer ON orders(customer_id);
      CREATE VIEW big_orders AS SELECT * FROM orders WHERE total > 100;
      INSERT INTO customers (email) VALUES ('a@x.io'), ('b@x.io');
      INSERT INTO orders (customer_id, total) VALUES (1, 50), (1, 150), (2, 10);
    `);
    db.close();
    const runtime = new DataRuntime(join(root, ".polpo"));
    const source = await runtime.store.createSource({ name: "Shop", slug: "shop", kind: "sqlite", environment: "development", config: { location: path }, tags: [], grants: [] });
    const datasets = await runtime.discover(source.id);
    const customers = datasets.find((item) => item.name === "customers")!;
    const orders = datasets.find((item) => item.name === "orders")!;
    const view = datasets.find((item) => item.name === "big_orders")!;
    expect(customers.rowCount).toBe(2);
    expect(orders.rowCount).toBe(3);
    expect(customers.columns.find((column) => column.name === "id")).toMatchObject({ primaryKey: true, type: "number", nativeType: "INTEGER" });
    expect(customers.columns.find((column) => column.name === "email")).toMatchObject({ nullable: false, nativeType: "VARCHAR(120)", type: "string" });
    expect(customers.columns.find((column) => column.name === "created_at")?.defaultValue).toBe("CURRENT_TIMESTAMP");
    expect(customers.indexes?.some((index) => index.unique && index.columns.includes("email"))).toBe(true);
    expect(orders.indexes).toContainEqual({ name: "orders_by_customer", columns: ["customer_id"], unique: false });
    expect(orders.foreignKeys).toEqual([{ columns: ["customer_id"], references: { dataset: "customers", columns: ["id"] }, onUpdate: "NO ACTION", onDelete: "CASCADE" }]);
    expect(view.kind).toBe("view");
    expect(view.indexes).toBeUndefined();
  });

  it("saves views bound to a read-only SQL statement (REST and agent tools)", async () => {
    const { runtime, source } = await fixture();
    const app = new OpenAPIHono();
    app.route("/views", dataViewRoutes(() => runtime.store));
    const created = await app.request("/views", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
      name: "US revenue", bindings: [{ id: "q", sql: { sourceId: source.id, statement: "SELECT region, SUM(revenue) AS revenue FROM customers GROUP BY region" } }],
      widgets: [{ type: "table", binding: "q" }],
    }) });
    expect(created.status).toBe(201);
    expect((await created.json()).data.bindings[0].sql.statement).toContain("SUM(revenue)");
    const empty = await app.request("/views", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Bad", bindings: [{ id: "q", sql: { sourceId: source.id, statement: " " } }] }) });
    expect(empty.status).toBe(400);

    // an agent may bind SQL only on a source it can read
    const view = JSON.parse(await executeDataTool("data_create_view", {
      name: "By region", bindings: [{ id: "q", sql: { sourceId: source.id, statement: "SELECT region FROM customers" } }], widgets: [{ type: "table", binding: "q" }],
    }, runtime.polpoDir, { agent: "analyst" })) as { bindings: Array<{ sql?: { statement: string } }> };
    expect(view.bindings[0]?.sql?.statement).toBe("SELECT region FROM customers");
    await expect(executeDataTool("data_create_view", {
      name: "Nope", bindings: [{ id: "q", sql: { sourceId: source.id, statement: "SELECT 1" } }], widgets: [],
    }, runtime.polpoDir, { agent: "stranger" })).rejects.toThrow("not available");
    await expect(executeDataTool("data_create_view", {
      name: "Both", bindings: [{ id: "q", sql: { sourceId: source.id, statement: "SELECT 1" }, inline: { rows: [] } }], widgets: [],
    }, runtime.polpoDir, {})).rejects.toThrow("exactly one");
  });
});
