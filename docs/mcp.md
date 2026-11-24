# Polpo as an MCP connector

Every Polpo server is also an [MCP](https://modelcontextprotocol.io) server. Claude Code, Codex, Claude Desktop, Cursor and any other MCP client can use your instance: ask Polpo to do things (and answer its questions and previews), chat with agents, follow tasks and missions, read data, read and write files, make artifacts and approve requests.

- **Endpoint:** `https://<your-polpo-host>/mcp` (Streamable HTTP, stateless).
- **Authentication:** your Polpo API key, as `Authorization: Bearer <key>` (or `X-API-Key: <key>`), or the MCP key (`POLPO_MCP_KEY`, below), or OAuth (a sign-in) for Claude and ChatGPT connectors. A server started without any API key, MCP key or login accepts calls without one: never make such a server reachable from the internet.
- **Local process instead of a URL:** `polpo mcp --url <server> --api-key <key>` runs the same tools (and the agent card) over stdio and forwards them to the server.

## Tools

The connector exposes tools designed for what people do, rather than one tool per endpoint. They are named `polpo_<area>_<verb>` (the same vocabulary as the hosted Polpo Cloud connector) and grouped in **toolsets**.

Every tool has a title and honest annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`), described parameters, and, when it returns data, an `outputSchema` with `structuredContent` plus a short text for the model. Output schemas are open (`additionalProperties` allowed): a field added later never makes an SDK client (Claude Code, Cursor) reject a result, and the tests validate every result against its schema with the SDK's own Ajv validator. Lists take `limit` and `cursor` and return `next_cursor`. Errors come back as `isError` results that say what to do next.

### core (on by default)

| Tool | What it does |
|---|---|
| `polpo_ask` | Ask Polpo in natural language: it can do anything the instance can. Returns `{ status, reply, session_id, pending? }`; pass `session_id` to continue the conversation. |
| `polpo_agent_chat` | Talk to one agent, with its tools, memory and skills; same result. |
| `polpo_answer` | Answer what a turn stopped for (`status: "needs_input"`): Polpo's questions, a mission plan to execute, save as draft, refine or cancel, a WhatsApp message or an email to send, refine or cancel. |
| `polpo_search` | Search everything at once, like ⌘K in the dashboard: chats (message text too, with who said it), groups, agents, tasks, missions, artifacts, files, data, skills, memory, the company brain… grouped by type, best first, with snippets (`types`, `limit`, `per_type`, `cursor`). See [search.md](search.md). |
| `polpo_search_ask` | Ask the search in plain words (Italian or English), like Enter in ⌘K: Polpo's model searches, answers in a line or two and returns the results worth opening plus intents (a page to open with its link, a palette command, or a change to hand to Polpo). Nothing is executed (read scope). See [search.md](search.md#ask-polpo). |
| `polpo_agents_list` | The agents. |
| `polpo_agent_show` | An agent's card: in Claude and ChatGPT an interactive card (see below), elsewhere text: its engine (Polpo, Claude Code, Codex) and computer, the task at hand with its latest run (engine, model, computer, cost) or why it failed, and the connectors it may use with their accounts. |
| `polpo_approvals_list`, `polpo_approval_resolve` | Decide on requests that wait for a person. |

### tasks (on by default)

| Tool | What it does | Annotations |
|---|---|---|
| `polpo_tasks_list` | Tasks by status, agent, mission, group, words or time (`updated_since`: a duration back from now such as `24h` or `7d`, or an ISO date/time; REST: `GET /tasks?updatedSince=`); paged, most recently updated first. Each item has `createdAt` / `updatedAt`, `last_run` (engine, model, computer), `toolScope` when the task narrows its agent's tools and, when it failed, `failure` (see below); the line shows a harness engine, when it was updated, "tools restricted" and the failure. | read-only |
| `polpo_task_show` | A task's card: in Claude and ChatGPT an interactive card (see [the task and mission cards](#the-task-and-mission-cards-mcp-app)), elsewhere text. | read-only |
| `polpo_task_get` | One task: description, result and assessment, outcomes, timestamps, why it failed (`failure`: `{ reason, retryable, kind }`), the tasks it depends on with their status (`dependencies`; their results reach its prompt, and its agent reads them in full with `task_result` / `dependency_results`), where and with what each run executed (`runs`: engine, model, computer, egress, session, cost) and its latest activity. The text shows the first 1500 characters of the result; the structured content has the whole task (`result.stdout`, every outcome). | read-only |
| `polpo_task_create` | Give an agent a task (title, description, `assignTo`, `dependsOn`, group, expectations, retries, duration, side effects, draft, and an optional tool scope: `connectors`, `connector_tools`, `allowed_tools`, which only narrow what the agent has). `dependsOn` takes ids of existing tasks: an unknown id is refused (it would keep the task pending for ever). | write |
| `polpo_task_update` | Change the description, agent, retries, side-effects flag or tool scope (`connectors`, `connector_tools`, `allowed_tools` replace it; `inherit_tools: true` drops it), or start a draft; returns what changed. | write, idempotent |
| `polpo_task_retry` | Run a failed task again. | write |
| `polpo_task_kill` | Stop a running or waiting task (`confirm: true`). | destructive |
| `polpo_task_delete` | Delete a task and its result for good (`confirm: true`); a running task is stopped first with `polpo_task_kill`. | destructive |
| `polpo_task_direct` | Steer a running task, add a follow-up, or continue a finished one. | write |
| `polpo_task_wait` | Wait until a task is done, failed, in review or waiting for approval (or given statuses), at most 55 s; returns its state, so call again to keep waiting. | read-only |
| `polpo_task_logs` | The activity of the task's runs (Polpo's engine and agent harnesses alike: messages, tool calls, results, usage), newest first, paged backwards, with `runs`. | read-only |

### missions (on by default)

| Tool | What it does | Annotations |
|---|---|---|
| `polpo_missions_list`, `polpo_mission_get` | Missions, with what each cost so far and its budget (`cost_usd`, `budget_usd`, `over_budget`); one with its plan, its tasks and their status counts, and its full `cost` (USD, tokens, runs, harness estimate vs model cost, by agent and by engine, `partial` when older runs were dropped) — see [missions.md](missions.md). | read-only |
| `polpo_mission_create` | A mission from a structured plan (tasks with `assignTo` and `dependsOn` by title; checkpoints, delays, quality gates), validated as the executor will; a draft, or started with `run: true`. `budget_usd` sets its spending limit. | write |
| `polpo_mission_update` | Rename, set or clear its budget (`budget_usd`, `null` clears; allowed while it runs, and raising or clearing it lets a mission its budget paused go on), or replace its tasks, checkpoints, delays or quality gates (not while it runs). | write, idempotent |
| `polpo_mission_run` | Start a draft, scheduled or finished mission, or resume a paused one. | write, open world |
| `polpo_mission_abort` | Stop a running mission and its unfinished tasks (`confirm: true`; without it, it says what would stop). | destructive |
| `polpo_mission_delete` | Delete a mission, its schedule and its tasks for good (`confirm: true`); a running mission is aborted first. | destructive |
| `polpo_mission_wait` | Wait until it is completed, failed, cancelled or paused, at most 55 s; returns the status and task counts. A scheduled or recurring mission never completes: the wait is reached when its current (or latest) run has finished (every task of that run done or failed), with `run: { number, outcome: "completed" \| "failed", task_counts }`; one that never ran keeps waiting for its first run. | read-only |
| `polpo_mission_show` | A mission's card: in Claude and ChatGPT an interactive card (cost against the budget, by engine and agent, its tasks), elsewhere text. | read-only |
| `polpo_playbooks_list`, `polpo_playbook_run` | Reusable mission templates, run with their parameters. | read-only / write |

### Why a task failed

A failed task carries `failure` on every surface (`GET /tasks/:id`, the slim list, `polpo_task_get`, `polpo_tasks_list`, the cards, Polpo's `get_task`): `reason`, its error in a line (an agent harness labels it and says what to change: "Bedrock: model … not enabled for this account — …", "Anthropic: authentication failed — …"); `retryable: false` when it was not retried automatically, because a re-run of the same agent would fail the same way (`result.retryable` on the task); and `kind`: `model_access`, `auth`, `budget`, `killed`, `assessment` or `error`.

`polpo_task_wait` and `polpo_mission_wait` send `notifications/progress` when the client passes a `progressToken`: that request is then answered as an event stream.

### team and config (on by default; changes need `polpo:admin`)

| Tool | What it does | Annotations |
|---|---|---|
| `polpo_agent_get` | An agent's configuration: role, model, instructions, tools, skills, identity, and its per-connector tool selection (`connectorTools`); selected tool names a connector no longer lists come back in `stale_connector_tools`. | read-only |
| `polpo_agent_create`, `polpo_agent_update` | Add an agent, or change its role, model, instructions, tools, skills, identity, manager or browser egress proxy (`browserEgress`, a name from the settings' egress proxies). `allowedTools` takes patterns: `artifact_*` lets it make artifacts (docs, html dashboards, diagrams), also on a harness engine (its Polpo tools run on the Polpo server). `computers: null` (or `[]`) clears its list of computers. `engine`: `"polpo"` (default) or an agent harness `{ harness: "claude-code" \| "codex" \| "opencode", model?, permissionMode?, effort?, maxBudgetUsd?, credentialRef? }` running in its computer (OpenCode: any model, its `model` the provider's id) (`credentialRef`: the agent's own key, a vault reference); refused unless the harness is enabled and the agent's computer can run it (see [harnesses.md](harnesses.md)). `connector_tools`: which tools of each connector granted to it the agent gets, `{ <connector id>: "*" \| [tool names] }` (`"*"` or no key: all, current and future; a list: only those raw MCP tool names); on update it replaces the whole selection and `null` clears it (see [connectors.md](connectors.md#choosing-an-agents-tools)). | write |
| `polpo_agent_delete` | Remove an agent (`confirm: true`). | destructive |
| `polpo_agent_avatar_set` | An agent's picture, from a public https URL, a file of the instance or base64 (checked by its bytes); `remove: true` removes it. | write, idempotent |
| `polpo_teams_list` | The teams and their agents. | read-only |
| `polpo_team_save` | Create a team, rename it (`new_name`), move agents into it (`add_agents`). | write |
| `polpo_team_delete` | Delete an empty team (`confirm: true`). | destructive |
| `polpo_config_get` | Settings (the orchestrator's display name, `orchestratorName`, "Polpo" by default; Polpo's model and fallbacks, image model, reasoning, the general settings, compaction, MCP toolsets and keys as vault references, egress proxies without credentials, escalation, SLA, appearance…), branding, and a summary of notification channels, rules and approval gates. Never secrets. | read-only |
| `polpo_config_update` | The orchestrator's display name (`orchestrator_name`, 1–40 characters; `null` or `""` restores "Polpo"), Polpo's model (and fallbacks), the image model, the reasoning level, the egress proxies agents' browsers can use (`egress_proxies`: `{ name: "socks5://host:port" }`, `null` removes them); `general` (Configuration → General: `maxRetries`, `logLevel`, `maxConcurrency`, `taskTimeout`, `staleThreshold`, `maxFixAttempts`, `maxQuestionRounds`, `maxResolutionAttempts`, `maxAssessmentRetries`, `defaultQualityThreshold`, `autoCorrectExpectations`, `enableScheduler`, `enableVolatileTeams`, `volatileCleanup`, `logRetentionDays`, `emailAllowedDomains`, `voiceReplies`, `defaultRetryPolicy`; `null` restores a default), `compaction`, `dependency_results` (how much of the results of the tasks it depends on a task receives in its prompt: `{ perTaskChars, totalChars }`, defaults 2000 and 20000; `null` restores them), `tailscale` (the auth key only as a vault reference), `mcp` (toolsets; named keys as vault references, scopes checked), `connectors` (private network, tool timeout). Models are checked against the catalog, vault references against the vault. Returns what changed. | write, idempotent |
| `polpo_branding_get`, `polpo_branding_update` | Product name, tagline, logo and dark-mode logo (`logo_dark`, shown in dark mode; the logo when absent), and the instance's default look: `theme` (light, dark, system), `palette` (one of the nine), `tokens` (`light` / `dark` maps of design tokens — colours, fonts, radius, shadows; `null` removes one; `replace` replaces a map; `derive` fills the rest; see [appearance.md](appearance.md)), `reset_appearance`. A logo comes from a public https URL (fetched by the server: never from private addresses, also after redirects; at most 4 MB), a file of the instance, or base64 data; PNG, JPEG, WebP or GIF, checked by its bytes; `null` removes it. Every value is checked before anything changes; the result lists what changed (`appearance.custom.light.primary`…). | read-only / write, idempotent |
| `polpo_providers_list`, `polpo_models_list` | LLM providers (with or without a key) and the model catalog (`provider:model`). | read-only |

**Provider API keys never go through MCP.** `polpo_providers_list` returns `setup_url`, the dashboard's Providers page, where the person enters the key. The instance's default look (`polpo_branding_update`) is what everyone sees unless they customize their own browser in Configuration → Appearance.

### artifacts, data, files (on by default)

| Tool | What it does |
|---|---|
| `polpo_artifacts_list`, `polpo_artifact_get`, `polpo_artifact_create`, `polpo_artifact_update` | Docs, editable workspaces (slides, sheets, design, motion), html dashboards, drawings and diagrams; update takes `expectedVersion` and is refused when the artifact changed since (see [artifacts.md](artifacts.md)). |
| `polpo_data_sources_list`, `polpo_data_query` | Structured data: the sources (with the agents that may use them) and rows of a dataset (fields, filters, sort, limit, `offset`; `includeTotal` also counts every matching row as `meta.totalCount`, not for REST sources). |
| `polpo_files_list`, `polpo_files_search`, `polpo_file_read` | Browse and read the instance's files (the agents' workspace, `.polpo`, volumes): text by line ranges, images and PDFs as they are. |
| `polpo_file_write`, `polpo_file_manage` | Create a file (text or base64; replacing one needs `overwrite: true`), make folders, rename, delete (`confirm: true`). |

#### The Data area (the `data` toolset)

Everything on the dashboard's Data and Views pages, as direct tools. Sources are the instance's setup (changes need `polpo:admin`); changing rows and views is day-to-day work (`polpo:work`); reads need `polpo:read`.

| Tool | What it does | Kind |
|---|---|---|
| `polpo_data_source_get` | One source by id, slug or name: connection settings (a password or token in the location masked as `***`), which credentials are stored (field names, never values), which agents may use it (`grants`), and its schema (datasets and columns with types, the database's own type, defaults and primary keys; row counts — exact on SQLite, the planner's estimate on PostgreSQL — and, for SQL sources, indexes and foreign keys; `schema_limit` at most 200; `schema: false` skips it). A missing secret comes with `setup_url`. | read-only, open world |
| `polpo_data_source_save` | Create a source (`name`, `kind`: postgres, sqlite, rest, json, csv, `location`; port, database, username, ssl, default dataset, environment, tags) or change one (`id`; only the fields given change). `grants` (`agent`, `capabilities` read/write/admin, `datasets`, `excluded_fields`) replace who may use it. | write (admin) |
| `polpo_data_source_test` | Connect and count the datasets; on failure, what to fix. | read-only, open world |
| `polpo_data_source_delete` | Remove a source and its stored credentials (`confirm: true`; without it, it names the views it would break). The data itself stays where it is. | destructive (admin) |
| `polpo_data_activity` | A source's recent tests, schema reads, queries, SQL and row changes, by whom, with rows, duration and errors (paginated). | read-only |
| `polpo_data_sql` | One read-only statement (`SELECT`, `WITH`, `EXPLAIN`) on PostgreSQL or SQLite; `max_rows` (default 200, at most 1000; rows are also cut at about 200 KB) with `truncated` and a `note`. Anything that writes is refused (the server refuses it too): rows change with `polpo_data_mutate`; schema changes (`CREATE`, `ALTER`, `DROP`, `TRUNCATE`) are not possible through Polpo. | read-only, open world |
| `polpo_data_mutate` | `insert` a row (`values`), `update` or `delete` rows (`filters` required: never a whole table). Update and delete need `confirm: true`; without it they say how many rows would change. | destructive, open world |
| `polpo_data_views_list`, `polpo_data_view_get` | Data views (live dashboards): widgets, bindings, the sources they read, the link; one view in full. | read-only |
| `polpo_data_view_save`, `polpo_data_view_delete` | Create a view (`name`, `bindings`: a query, a read-only SQL statement `{ sql: { sourceId, statement } }` run live, or inline rows, `widgets`) or change one (`id`; a list given replaces it); delete one (`confirm: true`). | write / destructive |

**Connection secrets never go through MCP** (a database password, a REST API's `Authorization` header): there is no parameter for them, and a location with a password or token in it (`postgres://user:pass@…`, `?api_key=…`) is refused. `polpo_data_source_save` returns the hand-off (`setup_url` opens the source's settings on the Data page with the field focused, `setup_id` `data:<source id>:password` — or `:authorization` for a REST API saved with `requires_auth: true` — and `next_step`); `polpo_setup_wait` waits for it, then `polpo_data_source_test` checks the connection.

The tools below act directly, like the dashboard: they call the instance's own REST API, never Polpo's model. Only `polpo_ask` (and `polpo_agent_chat`, which is the agent's own turn) run a model.

### rooms (on by default)

Group chats of people and agents (the dashboard's groups).

| Tool | What it does | Annotations |
|---|---|---|
| `polpo_rooms_list` | Rooms, newest first; with `id`, one room in full (agents, goal, owner, reply settings, who is answering now). | read-only |
| `polpo_room_create`, `polpo_room_update` | Open a room with agents, a goal and an owner; rename it, change its agents, goal, owner or reply settings. | write / write, idempotent |
| `polpo_room_delete` | Delete a web room, its transcript and its agents' "(group)" sessions (`confirm: true`); Telegram groups are not deleted here. | destructive |
| `polpo_room_messages` | The transcript, latest page first, older pages with `cursor`; `latest_id` is where to wait from. | read-only |
| `polpo_room_post` | Write as the connected person (the principal's name): `@agent` mentions and `reply_to_id` call agents in, as on the web. Returns the message id. | write, open world |
| `polpo_room_wait` | Wait (at most 55 s) for messages after `after_id`: by default until an agent answered and none is still typing. | read-only |

### chat (on by default)

| Tool | What it does | Annotations |
|---|---|---|
| `polpo_chat_sessions_list` | Conversations with Polpo and agents (filter by agent, starred, words). Continue one with `polpo_ask` / `polpo_agent_chat` and its `session_id`. | read-only |
| `polpo_chat_messages` | A conversation's messages, paged backwards: text, the tools used, attachments; never tool arguments. | read-only |
| `polpo_chat_session_update` | Rename, star or unstar. | write, idempotent |
| `polpo_chat_session_delete` | Delete a conversation (`confirm: true`). | destructive |

### memory (on by default)

| Tool | What it does | Annotations |
|---|---|---|
| `polpo_memory_get` | The shared memory, or one agent's own (`agent`). | read-only |
| `polpo_memory_update` | `append` a note; `replace` it all or `clear` it (both need `confirm: true` when there is something to lose). | destructive |

### skills (on by default; changes need `polpo:admin`)

| Tool | What it does | Annotations |
|---|---|---|
| `polpo_skills_list`, `polpo_skill_get` | The pool (who uses each skill, tags); one skill with its instructions. | read-only |
| `polpo_skill_create`, `polpo_skill_update` | Write a skill (and assign it); change its description, instructions, tools, tags or category. | write / write, idempotent |
| `polpo_skill_install` | Install skills from a GitHub repository or a path on the server. | write, idempotent, open world |
| `polpo_skill_assign` | Assign a skill to agents, or unassign it. | write, idempotent |
| `polpo_skill_delete` | Remove a skill from the pool (`confirm: true`); its history is kept for a grace period, so it can be restored. | destructive |
| `polpo_skill_versions`, `polpo_skill_version_diff` | A skill's history (every change: number, date, who, how, files, size; the current one marked); what changed between two versions (files added, removed, changed, unified diffs of text files). `polpo_skill_get` says how many versions a skill has. See [skills.md](skills.md#versions). | read-only |
| `polpo_skill_restore` | Put an older version back, or bring back a deleted skill; the current state is kept as a version first (`confirm: true`). | destructive |

### automation (on by default)

| Tool | What it does | Annotations |
|---|---|---|
| `polpo_schedules_list` | Scheduled missions (cron or a time, `paused` or not, next and last run, `last_outcome` and `last_error`, `missed_runs` while the server was down, `catch_up`); with `mission_id`, its recent runs' tasks. All of it is persisted: a restart keeps a pause and the next run. | read-only |
| `polpo_schedule_create`, `polpo_schedule_update` | Schedule a mission; change the expression, recurring, end date; pause (`enabled: false`) or resume (`enabled: true`); `catch_up`: what a run missed while the server was down does — `"once"` (default) runs it at startup when it is at most one interval late (24 h for a one-shot), `"none"` skips to the next. The expression is checked first: a cron with a value out of range (e.g. `99 99 * * *`) or a past time is refused with the reason. | write / write, idempotent |
| `polpo_schedule_run` | Run a scheduled mission now (the next scheduled run stays; a paused schedule stays paused). | write, open world |
| `polpo_schedule_delete` | Remove the schedule; the mission stays as a draft (`confirm: true`). | destructive |
| `polpo_checks_list` | Recurring checks and reminders: what Polpo or an agent does on a schedule and reports in a chat; proposed ones wait for a yes. | read-only |
| `polpo_check_create` | Instructions or a fixed message, every N minutes, on a cron (in a timezone) or once; reports to a chat session and, with `to`, a Telegram chat. Recorded as created by the principal. A time (`at`) that has passed is refused. | write |
| `polpo_check_update` | Change the instructions, message, schedule or limits; `confirm: true` approves a proposed check. | write, idempotent |
| `polpo_check_cancel` | Stop a check for good (`confirm: true`); it stays listed as cancelled. | destructive |
| `polpo_check_delete` | Delete a check's record (cancelled, ended or still active: it stops first; `confirm: true`). Its reports stay in their chat. | destructive |

### connectors (on by default; changes need `polpo:connectors`)

| Tool | What it does | Annotations |
|---|---|---|
| `polpo_connectors_list` | Connectors with their status, signed-in `account` (when known), auth (authorized? token set?), tool count, `icon_url` and who may use them; with `id`, its tools and their policy. With `agent`, only the connectors granted to that agent and the tools it gets (`agent_tools`; with `id`, `agent_gets` per tool and `stale_tools`), and `no_access`: the ones it has no access to — a task's tool scope never grants, so grant one first (`polpo_connector_update` `add_agents`), then scope the task to it. Never secrets. | read-only |
| `polpo_connector_catalog` | Well-known remote MCP servers to add in one step, and what each needs. | read-only |
| `polpo_connector_add` | Add from the catalog or a remote https URL (never a local process). A custom URL is probed first (transport, sign-in, scopes, name: see `docs/connectors.md` → "Detecting how to connect"); `detect_only: true` only returns that as `detected`, with the options and the recommended one. OAuth ones return `authorization_url` for the person to open; token-based ones are finished in the dashboard (`setup_url`). | write, open world |
| `polpo_connector_update` | Who may use it (agents, Polpo), on or off, name, per-tool policy (`allow`, `ask`, `off`). | write, idempotent |
| `polpo_connector_test` | Connect now and list its tools. | write, idempotent, open world |
| `polpo_connector_connect` | A fresh OAuth link (new, or `needs_reauth`). | write, open world |
| `polpo_connector_disconnect`, `polpo_connector_remove` | Sign it out (tokens revoked), or delete it with its secrets (`confirm: true`). | destructive |

**Connector secrets never go through MCP**: there is no parameter for a token, a header value or an OAuth app's client secret. The person enters them on the dashboard's Connectors page (`setup_url`).

### channels (on by default; rule changes need `polpo:admin`, sending and testing `polpo:messages`)

| Tool | What it does | Annotations |
|---|---|---|
| `polpo_channels_list` | Notification channels (name and type, never their tokens) and rules, the Telegram bots and the groups, topics and people they reach, WhatsApp profiles. | read-only |
| `polpo_channel_test` | Send a test notification on a channel. | write, open world |
| `polpo_message_send` | Send now on Telegram (with files), WhatsApp (text or a file) or email (with the agent's mail account and attachments), as Polpo or an agent. Without `confirm: true` it shows what it would send. | destructive, open world |
| `polpo_notification_rule_save`, `polpo_notification_rule_delete` | Create or replace a rule (events → channels, severity, template, cooldown); delete one (`confirm: true`). | write, idempotent / destructive |

Channels' setup (secrets through the dashboard hand-off), routes, Telegram invites and pairings and WhatsApp sign-in are in the `settings` toolset, below.

### computers (on by default; changes need `polpo:computers`)

Computers are persistent machines agents work on (Daytona or E2B; see `docs/computers.md`).

| Tool | What it does | Annotations |
|---|---|---|
| `polpo_computers_list` | "host" (this server) and each computer with its live status (running, stopped, paused, hibernated, archived, creating, error; missing = not created yet; deleted = its machine was deleted at the provider, outside Polpo: its next use or a reset makes a new one, without its files), last use, uptime, last snapshot and the agents using it; with `id`, one computer. | read-only |
| `polpo_computer_get` | One computer in full, as its page shows it: live status, agents, snapshots (Daytona v2), what a new machine is made from (image or snapshot, region, size), when it stops or hibernates by itself, recent activity (status changes, wakes, rotations, errors, a machine deleted at the provider), the harness sessions and recent task runs on it, and what was spent on it. Never starts it. | read-only |
| `polpo_computer_webhooks` | Whether the computers' providers push their machines' state (webhooks): per provider (Daytona, E2B) receiving / configured / not configured, last event, the URL to give the provider. Daytona: the endpoint is added in Daytona's dashboard and its signing secret entered in the dashboard (a setup link; never through MCP). E2B: `action: register` / `unregister` (Polpo registers the endpoint with its own secret). | write, idempotent, open world |
| `polpo_computer_save` | Create a computer (`kind` needed) or change one (only the fields given; `null` clears). `start: true` creates the machine now; otherwise it is created on first use. A network allowlist is checked when saved with the provider's rules (an entry that is not a host name is refused; Daytona v2 takes host names only). A changed network applies at the next start or wake on Daytona v2, after a reset elsewhere (the note says which). | write, idempotent |
| `polpo_computer_control` | `start`, `stop`, `restart`, or `reset` (delete the machine and create a new one: needs `confirm: true`). A reset whose wipe is done reports success (with a note when the new machine comes on its next use). | destructive, open world |
| `polpo_egress_status` | Where browsers go out: each egress proxy (reachable from this server, the agents and host computers using it), agents naming a proxy that does not exist, and each remote computer's egress through Tailscale in its VM (tailnet, node, path, proxy reachable, where its browser goes out; a hibernated or stopped computer is not started: "checked again when it wakes"). With `computer`, one computer. | read-only |
| `polpo_computer_delete` | Delete a computer and its machine (`confirm: true`); refused while it is an agent's default. | destructive |

An agent's computer is set with `polpo_agent_update` (`defaultComputer`, `computers`).

### Toolsets off by default

Enable them with `settings.mcp.toolsets` / `POLPO_MCP_TOOLSETS` (e.g. `default,brain,vault`) or `all`; see [Toolsets](#toolsets).

| Toolset | Tools | Annotations |
|---|---|---|
| `brain` | `polpo_brain_search` (by words, or the most connected entities and counts), `polpo_brain_get` (an entity with its relations and claims), `polpo_brain_save` (an entity, a relation or a claim), `polpo_brain_delete` (`confirm: true`) | read-only / write / destructive |
| `learning` (needs `polpo:admin`) | `polpo_learning_get` (an agent's learning settings and changes), `polpo_learning_review` (learn from its conversations now), `polpo_learning_revert` (`confirm: true`) | read-only / write / destructive |
| `watchers` | `polpo_watchers_list`, `polpo_watcher_create` (when a task reaches a status: create a task, run a mission or notify; never a shell command), `polpo_watcher_delete` (`confirm: true`) | read-only / write / destructive |
| `vault` (needs `polpo:vault`, also to read) | `polpo_vault_list` (each agent's entries: service, type, label and the names of the fields, never values; `setup_url` to add or change one), `polpo_vault_delete` (`confirm: true`; not entries shared from another agent) | read-only / destructive |
| `apps` | `polpo_apps_list` (services, whether they run, URLs, deployments, domains), `polpo_app_control` (start; stop and restart need `confirm: true`), `polpo_browser_profiles_list`, `polpo_browser_profile_clear` (`confirm: true`) | read-only / destructive |

### settings (on by default; changes need `polpo:admin`)

Every other section of the dashboard's Configuration page, as direct tools (no `polpo_ask`). A client without the admin scope sees only the reads (members, MCP access, channel peers and the WhatsApp login not even those). A connector URL can leave the toolset out (`?toolsets=core,tasks`), an instance with `settings.mcp.toolsets`.

**Secrets never pass through MCP** (what is typed into an MCP client stays in its conversation history). Instead, the hand-off: a tool that needs a secret returns `setup_url` — an absolute link (`POLPO_DASHBOARD_URL`, else `POLPO_UI_PUBLIC_URL`, else the API's origin; relative otherwise) that opens the exact form with the item selected and the field focused, e.g. `/config?section=channels&channel=ops&focus=botToken&setup=channel:ops:botToken` — plus `setup_id` (what is awaited) and `next_step` (one line to show the person). The assistant shows the link, calls `polpo_setup_wait { setup_id }` (it returns as soon as the secret exists — never its value — or `pending` at the timeout), then verifies with the area's test tool and goes on. After saving, the dashboard says "Done — go back to your assistant". Setup ids: `channel:<name>:<field>`, `provider:<name>`, `custom-provider:<id>:apiKey`, `sandbox:<daytona|e2b>:credential`, `sync:r2:secretAccessKey`, `vault:<agent>:<service>`, `connector:<id>:<field>`, `data:<source id>:<password|authorization>`.

| Tool | What it does | Annotations |
|---|---|---|
| `polpo_sandbox_get`, `polpo_sandbox_update` | Where agents' tools run: default provider, allowed providers, network, resources, chat idle minutes, external-content confinement, remote chats, isolation, lifecycle, warm VMs, volumes, and Daytona / E2B options (api, URL, target, region, snapshot, image, max timeout, hibernate; the key only as a vault reference `credential`). Fields merge; `null` removes one; values the server does not accept are listed. | read-only / write, idempotent |
| `polpo_sandbox_provider_test` | Check a remote provider answers with its key. | write, open world |
| `polpo_policies_get`, `polpo_policies_update` | Approval gates, the escalation policy and SLA monitoring; set or remove (`null`) the escalation policy and SLA (channels must exist). | read-only / write, idempotent |
| `polpo_approval_gate_save`, `polpo_approval_gate_delete` | Create or replace a gate (hook, auto or human handler, condition, channels, timeout and its action, priority, revisions, outcomes); delete one (`confirm: true`). | write, idempotent / destructive |
| `polpo_members_list`, `polpo_members_invite`, `polpo_members_remove` | Who may sign in (emails; members have no roles); add one (with an emailed sign-in link); remove one (`confirm: true`; never the last). Listing needs `polpo:admin` too. | read-only / write / destructive |
| `polpo_mcp_access_list`, `polpo_mcp_grant_revoke` | OAuth grants (app, person, scopes, dates) and named MCP keys (never values; keys are set with `polpo_config_update` `mcp.keys`); revoke a grant (`confirm: true`). Listing needs `polpo:admin` too. | read-only / destructive |
| `polpo_channel_save`, `polpo_channel_remove` | Set up a notification channel: its fields (chat id, recipients, sender, SMTP host and port, WhatsApp profile, push options) and its inbound gateway; the secrets it still needs come back as the hand-off (`setup_url`, `setup_id`, `next_step`). Saved secrets are kept and never returned. Remove one (`confirm: true`). | write, idempotent / destructive |
| `polpo_channel_routes_list`, `polpo_channel_route_set` | Who answers on each channel: inbound, the dedicated agent (or Polpo), replies through another channel, group replies (mentions or intent), session mode and idle time, per-agent overrides. Changes merge. | read-only / write, idempotent |
| `polpo_telegram_verify` | Check a saved channel's bot answers (its token stays on the server). | write, open world |
| `polpo_channel_invite` | A Telegram invite link (`t.me/<bot>?start=…`) for a channel with inbound on, or an invite's status. | write |
| `polpo_channel_peers`, `polpo_channel_allowlist`, `polpo_channel_pairing` | Peers, the allowlist and pending pairing codes (admin, it names people); allow or remove a peer (remove: `confirm: true`); approve or reject a pairing. | read-only / destructive / write |
| `polpo_setup_wait` | Wait (≤ 55 s) until the secrets of one or more `setup_id`s are saved in the dashboard: `done` or `pending`; only whether they exist, never their values. | read-only |
| `polpo_whatsapp_login`, `polpo_whatsapp_login_wait`, `polpo_whatsapp_logout` | Sign a WhatsApp profile in: the QR code comes back as an image to scan, then wait for the scan (a new QR when WhatsApp changes it); cancel; sign out (`confirm: true`). Admin only, reads too. | write / read-only / destructive |
| `polpo_sync_status`, `polpo_sync_update` | Cloud sync to R2: endpoint, bucket, prefix (never the keys, not even the access key id), schedule, excluded paths, the run in progress and the latest runs; change endpoint, bucket, prefix, schedule and excludes (the keys stay). | read-only / write, idempotent |
| `polpo_sync_run`, `polpo_sync_test`, `polpo_sync_disconnect` | Push or pull now (copy, or sync: a mirror that deletes; `dry_run`; a real run needs `confirm: true` and continues in the background); test the bucket; forget the bucket and keys (`confirm: true`). | destructive, open world / write / destructive |
| `polpo_custom_providers_list`, `polpo_custom_provider_save`, `polpo_custom_provider_remove` | Custom LLM providers and gateways: endpoint, API, models, static headers (never keys or secret headers: `setup_url`); changes merge; remove with `confirm: true`. | read-only / write / destructive |
| `polpo_provider_disconnect` | Remove a built-in provider's key or sign-in (`confirm: true`). | destructive |
| `polpo_harnesses_get`, `polpo_harnesses_update` | Agent harnesses (Claude Code, Codex, OpenCode; see [harnesses.md](harnesses.md)): which are enabled, auth (`api-key`, `bedrock`, `vertex`, `ai-gateway`, `gateway`; Codex `api-key`, `ai-gateway`, `gateway`; OpenCode `api-key` with a `provider` — anthropic, openai, google, xai, mistral, groq, deepseek, openrouter, moonshotai, zai —, `bedrock` with a Bedrock API key, `ai-gateway`, `gateway` in format `openai-chat`, `openai-responses` or `anthropic`; its `model` is required), the credential's vault reference and whether that entry exists (never its value), Bedrock region, Vertex project and region, the model gateway (`gateway`: preset, format, base URL, auth scheme, headers from the vault or literal, models, non-Claude), default model, whether the key stays on the server (model relay), `allow_host`, the agents on each and the computers that can run them. `polpo_harnesses_get { test: "claude-code" | "codex" | "opencode", agent? }` also tests the connection: one tiny model request from the Polpo server (never the computer) with that auth and model, or the agent's own key → ok, latency, endpoint, or a labelled error (`auth`, `model`, `network`, `timeout`, `protocol`, `config`). Changes merge; a missing credential entry comes back as the hand-off (`setup_id` `vault:<agent>:<service>`); a Claude subscription and OpenCode logins (ChatGPT, Copilot, OpenCode Zen…) are refused; disabling a harness agents use is refused. | read-only / write, idempotent |
| `polpo_harness_sessions_list` | Harness sessions (one per task run or chat on a harness): agent, computer, state (running, idle, detached while its computer hibernates, stopped, error), live now, bootstrapped when and how long it took, last detach and resume, turns, cost so far. Filter by `agent` or `computer`. | read-only |
| `polpo_harness_session_control` | `stop` a session's runtime (its bridge exits; the conversation resumes on the next turn) or `reset` it (forgets the conversation; `confirm: true`). A session a task run holds now is refused (kill the task). Needs `polpo:work`. | destructive, idempotent |

What each Configuration section maps to:

| Section | Read | Change |
|---|---|---|
| General | `polpo_config_get` | `polpo_config_update` (`general`, `compaction`, `tailscale`, `connectors`) |
| Members | `polpo_members_list` | `polpo_members_invite`, `polpo_members_remove` |
| Agent | `polpo_config_get`, `polpo_models_list` | `polpo_config_update` (name, model, image model, reasoning) |
| Providers | `polpo_providers_list`, `polpo_custom_providers_list` | `polpo_custom_provider_save` / `_remove`, `polpo_provider_disconnect`; keys and sign-in: dashboard |
| Channels | `polpo_channels_list`, `polpo_channel_routes_list`, `polpo_channel_peers` | `polpo_channel_save`, `polpo_channel_remove`, `polpo_channel_test`, `polpo_channel_route_set`, `polpo_telegram_verify`, `polpo_channel_invite`, `polpo_channel_allowlist`, `polpo_channel_pairing`, `polpo_whatsapp_login` / `_wait` / `_logout` |
| Rules | `polpo_channels_list` | `polpo_notification_rule_save`, `polpo_notification_rule_delete` |
| Policies | `polpo_policies_get` | `polpo_approval_gate_save` / `_delete`, `polpo_policies_update` |
| Sandbox | `polpo_sandbox_get` | `polpo_sandbox_update`, `polpo_sandbox_provider_test` |
| MCP access | `polpo_mcp_access_list` | `polpo_mcp_grant_revoke`; keys: `polpo_config_update` `mcp.keys` |
| Appearance | `polpo_branding_get` | `polpo_branding_update` |
| Cloud sync | `polpo_sync_status` | `polpo_sync_update`, `polpo_sync_run`, `polpo_sync_test`, `polpo_sync_disconnect`; R2 keys: dashboard |
| Harnesses | `polpo_harnesses_get` (`test`), `polpo_harness_sessions_list` | `polpo_harnesses_update`, `polpo_harness_session_control`; agents: `polpo_agent_update` `engine`; credentials: dashboard (vault) |

Not exposed yet: storage buckets, app registration and deployments, signing a browser profile in to a site, OAuth apps' client secrets, WhatsApp login (they need the dashboard or a person at the screen).

### admin (off by default)

| Tool | What it does |
|---|---|
| `polpo_api_search` | Find REST operations by words, tag or method (the reference is `/api/v1/openapi.json`). |
| `polpo_api_get` | **Read-only:** call one GET operation with its path parameters and query. Writes, event streams and binary downloads are refused: changes go through the typed tools. |

### Questions and previews

A Polpo turn can stop to ask the person something, or to show something that needs a decision. In the web chat that is a card; over MCP, `polpo_ask` (or `polpo_agent_chat`) returns `status: "needs_input"` and a `pending` item:

| `pending.kind` | What it carries | `polpo_answer` |
|---|---|---|
| `questions` | `questions[]` with ids and options | `answers: [{ question_id, selected?, text? }]` (unanswered questions are left to Polpo) |
| `mission_preview` | `mission: { name, plan }` | `action: execute` (with `confirm: true`), `save_draft`, `refine` (with `feedback`), `cancel` |
| `whatsapp_preview`, `email_preview` | the message | `action: send` (with `confirm: true`), `refine`, `cancel` |
| `vault_preview` | the service and the names of the fields, never the values | `cancel`; the person enters secrets in the dashboard (`dashboard_url`) |

`polpo_answer` does what the web chat does (the same REST calls: create and run the mission, send the email…), then the conversation goes on and Polpo's next reply comes back. The pending item is read from the conversation itself, so it survives between requests; pass `pending_id` to be sure you answer the one you showed. Links Polpo opens in the web chat (a file, a page, a tab) come back as `links`.

### Destructive actions

Actions that cannot be undone need an explicit `confirm: true` (deleting files, executing a mission plan, sending a message); without it the tool explains what would happen and asks to confirm. Clients also ask before tools marked `destructiveHint`.

### Examples

- **Plan and run a mission:** `polpo_mission_create { name: "Launch", tasks: [{ title: "Write copy", description: "…", assignTo: "writer" }, { title: "Review", description: "…", dependsOn: ["Write copy"] }] }` → `polpo_mission_run { id }` → `polpo_mission_wait { id }` (again until `reached: true`) → `polpo_mission_get { id }`.
- **Delegate in words:** `polpo_ask { message: "send the weekly report to the team" }` → `status: "needs_input"`, `pending.kind: "questions"` → ask the person → `polpo_answer { session_id, answers: [{ question_id: "where", selected: ["Slack"] }] }`.
- **Follow a task:** `polpo_task_create { … }` → `polpo_task_wait { id, timeout_seconds: 50 }` → if it failed, `polpo_task_get { id }` (assessment and activity), `polpo_task_update` and `polpo_task_retry`.
- **Rebrand the dashboard:** `polpo_branding_update { product_name: "Shoplix", logo: { url: "https://cdn.example.com/logo.png" } }`.
- **Give everyone a look:** `polpo_branding_update { theme: "light", palette: "claude", tokens: { light: { primary: "#c96442", fontFamily: "\"Inter\", sans-serif" } } }`.
- **Talk to the team in a room:** `polpo_room_post { id, text: "@writer draft the launch post" }` → `polpo_room_wait { id, after_id: message.id }` → the agents' replies.
- **Connect an app:** `polpo_connector_catalog { text: "linear" }` → `polpo_connector_add { catalog_id: "linear", agents: ["pm"] }` → give the person `authorization_url` → `polpo_connectors_list { id: "linear" }`.

### The same tools in Polpo's chat

Polpo itself (web chat, Telegram, WhatsApp) has a counterpart for every tool here: its own tool, or this server's handler run in process under Polpo's name (no `polpo_` prefix: `harnesses_update`, `computer_save`, `branding_update`, `channel_save`, `setup_wait`…), with the same rules, setup links and `confirm`. The less common ones are loaded on demand (progressive tool discovery). The map, with its few exceptions (`polpo_ask`, `polpo_answer`, the REST fallback), is `src/llm/polpo-mcp-bridge.ts`.

## Toolsets

An instance chooses the toolsets it offers:

- **`settings.mcp.toolsets`** in `.polpo/polpo.json`, e.g. `{ "settings": { "mcp": { "toolsets": ["default", "admin"] } } }`;
- **`POLPO_MCP_TOOLSETS`** in the environment (comma-separated; it wins over the settings).

Values: toolset names (`core`, `tasks`, `missions`, `artifacts`, `data`, `files`, `team`, `config`, `rooms`, `chat`, `memory`, `skills`, `automation`, `connectors`, `channels`, `computers`, `settings`, and, off by default, `brain`, `learning`, `watchers`, `vault`, `apps`, `admin`), `default` (the toolsets on by default, about 180 tools for a full-access client (178 today)) or `all`. Without either, the default toolsets are offered.

For example, the defaults plus the company brain and the vault: `POLPO_MCP_TOOLSETS=default,brain,vault`.

For example, an instance that only lets clients follow work: `POLPO_MCP_TOOLSETS=core,tasks,missions`.

A connector URL can narrow them further, never widen them: `https://<host>/mcp?toolsets=core,tasks`.

## Who acts, and scopes

What a client does through MCP is recorded as the authenticated principal, in events (`by`), approvals (`resolvedBy`) and artifacts (`createdBy`):

| Connected with | Recorded as |
|---|---|
| OAuth, allowed by a person signed in to the dashboard | `ada@example.com via Claude` (the person and the client's name) |
| OAuth, allowed with the API or MCP key | `Claude (MCP key)` |
| The API key or `POLPO_MCP_KEY` directly | `mcp-key` |
| A named key from `settings.mcp.keys` | `mcp-key:<name>` |
| A dashboard session | the person's email |
| A server without auth (localhost) | `mcp` |

Events caused through MCP also carry the scopes the caller acted under (`scopes`, next to `by` and `source`), and the server log names them on every MCP message.

## Scopes

Every tool needs one scope. There are three levels and five areas:

- **`polpo:read`** — see things. Every connection has it.
- **`polpo:work`** — do the day-to-day work: ask Polpo, chat with agents, tasks, missions, artifacts, data views and rows, rooms, memory, schedules and checks, approvals.
- **Areas**, one capability each, given on their own or on top of work: **`polpo:files`** (write, move, delete files), **`polpo:messages`** (send on Telegram, WhatsApp, email), **`polpo:connectors`**, **`polpo:computers`** (they cost money), **`polpo:vault`** (entry names, never values; reads too).
- **`polpo:admin`** — change the instance itself (team, settings, data sources and who may use them, skills, notification rules, learning, the read-only REST fallback). It includes work and every area.

Any scope includes read; a destructive tool (⚠ below) needs the write scope of its area. A connection is offered only the tools its scopes allow (`tools/list` hides the others). Calling a hidden tool anyway gets a `403` with `WWW-Authenticate: Bearer error="insufficient_scope", scope="<the scopes it has plus the one it needs>", resource_metadata="…"` and a JSON-RPC error that names the missing scope, so an OAuth client can ask the person for more (step-up) and retry.

The matrix, generated from the code (`node scripts/generate-mcp-scopes.mjs`; a test keeps it in sync):

<!-- scope-matrix:start (generated: node scripts/generate-mcp-scopes.mjs) -->
| Scope | What it allows | Tools |
| --- | --- | --- |
| `polpo:read` | See tasks, missions, artifacts, data, files, agents, rooms, chats, memory, schedules, connectors, computers and settings | `polpo_search`, `polpo_search_ask`, `polpo_agents_list`, `polpo_agent_show`, `agent_card_refresh`, `polpo_approvals_list`, `polpo_tasks_list`, `polpo_task_get`, `polpo_task_wait`, `polpo_task_logs`, `polpo_missions_list`, `polpo_mission_get`, `polpo_mission_wait`, `polpo_playbooks_list`, `polpo_task_show`, `polpo_mission_show`, `polpo_artifacts_list`, `polpo_artifact_get`, `polpo_data_sources_list`, `polpo_data_query`, `polpo_data_source_get`, `polpo_data_source_test`, `polpo_data_activity`, `polpo_data_sql`, `polpo_data_views_list`, `polpo_data_view_get`, `polpo_files_list`, `polpo_files_search`, `polpo_file_read`, `polpo_agent_get`, `polpo_agent_versions`, `polpo_agent_version_get`, `polpo_agent_version_diff`, `polpo_agent_deploys`, `polpo_teams_list`, `polpo_config_get`, `polpo_branding_get`, `polpo_providers_list`, `polpo_models_list`, `polpo_sandbox_get`, `polpo_policies_get`, `polpo_sync_status`, `polpo_custom_providers_list`, `polpo_channel_routes_list`, `polpo_setup_wait`, `polpo_rooms_list`, `polpo_room_messages`, `polpo_room_wait`, `polpo_chat_sessions_list`, `polpo_chat_messages`, `polpo_memory_get`, `polpo_skills_list`, `polpo_skill_get`, `polpo_skill_upload_prepare`, `polpo_skill_files`, `polpo_skill_file_read`, `polpo_skill_versions`, `polpo_skill_version_diff`, `polpo_schedules_list`, `polpo_checks_list`, `polpo_connectors_list`, `polpo_connector_catalog`, `polpo_channels_list`, `polpo_brain_search`, `polpo_brain_get`, `polpo_learning_get`, `polpo_watchers_list`, `polpo_apps_list`, `polpo_browser_profiles_list`, `polpo_computers_list`, `polpo_computer_get`, `polpo_egress_status`, `polpo_wabiz_status`, `polpo_wabiz_events`, `polpo_wabiz_templates`, `polpo_wabiz_conversation`, `polpo_harnesses_get`, `polpo_harness_sessions_list` |
| `polpo:work` | Ask Polpo and chat with agents; create, change, run and stop tasks, missions, artifacts, data views and rows, rooms, memory, schedules and checks; resolve approvals | `polpo_ask`, `polpo_agent_chat`, `polpo_answer` ⚠, `agent_intention_decide` ⚠, `polpo_approval_resolve` ⚠, `polpo_task_create`, `polpo_task_update`, `polpo_task_retry`, `polpo_task_kill` ⚠, `polpo_task_delete` ⚠, `polpo_task_direct`, `polpo_mission_create`, `polpo_mission_update`, `polpo_mission_run`, `polpo_mission_abort` ⚠, `polpo_mission_delete` ⚠, `polpo_playbook_run`, `polpo_artifact_create`, `polpo_artifact_update`, `polpo_data_mutate` ⚠, `polpo_data_view_save`, `polpo_data_view_delete` ⚠, `polpo_room_create`, `polpo_room_update`, `polpo_room_delete` ⚠, `polpo_room_post`, `polpo_chat_session_update`, `polpo_chat_session_delete` ⚠, `polpo_memory_update` ⚠, `polpo_schedule_create`, `polpo_schedule_update`, `polpo_schedule_delete` ⚠, `polpo_schedule_run`, `polpo_check_create`, `polpo_check_update`, `polpo_check_cancel` ⚠, `polpo_check_delete` ⚠, `polpo_brain_save`, `polpo_brain_delete` ⚠, `polpo_watcher_create`, `polpo_watcher_delete` ⚠, `polpo_app_control` ⚠, `polpo_browser_profile_clear` ⚠, `polpo_harness_session_control` ⚠ |
| `polpo:files` | Write, move and delete the instance's files | `polpo_file_write` ⚠, `polpo_file_manage` ⚠ |
| `polpo:messages` | Send messages on Telegram, WhatsApp and email, as Polpo or an agent | `polpo_channel_test`, `polpo_message_send` ⚠, `polpo_wabiz_send` ⚠, `polpo_wabiz_send_template` ⚠, `polpo_wabiz_approval` ⚠ |
| `polpo:connectors` | Add, change, connect, disconnect and remove connectors (the services agents use) | `polpo_connector_add`, `polpo_connector_update`, `polpo_connector_test`, `polpo_connector_connect`, `polpo_connector_disconnect` ⚠, `polpo_connector_remove` ⚠ |
| `polpo:computers` | Create, start, stop, reset and delete computers (they may cost money) | `polpo_computer_webhooks`, `polpo_computer_save`, `polpo_computer_control` ⚠, `polpo_computer_delete` ⚠ |
| `polpo:vault` | See the names of vault entries (never their values) and delete them | `polpo_vault_list`, `polpo_vault_delete` ⚠ |
| `polpo:admin` | Change the instance itself: agents and teams, settings and branding, data sources and who may use them, skills, channels and their rules, learning, the read-only REST fallback; includes every scope above | `polpo_data_source_save`, `polpo_data_source_delete` ⚠, `polpo_agent_create`, `polpo_agent_update`, `polpo_agent_publish`, `polpo_agent_deploy` ⚠, `polpo_agent_rollback` ⚠, `polpo_agent_delete` ⚠, `polpo_agent_avatar_set`, `polpo_team_save`, `polpo_team_delete` ⚠, `polpo_config_update`, `polpo_branding_update`, `polpo_sandbox_update`, `polpo_sandbox_provider_test`, `polpo_policies_update`, `polpo_approval_gate_save`, `polpo_approval_gate_delete` ⚠, `polpo_members_list`, `polpo_members_invite`, `polpo_members_remove` ⚠, `polpo_mcp_access_list`, `polpo_mcp_grant_revoke` ⚠, `polpo_sync_update`, `polpo_sync_disconnect` ⚠, `polpo_sync_test`, `polpo_sync_run` ⚠, `polpo_custom_provider_save`, `polpo_custom_provider_remove` ⚠, `polpo_provider_disconnect` ⚠, `polpo_channel_save`, `polpo_channel_remove` ⚠, `polpo_channel_route_set`, `polpo_telegram_verify`, `polpo_channel_invite`, `polpo_channel_peers`, `polpo_channel_allowlist` ⚠, `polpo_channel_pairing`, `polpo_whatsapp_login`, `polpo_whatsapp_login_wait`, `polpo_whatsapp_logout` ⚠, `polpo_skill_create`, `polpo_skill_update`, `polpo_skill_install`, `polpo_skill_delete` ⚠, `polpo_skill_assign`, `polpo_skill_upload_finalize` ⚠, `polpo_skill_restore` ⚠, `polpo_notification_rule_save`, `polpo_notification_rule_delete` ⚠, `polpo_learning_review`, `polpo_learning_revert` ⚠, `polpo_harnesses_update`, `polpo_api_search`, `polpo_api_get` |
<!-- scope-matrix:end -->

`polpo_ask` (work) hands a request to Polpo itself, which acts with its own tools and asks for a preview or an approval before risky changes; give a connection `polpo:work` only if you are fine with Polpo acting on its requests.

### Which connection gets which scopes

| Connection | Scopes |
|---|---|
| OAuth (Claude, ChatGPT, Claude Code…) | what the person allowed on the consent page; a client that asks for nothing in particular is offered read and work |
| The server's API key, a dashboard session, a server without auth | every scope |
| `POLPO_MCP_KEY` | `POLPO_MCP_KEY_SCOPES` (space-separated), or every scope when it is not set (as before scopes existed; the server logs a warning) |
| A named key in `settings.mcp.keys` | its `scopes`, default read and work |

Named keys keep their value in the vault: create a vault entry with a field `key` (or `apiKey`, `token`), then reference it:

```json
{ "settings": { "mcp": { "keys": [
  { "name": "ci", "keyRef": { "owner": "ops", "service": "mcp-ci" }, "scopes": ["polpo:read"] },
  { "name": "assistant", "keyRef": { "owner": "ops", "service": "mcp-assistant" }, "scopes": ["polpo:work", "polpo:files"] }
] } } }
```

To narrow the legacy key, set for example `POLPO_MCP_KEY_SCOPES="polpo:read polpo:work"` and restart. A client allowed on the consent page with a key gets at most that key's scopes.

**The old `polpo` scope (deprecated).** Tokens issued before scopes carry `polpo`, which still means every scope: connectors already connected keep working as they are. The consent page never issues it any more (a client that asks for it is offered every box, which the person can uncheck); metadata documents list only the scopes above. To narrow an old connection, revoke it on Settings → MCP access and connect again.

The dashboard's **Settings → MCP access** lists the OAuth grants (client, who allowed it, scopes, created, last used) with Revoke, and the MCP keys with their scopes (names only, never values).

## The agent card (MCP App)

In hosts that show [MCP Apps](https://modelcontextprotocol.io/extensions/apps/overview) (Claude on the web, Desktop and mobile; ChatGPT; VS Code), `polpo_agent_show` renders an interactive card in the conversation. Ask, for example, "how is the health coach doing?".

- **Inline:** whether the agent is working, the task at hand, today's results, what it plans next and its main goal. **Open** goes full screen; **Ask for an update** writes a message in the chat, so the model asks the agent.
- **Full screen:** tabs for overview, tasks, goals and routine; the agent's proposed intentions can be confirmed or cancelled there.

The card is a `ui://polpo/agent-card.html` resource: one HTML document that loads nothing from elsewhere, styled with the host's variables. Its own tools (`agent_card_refresh`, `agent_intention_decide`) are visible only to the card, not to the model. Hosts ask the person before showing an app the first time.

Claude reads the apps of a connector when it is connected: after updating Polpo to a version with new or changed apps, disconnect and connect the connector again (Settings → Connectors), or the tool answers with text only.

The widget's source is in `widgets/agent-card/`; after changing it, run `pnpm run build:widgets` (a test checks the generated module is up to date).

## The task and mission cards (MCP App)

`polpo_task_show` and `polpo_mission_show` render interactive cards in the same hosts. Ask, for example, "why did the report task fail?" or "how much has the launch mission cost?".

- **Task card:** its status and agent; why it failed (the labelled reason, its kind, and **Not retried** when a re-run would fail the same way); the latest run with the official marks of its engine (Polpo, Claude Code, Codex, OpenCode), its model, how the harness authenticated (Anthropic or OpenAI API key, Amazon Bedrock, Google Vertex AI), the computer (this server, Daytona, E2B, an ephemeral sandbox) and its cost against the run's budget; **Tools restricted** and what its runs get when the task narrows the agent's tools (`toolScope`, connectors named with their accounts, and what the agent no longer has); the tasks it depends on with their status. Full screen adds every run (egress, Tailscale, harness session, duration), its result and outcomes.
- **Mission card:** its status (paused by its budget), what it cost so far against its budget as a bar (red when over), the cost by engine (with their marks) and, full screen, by agent; its tasks with the engine and model of their latest run, their cost, a **Tools restricted** badge and why they failed (failed ones first).
- **Actions:** Open (full screen), Ask about it (a message in the chat, so the model follows up) and Refresh (the card calls its show tool again).

Both are one `ui://polpo/work-card.html` resource: one HTML document that loads nothing from elsewhere (the brand marks are inline SVG, Daytona's and E2B's as data URIs). Several cards of the same task or mission in a conversation: the newest stays live, older ones grey out.

The widgets' source is in `widgets/` (`agent-card/`, `work-card/`, `shared/` for the brand marks); after changing it, run `pnpm run build:widgets`.

## Setup

### Claude Code

```bash
claude mcp add --transport http polpo https://<your-polpo-host>/mcp --header "Authorization: Bearer <your-api-key>"
```

### OpenAI Codex

In `~/.codex/config.toml` (or `.codex/config.toml` in a trusted project):

```toml
[mcp_servers.polpo]
url = "https://<your-polpo-host>/mcp"
bearer_token_env_var = "POLPO_API_KEY"
```

Then export `POLPO_API_KEY` before starting Codex.

### Claude Desktop (local configuration)

In `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "polpo": {
      "command": "polpo",
      "args": ["mcp", "--url", "https://<your-polpo-host>"],
      "env": { "POLPO_API_KEY": "<your-api-key>" }
    }
  }
}
```

### Cursor and other clients with HTTP and headers

```json
{
  "mcpServers": {
    "polpo": {
      "url": "https://<your-polpo-host>/mcp",
      "headers": { "Authorization": "Bearer <your-api-key>" }
    }
  }
}
```

### Claude (web, Desktop, mobile) and ChatGPT as custom connectors

These connect with OAuth: you add the connector by URL and allow it on a Polpo consent page.

- **Claude:** Settings → Connectors → Add custom connector, URL `https://<your-polpo-host>/mcp`.
- **ChatGPT:** Settings → Apps → Advanced settings → Developer mode, then Create app with the same URL and OAuth.

The client discovers everything from the `401` it gets at first, so there is nothing else to configure:

1. The `401` points to the protected resource metadata (RFC 9728).
2. That names Polpo as the authorization server (RFC 8414 metadata).
3. The client registers itself, with a Client ID Metadata Document or Dynamic Client Registration.
4. It sends you to Polpo's consent page.

On the consent page you choose what the app may do (read always; work, files, messages, connectors, computers, vault, admin — the ones it asked for are checked, read and work when it asked for nothing in particular), then allow it:
- if you are signed in to the dashboard, with one click;
- otherwise by entering the server's API key or an MCP key (the app then gets at most that key's scopes).

Polpo then issues an access token (1 hour) and a refresh token (30 days, rotated at every use), with the scopes you allowed (the token response's `scope`). Tokens are stored hashed in `.polpo/oauth.json`. To disconnect an app, revoke it on Settings → MCP access (or call `/oauth/revoke`).

**Reachability:** Claude's and ChatGPT's servers must reach your Polpo over public HTTPS. An instance behind Tailscale serve is only reachable on your tailnet: use Tailscale Funnel or a reverse proxy with a public hostname (see below). Polpo takes the public URL from the `X-Forwarded-Host` and `X-Forwarded-Proto` headers; set `POLPO_PUBLIC_URL` when the proxy does not send them or mounts Polpo under a path. Claude Code is a local app, so it can sign in with OAuth over the tailnet too.

## Publishing only the connector

An instance can make its connector public and keep the dashboard and REST API private. The public paths are `/mcp`, `/oauth/…` and the discovery documents under `/.well-known/`:

1. **Set an MCP key.** `POLPO_MCP_KEY=<a long random secret>` in the server's environment. It opens `/mcp` and the consent page, and it does not put an API key on the dashboard. A server with no key at all must never be public.
2. **Publish only those paths.** With Tailscale Funnel, for an instance on port 3000 mounted under `/shoplix`:

   ```bash
   tailscale funnel --bg --set-path /shoplix/mcp http://127.0.0.1:3000/mcp
   tailscale funnel --bg --set-path /shoplix/oauth http://127.0.0.1:3000/oauth
   tailscale funnel --bg --set-path /shoplix/.well-known/oauth-protected-resource http://127.0.0.1:3000/.well-known/oauth-protected-resource
   tailscale funnel --bg --set-path /shoplix/.well-known/oauth-authorization-server http://127.0.0.1:3000/.well-known/oauth-authorization-server
   tailscale funnel --bg --set-path /.well-known/oauth-authorization-server/shoplix http://127.0.0.1:3000/.well-known/oauth-authorization-server
   tailscale funnel --bg --set-path /.well-known/oauth-protected-resource/shoplix/mcp http://127.0.0.1:3000/.well-known/oauth-protected-resource/mcp
   ```

   The last two answer the discovery URLs that clients build at the root of the host for an issuer with a path (RFC 8414 and RFC 9728).
3. **Tell Polpo its public URL.** `POLPO_PUBLIC_URL=https://<host>.ts.net/shoplix`. It applies to requests that come through that host; the same instance on the tailnet, on its own port, keeps its own URL.

The connector URL is then `https://<host>.ts.net/shoplix/mcp`. On the consent page, enter the MCP key.

Because these endpoints are public:
- open client registration is capped (200 clients; clients that hold tokens are kept);
- client metadata documents are fetched only from public addresses, never from the server's own network.

## Security

- The API key gives the same access as the REST API, and so does `POLPO_MCP_KEY` unless `POLPO_MCP_KEY_SCOPES` narrows it: keep keys secret, never put them in a URL, and give each client the fewest scopes it needs (named keys, the consent page).
- Every tool goes through the server's own API, with the same checks as the dashboard. There is no generic write tool: every change is a typed tool with its own validation and annotations, and the read-only REST fallback (`polpo_api_get`) is off unless the admin toolset is turned on.
- Secrets (vault entries, provider keys) never pass through MCP: the tools return a link to the dashboard page where the person enters them.
- Serve Polpo over HTTPS when you expose it beyond localhost (for example with Tailscale or a reverse proxy).
