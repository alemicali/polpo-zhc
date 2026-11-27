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
2. **The runner image `polpo-runner-vm-4`** in the Daytona project (pnpm 10.30.1, which the harness
   bootstrap needs, since vm-3; the live view's desktop since vm-4): `DAYTONA_V2_API_KEY=… node scripts/build-sandbox-images.mjs --provider daytona-v2`.
   Without it Polpo uses `polpo-runner-vm-3` (with pnpm); an older image gets pnpm activated with corepack at run time (about 1 s).
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
Responses API, `format: "openai-responses"`, base URL ending in `/v1`), or `"chatgpt"`: **sign in
with a ChatGPT account**, which OpenAI supports for Codex, also on headless machines
(`codex login --device-auth`, or a copy of `~/.codex/auth.json`:
[developers.openai.com/codex/auth](https://developers.openai.com/codex/auth)). The ChatGPT plan pays
for the work.

#### Codex signed in with ChatGPT

```json
"codex": { "auth": "chatgpt", "credentialRef": { "owner": "ops", "service": "codex-chatgpt" }, "model": "gpt-5-codex" }
```

- `credentialRef` is the vault entry that keeps Codex's **login cache**: a custom entry whose field
  `authJson` holds the whole `auth.json` (ChatGPT tokens). It may not exist before the first sign-in:
  the sign-in creates it. An agent's `engine.credentialRef` points it to its own entry (another
  ChatGPT account for that agent).
- **No API key is passed and nothing is brokered**: Codex gets an explicit, empty authentication
  environment (nothing from this server) and reads its own `auth.json`. Each agent has its own
  `CODEX_HOME` in its computer, `$HOME/.polpo-harness/codex/<agent>` (on this server, under the
  agent's isolated harness HOME).
- **Before a session** Polpo writes the vault's `auth.json` there (mode 600, directory 700, file
  storage: `cli_auth_credentials_store = "file"`) when the computer has none or an older one
  (`last_refresh`).
- **Write-back**: Codex refreshes its tokens inside `auth.json`. After each turn, at the end of the
  run and before the computer's VM goes away (hibernate, reset, delete), Polpo reads the file back
  and, when it changed and is not older than the vault's copy, saves it into the vault entry. The
  content is never logged; its tokens (`access_token`, `refresh_token`, `id_token`, an API key)
  are masked in transcripts and errors. A failed write-back is a warning in the run's log, never a
  failure of the run.
- **Signing in** (no files copied by hand): **Settings → Harnesses → Codex**, authentication
  *ChatGPT sign-in*, save, choose an agent on Codex and **Sign in with ChatGPT**. A terminal on the
  agent's computer (started if needed) runs `codex login --device-auth` with that agent's
  `CODEX_HOME`: open the link it shows, sign in with the ChatGPT account, enter the code. **Save
  sign-in** (also done when the dialog closes) captures the login into the vault. The card shows
  *signed in* / *not signed in* (whether the vault entry holds a login), never the login.
- Costs: tokens only (`costSource: "subscription"`), as for the CLI engine; the connection test
  says whether someone has signed in (no model request from this server: the login is used in the
  computer).
- REST: `GET /api/v1/harnesses/codex/chatgpt-login?agent=` (signed in, last refresh),
  `POST /api/v1/harnesses/codex/chatgpt-login { agent }` (the terminal to open:
  `/ws/terminal?agent=codex-chatgpt-login&harness_agent=<agent>`, the command, the vault entry),
  `POST /api/v1/harnesses/codex/chatgpt-login/capture { agent }` (reads `auth.json` from the agent's
  running computer into the vault: `updated`, `unchanged`, `missing`, `invalid` or `older`).
- MCP and Polpo's chat: `polpo_harnesses_update { codex: { auth: "chatgpt", credential_ref } }`,
  `polpo_harnesses_update { codex_chatgpt_login: { agent } }` (the dashboard link and the command),
  then `{ codex_chatgpt_login: { agent, capture: true } }`; `polpo_harnesses_get` says signed in or not.

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

REST: `GET /api/v1/harnesses` (with `relay`, each harness's `brokering`, and `chatgpt { signedIn }`
for Codex signed in with ChatGPT; see [Codex signed in with ChatGPT](#codex-signed-in-with-chatgpt)),
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

## CLI engine: the official Claude Code / Codex program on a personal plan

Besides the harnesses above (API keys, Bedrock, Vertex, gateways), an agent can run its tasks and
its chats through the **official, unmodified `claude` or `codex` program** signed in with **a
person's own plan** (Claude Pro/Max, ChatGPT Plus/Pro). This is the CLI engine:
`agent.engine: { type: "cli", cli: "claude" | "codex", account?, model?, permissionMode?, effort?, maxBudgetUsd?, args? }`
(`effort`: low…max, Claude Code `--effort`, Codex `model_reasoning_effort`, max → xhigh;
`maxBudgetUsd`: Claude Code `--max-budget-usd`, a bound on the CLI's own estimate).

### Parity with the harness engine

| | Harness engine (AI SDK) | CLI engine |
| --- | --- | --- |
| Polpo's tools (connectors with their accounts, register_outcome, artifacts, memory, data, messages, vault-granted tools, the task's tool scope, allowedTools) | host tools over the bridge | the same host tools (toHarnessHostTools over buildAgentToolset) as the run's MCP server: `--mcp-config` (Claude), `-c mcp_servers.polpo.*` (Codex) |
| Many tools: first request or tool search | `ENABLE_TOOL_SEARCH` false up to 40 tools, auto above | the same |
| Repository / account MCP servers | not loaded (`strictMcpConfig`) | not loaded (`--strict-mcp-config`) |
| Approvals | tasks: side-effect tools run; the runtime's own requests are denied | tasks: the same; chats: email/WhatsApp sends become the chat's preview (the person sends them) |
| Where | Daytona v2 computer (this server with `allowHost`) | this server, or a Daytona v2 / E2B computer |
| Remote transport | the bridge process (provider process API) | the provider's process API with **stdin** (Daytona v2 `stdin: "open"`, E2B `stdin: true`) |
| Chats | no (tasks only) | yes: streamed, steering, stop, one CLI conversation per chat session |
| Sessions view, stop, reset | `polpo_harness_sessions_list` / `_control` | the same (records with `engine: "cli"`, `cli`, `account`) |
| Continuations | resume the runtime's conversation | `--resume` / `thread/resume` |
| Cost | gateway, runtime estimate or tokens only | tokens, `costSource: "subscription"`, cost 0 |
| Failure classification | non-retryable auth/config errors | not signed in, usage limit, not installed: not retried |
| Effort / budget | `effort`, `maxBudgetUsd` | `effort`, `maxBudgetUsd` (Claude) |
| Run context (engine, model, computer, VM, session) | yes | yes (`claude-cli` / `codex-cli`, auth `subscription`) |
| Credential | an API key / gateway / cloud in the vault, brokered | the person's own sign-in in the account's directory, never read by Polpo |

### Why it is allowed, and what it does not do

- Anthropic's [Claude Code legal and compliance page](https://code.claude.com/docs/en/legal-and-compliance)
  lets a platform host **the unmodified Claude Code binary** when **each end user signs in with their
  own credentials** (their own Claude subscription included) **through Anthropic's own sign-in flow**.
  A platform must not collect, store or intermediate claude.ai credentials or tokens, nor route
  requests on behalf of other users. That is why the API-key harness above still refuses a Claude
  subscription (the Agent SDK with an OAuth token is not allowed), and why the CLI engine works as
  follows:
  - Polpo runs the official program as installed on the computer; it never patches, wraps or
    proxies its model traffic, and it never sees a token.
  - The person signs in themselves, in a terminal on the computer (`claude auth login`), completing
    Anthropic's sign-in in their own browser. Polpo only streams that terminal.
  - Polpo never reads, copies or backs up the credential files: the account's directory is not in
    the vault, not in Polpo's state, and excluded from Cloud sync (`.polpo-cli/**`).
  - **A personal sign-in runs only the work of the person who signed in** (see the policy guard).
- OpenAI lets Codex CLI users [sign in with ChatGPT](https://developers.openai.com/codex/auth);
  the same owner rule applies by default. An instance may opt in to sharing a Codex account
  (owner `"instance"`) with `settings.harnesses.cli.allowInstanceCodex: true`; the dashboard warns
  that a shared ChatGPT plan must be allowed by OpenAI's terms for that plan.
- T3 Code ([github.com/pingdotgg/t3code](https://github.com/pingdotgg/t3code)) uses the same
  approach: the user signs in with `claude auth login` / `codex login` on the machine, one config
  directory per account (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`).

### Accounts

An account is **a CLI config directory on one computer** — no secret is ever stored:

```jsonc
"settings": {
  "harnesses": {
    "enabled": [],
    "cli": {
      "accounts": [
        { "id": "ada-claude", "cli": "claude", "computer": "host",
          "configDir": "~/.polpo-cli/claude/ada-claude", "owner": "ada@example.com", "label": "Ada's Max" },
        { "id": "team-codex", "cli": "codex", "computer": "host",
          "configDir": "~/.polpo-cli/codex/team-codex", "owner": "instance" }
      ],
      "allowInstanceCodex": false
    }
  }
}
```

- `configDir` defaults to `~/.polpo-cli/<cli>/<id>` (`~` is that computer's home). Claude Code runs
  with `CLAUDE_CONFIG_DIR=<configDir>`, Codex with `CODEX_HOME=<configDir>`; `HOME` stays the
  computer's, so the official installers' locations (`~/.local/bin`) work.
- `owner` is the member who signs in (their email), or `"instance"`. The dashboard sets it to you
  when you add an account; nobody can create an account owned by someone else.
- Fields other than `id`, `cli`, `computer`, `configDir`, `owner`, `label` are refused (a token in
  the settings is an error).

**Settings → Harnesses → CLI accounts**: add an account (CLI, computer, label), see its installed
version and who is signed in (`claude auth status` JSON, `codex login status`), **Sign in** (a
terminal on this server running `claude auth login` or `codex login --device-auth` with the account's
directory and a minimal environment — none of the server's keys), **Sign out** (`claude auth logout`,
`codex logout`), **Install** when the program is missing (the official `npm install -g
@anthropic-ai/claude-code` / `npm install -g @openai/codex`, an explicit action), **Remove** (refused
while agents use it; the sign-in stays in its directory until you sign out). Only the owner can sign
in, sign out or remove a personal account. **On a remote computer** (Daytona v2, E2B) the same
**Sign in** opens the terminal on that computer: the provider's PTY (Daytona `sandbox.pty`, E2B
`pty`), streamed to the dashboard like the local one, running the login with the account's
directory; the computer is started when it is not running. Status, sign-out and install run there
too. The sign-in is written to that computer's disk: a Daytona v2 hibernation snapshot and an E2B
pause keep it; **a reset or a delete of the computer signs the account out** (sign in again), and an
ephemeral sandbox (no computer) cannot hold a sign-in.

REST (`/api/v1/harnesses/cli`): `GET /accounts` (with status; `?status=0` skips the checks),
`POST /accounts`, `PATCH /accounts/:id`, `DELETE /accounts/:id`, `GET /accounts/:id/status`,
`POST /accounts/:id/logout`, `GET /accounts/:id/login` (the terminal to open, on this server or on the account's computer),
`POST /install`, `PATCH /settings { allowInstanceCodex }`. The sign-in terminal is
`/ws/terminal?agent=cli-login&cli_account=<id>`. MCP: `polpo_harnesses_get` lists the accounts with
their status; `polpo_harnesses_update { cli: { add_account, remove_account, sign_out, install,
allow_instance_codex } }`; agents get the engine with `polpo_agent_create` / `polpo_agent_update`
(`engine: { type: "cli", … }`). Polpo's chat has the same through its harness tools.

### Policy guard

Before a run starts (and before the program is launched) Polpo checks the account against the work:

| The work | Account owned by a member | `"instance"` (Claude) | `"instance"` (Codex) |
| --- | --- | --- | --- |
| A task the owner created (dashboard, the API with their session, Polpo's chat or Polpo's MCP connector on their behalf) | runs | runs only without member sign-in (a personal install) | runs only with `allowInstanceCodex` |
| The tasks of a mission the owner started | runs | as above | with `allowInstanceCodex` |
| The runs of a schedule the owner owns (they created the mission or set its schedule) | runs | as above | with `allowInstanceCodex` |
| A chat with the agent by the owner | runs | as above | with `allowInstanceCodex` |
| Work of another member (their task, mission run, schedule, chat) | refused | refused when members sign in | with `allowInstanceCodex` |
| No known author (an API key, another agent's tools, a hook, an ownerless schedule) | refused | as above | with `allowInstanceCodex` |
| Channel customers, or an instance serving customers (a WhatsApp Business channel with audience `customers`) | refused | refused | refused (customers); allowed for an instance account with `allowInstanceCodex` on a customer-serving instance |

The refusal says why (Anthropic's terms, with the link) and what to use instead: an Anthropic API
key, Amazon Bedrock or Google Vertex AI (the Claude Code harness), or an OpenAI API key (Codex).
Who work is for is recorded: `Task.requestedBy` is the signed-in member who created the task (the
dashboard, the API, Polpo's chat or MCP connector acting for them), the member who started a
mission's run, or a schedule's owner; `Mission.owner` (shown as a schedule's `owner`) is the member
who created the mission or set its schedule. Channel turns and agents' own tools carry no member.

### How a run works

- **Claude Code**: `claude -p --input-format stream-json --output-format stream-json --verbose
  --replay-user-messages --permission-mode <mode> --append-system-prompt <Polpo's instructions>
  [--model m] [--resume <session>] [--max-turns n] [args…]` in the task's working directory. Each
  task prompt, follow-up and direction is a stream-json user message on stdin; the program echoes
  the messages it reads (`--replay-user-messages`), so a direction sent during a turn is known to
  be read. Output events (`system/init`, `assistant` text / thinking / `tool_use`, `user`
  `tool_result`, `result` with `usage` and `total_cost_usd`) become the run's transcript and activity.
  Permission modes: allow-all → `bypassPermissions`, allow-edits → `acceptEdits`, allow-reads →
  `default` (print mode cannot ask: what needs permission is denied).
- **Codex**: `codex app-server` (JSON-RPC over stdio, one object per line): `initialize`,
  `thread/start { cwd, model, approvalPolicy: "never", sandbox, developerInstructions }` (or
  `thread/resume` for a continuation), `turn/start`, `turn/steer` for a direction during a turn,
  `turn/interrupt`; notifications `item/started` / `item/completed` (agent messages, reasoning,
  commands, file changes, MCP and web tools), `thread/tokenUsage/updated`, `turn/completed`, `error`.
  Sandbox: allow-all → `danger-full-access`, allow-edits → `workspace-write`, allow-reads → `read-only`.
  An approval request is declined (the run is unattended).
- **Polpo's tools**: the run's MCP server (streamable HTTP, stateless, a per-run 256-bit token):
  on this server `http://127.0.0.1:<port>/mcp` with `Authorization: Bearer <token>`; for a remote
  computer `<POLPO_PUBLIC_URL>/api/v1/harness-relay/<token>/mcp`, the model relay's public route,
  piped to the run's unix socket (so `POLPO_PUBLIC_URL` must be set and that path exposed). Claude
  Code: `--mcp-config` + `--strict-mcp-config` + `--allowedTools=mcp__polpo` (its tools are named
  `mcp__polpo__<tool>`); Codex: `codex -c mcp_servers.polpo.url=… -c
  mcp_servers.polpo.bearer_token_env_var="POLPO_MCP_TOKEN" -c mcp_servers.polpo.tool_timeout_sec=900
  app-server` (the token only in the environment). The token is revoked when the run (or the chat
  turn) ends. The transcript names them by their Polpo name, marked as Polpo's tools.
- **Where**: this server (a child process in its own process group, killed with everything it
  started on kill or timeout), or a Daytona v2 / E2B computer: the provider's process API with the
  program's stdin open (`stdin: "open"` / `stdin: true`), the same transport as the harness bridge;
  a provider without process input falls back to an inbox file read through `tail -f`. The account
  must be on the agent's computer.
- **Cost**: tokens are recorded (usage store, run context) with `costSource: "subscription"` and cost
  0 — the plan pays. Claude Code's own `total_cost_usd` estimate is in the transcript, not billed.
- **Errors**: "not signed in" (or an expired sign-in) and "usage limit reached" fail the run without
  retries, saying how to sign in again or when to try again; a missing program says to install it.
- **Continuations** resume the CLI's conversation (`--resume <session>`, `thread/resume`): the
  conversation id is kept in the run's harness session record (`.polpo/harness-sessions.json`, key
  `cli:task:<id>`; ids only).
- **Sessions**: every CLI run and chat is a harness session record (`engine: "cli"`, `cli`,
  `account`, state, turns, tokens): `GET /harnesses/sessions`, `polpo_harness_sessions_list`; stop
  ends a live run's program (a task run in a runner process: kill the task), reset forgets the
  conversation (the next run starts a new one).

### Chats

An agent on the CLI engine answers its chats with the same program and account: each chat turn
starts the program, resumes the chat's own CLI conversation (one per chat session, key
`cli:chat:<agent>:<session>`; the first turn gets the chat so far as context), streams text,
reasoning and tool calls into the chat, and ends. A message typed while it works (a steer) reaches
it at once; Stop ends the turn (the conversation stays). Polpo's tools are there as in tasks; a
message to a person (`email_send`, `whatsapp_send`) becomes the chat's preview card and the person
sends, changes or cancels it. The account answers only its owner's chats (the signed-in member);
channel turns (WhatsApp, Telegram…) are refused. The CLI handles its own context (no manual
compaction). Tokens go to the usage store as `agent_chat`, cost 0.

### Coding chats

The Coding app's Claude Code and Codex sessions run on the CLI engine too, in a worktree, with the
account of the person who opens them (the same policy guard), as a chat with in-chat approvals of
risky actions (Claude Code's `--permission-prompt-tool` answered by a Polpo MCP tool; Codex's
`approvalPolicy: "on-request"` requests): see [coding.md](coding.md).
