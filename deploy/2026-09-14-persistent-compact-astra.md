# Persistent compact + Pi 0.85.1 — 2026-09-14

## Implementation

The Node host now supplies FileContextCheckpointStore to the completion route.
Sidecars live in `.polpo/context-checkpoints/<sessionId>.json` (0600 files,
0700 directory). Atomic rename and in-process compare-and-swap revisions
prevent a delayed request from overwriting a newer checkpoint.

The server fingerprints the covered request-history prefix, ignoring changing
timestamps and normalizing text-only content parts. On compatible requests it
restores the checkpoint followed by the uncovered messages. It invalidates
reuse on covered-history changes, shorter/different history, session identity
or agent/model changes. This is independent of web/mobile UI state and
survives backend/store reconstruction. Incompatible callers conservatively use
their supplied history instead of silently dropping or replacing messages.

Only the existing bounded extract of stable caller history is persisted;
in-flight native tool payloads (including potentially private vault results)
are excluded. Compaction has not been replaced with an LLM-generated semantic
summary. Original transcript and attachments remain untouched. The projected
history can compact again when NEW context grows beyond the model budget.

Hosts without the optional checkpoint adapter retain the existing behavior.
Sidecars for deleted sessions are inert: the completion route requires a
current session and scopes reuse by its creation timestamp. No transcript
cleanup or deletion was performed.

## Pi / Astra

- Updated root pi-ai and pi-agent-core, and packages/tools pi-agent-core, from
  0.84.2 to 0.85.1; lockfile updated with pnpm install --ignore-scripts.
- Both `openai:gpt-6-astra` and `openai-codex:gpt-6-astra` resolve to their
  native Responses adapters. Existing configured model defaults unchanged.
- A real, isolated Codex-subscription request using the current credentials
  returned `ASTRA_OK`, stopReason `stop`, reasoning `low`, no tools.
- Pi's current catalog advertises a conservative 272,000-token context window
  for Astra; we did not override it with the larger official model maximum.

## Validation

- Root tsc, server, tools, client SDK, React SDK builds and UI typecheck passed.
- 123 tests passed across compaction/checkpoint/completions, OAuth/profile
  storage, engine prompts, attachments and cross-device client events.
- Additional final checkpoint/cross-client and Astra catalog run: 8 tests pass
  (6 checkpoint tests and 2 Astra provider tests).
- 12 web composer tests pass.
- OpenAPI regenerated, 109 paths, no new public endpoint.
- Integration test uses a fresh app/store, full next-turn client history,
  verifies no repeated context_compaction event and unchanged visible history.

## Anthropic cooldown request

Reset only `anthropic:default` usage/cooldown state using the existing auth-store
helper. Previous state had errorCount 4 and lastErrorReason `refresh_failed`
despite a fresh login. Live Lumea `/api/v1/auth/status` then reported active,
errorCount 0. Credentials and other providers were not modified. This profile
store is global (`/home/alessio/.polpo/auth-profiles.json`). No provider-side
quota or rate limit was bypassed.

## Activation

Backend restart initially deferred because session `A4mfZRKH7y` still had a
live completion (`turn-ZGgXs_LB2i6Cua2d9K5G`), actively emitting tool updates.
Asked whether to wait or restart immediately. Until restart, the running
backend retains its previously loaded modules. Only Lumea is in restart scope;
Shoplix and Choosy were not restarted.

User selected waiting. The first live turn finished and another started in
the same session; waited for that one too. At 06:59:49 UTC all 165 session
active-turn probes were idle and processCount was 0. Restarted only
`polpo-lumea-server.service` (new PID 383585). Post-restart checks:

- Tailscale API health HTTP 200.
- Live `/api/v1/providers/models?provider=openai-codex` includes `gpt-6-astra`.
- Anthropic profile remains active, errorCount 0.
- Lumea API and UI systemd services both active.
- `git diff --check` passes. No git commit/push or EAS update needed/performed.
