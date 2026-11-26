# Triggers

A **trigger** is a public endpoint that receives events from outside Polpo — a form submission (Tally, Typeform, Google Forms through a relay), any service's webhook — checks who sent it, parses and validates it, filters and de-duplicates it, and records it as a **delivery** with the values an action would receive.

> **Actions arrive with the action engine.** This is the primitive only: registration and reception. A delivery is recorded and announced on the event bus (`trigger:delivery`), but nothing runs — no mission, playbook, task, agent turn or notification. The engine, when it comes, will subscribe to that event and use each delivery's **mapped** values. Until then the dashboard shows exactly what an action would have received.

Triggers are not channels: a channel is a conversation (Telegram, WhatsApp, the webhook channel for outbound notifications and iOS Shortcuts chats). A trigger never answers with a message and never goes through the channel gateway.

## The endpoint

```
POST <public URL>/hooks/{id}
```

- `{id}` is a slug with a random suffix (`tally-signup-3f9a1c2e`): endpoints are not guessable.
- Only `POST`. The answer is JSON:

| HTTP | Body | When |
|---|---|---|
| `202` | `{ "deliveryId", "status": "accepted" }` | recorded |
| `202` | `{ "deliveryId", "status": "filtered" }` | recorded, the filter did not match |
| `200` | `{ "deliveryId": <the original>, "status": "duplicate", "duplicateDeliveryId" }` | same dedupe key within the window |
| `400` | `{ "deliveryId", "status": "rejected", "error", "errors": [...] }` | not JSON / form / multipart it claims to be, or the contract's JSON Schema failed (`errors`: one line per problem, e.g. `body.email: required`) |
| `401` | `{ "deliveryId", "status": "rejected", "error": "Unauthorized" }` | missing or wrong secret, bad or missing signature, timestamp outside the tolerance |
| `404` | `{ "error": "Not found" }` | unknown or disabled trigger, or a sender outside the IP allowlist (existence is not leaked) |
| `413` | `{ "deliveryId", "status": "rejected", "error" }` | body (or a multipart file) over the limit |
| `415` | `{ "deliveryId", "status": "rejected", "error" }` | content type not accepted by the contract |
| `429` | `{ "error", "retryAfter" }` + `Retry-After` | over the trigger's rate limit |

### Publishing it (Tailscale Funnel)

Instances are tailnet-only; only listed paths are public. `/hooks/` is the **only** public prefix of this feature — it lives outside `/api` and outside the instance's auth gate (the trigger authenticates its own senders). Behind Tailscale Funnel with a path per instance (`POLPO_PUBLIC_URL=https://<host>/<instance>`), publish it once for every trigger:

```
tailscale funnel --bg --set-path /<instance>/hooks http://127.0.0.1:<port>/hooks
```

Funnel strips the mount path, so `/<instance>/hooks/{id}` reaches Polpo as `/hooks/{id}`. Set `POLPO_PUBLIC_URL` so the dashboard, the API (`endpoint`) and the MCP tools show the full URL (`…/hooks/{id}`); without it they show the path only. Remove it with `tailscale funnel --bg --set-path /<instance>/hooks off`.

## Authentication

Every configured method must pass; a trigger with neither a secret nor an HMAC signature is refused (never open).

- **Generated secret** (default). Polpo makes `pts_…` (32 random bytes), **shows it once** and keeps only its SHA-256 hash (and a hint, `pts_Ab12…`). Senders send `Authorization: Bearer <secret>` or `X-Polpo-Secret: <secret>`. `?token=<secret>` is accepted only when **allowQueryToken** is on (for senders that cannot set headers — URLs end up in logs). Comparisons are constant-time.
- **Rotation with overlap.** Rotating makes a new secret (shown once); the previous keeps working for the overlap (default one day, up to seven; `0` revokes it at once). The dashboard shows each valid secret's hint and expiry.
- **HMAC signature** — generic, for GitHub, Typeform, Stripe-style and custom senders:
  - `header` (e.g. `x-hub-signature-256`, `typeform-signature`), `algorithm` `sha256` | `sha1`, `encoding` `hex` | `base64`, optional `prefix` (e.g. `sha256=`, stripped before comparing). A header with several signatures (`t=…,v1=…`, comma or space separated) passes when one matches.
  - Optional `timestampHeader` (unix seconds or ms, or ISO) and `toleranceSeconds` (default 300): deliveries outside the tolerance are refused (replays, clock skew).
  - `signedPayload`: what is signed — `{body}` (default, the **raw body byte for byte**) or a template such as `{timestamp}.{body}` or `v0:{timestamp}:{body}`.
  - The **signing secret lives in the vault** (owner `$triggers`), set from the dashboard or `PUT /api/v1/triggers/{id}/hmac-secret { secret }` — never echoed. `{ generate: true }` makes one and returns it once. Setting a new one keeps the previous valid for the overlap. Over MCP the secret is entered on the dashboard through a setup link (`setup_id: trigger:<id>:hmac`), never in chat.
- **IP allowlist**: CIDRs or single addresses, IPv4 and IPv6. Behind a local proxy (Tailscale serve / Funnel, a reverse proxy on a private address) the sender's address is the **last** `X-Forwarded-For` entry — the one the proxy added, which the sender cannot forge; otherwise the socket's.

## The contract

What a delivery must look like:

- `contentTypes`: `json` (`application/json`, `*+json`), `form` (`application/x-www-form-urlencoded`: fields, repeated names become lists), `multipart` (`multipart/form-data`: fields, and files as metadata — name, field, type, size, SHA-256; their content is not kept), `text` (`text/*`).
- `maxBodyBytes` (default 256 KB, at most 10 MB; checked on `Content-Length` and while reading) and `maxFileBytes` (multipart, per file; default 5 MB).
- `schema`: a JSON Schema for the parsed body, validated with the same validator as agent suites (`type`, `required`, `properties`, `additionalProperties`, `enum`, `const`, `pattern`, min / max, items, `allOf` / `anyOf` / `oneOf` / `not`). A mismatch is answered `400` with the list of errors and recorded as `rejected` (with its body, to fix the contract or the sender).
- **Infer from a sample**: paste a delivery (or pick a recorded one) and Polpo infers a schema — types, `required` for every key present, `format` for emails, dates, date-times and URLs, list items merged — which you edit before saving. The dashboard shows it as JSON or YAML.
- **Versions**: every contract change is a new version (`contractVersion`), kept with who and a note; any two are diffed (`GET …/contract-versions/diff?from=1&to=2`). Each delivery records the version it was checked against.

## Filter

Optional conditions on the delivery; paths start with `body`, `headers` or `query` (`body.data.fields[0].value`, `headers.x-github-event`, `query.source`). Operators: `equals`, `not_equals`, `contains` (text comparisons case-insensitive), `in` (a list), `gte` / `lte` (numbers), `exists`, `not_exists`; `mode` `all` (default) or `any`. Deliveries that do not match are recorded as **filtered** (`202`). The comparisons are the hosted MCP servers' response filters: no expressions, no eval.

## Dedupe

A template key (`{{body.submission_id}}`, `{{headers.x-request-id}}`, `{{body.event}}-{{body.id}}`) and a window (`ttlSeconds`, up to seven days). A delivery whose key was seen within the window is recorded as **duplicate** and answered `200` with the **original** delivery's id; only a hash of the key is stored. A key whose values are missing does not dedupe.

## Rate limit

Requests per minute per trigger (default 60, up to 6000), a sliding window. Beyond it: `429` with `Retry-After`. Refusals are recorded as one `rate_limited` delivery a minute, counting them.

## Mapping

Named fields → templates over `body`, `headers` and `query` — what an action will receive. The templates are the hosted MCP servers' (`{{body.email}}`, `{{query.utm ?? "direct"}}`, `Hi {{body.name}}`): a template that is a single placeholder keeps its JSON type (a list stays a list). Every accepted, filtered or duplicate delivery stores its **mapped** values; the dashboard previews them on a sample before you save. Nothing is executed.

## Deliveries

Each request is recorded (newest first, the newest `retention` kept — default 500, at most 5000; older ones and their files are pruned):

- `id`, `receivedAt`, `status` (`accepted`, `rejected`, `filtered`, `duplicate`, `rate_limited`), `httpStatus`, `reasons`, contract `errors`, `test` (sent from the dashboard / API / a tool), `ip`, how it authenticated (`secret` via bearer / header / query and which one, `hmac` current / previous);
- `headers` with secrets redacted (authorization, cookies, signatures, tokens, keys, the trigger's signature header), the `query` (a `token` redacted);
- the parsed **body**, keys that look secret redacted, capped at 64 KB (`bodyTruncated`); refused-before-authentication deliveries keep **no body**;
- `files` (multipart metadata), `mapped` and `mappingErrors`, the `contractVersion`, `duplicateOf`.

Each recorded delivery is announced as **`trigger:delivery`** on the orchestrator's bus (SSE, notification rules, hooks): `{ triggerId, deliveryId, status, httpStatus, test?, mapped? }`. Changes to triggers are `trigger:changed`.

Storage: `.polpo/triggers/<id>/` — `trigger.json` (definition; secrets as hashes), `contracts.json` (versions), `deliveries/index.json` + one file per delivery, `dedupe.json` — per instance, whatever its store, no table or migration.

## Test tools

- **Send a test delivery** — through the contract, filter, dedupe and mapping (no secret, IP or rate check), recorded with `test: true` and announced like a real one.
- **Validate a sample** — against the saved contract, filter, dedupe and mapping or a **draft** of them; nothing is recorded.
- **Infer a schema** — from a sample or a recorded delivery.
- **Replay a delivery** — a recorded delivery through the current (or a draft) contract, filter, dedupe and mapping: a dry run showing the status, errors and mapped values it would get now. Nothing is recorded and no action runs.

## Surfaces

- **Dashboard**: **Triggers**, next to Schedules — the list (status, endpoint, auth, counts, last delivery), New trigger (the secret shown once), and a trigger's sheet: Overview (copyable endpoint and curl), Auth (rotation, HMAC and its secret, IP allowlist), Contract (content types, sizes, schema as JSON / YAML, inference, validation, versions and diffs), Rules (filter, dedupe, limits, mapping with a preview) and Deliveries (by status, payload, errors, mapped values, replay, send a test).
- **REST** `/api/v1/triggers` (see OpenAPI): `GET/POST /`, `POST /infer-schema`, `GET/PATCH/DELETE /{id}`, `POST /{id}/rotate-secret`, `PUT/DELETE /{id}/hmac-secret`, `GET /{id}/contract-versions[/diff]`, `GET /{id}/deliveries[/{deliveryId}]`, `POST /{id}/deliveries/{deliveryId}/replay`, `POST /{id}/test`, `POST /{id}/validate`, `POST /{id}/infer-schema`.
- **MCP** (toolset `automation`): `polpo_triggers_list`, `polpo_trigger_get` (versions, diffs), `polpo_trigger_deliveries` (`polpo:read`); `polpo_trigger_create`, `polpo_trigger_update`, `polpo_trigger_delete` (`confirm: true`), `polpo_trigger_test` (send, validate, infer_schema, replay) (`polpo:work`; a generated secret is shown only to `polpo:admin`); `polpo_trigger_auth` (rotate the secret — shown once —, the secret's settings, HMAC configuration with a setup link for its secret, IP allowlist) (`polpo:admin`); and the **trigger card** `polpo_trigger_show` (an MCP App: the triggers, or one with its recent deliveries and the last mapped values).
- **Polpo's chat**: `triggers_list`, `trigger_get`, `trigger_deliveries`, `trigger_create`, `trigger_update`, `trigger_delete`, `trigger_test`, `trigger_auth` (the *triggers* tool group).
- **SDK / React**: `getTriggers`, `createTrigger`, `updateTrigger`, `deleteTrigger`, `rotateTriggerSecret`, `setTriggerHmacSecret`, `getTriggerDeliveries`, `getTriggerDelivery`, `sendTriggerTest`, `validateTriggerSample`, `replayTriggerDelivery`, `inferTriggerSchema`, `getTriggerContractVersions`, `diffTriggerContract`; hooks `useTriggers` and `useTriggerDeliveries` (live on `trigger:changed` / `trigger:delivery`).

## Examples

### A Tally / Typeform-style form

Create the trigger, accept JSON, validate the fields you rely on, dedupe on the submission id and map what an action will need:

```bash
curl -X POST "$POLPO/api/v1/triggers" -H "Authorization: Bearer $POLPO_API_KEY" -H 'content-type: application/json' -d '{
  "name": "Signup form",
  "contract": { "contentTypes": ["json"], "schema": {
    "type": "object", "required": ["eventId", "data"],
    "properties": { "eventId": { "type": "string" }, "data": { "type": "object", "required": ["fields"] } } } },
  "filter": { "conditions": [{ "path": "body.eventType", "op": "equals", "value": "FORM_RESPONSE" }] },
  "dedupe": { "key": "{{body.eventId}}", "ttlSeconds": 86400 },
  "mapping": { "email": "{{body.data.fields[0].value}}", "name": "{{body.data.fields[1].value}}", "submittedAt": "{{body.createdAt}}" }
}'
# → { "trigger": { "id": "signup-form-3f9a1c2e", "endpoint": "https://host/acme/hooks/signup-form-3f9a1c2e", … }, "secret": "pts_…" }
```

Then in the form's webhook settings: the endpoint URL, and either a header `Authorization: Bearer pts_…` or — for Typeform, which signs instead — turn the secret off and configure the signature: header `typeform-signature`, `sha256`, `base64`, prefix `sha256=`, and paste Typeform's secret on the dashboard. Tally signs with `tally-signature` (`sha256`, `base64`, no prefix).

### A generic HMAC sender

```bash
SECRET='the-shared-signing-secret'
BODY='{"event":"order.paid","id":"ord_123","amount":4200}'
TS=$(date +%s)
SIG=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | sed 's/^.* //')
curl -X POST "https://host/acme/hooks/orders-8c1d22aa" \
  -H 'content-type: application/json' -H "x-timestamp: $TS" -H "x-signature: sha256=$SIG" -d "$BODY"
```

with the trigger's auth: `{ "secret": false, "hmac": { "header": "x-signature", "algorithm": "sha256", "encoding": "hex", "prefix": "sha256=", "timestampHeader": "x-timestamp", "toleranceSeconds": 300, "signedPayload": "{timestamp}.{body}" } }` and the signing secret set with `PUT /api/v1/triggers/orders-8c1d22aa/hmac-secret`.

### Watching deliveries

```ts
import { PolpoClient } from "@polpo-ai/sdk";
const polpo = new PolpoClient({ baseUrl: "http://localhost:3000", apiKey: process.env.POLPO_API_KEY });
const page = await polpo.getTriggerDeliveries("signup-form-3f9a1c2e", { status: ["accepted"] });
const last = await polpo.getTriggerDelivery("signup-form-3f9a1c2e", page.deliveries[0].id);
console.log(last.mapped); // { email: "ada@example.com", name: "Ada", submittedAt: "…" }
```

## Security notes

- Constant-time comparisons for secrets and signatures; HMACs over the raw bytes as received.
- Secrets never appear in definitions, deliveries, events or logs: generated secrets are stored hashed, HMAC secrets in the vault; secret headers and query tokens are redacted on every record.
- Bodies are capped while reading (`413` before the limit is exceeded in memory) and only stored once the sender is authenticated.
- No eval anywhere: filters are fixed comparisons and templates are path lookups.
