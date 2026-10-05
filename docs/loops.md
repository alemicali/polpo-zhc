# Deterministic Loops Contract

Polpo agents can declare deterministic loops directly in `agents.json`. This is a contract-only surface: the config parser, API schemas, SDK types, and deploy path preserve the shape so the runtime and dashboard can build on the same model.

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
