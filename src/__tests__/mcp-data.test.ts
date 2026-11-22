/**
 * The Data area through MCP, on a real instance (createApp, the real data routes, a real SQLite
 * file): sources (get with schema, save, test, delete), activity, read-only SQL, row changes with
 * confirm, data views; secrets never pass through (setup_url hand-off, masked locations); scopes.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { Hono } from "hono";
import { expectValidOutput } from "./helpers/mcp-output.js";

const PUBLIC = "https://polpo.example.com";
const DASHBOARD = "https://dash.example.com:5174";
const MCP_KEY = "mcp-key-for-data";
const DB_PASSWORD = "s3cr3t-pg-password-xyz";
let tmpDir: string;
let dbPath: string;
let app: Hono;

const DATA_TOOLS = [
  "polpo_data_sources_list", "polpo_data_query", "polpo_data_source_get", "polpo_data_source_save", "polpo_data_source_test",
  "polpo_data_source_delete", "polpo_data_activity", "polpo_data_sql", "polpo_data_mutate",
  "polpo_data_views_list", "polpo_data_view_get", "polpo_data_view_save", "polpo_data_view_delete",
];

beforeAll(async () => {
  process.env.POLPO_PUBLIC_URL = PUBLIC;
  process.env.POLPO_MCP_KEY = MCP_KEY;
  process.env.POLPO_DASHBOARD_URL = DASHBOARD;
  tmpDir = await mkdtemp(join(tmpdir(), "polpo-mcp-data-"));
  await mkdir(join(tmpDir, ".polpo"), { recursive: true });
  await writeFile(join(tmpDir, ".polpo", "polpo.json"), JSON.stringify({
    project: "mcp-data", team: { name: "t", agents: [{ name: "analyst", role: "Analyst" }] }, settings: { logLevel: "quiet" },
  }));
  dbPath = join(tmpDir, "business.sqlite");
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, region TEXT, revenue REAL);
    INSERT INTO customers (name, region, revenue) VALUES ('Ada', 'EU', 1200), ('Linus', 'US', 800), ('Grace', 'US', 1600);`);
  db.close();
  const { Orchestrator } = await import("../core/orchestrator.js");
  const { SSEBridge } = await import("../server/sse-bridge.js");
  const { createApp } = await import("../server/app.js");
  const orchestrator = new Orchestrator(tmpDir);
  await orchestrator.initInteractive("mcp-data", { name: "t", agents: [{ name: "analyst", role: "Analyst" }] });
  app = createApp(orchestrator, new SSEBridge(orchestrator), { workDir: tmpDir });
}, 30_000);

afterAll(async () => {
  delete process.env.POLPO_PUBLIC_URL;
  delete process.env.POLPO_MCP_KEY;
  delete process.env.POLPO_DASHBOARD_URL;
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
});

const rpc = async (method: string, params: Record<string, unknown> = {}) => (await (await app.request("/mcp", {
  method: "POST",
  headers: { "x-forwarded-host": "polpo.example.com", "x-forwarded-proto": "https", "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${MCP_KEY}` },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
})).json()) as { result?: any; error?: any };
const KEY = {};
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tool results are checked field by field
const tool = async (name: string, args: Record<string, unknown> = {}): Promise<any> => {
  const result = (await rpc("tools/call", { name, arguments: args })).result;
  await expectValidOutput(KEY, async () => (await rpc("tools/list")).result.tools, name, result);
  return result;
};
const text = (r: { content: Array<{ text?: string }> }) => r.content.map((c) => c.text ?? "").join("");
const rest = (method: string, path: string, body?: unknown) => app.request(`/api/v1${path}`, {
  method, headers: { authorization: `Bearer ${MCP_KEY}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}),
});

describe("the Data area through MCP", () => {
  it("offers every data tool, honestly annotated, with output schemas", async () => {
    const tools = (await rpc("tools/list")).result.tools as Array<{ name: string; annotations: Record<string, unknown>; outputSchema?: unknown; inputSchema: { properties?: Record<string, { description?: string }> } }>;
    const by = Object.fromEntries(tools.map((t) => [t.name, t]));
    for (const n of DATA_TOOLS) {
      expect(by[n], n).toBeDefined();
      expect(by[n]!.outputSchema, n).toBeTruthy();
      for (const [p, s] of Object.entries(by[n]!.inputSchema.properties ?? {})) expect(s.description, `${n}.${p}`).toBeTruthy();
    }
    for (const n of ["polpo_data_source_get", "polpo_data_source_test", "polpo_data_activity", "polpo_data_sql", "polpo_data_views_list", "polpo_data_view_get"]) {
      expect(by[n]!.annotations, n).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    }
    for (const n of ["polpo_data_source_delete", "polpo_data_mutate", "polpo_data_view_delete"]) expect(by[n]!.annotations, n).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    for (const n of ["polpo_data_source_save", "polpo_data_view_save"]) expect(by[n]!.annotations, n).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(by.polpo_data_sql!.annotations).toMatchObject({ openWorldHint: true });
  });

  it("scopes: reads for everyone, rows and views need work, sources need admin", async () => {
    const { toolScopeMatrix, handleMcpRequest } = await import("../server/mcp.js");
    const m = Object.fromEntries(toolScopeMatrix().map((t) => [t.name, t.scope]));
    for (const n of ["polpo_data_source_get", "polpo_data_source_test", "polpo_data_activity", "polpo_data_sql", "polpo_data_views_list", "polpo_data_view_get"]) expect(m[n], n).toBe("polpo:read");
    for (const n of ["polpo_data_mutate", "polpo_data_view_save", "polpo_data_view_delete"]) expect(m[n], n).toBe("polpo:work");
    for (const n of ["polpo_data_source_save", "polpo_data_source_delete"]) expect(m[n], n).toBe("polpo:admin");
    const list = async (scopes: string[]) => {
      const res = await handleMcpRequest(new Request("http://localhost/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      }), { api: vi.fn(), version: "x", principal: { kind: "oauth", actor: "x", scopes } });
      return ((await res.json()).result.tools as Array<{ name: string }>).map((t) => t.name).filter((n) => n.startsWith("polpo_data"));
    };
    const read = await list(["polpo:read"]);
    expect(read).toContain("polpo_data_sql");
    for (const n of ["polpo_data_mutate", "polpo_data_view_save", "polpo_data_source_save", "polpo_data_source_delete"]) expect(read).not.toContain(n);
    const work = await list(["polpo:read", "polpo:work"]);
    expect(work).toEqual(expect.arrayContaining(["polpo_data_mutate", "polpo_data_view_save", "polpo_data_view_delete"]));
    for (const n of ["polpo_data_source_save", "polpo_data_source_delete"]) expect(work).not.toContain(n);
    expect(await list(["polpo:admin"])).toEqual(expect.arrayContaining(DATA_TOOLS));
  });

  it("creates a SQLite source, reads its schema, tests it, runs read-only SQL and changes rows with confirm", async () => {
    // validation
    expect((await tool("polpo_data_source_save", { name: "Biz" })).isError).toBe(true);
    const created = await tool("polpo_data_source_save", {
      name: "Business DB", kind: "sqlite", location: dbPath, description: "Customers",
      grants: [{ agent: "analyst", capabilities: ["read"], datasets: ["customers"] }],
    });
    expect(created.isError).toBeFalsy();
    expect(created.structuredContent).toMatchObject({ created: true, source: { name: "Business DB", slug: "business-db", kind: "sqlite" } });
    expect(created.structuredContent.setup_url).toBeUndefined();
    const id = created.structuredContent.source.id as string;

    // get by slug, with schema and who may use it
    const got = await tool("polpo_data_source_get", { id: "business-db" });
    expect(got.structuredContent.source).toMatchObject({ id, grants: [expect.objectContaining({ agent: "analyst", capabilities: ["read"] })], credentials: { stored: [] } });
    expect(got.structuredContent.schema.datasets.map((d: { name: string }) => d.name)).toContain("customers");
    expect(text(got)).toContain("analyst [read]");

    // partial update keeps the rest
    const changed = await tool("polpo_data_source_save", { id, description: "All customers", environment: "staging" });
    expect(changed.structuredContent).toMatchObject({ created: false, source: { id, description: "All customers", environment: "staging", config: { location: dbPath } } });
    expect(changed.structuredContent.source.grants).toHaveLength(1);

    const tested = await tool("polpo_data_source_test", { id });
    expect(tested.structuredContent).toMatchObject({ id, ok: true, datasets: 1 });

    // read-only SQL, with a row cap and truncation note
    const sql = await tool("polpo_data_sql", { sourceId: id, sql: "SELECT name, revenue FROM customers ORDER BY revenue DESC", max_rows: 2 });
    expect(sql.structuredContent).toMatchObject({ row_count: 2, truncated: true, rows: [{ name: "Grace" }, { name: "Ada" }] });
    expect(sql.structuredContent.note).toMatch(/more/);
    for (const stmt of ["DELETE FROM customers", "DROP TABLE customers", "TRUNCATE customers", "UPDATE customers SET name = 'x'"]) {
      const refused = await tool("polpo_data_sql", { sourceId: id, sql: stmt });
      expect(refused.isError, stmt).toBe(true);
      expect(text(refused)).toContain("polpo_data_mutate");
    }
    // a write hidden after a SELECT is refused by the server
    expect((await tool("polpo_data_sql", { sourceId: id, sql: "SELECT 1; DROP TABLE customers" })).isError).toBe(true);

    // rows: insert needs no confirm, update/delete do (and say how many rows), no filters is refused
    const ins = await tool("polpo_data_mutate", { sourceId: id, dataset: "customers", operation: "insert", values: { name: "Edsger", region: "EU", revenue: 500 } });
    expect(ins.structuredContent).toMatchObject({ operation: "insert", affected_rows: 1 });
    expect((await tool("polpo_data_mutate", { sourceId: id, dataset: "customers", operation: "delete" })).isError).toBe(true);
    const preview = await tool("polpo_data_mutate", { sourceId: id, dataset: "customers", operation: "delete", filters: [{ field: "region", operator: "eq", value: "US" }] });
    expect(preview.isError).toBe(true);
    expect(text(preview)).toMatch(/2 row\(s\).*confirm: true/);
    const del = await tool("polpo_data_mutate", { sourceId: id, dataset: "customers", operation: "delete", filters: [{ field: "region", operator: "eq", value: "US" }], confirm: true });
    expect(del.structuredContent).toMatchObject({ affected_rows: 2 });
    const upd = await tool("polpo_data_mutate", { sourceId: id, dataset: "customers", operation: "update", values: { region: "UK" }, filters: [{ field: "name", operator: "eq", value: "Ada" }], confirm: true });
    expect(upd.structuredContent).toMatchObject({ affected_rows: 1 });
    const left = await tool("polpo_data_sql", { sourceId: id, sql: "SELECT name, region FROM customers ORDER BY name" });
    expect(left.structuredContent.rows).toEqual([{ name: "Ada", region: "UK" }, { name: "Edsger", region: "EU" }]);

    // activity, newest first, paginated
    const act = await tool("polpo_data_activity", { sourceId: id, limit: 2 });
    expect(act.structuredContent.items).toHaveLength(2);
    expect(act.structuredContent.next_cursor).toBeTruthy();
    expect(act.structuredContent.total).toBeGreaterThan(4);
    const actions = (await tool("polpo_data_activity", { sourceId: id, limit: 100 })).structuredContent.items.map((a: { action: string }) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["test", "discover", "sql", "mutate"]));
    expect((await tool("polpo_data_activity", { sourceId: id, cursor: "nope!" })).isError).toBe(true);
  });

  it("data views: create, list, read, change in part, delete with confirm; deleting a source names the views it breaks", async () => {
    const src = (await tool("polpo_data_source_save", { name: "Views DB", kind: "sqlite", location: dbPath })).structuredContent.source.id as string;
    expect((await tool("polpo_data_view_save", { description: "no name" })).isError).toBe(true);
    const made = await tool("polpo_data_view_save", {
      name: "Revenue", bindings: [{ id: "b1", query: { sourceId: src, dataset: "customers" } }],
      widgets: [{ type: "metric", title: "Total", binding: "b1", field: "revenue", aggregate: "sum" }],
    });
    expect(made.structuredContent).toMatchObject({ created: true, view: { name: "Revenue" } });
    const vid = made.structuredContent.view.id as string;
    expect(made.structuredContent.url).toBe(`${DASHBOARD}/views?view=${vid}`);
    // server-side validation comes back as an error to fix
    expect((await tool("polpo_data_view_save", { name: "Bad", widgets: [{ type: "nope" }] })).isError).toBe(true);

    const listed = await tool("polpo_data_views_list", {});
    expect(listed.structuredContent.items).toEqual([expect.objectContaining({ id: vid, widgets: 1, bindings: 1, sources: [src] })]);
    const renamed = await tool("polpo_data_view_save", { id: vid, name: "Revenue 2026" });
    expect(renamed.structuredContent.view).toMatchObject({ name: "Revenue 2026", widgets: [expect.objectContaining({ type: "metric" })] });
    expect((await tool("polpo_data_view_get", { id: vid })).structuredContent.view.bindings).toHaveLength(1);

    const notYet = await tool("polpo_data_source_delete", { id: src });
    expect(notYet.isError).toBe(true);
    expect(text(notYet)).toContain("Revenue 2026");
    expect((await tool("polpo_data_source_get", { id: src })).isError).toBeFalsy();
    const gone = await tool("polpo_data_source_delete", { id: src, confirm: true });
    expect(gone.structuredContent).toMatchObject({ deleted: true, affected_views: [`Revenue 2026 (${vid})`] });
    expect((await tool("polpo_data_source_get", { id: src })).isError).toBe(true);

    expect((await tool("polpo_data_view_delete", { id: vid })).isError).toBe(true);
    expect((await tool("polpo_data_view_delete", { id: vid, confirm: true })).structuredContent).toMatchObject({ deleted: true });
    expect((await tool("polpo_data_views_list", {})).structuredContent.items).toEqual([]);
  });

  it("secrets never pass through: a password in the location is refused, the hand-off points to the Data page, nothing leaks", async () => {
    const refused = await tool("polpo_data_source_save", { name: "Leaky", kind: "postgres", location: `postgres://app:${DB_PASSWORD}@db.example.com/app` });
    expect(refused.isError).toBe(true);
    expect(text(refused)).not.toContain(DB_PASSWORD);
    expect((await tool("polpo_data_source_save", { name: "Leaky REST", kind: "rest", location: "https://api.example.com/v1?api_key=abc123" })).isError).toBe(true);

    const pg = await tool("polpo_data_source_save", { name: "Warehouse", kind: "postgres", location: "127.0.0.1", port: 1, database: "wh", username: "app" });
    const sid = pg.structuredContent.source.id as string;
    expect(pg.structuredContent).toMatchObject({
      setup_id: `data:${sid}:password`,
      setup_url: `${DASHBOARD}/data?tab=sources&source=${sid}&focus=password&setup=data%3A${sid}%3Apassword`,
    });
    expect(pg.structuredContent.next_step).toContain("polpo_setup_wait");
    expect((await tool("polpo_setup_wait", { setup_id: `data:${sid}:password`, timeout_seconds: 0 })).structuredContent).toMatchObject({ status: "pending" });

    // the person enters the password on the Data page (the dashboard's own request)
    const current = (await (await rest("GET", `/data/${sid}`)).json()).data;
    const { credentialKeys: _keys, id: _id, createdAt: _c, updatedAt: _u, ...input } = current;
    expect((await rest("PUT", `/data/${sid}`, { ...input, credentials: { password: DB_PASSWORD } })).status).toBe(200);
    expect((await (await rest("GET", `/data/${sid}`)).json()).data.credentialKeys).toEqual(["password"]);
    expect((await tool("polpo_setup_wait", { setup_id: `data:${sid}:password`, timeout_seconds: 0 })).structuredContent).toMatchObject({ status: "done" });

    const got = await tool("polpo_data_source_get", { id: sid, schema: false });
    expect(got.structuredContent.source.credentials).toEqual({ stored: ["password"] });
    expect(got.structuredContent.setup_url).toBeUndefined();
    const tested = await tool("polpo_data_source_test", { id: sid });
    expect(tested.isError).toBe(true);
    for (const r of [got, tested, pg, await tool("polpo_data_activity", { sourceId: sid }), await tool("polpo_data_sources_list")]) {
      expect(JSON.stringify(r)).not.toContain(DB_PASSWORD);
    }
  });

  it("masks passwords and tokens in locations and error text", async () => {
    const { maskLocation, maskSecretsInText, locationHasSecret } = await import("../server/mcp-server/data.js");
    expect(maskLocation("postgres://app:hunter2@db:5432/x")).toBe("postgres://app:***@db:5432/x");
    expect(maskLocation("https://api.example.com/v1?token=abc&page=2")).toBe("https://api.example.com/v1?token=***&page=2");
    expect(maskLocation("/data/file.csv")).toBe("/data/file.csv");
    expect(maskSecretsInText("connect failed: host=db password=hunter2 user=app")).toBe("connect failed: host=db password=*** user=app");
    expect(locationHasSecret("db.example.com")).toBe(false);
    expect(locationHasSecret("postgres://app@db/x")).toBe(false);
    expect(locationHasSecret("host=db password=x")).toBe(true);
  });
});
