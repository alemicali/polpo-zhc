# Mission cost and budget

A mission's tasks record every run they make (`Task.runs`: where and with what it ran, and what it
cost). A mission adds them up, and can have a budget that stops it when spent.

## What a mission cost

The cost of a mission is the sum of **every recorded run of every task of the mission**: first
runs, retries, fix attempts and continuations alike (and every run of a recurring mission). For
each run:

- an agent harness (Claude Code, Codex) reports the runtime's own estimate: `harnessUsd`;
- Polpo's engine reports the model cost the provider gives: `modelUsd`.

`GET /api/v1/missions/:id` returns it as `cost`:

```json
{
  "currency": "USD",
  "usd": 4.2, "harnessUsd": 4, "modelUsd": 0.2, "tokens": 152000,
  "runs": 5, "tasks": 3, "unpricedRuns": 0, "runsActive": 1,
  "byEngine": [{ "engine": "claude-code", "usd": 4, "harnessUsd": 4, "modelUsd": 0, "tokens": 2000, "runs": 3 }, "…"],
  "byAgent": [{ "agent": "coder", "usd": 4, "harnessUsd": 4, "modelUsd": 0, "tokens": 2000, "runs": 3 }, "…"],
  "partial": false,
  "budgetUsd": 5, "remainingUsd": 0.8, "budgetUsed": 0.84, "overBudget": false
}
```

- `byAgent`: the agent that ran each run (a reassigned task counts under each agent that ran it).
- `unpricedRuns`: runs that reported no cost (yet: a run starting).
- `partial`: a task keeps its latest 20 runs. When older ones were dropped the total may be higher;
  for runs on a harness the cost is taken back from the token-usage records (`agent_harness`, which
  carry the task id and are not capped: `recoveredUsd`), so only tasks that also ran on Polpo's
  engine stay partial (`partialTaskIds`).
- `agentBudgetCapUsd` (only without a mission budget): the sum of the per-run harness budgets
  (`engine.maxBudgetUsd`) of the agents of the mission's tasks, one run each — an informational
  upper bound, given only when every task's agent has one.

The missions list (`GET /api/v1/missions`, also `?slim=true`) gives each mission a compact
`cost`: `{ usd, tokens, runs, partial?, budgetUsd?, overBudget? }`.

**Why task runs and not the token-usage records.** Token-usage records carry no mission id, and
only harness runs write them (turn by turn, with the task id as their session): they repeat what
`Task.runs` already holds, so adding both would count twice. `Task.runs` covers both engines, is in
every store and is what the orchestrator checks the budget against on every tick. Assessment and
chat calls are not task runs and are not counted.

## The budget

`budgetUsd` (a positive number of USD) is optional:

- REST: `POST /api/v1/missions { …, budgetUsd: 20 }`, `PATCH /api/v1/missions/:id { budgetUsd: 30 }`
  (`null` clears it).
- MCP: `budget_usd` on `polpo_mission_create` and `polpo_mission_update` (`null` clears it).
- Polpo: `budgetUsd` on `create_mission` and `update_mission`.
- Dashboard: the mission page's cost button → Budget.

When what the mission spent reaches its budget:

1. no new task of the mission starts; tasks already running finish (their cost still counts);
2. the mission goes to `paused` with `pauseReason: "budget"`;
3. `mission:budget-exceeded { missionId, name, spentUsd, budgetUsd, reason }` is emitted once:
   notification rules on it (or on `mission:*`) send it to your
   channels.

Raise the budget above what it spent, or clear it, and at the next tick the mission is `active`
again and its tasks start (`mission:budget-resumed`). Resuming it by hand while it is still over
its budget is refused with the reason. A mission paused at a checkpoint is left alone; once the
checkpoint is resumed, the budget is checked again.

## In the dashboard

- Mission page: the total next to the actions, with the budget bar (warning colour from 80%,
  destructive at 100%). Click it for the breakdown by engine (with their marks) and by agent, the
  harness estimate and the model cost, and to set, change or clear the budget. A mission its budget
  paused shows a banner.
- Missions list: each mission's cost (against its budget), and "over budget" when it paused.
