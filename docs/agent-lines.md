# Communication lines between agents

Agents talk to each other with `ask_agent` (a quick question), `message_agent` (a handoff of real
work) and `escalate` (to their manager), and they set each other off in rooms. **Communication
lines** decide who may talk to whom, along the org chart (`reportsTo`) by default.

## The policy: `talksTo`

Each agent has a `talksTo` field (in `.polpo/polpo.json`, the agent's page → Overview →
Communication, REST, MCP or Polpo's chat):

```json
{ "name": "dev", "reportsTo": "cto", "talksTo": { "mode": "org", "agents": ["writer"], "acceptFrom": "anyone" } }
```

| `mode` | The agent may talk to |
| --- | --- |
| `org` | its manager (`reportsTo`), its direct reports (agents whose `reportsTo` is it), plus the extra `agents` listed. **The default for every agent created from now on.** |
| `list` | only the listed `agents` |
| `anyone` | every other agent |
| `none` | no other agent |

Always, whatever the policy:

- **Polpo** (the orchestrator) talks to every agent, and every agent can answer Polpo.
- **`escalate`** always reaches the agent's manager (`reportsTo`), even with `list` or `none`.

Lines are **directional**: the sender's policy decides. A receiver can also refuse senders outside
its own lines with `acceptFrom: "lines"` (default `"anyone"`: it accepts whoever's lines reach it).

Names in `agents` that no longer exist are ignored (deleting an agent never breaks the config).
Mission-scoped (volatile) agents are created without lines.

### Agents from before the lines

An agent without `talksTo` keeps today's behaviour, `anyone`, so nothing breaks. The dashboard
shows a hint on its Communication section ("Not restricted … Use org chart lines") and the org
chart's lines overlay counts the agents not restricted yet; `GET /agents/lines` lists them in
`unrestricted`.

### Versioned like the other fields

`talksTo` is a versioned agent field: a change goes to the agent's draft, and runs use it once
published and deployed (the instance setting decides whether an update publishes and deploys at
once; deploy gates apply). See [agent-versions.md](agent-versions.md).

## Enforcement

- `ask_agent` / `message_agent` refuse a target outside the lines, with a message that lists who the
  agent can talk to: `writer is outside your communication lines (org). You can talk to: cto, qa.`
  An unknown name is answered with the reachable agents only.
- The tools' descriptions name **only** the agents the lines reach, so the model does not try others.
  An agent that can reach nobody gets no `ask_agent` / `message_agent`; an agent without a manager
  gets no `escalate`.
- **Rooms**: an agent's reply sets off (by `@mention` or by intent) only the agents it may talk to.
  A person's messages and mentions and Polpo's replies are not limited.
- The existing brakes stay: no loops (an agent already in the exchange is not asked again), at most
  3 nested hops, a time limit per answer.

## Agents working a task

Task runs (on Polpo's engine, a harness such as Claude Code / Codex / OpenCode, or a CLI engine, on
this server or on a computer) get `ask_agent`, `message_agent` and `escalate` too, within the same
lines. The run's process reaches the orchestrator over its notification socket; the orchestrator
takes the agent and the task from the run record, never from the request.

A task turn cannot receive a later turn, so:

- **`ask_agent` and `escalate` wait** for the answer (up to 3 minutes) and return it as the tool
  result. If the answer takes longer, the run goes on and the answer reaches the task when it comes.
- **`message_agent` hands off** and the run goes on. The reply reaches the task.

A reply that reaches the task is written in the run's log (`agent:reply`) and then:

- while the run is still working: it is given to the agent as a follow-up message;
- once the run is over (or the engine cannot take follow-ups): it is attached to the task as a text
  outcome, "Reply from &lt;agent&gt;".

Every exchange appears in the **Agent conversations** view, with the task it came from.

## The org chart view

The Agents page's org chart always draws the hierarchy (`reportsTo`). The **Communication lines**
toggle (off by default, remembered in this browser) overlays who may talk to whom: dashed edges
(arrows at both ends when both may talk), a badge with each agent's mode, and the count of agents
not restricted yet.

## Surfaces

| Surface | What |
| --- | --- |
| REST | `talksTo` on `POST /agents` and `PATCH /agents/{name}` (`null` removes it); `GET /agents/lines`: every agent's lines and the edges |
| MCP | `talksTo` on `polpo_agent_create` / `polpo_agent_update`; `polpo_agent_lines`; `polpo_agent_get` and the agent card (`polpo_agent_show`) show the lines |
| Polpo's chat | `talksTo` on `add_agent` / `update_agent`; `agent_lines` |
| SDK | `client.getAgentLines()`, `AgentTalksTo`, `AgentLinesChart`; React `useAgentLines()` |
| Dashboard | the agent's Overview → Communication (reports to, lines, extra agents, accept only its lines, the preview), the org chart's lines overlay |
