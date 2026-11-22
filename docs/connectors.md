# Connectors: external apps over MCP

Connectors link a Polpo workspace to the apps people already use (Linear, Notion, GitHub, Slack, Stripe, Sentry, Gmail, Google Calendar and Drive, HubSpot, any custom MCP server), the way Claude's connectors do. Polpo is the [MCP](https://modelcontextprotocol.io) *client*: a connector is configured once for the workspace, and the agents it is granted to (and Polpo itself) get its tools.

(For the opposite direction, Polpo as an MCP *server* that Claude, ChatGPT or Cursor connect to, see [mcp.md](mcp.md).)

## How it works

- A connector is a remote MCP server (Streamable HTTP, falling back to SSE automatically; or legacy SSE), or a local process (stdio, admin only).
- Its tools appear to the model as `mcp__<connector>__<tool>` (only `a-z A-Z 0-9 _ -`, at most 64 characters; long names end with a short hash). Parameters are the server's own JSON Schema.
- **Who may use it** is set on the connector: `access.agents` (agent names, or `"*"` for every agent) and `access.polpo` (Polpo's chat). New connectors default to Polpo only; grant agents explicitly.
- **Which tools** of a granted connector an agent gets is set on the agent: `connectorTools` (see [below](#choosing-an-agents-tools)). By default, all of them.
- An agent with `allowedTools` gets a connector's tools only when its list matches them: `mcp__*` (every connector granted to it), `mcp__linear__*` (one connector), or exact names such as `mcp__linear__create_issue`. Agents without `allowedTools` get every tool of the connectors granted to them.
- **Per-tool policy** (`toolPolicy`): `"off"` hides a tool from everyone; `"ask"` is reserved for asking the person before the call runs (today it behaves like `"allow"`); `"allow"` is the default.
- Connections are opened lazily and reused; tool lists are cached for 5 minutes and refreshed when the server announces a change. Tool calls time out after 60 s (`toolTimeoutMs` per connector, or `settings.connectors.toolTimeoutMs`). Results over 100 KB of text are cut, with a note telling the model to ask for less.
- A connector that cannot connect never breaks a chat or a task: it is skipped, its status records why, and the agent's prompt says it is unavailable.
- Status (`connected`, `needs_auth`, `needs_reauth`, `error`, `disabled`, …) is announced as the `connector:changed` event (SSE, hooks).

## Adding a connector

From the dashboard (**Connectors** in the sidebar: browse the catalog, connect, choose who can use each connector and set per-tool policy; an agent's **Tools & Skills** tab grants or revokes its connectors), from Polpo's chat ("connect Linear", "give Marco access to Notion"), or with the API:

```bash
# from the catalog (OAuth with dynamic registration: nothing to set up)
curl -X POST $POLPO/api/v1/connectors -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"catalogId": "linear", "access": {"agents": ["pm"], "polpo": true}}'
curl -X POST $POLPO/api/v1/connectors/linear/oauth/start -H "Authorization: Bearer $KEY"
# → {"data": {"authorizationUrl": "https://mcp.linear.app/authorize?..."}}: open it in a browser

# a custom server with a token
curl -X POST $POLPO/api/v1/connectors -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"name": "Internal tools", "url": "https://tools.example.com/mcp", "auth": {"type": "bearer"}, "secrets": {"bearerToken": "…"}, "access": {"agents": "*"}}'
```

Auth types: `none`, `bearer` (a token), `headers` (secret headers, e.g. `{"secrets": {"headers": {"X-Api-Key": "…"}}}`), `oauth`.

Catalog entries with a per-account URL (`urlTemplate`, e.g. `https://mcp.dev.azure.com/{organization}`) need `url` with your own value; entries with `variants` (EU, sandbox…) take the variant's URL as `url`.

### API

| Method | Path | |
|---|---|---|
| `GET` | `/api/v1/connectors` | List: status, tool count, access, and which secrets are set (never their values) |
| `POST` | `/api/v1/connectors` | Create (`catalogId` or `url`/`transport`, `auth`, `access`, `toolPolicy`, `toolTimeoutMs`, `secrets`) |
| `GET` | `/api/v1/connectors/catalog` | The catalog, this instance's redirect URI, the OAuth apps |
| `GET` / `PUT` / `DELETE` | `/api/v1/connectors/oauth-apps[/:app]` | Shared OAuth apps (`{ clientId, clientSecret }`; the secret is write-only) |
| `GET` / `PATCH` / `DELETE` | `/api/v1/connectors/:id` | Read, change (secrets write-only), remove (revokes when possible, deletes the secrets) |
| `POST` | `/api/v1/connectors/:id/test` | Connect and list the tools |
| `GET` | `/api/v1/connectors/:id/tools` | The tools (`?refresh=1`), with their policy |
| `POST` | `/api/v1/connectors/:id/oauth/start` | `{ authorizationUrl }` to open (or `{ authorized: true }`) |
| `POST` | `/api/v1/connectors/:id/disconnect` | Revoke (best effort) and forget the OAuth tokens |
| `GET` | `/api/v1/connectors/oauth/callback` | **Public**: where the browser comes back (single-use state) |
| `GET` | `/api/v1/connectors/oauth/client-metadata.json` | **Public**: this instance's OAuth Client ID Metadata Document |

### Polpo's tools

`connectors_list` (status, tools, who may use them; `catalog: true` or `search` for the catalog), `connector_add` (catalog id or custom URL; for OAuth it returns the link the person opens; a token or an OAuth app's secret is entered by the person from a setup link, never in chat, and Polpo waits with `setup_wait`), `connector_connect` (a fresh link after `needs_reauth`), `connector_update_access`, `connector_remove` (only with `confirm: true`, after the person agreed); on demand (group `connectors`): `connector_catalog`, `connector_update` (name, on/off, tool policy), `connector_test`, `connector_disconnect`. Which tools of a connector an agent gets: `add_agent` / `update_agent` `connectorTools`. Polpo cannot add local (stdio) connectors.

## Several accounts of the same service

One catalog app can be connected more than once: two Gmail inboxes, one inbox per agent, a staging and a production Linear workspace. Each account is a separate connector with its own id, OAuth tokens (or key), name, access and tool policy.

- **Ids.** The first one takes the catalog id (`gmail`); adding the same `catalogId` again gives the next free one: `gmail-2`, `gmail-3`… Its tools are `mcp__gmail-2__<tool>`, so `allowedTools` and `connectorTools` can target one account (`mcp__gmail-2__*`).
- **Names.** Give each account a name that says which it is ("Gmail – info@lumea.dev"). Without a `name`, a second account is called "Gmail 2" (never the same name as the first). Rename any connector from its sheet (pencil next to the name), with `PATCH /api/v1/connectors/:id { "name": "…" }`, `polpo_connector_update { id, name }` or Polpo's `connector_update`.
- **Account.** When the sign-in's token response includes an OpenID `id_token` (no extra scope is requested for it), its email (or `preferred_username`) is stored as the connector's `account`; the dashboard then offers it as the name. Google Workspace MCP servers only grant their product scopes, so for them the name is what tells accounts apart. Disconnecting clears `account`.

**Dashboard.** On a connected app's card in **Browse**, **Account** adds another one; so does **Add another account** in a connector's sheet and **Add account** on a group in **Connected**. It asks the display name (prefilled "Gmail 2"), then runs the normal connect flow (sign-in window, or key / URL first). The Connected tab keeps an app's accounts together ("Gmail · 2 accounts"); every row, and every connector on the agent page (Tools & Skills → Connectors), shows its name and what tells it apart (the signed-in account, else its id). "Who can use it" is set per account in its sheet.

**API / MCP / Polpo.**

```bash
curl -X POST http://localhost:3000/api/v1/connectors -H 'Content-Type: application/json' \
  -d '{"catalogId": "gmail", "name": "Gmail – info@lumea.dev", "access": {"agents": ["support"]}}'
# → {"data": {"id": "gmail-2", "name": "Gmail – info@lumea.dev", "catalogId": "gmail", "status": "needs_auth", …}}
```

`polpo_connector_add { catalog_id: "gmail", name: "Gmail – info@lumea.dev" }` (and Polpo's `connector_add`) does the same and returns the sign-in link. `polpo_connectors_list` / `connectors_list` show each one's id, name, account and "another gmail account".

**How agents tell them apart.** A connector tool's description starts with the connector's name and account (`[Gmail 2 – info@lumea.dev] Search threads…`), on Polpo's engine, in progressive discovery (`tools_search` groups) and as harness host tools (Claude Code, Codex). The prompt's Connectors section lists each granted connector by name with its `mcp__<id>__*` prefix and, when an agent has several accounts of one app, adds a line such as `2 accounts of the same app: gmail = Gmail; gmail-2 = Gmail – info@lumea.dev`, telling it to use the account the request is about and to ask when that is unclear.

## OAuth

Polpo uses the MCP SDK's OAuth client: protected resource metadata (RFC 9728) and authorization server discovery (RFC 8414), PKCE (S256), the `resource` indicator, and refresh on `401`. How the client is identified:

1. **Client ID Metadata Document** (servers that advertise `client_id_metadata_document_supported`): the client id is this instance's `https://<public URL>/api/v1/connectors/oauth/client-metadata.json`, served without authentication. Needs a public **https** URL.
2. **Dynamic client registration** (RFC 7591) otherwise.
3. **A pre-registered client** for servers that support neither (Google, Slack, GitHub OAuth, HubSpot, Asana, Box, Zoom…): the admin registers an OAuth app with the vendor once and saves it as a **shared OAuth app** (`PUT /api/v1/connectors/oauth-apps/<app>` with `clientId` and `clientSecret`). Every connector of that vendor reuses it (`auth.oauth.app`). A single connector can also carry its own `auth.oauth.clientId` (with `secrets.clientSecret`).

The flow: `POST /connectors/:id/oauth/start` returns the authorization URL (with a random, single-use `state` that expires after 10 minutes); the person signs in at the provider; the browser comes back to `GET /api/v1/connectors/oauth/callback`, which exchanges the code, stores the tokens and connects. The page tells the person they can close the tab (and notifies the dashboard window that opened it). Expired tokens are refreshed automatically; when the refresh fails too the connector shows `needs_reauth` and needs a new authorization. Disconnecting revokes the tokens when the server supports revocation.

### The redirect URI to register

```
<public URL>/api/v1/connectors/oauth/callback
```

`<public URL>` is `POLPO_PUBLIC_URL` when set (it may include a path, e.g. `https://host.ts.net/alessio`), else the origin the dashboard is reached at (forwarded host and protocol behind a proxy). When `POLPO_PUBLIC_URL` is set it is always used for every URL a provider must reach (redirect URI, metadata document URL and its contents), even when the dashboard calls the API through another host or port (e.g. a tailnet-only `:3001`). `GET /api/v1/connectors/catalog` returns it as `redirectUri`. Register exactly this URI on pre-registered OAuth apps.

If the public URL changes, the next Connect drops a stored client that no longer matches (a metadata document URL or a registration for another redirect URI) and registers again. After the provider, the callback page links back to the dashboard: `POLPO_DASHBOARD_URL` (else `POLPO_UI_PUBLIC_URL`, else the public URL). An `error` / `error_description` returned by the provider becomes the connector's `lastError`. The server logs each attempt as `[polpo/connectors] oauth start <id>: …` / `oauth callback <id>: …` (authorization endpoint, client kind, redirect URI; never tokens or state).

### Public URL requirement (Tailscale Funnel, reverse proxies)

The provider redirects the person's browser to the callback, so it must be reachable from that browser; CIMD servers fetch the metadata document from the internet. On instances published through Tailscale Funnel (or another proxy that only exposes some paths), expose these two paths in addition to `/mcp` and the `/oauth` paths:

- `/api/v1/connectors/oauth/callback` (browser redirect; must be reachable by the person's browser)
- `/api/v1/connectors/oauth/client-metadata.json` (fetched by authorization servers that support CIMD; must be reachable from the internet)

With a path prefix (`POLPO_PUBLIC_URL=https://host.ts.net/<name>`), that is `/<name>/api/v1/connectors/oauth/callback` and `/<name>/api/v1/connectors/oauth/client-metadata.json`. Both are safe to expose: the callback only accepts a valid single-use state, and the metadata document is public by design. Everything else under `/api/v1/connectors` stays behind the API key.

## Google (Gmail, Calendar, Drive, Docs, Sheets, Slides, Chat, People, Workspace search, Google Cloud)

Google publishes official remote MCP servers (Workspace servers are a Developer Preview). They need a pre-registered client, set up once and shared by every Google connector:

1. In Google Cloud Console → APIs & Services → Credentials, create an **OAuth client** of type **Web application**. For Workspace servers enable **"Use this client for an AI-powered agent"**.
2. Add the redirect URI above (`<public URL>/api/v1/connectors/oauth/callback`) to the client.
3. Enable, in the same project, the product API **and** its MCP API: Gmail (`gmailmcp.googleapis.com`), Drive (`drivemcp.googleapis.com`), Calendar (`calendarmcp.googleapis.com`), Docs (`docsmcp.googleapis.com`), Sheets (`sheetsmcp.googleapis.com`), Slides (`slidesmcp.googleapis.com`), Chat (`chatmcp.googleapis.com`), People, Workspace search (`workspacemcp.googleapis.com`); for Google Cloud servers (BigQuery, Cloud Run, Storage…) their MCP APIs.
4. The project must be enrolled in the Workspace MCP Developer Preview.
5. Save the client as the **`google`** OAuth app (Connectors → OAuth apps, or `PUT /api/v1/connectors/oauth-apps/google` with `clientId` and `clientSecret`).
6. Connect each service with one click (catalog ids `gmail`, `google-calendar`, `google-drive`, `google-docs`, `google-sheets`, `google-slides`, `google-chat`, `google-people`, `google-workspace-search`, `bigquery`, `gcp-*`).

Polpo asks Google for offline access (`access_type=offline`, `prompt=consent`) so a refresh token is issued, with each service's scopes (e.g. Gmail: `gmail.readonly gmail.compose gmail.modify`; Calendar: `calendar.calendarlist.readonly calendar.events.freebusy calendar.events.readonly calendar.events`). The authorization server is `https://accounts.google.com` (Google's MCP servers publish no resource metadata). Google Maps uses an API key instead (`X-Goog-Api-Key`).

## Custom connectors

Any remote MCP server: `url` (https), `transport` `http` (default; falls back to SSE) or `sse`, and `auth` `none` / `bearer` / `headers` / `oauth` (dynamic registration, CIMD, or `auth.oauth.clientId` + `secrets.clientSecret`, with optional `scopes`, `extraAuthParams` and `authorizationServer`). Non-secret headers go in `transport.headers`.

### Local (stdio) connectors — admin only

```json
{ "name": "Filesystem", "transport": { "type": "stdio", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/data"], "env": { "API_TOKEN": "${vault:API_TOKEN}" } },
  "secrets": { "values": { "API_TOKEN": "…" } } }
```

A stdio connector **runs a command on the Polpo server** with the server's user, so only an authenticated API call can create or change one (Polpo's chat tools refuse it). It starts with a minimal environment (PATH, HOME, locale, proxies: no API keys), plus its own `env`, where `${vault:KEY}` is replaced by the connector's secret `KEY` (`secrets.values`). Only add servers you trust as much as the code you run on the host.

## Security

- **Secrets only in the vault**, under the reserved owner `$connectors` (service = connector id; shared OAuth apps under `oauth-app:<id>`): bearer tokens, secret headers, OAuth tokens, client secrets, registered client info, the PKCE verifier and the pending state. `.polpo/connectors.json` holds configuration only. Reserved vault owners are never readable by agents or through the vault API.
- **Write-only secrets**: the API never returns a token, header value or secret, only which ones are set.
- **Network**: remote connectors must use https; private, loopback, link-local and CGNAT (tailnet) addresses are refused unless `settings.connectors.allowPrivateNetwork` is `true` (or `POLPO_CONNECTORS_ALLOW_PRIVATE=1`), which also allows `http://localhost`. The URL is checked when saved and before every connection.
- Tokens are never logged; tool results are capped; tool calls time out and honor cancellation.

## Choosing an agent's tools

Connector access is per connector: an agent granted Linear gets every Linear tool. To give it only some of them, set `connectorTools` on the agent, keyed by connector id:

```json
{ "name": "pm", "connectorTools": { "linear": ["create_issue", "list_issues"], "notion": "*" } }
```

- A missing key or `"*"`: every tool of that connector, current and future (the default).
- A list: only those tools, by the server's own tool name (`create_issue`, not `mcp__linear__create_issue`). An empty list: none.
- It narrows, never grants: an agent gets a tool only when the connector is granted to it (`access.agents`), the tool is not `"off"` (`toolPolicy`), the agent's `connectorTools` selects it, and its `allowedTools` (if any) matches it. Progressive `tools_search` / `tools_load` and harness host tools see only that intersection. Polpo's own chat is not affected.
- Names the connector does not list (renamed, removed, or the connector is disconnected right now) are kept, and shown as stale on the agent page, by `polpo_agent_get` (`stale_connector_tools`) and by `polpo_connectors_list { id, agent }` (`stale_tools`).

Set it from the dashboard (agent page → **Tools & Skills** → Connectors → **Tools** on a granted connector: "All tools" or "Only selected", with search and select all / none), with `PATCH /api/v1/agents/:name { "connectorTools": … }` (the whole map; `null` clears it; `"*"` entries are dropped and lists deduplicated), or over MCP with `connector_tools` on `polpo_agent_create` / `polpo_agent_update`. `polpo_connectors_list { agent }` shows what an agent gets.

## Restricting one task's tools

By default a task inherits every connector and tool its agent has. For a run that must be deterministic (send only from the Gmail 2 account, only create Linear issues, no shell), give the task an optional `toolScope`:

```json
{
  "title": "Send the weekly recap",
  "assignTo": "pm",
  "toolScope": {
    "connectors": ["gmail-2", "linear"],
    "connectorTools": { "linear": ["create_issue"] },
    "allowedTools": ["read", "grep"]
  }
}
```

- `connectors`: the connector ids the run may use (each account of an app is its own connector: `gmail`, `gmail-2`), or `"none"`. Absent: every connector the agent has.
- `connectorTools`: per connector, `"*"` or the server's tool names (as in the agent's `connectorTools`). Absent or `"*"`: what the agent gets of that connector.
- `allowedTools`: built-in tools or patterns (`read`, `bash`, `browser_*`). Absent: the agent's own. Connector tools are chosen with the two fields above, not here (`mcp__…` is refused).
- **Opt-in, narrow only.** No `toolScope` (or `null`): no change at all. A scope never grants: a connector the agent is not granted, a tool its `connectorTools` does not select, a tool turned `"off"`, a tool the connector does not list (checked when it can be listed), or a built-in tool the agent does not have (its `allowedTools`, or the default tools for an agent without them) is refused when the task is created or updated: `400 INVALID_TOOL_SCOPE` with one line per problem. If the agent later loses something the scope names (connector removed, access revoked, tool renamed), the run simply does not get it, and `GET /api/v1/tasks/:id` lists it in `toolScopeStale` (also shown on the task page and by `polpo_task_get`).
- **Enforced everywhere the run's tools are resolved.** The runner applies the scope to the agent config the run gets (`applyTaskToolScope` in `@polpo-ai/core`): Polpo's engine, progressive `tools_search` / `tools_load` (they only see the scoped set), the prompt's Connectors section (a left-out connector is not listed) and harness host tools for Claude Code and Codex all resolve from it. `register_outcome`, `task_result` and `dependency_results` are not affected.
- **Recorded.** Each run records the scope it had (`Task.runs[].toolScope`; `polpo_task_get` / `polpo_task_logs` print "tools restricted (…)").

Where to set it: the task page → **Tools for this task** ("Inherit from agent" or "Restrict": the agent's connectors and accounts, optionally only some of their tools with search and select all / none, optionally only some built-in tools); `POST /api/v1/tasks` and `PATCH /api/v1/tasks/:id` (`toolScope`, `null` clears it); a mission task's `toolScope` (see `missions.md`); MCP `polpo_task_create` / `polpo_task_update` with `connectors`, `connector_tools`, `allowed_tools` (`inherit_tools: true` clears it; any of the three replaces the whole scope) and the same fields on `polpo_mission_create` / `polpo_mission_update` tasks; Polpo's `create_task` / `update_task` / `add_mission_task` / `update_mission_task` (`toolScope`). Scheduled and recurring missions create their tasks from the mission document, so a mission task's scope applies to every run.

## Progressive tool discovery

A few connectors easily add a hundred tools to every request. When a run (a task, a chat turn of an agent or of Polpo) has more tools than `settings.tools.progressiveThreshold` (default 30), it starts with its essential tools plus two meta tools, and the rest is loaded on demand:

- **Deferred:** connector tools (`mcp__*`), and optional groups: for agents browser, email, images/video/audio, Excel/PDF/Word, WhatsApp, phone, Ink Hub, data, company brain, storage; for Polpo step-by-step mission editing, apps, data, company brain, storage, skills and playbooks, Ink Hub, phone, WhatsApp, browser and profiles, computers, agent learning. Everything else (files, shell, HTTP, vault, memory, tasks, missions, team, schedules, connectors management, chat tools…) is always on.
- The prompt lists the deferred groups with their size (`Connector Linear (mcp__linear__*): 12 tools`) and how to search them.
- `tools_search { query?, connectors?, groups?, list?, limit?, offset? }`:
  - **Search** (`query`): ranks the deferred tools by name (snake / camel / kebab split), title, description, parameter names and connector / group. Plurals are folded and the verbs and nouns tool names use count as the same word (send / post, create / add / save, list / search / find / get, delete / remove / trash, update / edit / set, pull request / pr…), in English and Italian ("invia una email", "cerca le issue", "elenca i progetti"); a query that names an app ("… in Linear") puts that app's tools first. Deterministic (no LLM, no embeddings), indexed once per run. It returns the best 8 (`limit`, up to 25) with the `total` of matches and the next `offset` when there are more; weak matches (below 30% of the best score) are left out, and a tie of strong matches at the page edge is shown together.
  - **Filters** (hard, not a boost; connectors and groups together are a union): `connectors` takes a connector id (`gmail-2`), its name or account (`Gmail 2 – info@lumea.dev`, `info@lumea.dev`), `mcp__<id>` for exactly one account, or an app / catalog id (`gmail`: every Gmail account, with a note saying which); `groups` takes group ids (`browser`, `documents`). An unknown value is answered with a note listing the valid ones, never with a silent empty result.
  - **Complete list** (`list: true`, or an empty / `*` query with a filter): every loadable tool in scope, name and first sentence, 50 per page (`limit` up to 100), so nothing is missed. No query and no filter: the connectors and groups with their size.
  - The answer is grouped by connector account and group (`Gmail 2 – info@lumea.dev [connector gmail-2] — 3 matches:`), with the exact names to pass to `tools_load` and `(loaded)` on those already loaded. On Polpo's engine the meta tool's `details` carry the structured result (`ToolSearchResult`: `hits`, `total`, `more`, `nextOffset`, per-connector `counts`, `notes`) for UIs.
- `tools_load { names }` loads tools by exact name, or all the tools of a connector or group: its id (`linear`, `mcp__linear`, `mcp__linear__*`), its name (`Linear`, an account name) or an app (`gmail`: all its accounts) or a group id (`browser`). It reports what it loaded, what was already available and what is unknown, with close names (`did you mean mcp__gmail__send_message?`).
- A loaded tool is declared to the model before its next step as a pi-ai system message with `toolsAdded`. Where the provider supports changing tools mid-conversation it goes inline and the cached prompt prefix survives: Anthropic (inline `tool_addition` blocks on recent Claude models), OpenAI Responses (`additional_tools` / tool search on GPT-5.6+ and Codex), Kimi (K3). Every other model gets the current tool list at the top of the request.
- Loaded tools stay for the rest of the conversation: in a chat, the next turns start with the tools loaded (or used) in earlier turns; in a task, for the run. After a compaction, loaded tools are declared again.
- Search and load only see the tools the run was given: `allowedTools`, connector access, `toolPolicy`, the agent's `connectorTools` and the task's `toolScope` are applied first. In a chat, calling a deferred tool by name without loading it loads it (in a task the call fails as an unknown tool until it is loaded).

| Setting | Default | |
|---|---|---|
| `settings.tools.progressiveThreshold` | `30` | Runs with more tools than this defer their optional tools (`"auto"` mode) |
| `settings.tools.progressive` | `"auto"` | Default mode for Polpo and agents: `"auto"`, `"always"`, `"never"` |
| `agent.progressiveTools` | — | Per-agent mode (wins over `settings.tools.progressive`) |

## Configuration

`.polpo/polpo.json`:

```json
{
  "settings": {
    "connectors": {
      "allowPrivateNetwork": false,
      "toolTimeoutMs": 60000
    }
  }
}
```

| Setting | Default | |
|---|---|---|
| `settings.connectors.allowPrivateNetwork` | `false` | Allow connectors on private / local addresses (and `http://localhost`) |
| `settings.connectors.toolTimeoutMs` | `60000` | Default tool call timeout (a connector's `toolTimeoutMs` wins) |
| `POLPO_PUBLIC_URL` (env) | — | The public URL used for the OAuth redirect URI and the client metadata document |
| `POLPO_CONNECTORS_ALLOW_PRIVATE=1` (env) | — | Same as `allowPrivateNetwork` |

Connectors themselves live in `.polpo/connectors.json` (written by the API; edit it by hand only with the server stopped).

## Catalog

`GET /api/v1/connectors/catalog` lists 150+ official remote MCP servers (`src/mcp/catalog-data.ts`, generated by `scripts/generate-connector-catalog.mjs` from a verified list): id, name, category, description, `url` or `urlTemplate`, `variants`, transport, auth (`oauth`, `oauth_preregistered`, `bearer`, `none`), `oauthRegistration` (`dcr`, `cimd`, `dcr+cimd`, `preregistered`), notes, docs and the vendor icon. The dashboard bundles the icons (no hotlinking): after regenerating the catalog run `node scripts/fetch-connector-icons.mjs` and commit `ui/public/connector-icons/` and `ui/src/generated/connector-icons.ts`.
