# Agent harnesses: Claude Code and Codex as an agent's engine

An agent can run its tasks on an official agent runtime instead of Polpo's own engine:
**Claude Code** (Anthropic) or **Codex** (OpenAI). The runtime runs **inside the agent's computer**
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

**A Claude subscription (Pro/Max sign-in, `sk-ant-oat…` tokens) is refused** — in the settings and in
the vault entry. Anthropic's consumer terms do not allow a subscription to power a product that runs
agents for other people; use an API key, Bedrock or Vertex (billed to that account).

Authentication is always **explicit**: Polpo hands the adapter an authentication environment, so it
never looks at this server's `process.env`, `~/.claude/settings.json` (`apiKeyHelper`), the native
subscription store or `~/.codex/auth.json`.

### Codex: authentication

`auth: "api-key"` with an OpenAI API key (`apiKey` or `OPENAI_API_KEY` in the entry). Signing in with
ChatGPT is not supported yet.

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

- `engine`: `"polpo"` (default) or `{ harness, model?, permissionMode?, effort?, maxBudgetUsd? }`.
  `permissionMode` `allow-all` (default: the runtime works unattended in its VM), `allow-edits` or
  `allow-reads`; in a task nobody answers an approval, so an action the mode does not allow is
  denied and the runtime is told to do it another way. `maxBudgetUsd` stops a run when Claude Code's
  spend estimate passes it.
- Checked when saved (config file, `PATCH /api/v1/agents/:name`, `PATCH /api/v1/config/settings`,
  MCP) and again before every run: the harness must be enabled, the agent's computer must be able
  to run it, secrets are never accepted in the settings, a harness that agents use cannot be
  disabled.

Dashboard: **Settings → Harnesses** (enable, authentication, credential via the vault picker, region,
model, allow on this server; the harness sessions with Stop / Reset) and the agent's **Computer tab →
Engine** (Polpo / Claude Code / Codex, model, permission mode, effort, budget; only enabled
harnesses are offered).

MCP (see [mcp.md](mcp.md)): `polpo_harnesses_get`, `polpo_harnesses_update` (admin; a missing
credential entry comes back as `setup_url` + `setup_id` for `polpo_setup_wait`),
`polpo_harness_sessions_list`, `polpo_harness_session_control` (work), and `engine` on
`polpo_agent_create` / `polpo_agent_update`.

REST: `GET /api/v1/harnesses`, `GET /api/v1/harnesses/sessions?agent=&computer=`,
`POST /api/v1/harnesses/sessions/:key/stop`, `POST /api/v1/harnesses/sessions/:key/reset { confirm: true }`.

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
   Polpo tools load with the first request (`alwaysLoad`), not behind Claude Code's tool search.
4. The turn streams into the run's transcript (text, reasoning, every tool call and result, the
   runtime's own tools and Polpo's) and its activity (tool calls, files written or edited). Secrets
   are scrubbed from everything written.
5. Usage and cost: each turn's tokens (input, cached, output) go to the task's activity, and a
   token-usage record (`source: "agent_harness"`) carries the runtime's cost estimate (Claude Code
   reports it cumulatively per session; Polpo records the difference). `GET /api/v1/token-usage`
   adds it to the cost (`harnessCost`).
6. Deliverables: what the runtime registers with `register_outcome`, and the output directory
   copied back like any remote run.
7. Directions: a follow-up runs as the next turn; a steer goes to the running turn; kill aborts it.
8. At the end the runtime stops (its bridge exits); its conversation stays in the VM, and a
   continuation of the task ("continue" direction) resumes it.

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

## Costs and limits

- Claude Code sends its own system prompt and tool catalog (about 47k tokens) with every request;
  prompt caching makes later requests cheap (measured on Bedrock: $0.023 for a first 5-tool turn on
  Haiku 4.5, $0.007 for the next). Budget runs with `maxBudgetUsd`.
- The VM: about 640 MB of memory in use during a turn, the bridge about 92 MB between turns; 400 MB of
  disk for the bootstrap.
- The credential is visible to processes inside the VM (the runtime needs it); use a dedicated,
  scoped key per instance.
- Phase 1 runs **tasks**. Chats with an agent on a harness still run on Polpo's engine (with the
  agent's model). Codex has no budget limit and no Polpo-side cost (OpenAI does not report one in the
  stream). E2B and Daytona v0 computers are refused. Interactive approvals for `allow-edits` /
  `allow-reads` (a person answering in the dashboard) come later.
