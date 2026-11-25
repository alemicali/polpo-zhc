# Agent suites

An agent's **Suites** tab holds its **tests and evals**: cases that send the agent a message (or a
task), answer its tools with **mocks** and/or **script its model**, and **check** what happened.
A suite runs against a **version** of the agent (production, the draft, `1.2.0`) through the
agent's real execution path, and every run keeps a **trace** per case.

Cases can also be **evals**: scorers give each case a score 0..1 (exact, numeric, similarity, JSON
Schema, tool trajectory, cost, latency, an LLM judge, custom code), runs aggregate them, compare
with a **baseline** run (regressions and improvements) and draw a **trend** over versions; an AI
review explains a run (see [Evals](#evals-scorers-baselines-trends)). Suites marked **required**
are the agent's **CI gate**: they run against a version before it reaches production, and the
deploy happens only if they pass (see [CI gate](#ci-gate-required-suites-before-production)).

A case can **replay a recorded exchange** (a cassette: record a case live once, or turn a real chat
or task into a case; see [Record and replay](#record-and-replay-cassettes)), talk with a **simulated
user** over several turns ([Simulated users](#simulated-users-multi-turn-cases)), and cases can be
**proposed by AI** and reviewed before they are saved ([Generate cases](#generate-cases-with-ai)).
The same suites test a **hosted MCP server** (its saved tests, the upstream API mocked) and a
**mission** (its tasks run in test mode, every agent mocked) — see [Suites for hosted servers and
missions](#suites-for-hosted-servers-and-missions) — and run from a terminal or CI with **`polpo
test`** and the **GitHub Action** ([polpo test and CI](#polpo-test-and-ci)). The same engine will run
**benchmarks** later; the data model already has their fields (see [Later phases](#later-phases)).

Suites live in `.polpo/agent-suites/<agent>/suites/<id>.json`, runs in
`.polpo/agent-suites/<agent>/runs/<run>.json` (the newest 100 per agent), deploy gates in
`.polpo/agent-suites/<agent>/gates/<id>.json` (the newest 200), cassettes in
`.polpo/agent-suites/<agent>/cassettes/<id>.json`. Removing an agent removes its suites, runs,
gates and cassettes. A mission's suites and runs are kept the same way under the owner
`mission:<id>`, a hosted server's runs under `mcp-server:<id>` (its suite is its saved tests);
deleting the mission or the server removes them.

## Concepts

| | |
|---|---|
| **Suite** | A named set of cases for one agent: default mock mode, shared mocks, datasets, default budgets, concurrency (1–4). Saved with a `revision`: a save that started from an older revision is refused (someone changed it meanwhile). |
| **Case** | `input` (`kind: chat` — a message —, or `task` — a task description, sent with the task framing; `tool` — a hosted server's tool with `args` —, or `mission` — the mission run in test mode), optional `history` (earlier turns) and `context` (`system` instructions, `memory`, `files`, `attachments`, given as context: the agent's real memory and workspace are untouched), a `mode`, `mocks` (tools, model, `cassette`, `simulatedUser`, `http`, `agents`), `assertions`, `budgets`, an optional `dataset`. |
| **Cassette** | A recorded exchange (every model turn and tool call with its arguments and result, secrets redacted) a case replays offline. |
| **Dataset** | Rows (`[{ "country": "IT", "rate": "4.99" }]`); a case with `dataset: "<id>"` runs once per row, with `{{row.column}}` filled in its input, mocks and assertions. Manual, or imported from CSV / JSON. |
| **Run** | The suite (or some cases) executed against a version, as a **variant** (`agent`, `version`, optional per-run `overrides`). Each case: status, assertions with messages and diffs, scores, trace, cost, duration; the run: aggregates, the comparison with its baseline, an optional AI review. |
| **Scorer** | A score 0..1 for a case with a threshold and a reason (evals); suite defaults and per case. |

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
| `tool_failed` | `tool?`, `contains?` | a tool call failed (with that text): a hosted server's tool expected to fail |
| `http_called` | `url` (glob or substring), `method?`, `times?` | the hosted server's tool sent that upstream request (mocked or not) |
| `task_status` | `task` (title), `status` (`done`, `failed`, `skipped`) | missions: the task ended so |
| `task_order` | `tasks: [...]` | missions: the tasks finished in this order |
| `task_agent` | `task`, `agent` | missions: the task was done by that agent |

`tool_called`, `tool_not_called` and `tool_args` take `agent` in mission suites (only that agent's
calls). In a multi-turn case the reply checks read **every** agent reply of the conversation and
the tool checks every call of it.

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

`POST /agents/{name}/suites/{id}/runs { target?, caseIds?, mode?, concurrency?, overrides?, variant?, wait?, allowRealTools?, repetitions?, baselineRunId?, regressionTolerance? }`
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
| Dashboard | Agent page → **Suites**: suites with their last run (score, regressions), **New suite**, the editor (Cases — input, mode, dataset, scripted turns, tool mocks, scorers, assertions —, **Evals** — judge model, repetitions, regression tolerance, baseline policy, default scorers —, Datasets with CSV / JSON import, JSON, YAML), **Run** on production / draft / a version in each case's mode or one for all (real tools after a confirmation), runs (score, ▼ regressions, ★ baseline), the run report (scores per scorer with deltas, the comparison with the baseline, each case's scores and the judge's reasoning, assertions with diffs, chat-style traces, **Mark as baseline**, **Explain this run**, Cancel), the **trend** chart per suite (pass rate and score over runs, by version) |
| REST | `GET/POST /api/v1/agents/{name}/suites`, `GET/PUT/DELETE …/suites/{id}` (`?format=yaml`, `{ yaml, revision }`), `POST …/suites/{id}/datasets/import`, `POST …/suites/{id}/runs`, `GET /api/v1/agents/{name}/suite-runs` (`?suite=`, `?benchmark=`, `?full=true`), `GET …/suite-runs/{runId}`, `POST …/suite-runs/{runId}/cancel`; evals: `GET …/suites/{id}/trend`, `GET/PUT/DELETE …/suites/{id}/baseline`, `GET …/suite-runs/{runId}/compare` (`?baseline=`, `?tolerance=`), `POST …/suite-runs/{runId}/review` (OpenAPI tag "Agent suites") |
| MCP | `polpo_agent_suite_list`, `polpo_agent_suite_get` (JSON or YAML) and `polpo_agent_suite_run_get` (reports, one case's trace) need `polpo:read`; `polpo_agent_suite_save` (JSON, YAML, dataset imports), `polpo_agent_suite_delete` and `polpo_agent_suite_run` (waits up to 55 s; `cancel`; `repetitions`, `baseline`, `tolerance`) need `polpo:work`; a run with real tools needs `polpo:admin`. Evals: `polpo_agent_suite_trend` (`polpo:read`), `polpo_agent_suite_baseline` (show, mark, clear, compare) and `polpo_agent_suite_review` (explain a run) (`polpo:work`); reports list scores per scorer, flaky cases and the regressions. **Suite card** (an MCP App): `polpo_agent_suite_show` (`polpo:read`) shows the suites, a run's report (scores, deltas, regressed cases, the review; "Explain this run" asks the model) or a suite's trend chart, inline or full screen |
| Polpo's chat | `agent_suite_list`, `agent_suite_get`, `agent_suite_save`, `agent_suite_delete`, `agent_suite_run`, `agent_suite_run_get`, `agent_suite_trend`, `agent_suite_baseline`, `agent_suite_review` (group "agent-versions": "write a test for the shop agent's shipping quotes", "run the shop suites on the draft", "add an LLM judge for politeness", "did the draft regress?", "explain the last run") |
| SDK | `getAgentSuites`, `getAgentSuite`, `getAgentSuiteYaml`, `createAgentSuite`, `saveAgentSuite`, `deleteAgentSuite`, `importAgentSuiteDataset`, `runAgentSuite`, `getAgentSuiteRuns`, `getAgentSuiteRun`, `cancelAgentSuiteRun`, `getAgentSuiteTrend`, `getAgentSuiteBaseline`, `setAgentSuiteBaseline`, `compareAgentSuiteRun`, `reviewAgentSuiteRun`; React `useAgentSuites(name)` → `{ suites, runs, save, remove, importDataset, run, cancel, yaml, setBaseline, review }`, `useAgentSuiteRun(name, runId)` (polls while running), `useAgentSuiteTrend(name, suiteId)` |

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

## Evals: scorers, baselines, trends

A case with **scorers** is an eval: each scorer gives a **score 0..1**, passes or fails against its
**threshold**, and says **why**. A case passes when its assertions pass and every scorer passes; a
scorer that cannot run (no judge model, no sandbox, bad code) **errors** the case. The case's
**score** is the weighted mean of its scorers (`weight`, default 1).

```yaml
scorers:                      # suite defaults: every case gets them (a case scorer with the same id replaces one)
  - { type: cost, maxUsd: 0.02 }
evals:
  judgeModel: anthropic:claude-sonnet-5-5   # default: Polpo's model (Settings → Orchestrator)
  repetitions: 3                            # run every case 3 times
  regressionTolerance: 0.05
  baseline: previous                        # previous (default) | production | none
cases:
  - name: Quote
    dataset: rates                          # rows: { country: IT, expected: 4.99 }
    input: { kind: chat, message: "How much is shipping to {{row.country}}?" }
    scorers:
      - { id: price, type: numeric, expected: "{{row.expected}}", tolerance: 0.01 }
      - { id: country, type: exact, from: tool_args, tool: "mcp__printful__*", path: recipient.country_code, expected: "{{row.country}}" }
      - id: judge
        type: llm_judge
        rubric: A correct, polite shipping quote
        criteria:
          - { name: correctness, description: The price and the carrier are right, weight: 3 }
          - { name: tone, description: Polite and short, weight: 1 }
```

### Scorers

| Type | Fields | Score |
|---|---|---|
| `exact` | `expected` (any JSON), `caseSensitive?` | 1 when equal (text trimmed, case-insensitive by default; objects deeply), else 0 |
| `numeric` | `expected` (number, or `{{row.x}}`), `tolerance?` (absolute; `relative: true` → a fraction of expected), `extract?` (a regex, its first group) | 1 within the tolerance, else 1 − relative error. The number is the value itself, or the first number in the text (`4,99`, `1.234,56`, `12,000` understood) |
| `contains_all` / `contains_any` | `values`, `caseSensitive?` | all: the share found; any: 1 when one is found |
| `regex` | `pattern`, `flags?` | 1 when it matches |
| `similarity` | `expected`, `method?` (`levenshtein` default, `tokens`) | normalized similarity (lowercase, accents and punctuation folded): 1 − edit distance / length, or the Dice coefficient of the words (texts over 2000 characters always use words). No external service |
| `json_schema` | `schema` | 1 when the value (by default the reply's JSON: the whole reply, a ```json block or the outermost `{…}`) is valid; the problems otherwise |
| `tool_trajectory` | `expected` (tool names or globs), `order?` (`in_order` default, `exact`, `any`) | in order: longest common subsequence / expected (extra calls allowed); exact: 1 for the same sequence, else LCS / the longer; any: the share of expected tools called |
| `cost` / `latency` | `maxUsd` / `maxMs` | 1 within the target, then target / actual |
| `llm_judge` | `rubric`, `criteria?` (`name`, `description`, `weight`), `expected?` (a reference answer), `model?` | **G-Eval**: the judge reasons on each criterion then scores it 1–5; the score is the weighted mean mapped to 0..1. Temperature 0; the model is the scorer's, else the suite's `evals.judgeModel`, else Polpo's effective model. The reasoning per criterion, the summary, the model and the judge's cost are kept on the result |
| `custom` | `code`, `expected?`, `timeoutMs?` (default 5 s, max 30 s) | the body of an async JS function with `reply`, `toolCalls` (`name`, `args`, `result`, `isError`), `turns`, `costUsd`, `durationMs`, `message`, `row`, `expected`; it returns a number 0..1, a boolean or `{ score, reason }` (an expression without `return` is returned). It runs in the **sandboxed code worker** hosted MCP servers use (bubblewrap: no network, no instance files, no secrets, 128 MB); without bubblewrap (macOS, Windows) the scorer errors |

Every scorer has `id` (made from its type when missing: `exact`, `exact-2`…; aggregates, baselines
and — phase 3 — gate thresholds use it), `label`, `threshold` (default 1; `similarity` 0.8;
`llm_judge` 0.6) and `weight`. The value-reading scorers (`exact`, `numeric`, `contains_*`,
`regex`, `similarity`, `json_schema`) read **`from`**: `reply` (default), `reply_json`,
`tool_args` / `tool_result` (with `tool`, a name or glob, and `which`: `last` default, `first`) or
`outcome` (the registered outcome's arguments), narrowed by **`path`** (`recipient.country_code`,
`items[0].quantity`, `$.rate`).

**Dataset expected values**: scorers are templated with the case's row like everything else, so a
dataset with an `expected` column and `expected: "{{row.expected}}"` scores every row against its
own expected value (a string that is only a placeholder keeps the value's type: numbers stay numbers).

### Aggregates and repetitions

Every run stores `aggregates`: per scorer the **mean, median, p10**, min, max, stddev and pass rate;
the run's **overall score** (the mean of the cases' weighted scores); the pass rate, cost and
duration totals, latency p50 / p90, and what the judges cost (not counted in the agent's cost).

With **repetitions** (`evals.repetitions`, or `repetitions` on a run, 1–10) every case (every
dataset row) runs N times — keys `case#row~1`, `~2`… — and `aggregates.cases` gives each case its
attempts, pass rate, **mean score and stddev**, and a **flaky** flag: it both passed and failed, or
its scores spread more than `evals.flakyStddev` (default 0.1).

### Baselines and regressions

Each finished run is compared with a **baseline run** and stores `run.baseline`: the pass-rate,
score, cost and duration deltas, and per case and per scorer the change — `regressed`, `improved`,
`unchanged`, `new` or `removed`. A case regresses when it passed and now fails, or when its pass
rate (with repetitions), its score or one of its scorers drops by more than the **tolerance**
(`evals.regressionTolerance`, default 0.05, or `regressionTolerance` on a run); it improves the
other way round.

The baseline is: the run given with `baselineRunId`; else the run **marked** as the suite's baseline
(`PUT …/suites/{id}/baseline { runId }` — e.g. the last good run on production; a marked run is never
dropped from the history); else, by `evals.baseline`, the **previous** finished run (default), the
latest finished run on **production**, or none. `GET …/suite-runs/{runId}/compare?baseline=` compares
any two runs on demand.

### Trends

`GET …/suites/{id}/trend` gives the suite's finished runs over time (oldest first) — pass rate,
overall score, mean per scorer, cost, latency, regressions, the baseline flagged — and the same
averaged **by version** (production's version, a published one, or the draft). The dashboard draws
it as a chart; the MCP suite card too.

### Explain this run (AI review)

`POST …/suite-runs/{runId}/review { language? }` asks Polpo's model (the orchestrator's effective
model) to explain a finished run: a summary, what failed or regressed and why (the failed
assertions and scorers with their reasons, the judge's reasoning, the trace, the deltas), and
**suggested fixes** — instruction edits quoting the text, tool changes, or the test itself when its
expectation or mock is wrong. The agent's instructions and tools (of the version the run used, with
its overrides) are part of the prompt. The review is stored on the run (`run.review`, Markdown).

## CI gate: required suites before production

A suite with `gate.required` is a **deploy gate** of its agent: before any version of the agent
reaches production — from the dashboard, REST, MCP, Polpo's chat, or the auto-deploy of an API
update — every required suite runs against that version (a run with `trigger: "deploy"`), and the
production pointer moves **only if every one passes its gate**. Otherwise the deploy is **blocked**:
production is unchanged and the deploy history records it (`action: "blocked"`, "Blocked by
suites", with the failing suites, why, their failed cases and the runs to open).

```yaml
gate:
  required: true          # every deploy of the agent waits for this suite
  minPassRate: 1          # 0..1, default 1: every case must pass
  maxRegression: 0.05     # largest drop of the pass rate or the overall score versus the baseline (default: not checked)
  scoreThresholds:        # minimum mean per scorer id; "score" is the run's overall score
    judge: 0.7
    score: 0.8
  onPublish: true         # also run when a version is published (a non-blocking check)
  allowRealTools: false   # admins only: the gate may run the suite's real-tools cases
```

A suite **passes its gate** when its run finished (not cancelled, no run-level error) and:

- its **pass rate** ≥ `minPassRate` (default 1);
- with `maxRegression`: neither the pass rate nor the overall score dropped more than that
  versus the **baseline** — the suite's marked baseline, else its latest finished run on production;
- every **`scoreThresholds`** entry is met (the mean of that scorer over the run's cases; a scorer
  with no scores fails).

**Async: "in verifica".** Suites take time, so a deploy through the gate is **pending**: the request
answers at once (`202`, `status: "pending"`, the gate) and production keeps running its version;
the gate's progress (cases done / planned, each suite's status) is saved and sent live as the
`agent:gate` event (SSE), so the dashboard updates as it goes. When every run ends, the gate
deploys (passed) or records the block. A pending verification can be **cancelled** (nothing is
deployed). Only one deploy per agent is verified at a time (another version waits: `409`); the
runs share the instance's limit of **two suite runs at a time**.

**Rollbacks are never gated**: a rollback must always work. It stops a verification in flight (which
would otherwise deploy over it).

**Real tools.** The gate never runs a suite whose cases would use real tools (modes `none` /
`model`, unmocked tools run for real, the CLI engine's own tools) unless the suite has
`gate.allowRealTools` — which only an **admin** can turn on (a dashboard member, the owner's key,
an MCP client with `polpo:admin`, Polpo). Without it such a required suite does not run and blocks
the deploy ("not run: it uses real tools"): make it offline (mode `all` or `tools`) or let it.

**Override.** An **admin** can deploy anyway with a **mandatory reason**: the deploy history records
the override (who, when, the reason, and which gates had failed or were not verified). Others are
refused (`403`). An override on a verification still running cancels its runs first; an override
with no gate deploys without running the suites ("not verified").

**Publish checks.** Suites with `gate.onPublish` also run when a version is **published** (not
deployed): a non-blocking check (`trigger: "publish"`) whose result is shown on the version
(✓ passed, ✗ failed) before anyone deploys it.

**API updates that auto-deploy** (`PATCH /agents/{name}` without flags while
`settings.agents.versioning.autoDeployApiUpdates` is on, MCP `polpo_agent_update`, Polpo's
`update_agent`): the change is published, then deployed through the gate. When the gate blocks it,
the update **stays published, not deployed**, and the response says so: `versioning.deployStatus`
(`pending` / `blocked`), `versioning.gate` (with the failing gates), `versioning.warning` ("Published
as 1.3.0 but not deployed: Blocked by suites: …"). `wait: true` waits for the verdict.

Changes written **live** — an agent changing its own settings, skill assignment, Ink installs, a
file edit — are recorded as versions deployed at once (docs/agent-versions.md) and are not gated:
they already run. A gate left running when the server restarts is finished as errored (nothing
deployed): deploy again.

Each gate run is a normal suite run (`trigger: "deploy"` or `"publish"`, target the version) with
`run.gate = { decision: "pass" | "fail" | "override", reason?, by?, gateId }`.

| Surface | How |
|---|---|
| Dashboard | Agent page → **Versions**: the required suites ("Deploys are verified first by …"), the deploy being verified (progress bar, each suite, **Cancel**, **Deploy anyway…**), each version's gate badge (✓ Suites passed, ✗ Blocked by suites / Check failed, Verifying n/m, Override), the deploy history's badges (blocked deploys struck through, overrides with their reason) whose rows open what failed with **Open run**; the deploy confirmation says the suites run first; a blocked deploy opens the override dialog (reason required). **Suites** tab: **Required** badge on the suites that gate deploys, the editor's **Gate** view (required, minimum pass rate, max regression, score thresholds, on publish, real tools), runs marked "Deploy gate" / "Publish check" with their decision |
| REST | `POST /agents/{name}/deploy { version, note?, override?: { reason }, wait? }` → `200` deployed (`status: "deployed"`, the entry with its `gate`), `202` pending (`status: "pending"`, `gate`), `409` `GATE_BLOCKED` (`data`/`details`: `{ status, gate, entry }`), `403` an override by a non-admin; `POST …/publish { deploy?, wait? }` (`deployStatus`, `gate`; without deploy, `check`: the publish checks); `GET /agents/{name}/deploy-gates[?version=&limit=]`, `GET …/deploy-gates/{id}[?wait=seconds]`, `POST …/deploy-gates/{id}/cancel`, `POST …/deploy-gates/{id}/override { reason, note? }`; `GET …/versions` (each version's `gate`, `state.gate.requiredSuites`, `state.gate.pending`); `GET …/deploys` (each entry's `gate`, blocked deploys); `PATCH /agents/{name} { …, wait? }` (`versioning.deployStatus`, `gate`, `warning`); event `agent:gate` |
| MCP | `polpo_agent_deploy` (admin) returns the gate: waits up to ~50 s, then deployed, still pending (with its id) or **blocked** (which suites failed, why, the failed cases, the runs); `override_reason` deploys anyway (admins); `cancel_gate` stops a verification. `polpo_agent_deploy_gates` (`polpo:read`): the required suites and the gates (one with `id`, `wait`). `polpo_agent_publish`, `polpo_agent_update` say when a deploy is pending or blocked; `polpo_agent_versions` and `polpo_agent_deploys` show each version's and deploy's gate; `polpo_agent_suite_list` marks required suites; the **suite card** (`polpo_agent_suite_show`) shows the Required badge and the latest deploy gates (verifying, passed, blocked, override). `gate` in `polpo_agent_suite_save` (`allowRealTools` needs `polpo:admin`) |
| Polpo's chat | `agent_deploy` (with `override_reason`, `cancel_gate`), `agent_deploy_gates`, `agent_suite_save` with `gate`, `update_agent` (says when the deploy is pending or blocked) |
| SDK | `deployAgentVersion(name, version, note?, { override?, wait? })` → `AgentDeployOutcome` (a blocked deploy throws `PolpoApiError` with code `GATE_BLOCKED`), `getAgentDeployGates`, `getAgentDeployGate(name, id, { waitSeconds })`, `cancelAgentDeployGate`, `overrideAgentDeployGate`; React `useAgentDeployGates(name)` → `{ data, pending, cancel, override }` (live on `agent:gate`), `useAgentDeploys().deploy(version, note, { override })` |

## Record and replay (cassettes)

A **cassette** is a real exchange saved once and replayed offline: every model turn (text,
thinking, tool calls, usage) and every tool call with its arguments and result. A case points at
it with `mocks.cassette`:

```json
{ "id": "rates-it", "name": "Rates to Italy", "input": { "message": "How much is shipping to Italy?" }, "mode": "all",
  "mocks": { "cassette": { "id": "rates-it-rec", "match": "exact", "onUnmatched": "block", "model": true } },
  "assertions": [{ "type": "tool_called", "tool": "mcp__printful__shipping_rates", "args": { "country": "IT" } }] }
```

- **Record** (`POST …/suites/{id}/cases/{caseId}/record { allowRealTools: true, target? }`, the
  cassette viewer's **Record**, MCP `polpo_agent_suite_record`, or a run with `record: true`): the
  case runs **live** once — the agent's real model and real tools, side effects possible — so it
  needs an **admin** and an explicit confirmation (`allowRealTools: true`; the dashboard asks; MCP
  needs `polpo:admin`). Approvals are never given by a recording. The exchange is saved as the
  case's cassette (`<case>-rec`, one per dataset row: `<case>-rec--r<n>`) and the case is pointed
  at it; it replays from then on. **Re-record** the same way: calls marked as mocks stay pinned.
- **Secrets are redacted** before anything is written: the vault's values wherever they appear,
  values under secret-looking keys (`authorization`, `api_key`, `token`, `password`, `cookie`,
  `client_secret`…), and credential shapes in text (bearer / basic tokens, `sk-…`, GitHub, Slack,
  AWS, Google keys, JWTs, `Authorization: …` headers dumped in a result). The cassette says how many
  values were redacted. A redacted argument matches anything when replayed.
- **Replay**: in a mode that mocks tools (`all`, `tools`) a tool call is answered by the case's own
  mocks first, then by the cassette; in a mode that scripts the model (`all`, `model`) the recorded
  model turns are played (`model: false` keeps the real model). Matching (`match`): `exact`
  arguments (default), `partial` (the recorded arguments are a subset of the call's), `tool` (the
  next unused recording of that tool, any arguments) or `sequence` (the n-th call of the case must
  be the n-th recorded one). A call no recording answers is **blocked** (an error result,
  `onUnmatched: "block"`, default) or **fails** the case (`"fail"`). The trace says which cassette
  answered, how many calls and turns it replayed and which calls it could not.
- **Edit** (the cassette viewer, `PATCH …/cassettes/{id} { edits, revision? }`, MCP
  `polpo_agent_suite_cassette_edit`): per recorded call, change the `response` (and `isError`),
  `delete` it, or `markAsMock` — the call becomes a tool mock of its case (kept on re-recording).
  `revision` refuses an edit over a newer one. Deleting the cassette makes the case block its
  calls until it is recorded again.
- **From a real chat or task** (`POST …/suites/{id}/cases/from-recording { sessionId | taskId,
  messageIndex?, name? }`, **Add cases → From a chat or task**, MCP `polpo_agent_suite_record` with
  `from_session` / `from_task`): no live run. A chat with the agent (its last user message, or
  `messageIndex`; the earlier turns become the case's history) or a task run's activity (the task
  description is the message, `kind: task`) becomes a case and its cassette, secrets redacted; the
  case replays it offline (mode `all`) and checks the same tool calls with the same arguments, in
  order (the core's `caseFromTrace`, extended with the cassette).

## Simulated users (multi-turn cases)

`mocks.simulatedUser` turns a case into a **conversation**: the case's message is the first user
turn, then after each agent reply a **simulated user** — a model playing a persona — writes the
next one, until it stops.

```json
{ "name": "Refund, annoyed customer", "input": { "message": "My order never arrived. I want my money back." }, "mode": "tools",
  "mocks": {
    "simulatedUser": { "persona": "An annoyed customer, short answers", "goal": "Get a refund for order 1234",
      "constraints": ["Gives the order number only when asked", "Writes in Italian"], "maxTurns": 5, "stop": "goal" },
    "tools": [{ "tool": "refund_order", "response": { "ok": true } }] },
  "assertions": [{ "type": "tool_called", "tool": "refund_order", "args": { "order": "1234" } }, { "type": "text_not_contains", "value": "I cannot help" }],
  "scorers": [{ "id": "polite", "type": "llm_judge", "rubric": "Polite and empathetic throughout", "threshold": 0.7 }] }
```

- `persona`, `goal`, `constraints`: who plays the user and what they want (at least a persona or
  a goal). `maxTurns`: user turns after the first (1–20, default 5).
- **Stop condition** (`stop`): `goal` (default — the simulator says the goal is reached, or that it
  cannot be), `scorer` (when the case's scorer `stopScorer` passes, checked after each reply), or
  `max_turns` (every turn runs; the simulator keeps talking). A conversation also stops when the
  agent waits for a person (an approval, `ask_user`) or a budget is spent.
- **Model**: `simulatedUser.model`, else the suite's `simulatorModel` (editor → Evals), else
  Polpo's effective orchestrator model (`settings.orchestratorModel`, else a connected provider's).
  The simulator's calls are counted apart (not in the agent's cost).
- **Scripted user**: `script: ["and to Germany?", "thanks"]` plays these user turns in order, no
  simulator model: fully offline with a scripted model and tool mocks.
- The **transcript** is in the trace (`trace.transcript`: each message, simulated or scripted, the
  simulator's note when it stopped; `trace.simulator`: model, calls, cost, why it stopped, goal
  reached) and drawn as a conversation in the report and the suite card. **Assertions and scorers
  read the whole conversation**: `text` holds every agent reply, the tool checks every call;
  `trace.finalText` is the last reply.

## Generate cases with AI

**Add cases → Generate cases** (REST `POST /agents/{name}/suites/generate-cases`, MCP
`polpo_agent_suite_generate`, Polpo's `agent_suite_generate`): Polpo's model reads the agent's
instructions, tools, skills and connectors, an optional **brief** ("refunds over 100 EUR") and up to
five **sample chats** (`sessionIds`, secrets redacted) and proposes `count` cases (1–20, default
6): **happy paths**, **edge cases** and **adversarial** ones (prompt injection, off-scope requests,
unsafe actions) — `include` picks the kinds. `style: "contract"` (default) writes offline cases
(scripted model, every tool it calls mocked); `"tools"` uses the real model with mocked tools.
Each proposal comes back **validated** with its category and rationale (an invalid one says why);
**nothing is saved**: a person ticks the ones to keep and adds them (`POST …/suites/{id}/cases {
cases, datasets?, revision? }`, MCP `accept`). Generated cases are marked `source.kind:
"generated"`.

**Dataset rows** (`POST …/suites/{id}/datasets/generate { caseId, count?, brief? }`, the dialog's
**Dataset rows**, MCP `rows_for_case`): rows proposed for a case's dataset (its columns kept, edge
and adversarial values included), shown for review and added only when accepted.

Generation costs tokens of Polpo's model; without a model it answers `409`.

## Suites for hosted servers and missions

The same suites test two more targets. Their REST routes mirror an agent's under
`/api/v1/mcp-servers/{id}/…` and `/api/v1/missions/{id}/…` (`suites`, `suites/{suiteId}`,
`…/runs`, `suite-runs`, `suite-runs/{runId}`, `…/cancel`, baselines, trends; OpenAPI tags "MCP
server suites" and "Mission suites").

### Hosted MCP servers

A hosted server's **saved tests are its suite** (one suite, id `saved-tests`; docs/custom-mcp-servers.md):
the same tests, stored once in the server's `tests.json`, its settings (shared HTTP mocks, datasets,
the gate) in `server.json`. Each test is a case that calls one of the server's tools
(`input: { kind: "tool", tool, args }`) on the draft (default), production or a version; the legacy
`expect` / `contains` are assertions (`tool_failed` / `no_tool_errors`, `text_contains`).

```json
{ "name": "Item 404", "input": { "kind": "tool", "tool": "get_item", "args": { "id": "9" } },
  "mocks": { "http": [{ "method": "GET", "url": "*/items/9", "status": 404, "body": { "error": "nope" } }] },
  "assertions": [{ "type": "tool_failed", "contains": "No such item" }, { "type": "http_called", "method": "GET", "url": "*/items/9", "times": 1 }] }
```

- **The upstream API is mocked**: `mocks.http` (case first, then the suite's) answers each request
  by method and URL (a glob or a substring) with `status`, `body`, `headers`, `times`. In modes
  `all` / `tools` a request no mock matches is **blocked** (`unmockedHttp: "block"`, default) and
  nothing reaches the network; secrets are placeholders (a real one never reaches a test), so
  destructive and approval tools run safely. Real HTTP (mode `none`, or `unmockedHttp: "real"`)
  needs an admin and runs read-only tools only. Code tools run in their sandboxed worker with its
  own network, so HTTP mocks do not reach them: their cases are skipped in mocked modes (run them
  in mode `none`).
- The trace lists each HTTP request (method, URL, status, which mock answered, or blocked).
- **Publish and deploy**: publishing runs the saved tests as this suite on the draft (offline; the
  legacy live run only when a case needs real HTTP), with the server's `onTestFailure` (warn or
  block). Mark the suite **Required to deploy** (`gate.required`, the hosted server's **Suite** tab)
  and every deploy — dashboard, REST, MCP, Polpo — runs it on the version first, exactly like an
  agent's [CI gate](#ci-gate-required-suites-before-production) (`minPassRate`, `allowRealTools`):
  when it fails, the deploy is **blocked** (`409 GATE_BLOCKED` with `{ runId, failures }`; a publish
  with `deploy: true` stays published, not deployed, with `deployBlocked`), and an **admin** may
  deploy anyway with `override: { reason }` (recorded on the deploy: who, why). Rollbacks are never
  gated. The deploy history shows each deploy's gate (suite passed, override and its reason).

### Missions

A mission's suites (`input: { kind: "mission", message? }`) run the mission **in test mode**: its
tasks in dependency order, each a chat turn of its assigned agent (production version) with the
task framing and what the tasks before produced, every agent with **its own mocks**:

```json
{ "name": "Blog post, happy path", "input": { "kind": "mission", "message": "Topic: octopuses" },
  "mocks": { "agents": {
    "writer": { "model": { "turns": [{ "toolCalls": [{ "name": "web_search", "args": { "q": "octopus" } }] }, { "text": "3 facts" }, { "text": "post written" }] },
                "tools": [{ "tool": "web_search", "response": "facts" }] },
    "checker": { "model": { "turns": [{ "text": "looks good" }] } } } },
  "assertions": [
    { "type": "task_order", "tasks": ["Research", "Write", "Check"] },
    { "type": "task_status", "task": "Check", "status": "done" },
    { "type": "task_agent", "task": "Check", "agent": "checker" },
    { "type": "tool_called", "tool": "web_search", "agent": "writer", "times": 1 },
    { "type": "artifact_created", "titleContains": "octopus" }] }
```

- `mocks.agents.<name>` is merged over the case's shared mocks for that agent's tasks; an agent's
  scripted turns continue across its tasks.
- A task whose dependency did not finish is **skipped**; a failed task (an error, a spent budget)
  is `failed`. With no assertions or scorers, a case passes when every task is done.
- The trace has one entry per task (agent, status, reply, calls, turns, cost, time, error), every
  tool call with its agent, and notes for what test mode does not run.

**What a mission suite does not do (deferred)**: it does not go through the mission engine. The
tasks run **one after another** (no parallelism), with no task assessment / review loop, no
retries, and the mission's **checkpoints, delays and quality gates are not run** (the run notes
them; check the tasks with assertions instead). Each task is an agent chat turn with the task
framing, not the task runner process (as for `kind: task` cases). Agents run their production
version; there is no `target`. Recording cassettes is for agent suites only.

## polpo test and CI

`polpo test` runs suites and reports, locally or on a remote instance:

```bash
polpo test shop --version draft --junit suites.xml          # one agent's suites, on its draft
polpo test --suite quotes --mode all                         # every agent, offline
polpo test --mcp-server stock-api                            # a hosted server's saved tests (draft)
polpo test --mission blog-post --json report.json
POLPO_URL=https://polpo.example.com POLPO_TOKEN=… polpo test shop --fail-on-regression --summary summary.md
```

| Option | |
|---|---|
| `[agent]` | The agent whose suites run (default: every agent's) |
| `--mcp-server <id>` / `--mission <id>` | A hosted server's saved tests / a mission's suites instead |
| `--suite <id>` | Only this suite |
| `--version <v>` | `production` (default; hosted servers: `draft`), `draft` or a published version |
| `--mode <mode>` | Every case in this mode (`all` offline, `tools`, `model`, `none`) |
| `--fail-on-regression` | Also fail when a run regressed versus its baseline |
| `--allow-real-tools` | Confirm runs that use real tools (remotely: an admin key) |
| `--json [file]` / `--junit <file>` / `--summary <file>` | JSON report (stdout or a file), JUnit XML (one test suite per run, failures with their messages), a Markdown summary (a table of runs with links to the dashboard, the failed cases) |
| `--remote <url>` / `--token <key>` | Run on an instance through its REST API (env `POLPO_URL`, `POLPO_TOKEN`: an API key). Without it the project in the working directory (`-d`) runs in process: nothing listens |
| `--timeout <s>` | How long to wait for the runs (default 1800) |

It prints a report (each run, its failed cases and why) and exits **0** when every run passed,
**1** when a run failed or errored (or regressed, with `--fail-on-regression`), **2** when it could
not run (bad options, an unknown agent or suite, the instance unreachable).

### GitHub Action

A reusable composite action, `.github/actions/polpo-test` (in this repository: use it as
`alemicali/polpo-zhc/.github/actions/polpo-test@<ref>`, or copy it), runs `polpo test --remote`
against your instance with a token from a secret, writes JUnit XML, posts the Markdown summary to
the job summary and **fails the step** when a run fails or regresses (`fail-on-regression:
"false"` only reports regressions). Inputs: `url`, `token` (required), `agent`, `suite`, `version`,
`mode`, `mcp-server`, `mission`, `fail-on-regression`, `allow-real-tools`, `junit`, `timeout`,
`polpo-version`, `node-version`; outputs `exit-code` and `junit`.

```yaml
# .github/workflows/polpo-suites.yml
name: Polpo suites
on:
  pull_request:
  workflow_dispatch:
jobs:
  suites:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Agent suites on the draft
        uses: alemicali/polpo-zhc/.github/actions/polpo-test@main
        with:
          url: ${{ vars.POLPO_URL }}
          token: ${{ secrets.POLPO_TOKEN }}
          agent: shop
          version: draft
      - name: The hosted server's saved tests
        if: always()
        uses: alemicali/polpo-zhc/.github/actions/polpo-test@main
        with:
          url: ${{ vars.POLPO_URL }}
          token: ${{ secrets.POLPO_TOKEN }}
          mcp-server: stock-api
          junit: stock-api.xml
```

Keep the key in a secret; runs that use real tools need an admin key and `allow-real-tools:
"true"`. Offline suites (mode `all`, cassettes, scripted users) cost nothing and are deterministic:
the best fit for every pull request. This repository's own CI does not run it.

## Phase 4 surfaces

| Surface | How |
|---|---|
| Dashboard | Agent page → **Suites**: rows count the cases replaying a cassette and the multi-turn ones; **Add cases** (Generate cases — brief, sample chats, how many, happy / edge / adversarial, offline or real model — with a review list where each proposal is ticked before **Add**; Dataset rows for a case; From a chat or task); the case editor's **Multi-turn** block (persona, goal, constraints, script, max turns, stop condition, simulator model) and the cassette's matching and unmatched policy; **Evals** view: the suite's simulated user model. The run report draws a multi-turn case as a **conversation** (simulated / scripted turns, why it stopped), a mission's **tasks**, a hosted server's **HTTP requests**, the cassette replayed or recorded, and opens the **cassette viewer** (Record / Re-record after a confirmation, each call's arguments with secrets redacted, edit its response, delete it, Mark as mock, delete the cassette). Hosted server → **Suite** tab (the saved tests as the suite: run, report, edit as JSON, **Required to deploy**); its Versions: a blocked deploy with what failed, **Deploy anyway…** (reason), the gate in the deploy history. Mission page → **Suites** tab |
| REST | Cassettes: `GET …/agents/{name}/cassettes`, `GET/PATCH/DELETE …/cassettes/{id}`, `GET …/suites/{id}/cases/{caseId}/cassette`, `POST …/suites/{id}/cases/{caseId}/record`, runs with `record: true`; `POST …/suites/{id}/cases/from-recording`; generation: `POST …/agents/{name}/suites/generate-cases`, `POST …/suites/{id}/cases` (accept), `POST …/suites/{id}/datasets/generate`; other targets: `/mcp-servers/{id}/suites…`, `/missions/{id}/suites…`, `…/suite-runs…`; hosted publish / deploy: `override`, `deployBlocked`, `409 GATE_BLOCKED` |
| MCP | `polpo_agent_suite_cassette` (list, or one cassette's calls) and `polpo_target_suites` (a hosted server's or a mission's suites and runs) need `polpo:read`; `polpo_agent_suite_record` (live: `polpo:admin`; `from_session` / `from_task`: `polpo:work`), `polpo_agent_suite_replay`, `polpo_agent_suite_cassette_edit`, `polpo_agent_suite_generate` (propose, `accept`, `rows_for_case`), `polpo_target_suite_save` and `polpo_target_suite_run` need `polpo:work` (real tools or HTTP: `polpo:admin`). The **suite card** (`polpo_agent_suite_show`) draws transcripts, the replayed cassette and a mission's tasks. `polpo_mcp_server_publish` / `polpo_mcp_server_deploy` take `override_reason` and say when the suite blocked a deploy |
| Polpo's chat | `agent_suite_record`, `agent_suite_replay`, `agent_suite_cassette`, `agent_suite_cassette_edit`, `agent_suite_generate`, `target_suites`, `target_suite_save`, `target_suite_run` (group "agent-versions": "record the rates case", "turn my last chat with shop into a test", "propose adversarial cases for the shop agent", "test the stock-api server's tools", "run the blog mission's suite") |
| SDK | `getAgentCassettes`, `getAgentCassette`, `getAgentSuiteCaseCassette`, `editAgentCassette`, `deleteAgentCassette`, `recordAgentSuiteCase`, `agentSuiteCaseFromRecording`, `generateAgentSuiteCases`, `acceptAgentSuiteCases`, `generateAgentSuiteDatasetRows`, `getTargetSuites`, `saveTargetSuite`, `deleteTargetSuite`, `runTargetSuite`, `getTargetSuiteRuns`, `getTargetSuiteRun`; `publishMcpServer` (`override`, `deployBlocked`), `deployMcpServer(id, version, note?, { override })`. React: `useAgentSuites(name)` adds `record`, `fromRecording`, `generate`, `accept`, `generateRows`; `useSuiteCassette(name, suiteId, caseId)` → `{ cassette, edit, remove, refetch }`; `useTargetSuites(kind, id)` → `{ suites, runs, save, remove, run }`; `useTargetSuiteRun(kind, id, runId)`; `useMcpServer(id).publish` / `.deploy(version, note, { override })` |
| CLI | `polpo test` (above) |

## Later phases

Reserved in the model now, built later (no migration needed):

- **Phase 2 — evals**: built (see [Evals](#evals-scorers-baselines-trends)).
- **Phase 3 — gates**: built (see [CI gate](#ci-gate-required-suites-before-production)).
- **Phase 4 — record / replay, simulated users, generated cases, `polpo test` and CI, hosted server
  and mission suites**: built (see the sections above). Not in phase 4: `suite.target` of kind
  `team` (reserved, refused); mission suites run the tasks in sequence outside the mission engine
  (no checkpoints, delays, quality gates, assessments or retries: see [Missions](#missions));
  cassettes for hosted servers and missions (their upstream is mocked with HTTP / per-agent mocks
  instead); code tools of a hosted server with HTTP mocks (their sandbox has its own network).
- **Phase 5 — benchmarks and playground**: `run.variant` (`id`, `label`, `agent`, `version`,
  `overrides`), `run.benchmarkRunId`, `run.repetition` and `result.variantId` make the comparison
  matrix (case × variant); `caseFromTrace` (core) turns a recorded exchange into a case (observed
  tool calls become mocks and expectations, optionally the model turns a script).
