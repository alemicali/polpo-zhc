# Web input fix and Pi / compaction audit — 2026-09-14

## Implemented and served

The composer awaited `send()` through the entire streaming response before
acknowledging its draft. The server persists the user message and attachments
before its first SSE role chunk. The web hook now invokes an optional
`onAccepted` callback once on that chunk, before migrating a newly created
session. PromptInput's explicit, idempotent acknowledgement clears only the
submitted draft/attachments and emits an input event to synchronize composer
state. Failed sends/conversions retain input. Current provider values and a
submission ownership key protect edits and other chats from late callbacks.
Duplicate submissions during attachment conversion are guarded.

Validation:

- `pnpm exec vitest run --config ui/vitest.config.ts`: 12 tests passed, real
  React DOM with jsdom; provider/uncontrolled modes, early acknowledgement,
  subsequent drafts, failure/retry, duplicate submit, chat ownership,
  submitted/new attachments, failed conversion.
- Root `./node_modules/.bin/tsc`, UI typecheck and production build passed.
- Targeted completions / context-compaction / pi-oauth-runtime: 37 tests passed.
- Browser reproduction on the actual production bundle with delayed mock SSE:
  second prompt in the same session stayed populated before fix; after fix
  it cleared while the stream remained open. A subsequent draft survived
  stream completion and an HTTP 503 rejected send.
- Browser mocks injected before SDK construction in a temporary static server
  with GET-only API forwarding. This avoids the SDK's captured-fetch bypass.
  An earlier live smoke request created QA session `LtFUs_W3`; it completed.
  Temporary queued QA text was removed. Browser and temporary server closed.
- Screenshots: `/tmp/polpo-composer-before.png`, `/tmp/polpo-composer-after.png`.
- Live Lumea web endpoint HTTP 200, serving `assets/app-D0LPq5iR.js`.
  No backend restart. The UI dist directory is shared by configured instances.

## Pi update findings — not installed

Root pi-ai / pi-agent-core and tools' pi-agent-core are on 0.84.2. npm latest
for both packages is 0.85.1. The installed built-in catalogs do not contain
`gpt-6-astra` for either `openai` or `openai-codex`.

Pi 0.85.1 (2026-09-05) explicitly adds GPT-6 Astra for API keys and Codex
subscriptions, plus a GPT-5.6+ Responses prompt-cache TTL fix. 0.85.0 also
fixes terminal Codex SSE events lacking a blank-line delimiter. Breaking
changes in the intervening versions include Cloudflare binding helper and
Google thinking-level type renames; no use of those names found in our main
Pi integration. An actual upgrade still requires coordinated package changes,
build/tests, and account-specific model access validation. No credentials,
model defaults or dependency versions were changed by this audit.

Sources:

- https://github.com/earendil-works/pi/blob/main/packages/ai/CHANGELOG.md
- https://www.npmjs.com/package/@earendil-works/pi-ai
- https://developers.openai.com/api/docs/models/gpt-6-astra

## Repeated compaction — diagnosed, not fixed

`packages/server/src/routes/completions.ts` builds piMessages afresh from
`body.messages` for every HTTP request. `prepareContext` compacts a local
`messages` array inside that request; it does not persist or restore a
session checkpoint. Web `streamCompletion` keeps sending its full conversation
history. A history above the soft limit can therefore trigger compaction on
each new message. The displayed notice is not proof of a durable checkpoint.

`summarizeContextMessages` in `packages/core/src/context-compaction.ts` creates
a bounded, truncated extract (24,000 characters by default), not a model-made
semantic summary. The current compaction tests cover a single request and
overflow recovery, not checkpoint reuse on the next request.

Required follow-up: durable per-session checkpoint plus an exact covered-history
boundary, retaining the original user-visible transcript separately. Subsequent
requests must use checkpoint + post-boundary messages across web/mobile/restarts,
with explicit invalidation for history edits and a multi-turn regression test.
Pi upgrade alone will not fix this application-owned projection logic.
