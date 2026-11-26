# Agents posting to notification channels

An agent working a task, or chatting, can post a message to one of the instance's notification
channels — Slack (as the Polpo bot), Telegram, email, WhatsApp Business operators, a webhook, push —
with its `send_notification` tool. It goes through the same notification router as
`POST /api/v1/notifications/send` and Polpo's own `send_notification`: no other send path.

The owner decides where: the tool exists only for agents that have **both**

- `send_notification` in `allowedTools` (an exact name, or a pattern such as `send_*`), and
- at least one channel in `notifyChannels`.

## The allowlist

```json
{
  "name": "lead-notifier",
  "allowedTools": ["read", "send_notification"],
  "notifyChannels": [
    { "channel": "slack", "targets": ["C0LEADBF"] },
    { "channel": "telegram" }
  ],
  "notifyRateLimit": 5
}
```

| Value | The agent may post to |
| --- | --- |
| `"*"` | every configured channel, each to its own default target (no `to`) |
| `{ "channel": "telegram" }` | that channel's default target only (no `to`) |
| `{ "channel": "slack", "targets": ["C0LEADBF", "C0OPS"] }` | only those targets: `to` is required and must be one of them (Slack channel ids, Telegram chat ids, email addresses) |
| `{ "channel": "slack", "targets": ["*"] }` | any target on that channel |

A Slack thread (`thread_ts`) is always allowed within an allowed target. `channel` is the name in
`settings.notifications.channels`; a name that is not configured (yet) is kept with a **warning** (in
the REST response, MCP and Polpo's answer), and the agent cannot post there until it exists.

`notifyChannels` and `notifyRateLimit` are versioned agent fields: changes go to the draft and are
published and deployed like any other ([agent-versions.md](agent-versions.md)).

## The tool

```
send_notification { channel, to?, thread_ts?, title?, body, severity? }
```

- `body`: markdown or plain text, at most 8000 characters; `title` (at most 200) defaults to
  "Message from <the agent's display name>"; `severity`: `info` (default), `warning`, `critical`.
- Its description lists what the agent may use. A call outside the allowlist is refused with that
  list, e.g. `Agent "lead-notifier" may not post to "C0GENERAL" on "slack". Allowed: "slack" (to:
  "C0LEADBF"); "telegram" (its default target only, no `to`).`
- Errors from the channel (the Slack app is not in the channel, a bad chat id…) come back to the
  agent as the tool's error (`throwOnError`).
- **Rate limit**: `notifyRateLimit` messages per minute per agent (default 5, at most 60); above it
  the call is refused with the wait.
- Prompt-injection hygiene: only what the agent writes is sent; where it goes is the owner's
  allowlist, never something the agent read. In chats the tool is not gated by a confirmation (the
  allowlist is the owner's consent), unlike `email_send` / `whatsapp_send` to arbitrary recipients.

## Every engine, checked on the server

- **Polpo's engine, harnesses (Claude Code, Codex, OpenCode) and the CLI engine** get the same tool
  (a harness as a host tool, a CLI through Polpo's MCP tool server).
- A **task run** lives in its own process: the tool asks the orchestrator over the notification
  socket, and the orchestrator sends **as the run's agent** (from the run record and the task: the
  version it runs and the task's tool scope), never as an agent named in the request, and checks the
  allowlist and the rate limit again.
- **Chats** (Polpo's engine, CLI chats) send in the server process with the same checks.

## The history

Every message is in the notification history (`GET /api/v1/notifications`, the dashboard's
Notifications) with `ruleName` `Agent <name> · task <id>` (or `· chat <session>`) and an `origin`:

```json
{ "kind": "agent", "agent": "lead-notifier", "taskId": "…", "missionId": "…", "runId": "…" }
```

(`sessionId` for a chat). Stored in the `origin` column (SQLite migration 0021, PostgreSQL 0022).

## Where to set it

- **Dashboard**: agent page → **Tools & Skills** → **Notifications**: the `send_notification`
  toggle (added to / removed from `allowedTools`; an agent on the default tools keeps its core tools),
  "Every configured channel", per channel a switch and its targets (comma separated), the per-minute
  limit.
- **REST**: `POST /api/v1/agents` and `PATCH /api/v1/agents/{name}` with `notifyChannels` /
  `notifyRateLimit` (`null` or `[]` clears; `warnings` in the response). See `docs/openapi.json`.
- **MCP**: `polpo_agent_create` / `polpo_agent_update` `notifyChannels`, `notifyRateLimit`;
  `polpo_agent_get` shows them (and warns when the tool is missing from `allowedTools`).
- **Polpo's chat**: `add_agent` / `update_agent` `notifyChannels`, `notifyRateLimit`.
- **SDK**: `AgentConfig.notifyChannels`, `UpdateAgentRequest.notifyChannels` (`AgentNotifyChannels`),
  `NotificationRecord.origin`; React: `useAgents().updateAgent`.
- **polpo.json**: on the agent (validated at load).

## Example: a lead for review on Slack

1. Configure the Slack channel ([slack.md](slack.md)) and invite the app to `#lead-black-friday`.
2. Give `lead-notifier` `send_notification` and `{ "channel": "slack", "targets": ["C0LEADBF"] }`.
3. Its task: "Explain why ACME is a good lead and post it for review". It calls
   `send_notification { channel: "slack", to: "C0LEADBF", title: "Lead ACME", body: "…" }`; the
   message appears in the channel from the Polpo bot and in the history with the task as origin.
