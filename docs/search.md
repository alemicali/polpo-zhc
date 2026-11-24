# Global search

One box that finds everything on the instance — the dashboard's **⌘K / Ctrl+K** palette, the REST
endpoint `GET /api/v1/search`, the MCP tool `polpo_search`, Polpo's chat tool `search` and the
SDKs (`client.search()`, `useSearch()`) all use the same engine (`src/server/search`).

## In the dashboard

- **Open it** with ⌘K (macOS) or Ctrl+K anywhere — Ctrl+K inside a terminal stays the terminal's
  "kill line" — from the **Search…** field at the top of the sidebar (above Dashboard, in both
  sidebar styles; a search icon in the collapsed rail), or from the search icon of the mobile
  header (full screen there). A link with `?search=<words>` opens it too.
- **Empty box**: recent searches, recently opened items and the main commands. Recents are kept in
  this browser per instance (`localStorage`, key `polpo:search:v1:<instance>`); with storage
  blocked they last for the tab.
- **As you type**: pages and commands appear at once (they are matched in the browser), then the
  server's results grouped by type, best group first. The request is debounced (120 ms) and every
  newer query cancels the one in flight.
- **Keyboard**: ↑ / ↓ move, ↵ opens, ⌘↵ / Ctrl↵ opens in a new tab, Tab / Shift+Tab jump to the
  next / previous group, Esc closes.
- **Prefixes** (also the chips under the box):

  | Prefix | Searches |
  |---|---|
  | `>` | commands: new chat, new task / mission / agent (words after the name go to Polpo: `> new task fix the login`), new group, theme, sidebar style, What's new, every Settings section |
  | `/` | pages |
  | `@` or `agent:` | agents |
  | `#` or `task:` | tasks |
  | `chat:` | chats and groups |
  | `mission:`, `file:`, `artifact:`, `data:`, `skill:`, `memory:` (memory and company brain), `event:` | that type only |

- **Preview** (desktop, on the right): a chat's matching message with the two before and after; a
  task's status, agent, last run and cost; a mission's status, tasks and cost; an agent's role,
  model and status; an artifact's thumbnail (SVG, HTML without scripts) or first lines; a file's
  first lines or image; a table's columns.

## What it searches

| Type | Matched on | Opens |
|---|---|---|
| `chat` | title, agent, **every message's text** (who said it, the matched passage) | `/chat?session=…` |
| `room` | group title, agents, the latest 400 messages of each group | `/chat?room=…` |
| `agent` | display name, name, role, title, model, skills, bio | `/agents/:name` |
| `task` | title, agent, group, id, description | `/tasks/:id` |
| `mission` | name, id, prompt and plan | `/missions/:id` |
| `schedule` | the mission's name, cron expression | `/schedules` |
| `playbook` | name, description, parameters | `/playbooks/:name` |
| `approval` | title, agent, status, description | `/approvals` |
| `artifact` | title, type, description, **content** (text, markup removed) | `/artifacts/:id` |
| `file` | name and path (the agents' workspace; no content index) | `/files?path=…&highlight=…` |
| `data` | sources, views, tables and their columns | `/data?source=…&table=…` |
| `connector`, `skill`, `computer`, `app`, `channel`, `member` | name, description, kind | their page |
| `memory` | shared memory and each agent's own | `/memory` |
| `brain` | company brain entities (the brain's own search) | `/brain?entity=…` |
| `event` | the latest events of the bus (not the streaming ones) | the task / mission, or `/events` |

Lists are read **as the dashboard reads them** (the instance's own API, in process), so the search
sees exactly what the dashboard shows, already redacted: vault values, config secrets and tokens
are never searched. Anything that still looks like a secret in a snippet (API keys, bearer tokens,
JWTs, private keys, `password=…`) is masked as `••••••`.

## Ranking

1. title **equal** to the query, 2. title **starting** with it, 3. every word in the title,
4. in the subtitle / keywords, 5. anywhere in the content — then match quality (exact word >
prefix > same stem > one typo > inside a word) and **recency** (fades over a few weeks).

Matching is diacritics-insensitive (`citta` finds *città*), folds Italian and English plurals
(`fatture` / `fattura`, `agents` / `agente`), treats words as prefixes, and forgives one typo
(including two swapped letters) in words of 5 letters or more. Every word must match.

## Chat messages: the full-text index

| Database | Index | Migration |
|---|---|---|
| SQLite | FTS5 table `messages_fts` over `messages.content` (external content, `unicode61 remove_diacritics 2`), kept in step by triggers; existing messages are indexed by `rebuild` | `0016_message_search` |
| PostgreSQL | GIN index `idx_pg_messages_fts` on `to_tsvector('simple', content)`, built over existing rows | `0017_message_search` |

`SessionStore.searchMessages({ terms, limit })` (optional in `@polpo-ai/core`) queries it: every
term is a word prefix (the engine passes stems: `missioni` → `mission`). Hits are re-checked
against the query before they are shown, so a stale index entry never surfaces. Stores without an
index (the file store) and typo searches with few hits fall back to a bounded scan of the latest
60 chats (80 messages each, 250 ms at most).

## REST

```
GET /api/v1/search?q=invoice&types=chat,task&limit=40&perType=6&cursor=…
```

- `q` — the words (empty: no results; the sources warm up for the next query)
- `types` — comma-separated types (default: all); unknown types → 400
- `limit` — results per page (default 40, max 100); `perType` — per type when several are searched (default 6)
- `cursor` — `nextCursor` of the previous page (with a single type it pages through all of its results)

The answer: `{ query, took, partial, groups: [{ type, label, total, items }], items, nextCursor }`;
each item is `{ type, id, title, titleHighlights?, subtitle?, snippet?: { text, highlights }, url,
updatedAt?, score, meta? }` — highlights are `[start, end)` ranges, `url` the dashboard route,
`meta` the type's details (agent, status, messageId, author, role, columns, path…).

The search answers within a time budget (800 ms): a source still loading the first time is listed
in `partial` and answered from its cache next time (lists are cached for 3–60 s and refreshed in
the background). A client that aborts the request (a newer keystroke) stops the search.

## Elsewhere

- **MCP**: `polpo_search` (toolset `core`, scope `polpo:read`) — the groups as text with bolded
  snippets and the ids the other tools take, plus the same structure.
- **Polpo in chat**: `search` (group *chats*, found by `tools_search`).
- **SDK**: `client.search(q, { types, limit, perType, cursor, signal })`; React
  `useSearch(q, { types, limit, perType, debounceMs, enabled })` → `{ data, isLoading, error }`.
