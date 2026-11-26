# Decisions

`decide()` asks a **decision model** — a "System One" model such as TypeSafe's Jev — typed
questions about a state and gets **probabilities** back, instead of a chat completion. It is cheap,
fast and calibrated: use it for classification, routing, yes/no checks, ratings and rankings.

```
decide({ state, questions, model?, thresholds?, fallback? })
  → { id, answers, model, usage, costUsd, calibrated, latencyMs, uncertain }
```

Every surface uses the same service: REST, MCP, Polpo's chat, the agents' `decide` tool, mission
and playbook **decision nodes**, and the agent suites' **decision scorer**. Every call is in the
**decision log**.

## Questions

| Type | Asks | Answer |
| --- | --- | --- |
| `predicate` | yes / no | `value` (P(yes) ≥ 0.5) and `probability` = P(yes) |
| `choice` | one of `choices` (2–20, `{ value, description }`) | `choice` and `probabilities` per option |
| `score` | a level of `levels` (2–11, ordered, lowest first) | a fractional `score` (0 … levels − 1), the nearest `level`, `probabilities` per level |
| `rank` | sort `items` (2–20) | `ranking`, best first (composite: one `score` per item on `levels`, default a 5-level fit scale) |

A question has a `name` (letters, digits, `_`, `-`; unique in the call), `instructions` and an
optional `threshold` (0..1). The request's `thresholds` is a number for every question or
`{ name: number }`; a question's own wins. **`confidence`** is the provider's confidence when it
gives one, else the probability of the answer given (a rank: its lowest item). Below the threshold
— or with a threshold and no confidence at all — the answer is **`uncertain`**, and so is the result.

The **state** is text or JSON (an object or array, at most 100 000 characters as text).

Limits: 16 questions, 40 once ranks are expanded.

## The decision model

`settings.decisionModel` in `.polpo/polpo.json` (Settings → **Decisions**):

```jsonc
"decisionModel": "vercel-ai-gateway:typesafe-ai/jev"
// or
"decisionModel": {
  "gateway": "vercel-ai-gateway",
  "model": "typesafe-ai/jev",
  "credentialRef": { "owner": "polpo-infra", "service": "vercel-ai-gateway" },  // the key in the vault
  "credentialField": "token",                                                      // default: apiKey, key or token
  "fallback": { "model": "openai/gpt-6-luna", "confidenceBelow": 0.6 },           // or just a model id: on errors only
  "zeroDataRetention": true
}
```

A request may pass its own `model` (the configured key is used when it is on the same gateway).

### Gateways and keys

Decisions go through the **shared gateway resolver** (`@polpo-ai/core` `gateways.ts`). The gateways
are the custom-provider presets of kind *gateway* with a fixed official host; today **Vercel AI
Gateway** offers decisions. The resolver gives a gateway's base URL, the hosts its key may be sent to
(`ai-gateway.vercel.sh`, https only, no redirects), the key and the headers:

- the **vault entry** chosen in the settings (`credentialRef`, optionally `credentialField`) — a
  missing entry is an error, never silently replaced;
- otherwise the gateway's environment variable (`AI_GATEWAY_API_KEY`).

The key is never logged, returned or put in an error (`GET /api/v1/decisions/status` says where it
comes from: `vault polpo-infra / vercel-ai-gateway (token)` or `env AI_GATEWAY_API_KEY`).

The call is Vercel AI Gateway's Decisions API, `POST https://ai-gateway.vercel.sh/v1/decisions`:
`{ model, input, questions: [{ type, name, instructions, choices?, levels? }], providerOptions? }`,
where `input` is the text or one user message with an `input_json` part, the fallback is
`providerOptions.gateway.models` (a conditional `{ model, when: { confidenceBelow } }`) and zero data
retention `providerOptions.gateway.zeroDataRetention`. The answers' usage and
`provider_metadata.gateway.cost` go to **token usage** (source `decision`) like other model calls.

Polpo's questions are a neutral shape: they also map to TypeSafe's native schema
(`{ state, questions: { name: { type, instructions, criteria } } }`, also taken by Upstage Solar Decide
and Ollama's `/v1/systemone`), so more providers can be added.

### Without a decision model

`settings.decisions.unconfigured`:

- `"error"` (default): `decide` answers **409** `NOT_CONFIGURED` with a link to Settings
  (`/config?section=decisions`).
- `"orchestrator"`: Polpo's own model answers through the **chat pipeline** (a turn without tools,
  usage tracked as a chat), asked for a distribution per question; the result is **`calibrated: false`**.

## The decision log

Every call that reaches a model (also the failed ones) is recorded under `.polpo/decisions/`: who
called (`api`, `mcp`, `chat`, `agent` + its name, `mission` + its id, `suite`, `playground`) and who
the person is, the questions, the answers, the model, the cost and latency, whether it is calibrated
and uncertain, the state's sha256 and the state itself capped at 8 000 characters.

`settings.decisions`: `retention` (decisions kept, default 1000), `retentionDays` (default 30; 0: no
age limit), `storeInputs` (`"capped"` default, or `"hash"`: only the hash).

## Surfaces

- **REST**: `POST /api/v1/decide`; `GET /api/v1/decisions` (`limit`, `cursor`, `caller`, `callerId`,
  `uncertain`, `status`), `GET /api/v1/decisions/{id}`, `GET /api/v1/decisions/status`,
  `GET /api/v1/decisions/nodes`, `POST /api/v1/decisions/nodes/resolve`. Errors: 400 invalid (with
  `details`), 409 not configured (or the key is missing), 429 the gateway's rate limit, 502 the model
  failed or refused, 504 too slow (60 s).
- **MCP**: `polpo_decide` (work scope), `polpo_decisions` (read: the log, one decision, the mission
  nodes), `polpo_decision_resolve` (work) and the **decision card** `polpo_decision_show` (an MCP App:
  each answer with probability bars).
- **Polpo's chat**: `decide`, `decisions`, `decision_resolve` (the *decisions* tool group).
- **Agents**: the `decide` tool, given with `decide` in the agent's `allowedTools`; its calls are logged
  with the agent as caller.
- **SDK**: `client.decide`, `getDecisions`, `getDecision`, `getDecisionStatus`, `getDecisionNodes`,
  `resolveDecisionNode`; React `useDecide`, `useDecisions`, `useDecisionNodes`.
- **Dashboard**: **Decisions** (try questions on a state, nodes waiting for you, the log) and
  Settings → **Decisions**.
- Events: `decision:made` (every logged decision), `decision:node` (a mission node deciding, decided
  or waiting).

## Decision nodes in missions and playbooks

A mission (or a playbook's mission) can have `decisions`: after some tasks, a typed decision on their
results picks the branch that runs.

```jsonc
{
  "tasks": [
    { "title": "Triage", "description": "Read the ticket and summarize it" },
    { "title": "Refund", "description": "Refund the duplicate charge", "dependsOn": ["Triage"] },
    { "title": "Reply", "description": "Answer the customer", "dependsOn": ["Triage"] },
    { "title": "Escalate", "description": "Hand it to a person", "dependsOn": ["Triage"] }
  ],
  "decisions": [{
    "name": "route",
    "afterTasks": ["Triage"],
    "state": "Ticket summary: {{tasks.Triage}}",
    "question": { "type": "choice", "instructions": "Which team handles it?",
                  "choices": [{ "value": "billing" }, { "value": "support" }] },
    "branches": { "billing": ["Refund"], "support": ["Reply"] },
    "threshold": 0.7,
    "onUncertain": "human"
  }]
}
```

- **When**: the tasks in a node's branches wait; once every after task has finished (done or
  failed), the decision is taken on the **state**: the template with `{{tasks.<title>}}` (that task's
  result; in playbooks this placeholder is reserved, not a parameter), or every after task's result.
- **Branches**: predicate `yes` / `no`; choice an option's value; score a level index, a range (`0-1`)
  or a level's label; rank `ranked` (the sorted list goes to its tasks). An answer with no branch runs
  none of them.
- **Then**: the chosen branch's tasks go on, with the decision (question, answer, ranking) appended to
  their description; the other branches' tasks — and the tasks whose dependencies are all skipped —
  are **skipped** (done, their result says why). A task that also depends on the chosen branch (a
  join) still runs.
- **Uncertain or failed** (no decision model, the gateway failing): `onUncertain: "human"` (default)
  pauses the mission at a checkpoint `Decision: <name>` (notified like any checkpoint): resuming it
  takes the model's suggestion; or choose a branch (or none) on the Decisions page,
  `POST /api/v1/decisions/nodes/resolve` or `polpo_decision_resolve`. `onUncertain: { "branch": "…" }`
  takes that branch without a person.
- `model` on a node overrides `settings.decisionModel`; `notifyChannels` notify when a person must choose.
- The node's state survives restarts (`.polpo/decisions/nodes.json`); a decision cut short by a
  restart is taken again. Documents without `decisions` run as before.

The mission and playbook graphs draw decision nodes between their after tasks and their branches,
each edge labelled with its answer, and show the live state (deciding, the branch taken, waiting).

## Suites: the decision scorer

A cheap judge for agent suites (docs/agent-suites.md):

```jsonc
{ "type": "decision", "question": "predicate", "instructions": "Does the reply answer politely?", "threshold": 0.5 }
{ "type": "decision", "question": "choice", "instructions": "Which tone?", "choices": [{ "value": "formal" }, { "value": "casual" }], "expected": "formal" }
{ "type": "decision", "question": "score", "instructions": "How complete is it?", "levels": ["poor", "partial", "complete"] }
```

The state is the user's message and the value read (`from` / `path` as other scorers; the reply by
default). The score: a predicate's P(yes) (P(no) with `expected: false`); a choice's probability of
`expected`; a score's level reached (0..1), or the probability of `expected`'s level. Default
threshold 0.5. Each call is logged with the caller `suite`.

## Trying it on an instance

```bash
# the instance's API key (Settings → MCP access / API keys), never printed in logs
curl -sS https://<host>/<instance>/api/v1/decide \
  -H "Authorization: Bearer $POLPO_API_KEY" -H 'content-type: application/json' \
  -d '{
    "state": "Hi, I was charged twice for my October invoice, please refund the extra charge.",
    "questions": [
      { "name": "refund", "type": "predicate", "instructions": "Is the customer asking for money back?" },
      { "name": "team", "type": "choice", "instructions": "Which team should handle it?",
        "choices": [{ "value": "billing", "description": "Charges and refunds" }, { "value": "support", "description": "Everything else" }],
        "threshold": 0.7 },
      { "name": "urgency", "type": "score", "instructions": "How urgent is it?", "levels": ["Low", "Normal", "High"] }
    ]
  }' | jq

curl -sS https://<host>/<instance>/api/v1/decisions/status -H "Authorization: Bearer $POLPO_API_KEY" | jq   # the model and where the key comes from
curl -sS 'https://<host>/<instance>/api/v1/decisions?limit=5' -H "Authorization: Bearer $POLPO_API_KEY" | jq
```

## Not yet

- `box` questions (image regions) and image state parts: Polpo's state is text or JSON.
- Other decision providers (TypeSafe directly, Upstage, Ollama, the AI SDK's decision models): the
  neutral shape maps to them; adapters come later.
- The harness gateway settings and custom providers still resolve their own gateway keys; they can
  move onto the shared resolver.
