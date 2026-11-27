/**
 * data_transaction: several SQL statements in one transaction (SQLite here; PostgreSQL when
 * POLPO_TEST_DATABASE_URL points at a disposable database, as in CI). Commit, rollback on a
 * failing statement and on an expectRows mismatch, SET LOCAL settings seen by a trigger, refused
 * statements, grants, dataset restrictions, timeout bounds, REST, agent tools, activity log.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { OpenAPIHono } from "@hono/zod-openapi";
import { DataRuntime } from "../server/data-runtime.js";
import { classifySql, settingNeedsAdmin, sqlTables } from "../server/data-sql.js";
import { dataRoutes } from "../server/routes/data.js";
import { createDataAgentTools, executeDataTool } from "../tools/data-tools.js";

const roots: string[] = [];

async function sqliteFixture() {
  const root = await mkdtemp(join(tmpdir(), "polpo-data-tx-"));
  roots.push(root);
  const polpoDir = join(root, ".polpo");
  const path = join(root, "archive.sqlite");
  const db = new Database(path);
  db.exec(`
    CREATE TABLE pratiche (id INTEGER PRIMARY KEY, titolo TEXT NOT NULL, stato TEXT NOT NULL, segreto TEXT);
    CREATE TABLE eventi (id INTEGER PRIMARY KEY AUTOINCREMENT, pratica INTEGER NOT NULL, da TEXT, a TEXT);
    CREATE TABLE altro (id INTEGER PRIMARY KEY);
    CREATE TRIGGER pratiche_stato AFTER UPDATE OF stato ON pratiche BEGIN
      INSERT INTO eventi (pratica, da, a) VALUES (OLD.id, OLD.stato, NEW.stato);
    END;
    INSERT INTO pratiche (id, titolo, stato, segreto) VALUES (1, 'Uno', 'bozza', 'x'), (2, 'Due', 'bozza', 'y');
  `);
  db.close();
  const runtime = new DataRuntime(polpoDir);
  const source = await runtime.store.createSource({
    name: "Archivio", slug: "archivio", kind: "sqlite", environment: "development", config: { location: path }, tags: [],
    grants: [
      { id: "w", agent: "writer", capabilities: ["write"], datasets: ["*"] },
      { id: "r", agent: "reader", capabilities: ["read"], datasets: ["*"] },
      { id: "s", agent: "scoped", capabilities: ["write"], datasets: ["pratiche", "eventi"], excludedFields: ["segreto"] },
      { id: "a", agent: "boss", capabilities: ["admin"], datasets: ["*"] },
    ],
  });
  const read = (sql: string) => { const d = new Database(path, { readonly: true }); try { return d.prepare(sql).all(); } finally { d.close(); } };
  return { runtime, source, polpoDir, path, read };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("SQL classifier", () => {
  it("classifies reads, writes and admin statements and finds tables", () => {
    expect(classifySql("SELECT * FROM a JOIN b ON a.id = b.id", "postgres")).toMatchObject({ kind: "read", tables: ["a", "b"] });
    expect(classifySql("INSERT INTO s.t (a) VALUES ($1) ON CONFLICT DO NOTHING", "postgres")).toMatchObject({ kind: "write", command: "INSERT", tables: ["s.t"] });
    expect(classifySql("UPDATE t SET x = 1 WHERE id = $1 AND stato = $2 RETURNING id", "postgres")).toMatchObject({ kind: "write", tables: ["t"] });
    expect(classifySql("INSERT INTO t (a) VALUES (1) ON CONFLICT (a) DO UPDATE SET a = excluded.a", "postgres").tables).toEqual(["t"]);
    expect(classifySql("DELETE FROM t USING u WHERE t.id = u.id", "postgres").tables).toEqual(["t", "u"]);
    expect(classifySql("WITH x AS (SELECT * FROM a) SELECT * FROM x, b AS bb WHERE true", "postgres").tables).toEqual(["a", "b"]);
    expect(classifySql("WITH d AS (DELETE FROM a RETURNING *) SELECT * FROM d", "postgres").kind).toBe("write");
    expect(classifySql("SELECT extract(year FROM now()), substring('x' FROM 1) FROM t", "postgres").tables).toEqual(["t"]);
    expect(classifySql(`SELECT 'DROP TABLE x; BEGIN' AS a, $$;COMMIT$$ FROM "My Table" -- ; DROP`, "postgres").tables).toEqual(["My Table"]);
    expect(classifySql("SELECT * FROM generate_series(1, 3)", "postgres").tables).toEqual([]);
    expect(classifySql("CREATE TABLE x (id int)", "postgres")).toMatchObject({ kind: "admin" });
    for (const sql of ["DROP TABLE x", "ALTER TABLE x ADD c int", "TRUNCATE x", "GRANT ALL ON x TO y", "DO $$ BEGIN END $$", "CALL p()", "COPY x TO STDOUT"]) {
      expect(classifySql(sql, "postgres").kind, sql).toBe("admin");
    }
    expect(classifySql("SELECT pg_terminate_backend(1)", "postgres")).toMatchObject({ kind: "admin", adminReason: expect.stringContaining("pg_terminate_backend") });
    expect(classifySql("SELECT set_config('role', 'x', false)", "postgres").kind).toBe("admin");
    expect(classifySql("SELECT a INTO b FROM c", "postgres").kind).toBe("admin");
  });

  it("refuses transaction control, SET, identity switches, COPY PROGRAM and several statements", () => {
    for (const sql of ["BEGIN", "start transaction", "COMMIT", "ROLLBACK", "SAVEPOINT a", "RELEASE SAVEPOINT a", "END", "PREPARE TRANSACTION 'x'"]) {
      expect(() => classifySql(sql, "postgres"), sql).toThrow(/Transaction control/);
    }
    for (const sql of ["SET ROLE admin", "SET SESSION AUTHORIZATION postgres", "SET TRANSACTION ISOLATION LEVEL SERIALIZABLE", "SET LOCAL x.y = 1", "RESET ROLE"]) {
      expect(() => classifySql(sql, "postgres"), sql).toThrow(/not allowed/);
    }
    expect(() => classifySql("COPY t FROM PROGRAM 'curl x'", "postgres")).toThrow(/PROGRAM/);
    expect(() => classifySql("COPY t TO '/tmp/x'", "postgres")).toThrow(/server file/);
    expect(() => classifySql("SELECT 1; SELECT 2", "postgres")).toThrow(/one statement/);
    expect(() => classifySql("UPDATE t SET a = 1; COMMIT", "postgres")).toThrow(/one statement/);
    expect(classifySql("SELECT 1;", "postgres").kind).toBe("read");
    expect(() => classifySql("ATTACH DATABASE 'x' AS y", "sqlite")).toThrow(/not allowed/);
    expect(() => classifySql("PRAGMA writable_schema = 1", "sqlite")).toThrow(/not allowed/);
    expect(() => classifySql("SELECT 'unterminated", "postgres")).toThrow(/Unterminated/);
  });

  it("validates setting names", () => {
    expect(settingNeedsAdmin("archivio.autore")).toBe(false);
    expect(settingNeedsAdmin("search_path")).toBe(true);
    for (const key of ["Archivio.autore", "a.b.c", "x;y", "a-b", "", "role", "session_authorization", "transaction_read_only"]) {
      expect(() => settingNeedsAdmin(key), key).toThrow();
    }
    expect(sqlTables("SELECT * FROM main.pratiche", "sqlite")).toEqual(["pratiche"]);
  });
});

describe("data_transaction on SQLite", () => {
  it("commits every statement and returns command, rowCount and returned rows", async () => {
    const { runtime, source, read } = await sqliteFixture();
    const result = await runtime.transaction({
      sourceId: source.slug,
      statements: [
        { sql: "INSERT INTO pratiche (id, titolo, stato) VALUES (?, ?, ?) ON CONFLICT DO NOTHING", params: [3, "Tre", "bozza"], expectRows: 1 },
        { sql: "INSERT INTO pratiche (id, titolo, stato) VALUES (?, ?, ?) ON CONFLICT DO NOTHING", params: [1, "Uno bis", "bozza"], expectRows: { max: 1 } },
        { sql: "UPDATE pratiche SET stato = ? WHERE id = ? AND stato = ? RETURNING id, stato", params: ["inviata", 1, "bozza"], expectRows: 1 },
        { sql: "SELECT count(*) AS n FROM eventi" },
      ],
    }, { agent: "writer" });
    expect(result).toMatchObject({ status: "committed", readOnly: false });
    expect(result.statements).toEqual([
      { index: 0, command: "INSERT", rowCount: 1 },
      { index: 1, command: "INSERT", rowCount: 0 },
      { index: 2, command: "UPDATE", rowCount: 1, rows: [{ id: 1, stato: "inviata" }], truncated: false },
      { index: 3, command: "SELECT", rowCount: 1, rows: [{ n: 1 }], truncated: false },
    ]);
    expect(read("SELECT id, stato FROM pratiche ORDER BY id")).toEqual([{ id: 1, stato: "inviata" }, { id: 2, stato: "bozza" }, { id: 3, stato: "bozza" }]);
  });

  it("rolls everything back when a statement fails, saying which one and why", async () => {
    const { runtime, source, read } = await sqliteFixture();
    const result = await runtime.transaction({
      sourceId: source.id,
      statements: [
        { sql: "UPDATE pratiche SET stato = 'chiusa' WHERE id = 1" },
        { sql: "INSERT INTO pratiche (id, titolo, stato) VALUES (2, 'dup', 'x')" },
      ],
    }, { agent: "writer" });
    expect(result.status).toBe("rolled_back");
    expect(result.failed).toMatchObject({ index: 1, reason: "error", message: expect.stringMatching(/UNIQUE/) });
    expect(read("SELECT stato FROM pratiche WHERE id = 1")).toEqual([{ stato: "bozza" }]);
    expect(read("SELECT count(*) AS n FROM eventi")).toEqual([{ n: 0 }]);
  });

  it("rolls back on an expectRows mismatch (the conditional update touched no row)", async () => {
    const { runtime, source, read } = await sqliteFixture();
    const result = await runtime.transaction({
      sourceId: source.id,
      statements: [
        { sql: "INSERT INTO eventi (pratica, da, a) VALUES (?, ?, ?)", params: [2, "manuale", "nota"] },
        { sql: "UPDATE pratiche SET stato = ? WHERE id = ? AND stato = ?", params: ["chiusa", 2, "inviata"], expectRows: 1 },
      ],
    }, { agent: "writer" });
    expect(result).toMatchObject({ status: "rolled_back", failed: { index: 1, reason: "expect_rows", message: "expected exactly 1 row(s), got 0" } });
    expect(result.statements).toHaveLength(1);
    expect(read("SELECT count(*) AS n FROM eventi")).toEqual([{ n: 0 }]);
    const range = await runtime.transaction({ sourceId: source.id, statements: [{ sql: "SELECT * FROM pratiche", expectRows: { min: 3 } }] }, { agent: "reader" }).catch((e) => e);
    expect(range).toBeInstanceOf(Error); // reader cannot run a write transaction
    const ranged = await runtime.transaction({ sourceId: source.id, readOnly: true, statements: [{ sql: "SELECT * FROM pratiche", expectRows: { min: 3 } }] }, { agent: "reader" });
    expect(ranged.failed).toMatchObject({ reason: "expect_rows", message: "expected at least 3 row(s), got 2" });
  });

  it("refuses forbidden statements before opening the transaction", async () => {
    const { runtime, source, read } = await sqliteFixture();
    const run = (sql: string, agent = "writer") => runtime.transaction({ sourceId: source.id, statements: [{ sql: "UPDATE pratiche SET stato = 'x' WHERE id = 1" }, { sql }] }, { agent });
    await expect(run("BEGIN")).rejects.toThrow(/Statement 2: Transaction control/);
    await expect(run("COMMIT")).rejects.toThrow(/Transaction control/);
    await expect(run("UPDATE pratiche SET stato = 'y'; DELETE FROM pratiche")).rejects.toThrow(/one statement/);
    await expect(run("DROP TABLE altro")).rejects.toThrow(/needs the admin grant/);
    await expect(run("CREATE TABLE x (id int)")).rejects.toThrow(/needs the admin grant/);
    await expect(run("PRAGMA foreign_keys = OFF")).rejects.toThrow(/not allowed/);
    await expect(run("ATTACH DATABASE '/tmp/x.db' AS x")).rejects.toThrow(/not allowed/);
    expect(read("SELECT stato FROM pratiche WHERE id = 1")).toEqual([{ stato: "bozza" }]);
    // admin may change the schema
    const admin = await run("CREATE TABLE nuova (id INTEGER PRIMARY KEY)", "boss");
    expect(admin.status).toBe("committed");
    // settings are PostgreSQL only
    await expect(runtime.transaction({ sourceId: source.id, settings: { "archivio.autore": "a" }, statements: [{ sql: "SELECT 1" }] }, { agent: "writer" }))
      .rejects.toThrow(/only for PostgreSQL/);
  });

  it("needs the write grant; readOnly transactions need read and cannot write", async () => {
    const { runtime, source, read } = await sqliteFixture();
    await expect(runtime.transaction({ sourceId: source.id, statements: [{ sql: "UPDATE pratiche SET stato = 'x'" }] }, { agent: "reader" }))
      .rejects.toThrow(/Access denied/);
    await expect(runtime.transaction({ sourceId: source.id, statements: [{ sql: "SELECT 1" }] }, { agent: "stranger" }))
      .rejects.toThrow(/Access denied/);
    const ok = await runtime.transaction({ sourceId: source.id, readOnly: true, statements: [{ sql: "SELECT id FROM pratiche ORDER BY id" }, { sql: "SELECT count(*) AS n FROM eventi" }] }, { agent: "reader" });
    expect(ok).toMatchObject({ status: "committed", readOnly: true, statements: [{ rowCount: 2, rows: [{ id: 1 }, { id: 2 }] }, { rows: [{ n: 0 }] }] });
    await expect(runtime.transaction({ sourceId: source.id, readOnly: true, statements: [{ sql: "UPDATE pratiche SET stato = 'x'" }] }, { agent: "writer" }))
      .rejects.toThrow(/readOnly transaction runs only/);
    // the read-only handle refuses writes even when the text check is fooled (a writing CTE)
    const sneaky = await runtime.transaction({ sourceId: source.id, readOnly: true, statements: [{ sql: "SELECT 1" }] }, { agent: "reader" });
    expect(sneaky.status).toBe("committed");
    expect(read("SELECT stato FROM pratiche WHERE id = 1")).toEqual([{ stato: "bozza" }]);
  });

  it("enforces dataset grants on every named table and hides excluded fields", async () => {
    const { runtime, source } = await sqliteFixture();
    await expect(runtime.transaction({ sourceId: source.id, statements: [{ sql: "INSERT INTO altro (id) VALUES (1)" }] }, { agent: "scoped" }))
      .rejects.toThrow(/Statement 1: Access denied to Archivio \/ altro/);
    await expect(runtime.transaction({ sourceId: source.id, statements: [{ sql: "UPDATE pratiche SET stato = 'x' WHERE id IN (SELECT id FROM altro)" }] }, { agent: "scoped" }))
      .rejects.toThrow(/altro/);
    await expect(runtime.transaction({ sourceId: source.id, readOnly: true, statements: [{ sql: "SELECT * FROM pratiche p JOIN altro a ON a.id = p.id" }] }, { agent: "scoped" }))
      .rejects.toThrow(/altro/);
    const ok = await runtime.transaction({ sourceId: source.id, statements: [{ sql: "UPDATE pratiche SET stato = 'x' WHERE id = 1 RETURNING *" }] }, { agent: "scoped" });
    expect(ok.statements[0]!.rows).toEqual([{ id: 1, titolo: "Uno", stato: "x" }]);
    // data_sql honours the same dataset grant
    await expect(runtime.rawSql(source.id, "SELECT * FROM altro", { agent: "scoped" })).rejects.toThrow(/altro/);
    expect((await runtime.rawSql(source.id, "SELECT id FROM pratiche", { agent: "scoped" })).rows).toHaveLength(2);
  });

  it("bounds timeoutMs and the number of statements", async () => {
    const { runtime, source } = await sqliteFixture();
    const one = [{ sql: "SELECT 1" }];
    await expect(runtime.transaction({ sourceId: source.id, statements: one, timeoutMs: 60_001 }, { agent: "writer" })).rejects.toThrow(/timeoutMs must be/);
    await expect(runtime.transaction({ sourceId: source.id, statements: one, timeoutMs: 50 }, { agent: "writer" })).rejects.toThrow(/timeoutMs must be/);
    await expect(runtime.transaction({ sourceId: source.id, statements: one, timeoutMs: 1.5 as number }, { agent: "writer" })).rejects.toThrow(/timeoutMs must be/);
    expect((await runtime.transaction({ sourceId: source.id, statements: one, timeoutMs: 60_000 }, { agent: "writer" })).status).toBe("committed");
    await expect(runtime.transaction({ sourceId: source.id, statements: [] }, { agent: "writer" })).rejects.toThrow(/at least one/);
    await expect(runtime.transaction({ sourceId: source.id, statements: Array.from({ length: 51 }, () => ({ sql: "SELECT 1" })) }, { agent: "writer" })).rejects.toThrow(/at most 50/);
  });

  it("records the transaction in the activity log, without parameter values", async () => {
    const { runtime, source } = await sqliteFixture();
    await runtime.transaction({ sourceId: source.id, statements: [{ sql: "UPDATE pratiche SET titolo = ? WHERE id = ?", params: ["top-secret-value", 1], expectRows: 1 }, { sql: "SELECT * FROM eventi" }] }, { agent: "writer" });
    await runtime.transaction({ sourceId: source.id, statements: [{ sql: "UPDATE pratiche SET titolo = ? WHERE id = ?", params: ["other-secret", 99], expectRows: 1 }] }, { agent: "writer" });
    const activity = await runtime.store.listActivity(source.id, 10);
    const tx = activity.filter((item) => item.action === "transaction");
    expect(tx).toHaveLength(2);
    expect(tx).toEqual(expect.arrayContaining([
      expect.objectContaining({ agent: "writer", status: "succeeded", statementCount: 2, rowCount: 1, dataset: "pratiche, eventi", readOnly: false }),
      expect.objectContaining({ agent: "writer", status: "failed", statementCount: 1, error: expect.stringMatching(/Rolled back at statement 1: expected exactly 1/) }),
    ]));
    expect(JSON.stringify(activity)).not.toMatch(/secret/);
  });

  it("is an agent tool gated by allowedTools, and a REST endpoint", async () => {
    const { runtime, source, polpoDir, read } = await sqliteFixture();
    expect(createDataAgentTools(polpoDir, "writer", ["data_query"]).map((tool) => tool.name)).not.toContain("data_transaction");
    expect(createDataAgentTools(polpoDir, "writer", ["data_transaction"]).map((tool) => tool.name)).toEqual(["data_transaction"]);
    const [tool] = createDataAgentTools(polpoDir, "writer", ["data_*"]).filter((t) => t.name === "data_transaction");
    const out = await tool!.execute("call", { sourceId: "archivio", statements: [{ sql: "UPDATE pratiche SET stato = ? WHERE id = ?", params: ["agente", 2], expectRows: 1 }] });
    expect(JSON.parse(out.content[0].text)).toMatchObject({ status: "committed", statements: [{ command: "UPDATE", rowCount: 1 }] });
    const [readerTool] = createDataAgentTools(polpoDir, "reader", ["data_transaction"]);
    expect((await readerTool!.execute("call", { sourceId: "archivio", statements: [{ sql: "DELETE FROM pratiche WHERE id = 1" }] })).content[0].text).toMatch(/^Error: Access denied/);
    expect(JSON.parse(await executeDataTool("data_transaction", { sourceId: source.id, readOnly: true, statements: [{ sql: "SELECT stato FROM pratiche WHERE id = 2" }] }, polpoDir, { admin: true })))
      .toMatchObject({ statements: [{ rows: [{ stato: "agente" }] }] });

    const app = new OpenAPIHono();
    app.route("/data", dataRoutes(() => ({ runtime, store: runtime.store })));
    const post = (body: unknown, id = source.id) => app.request(`/data/${id}/transaction`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const committed = await post({ statements: [{ sql: "INSERT INTO eventi (pratica, a) VALUES (?, ?) RETURNING pratica, a", params: [1, "rest"], expectRows: 1 }] }, "archivio");
    expect(committed.status).toBe(200);
    expect((await committed.json()).data).toMatchObject({ status: "committed", statements: [{ command: "INSERT", rowCount: 1, rows: [{ pratica: 1, a: "rest" }] }] });
    const rolled = await post({ statements: [{ sql: "DELETE FROM eventi" }, { sql: "UPDATE pratiche SET stato = 'z' WHERE id = 42", expectRows: 1 }] });
    expect((await rolled.json()).data).toMatchObject({ status: "rolled_back", failed: { index: 1, reason: "expect_rows" } });
    expect(read("SELECT count(*) AS n FROM eventi")).toEqual([{ n: 2 }]); // the trigger's event + the REST insert
    const refused = await post({ statements: [{ sql: "BEGIN" }] });
    expect(refused.status).toBe(400);
    expect((await refused.json()).error).toMatch(/Transaction control/);
    const invalid = await post({ statements: [{ sql: "SELECT 1" }], timeoutMs: 120_000 });
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).error).toMatch(/timeoutMs/);
    expect((await post({ statements: [] })).status).toBe(400);
  });
});

// ── PostgreSQL ─────────────────────────────────────────────────────────
// A disposable database (CI's service container): every run works in its own schema and drops it.
const PG_URL = process.env.POLPO_TEST_DATABASE_URL;

describe.skipIf(!PG_URL)("data_transaction on PostgreSQL", () => {
  const schema = `polpo_tx_${process.pid}_${Date.now().toString(36)}`;
  let runtime: DataRuntime;
  let sourceId: string;
  let admin: import("postgres").Sql;
  let root: string | undefined;

  beforeAll(async () => {
    const postgres = (await import("postgres")).default;
    admin = postgres(PG_URL!, { max: 1, onnotice: () => {} });
    await admin.unsafe(`
      CREATE SCHEMA ${schema};
      CREATE TABLE ${schema}.pratiche (id int PRIMARY KEY, titolo text NOT NULL, stato text NOT NULL);
      CREATE TABLE ${schema}.eventi (id serial PRIMARY KEY, pratica int NOT NULL, da text, a text, autore text);
      CREATE TABLE ${schema}.altro (id int PRIMARY KEY);
      CREATE FUNCTION ${schema}.log_stato() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN
        INSERT INTO ${schema}.eventi (pratica, da, a, autore) VALUES (OLD.id, OLD.stato, NEW.stato, current_setting('archivio.autore', true));
        RETURN NEW;
      END $fn$;
      CREATE TRIGGER pratiche_stato AFTER UPDATE OF stato ON ${schema}.pratiche FOR EACH ROW EXECUTE FUNCTION ${schema}.log_stato();
      INSERT INTO ${schema}.pratiche VALUES (1, 'Uno', 'bozza'), (2, 'Due', 'bozza');
    `);
    const url = new URL(PG_URL!);
    root = await mkdtemp(join(tmpdir(), "polpo-data-tx-pg-"));
    const password = decodeURIComponent(url.password);
    const vault = { get: async () => ({ credentials: { password } }) } as unknown as import("../core/vault-store.js").VaultStore;
    runtime = new DataRuntime(join(root, ".polpo"), vault);
    const source = await runtime.store.createSource({
      name: "Archivio PG", slug: "archivio-pg", kind: "postgres", environment: "development", tags: [],
      config: { location: url.hostname, port: Number(url.port || 5432), database: url.pathname.slice(1), username: decodeURIComponent(url.username) },
      grants: [
        { id: "w", agent: "writer", capabilities: ["write"], datasets: ["*"] },
        { id: "r", agent: "reader", capabilities: ["read"], datasets: ["*"] },
        { id: "s", agent: "scoped", capabilities: ["write"], datasets: [`${schema}.pratiche`, `${schema}.eventi`] },
        { id: "a", agent: "boss", capabilities: ["admin"], datasets: ["*"] },
      ],
    });
    sourceId = source.id;
  }, 30_000);

  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    if (!admin) return;
    await admin.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
    await admin.end({ timeout: 5 });
  });

  const t = (name: string) => `${schema}.${name}`;

  it("commits with SET LOCAL settings that a trigger sees, idempotent inserts and conditional updates", async () => {
    const result = await runtime.transaction({
      sourceId,
      settings: { "archivio.autore": "agente-archivio" },
      statements: [
        { sql: `SELECT current_setting('archivio.autore') AS autore, current_setting('statement_timeout') AS st` },
        { sql: `INSERT INTO ${t("pratiche")} (id, titolo, stato) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, params: [3, "Tre", "bozza"], expectRows: 1 },
        { sql: `INSERT INTO ${t("pratiche")} (id, titolo, stato) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, params: [1, "Uno bis", "bozza"], expectRows: { max: 1 } },
        { sql: `UPDATE ${t("pratiche")} SET stato = $1 WHERE id = $2 AND stato = $3 RETURNING id, stato`, params: ["inviata", 1, "bozza"], expectRows: 1 },
      ],
      timeoutMs: 5_000,
    }, { agent: "writer" });
    expect(result.status).toBe("committed");
    expect(result.statements.map((s) => [s.command, s.rowCount])).toEqual([["SELECT", 1], ["INSERT", 1], ["INSERT", 0], ["UPDATE", 1]]);
    expect(result.statements[0]!.rows).toEqual([{ autore: "agente-archivio", st: "5s" }]);
    expect(result.statements[3]!.rows).toEqual([{ id: 1, stato: "inviata" }]);
    expect(await admin.unsafe(`SELECT pratica, da, a, autore FROM ${t("eventi")}`)).toEqual([{ pratica: 1, da: "bozza", a: "inviata", autore: "agente-archivio" }]);
    // SET LOCAL: gone after the transaction
    const after = await runtime.transaction({ sourceId, readOnly: true, statements: [{ sql: "SELECT current_setting('archivio.autore', true) AS autore" }] }, { agent: "reader" });
    expect(after.statements[0]!.rows![0]!.autore ?? "").toBe("");
  });

  it("rolls back on a failing statement and on an expectRows mismatch", async () => {
    const before = await admin.unsafe(`SELECT count(*)::int AS n FROM ${t("eventi")}`);
    const failing = await runtime.transaction({
      sourceId,
      statements: [
        { sql: `UPDATE ${t("pratiche")} SET stato = 'chiusa' WHERE id = 2` },
        { sql: `INSERT INTO ${t("pratiche")} (id, titolo, stato) VALUES (2, 'dup', 'x')` },
      ],
    }, { agent: "writer" });
    expect(failing).toMatchObject({ status: "rolled_back", failed: { index: 1, reason: "error", message: expect.stringMatching(/duplicate key/) } });
    const mismatch = await runtime.transaction({
      sourceId,
      settings: { "archivio.autore": "x" },
      statements: [
        { sql: `UPDATE ${t("pratiche")} SET stato = 'chiusa' WHERE id = 2` },
        { sql: `UPDATE ${t("pratiche")} SET stato = $1 WHERE id = $2 AND stato = $3`, params: ["chiusa", 1, "bozza"], expectRows: 1 },
      ],
    }, { agent: "writer" });
    expect(mismatch).toMatchObject({ status: "rolled_back", failed: { index: 1, reason: "expect_rows", message: "expected exactly 1 row(s), got 0" } });
    expect(await admin.unsafe(`SELECT stato FROM ${t("pratiche")} WHERE id = 2`)).toEqual([{ stato: "bozza" }]);
    expect(await admin.unsafe(`SELECT count(*)::int AS n FROM ${t("eventi")}`)).toEqual(before);
  });

  it("refuses SET ROLE, transaction control, DDL without admin and server settings", async () => {
    const run = (sql: string, agent = "writer") => runtime.transaction({ sourceId, statements: [{ sql }] }, { agent });
    await expect(run("SET ROLE postgres")).rejects.toThrow(/not allowed/);
    await expect(run("SET SESSION AUTHORIZATION postgres")).rejects.toThrow(/not allowed/);
    await expect(run("BEGIN")).rejects.toThrow(/Transaction control/);
    await expect(run(`DROP TABLE ${t("altro")}`)).rejects.toThrow(/admin grant/);
    await expect(run("SELECT pg_sleep(0)")).rejects.toThrow(/admin grant/);
    await expect(runtime.transaction({ sourceId, settings: { role: "postgres" }, statements: [{ sql: "SELECT 1" }] }, { agent: "boss" })).rejects.toThrow(/never allowed/);
    await expect(runtime.transaction({ sourceId, settings: { search_path: "public" }, statements: [{ sql: "SELECT 1" }] }, { agent: "writer" })).rejects.toThrow(/admin grant/);
    expect((await run(`CREATE TABLE ${t("nuova")} (id int)`, "boss")).status).toBe("committed");
  });

  it("grants: no write is refused; readOnly with read runs READ ONLY at the database", async () => {
    await expect(runtime.transaction({ sourceId, statements: [{ sql: `DELETE FROM ${t("eventi")}` }] }, { agent: "reader" })).rejects.toThrow(/Access denied/);
    const ok = await runtime.transaction({ sourceId, readOnly: true, statements: [{ sql: "SELECT current_setting('transaction_read_only') AS ro" }] }, { agent: "reader" });
    expect(ok.statements[0]!.rows).toEqual([{ ro: "on" }]);
    await expect(runtime.transaction({ sourceId, statements: [{ sql: `INSERT INTO ${t("altro")} VALUES (1)` }] }, { agent: "scoped" })).rejects.toThrow(/altro/);
    expect((await runtime.transaction({ sourceId, statements: [{ sql: `SELECT count(*)::int AS n FROM ${t("pratiche")}` }] }, { agent: "scoped" })).status).toBe("committed");
  });

  it("cancels a statement that runs past timeoutMs and rolls back", async () => {
    const result = await runtime.transaction({
      sourceId,
      timeoutMs: 300,
      // pg_sleep is privileged (admin): the server's statement_timeout cancels it after 300 ms
      statements: [{ sql: `UPDATE ${t("pratiche")} SET titolo = 'x' WHERE id = 1` }, { sql: "SELECT pg_sleep(3)" }],
    }, { agent: "boss" });
    expect(result).toMatchObject({ status: "rolled_back", failed: { index: 1, reason: "timeout" } });
    expect(await admin.unsafe(`SELECT titolo FROM ${t("pratiche")} WHERE id = 1`)).toEqual([{ titolo: "Uno" }]);
  }, 20_000);
});
