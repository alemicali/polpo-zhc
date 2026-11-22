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
| `polpo_agents_list` | The agents. |
| `polpo_agent_show` | An agent's card: in Claude and ChatGPT an interactive card (see below), elsewhere text. |
| `polpo_approvals_list`, `polpo_approval_resolve` | Decide on requests that wait for a person. |

### tasks (on by default)

| Tool | What it does | Annotations |
|---|---|---|
| `polpo_tasks_list` | Tasks by status, agent, mission, group or words; paged. | read-only |
| `polpo_task_get` | One task: description, result and assessment, outcomes, timestamps, dependencies and its latest activity. | read-only |
| `polpo_task_create` | Give an agent a task (title, description, `assignTo`, `dependsOn`, group, expectations, retries, duration, side effects, draft). `dependsOn` takes ids of existing tasks: an unknown id is refused (it would keep the task pending for ever). | write |
| `polpo_task_update` | Change the description, agent, retries or side-effects flag, or start a draft; returns what changed. | write, idempotent |
| `polpo_task_retry` | Run a failed task again. | write |
| `polpo_task_kill` | Stop a running or waiting task (`confirm: true`). | destructive |
| `polpo_task_delete` | Delete a task and its result for good (`confirm: true`); a running task is stopped first with `polpo_task_kill`. | destructive |
| `polpo_task_direct` | Steer a running task, add a follow-up, or continue a finished one. | write |
| `polpo_task_wait` | Wait until a task is done, failed, in review or waiting for approval (or given statuses), at most 55 s; returns its state, so call again to keep waiting. | read-only |
| `polpo_task_logs` | The activity of the task's runs, newest first, paged backwards. | read-only |

### missions (on by default)

| Tool | What it does | Annotations |
|---|---|---|
| `polpo_missions_list`, `polpo_mission_get` | Missions; one with its plan, its tasks and their status counts. | read-only |
| `polpo_mission_create` | A mission from a structured plan (tasks with `assignTo` and `dependsOn` by title; checkpoints, delays, quality gates), validated as the executor will; a draft, or started with `run: true`. | write |
| `polpo_mission_update` | Rename, or replace its tasks, checkpoints, delays or quality gates (not while it runs). | write, idempotent |
| `polpo_mission_run` | Start a draft, scheduled or finished mission, or resume a paused one. | write, open world |
| `polpo_mission_abort` | Stop a running mission and its unfinished tasks (`confirm: true`; without it, it says what would stop). | destructive |
| `polpo_mission_delete` | Delete a mission, its schedule and its tasks for good (`confirm: true`); a running mission is aborted first. | destructive |
| `polpo_mission_wait` | Wait until it is completed, failed, cancelled or paused, at most 55 s; returns the status and task counts. A scheduled or recurring mission never completes: the wait is reached when its current (or latest) run has finished (every task of that run done or failed), with `run: { number, outcome: "completed" \| "failed", task_counts }`; one that never ran keeps waiting for its first run. | read-only |
| `polpo_playbooks_list`, `polpo_playbook_run` | Reusable mission templates, run with their parameters. | read-only / write |

`polpo_task_wait` and `polpo_mission_wait` send `notifications/progress` when the client passes a `progressToken`: that request is then answered as an event stream.

### team and config (on by default; changes need `polpo:admin`)

| Tool | What it does | Annotations |
|---|---|---|
| `polpo_agent_get` | An agent's configuration: role, model, instructions, tools, skills, identity. | read-only |
| `polpo_agent_create`, `polpo_agent_update` | Add an agent, or change its role, model, instructions, tools, skills, identity, manager or browser egress proxy (`browserEgress`, a name from the settings' egress proxies). `computers: null` (or `[]`) clears its list of computers. | write |
| `polpo_agent_delete` | Remove an agent (`confirm: true`). | destructive |
| `polpo_agent_avatar_set` | An agent's picture, from a public https URL, a file of the instance or base64 (checked by its bytes); `remove: true` removes it. | write, idempotent |
| `polpo_teams_list` | The teams and their agents. | read-only |
| `polpo_team_save` | Create a team, rename it (`new_name`), move agents into it (`add_agents`). | write |
| `polpo_team_delete` | Delete an empty team (`confirm: true`). | destructive |
| `polpo_config_get` | Settings (Polpo's model and fallbacks, image model, reasoning, retries, egress proxies without credentials…), branding, and a summary of notification channels, rules and approval gates. Never secrets. | read-only |
| `polpo_config_update` | Polpo's model (and fallbacks), the image model, the reasoning level, the egress proxies agents' browsers can use (`egress_proxies`: `{ name: "socks5://host:port" }`, `null` removes them); models are checked against the catalog. Returns what changed. | write, idempotent |
| `polpo_branding_get`, `polpo_branding_update` | Product name, tagline and logo. The logo comes from a public https URL (fetched by the server: never from private addresses, also after redirects; at most 4 MB), a file of the instance, or base64 data; PNG, JPEG, WebP or GIF, checked by its bytes. | read-only / write, idempotent |
| `polpo_providers_list`, `polpo_models_list` | LLM providers (with or without a key) and the model catalog (`provider:model`). | read-only |

**Provider API keys never go through MCP.** `polpo_providers_list` returns `setup_url`, the dashboard's Providers page, where the person enters the key. (The dashboard's colours and theme are chosen in each browser, so they are not part of the instance's branding.)

### artifacts, data, files (on by default)

| Tool | What it does |
|---|---|
| `polpo_artifacts_list`, `polpo_artifact_get`, `polpo_artifact_create` | Documents, html dashboards and designs, diagrams. |
| `polpo_data_sources_list`, `polpo_data_query` | Structured data. |
| `polpo_files_list`, `polpo_files_search`, `polpo_file_read` | Browse and read the instance's files (the agents' workspace, `.polpo`, volumes): text by line ranges, images and PDFs as they are. |
| `polpo_file_write`, `polpo_file_manage` | Create a file (text or base64; replacing one needs `overwrite: true`), make folders, rename, delete (`confirm: true`). |

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
| `polpo_skill_delete` | Remove a skill from the pool (`confirm: true`). | destructive |

### automation (on by default)

| Tool | What it does | Annotations |
|---|---|---|
| `polpo_schedules_list` | Scheduled missions (cron or a time, paused or not, next and last run); with `mission_id`, its recent runs' tasks. | read-only |
| `polpo_schedule_create`, `polpo_schedule_update` | Schedule a mission; change the expression, recurring, end date; pause (`enabled: false`) or resume (`enabled: true`). The expression is checked first: a cron with a value out of range (e.g. `99 99 * * *`) or a past time is refused with the reason. | write / write, idempotent |
| `polpo_schedule_run` | Run a scheduled mission now (the next scheduled run stays; a paused schedule stays paused). | write, open world |
| `polpo_schedule_delete` | Remove the schedule; the mission stays as a draft (`confirm: true`). | destructive |
| `polpo_checks_list` | Recurring checks and reminders: what Polpo or an agent does on a schedule and reports in a chat; proposed ones wait for a yes. | read-only |
| `polpo_check_create` | Instructions or a fixed message, every N minutes, on a cron (in a timezone) or once; reports to a chat session and, with `to`, a Telegram chat. Recorded as created by the principal. | write |
| `polpo_check_update` | Change the instructions, message, schedule or limits; `confirm: true` approves a proposed check. | write, idempotent |
| `polpo_check_cancel` | Stop a check for good (`confirm: true`); it stays listed as cancelled. | destructive |
| `polpo_check_delete` | Delete a check's record (cancelled, ended or still active: it stops first; `confirm: true`). Its reports stay in their chat. | destructive |

### connectors (on by default; changes need `polpo:admin`)

| Tool | What it does | Annotations |
|---|---|---|
| `polpo_connectors_list` | Connectors with their status, auth (authorized? token set?), tool count and who may use them; with `id`, its tools and their policy. Never secrets. | read-only |
| `polpo_connector_catalog` | Well-known remote MCP servers to add in one step, and what each needs. | read-only |
| `polpo_connector_add` | Add from the catalog or a remote https URL (never a local process). OAuth ones return `authorization_url` for the person to open; token-based ones are finished in the dashboard (`setup_url`). | write, open world |
| `polpo_connector_update` | Who may use it (agents, Polpo), on or off, name, per-tool policy (`allow`, `ask`, `off`). | write, idempotent |
| `polpo_connector_test` | Connect now and list its tools. | write, idempotent, open world |
| `polpo_connector_connect` | A fresh OAuth link (new, or `needs_reauth`). | write, open world |
| `polpo_connector_disconnect`, `polpo_connector_remove` | Sign it out (tokens revoked), or delete it with its secrets (`confirm: true`). | destructive |

**Connector secrets never go through MCP**: there is no parameter for a token, a header value or an OAuth app's client secret. The person enters them on the dashboard's Connectors page (`setup_url`).

### channels (on by default; channel and rule changes need `polpo:admin`, sending `polpo:work`)

| Tool | What it does | Annotations |
|---|---|---|
| `polpo_channels_list` | Notification channels (name and type, never their tokens) and rules, the Telegram bots and the groups, topics and people they reach, WhatsApp profiles. | read-only |
| `polpo_channel_test` | Send a test notification on a channel. | write, open world |
| `polpo_message_send` | Send now on Telegram (with files), WhatsApp (text or a file) or email (with the agent's mail account and attachments), as Polpo or an agent. Without `confirm: true` it shows what it would send. | destructive, open world |
| `polpo_notification_rule_save`, `polpo_notification_rule_delete` | Create or replace a rule (events → channels, severity, template, cooldown); delete one (`confirm: true`). | write, idempotent / destructive |

Bot tokens, SMTP passwords and API keys are set up in the dashboard (`setup_url`), never through MCP.

### computers (on by default; changes need `polpo:admin`)

Computers are persistent machines agents work on (Daytona or E2B; see `docs/computers.md`).

| Tool | What it does | Annotations |
|---|---|---|
| `polpo_computers_list` | "host" (this server) and each computer with its live status (running, stopped, paused, hibernated, archived, creating, error; missing = not created yet), last use, uptime, last snapshot and the agents using it; with `id`, one computer. | read-only |
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
| `vault` (needs `polpo:admin`, also to read) | `polpo_vault_list` (each agent's entries: service, type, label and the names of the fields, never values; `setup_url` to add or change one), `polpo_vault_delete` (`confirm: true`; not entries shared from another agent) | read-only / destructive |
| `apps` | `polpo_apps_list` (services, whether they run, URLs, deployments, domains), `polpo_app_control` (start; stop and restart need `confirm: true`), `polpo_browser_profiles_list`, `polpo_browser_profile_clear` (`confirm: true`) | read-only / destructive |

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
- **Talk to the team in a room:** `polpo_room_post { id, text: "@writer draft the launch post" }` → `polpo_room_wait { id, after_id: message.id }` → the agents' replies.
- **Connect an app:** `polpo_connector_catalog { text: "linear" }` → `polpo_connector_add { catalog_id: "linear", agents: ["pm"] }` → give the person `authorization_url` → `polpo_connectors_list { id: "linear" }`.

## Toolsets

An instance chooses the toolsets it offers:

- **`settings.mcp.toolsets`** in `.polpo/polpo.json`, e.g. `{ "settings": { "mcp": { "toolsets": ["default", "admin"] } } }`;
- **`POLPO_MCP_TOOLSETS`** in the environment (comma-separated; it wins over the settings).

Values: toolset names (`core`, `tasks`, `missions`, `artifacts`, `data`, `files`, `team`, `config`, `rooms`, `chat`, `memory`, `skills`, `automation`, `connectors`, `channels`, `computers`, and, off by default, `brain`, `learning`, `watchers`, `vault`, `apps`, `admin`), `default` (the toolsets on by default, about 95 tools) or `all`. Without either, the default toolsets are offered.

For example, the defaults plus the company brain and the vault: `POLPO_MCP_TOOLSETS=default,brain,vault`.

For example, an instance that only lets clients follow work: `POLPO_MCP_TOOLSETS=core,tasks,missions`.

A connector URL can narrow them further, never widen them: `https://<host>/mcp?toolsets=core,tasks`.

## Who acts, and scopes

What a client does through MCP is recorded as the authenticated principal, in events (`by`), approvals (`resolvedBy`) and artifacts (`createdBy`):

| Connected with | Recorded as |
|---|---|
| OAuth, allowed by a person signed in to the dashboard | `ada@example.com via Claude` (the person and the client's name) |
| OAuth, allowed with the API or MCP key | `Claude (MCP key)` |
| The API key or the MCP key directly | `mcp-key` |
| A dashboard session | the person's email |
| A server without auth (localhost) | `mcp` |

Every tool also needs a scope: reads `polpo:read`, writes `polpo:work`; changes to the team, the configuration, skills, connectors, channels and rules, computers, learning, and the `vault` and `admin` toolsets (reads too), `polpo:admin`. Sending a message (`polpo_message_send`) needs `polpo:work`. Tokens issued today carry `polpo`, which grants all of them, as do the API and MCP keys; a principal with fewer scopes is offered fewer tools.

## The agent card (MCP App)

In hosts that show [MCP Apps](https://modelcontextprotocol.io/extensions/apps/overview) (Claude on the web, Desktop and mobile; ChatGPT; VS Code), `polpo_agent_show` renders an interactive card in the conversation. Ask, for example, "how is the health coach doing?".

- **Inline:** whether the agent is working, the task at hand, today's results, what it plans next and its main goal. **Open** goes full screen; **Ask for an update** writes a message in the chat, so the model asks the agent.
- **Full screen:** tabs for overview, tasks, goals and routine; the agent's proposed intentions can be confirmed or cancelled there.

The card is a `ui://polpo/agent-card.html` resource: one HTML document that loads nothing from elsewhere, styled with the host's variables. Its own tools (`agent_card_refresh`, `agent_intention_decide`) are visible only to the card, not to the model. Hosts ask the person before showing an app the first time.

Claude reads the apps of a connector when it is connected: after updating Polpo to a version with new or changed apps, disconnect and connect the connector again (Settings → Connectors), or the tool answers with text only.

The widget's source is in `widgets/agent-card/`; after changing it, run `pnpm run build:widgets` (a test checks the generated module is up to date).

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

On the consent page you allow the app:
- if you are signed in to the dashboard, with one click;
- otherwise by entering the server's API key.

Polpo then issues an access token (1 hour) and a refresh token (30 days, rotated at every use). Tokens are stored hashed in `.polpo/oauth.json`; delete a client's tokens there, or call `/oauth/revoke`, to disconnect it.

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

- The API key and the MCP key give the same access as the REST API: keep them secret, and never put them in a URL.
- Every tool goes through the server's own API, with the same checks as the dashboard. There is no generic write tool: every change is a typed tool with its own validation and annotations, and the read-only REST fallback (`polpo_api_get`) is off unless the admin toolset is turned on.
- Secrets (vault entries, provider keys) never pass through MCP: the tools return a link to the dashboard page where the person enters them.
- Serve Polpo over HTTPS when you expose it beyond localhost (for example with Tailscale or a reverse proxy).
