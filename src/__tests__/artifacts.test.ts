import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { OpenAPIHono } from "@hono/zod-openapi";
import {
  applyArtifactEdits, applyArtifactPatch, artifactContentProblem, buildArtifact, MAX_ARTIFACT_VERSIONS,
} from "@polpo-ai/core/artifacts";
import { DataRuntime } from "../server/data-runtime.js";
import { FileArtifactStore } from "../stores/file-artifact-store.js";
import { artifactRoutes } from "../server/routes/artifacts.js";
import { artifactPrincipal } from "../server/artifact-runtime.js";
import { createArtifactAgentTools, executeArtifactTool } from "../tools/artifact-tools.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "polpo-artifacts-"));
  roots.push(root);
  const polpoDir = join(root, ".polpo");
  const dbPath = join(root, "sales.sqlite");
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE orders (id INTEGER PRIMARY KEY, region TEXT, amount REAL, secret TEXT);
    INSERT INTO orders (region, amount, secret) VALUES ('EU', 10, 'a'), ('US', 30, 'b'), ('US', 5, 'c');`);
  db.close();
  const data = new DataRuntime(polpoDir);
  const source = await data.store.createSource({
    name: "Sales", slug: "sales", kind: "sqlite", environment: "development", config: { location: dbPath }, tags: [],
    grants: [{ id: "g1", agent: "analyst", capabilities: ["read"], datasets: ["orders"], excludedFields: ["secret"] }],
  });
  const store = new FileArtifactStore(polpoDir);
  const emitted: unknown[] = [];
  const app = new OpenAPIHono();
  app.route("/artifacts", artifactRoutes(() => ({ store, data, author: () => "person:ada@example.com", emit: (p) => emitted.push(p) })));
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(`/artifacts${path}`, { method, ...(body ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}) });
    return { status: res.status, body: await res.json() as { ok: boolean; data: any; error?: string } };
  };
  return { polpoDir, data, source, store, call, emitted };
}

const page = (title: string) => `<!doctype html><html><body><h1>${title}</h1></body></html>`;

describe("artifact model", () => {
  it("validates content by type", () => {
    expect(artifactContentProblem("doc", "  ")).toBe("The content is empty");
    expect(artifactContentProblem("svg", "<div/>")).toMatch(/<svg>/);
    expect(artifactContentProblem("svg", '<svg viewBox="0 0 1 1"></svg>')).toBeUndefined();
    expect(artifactContentProblem("view", "{")).toMatch(/valid JSON/);
    expect(artifactContentProblem("html", "x".repeat(1_000_001))).toMatch(/over 1000 KB/);
    expect(() => buildArtifact("a1", { title: "x", type: "pdf" as never, content: "x", createdBy: "polpo" })).toThrow(/Unknown artifact type/);
  });

  it("keeps the previous content as a version, with who wrote it, newest first and capped", () => {
    let a = buildArtifact("a1", { title: "Report", type: "doc", content: "v1", createdBy: "analyst" }, "2026-10-25T10:00:00Z");
    a = applyArtifactPatch(a, { content: "v2", author: "polpo", note: "added totals" }, "2026-10-25T11:00:00Z");
    expect(a).toMatchObject({ content: "v2", version: 2, author: "polpo", note: "added totals" });
    expect(a.versions).toEqual([{ version: 1, content: "v1", author: "analyst", at: "2026-10-25T10:00:00Z" }]);
    a = applyArtifactPatch(a, { content: "v3", author: "person:ada" });
    expect(a.versions[0]).toMatchObject({ version: 2, content: "v2", author: "polpo", note: "added totals" });
    // only the title: no new version
    expect(applyArtifactPatch(a, { title: "Q4 report" })).toMatchObject({ title: "Q4 report", version: 3 });
    for (let i = 4; i < 40; i++) a = applyArtifactPatch(a, { content: `v${i}` });
    expect(a.versions).toHaveLength(MAX_ARTIFACT_VERSIONS);
    expect(a.versions[0]!.version).toBe(38);
  });

  it("applies find/replace edits that each match once", () => {
    expect(applyArtifactEdits("<h1>Sales</h1><p>EU</p>", [{ find: "Sales", replace: "Orders" }, { find: "EU", replace: "US" }]))
      .toBe("<h1>Orders</h1><p>US</p>");
    expect(() => applyArtifactEdits("a a", [{ find: "a", replace: "b" }])).toThrow(/more than once/);
    expect(() => applyArtifactEdits("abc", [{ find: "zz", replace: "b" }])).toThrow(/Edit 1: the text to find is not/);
  });

  it("data rights: agents use their grants, Polpo and people have all", () => {
    expect(artifactPrincipal("analyst")).toEqual({ agent: "analyst" });
    expect(artifactPrincipal("polpo")).toEqual({ admin: true });
    expect(artifactPrincipal("person:ada@example.com")).toEqual({ admin: true });
  });
});

describe("artifacts API", () => {
  it("creates, lists, updates with versions, restores and deletes", async () => {
    const { call, emitted } = await fixture();
    const created = await call("POST", "", { title: "Sales dashboard", type: "html", kind: "dashboard", content: page("v1"), sources: ["sales"] });
    expect(created.status).toBe(201);
    const id = created.body.data.id as string;
    expect(id).toMatch(/^art_/);
    expect(created.body.data.createdBy).toBe("person:ada@example.com");

    expect((await call("PATCH", `/${id}`, { content: page("v2"), note: "bigger chart" })).body.data).toMatchObject({ version: 2, note: "bigger chart" });
    expect((await call("GET", "?type=html")).body.data.map((a: { id: string }) => a.id)).toEqual([id]);
    expect((await call("GET", "?q=sales")).body.data).toHaveLength(1);
    expect((await call("GET", "?q=nothing")).body.data).toHaveLength(0);

    const restored = await call("POST", `/${id}/restore/1`);
    expect(restored.body.data).toMatchObject({ version: 3, content: page("v1"), note: "restored version 1" });
    expect((await call("POST", `/${id}/restore/9`)).status).toBe(400);

    expect((await call("POST", "", { title: "x", type: "view", content: "{}" })).status).toBe(400);
    expect((await call("DELETE", `/${id}`)).body.data).toEqual({ deleted: true });
    expect((await call("GET", `/${id}`)).status).toBe(404);
    expect(emitted.map((e: any) => e.action)).toEqual(["created", "updated", "updated", "deleted"]);
  });

  it("shows the former data views as read-only artifacts of type view", async () => {
    const { call, data, source } = await fixture();
    const view = await data.store.createView({
      name: "Orders by region", persistence: "saved", createdBy: "analyst",
      bindings: [{ id: "b1", query: { sourceId: source.id, dataset: "orders" } }],
      widgets: [{ id: "w1", type: "table", binding: "b1", width: 4, height: "standard" }],
    });
    const list = (await call("GET", "")).body.data;
    expect(list).toEqual([expect.objectContaining({ id: `view:${view.id}`, type: "view", title: "Orders by region", createdBy: "analyst", sources: [source.id] })]);
    const one = (await call("GET", `/view:${view.id}`)).body.data;
    expect(JSON.parse(one.content).widgets[0].type).toBe("table");
    expect((await call("PATCH", `/view:${view.id}`, { title: "x" })).status).toBe(409);
    expect((await call("DELETE", `/view:${view.id}`)).status).toBe(409);
  });

  it("the data bridge reads with the author's rights", async () => {
    const { call, store, source } = await fixture();
    const byAnalyst = await store.create({ title: "Mine", type: "html", content: page("a"), createdBy: "analyst" });
    const byStranger = await store.create({ title: "Other", type: "html", content: page("b"), createdBy: "intern" });
    const byPerson = await store.create({ title: "People", type: "html", content: page("c"), createdBy: "person:ada" });

    const sources = await call("POST", `/${byAnalyst.id}/data`, { method: "sources" });
    expect(sources.body.data).toEqual([expect.objectContaining({ id: source.id, name: "Sales", kind: "sqlite" })]);
    const rows = await call("POST", `/${byAnalyst.id}/data`, { method: "query", params: { sourceId: source.id, dataset: "orders", fields: ["region", "amount"] } });
    expect(rows.body.data.rows).toHaveLength(3);
    // the analyst may not read the secret field, so neither may its artifact
    expect((await call("POST", `/${byAnalyst.id}/data`, { method: "query", params: { sourceId: source.id, dataset: "orders", fields: ["secret"] } })).body.ok).toBe(false);
    // an author with no grant sees nothing
    expect((await call("POST", `/${byStranger.id}/data`, { method: "sources" })).body.data).toEqual([]);
    expect((await call("POST", `/${byStranger.id}/data`, { method: "query", params: { sourceId: source.id, dataset: "orders" } })).body.ok).toBe(false);
    // a person's artifact reads everything, also with read-only SQL
    const sql = await call("POST", `/${byPerson.id}/data`, { method: "sql", params: { sourceId: source.id, sql: "select region, sum(amount) as total from orders group by region order by region" } });
    expect(sql.body.data.rows).toEqual([{ region: "EU", total: 10 }, { region: "US", total: 35 }]);
    expect((await call("POST", `/${byPerson.id}/data`, { method: "mutate" })).status).toBe(400);
  });
});

describe("artifact tools", () => {
  it("Polpo creates, edits in place and reads; agents change only their own", async () => {
    const { store } = await fixture();
    const emit = vi.fn();
    const polpo = { store, author: "polpo", sessionId: "s1", emit };
    const created = await executeArtifactTool("artifact_create", { title: "Plan", type: "doc", content: "# Plan\n\n- step one" }, polpo);
    const id = /art_[\w-]+/.exec(created)![0];
    expect(created).toContain(`Open: /artifacts/${id}`);
    expect((await store.get(id))).toMatchObject({ createdBy: "polpo", sessionId: "s1" });

    const updated = await executeArtifactTool("artifact_update", { id, edits: [{ find: "step one", replace: "step one\n- step two" }], note: "added a step" }, polpo);
    expect(updated).toMatch(/now v2/);
    expect((await store.get(id))!.content).toBe("# Plan\n\n- step one\n- step two");
    expect(await executeArtifactTool("artifact_get", { id, version: 1 }, polpo)).toContain("--- content of v1 ---\n# Plan\n\n- step one");
    await expect(executeArtifactTool("artifact_update", { id, content: "x", edits: [{ find: "a", replace: "b" }] }, polpo)).rejects.toThrow(/either content or edits/);

    const analyst = { store, author: "analyst" };
    await expect(executeArtifactTool("artifact_update", { id, content: "hijack" }, analyst)).rejects.toThrow(/belongs to polpo/);
    await expect(executeArtifactTool("artifact_delete", { id }, analyst)).rejects.toThrow(/belongs to polpo/);
    expect(await executeArtifactTool("artifact_list", {}, analyst)).toBe("No artifacts.");
    expect(await executeArtifactTool("artifact_list", {}, polpo)).toContain(`${id} [doc] Plan — by polpo, v2`);
    expect(emit.mock.calls.map(([p]) => p.action)).toEqual(["created", "updated"]);
  });

  it("agents get the tools with artifact_* (or some of them) in allowedTools", async () => {
    const { store } = await fixture();
    const ctx = () => ({ store, author: "analyst" });
    expect(createArtifactAgentTools(["read", "data_*"], ctx)).toEqual([]);
    expect(createArtifactAgentTools(["artifact_*"], ctx).map((t) => t.name)).toEqual(["artifact_create", "artifact_update", "artifact_get", "artifact_list", "artifact_delete"]);
    const [create] = createArtifactAgentTools(["artifact_create"], ctx);
    const result = await create!.execute("t1", { title: "Chart", type: "svg", content: '<svg viewBox="0 0 10 10"><rect width="5" height="5"/></svg>' });
    expect(result.details).toEqual({ artifactId: expect.stringMatching(/^art_/) });
    const bad = await create!.execute("t2", { title: "Broken", type: "svg", content: "<div/>" });
    expect(bad.content[0]!.text).toMatch(/^Error: An svg artifact must contain/);
  });
});
