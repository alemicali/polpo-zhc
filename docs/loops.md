# Deterministic Loops

Polpo agents can declare deterministic loops directly in `agents.json`. When an agent has a `pipeline`, every task assigned to it runs that pipeline step by step instead of a single agent session (see [Execution](#execution)). Chats with the agent are not affected.

```json
[
  {
    "agent": {
      "name": "support-router",
      "role": "Support triage and resolution",
      "runtime": "polpo-runner",
      "loops": {
        "triage": {
          "systemPrompt": "Classify the ticket and write the result to context.ticket.category.",
          "tools": ["read", "search_*"],
          "stopWhen": { "expression": "context.ticket.category != null" },
          "output": {
            "schema": {
              "type": "object",
              "properties": {
                "category": { "type": "string" }
              },
              "required": ["category"]
            }
          }
        },
        "resolve": {
          "model": "openai/gpt-4o",
          "maxTurns": 12,
          "tools": ["read", "write", "http_fetch"]
        }
      },
      "pipeline": {
        "mode": "sequential",
        "context": "shared",
        "steps": [
          { "loop": "triage" },
          {
            "switch": {
              "cases": [
                {
                  "when": "context.ticket.category == 'billing'",
                  "steps": [{ "human": "billing_approval", "notify": ["ops"] }]
                }
              ],
              "default": { "steps": [{ "loop": "resolve" }] }
            }
          }
        ]
      }
    },
    "teamName": "default"
  }
]
```

## Agent Fields

`runtime` is an optional non-empty string identifying the runtime profile for deterministic loop execution.

`loops` is an optional object keyed by loop name. Each loop can define:

- `name`: optional display name. The record key is still the canonical ID.
- `systemPrompt`: loop-specific prompt.
- `tools`: loop-specific allowed tool subset.
- `model`: loop-specific model override.
- `reasoning`: loop-specific reasoning override.
- `maxTurns`: positive integer turn limit.
- `stopWhen.expression`: deterministic stop condition over the shared context bag.
- `output.schema`: structured output contract.

`pipeline` composes loops and human gates. Supported steps are:

- `{ "loop": "triage" }`
- `{ "parallel": [steps], "join": "all" | "any" | number }`
- `{ "switch": { "cases": [{ "when": "...", "steps": [...] }], "default": { "steps": [...] } } }`
- `{ "human": "approval_name", "notify": ["ops"] }`

Each step can also include `when`, a deterministic guard expression.

## Validation

The local config parser rejects malformed loop contracts before deploy:

- `loops` must be an object keyed by non-empty loop names.
- Loop `tools` and `notify` entries must be non-empty strings.
- `maxTurns` and numeric `join` values must be positive integers.
- `pipeline.steps`, `parallel`, switch cases, and switch defaults must contain at least one step.
- A pipeline `loop` step must reference an existing key in `loops`.

`polpo deploy` sends the full agent config to the API; the API schema now preserves `runtime`, `loops`, and `pipeline` on create and update.

## Execution

The task's runner process executes the pipeline (`src/adapters/pipeline.ts`, `src/core/pipeline/`).

**Shared context.** One JSON object per run, starting empty. Expressions read it as `context`.

- A loop writes keys with `register_outcome({type: 'json', label: 'context', data: {...}})`. Objects are deep-merged; other values replace.
- A loop's structured output, registered with `label: 'output'`, is stored at `context.outputs.<loop>`.
- A human step's decision is stored at `context.human.<name>` as `{ "approved": true|false, "note": "..." }`.
- The final context is attached to the task as the JSON outcome "Pipeline context".

**Loops.** Each loop attempt is a fresh session of the same agent with the loop's overrides: `systemPrompt` is appended to the agent's, and `tools`, `model`, `reasoning` and `maxTurns` replace the agent's. The task description is extended with the current context, the output schema and the stop condition. A loop runs once. If its output does not match `output.schema` (or is missing), or `stopWhen` is still false afterwards, it runs again with feedback explaining why — up to 3 attempts in total, then the pipeline fails. A session that fails (error, turn limit, killed) fails the pipeline immediately.

**Steps.**

- `when` on any step: the step is skipped when the guard is false.
- `parallel`: branches run concurrently. `join: "all"` (default) needs every branch to succeed; `"any"` succeeds on the first success; a number `n` needs `n` successes. Once the join is decided, the remaining branches are stopped.
- `switch`: the first case whose `when` is true runs; otherwise `default`, if any.
- `human`: creates an approval request (Approvals page, `/approve` in channels, `POST /api/v1/approvals/{id}/approve|reject`) and waits. Approving continues; rejecting fails the pipeline with the rejection note. Each channel in `notify` gets a direct notification. Resolving these requests does not change the task's status — the pipeline does. Human steps need the local server (the runner reaches it over the notification socket). A request nobody waits for anymore — the run was cancelled, a `parallel` join was already decided, or the task stopped — is rejected automatically by `system`.
- `pipeline.mode: "parallel"` runs the top-level steps as one `parallel` step with `join: "all"`.

**Live state.** The run exposes its state in the run activity (`activity.pipeline`): each step by path (`steps.1.switch.cases.0.steps.0`) with its status (running, waiting, done, failed, skipped, cancelled), attempt, retry feedback and error, plus the shared context. It travels with `agent:activity` events. The task page shows it in the Pipeline tab, live while running and from the run log afterwards.

**Result.** The task succeeds when the pipeline completes; its usual assessment (expectations, reviews, retries) then applies. A failed pipeline fails the run with the failing step's reason, and Polpo's normal retry policy takes over.

**Expressions** (`when`, `stopWhen.expression`) are parsed, never `eval`'d. Supported: `context.a.b`, `context.list[0]`, `context["key"]`, string/number/`true`/`false`/`null` literals, `==`, `!=`, `<`, `<=`, `>`, `>=`, `&&`, `||`, `!`, parentheses. A missing path is `null`, so `context.x != null` means "is set". `==` does not coerce types; ordering only compares two numbers or two strings. A malformed expression fails the step.
