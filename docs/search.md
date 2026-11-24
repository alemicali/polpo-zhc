# Global search

One box that finds everything on the instance — the dashboard's **⌘K / Ctrl+K** palette, the REST
endpoint `GET /api/v1/search`, the MCP tool `polpo_search`, Polpo's chat tool `search` and the
SDKs (`client.search()`, `useSearch()`) all use the same engine (`src/server/search`). The same
box also **asks Polpo** in plain words (↵ on *Ask Polpo*, or ⌘↵): see [Ask Polpo](#ask-polpo).

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
- **Keyboard**: ↑ / ↓ move, ↵ opens, **⌘↵ / Ctrl↵ asks Polpo** (see [Ask Polpo](#ask-polpo)),
  ⇧↵ opens in a new tab, Tab / Shift+Tab jump to the next / previous group, Esc closes.
- **Size**: a large panel on desktop (up to 72rem wide and 86% of the height, the preview pane
  taking a bit more than half), full screen on phones.
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

## Ask Polpo

The same box takes requests in plain words, in Italian or English: *"quali task sono falliti ieri?"*,
*"apri la chat con coach"*, *"where do I set up Telegram?"*, *"vai agli artefatti"*.

- **How to ask**: as soon as there are words, the palette shows an **Ask Polpo: "…"** row — first
  when the words read like a request (a question mark, a question word, a verb like *vai / apri /
  mostra / go / open / show*, or four words and more), last otherwise, so plain keywords still open
  the best result with ↵. ↵ on that row, or **⌘↵ / Ctrl↵ from anywhere**, sends the words.
- **The fast path**: *"vai agli artifatti"*, *"apri le impostazioni dei canali"*, *"go to tasks"*,
  *"open channels settings"* — a verb then exactly a page's name (articles skipped, Italian names
  folded) — becomes a **Go to …** row and opens the page at once, without the model.
- **The answer** streams at the top of the list (a line or two), with the results Polpo picked as
  rows to open (with their preview); the normal search results stay below.
- **What runs by itself**: opening a dashboard page or a result, and commands that only change the
  view (theme, sidebar style, What's new, new group, a Settings section). The palette closes and
  the router navigates. **What never does**: anything that creates or changes data or sends a
  message (a task, a mission, an agent, a chat message…) is a row you pick — it opens a new chat
  with Polpo with the message, like the *New task* command. The dashboard enforces this on its own
  side too: only relative dashboard routes and view commands ever run without a click, whatever
  the server answers.
- **No model**: if Polpo's model is not configured (Settings → Orchestrator) or fails, one line
  says so and the search keeps working.

### The engine

`POST /api/v1/search/ask` (`src/server/search/ask.ts`) calls the **orchestrator's model**
(`settings.orchestratorModel`, its primary) through the same auth-aware client as Polpo's chat
(`streamSimpleWithAuth`: API keys, OAuth profiles, custom providers and gateways, provider
cooldowns). Its tools:

| Tool | Does |
|---|---|
| `search(query, types?)` | the global search (this engine), up to 8 results shown to the model as `[type:id] type · title (details) → route — "snippet"` |
| `suggest_results(keys)` | the results to show, best first (up to 6; without it, the first ones found) |
| `navigate(route, label?)` | an intent to open a page — only a relative route under a known page or a result (`/config?section=channels`, `/agents/coach`); ends the turn |
| `open_result(key)` | an intent to open a result; ends the turn |
| `run_command(id, argument?)` | a palette command: run at once if it only changes the view, else a button |
| `suggest_action(label, message)` | a button that hands the change to a new Polpo chat |

**Limits**: 4 model rounds (the last without tools), 3 searches, 700 output tokens per round, 25 s
in all, questions up to 500 characters, 20 questions a minute per client (on top of the API's
general limit). **Secrets**: the question, the page and every tool result go through the search's
redaction (`maskSecrets`) before the model sees them; results are already read as the dashboard
reads them (no vault values or tokens). **Cost**: the tokens and cost are recorded like Polpo's chat
turns, with source `search_ask` (token usage store, `token-usage:recorded`).

### REST

```
POST /api/v1/search/ask
{ "q": "dove configuro telegram?", "route": "/dashboard", "pages": [...], "commands": [...], "stream": true }
```

- `q` (1–500 characters); `route` — the page the person is on; `pages` (`{ id?, label, to, section? }`,
  default: the built-in list) and `commands` (`{ id, label, hint?, argument?, confirm? }` — `confirm`:
  changes data, only ever a button) — what the dashboard can open and run.
- Without `stream`: `{ ok: true, data: { answer, items, intents, fastPath, rounds, usage? } }`.
  With `stream: true`: Server-Sent Events whose `data` is `{ type, … }`: `status` (`text`), `delta`
  (`text`), `results` (`items`), `intent` (`intent`), then `done` (`result`) or `error` (`error`, `code`).
- Intents: `{ kind: "navigate", route, label, auto }`, `{ kind: "open", route, label, key, auto }`,
  `{ kind: "command", id, label, argument?, auto }`, `{ kind: "handoff", label, message, auto: false }`.
  `auto: true` is what the dashboard runs at once; the server itself never runs anything.
- Errors: `503` `NO_MODEL` (no orchestrator model — the fast path still answers) or `NOT_READY`;
  `502` `LLM_ERROR` / `TIMEOUT`; `429` `RATE_LIMITED`; `400` for an empty or too long question.

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
- **MCP, asking**: `polpo_search_ask` (toolset `core`, scope `polpo:read`) — `{ q }` → the answer,
  the results with dashboard links and the intents as text and as `{ answer, items, intents,
  fast_path }`. Intents are only returned: nothing is opened or run.
- **Polpo in chat**: `search` (group *chats*, found by `tools_search`). There is no chat tool for
  asking: in chat Polpo *is* the model that answers, with the same `search` tool (an exception in
  `MCP_EXCEPTIONS`).
- **SDK**: `client.search(q, { types, limit, perType, cursor, signal })`; React
  `useSearch(q, { types, limit, perType, debounceMs, enabled })` → `{ data, isLoading, error }`.
  Asking: `client.searchAsk(q, { route, pages, commands, onEvent, signal })` (with `onEvent` it
  streams) → `{ answer, items, intents, fastPath, rounds, usage }`; React `useSearchAsk()` →
  `{ status, question, answer, activity, items, intents, result, error, ask, cancel, reset }`
  (running intents is up to the caller).
