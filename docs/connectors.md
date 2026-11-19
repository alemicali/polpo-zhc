# Connectors: external apps over MCP

Connectors link a Polpo workspace to the apps people already use (Linear, Notion, GitHub, Slack, Stripe, Sentry, Gmail, Google Calendar and Drive, HubSpot, any custom MCP server), the way Claude's connectors do. Polpo is the [MCP](https://modelcontextprotocol.io) *client*: a connector is configured once for the workspace, and the agents it is granted to (and Polpo itself) get its tools.

(For the opposite direction, Polpo as an MCP *server* that Claude, ChatGPT or Cursor connect to, see [mcp.md](mcp.md).)

## How it works

- A connector is a remote MCP server (Streamable HTTP, falling back to SSE automatically; or legacy SSE), or a local process (stdio, admin only).
- Its tools appear to the model as `mcp__<connector>__<tool>` (only `a-z A-Z 0-9 _ -`, at most 64 characters; long names end with a short hash). Parameters are the server's own JSON Schema.
- **Who may use it** is set on the connector: `access.agents` (agent names, or `"*"` for every agent) and `access.polpo` (Polpo's chat). New connectors default to Polpo only; grant agents explicitly.
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

`connectors_list` (status, tools, who may use them; `catalog: true` or `search` for the catalog), `connector_add` (catalog id or custom URL; for OAuth it returns the link the person opens), `connector_connect` (a fresh link after `needs_reauth`), `connector_update_access`, `connector_remove` (only with `confirm: true`, after the person agreed). Polpo cannot add local (stdio) connectors.

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

`<public URL>` is `POLPO_PUBLIC_URL` when set (it may include a path, e.g. `https://host.ts.net/alessio`), else the origin the dashboard is reached at (forwarded host and protocol behind a proxy). `GET /api/v1/connectors/catalog` returns it as `redirectUri`. Register exactly this URI on pre-registered OAuth apps.

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
