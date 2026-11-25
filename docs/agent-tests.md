# Agent tests

An agent's **Tests** tab checks everything the agent has at its disposal before you rely on it:
its engine and model, its tools, connectors, vault references, skills, computer and sandbox,
the channels routed to it and its versions. Each check runs on its own (**Run**) or with the
others (**Run all**) and returns ✓ pass, ⚠ warn or ✗ fail, with the details and, when there
is one, a fix: a link to the setting, or a one-click action.

Runs are kept per agent (the last 50, in `.polpo/agent-tests/<agent>.json`) with their time,
who ran them, the target and the version tested: the **History**.

## Checks

| Check | What it does | Fails / warns when |
|---|---|---|
| `engine` | A minimal real request with the agent's actual engine and auth (a few tokens). Polpo's engine: one tiny completion with the agent's model (`queryText`). A harness (Claude Code, Codex, OpenCode): the harness connection test (`POST /harnesses/test`, same code) with the agent's engine, so its own credential and model count; API key, Bedrock, Vertex and gateways alike. The CLI engine: the account's installed version and sign-in status (`claude auth status` / `codex login status`, as `GET /harnesses/cli/accounts/:id/status`) and the owner policy guard for the person testing. Shows the model and the latency. | the request fails (auth, model access, network…); the harness is not enabled or cannot run there; the CLI is not installed or not signed in (✗); the policy would refuse work the person starts (⚠) |
| `tools` | Every `allowedTools` entry (globs too) resolves to a real built-in tool; `mcp__…` entries are checked under Connectors; the built-in tools left out stay blocked. | a name matches no tool (a typo) or a glob matches nothing (⚠) |
| `connectors` | Each connector the agent can use (access lists the agent or `*`) is tested as the connector's **Test** does (connect, auth, list tools); how many of its tools reach the agent after the connector's tool policy (`off` = blocked), `connectorTools` and `allowedTools`. Each connector named in `allowedTools` (`mcp__printful__*`) or `connectorTools` must grant the agent. | a connector named in `allowedTools` whose access leaves the agent out (✗, **one-click fix: grant access**); a connector that cannot connect or needs a new sign-in (✗); granted but none of its tools reaches the agent, unknown or disabled connector, selected tools the server does not have (⚠) |
| `vault` | The agent's entries (names only, never values; shared ones marked), the vault references of its engine (`engine.credentialRef`, the harness credential and secret gateway headers), and the `env_from_vault` mappings (`{ "VAR": "service.key" }`) written in its instructions and skills. | a referenced entry or field does not exist (✗) |
| `skills` | Each assigned skill loads (SKILL.md and its bundled files); the skill versions pinned by the tested version exist. | a skill is missing or unreadable, a pinned version was removed (✗) |
| `computer` | The default computer: this server, or a remote one's live status (a stopped machine is **never started** unless you click **Start and test**, which may cost); the sandbox provider (key configured and found, the provider test when the machine is not running); the egress proxy (reachable from this server) or, for a remote computer with egress, its tailnet status (the existing egress check). | unknown computer, provider without its key, proxy unreachable, tailnet down (✗); a computer that is not running (⚠, offers **Start and test**) |
| `channels` | Channel routes dedicated to the agent (`gateway.agent`): the channel runs. | inbound off (⚠); the channel is not running, `replyTo` names a missing channel (✗) |
| `versioning` | The production version and the draft. | no version deployed, a stale draft (based on a version production no longer runs: rebase or discard) (⚠) |
| `smoke` | **Only on an explicit click** (it costs a real turn): a tiny chat turn that asks the agent to call one harmless tool (`register_outcome`) and reply, checked end to end (the reply, the tool called and completed). The test chat is deleted afterwards. | no reply or the tool failed (✗); the tool was not called (⚠) |

**Run all** runs every check but `smoke`. A check that throws fails on its own; the others still run.

## Targets

A run tests **production** (what runs; the default), the **draft** (the unpublished working copy)
or a **published version** (`1.2.0`), so a version can be tested before it is deployed. The smoke
run chats with `agent@draft` or `agent@1.2.0` (the completions API accepts `@draft` too).

## Fixes

A check's item may carry `fix`: `href` (a dashboard path, e.g. `/config?section=harnesses`) or
`action`. The one action today is `grant-connector-access`: it adds the agent to the connector's
`access.agents` (`POST /agents/{name}/tests/fix`), then the dashboard runs the check again.

## Surfaces

| Surface | How |
|---|---|
| Dashboard | Agent page → **Tests**: target (production, draft, a version), Run all, Run per check, problems with their fixes (open a row for every item), **Run smoke test** and **Start and test** after a confirmation, History (a past run opens) |
| REST | `POST /api/v1/agents/{name}/tests` `{ checks?, target?, startComputer?, smokePrompt? }` → the run; `GET /api/v1/agents/{name}/tests?limit=` the history; `GET /api/v1/agents/{name}/tests/{id}`; `POST /api/v1/agents/{name}/tests/fix` `{ type: "grant-connector-access", connector }` (OpenAPI: tag "Agent tests") |
| MCP | `polpo_agent_test` (`name`, `checks`, `target`, `start_computer`, `smoke_prompt`, `history`, `fix_connector`): the `polpo:read` scope runs the checks; the smoke run and the fix need `polpo:admin` |
| Polpo's chat | `agent_test` (group "agent-versions": "test the shop agent", "why doesn't the shop agent see Printful?") |
| SDK | `runAgentTests(name, req)`, `getAgentTests(name, { limit })`, `getAgentTest(name, id)`, `fixAgentTest(name, action)`; React `useAgentTests(name)` → `{ history, latest, running, runAll, runOne, fix }` |

## Safety

- No secret value is ever read into a result: vault checks compare entry and field **names**.
- The engine check costs a few tokens; the smoke run a short turn; neither runs on its own.
- A stopped remote computer is started only with `startComputer: true` (the **Start and test** button).
- The connector check connects to each granted connector exactly as its **Test** button does.
