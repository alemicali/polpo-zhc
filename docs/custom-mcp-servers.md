# Hosted MCP servers

Polpo is an MCP **client** (connectors: Linear, Notion, any MCP server by URL) and an MCP **server**
(`/mcp`, its own tools). Hosted MCP servers add a third thing: **MCP servers Polpo builds and serves
itself**, for any API — from its docs, from a description, or from a template such as Printful. Each
one becomes a **connector** the moment it is first published, so agents and Polpo use it like any
other connector.

```
draft ──publish──▶ 1.0.0 ──deploy──▶ production ──▶ connector "Printful" (Hosted by Polpo · v1.0.0)
  ▲                  1.1.0 ◀──rollback──┘                  └─▶ public: POLPO_PUBLIC_URL/mcp/servers/printful (optional)
  └── edit, test
```

## Concepts

| | |
|---|---|
| **Server** | `.polpo/mcp-servers/<id>/`: settings (`server.json`), the draft, versions, deploy history, saved tests, call log, calls waiting for approval, code builds. |
| **Spec** (versioned) | name, description, icon, `baseUrl`, **`allowedDomains`**, **`secrets`** (vault references), `auth`, default headers, `limits`, npm `dependencies` (code tools), `tools`, `resources`. |
| **Tool** | name, title, a description written for the model, `inputSchema` / `outputSchema` (JSON Schema), annotations (`readOnlyHint`, `destructiveHint`…), `requiresApproval`, `publicCallable`, and a **kind**: `http` (declarative) or `code`. |
| **Settings** (not versioned) | visibility (`private` / `public`), kill switch (`disabled`), `onTestFailure` (`warn` / `block`), public `rateLimits`, the bound connector id. |

### HTTP tools (declarative)

One request per call, built from the input and run **by Polpo** (no sandbox):

```json
{
  "name": "get_product", "kind": "http",
  "description": "One catalog product with its variants (ids, sizes, colors, prices).",
  "inputSchema": { "type": "object", "properties": { "product_id": { "type": "integer" } }, "required": ["product_id"] },
  "annotations": { "readOnlyHint": true },
  "http": {
    "method": "GET", "url": "/products/{{input.product_id}}",
    "query": { "limit": "{{input.limit ?? 20}}" },
    "response": { "pick": "result", "fields": ["product.id", "product.title", "variants"] },
    "errors": [{ "status": 404, "message": "No such product" }]
  }
}
```

- Templates: `{{input.path}}`, `{{input.x ?? "default"}}`; `{{secrets.NAME}}` only in headers and query
  parameters. In the URL, values are URL-encoded and a missing one is an error; an empty query
  parameter is left out; in a JSON body, a value that is exactly one placeholder keeps its type
  (numbers, lists, objects) and keys whose value is missing are left out.
- Response mapping: `pick` (JSONPath-ish: `result`, `$.data.items`, `items[0]`, `items[*].id`),
  `fields` (keep only these, also of each item of a list; dotted paths keep their shape), `maxChars`.
- `errors`: the first rule whose `status` (`404`, `"4xx"`, `"5xx"`) and optional `match` fit turns a
  failure into that message (with the API's own detail).
- `pagination`: hints (style, parameter names, where the total / next cursor is) the description
  can rely on; the executor does not loop.

### Code tools

An ES module exporting `handler(input, ctx)`; TypeScript types are stripped when the runtime can.

```js
export async function handler(input, ctx) {
  const r = await ctx.fetch(`https://api.example.com/rates?base=${input.base}`, {
    headers: { authorization: `Bearer ${ctx.secrets.token}` },
  });
  ctx.log("status", r.status);
  return await r.json();
}
```

`ctx.fetch` (and the global `fetch`) reach only the server's allowed domains; `ctx.secrets` holds
the declared secrets for this call; `ctx.log` goes to the Test section (masked). npm dependencies
(`"dependencies": { "date-fns": "^4.1.0" }`) are installed at publish with `npm install
--ignore-scripts` (no install scripts ever run), the lockfile is recorded in the version, and the
installed size is capped (`limits.depsMaxMb`, default 100 MB).

## Security model

**Credentials.** A server never contains a secret. It names vault entries —
`"secrets": { "token": { "owner": "polpo-infra", "service": "printful", "key": "token" } }` — and
auth uses them by name (`{ "type": "bearer", "secret": "token" }`). A literal value is refused, and
so are reserved owners (`$connectors`, `$providers`…). Responses only say whether each secret is set.

**HTTP calls** (`src/mcp-servers/http-executor.ts`):
1. the URL must be `https` (http only for `localhost` / `127.0.0.1` listed explicitly) without
   credentials in it;
2. its host must be in `allowedDomains` (`api.example.com`, `*.example.com`) and resolve to public
   addresses only (no loopback, private, CGNAT/tailnet, link-local / metadata);
3. only then are the secrets the call uses read from the vault — for this call only;
4. redirects are never followed (a redirect could carry the credential elsewhere);
5. timeout (`limits.timeoutMs`, 30 s), response size cap (`maxResponseBytes`, 2 MB), what the model
   sees capped (`maxResultChars`), retries on 429 / 5xx (`retries`, 2) for idempotent methods only,
   honoring `Retry-After` (capped at 10 s);
6. the request kept for tests and logs has every secret masked (also URL-encoded and base64).

**Code tools** (`src/mcp-servers/code-worker.ts`): one worker process per server version, in
bubblewrap (`bwrap --unshare-all --clearenv --die-with-parent`):
- filesystem: read-only `/usr` (and the node binary), the version's build folder read-only at
  `/srv`, an empty `/tmp`. No `.polpo`, no vault, no instance files, no home directory;
- network: none of its own. `ctx.fetch` / `fetch` are requests the **host** makes after the same
  destination checks as HTTP tools; libraries that use `HTTP(S)_PROXY` go through the sandbox
  allowlist proxy (`src/sandbox/net-proxy.ts`, on a Unix socket bridged inside the jail) that allows
  only the declared hosts. Raw sockets fail;
- secrets: passed with each call, in memory; never in files or the environment;
- limits: V8 heap (`memoryMb`, 256), per-call timeout (`timeoutMs`) after which the whole process
  tree is killed (`src/sandbox/process-tree.ts`) and the next call starts a fresh worker, calls at
  once (`concurrency`, 4), result size (`maxResponseBytes`), idle stop (`idleMs`, 5 min).
- Code tools need Linux with `bwrap`; elsewhere they answer that they are unavailable.

**Approvals.** A tool with `requiresApproval` never runs for agents or Polpo: the call is queued
(`pending/<id>.json`) and becomes an **Approvals** request ("Printful · Create a draft order");
approving runs it once, in the server process, with the input that was asked; rejecting closes it.
The tool answers "Queued for approval" to the agent. Calls queued by task runner processes are picked
up by the server within seconds.

**Tests never surprise you.** In the Test section (and `polpo_mcp_server_test`, `POST …/test`), a
destructive or approval tool is a **dry run** — the request that would go out, secrets masked —
unless `confirm: true`. Saved test cases run on every publish and **always skip** destructive and
approval tools.

**Kill switch.** `disabled: true` refuses every call (private and public) until switched back on.

**Who can change them.** The REST API is the authenticated API; over MCP, reading needs
`polpo:read` and every change (create, edit, test with the instance's credentials, publish, deploy,
visibility, delete) needs `polpo:admin`.

## Testing, versions and deploys

- **Test** one tool against the draft, production or any version; save sample inputs as test cases
  (`expect: "ok" | "error"`, `contains`). Publish runs them first: failures warn, or block with
  `onTestFailure: "block"` (`force: true` overrides).
- **Publish** freezes the draft as the next semver version. The bump is suggested: **major** when a
  tool is removed or its input schema, kind or approval changes; **minor** for added tools or
  setting changes; **patch** for names, descriptions and icons. An explicit version must be higher
  than every existing one.
- The **first** version is deployed at once (`initial`) and creates the connector. Later ones go
  live with `deploy: true` or **Deploy**. **Rollback** goes back to the version deployed before (or
  to a given one). Every move is in the deploy history, and any two refs (`draft`, `production`,
  a version) can be diffed — per-tool changes and a git-style unified diff, the same view as agent
  versions.

## The connector

On first publish Polpo creates a connector bound to the server (`transport: { type: "hosted",
serverId }`), shown as **Hosted by Polpo · v1.2.0**. It is served **in process** (no network) with
the instance's credentials, in the server and in task runners alike, and behaves like any connector:
Polpo may use it by default, agents are granted in Connectors, tools can be selected per agent and
per task, policies (allow / ask / off) and tool search apply. Its auth and transport can only be
changed in the server. Deleting the server deletes the connector.

## Private and public

- **Private** (default): only this instance (agents, Polpo's chat, MCP via Polpo). From outside the
  public endpoint answers 404, as if it did not exist.
- **Public**: anyone with `POLPO_PUBLIC_URL/mcp/servers/<id>` can call it — **with this instance's
  credentials**. The dashboard and `polpo_mcp_server_update` ask for confirmation. It is a Streamable
  HTTP MCP endpoint (stateless, JSON responses): `initialize`, `tools/list` with annotations and
  `outputSchema`, `tools/call` with structured content, `resources/list|read` for MCP Apps widgets
  (`ui://…`, `text/html;profile=mcp-app`, linked from a tool's `uiResource`). Protections:
  - destructive and approval tools are neither listed nor callable unless the tool sets
    `publicCallable` (approval tools are never callable publicly);
  - rate limits per client IP and in all (`rateLimits`, default 30 and 300 requests per minute;
    `429` with `Retry-After`); the client IP is the first `X-Forwarded-For` address (Tailscale
    Funnel sets it), else the socket's;
  - request bodies capped at 1 MB; every tool call logged with its caller's address;
  - the kill switch answers `503`.

### Tailscale Funnel

Instances expose only `/mcp` through Funnel. To make public servers reachable, publish their path
too (per instance; not done automatically):

```bash
tailscale funnel --bg --set-path /<instance>/mcp/servers http://127.0.0.1:<port>/mcp/servers
```

Set `POLPO_PUBLIC_URL` to the instance's public base (e.g. `https://host.ts.net/<instance>`) so the
dashboard shows the right URL. Remove the path with `tailscale funnel --bg --set-path
/<instance>/mcp/servers off` when no server is public.

## Surfaces

| | |
|---|---|
| Dashboard | Connectors → **Hosted servers**; **Create server** (template, from API, from description, blank); the editor: Tools, Settings (credentials, auth, domains, dependencies, limits, visibility, kill switch), Test, Versions, Logs. |
| REST | `GET/POST /api/v1/mcp-servers`, `GET /templates`, `POST /generate`, `GET/PATCH/DELETE /{id}`, `PUT/DELETE /{id}/draft`, `PUT /{id}/tests`, `POST /{id}/test`, `POST /{id}/tests/run`, `POST /{id}/publish`, `POST /{id}/deploy`, `POST /{id}/rollback`, `GET /{id}/versions[/{version}]`, `GET /{id}/deploys`, `GET /{id}/diff`, `GET /{id}/logs`, `GET /{id}/pending` (OpenAPI: tag "MCP servers"). |
| MCP | `polpo_mcp_servers_list`, `polpo_mcp_server_get` (versions, diff), `…_create`, `…_generate`, `…_update`, `…_test`, `…_publish`, `…_deploy` (and rollback), `…_logs`, `…_delete` (toolset `connectors`; changes need `polpo:admin`). |
| Polpo's chat | The same tools ("hosted-servers" group): "create a connector for Printful". |
| SDK | `getMcpServers`, `getMcpServerTemplates`, `createMcpServer`, `generateMcpServer`, `saveMcpServerDraft`, `testMcpServerTool`, `runMcpServerTests`, `publishMcpServer`, `deployMcpServer`, `rollbackMcpServer`, `diffMcpServer`, `getMcpServerLogs`…; React `useMcpServers`, `useMcpServer`. |
| Events | `mcp-server:changed` `{ id, what }` (created, draft, published, deployed, settings, tests, pending, deleted). |

## Walkthrough: Printful

1. Store a Printful private token (Printful → Settings → API) in the vault, under the reference the
   template uses:
   ```bash
   curl -X POST "$POLPO/api/v1/vault/entries" -H "authorization: Bearer $KEY" -H "content-type: application/json" \
     -d '{ "agent": "polpo-infra", "service": "printful", "type": "api_key", "credentials": { "token": "<token>" } }'
   ```
2. Connectors → **Create server** → Template → **Printful** → Use (or `polpo_mcp_server_create {
   template: "printful" }`, or ask Polpo "create a connector for Printful").
3. **Test**: `list_catalog_categories`, `get_product { "product_id": 71 }`, `get_shipping_rates`. Three
   test cases are saved with the template.
4. **Publish**: 1.0.0 is deployed and the **Printful** connector appears (Hosted by Polpo · v1.0.0).
   Grant it to the agents that need it.
5. An agent asks for `create_order`: it is queued; approve it in **Approvals** and the draft order is
   created (never confirmed for fulfillment).

### Spike: what is safe to try with a real token

The template's tools against Printful's API (https://developers.printful.com/docs/), read-only first:

| Tool | Printful API | Safe to try | Notes |
|---|---|---|---|
| `list_catalog_categories` | `GET /categories` | yes | read-only |
| `list_catalog_products` | `GET /products` | yes | read-only; the whole catalog unless `category_id` |
| `get_product` | `GET /products/{id}` | yes | read-only (variants, prices) |
| `get_variant` | `GET /products/variant/{id}` | yes | read-only |
| `get_shipping_rates` | `POST /shipping/rates` | yes | a quote: creates nothing, costs nothing |
| `get_order`, `list_orders` | `GET /orders…` | yes | read-only |
| `create_mockup_task` | `POST /mockup-generator/create-task/{id}` | yes, sparingly | Printful's docs list no charge for the mockup generator (it creates no order or product), but it is rate limited to a few tasks per minute; check your account if in doubt |
| `get_mockup_result` | `GET /mockup-generator/task` | yes | read-only |
| `create_order` | `POST /orders` | **no** | makes a **draft** order (never sends `confirm`), destructive, needs approval for every call; in Test it is a dry run unless confirmed; saved tests skip it. Do not approve it during a spike. |

No tool confirms, cancels or pays for an order.

## Limits and what is not there yet

- Code tools need Linux with bubblewrap; memory is limited through V8's heap size (no cgroup).
- Public servers have no per-client keys or OAuth: public means anyone with the URL.
- No "run on a computer" option and no external deployment (later).
- Pagination is described to the model, not followed automatically.
