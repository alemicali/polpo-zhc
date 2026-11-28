# Tasks

## Pausing a task

A single task can be held until someone resumes it, without failing it. A mission has its own
pause (checkpoints, budget); the two are independent.

| | |
|---|---|
| Can be paused | `pending`, `assigned`, `in_progress` |
| Status while paused | `paused` |
| Resumed to | `pending` (killed: `failed`) |

### What a pause does

- **A pending task** is simply not scheduled.
- **A running task**: its run gets SIGTERM, as with a kill, but the run ends as **`paused`**
  (`Task.runs[].status`), not failed: no review, no retry, no retry counted. Its session id, its
  conversation checkpoint and the outcomes it produced so far are kept.
- **Its mission** stays `active` and does not complete while the task is paused; tasks that depend on
  it wait (a paused dependency is never taken for a deadlock). Pausing or resuming the mission does
  not pause or resume the task.
- **Kill** still works on a paused task (it fails).

The task records the pause in `Task.pause`:

```json
{
  "at": "2026-11-28T09:12:03.120Z",
  "by": "anna@acme.com",
  "reason": "waiting for the client's logo",
  "from": "in_progress",
  "runId": "x1Yv…",
  "resumedAt": "2026-11-28T10:02:41.004Z",
  "resumedBy": "bob@acme.com"
}
```

`by` is the signed-in member who asked (the API with a member's session, Polpo's chat on their
behalf, the MCP connector's user), `Polpo` for Polpo's own tools, or the agent for a blocking computer
takeover nobody took in time (reason `waiting for takeover`, `takeover: { requestId, computerId }`:
completing the takeover resumes the task, resuming it by hand cancels the request; see
[computer-live-view.md](computer-live-view.md#soft-and-hard-requests)).
The record stays after resume, with who resumed it; `status === "paused"` is what says the task is
paused now.

### What a resume does

The task goes back to `pending`. When the pause stopped a run, the next run **continues** it: a
`continue` direction (the same continuation as `POST /tasks/:id/directions { mode: "continue" }`:
same checkpoint, same harness session) tells the agent it was paused, by whom and why, that it was
resumed and by whom, plus the optional message, and asks it to check the current state first (the
step it was on may be half done). A task paused while pending starts fresh.

Resume waits up to 10 s for the stopped run to end; if it is still stopping, it answers 409 (try again).

### Everywhere

| Surface | Pause | Resume |
|---|---|---|
| REST | `POST /tasks/:id/pause` `{ reason? }` | `POST /tasks/:id/resume` `{ message? }` |
| REST (status) | `PATCH /tasks/:id { "status": "paused" }` | `PATCH /tasks/:id { "status": "pending" }` |
| MCP | `polpo_task_pause` `{ id, reason? }` | `polpo_task_resume` `{ id, message? }` |
| Polpo's chat | `pause_task` | `resume_task` |
| SDK | `client.pauseTask(id, { reason })` | `client.resumeTask(id, { message })` → `{ continued, task, direction? }` |
| React | `useTask(id).pauseTask(reason)` | `useTask(id).resumeTask(message)` |
| Dashboard | task page → Pause | task page → Resume |

Errors: 404 `NOT_FOUND`; 409 `INVALID_STATE` (already paused, not pausable, not paused, still stopping).
`GET /tasks?status=paused` lists paused tasks; slim rows carry `pause`. The MCP task card shows the
pause with Pause / Resume buttons; the dashboard shows a paused banner on the task page, a **Paused**
badge, tab and board column in the task lists.

### Events

- `task:paused` `{ taskId, title, from, reason?, pausedBy?, runId?, takeover? }`
- `task:resumed` `{ taskId, title, continued, resumedBy?, message?, reason?, pausedMs?, takeover? }`

Both carry `source` / `by` like other change events and can be routed by notification rules.
