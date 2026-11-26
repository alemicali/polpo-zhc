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
| **Spec** (versioned) | name, description, icon, `baseUrl`, **`allowedDomains`**, **`secrets`** (vault references), `auth`, default `headers` and `query`, `scopes` (defaults for a group of tools), `settingsSchema`, `limits`, npm `dependencies` (code tools), `tools`, `resources`. |
| **Tool** | name, title, a description written for the model, `inputSchema` / `outputSchema` (JSON Schema), annotations (`readOnlyHint`, `destructiveHint`…), `requiresApproval`, `publicCallable`, and a **kind**: `http` (declarative) or `code`. |
| **Settings** (not versioned) | visibility (`private` / `public`), kill switch (`disabled`), `onTestFailure` (`warn` / `block`), public `rateLimits`, the bound connector id, the template and its installed revision, and the **values of the spec's settings** (`settings`, e.g. a store id). |

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

- Templates: `{{input.path}}`, `{{settings.key}}` (the server's settings), `{{input.x ?? "default"}}`
  or a variable fallback `{{input.currency ?? settings.currency}}`; `{{secrets.NAME}}` only in headers
  and query parameters. In the URL, values are URL-encoded and a missing one is an error; an empty query
  parameter is left out; in a JSON body, a value that is exactly one placeholder keeps its type
  (numbers, lists, objects) and keys whose value is missing are left out.
- Response mapping: `pick` (JSONPath-ish: `result`, `$.data.items`, `items[0]`, `items[*].id`),
  `fields` (keep only these, also of each item of a list; dotted paths keep their shape), `maxChars`.
  See **Output shaping** below for filters, local paging and summaries.
- `errors`: the first rule whose `status` (`404`, `"4xx"`, `"5xx"`) and optional `match` fit turns a
  failure into that message (with the API's own detail).
- `pagination`: hints (style, parameter names, where the total / next cursor is) the description
  can rely on; the executor does not loop.

### Settings, default headers and scopes

A spec can declare non-secret **settings** — typed values set when the server is installed and
changed later without a new version (`PATCH /mcp-servers/{id} { settings }`, the Settings tab,
`polpo_mcp_server_update { settings }`):

```json
"settingsSchema": [
  { "key": "store_id", "label": "Store id", "type": "string", "pattern": "\\d{1,12}",
    "help": "Needed with an account-level token" },
  { "key": "currency", "label": "Default currency", "type": "enum", "options": ["EUR", "USD"], "default": "EUR" }
]
```

Types: `string` (optional `pattern`), `number` (`min`, `max`), `enum` (`options`), `boolean`; `required`
and `default`. Values are validated (unknown keys refused, numbers and booleans coerced); tools see the
stored value or the default as `{{settings.key}}` (code tools: `ctx.settings`).

**Default headers and query** apply to every HTTP tool (`headers`, `query`); **scopes** apply to the
tools that list them, so a header is not repeated in each tool:

```json
"scopes": { "store": { "headers": { "X-PF-Store-Id": "{{settings.store_id}}" } } },
"tools": [{ "name": "list_orders", "scopes": ["store"], … }]
```

Precedence: server defaults < scopes (in the order the tool lists them) < the tool's own. A header or
query parameter whose value renders empty (e.g. the setting is not set) is left out.

### Output shaping

Large answers stay useful without cutting what the model needs:

```json
"response": {
  "pick": "result.variants",
  "filters": [
    { "path": "color", "input": "color", "match": "contains" },
    { "path": "size", "input": "size" }
  ],
  "page": { "defaultLimit": 50, "maxLimit": 100 },
  "fields": ["id", "name", "size", "color", "price", "in_stock"]
}
```

- `filters`: keep the items of the picked list whose `path` matches the tool input `input` (rules whose
  input is not given are skipped) or a fixed `value`; `match`: `equals` (default, case-insensitive),
  `contains`, `in` (the input is a list), `gte`, `lte`.
- `page`: page the list locally for APIs that answer with everything — the result is
  `{ items, total, offset, limit, next_offset }`, read from the inputs `offset` / `limit` (or
  `offsetInput` / `limitInput`).
- `aggregates`: computed on the whole response, added to the result — `count`, `unique`, `min`, `max`,
  `sum`, `value` (e.g. `"colors": { "path": "result.variants[*].color", "op": "unique" }`): a summary
  instead of a dump.
- When the text is still over `maxChars`, a list keeps as many **whole** items as fit and says how many
  there are (`shown`, `total`, a note to filter or page) instead of being cut in the middle of the JSON.

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
  (`expect: "ok" | "error" | "any"`, `contains`). Publish runs them first: failures warn, or block with
  `onTestFailure: "block"` (`force: true` overrides).
- The saved tests are also the server's **suite** (the **Suite** tab; docs/agent-suites.md,
  "Hosted MCP servers"): each test can carry more checks (`assertions`, `scorers`), **HTTP mocks**
  that answer the upstream API (`http`, offline: nothing reaches the network, secrets are
  placeholders, so destructive and approval tools are safe to test), a `mode` and a dataset. Publish
  runs them as the suite (offline). Mark it **Required to deploy** and every deploy runs it on the
  version first: a failure blocks the deploy (the version stays published), an admin can deploy
  anyway with a reason; rollbacks are never gated. Also from the terminal and CI: `polpo test
  --mcp-server <id>`.
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

## Ready-made connectors

Connectors → **Hosted servers** opens with **Ready-made (hosted by Polpo)**: curated templates of
hosted connectors, each with its vendor, category, description, the read-only tools (safe to try), the
tools that need approval, its maturity ("tested with the live API" or not) and its status here —
**available**, **installed · vX**, **update available**, or an install not finished.

| Template | Category | Read-only | Needs approval | Settings | Live API tested |
|---|---|---|---|---|---|
| **Printful** (revision 2) | Print on demand | stores, categories, products (filter + paging), product summary, **find_variant** (color / size), variant, shipping rates, order cost estimate, mockup result, orders | `create_order` (a **draft**, never confirmed) | `store_id` (→ `X-PF-Store-Id` on store endpoints) | revision 1 only |
| **Gelato** (revision 1) | Print on demand | catalogs, catalog attributes, product search, product, prices, shipping methods, order quote, order, order search | `create_draft_order` (`orderType: "draft"`, fixed) | `currency`, `country` (defaults) | no |
| **Printify** (revision 1) | Print on demand | shops, blueprints (search + paging), blueprint, print providers, **find_variant**, catalog shipping, shop products, product summary, shipping cost, orders | `create_order` (kept on hold; never sent to production) | `shop_id` (in the shop URLs) | no |

`create_mockup_task` (Printful) is free of charge on Printful's side and rate-limited; it needs no
approval by default (turn `requiresApproval` on in the draft if you want one).

### Install

**Install** opens one dialog:

1. **Settings** — e.g. Printful's store id (only with an account-level token: `list_stores` lists them).
2. **Credentials** — where to create the token, which scopes, a read-only recommendation; the value
   is posted to the vault entry the template names (e.g. `polpo-infra / printful`, field `token`) and is
   never shown again (the server only says "saved in the vault" / "not set").
3. **Who can use it** — the agents the connector grants, or all agents; none by default, and the dialog
   says so ("only Polpo will see its tools"), so an agent with `mcp__printful__*` in its tools is not
   left with nothing.
4. **Install** — the template's read-only tests run on the draft; if they pass, 1.0.0 is published and
   deployed and the connector is created with the chosen agents. A missing secret or a failing test
   publishes nothing and says why.

Installing a template already installed at an **older revision** makes the new revision the server's
**draft**, with the diff (e.g. `added tools.find_variant`); publish it from Versions when it looks
right. At the same revision, install only saves settings and access.

| Surface | |
|---|---|
| REST | `GET /mcp-servers/templates` (catalog + status), `GET /mcp-servers/templates/{t}`, `POST /mcp-servers/templates/{t}/install { id?, settings?, secrets?, agents?, publish?, force? }` → `status`: `installed`, `needs_secrets` (`missingSecrets`), `tests_failed`, `draft`, `upgrade_draft` (`diff`), `up_to_date`; `PUT /mcp-servers/{id}/secrets/{name} { value }` (write-only). |
| MCP | `polpo_mcp_server_templates` (read), `polpo_mcp_server_install` (admin). Secrets never pass through MCP: a missing one returns `setup_url` / `setup_ids` (`mcp-server:<id>:<secret>`) that open the server's Settings with the secret's input focused; `polpo_setup_wait` waits for it, then install again. |
| Polpo's chat | "install the Printful connector" (the same tools). |
| SDK | `getMcpServerTemplates`, `getMcpServerTemplate`, `installMcpServerTemplate`, `saveMcpServerSecret`; React `useMcpServers().install`, `useMcpServer().saveSecret`. |

### How to add a template

1. Create `src/mcp-servers/templates/<id>/template.ts` exporting a `McpServerTemplate`
   (`src/mcp-servers/templates/types.ts`) and add it to `MCP_SERVER_TEMPLATES` in
   `src/mcp-servers/templates/index.ts`.
2. Fill in: `id`, `name`, `vendor`, `category`, `description`, `icon`, `docs`, `revision` (start at 1),
   `changelog`, `maturity` (`testedWithLiveApi: false` until someone runs it against the real API), a
   one-line `setup`, `secrets` (per secret of the spec: `label`, `howTo`, `url`, `scopes`,
   `recommendation`), the `spec` and `tests`.
   `icon` (and the spec's `icon`) is the key of the vendor's official mark, bundled in
   `ui/public/hosted-server-icons/` (SVG preferred, else PNG ≥ 128 px, from the vendor's own site or
   press kit, the source URL in a comment) and listed in both `ui/src/lib/hosted-server-icons.ts` and
   `src/mcp-servers/icons.ts` (add a `dark` file when the mark is dark on transparent). The cards, the
   server editor and the connector it becomes show it; icons are never fetched at runtime.
3. Curate, don't mirror the API: a few task-oriented tools with descriptions written for the model;
   read-only first (`readOnlyHint`); anything that creates, pays or ships gets `requiresApproval` and
   `destructiveHint`, and should create a draft / on-hold item the vendor never fulfils by itself; fix
   such values in the body (e.g. `"orderType": "draft"`), never take them from the input.
4. Shape the answers (filters, paging, aggregates) so the variant / item the user needs is never cut off.
5. `tests` are **read-only** tools only (they run at install, before publishing), with stable ids.
6. Add the vendor's endpoints to the mocked API in `src/__tests__/mcp-server-templates.test.ts`: every
   template's tools run there against recorded-shaped responses in CI.
7. Any change to the spec or tests: bump `revision` and add a `changelog` line — installed servers then
   show "update available".

### Template spec reference

| Field | |
|---|---|
| `spec.settingsSchema[]` | `{ key, label, type: string \| number \| enum \| boolean, help?, required?, default?, options?, pattern?, min?, max? }` |
| `spec.headers`, `spec.query` | templates sent with every HTTP tool |
| `spec.scopes.<name>` | `{ description?, headers?, query? }`, applied to tools with `scopes: ["<name>"]` |
| `tool.http.response` | `pick`, `fields`, `maxChars`, `filters[] { path, input? \| value?, match? }`, `page { offsetInput?, limitInput?, defaultLimit?, maxLimit? }`, `aggregates.<key> { path, op }` |
| placeholders | `{{input.x}}`, `{{settings.x}}`, `{{secrets.X}}` (headers / query only), fallbacks `?? "literal"` or `?? settings.x` |

## Surfaces

| | |
|---|---|
| Dashboard | Connectors → **Hosted servers**; **Create server** (template, from API, from description, blank); the editor: Tools, Settings (credentials, auth, domains, dependencies, limits, visibility, kill switch), Test, Versions, Logs. |
| REST | `GET/POST /api/v1/mcp-servers`, `GET /templates[/{t}]`, `POST /templates/{t}/install`, `PUT /{id}/secrets/{name}`, `POST /generate`, `GET/PATCH/DELETE /{id}`, `PUT/DELETE /{id}/draft`, `PUT /{id}/tests`, `POST /{id}/test`, `POST /{id}/tests/run`, `POST /{id}/publish`, `POST /{id}/deploy`, `POST /{id}/rollback`, `GET /{id}/versions[/{version}]`, `GET /{id}/deploys`, `GET /{id}/diff`, `GET /{id}/logs`, `GET /{id}/pending` (OpenAPI: tag "MCP servers"). |
| MCP | `polpo_mcp_servers_list`, `polpo_mcp_server_get` (versions, diff), `…_templates`, `…_install`, `…_create`, `…_generate`, `…_update`, `…_test`, `…_publish`, `…_deploy` (and rollback), `…_logs`, `…_delete` (toolset `connectors`; changes need `polpo:admin`). |
| Polpo's chat | The same tools ("hosted-servers" group): "create a connector for Printful". |
| SDK | `getMcpServers`, `getMcpServerTemplates`, `createMcpServer`, `generateMcpServer`, `saveMcpServerDraft`, `testMcpServerTool`, `runMcpServerTests`, `publishMcpServer`, `deployMcpServer`, `rollbackMcpServer`, `diffMcpServer`, `getMcpServerLogs`…; React `useMcpServers`, `useMcpServer`. |
| Events | `mcp-server:changed` `{ id, what }` (created, draft, published, deployed, settings, tests, pending, deleted). |

## Walkthrough: Printful

1. Connectors → **Hosted servers** → Ready-made → **Printful** → **Install** (or
   `polpo_mcp_server_install { template: "printful", settings: { store_id: "…" }, agents: ["designer"] }`,
   or ask Polpo "install the Printful connector").
2. Paste a Printful private token (developers.printful.com/tokens); with an account-level token, also the
   store id (`list_stores`).
3. Choose the agents. **Install**: the read-only tests run (`list_catalog_categories`,
   `get_product { "product_id": 71 }`, `find_variant { product_id: 71, color: "White", size: "M" }`,
   `get_shipping_rates`), then 1.0.0 is deployed and the **Printful** connector appears (Hosted by
   Polpo · v1.0.0), granted to those agents.
4. `get_product` gives the summary (colors, sizes, price range); `find_variant` the exact variant ids.
5. An agent asks for `create_order`: it is queued; approve it in **Approvals** and the draft order is
   created (never confirmed for fulfillment).

A Printful server installed from revision 1 shows "update available": **Update** makes revision 2 its
draft (store setting, `find_variant`, `list_stores`, `estimate_order_costs`, …) with the diff to publish.

### Spike: what is safe to try with a real token

The template's tools against Printful's API (https://developers.printful.com/docs/), read-only first:

| Tool | Printful API | Safe to try | Notes |
|---|---|---|---|
| `list_catalog_categories` | `GET /categories` | yes | read-only |
| `list_catalog_products` | `GET /products` | yes | read-only; the whole catalog unless `category_id` |
| `list_stores` | `GET /stores` | yes | read-only |
| `get_product` | `GET /products/{id}` | yes | read-only (a summary: colors, sizes, price range) |
| `find_variant` | `GET /products/{id}` | yes | read-only; the variants filtered by color / size, paged |
| `estimate_order_costs` | `POST /orders/estimate-costs` | yes | a quote: creates nothing, costs nothing |
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
- Pagination is described to the model, not followed automatically (local paging of a full answer is,
  see Output shaping).
- Gelato and Printify templates are built from the vendors' docs and tested against recorded-shaped
  responses only: run them read-only against the real API before relying on them.
