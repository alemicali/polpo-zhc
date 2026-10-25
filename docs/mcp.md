# Polpo as an MCP connector

Every Polpo server is also an [MCP](https://modelcontextprotocol.io) server. Claude Code, Codex, Claude Desktop, Cursor and any other MCP client can use your instance: ask Polpo to do things, chat with agents, follow tasks and missions, read data, read and write files, make artifacts, approve requests, and call any REST operation.

- **Endpoint:** `https://<your-polpo-host>/mcp` (Streamable HTTP, stateless).
- **Authentication:** your Polpo API key, as `Authorization: Bearer <key>` (or `X-API-Key: <key>`), or the MCP key (`POLPO_MCP_KEY`, below), or OAuth (a sign-in) for Claude and ChatGPT connectors. A server started without any API key, MCP key or login accepts calls without one: never make such a server reachable from the internet.
- **Local process instead of a URL:** `polpo mcp --url <server> --api-key <key>` runs the same tools over stdio and forwards them to the server.

## Tools

The connector exposes a small set of tools designed for what people do, rather than one tool per endpoint. Hundreds of tool definitions would fill the model's context and make it choose worse.

| Tool | What it does |
|---|---|
| `ask_polpo` | Ask Polpo in natural language: it can do anything the instance can (plan, run, manage agents, query data, make artifacts). Returns a `session_id` to continue the conversation. |
| `chat_with_agent` | Talk to one agent, with its tools, memory and skills; `session_id` continues the conversation. |
| `list_agents` | The agents. |
| `list_tasks`, `get_task`, `create_task` | Follow and create tasks. |
| `list_missions`, `get_mission` | Missions and their plans. |
| `list_artifacts`, `get_artifact`, `create_artifact` | Documents, html dashboards and designs, diagrams. |
| `list_data_sources`, `query_data` | Structured data. |
| `list_approvals`, `resolve_approval` | Decide on requests that wait for a person. |
| `list_files`, `search_files`, `read_file` | Browse and read the instance's files (the agents' workspace, `.polpo`, volumes): text by line ranges, images and PDFs as they are. |
| `write_file`, `manage_file` | Create or replace a file (text or base64), make folders, rename, delete. |
| `list_operations`, `call_operation` | Every REST operation of the server (more than 300), for anything else. |

Read-only tools are marked as such (`readOnlyHint`); `call_operation`, `resolve_approval`, `write_file` and `manage_file` are marked destructive, so clients ask before running them.

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
- Every tool goes through the server's own API, with the same checks as the dashboard.
- Serve Polpo over HTTPS when you expose it beyond localhost (for example with Tailscale or a reverse proxy).
