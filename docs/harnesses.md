# Agent harnesses: Claude Code, Codex and OpenCode as an agent's engine

An agent can run its tasks on an official agent runtime instead of Polpo's own engine:
**Claude Code** (Anthropic), **Codex** (OpenAI) or **OpenCode** (open source, any model). The runtime runs **inside the agent's computer**
(a Daytona v2 VM), works on the computer's files with its own tools (Bash, Read, Write, Edit,
search…), and gets **Polpo's tools** as extra tools that run on the Polpo server with the agent's
permissions: `register_outcome`, email, data sources, artifacts, storage, company brain, connectors
(`mcp__*`), Ink, and the rest of the agent's `allowedTools`.

Polpo drives the runtime through the AI SDK harness API (`@ai-sdk/harness`, experimental; the
versions are pinned exactly and only `src/harness/sdk.ts` imports them).

## What you need

1. **A Daytona v2 computer** for the agent (`settings.sandbox.providers.daytona.api: "v2"`, see
   [daytona-v2.md](daytona-v2.md) and [computers.md](computers.md)), set as its `defaultComputer`.
   E2B and Daytona v0 computers cannot run harnesses yet. On this server (no remote computer) only
   when `settings.harnesses.allowHost` is true, and then with an **isolated HOME**
   (`.polpo/harness/<agent>/home`): never the server's `~/.claude`, `~/.codex` or environment.
2. **The runner image `polpo-runner-vm-3`** in the Daytona project (it adds pnpm 10.30.1, which the
   harness bootstrap needs): `DAYTONA_V2_API_KEY=… node scripts/build-sandbox-images.mjs --provider daytona-v2`.
   Without it Polpo uses `polpo-runner-vm-2` and activates pnpm with corepack at run time (about 1 s).
3. **A credential in the vault**, chosen in Settings → Harnesses (a vault reference: owner + service;
   the key itself is added in that agent's Credentials tab and never stored in the settings).

### Claude Code: authentication

| `auth` | Vault entry | What the runtime gets |
|---|---|---|
| `bedrock` | `apiKey` (a Bedrock API key / bearer token), or `accessKeyId` + `secretAccessKey` (+ `sessionToken`) | `CLAUDE_CODE_USE_BEDROCK=1`, `AWS_REGION` (`bedrock.region`), `AWS_BEARER_TOKEN_BEDROCK` or the AWS keys, `ANTHROPIC_MODEL` (the model) |
| `api-key` | `apiKey` (an Anthropic API key, `sk-ant-api…`) | `ANTHROPIC_API_KEY` |
| `vertex` | `serviceAccountJson` (a service account key) | `CLAUDE_CODE_USE_VERTEX=1`, `CLOUD_ML_REGION`, `ANTHROPIC_VERTEX_PROJECT_ID`, the key as a file (`GOOGLE_APPLICATION_CREDENTIALS`) |
| `ai-gateway` | `gateway.credentialRef` → `apiKey` (a Vercel AI Gateway key) | the gateway's base URL and a placeholder key (see [Model gateways](#model-gateways)) |
| `gateway` | `gateway.credentialRef` → `apiKey` (the gateway's key; none with `authScheme: "none"`) | the gateway's base URL, a placeholder key, the gateway's model ids |

With `api-key`, `ai-gateway` and `gateway` the key **does not enter the VM** when Polpo's model relay
is reachable (see [Credential brokering](#credential-brokering)): the runtime gets a placeholder.

**A Claude subscription (Pro/Max sign-in, `sk-ant-oat…` tokens) is refused** — in the settings and in
the vault entry. Anthropic's consumer terms do not allow a subscription to power a product that runs
agents for other people; use an API key, Bedrock or Vertex (billed to that account).

Authentication is always **explicit**: Polpo hands the adapter an authentication environment, so it
never looks at this server's `process.env`, `~/.claude/settings.json` (`apiKeyHelper`), the native
subscription store or `~/.codex/auth.json`.

### Codex: authentication

`auth: "api-key"` with an OpenAI API key (`apiKey` or `OPENAI_API_KEY` in the entry), `"ai-gateway"`
(the Vercel AI Gateway: model ids `openai/…`) or `"gateway"` (a gateway that speaks the OpenAI
Responses API, `format: "openai-responses"`, base URL ending in `/v1`). Signing in with ChatGPT is not
supported yet.

### OpenCode: any model, open-weight ones included

[OpenCode](https://opencode.ai) (`opencode-ai`, MIT) runs as a bridge process in the computer like
Claude Code (`@ai-sdk/harness-opencode`, pinned; it installs `opencode-ai` and ripgrep in the VM).
It runs **any model** OpenCode supports, so choose it when an agent needs a model the other two
cannot run: open-weight models (Kimi, GLM, Qwen, DeepSeek…) on Amazon Bedrock, OpenRouter, Groq or a
gateway; Gemini, Grok, Mistral; or a provider the team already pays. Claude Code stays the choice for
Claude models, Codex for OpenAI's.

| `auth` | Settings | Vault entry |
|---|---|---|
| `api-key` | `provider`: `anthropic`, `openai`, `google`, `xai`, `mistral`, `groq`, `deepseek`, `openrouter`, `moonshotai`, `zai` | the provider's API key (`apiKey`, or its own variable name, e.g. `MOONSHOT_API_KEY`) |
| `bedrock` | `bedrock.region` | a **Bedrock API key** (`apiKey` or `AWS_BEARER_TOKEN_BEDROCK`) |
| `ai-gateway` | `gateway: { baseUrl?, credentialRef }` | the Vercel AI Gateway key |
| `gateway` | `gateway: { format, baseUrl, authScheme, credentialRef?, headers?, models: { main } }`; `format`: `openai-chat` (Chat Completions: OpenRouter, LiteLLM, vLLM, most gateways), `openai-responses` or `anthropic` | the gateway's key |

```json
"opencode": { "auth": "bedrock", "credentialRef": { "owner": "ops", "service": "bedrock" },
              "bedrock": { "region": "us-east-1" }, "model": "global.moonshotai.kimi-k3.1" }
```

- **The model is required** (in the setting, `gateway.models.main`, or the agent's `engine.model`):
  the provider's id, with or without OpenCode's provider prefix (`amazon-bedrock/global.moonshotai.kimi-k3.1`
  is stored as `global.moonshotai.kimi-k3.1`). OpenCode's model catalog (models.dev) supplies the
  model's limits and prices; a model it does not list still runs (Polpo declares it), without a price.
- **Bedrock** takes a Bedrock API key only: it is a bearer token, so Polpo's relay can keep it out of
  the VM. AWS access keys (SigV4) sign every request inside the VM and are refused for OpenCode (use
  Claude Code for SigV4, or create a Bedrock API key). OpenCode adds Bedrock's cross-region prefix
  (`us.`, `eu.`…) for the models that need it; ids that already carry one (`global.…`) are kept.
- **Logins are never used**: OpenCode can sign in to ChatGPT/Codex, GitHub Copilot, xAI, OpenCode
  Zen/Go, GitLab Duo… on a laptop; Polpo refuses those (`auth: "subscription"` and the like, provider
  `github-copilot`, `opencode`, `opencode-go`, `gitlab`, `poe`).
- **Polpo writes OpenCode's config** for each run: only the chosen provider (`enabled_providers`), its
  key option (or a placeholder), its base URL (Polpo's relay when it brokers), the model (also the
  small model for titles and summaries), gateway headers when not brokered. The adapter gets an
  empty, explicit authentication (`auth: {}`), so it never reads this server's environment,
  `~/.local/share/opencode/auth.json` or a subscription; the computer's own provider variables
  (`OPENAI_API_KEY`, `AWS_*`, `AI_GATEWAY_API_KEY`…) are blanked for OpenCode's processes.
- Effort maps to OpenCode's reasoning variant (`low`, `medium`, `high`; `xhigh` / `max` → `high`).
  `maxBudgetUsd` is not enforced by OpenCode. OpenCode compacts the conversation by itself when it
  nears the model's context window and resumes from its saved session state (the bridge keeps it in
  the VM), like the other runtimes; it reads the repository's `AGENTS.md` itself.

## Configuration

```json
{
  "settings": {
    "harnesses": {
      "enabled": ["claude-code"],
      "claude-code": {
        "auth": "bedrock",
        "credentialRef": { "owner": "ops", "service": "bedrock" },
        "bedrock": { "region": "us-east-1" },
        "model": "us.anthropic.claude-sonnet-4-5-20250929-v1:0"
      },
      "codex": { "auth": "api-key", "credentialRef": { "owner": "ops", "service": "openai" } },
      "allowHost": false
    }
  },
  "teams": [{ "name": "t", "agents": [{
    "name": "ada", "defaultComputer": "ada-box",
    "engine": { "harness": "claude-code", "model": "us.anthropic.claude-haiku-4-5-20251001-v1:0", "permissionMode": "allow-all", "effort": "medium", "maxBudgetUsd": 2 }
  }]}]
}
```

- `engine`: `"polpo"` (default) or `{ harness, model?, permissionMode?, effort?, maxBudgetUsd?, credentialRef? }`.
  `credentialRef` (a vault reference, never the key) is the agent's **own key** for cost separation:
  it replaces the harness's API key or gateway key for this agent's runs (not with Bedrock / Vertex,
  nor with a gateway that takes no key).
  `permissionMode` `allow-all` (default: the runtime works unattended in its VM), `allow-edits` or
  `allow-reads`; in a task nobody answers an approval, so an action the mode does not allow is
  denied and the runtime is told to do it another way. `maxBudgetUsd` stops a run when Claude Code's
  spend estimate passes it.
- Checked when saved (config file, `PATCH /api/v1/agents/:name`, `PATCH /api/v1/config/settings`,
  MCP) and again before every run: the harness must be enabled, the agent's computer must be able
  to run it, secrets are never accepted in the settings, a harness that agents use cannot be
  disabled.

Dashboard: **Settings → Harnesses** (enable, authentication, credential via the vault picker, region,
gateway with presets, model, allow on this server; **Test connection**, also run after every save;
whether the key stays on the server; the harness sessions with Stop / Reset) and the agent's
**Computer tab → Engine** (Polpo / Claude Code / Codex, model, permission mode, effort, budget, own
key; only enabled harnesses are offered; the connection is tested after a save).

MCP (see [mcp.md](mcp.md)): `polpo_harnesses_get`, `polpo_harnesses_update` (admin; a missing
credential entry comes back as `setup_url` + `setup_id` for `polpo_setup_wait`; `gateway` for
`ai-gateway` / `gateway`), `polpo_harnesses_get { test, agent? }` (the connection test), `polpo_harness_sessions_list`,
`polpo_harness_session_control` (work), and `engine` on `polpo_agent_create` / `polpo_agent_update`.

REST: `GET /api/v1/harnesses` (with `relay` and each harness's `brokering`),
`GET /api/v1/harnesses/sessions?agent=&computer=`, `POST /api/v1/harnesses/sessions/:key/stop`,
`POST /api/v1/harnesses/sessions/:key/reset { confirm: true }`,
`POST /api/v1/harnesses/test { harness, settings?, agent? }` (see [Connection test](#connection-test)).

## Model gateways

A harness can reach its model through a gateway instead of the provider: for cost control, logging,
routing, fallbacks or other models. Two auth types:

- **`ai-gateway`** — the [Vercel AI Gateway](https://vercel.com/ai-gateway):
  `gateway: { baseUrl?, credentialRef }` (`baseUrl` defaults to `https://ai-gateway.vercel.sh`). The
  AI SDK uses its gateway mode: Claude Code calls `<base>/v1/messages` and maps `anthropic/…` model
  ids; Codex calls `<base>/v1/responses` and prefixes `openai/`.
- **`gateway`** — any gateway:

```json
"claude-code": {
  "auth": "gateway",
  "gateway": {
    "preset": "cloudflare",
    "format": "anthropic",
    "baseUrl": "https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/anthropic",
    "authScheme": "none",
    "headers": [{ "name": "cf-aig-authorization", "credentialRef": { "owner": "ops", "service": "cloudflare" }, "field": "token", "prefix": "Bearer " }],
    "models": { "main": "claude-sonnet-4-5", "haiku": "claude-haiku-4-5" }
  }
}
```

| Field | Meaning |
|---|---|
| `format` | `anthropic` (Claude Code: Anthropic Messages) or `openai-responses` (Codex: OpenAI Responses) |
| `baseUrl` | https only, no user info, no query or fragment (http only for `localhost`). Claude Code appends `/v1/messages` (do not include it); Codex appends `/responses`, so the base ends in `/v1` (Cloudflare's `…/openai` is accepted as is) |
| `authScheme` | how the gateway key is sent: `x-api-key`, `bearer` (`Authorization: Bearer`, default) or `none` (no key; auth in a header) |
| `credentialRef` | the gateway key's vault entry (required unless `authScheme: "none"`) |
| `headers` | extra headers on every model request: `{ name, credentialRef, field?, prefix? }` for a secret (from the vault; `field` defaults to the entry's apiKey / key / token; `prefix` e.g. `"Bearer "`), `{ name, value }` for a literal that is not a secret (a value that looks like a key is refused). Names are HTTP tokens; `host`, `content-length`, `authorization`, `x-api-key`, `cookie`, `anthropic-*` and hop-by-hop headers are refused. Secret header entries must exist in the vault to save |
| `models` | `{ main, haiku?, sonnet?, opus? }`: the gateway's model ids; Claude Code's aliases map to them (`ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_HAIKU_MODEL` / `_SONNET_` / `_OPUS_`, `ANTHROPIC_SMALL_FAST_MODEL`). Required with `openai-responses` or `nonClaude` (or a harness `model`) |
| `nonClaude` | Claude Code on non-Claude models (GLM, Kimi, Qwen, DeepSeek… behind the Anthropic format): sets `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1`, `CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING=1`, maps every alias to `models.main` unless set, and sends no adaptive thinking or effort |

Presets in Settings → Harnesses (a label: the URL, scheme and headers are what count):

| Preset | Base URL (Claude Code / Codex) | Key | Headers |
|---|---|---|---|
| Vercel AI Gateway | auth `ai-gateway` | AI Gateway key | — |
| Cloudflare AI Gateway | `https://gateway.ai.cloudflare.com/v1/{account}/{gateway}/anthropic` / `…/openai` (account and gateway ids in the form) | `none` with provider keys stored in Cloudflare (BYOK), or your provider key (`x-api-key` for Claude, `bearer` for Codex) | `cf-aig-authorization: Bearer <vault>` (authenticated gateway) |
| OpenRouter | `https://openrouter.ai/api` / `https://openrouter.ai/api/v1` | `bearer` (OpenRouter key) | — |
| LiteLLM | your proxy's URL / `<url>/v1` | `bearer` (virtual key) | — |
| Portkey | `https://api.portkey.ai` / `https://api.portkey.ai/v1` | `none` | `x-portkey-api-key: <vault>`, `x-portkey-provider: anthropic` / `openai` or an `@integration` slug (literal) |
| Kong AI Gateway | your route's URL | as your key-auth plugin expects (`bearer`, `x-api-key` or a header) | — |
| Custom | any | any | any |

Costs through a gateway: Claude Code's own estimate uses Anthropic's prices. Polpo records every
turn's tokens and marks the cost's source on the run (`runContext.cost.costSource`): `gateway` when
the gateway reports a cost in a response header (best effort: `x-litellm-response-cost` and similar),
`runtime` (Anthropic directly), `runtime-estimate` (Claude models through a gateway: approximate),
`tokens-only` (non-Claude models and Codex through a gateway: no reliable price, the cost is not
recorded).

## Credential brokering

The runtime in the VM needs to call its model, but the VM should not hold the key: an agent (or
anything it runs) could read it. The AI SDK harness supports **credential brokering**: when the
sandbox session implements `addRequestTransformations` / `setRequestTransformations`, it puts a
random placeholder (`aisdkhc_…`) in the VM instead of the key and registers request transformations
("requests to host H whose `x-api-key` is the placeholder get `x-api-key: <key>`") that the sandbox
applies **outside** the VM. Polpo's sandbox session implements them once, for **every computer
provider** (`src/harness/sandbox-session.ts`):

- **Polpo's model relay**, for every provider (Daytona v2, Daytona v0, E2B): the VM's base URL
  becomes `<POLPO_PUBLIC_URL>/api/v1/harness-relay/<token>`, and the rules are applied by Polpo.
- The session layer also has a small optional hook, `RemoteDriver.requestTransformations(rules,
  { replace })`, for a provider that could apply the rules itself; no provider implements it today.

The rules: the SDK's credential rules (presented as the
gateway's `authScheme` wants: `x-api-key`, a Bearer token, or removed) and Polpo's own rules for the
gateway headers (host = the upstream's). Credential headers the VM sends (`authorization`,
`x-api-key`, `cookie`) are always dropped; only rule headers reach the upstream; in Polpo's rules a
header value `""` removes the header.

The relay (`src/harness/relay.ts`):

```
VM ──https──▶ <POLPO_PUBLIC_URL>/api/v1/harness-relay/<token>/v1/messages   (Funnel / proxy)
   ──▶ Polpo server: a pipe, never sees a key
   ──unix socket──▶ the run's lease (in the process that runs the task and holds the key)
   ──https──▶ <upstream>/v1/messages   (placeholder swapped, gateway headers added)
```

- **One lease per run**: a random 256-bit token (the VM's base URL), a unix socket named by the
  token's hash in a 0700 directory (`/tmp/polpo-relay-<hash of the .polpo dir>/`, or
  `POLPO_RELAY_SOCKET_DIR`), the run's rules and its upstream. Suspended (503) while the computer
  hibernates, resumed when the session re-attaches, **revoked when the run ends** (or its session is
  stopped or reset; the socket is removed). Tokens are never logged; transcripts scrub them.
- **Rule matching follows the AI SDK type**: `host`, `path` (`exact` / `startsWith` / `regex`),
  `method`, `queryString` and `headers` key/value matchers (header names case-insensitive). The SDK
  registers its rules for the base URL it was given, i.e. the relay's public host and path
  (`/<instance>/api/v1/harness-relay/<token>`); Polpo's gateway rules are for the upstream host. A
  rule matches when it matches the request **as the VM sent it** (relay URL) or **as it goes
  upstream** (upstream URL), host and path from the same view. A request that no credential rule of
  the session matches (a stale placeholder) is refused (401).
- **Not an open proxy**: the upstream is the configured base URL (`https://api.anthropic.com`,
  `https://api.openai.com/v1`, the gateway's); a path that would leave it (`..`, encoded dots,
  slashes or backslashes) is refused; redirects are not followed.
- **Streaming**: bodies pass through untouched in both directions (SSE included) with backpressure
  (a chunk is read from the upstream when the VM takes one); `anthropic-beta`, `anthropic-version`
  and the other request headers pass through; `accept-encoding: identity` upstream. The VM's
  disconnect aborts the upstream request. Timeouts: 10 min to the upstream's first byte, 5 min
  between chunks.
- Mounted before the API rate limit (an agent turn makes many calls) and outside the dashboard's
  authentication: the token authenticates.

**What the host needs.** Computers reach the relay at `POLPO_PUBLIC_URL`. On an instance published
through Tailscale Funnel with a path per instance (`POLPO_PUBLIC_URL=https://<host>/<instance>`),
expose one more path (Funnel strips the mount path):

```bash
tailscale funnel --bg --set-path /<instance>/api/v1/harness-relay http://127.0.0.1:<port>/api/v1/harness-relay
```

It is safe to expose: without a live run's token every request gets the same 401. Without
`POLPO_PUBLIC_URL` Polpo **falls back** to forwarding the key into the VM (as before), with a warning
in the server log, in the run's transcript and in Settings → Harnesses (`GET /api/v1/harnesses`
returns `relay.available: false` and `brokering: "in-vm"`). Secret gateway headers then go with the
requests from the VM too (`ANTHROPIC_CUSTOM_HEADERS` / Codex `http_headers`); a Codex gateway with
`authScheme: "x-api-key"` needs the relay.

**OpenCode** is brokered by Polpo itself: Polpo writes OpenCode's provider config, so the
placeholder (`polpo-placeholder-…`, in the provider's key option) and its rule are Polpo's
(`credentialRules`, installed on the run's lease, or on a native provider before the first process
starts). The adapter registers no rule of its own (its authentication is empty). The base URL in the
config is the relay's; the upstream is the provider's (e.g. `https://api.moonshot.ai/v1`,
`https://bedrock-runtime.<region>.amazonaws.com`, `<gateway>/v1/ai` for the AI Gateway). The key
presented as each provider wants it: `x-api-key` (Anthropic), `x-goog-api-key` (Gemini), a Bearer
token (the others, Bedrock API keys included). Without the relay the key goes in OpenCode's config in
the VM.

**Claude Code on Bedrock and Vertex** signs every request (SigV4, Google OAuth) inside the runtime, so
its credentials cannot be swapped on the way out: they still go into the VM. To keep them out, put a
gateway in front (e.g. LiteLLM or Portkey with Bedrock/Vertex behind it, or Cloudflare AI Gateway)
and use `auth: "gateway"`. Runs on this server (`allowHost`) are not brokered: the runtime already
runs next to Polpo's files (isolated HOME).

## Connection test

`POST /api/v1/harnesses/test { harness, settings?, agent? }` (MCP `polpo_harnesses_get { test }`, Polpo
`harnesses_get { test }`, the **Test connection** button; run after every save in the dashboard) sends one
tiny request **from the Polpo server, never the VM**, with the configured authentication and model
(the saved settings, the ones being edited in `settings`, or `agent`'s own key and model):

- Anthropic format (API key, Vercel AI Gateway, gateways for Claude Code): `POST {base}/v1/messages`,
  `stream: true`, `max_tokens: 16`, one trivial tool with `tool_choice: any`; passes on
  `message_start` → a `tool_use` block → `message_stop` (Claude Code needs streaming and tools).
- OpenAI Responses (Codex): `POST {base}/responses`, `stream: true`, `max_output_tokens: 16`, one
  function tool; passes on `response.completed` (or `response.incomplete` at the token limit).
- Bedrock: a minimal Converse call with the model (Bedrock API key, or SigV4 with access keys).
- Vertex AI: a minimal `rawPredict` (the service account's OAuth token).
- OpenCode: its provider's format with its model (required): Chat Completions
  (`POST {base}/chat/completions`, streamed, one tool) for the OpenAI-compatible providers, OpenAI
  gateways in that format and the Vercel AI Gateway; Anthropic Messages (`{base}/messages`); OpenAI
  Responses; Gemini `generateContent` with `x-goog-api-key`; Bedrock Converse with the Bedrock API key.

The result: `{ ok, latencyMs, model, endpoint, status, errorKind?, error?, note? }`, `errorKind` one of
`config` (settings or vault entry), `auth`, `model` (not available to the account / unknown id),
`network`, `timeout`, `protocol` (no streaming or tools), `upstream`; the error says what to change,
with secrets scrubbed. Defaults when no model is set: `claude-haiku-4-5`, `gpt-5-mini` (or their
`anthropic/…`, `openai/…` ids on the AI Gateway), Haiku 4.5 on Bedrock / Vertex.

### From Polpo's chat

Polpo has the same tools as the MCP server: `harnesses_get` / `harnesses_update` (secrets: a setup link, then `setup_wait`),
`harness_sessions_list` / `harness_session_control` (group `harnesses`, loaded on demand), and `add_agent` / `update_agent`
take `engine` and `defaultComputer`. Ask "create an agent on Claude Code with a computer" and it enables the harness if needed,
creates a Daytona v2 computer and the agent.

## How a run works

1. The task runner sees `agent.engine` and starts the harness engine (`src/adapters/harness-engine.ts`)
   instead of Polpo's.
2. It attaches the agent's computer (waking it from its snapshot when it hibernates), makes sure pnpm
   is there, picks a free port for the bridge (4000–4099), and creates the harness session: the
   first time on a VM the adapter installs its bridge and the runtime (about 13 s and 370 MB under
   `~/.ai-sdk-harness`), then starts the bridge, which the server reaches over WebSocket through the
   Daytona preview proxy (a signed link valid 24 h, re-minted on every re-attach).
3. Instructions: the agent's prompt (identity, responsibilities, `systemPrompt`), its working and
   output directories, the list of Polpo tools, connectors, and the repository's `AGENTS.md`
   (Claude Code; Codex reads it itself). The agent's skills are given to the runtime as its skills.
   Polpo tools load with the first request, not behind Claude Code's tool search: Polpo starts
   Claude Code with `ENABLE_TOOL_SEARCH=false` when the agent has up to 40 Polpo tools (the
   `alwaysLoad` tool hint alone is not honored by the pinned Claude Code), and `auto` above that
   (deferred only when the tool definitions take a large share of the context). `register_outcome`
   is always among them, whatever the agent's `allowedTools`.
   A task that depends on other tasks (or belongs to a mission) also gets `task_result` as a Polpo
   tool, and its prompt carries its dependencies' results (see [Results between tasks](missions.md#results-between-tasks)).
   Only `task_result` is offered to the runtime (not `dependency_results`: the results are already in
   the prompt), to keep the Polpo tools within the 40 that load with the first request.
4. The turn streams into the run's transcript (text, reasoning, every tool call and result, the
   runtime's own tools and Polpo's) and its activity (tool calls, files written or edited). Secrets
   are scrubbed from everything written.
5. Usage and cost: each turn's tokens (input, cached, output) go to the task's activity, and a
   token-usage record (`source: "agent_harness"`) carries the runtime's cost estimate (Claude Code
   reports it cumulatively per session; Polpo records the difference). `GET /api/v1/token-usage`
   adds it to the cost (`harnessCost`) and its input, output and cache tokens to `inputTokens`,
   `outputTokens`, `cacheReadTokens` and `cacheWriteTokens`; `?taskId=<id>` narrows it to one task (its runs' tokens and
   harness cost), `?range=` is `1h`, `today`, `24h`, `7d` (default), `30d` or `all` (anything else: 400).
6. Deliverables: what the runtime registers with `register_outcome`, and the output directory
   copied back like any remote run. A continuation of the task adds its outcomes to the previous
   runs' (as with Polpo's engine); a retry or fix starts over.
7. Directions: a follow-up runs as the next turn; a steer goes to the running turn; kill aborts it.
8. At the end the runtime stops (its bridge exits); its conversation stays in the VM, and a
   continuation of the task ("continue" direction) resumes it.

## Where and with what a run executed

Every run of a task is recorded on the task, in `runs` (newest last, at most 20; no secret ever:
the authentication kind and region, never the credential or its vault reference):

| Field | Meaning |
|---|---|
| `engine`, `model` | `polpo`, `claude-code` or `codex`; the model id (the agent's on Polpo's engine, the harness model otherwise) |
| `auth` | `{ kind: "bedrock" \| "vertex" \| "api-key", region? }` (harnesses) |
| `permissionMode`, `effort`, `budgetUsd` | The harness options of the run |
| `computer` | `{ id, name?, kind: host \| daytona \| e2b \| ephemeral, provider?, daytonaApi?: v0 \| v2, remoteId? }` (`remoteId`: the VM the run used) |
| `sandbox` | `{ provider, ephemeral, fallbackFrom? }` |
| `egress` | `{ mode: "direct" }` or `{ mode: "proxy", proxy, tailscale? }` |
| `session` | `{ resumed, bootstrapMs, sessionId }` (harnesses: a continuation resumes the conversation) |
| `cost` | `{ harnessUsd?, modelUsd?, tokens? }`: the harness's own estimate (Claude Code), or the model cost the provider reports to Polpo's engine |
| `status`, `startedAt`, `endedAt`, `durationMs`, `exitCode`, `continuation` | The run itself |

The orchestrator writes what it knows when it spawns the run; the engine reports the session, the VM
and the cost while it runs (`AgentActivity.runContext`) and the orchestrator merges it; the entry is
closed when the run ends. `GET /api/v1/tasks/:id` returns `runs`, the slim list `lastRun`;
`polpo_task_get` and `polpo_task_logs` return them structured (`runs`) and as one line per run. The
dashboard shows them on the task page (Run card, with the earlier runs) and as small marks on the
tasks list, mission tasks, agents, computers and the event feed.

A harness run's transcript is the same run log as Polpo's engine (`GET /api/v1/agents/processes/:taskId/activity`,
`polpo_task_logs`, the task's Execution tab): `assistant`, `reasoning`, `tool_use` / `tool_result`
(the runtime's own tools in lower case, e.g. `write`, `bash`; Polpo's tools with `host: true`),
`log` lines (session started / resumed / detached) and one `usage` entry per turn (tokens, `costUsd`).

## Hibernation and resume

A Daytona v2 computer hibernates when idle (memory and disk snapshot, VM deleted) and rotates before
its 24 h wall clock. A harness turn **holds** the computer (it counts as a command in flight), so an
idle hibernation never cuts a turn. Before a snapshot every live harness session on the computer
**detaches**: its resume state (which contains the bridge's private key) is saved encrypted in the
vault (system namespace `$harness`, never visible to agents). The bridge process lives on in the
memory snapshot; on the next turn the session re-attaches to the new VM (new id, new preview URL)
in about 1.3 s, without reinstalling anything. A reset or delete of the computer **stops** the
sessions instead (their next turn starts a new bridge that resumes the conversation when the disk
is kept). A forced rotation in the middle of a turn breaks the turn: the engine re-attaches once
and asks the runtime to check its work and continue.

Session status (no secrets) is in `.polpo/harness-sessions.json`: state, live, when the runtime was
bootstrapped and how long it took, last detach and resume, turns, cost.

Sessions follow what they belong to. Deleting a task resets its session: the runtime stops, the
status record goes and its resume state is removed from the vault. Removing an agent resets all of
its sessions, and deleting a computer resets the sessions bound to it. This is best effort: it never
blocks the delete, and failures are logged. The server also sweeps for orphans at startup and every
15 minutes. An orphan is a session whose task, agent or computer no longer exists. The sweep skips
sessions that are live and sessions updated in the last 10 minutes.

## Costs and limits

- **OpenCode's cost**: OpenCode prices each model step from its catalog (models.dev list prices) and
  reports it on the step (`opencode.cost`, not cumulative); a turn's cost is the sum of its steps
  (`costSource: "runtime"`, `"runtime-estimate"` through the AI Gateway). A model its catalog has no
  price for (a custom gateway's) reports 0: Polpo records tokens only. A gateway that reports its cost
  in a response header still wins.
- Claude Code sends its own system prompt and tool catalog (about 47k tokens) with every request;
  prompt caching makes later requests cheap (measured on Bedrock: $0.023 for a first 5-tool turn on
  Haiku 4.5, $0.007 for the next). Budget runs with `maxBudgetUsd`.
- The VM: about 640 MB of memory in use during a turn, the bridge about 92 MB between turns; 400 MB of
  disk for the bootstrap.
- With an API key or a gateway, the key stays on the Polpo server when the model relay is reachable
  (the VM has a placeholder). Bedrock / Vertex credentials, and every key when `POLPO_PUBLIC_URL` is
  not set, are visible to processes inside the VM: use a dedicated, scoped key per instance.
- Phase 1 runs **tasks**. Chats with an agent on a harness still run on Polpo's engine (with the
  agent's model). Codex has no budget limit and no Polpo-side cost (OpenAI does not report one in the
  stream). E2B and Daytona v0 computers are refused. Interactive approvals for `allow-edits` /
  `allow-reads` (a person answering in the dashboard) come later.
