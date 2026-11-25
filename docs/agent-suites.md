# Agent suites

An agent's **Suites** tab holds its **tests and evals**: cases that send the agent a message (or a
task), answer its tools with **mocks** and/or **script its model**, and **check** what happened.
A suite runs against a **version** of the agent (production, the draft, `1.2.0`) through the
agent's real execution path, and every run keeps a **trace** per case.

The same engine will run evals (scorers), deploy **gates** and **benchmarks** later; the data
model already has their fields (see [Later phases](#later-phases)).

Suites live in `.polpo/agent-suites/<agent>/suites/<id>.json`, runs in
`.polpo/agent-suites/<agent>/runs/<run>.json` (the newest 100 per agent). Removing an agent
removes its suites and runs.

## Concepts

| | |
|---|---|
| **Suite** | A named set of cases for one agent: default mock mode, shared mocks, datasets, default budgets, concurrency (1–4). Saved with a `revision`: a save that started from an older revision is refused (someone changed it meanwhile). |
| **Case** | `input` (`kind: chat` — a message —, or `task` — a task description, sent with the task framing), optional `history` (earlier turns) and `context` (`system` instructions, `memory`, `files`, `attachments`, given as context: the agent's real memory and workspace are untouched), a `mode`, `mocks`, `assertions`, `budgets`, an optional `dataset`. |
| **Dataset** | Rows (`[{ "country": "IT", "rate": "4.99" }]`); a case with `dataset: "<id>"` runs once per row, with `{{row.column}}` filled in its input, mocks and assertions. Manual, or imported from CSV / JSON. |
| **Run** | The suite (or some cases) executed against a version, as a **variant** (`agent`, `version`, optional per-run `overrides`). Each case: status, assertions with messages and diffs, trace, cost, duration. |

## Mock modes

| Mode | Model | Tools | Cost | Side effects | Who may run it |
|---|---|---|---|---|---|
| `all` — contract (default) | scripted turns | mocks | none (offline) | none | work scope |
| `tools` | the agent's real model | mocks (unmocked calls blocked; `unmockedTools: "real"` runs them) | tokens | none (unless `unmockedTools: "real"`) | work scope (admin with `unmockedTools: "real"`) |
| `model` | scripted turns | real | none | possible | admin, after a confirmation |
| `none` — live | real | real | tokens | possible | admin, after a confirmation |

A run that would use real tools needs `allowRealTools: true` (REST; the dashboard asks first,
MCP needs `polpo:admin`). **Approvals are never given by a test**: a gated send (`email_send`,
`whatsapp_send`…) or `ask_user` stops the turn for a person, a hosted MCP server tool that needs
approval is queued in Approvals as usual; both are recorded as "approval requested".

Each case's chat turn is deleted afterwards: a test is not a conversation. Scripted turns are
not counted as token spending.

### Tool mocks

```json
{ "id": "rates", "tool": "mcp__printful__*", "when": { "args": { "country": "IT" }, "match": "partial", "call": 1 },
  "response": { "rates": [{ "id": "STANDARD", "rate": "4.99" }] }, "delayMs": 0, "times": 1 }
```

- `tool`: a name or a glob (`*` any characters, `?` one): native tools (`write`, `bash`…),
  Polpo's host tools, connector tools (`mcp__<connector>__<tool>`) and hosted MCP server tools
  alike.
- `when.args` compared with `match` (`partial` default, `exact`, `regex`, `schema`); `when.call`:
  only the n-th call of that tool.
- `response` (a string as is, anything else as JSON) or `error` (the model sees `Error: …`);
  `{{args.x}}` and `{{row.x}}` are filled in; `delayMs` up to 60 s; `times`: at most this many calls.
- The case's mocks are tried before the suite's; the first that matches answers. A mocked call
  never reaches the tool: **no side effect**.
- With no matching mock: `register_outcome`, `artifact_create` and `artifact_update` get a harmless
  stub (their arguments still count for the assertions); anything else is **blocked** (an error
  result, noted in the trace), or run for real with `unmockedTools: "real"` (mode `tools` only).

### Model mocks

```json
{ "turns": [
  { "toolCalls": [{ "name": "mcp__printful__shipping_rates", "args": { "country": "IT", "items": [{ "variant_id": 4012, "quantity": 1 }] } }] },
  { "text": "Standard shipping to Italy costs 4.99 EUR." }
], "onExhausted": "stop" }
```

Each model call takes the next turn (text and/or tool calls with exact arguments; optional
`usage` to test cost budgets offline). After the last turn: an empty answer (`stop`, default) or
the case errors (`error`). Scripted calls still go through the real pipeline: argument
validation against the tool's schema, interactive tools, approvals.

### Budgets

`budgets: { maxTurns, maxCostUsd, maxDurationMs }` per case (suite defaults; 20 turns and 5 minutes
by default). A spent budget stops the case before its next model call (`finishReason: "budget"`).

## Assertions

Every assertion may have a `label`. A failed one says why, with `expected`, `actual` and, for
arguments and tool order, a unified **diff**.

| Type | Fields | Passes when |
|---|---|---|
| `tool_called` | `tool` (name or glob), `times` \| `min` / `max`, `args`, `match` | the tool was called (that many times; with matching arguments) |
| `tool_not_called` | `tool`, `args?`, `match?` | never called (with those arguments) |
| `tool_order` | `tools: [...]`, `strict?` | called in this order (a subsequence; `strict`: one right after the other) |
| `tool_args` | `tool`, `value`, `match` (`partial`, `exact`, `regex`, `schema`), `which` (`any`, `all`, `first`, `last`) | the calls' arguments match (`schema`: `value` is a JSON Schema) |
| `no_tool_errors` | | no tool call failed (blocked calls count as failures) |
| `outcome_registered` | `label?`, `outcomeType?`, `valueContains?` | `register_outcome` was called (so) |
| `artifact_created` | `kind?`, `titleContains?` | `artifact_create` was called (so) |
| `approval_requested` | `tool?` | a person's approval was requested (a gated send, `ask_user`, a hosted tool queued) |
| `text_contains` / `text_not_contains` | `value` (string or list), `caseSensitive?` | the final reply contains every value / none |
| `text_regex` | `pattern`, `flags?` | the reply matches |
| `max_turns` / `max_cost` / `max_duration` | `value` / `usd` / `ms` | within the limit |

A case without assertions passes when it runs without errors. Matching: `partial` compares the
listed keys (deeply; `"5"` equals `5`), `regex` treats string values as patterns, `schema` checks a
JSON Schema (type, properties, required, additionalProperties, items, enum, const, bounds,
lengths, pattern, anyOf / oneOf / allOf / not).

## Per-engine support

Each case runs as one chat turn with `agent`, `agent@draft` or `agent@1.2.0` through the
in-process chat completions pipeline (the path of the agent's chats and the Tests tab's smoke
run), inside the case's hooks (`src/core/agent-suite-context.ts`).

| Engine | Model mock | Tool mocks | Notes |
|---|---|---|---|
| Polpo's engine | ✓ (`streamLLM` answers from the script: no provider call) | ✓ every tool, intercepted in the tool executor before it runs | the reference |
| Harness (Claude Code, Codex, OpenCode SDK) | ✓ | ✓ | chats — and so cases — run on Polpo's engine with the agent's model (docs/harnesses.md); task runs inside the VM are not covered yet |
| CLI engine (official `claude` / `codex`) | ✗ (the program calls its own model: modes `model` / `all` error with a clear message) | Polpo's tools it uses (connectors, `register_outcome`, artifacts…) through its MCP tool server; the program's own tools (Bash, Read, Edit…) run for real | mode `tools` therefore counts as real tools (admin) |

`kind: "task"` cases run as an agent turn with the task framing (not through the task runner
process).

## Datasets

- In the suite: `datasets: [{ "id": "countries", "name": "Countries", "rows": [...] }]`.
- Import: `POST /agents/{name}/suites/{id}/datasets/import { format: "csv" | "json", text, name?, id?, mode?: "replace" | "append", coerce? }`.
  CSV: the first line names the columns; quotes, `""`, commas or semicolons or tabs; numbers and
  `true` / `false` become values (`coerce: false` keeps text; `02` stays text). JSON: a list of
  objects or `{ rows }`.
- Templating: `{{row.country}}` inside text is written out; a string that is only
  `{{row.rate}}` takes the value as is (numbers stay numbers). Unknown names stay as they are.

## Runs and reports

`POST /agents/{name}/suites/{id}/runs { target?, caseIds?, mode?, concurrency?, overrides?, variant?, wait?, allowRealTools? }`
returns the run (running, or finished with `wait: true`). Up to two runs at a time per instance
(others wait, `queued`); cases run one at a time unless `concurrency` (max 4).
Cancel: `POST /agents/{name}/suite-runs/{runId}/cancel` (cases not started are skipped; running
ones stop before their next model call or tool).

Each case's **trace**: the messages sent; the model turns (text, thinking, tool calls, scripted
or real, usage); the tool calls (arguments, result, `mocked`: `mock` with the mock's id, `stub`,
`blocked` or real, approval); the reply; the finish reason; approvals; usage and cost; the runner's
notes. The dashboard draws it like a chat (the chat page's own parts).

`overrides` (`model`, `reasoning`, `engine`, `instructions`, `instructionsAppend`,
`allowedTools`, `maxTurns`) change the agent **for that run only** (nothing is saved): run the same
suite with two models and compare.

## Surfaces

| Surface | How |
|---|---|
| Dashboard | Agent page → **Suites**: suites with their last run, **New suite**, the editor (Cases — input, mode, dataset, scripted turns, tool mocks, assertions —, Datasets with CSV / JSON import, JSON, YAML), **Run** on production / draft / a version in each case's mode or one for all (real tools after a confirmation), runs, the run report (assertions with diffs, chat-style traces, Cancel) |
| REST | `GET/POST /api/v1/agents/{name}/suites`, `GET/PUT/DELETE …/suites/{id}` (`?format=yaml`, `{ yaml, revision }`), `POST …/suites/{id}/datasets/import`, `POST …/suites/{id}/runs`, `GET /api/v1/agents/{name}/suite-runs` (`?suite=`, `?benchmark=`, `?full=true`), `GET …/suite-runs/{runId}`, `POST …/suite-runs/{runId}/cancel` (OpenAPI tag "Agent suites") |
| MCP | `polpo_agent_suite_list`, `polpo_agent_suite_get` (JSON or YAML) and `polpo_agent_suite_run_get` (reports, one case's trace) need `polpo:read`; `polpo_agent_suite_save` (JSON, YAML, dataset imports), `polpo_agent_suite_delete` and `polpo_agent_suite_run` (waits up to 55 s; `cancel`) need `polpo:work`; a run with real tools needs `polpo:admin` |
| Polpo's chat | `agent_suite_list`, `agent_suite_get`, `agent_suite_save`, `agent_suite_delete`, `agent_suite_run`, `agent_suite_run_get` (group "agent-versions": "write a test for the shop agent's shipping quotes", "run the shop suites on the draft") |
| SDK | `getAgentSuites`, `getAgentSuite`, `getAgentSuiteYaml`, `createAgentSuite`, `saveAgentSuite`, `deleteAgentSuite`, `importAgentSuiteDataset`, `runAgentSuite`, `getAgentSuiteRuns`, `getAgentSuiteRun`, `cancelAgentSuiteRun`; React `useAgentSuites(name)` → `{ suites, runs, save, remove, importDataset, run, cancel, yaml }`, `useAgentSuiteRun(name, runId)` (polls while running) |

## Example: Printful shipping rates

A contract suite for a shop agent that quotes shipping through the Printful connector
(`mcp__printful__*`). It runs offline: nothing reaches Printful, nothing is ordered.

```yaml
name: Shipping rates
defaultMode: all
mocks:
  tools:
    - id: rates
      tool: mcp__printful__shipping_rates
      when: { args: { recipient: { country_code: "{{row.country}}" } } }
      response: { result: [{ id: STANDARD, name: Flat Rate, rate: "{{row.rate}}", currency: EUR }] }
    - id: no-orders
      tool: mcp__printful__create_order
      error: Orders are not allowed in this test
datasets:
  - id: countries
    name: Countries
    rows:
      - { country: IT, rate: "4.99" }
      - { country: DE, rate: "5.49" }
      - { country: US, rate: "9.99" }
cases:
  - name: Quote a t-shirt
    dataset: countries
    input:
      kind: chat
      message: How much is shipping one t-shirt (variant 4012) to {{row.country}}?
    mocks:
      model:
        turns:
          - toolCalls:
              - name: mcp__printful__shipping_rates
                args: { recipient: { country_code: "{{row.country}}" }, items: [{ variant_id: 4012, quantity: 1 }] }
          - text: Standard shipping to {{row.country}} costs {{row.rate}} EUR.
    assertions:
      - { type: tool_called, tool: mcp__printful__shipping_rates, times: 1 }
      - type: tool_args
        tool: mcp__printful__shipping_rates
        match: schema
        value:
          type: object
          required: [recipient, items]
          properties:
            recipient: { type: object, required: [country_code], properties: { country_code: { type: string, pattern: "^[A-Z]{2}$" } } }
            items: { type: array, minItems: 1 }
      - { type: tool_not_called, tool: mcp__printful__create_order }
      - { type: text_contains, value: "{{row.rate}}" }
      - { type: max_turns, value: 4 }
  - name: Never orders without approval
    mode: tools        # the real model decides; Printful is still mocked
    input: { kind: chat, message: Order 3 posters for Ann and ship them to Milan }
    assertions:
      - { type: tool_not_called, tool: mcp__printful__confirm_order }
      - { type: max_cost, usd: 0.05 }
```

The first case (contract) checks the conversation's shape for every country without a model;
the second runs the agent's real model with the tools still mocked, to check it does not confirm
an order on its own. Save the same as JSON through REST or `polpo_agent_suite_save`.

## Later phases

Reserved in the model now, built later (no migration needed):

- **Phase 2 — evals**: `case.scorers` (`exact`, `numeric` with tolerance, `similarity`, `llm_judge`
  with a rubric — the G-Eval assessor —, `custom`) with thresholds and `result.scores`; `run.baseline`
  (comparison with a previous run).
- **Phase 3 — gates**: `suite.gate` (`required`, `minPassRate`, `maxRegression` versus production,
  `scoreThresholds`); `run.trigger: "publish"` and `run.gate` (`pass` / `fail` / `override` with the
  reason, in the deploy history).
- **Phase 4**: `mocks.cassette` (record / replay), `mocks.simulatedUser`, generated datasets
  (`dataset.source.kind: "generated"`), `suite.target` other than an agent (hosted MCP server,
  mission, team).
- **Phase 5 — benchmarks and playground**: `run.variant` (`id`, `label`, `agent`, `version`,
  `overrides`), `run.benchmarkRunId`, `run.repetition` and `result.variantId` make the comparison
  matrix (case × variant); `caseFromTrace` (core) turns a recorded exchange into a case (observed
  tool calls become mocks and expectations, optionally the model turns a script).
