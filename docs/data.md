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
| **Activity** | Every test, schema read, query, SQL statement and row change: when, by whom (an agent or Polpo), rows, duration, errors; filter by action or failures. Live. |
| **Settings** | The connection (host, port, database, user, TLS; URL; file path), description, environment, categories; the secret (PostgreSQL password, REST `Authorization` header) is written to the Vault and never shown again — only whether it is stored; test the connection; delete the source (the data itself is not touched). |

Keyboard in the grid: arrows, Home/End, PageUp/PageDown move between cells; Enter opens the row; F2 edits the cell (Enter saves, Escape cancels); Space selects the row.

Old links keep working: `/data?tab=sources&source=<id>` opens the source, `?tab=explore` its tables, and an assistant's setup link (`?source=<id>&focus=password&setup=data:<id>:password`) opens Settings on the secret field.

## API additions

- `POST /api/v1/data/query` takes `includeTotal: true`: `meta.totalCount` is every row the filters match, ignoring `limit` and `offset` (SQL sources count in the database, files in memory; REST sources cannot).
- `GET /api/v1/data/:id/schema` returns, per dataset, `rowCount`, and for SQL sources `indexes` (`name`, `columns`, `unique`, `primary`) and `foreignKeys` (`columns`, `references: { dataset, columns }`, `onUpdate`, `onDelete`); columns carry `primaryKey` (now on PostgreSQL too), `nativeType` and `defaultValue`.
- A view binding can be `{ id, sql: { sourceId, statement } }`: a read-only statement run live (REST `/api/v1/views`, the agent tools `data_create_view` / `data_update_view`, MCP `polpo_data_view_save`).
