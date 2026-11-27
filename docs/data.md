# Data

The **Data** page (`/data`) is where structured data sources live: PostgreSQL and SQLite databases, REST APIs, JSON and CSV files. Agents query them with the data tools (`data_*`) when you give them a grant; you browse and change them here. The same operations are in the REST API (`/api/v1/data`, `/api/v1/views`) and in MCP (`polpo_data_*`, see [mcp.md](mcp.md)).

## Sources

`/data` lists the sources as cards: the connector (icon and name), where it lives (never a secret), the environment (production is marked), the connection health (from the last test, schema read or query; **Test** checks it now), the agents that may use it and how many views read it. **Add source** connects a new one.

## A source's workspace

`/data?source=<id>&tab=<tab>&table=<table>` opens a source. The tabs:

| Tab | What it does |
| --- | --- |
| **Tables** | The tables (with row counts) as cards; one opens in the data grid: paging with the total count, sort by a column header, filters (equals, compares, contains, starts with, is one of, is null), columns to show, a row's details. On SQLite and PostgreSQL: **Add row**, edit a value in place (double-click or F2), edit a row, delete selected rows. Every change opens a confirmation that says what it writes and how many rows it will touch (counted on the source first); updates and deletes pick rows by primary key (a table without one: by every value, with a warning when more rows match). **Save as view** keeps the filters and sort. |
| **Schema** | Every dataset with its columns (type, the database's own type, nullability, default, primary key), indexes, and relations both ways (its foreign keys, and the tables that reference it). |
| **SQL** | SQLite and PostgreSQL: one read-only statement (`SELECT`, `WITH`, `EXPLAIN`), highlighted, run with Ctrl/⌘+Enter in a read-only transaction; results in the grid (at most 1,000 rows); this browser's history per source; **Save as view** makes a view that runs the statement live. |
| **Views** | The data views that read this source (they open in Artifacts, type view); delete one. |
| **Access** | A role per agent — no access, viewer (read), operator (also changes rows), steward (admin) — and its scope: every dataset or some, and fields it never sees. An agent also needs the data tools assigned. |
| **Activity** | Every test, schema read, query, SQL statement, row change and transaction: when, by whom (an agent or Polpo), rows, duration, errors; filter by action or failures. Live. |
| **Settings** | The connection (host, port, database, user, TLS; URL; file path), description, environment, categories; the secret (PostgreSQL password, REST `Authorization` header) is written to the Vault and never shown again — only whether it is stored; test the connection; delete the source (the data itself is not touched). |

Keyboard in the grid: arrows, Home/End, PageUp/PageDown move between cells; Enter opens the row; F2 edits the cell (Enter saves, Escape cancels); Space selects the row.

Old links keep working: `/data?tab=sources&source=<id>` opens the source, `?tab=explore` its tables, and an assistant's setup link (`?source=<id>&focus=password&setup=data:<id>:password`) opens Settings on the secret field.

## API additions

- `POST /api/v1/data/query` takes `includeTotal: true`: `meta.totalCount` is every row the filters match, ignoring `limit` and `offset` (SQL sources count in the database, files in memory; REST sources cannot).
- `GET /api/v1/data/:id/schema` returns, per dataset, `rowCount`, and for SQL sources `indexes` (`name`, `columns`, `unique`, `primary`) and `foreignKeys` (`columns`, `references: { dataset, columns }`, `onUpdate`, `onDelete`); columns carry `primaryKey` (now on PostgreSQL too), `nativeType` and `defaultValue`.
- A view binding can be `{ id, sql: { sourceId, statement } }`: a read-only statement run live (REST `/api/v1/views`, the agent tools `data_create_view` / `data_update_view`, MCP `polpo_data_view_save`).

## Transactions (`data_transaction`)

Several SQL statements that must succeed together — insert a record and its events, move a record to a new state only if it is still in the expected one, write a row only if it is not there yet — run in **one transaction on one connection** on a PostgreSQL or SQLite source. Everything commits, or nothing does.

```json
{
  "sourceId": "archivio",
  "settings": { "archivio.autore": "archivist" },
  "statements": [
    { "sql": "INSERT INTO pratiche (id, titolo, stato) VALUES ($1, $2, 'bozza') ON CONFLICT DO NOTHING", "params": [42, "Contratto"] },
    { "sql": "UPDATE pratiche SET stato = $1 WHERE id = $2 AND stato = $3 RETURNING id, stato", "params": ["inviata", 42, "bozza"], "expectRows": 1 },
    { "sql": "SELECT count(*) AS eventi FROM eventi WHERE pratica = $1", "params": [42] }
  ],
  "timeoutMs": 15000
}
```

- **Order**: `BEGIN` (`READ ONLY` with `readOnly: true`); every `settings` entry as `SET LOCAL` (`set_config(key, value, true)`, so a trigger can read it with `current_setting('archivio.autore', true)`); `statement_timeout` and `lock_timeout` = `timeoutMs` (`SET LOCAL`, after the settings so they cannot be lifted); each statement in order with its bind parameters; `COMMIT`.
- **Bind parameters, never interpolation**: `$1, $2…` on PostgreSQL, `?` on SQLite. Objects and arrays are sent as JSON text (cast with `$1::jsonb`); on SQLite booleans become 1/0.
- **`expectRows`** (`n`, or `{ min, max }`): rows the statement changed (INSERT/UPDATE/DELETE) or returned (SELECT). A mismatch rolls everything back — the way to make a conditional `UPDATE … WHERE id = $1 AND stato = $2` touch exactly one row.
- **Rollback**: a failing statement (a constraint, a syntax error, a timeout) or an `expectRows` mismatch rolls the whole transaction back. The result is `status: "rolled_back"` with `failed: { index, reason: "error" | "expect_rows" | "timeout", message }` (0-based `index`) and the results of the statements before it (which were undone).
- **Result** per statement: `command` (INSERT, UPDATE, SELECT…), `rowCount`, and for statements that return rows (SELECT, `RETURNING`) `rows` — at most 1,000 per statement and 5,000 per transaction, with `truncated`. Fields the agent's grant excludes are left out of returned rows.
- **Limits**: 1–50 statements; one statement per `sql` (at most 20,000 characters, 1,000 params); at most 20 settings (values up to 1,000 characters); `timeoutMs` 100–60,000 (default 15,000) bounds each statement and lock wait, and the transaction is abandoned once it has run longer than that between statements (on PostgreSQL the connection is closed if the server has not cancelled in time). SQLite cannot cancel a running statement: there `timeoutMs` bounds lock waits (`busy_timeout`) and the time between statements; `settings` are PostgreSQL only.

**Who may run what** (checked before anything is sent; the database's own role and the `READ ONLY` transaction stay the last guard):

| | Needs |
| --- | --- |
| `readOnly: true` with `SELECT`, `WITH`, `VALUES`, `TABLE`, `EXPLAIN`, `SHOW` | the **read** grant |
| `INSERT`, `UPDATE`, `DELETE`, `MERGE`, writing CTEs, custom settings (`namespace.name`) | the **write** grant |
| DDL and privileged statements (`CREATE`, `ALTER`, `DROP`, `TRUNCATE`, `GRANT`, `REVOKE`, `COPY`, `DO`, `CALL`, `LOCK`, `SELECT … INTO`…), admin functions (`pg_terminate_backend`, `pg_read_file`, `pg_sleep`, `lo_*`, `dblink*`, `set_config`…), server settings without a dot (`search_path`…) | the **admin** grant |
| Transaction control (`BEGIN`, `START`, `COMMIT`, `END`, `ROLLBACK`, `SAVEPOINT`, `RELEASE`, `PREPARE TRANSACTION`), `SET` / `RESET` (including `SET ROLE`, `SET SESSION AUTHORIZATION`, `SET TRANSACTION`), `COPY … PROGRAM` or to/from a server file, `ATTACH`, `PRAGMA`, `VACUUM`, more than one statement in one `sql`, the settings `role`, `session_authorization`, `transaction_read_only` | never |

A grant limited to some datasets applies to **every table the statements name** (after `FROM`, `JOIN`, `INTO`, `UPDATE`, `USING`, in subqueries too): an unqualified table on PostgreSQL matches `public.<table>` as well. `data_sql` now checks the same dataset scope.

**Audit**: each transaction is one entry in the source's Activity (`action: "transaction"`): who, the tables it named, how many statements, rows changed, whether it was read-only, the outcome and, when rolled back, which statement and why. Parameter values and settings values are never logged.

**Surfaces**: the agent tool `data_transaction` (allowed with `data_transaction` or `data_*` in `allowedTools`; on Polpo's engine, in chats and as a host tool for harness agents), Polpo's chat, REST `POST /api/v1/data/{id}/transaction` (same body without `sourceId`; `{ ok: true, data }` for both committed and rolled back, 400 when refused), MCP `polpo_data_transaction` (writes need `confirm: true`; a rollback is an error result with the same structured content), SDK `client.runDataTransaction(sourceId, request)`.
