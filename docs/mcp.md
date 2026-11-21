# Polpo as an MCP connector

Every Polpo server is also an [MCP](https://modelcontextprotocol.io) server. Claude Code, Codex, Claude Desktop, Cursor and any other MCP client can use your instance: ask Polpo to do things (and answer its questions and previews), chat with agents, follow tasks and missions, read data, read and write files, make artifacts and approve requests.

- **Endpoint:** `https://<your-polpo-host>/mcp` (Streamable HTTP, stateless).
- **Authentication:** your Polpo API key, as `Authorization: Bearer <key>` (or `X-API-Key: <key>`), or the MCP key (`POLPO_MCP_KEY`, below), or OAuth (a sign-in) for Claude and ChatGPT connectors. A server started without any API key, MCP key or login accepts calls without one: never make such a server reachable from the internet.
- **Local process instead of a URL:** `polpo mcp --url <server> --api-key <key>` runs the same tools (and the agent card) over stdio and forwards them to the server.

## Tools

The connector exposes tools designed for what people do, rather than one tool per endpoint. They are named `polpo_<area>_<verb>` (the same vocabulary as the hosted Polpo Cloud connector) and grouped in **toolsets**.

Every tool has a title and honest annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`), described parameters, and, when it returns data, an `outputSchema` with `structuredContent` plus a short text for the model. Lists take `limit` and `cursor` and return `next_cursor`. Errors come back as `isError` results that say what to do next.

### core (on by default)

| Tool | What it does |
|---|---|
| `polpo_ask` | Ask Polpo in natural language: it can do anything the instance can. Returns `{ status, reply, session_id, pending? }`; pass `session_id` to continue the conversation. |
| `polpo_agent_chat` | Talk to one agent, with its tools, memory and skills; same result. |
| `polpo_answer` | Answer what a turn stopped for (`status: "needs_input"`): Polpo's questions, a mission plan to execute, save as draft, refine or cancel, a WhatsApp message or an email to send, refine or cancel. |
| `polpo_agents_list` | The agents. |
| `polpo_agent_show` | An agent's card: in Claude and ChatGPT an interactive card (see below), elsewhere text. |
| `polpo_approvals_list`, `polpo_approval_resolve` | Decide on requests that wait for a person. |

### tasks, missions, artifacts, data, files (on by default)

| Tool | What it does |
|---|---|
| `polpo_tasks_list`, `polpo_task_get`, `polpo_task_create` | Follow and create tasks (filter by status, agent, words). |
| `polpo_missions_list`, `polpo_mission_get` | Missions and their plans. |
| `polpo_artifacts_list`, `polpo_artifact_get`, `polpo_artifact_create` | Documents, html dashboards and designs, diagrams. |
| `polpo_data_sources_list`, `polpo_data_query` | Structured data. |
| `polpo_files_list`, `polpo_files_search`, `polpo_file_read` | Browse and read the instance's files (the agents' workspace, `.polpo`, volumes): text by line ranges, images and PDFs as they are. |
| `polpo_file_write`, `polpo_file_manage` | Create a file (text or base64; replacing one needs `overwrite: true`), make folders, rename, delete (`confirm: true`). |

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

## Toolsets

An instance chooses the toolsets it offers:

- **`settings.mcp.toolsets`** in `.polpo/polpo.json`, e.g. `{ "settings": { "mcp": { "toolsets": ["default", "admin"] } } }`;
- **`POLPO_MCP_TOOLSETS`** in the environment (comma-separated; it wins over the settings).

Values: toolset names (`core`, `tasks`, `missions`, `artifacts`, `data`, `files`, `admin`), `default` (every toolset except `admin`) or `all`. Without either, the default toolsets are offered.

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

Every tool also needs a scope: reads `polpo:read`, writes `polpo:work`, the admin toolset `polpo:admin`. Tokens issued today carry `polpo`, which grants all of them, as do the API and MCP keys; a principal with fewer scopes is offered fewer tools.

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
