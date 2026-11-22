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

# Results between tasks

A task that depends on other tasks (`dependsOn`, in a mission or between standalone tasks)
receives their results. Nothing to set up: no checkpoint, no script appending them to its
description.

## In the prompt

At every run of the task (first run, retries, fix runs, continuations), Polpo puts a
`<dependency-results>` section before its description, with one block per dependency, in its
`dependsOn` order:

- title, agent, status and task id;
- the final result: what its agent replied at the end of its last run (`result.stdout`);
- its registered outcomes: text, URLs and JSON inline; files and media as references (the path its
  producer registered, on the producer's computer, with the outcome id and the task id). A text
  outcome equal to the result is not repeated;
- its error, when it failed (`result.stderr`, and the reviewer's feedback when the assessment did
  not pass).

```text
<dependency-results>
The results of the 3 tasks this task depends on. They are your input: use them.
A part marked …[truncated] is shortened here: read a result in full with task_result({task: "<task id or title>"}).
Files and media are references: their path is on the computer of the task that produced them.

### 1. "frase-01" — agent spike-01 — done — task id w1
Result:
L'alba dipinge il porto di rosa mentre i gabbiani svegliano la citta dal sonno salato.
Outcomes:
- text "frase-01": (same as the result above)

### 2. "frase-02" — agent spike-02 — done — task id w2
Result:
Rapporto: lorem ipsum lorem ipsum … …[truncated]
Outcomes:
- file "Report" (application/pdf, 20 KB): path /home/daytona/out/report.pdf (on computer "spike-02") · outcome id o9 · task id w2

### 3. "fetch" — agent spike-03 — failed — task id w3
Error:
HTTP 503 from the API
</dependency-results>
```

The section has a budget: at most `perTaskChars` per dependency (default 2000) and `totalChars`
in all (default 20000), shared fairly (short results leave their room to long ones; the longest
parts are cut first, with `…[truncated]`). With very many dependencies, those whose share would
be too small are listed by title and id only. Change it in `.polpo/polpo.json`:

```json
{ "settings": { "dependencyResults": { "perTaskChars": 4000, "totalChars": 40000 } } }
```

(or `PATCH /api/v1/config/settings` with `dependencyResults`; `null` restores the defaults).

Dependencies are task ids; in a mission document they are titles, resolved to ids when the
mission runs (and still matched by title within the mission if an id is not found).

## The tools: task_result and dependency_results

A task run whose task has dependencies or belongs to a mission gets two tools:

- `task_result({task, offset?})`: one task in full (result text paged by `offset`, outcomes with
  file references, status, error), by id or exact title;
- `dependency_results()`: every dependency's result, with a larger budget than the prompt
  (8000 per task, 80000 in all).

They read only **the task's own dependencies and the tasks of its own mission** (itself included).
A task of another mission, or a standalone task it does not depend on, is refused. Polpo's engine
has both; an agent harness (Claude Code, Codex) gets `task_result` as a Polpo tool (see
[harnesses](harnesses.md)).

Polpo (its `get_task` tool) and MCP clients (`polpo_task_get`) read any task's full result.

# Checkpoints

A checkpoint pauses a mission when its `afterTasks` are all finished (done or failed) and holds
its `blocksTasks` until someone resumes it (dashboard, `POST /api/v1/missions/:id/checkpoints/:name/resume`,
Polpo's `resume_checkpoint`, MCP):

```json
{ "name": "collect", "afterTasks": ["frase-01", "frase-02"], "blocksTasks": ["frase-finale"], "message": "Check the sentences" }
```

Each task in `blocksTasks` must also list the `afterTasks` in its `dependsOn` (the mission is refused
otherwise). A checkpoint is for a person's decision; it is not needed to pass results to the next
task (see above).
