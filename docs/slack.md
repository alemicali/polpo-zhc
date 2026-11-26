# Slack

A Slack channel (`type: "slack"`) does two things:

- **Notifications out**: rules, direct sends and conversation replies post to a Slack channel,
  with the app's bot token (`chat.postMessage` to the channel's `chatId`, or to a target channel
  and thread) or with an Incoming Webhook URL.
- **Conversations in** (inbound on): people talk to Polpo — or to one agent — from Slack, through
  the same gateway as Telegram: DMs, mentions in channels, threads, files, buttons, `/polpo`.

Inbound uses **Socket Mode**: the instance opens an outbound WebSocket to Slack, so Slack never
calls the instance. Nothing has to be public — it works on an instance reachable only from the
tailnet, with no Funnel path.

## 1. Create the Slack app

1. Open <https://api.slack.com/apps> → **Create New App** → **From scratch**; name it (e.g.
   *Polpo*) and pick the workspace.
2. **Socket Mode** (left menu) → **Enable Socket Mode**. Slack asks for an **app-level token**:
   name it (e.g. *polpo-socket*), keep the scope **`connections:write`**, **Generate**. Copy the
   token (`xapp-…`): this is the **app-level token**.
3. **OAuth & Permissions** → **Bot Token Scopes**, add:

   | Scope | Why |
   |---|---|
   | `app_mentions:read` | mentions of the app in channels |
   | `channels:history` | messages in public channels the app is in (threads, `channelMessages: "all"`) |
   | `groups:history` | the same in private channels |
   | `im:history` | direct messages with the app |
   | `chat:write` | replies and notifications |
   | `files:read` | files people send (downloaded with the bot token) |
   | `files:write` | files Polpo and agents send back |
   | `users:read` | people's display names |
   | `commands` | the `/polpo` slash command (added by step 5) |

   Optional: `mpim:history` (group DMs), `channels:read` (the app is enabled at once when someone
   already allowed invites it to a channel).
4. **Event Subscriptions** → **Enable Events** (no Request URL is needed with Socket Mode) →
   **Subscribe to bot events**: `app_mention`, `message.im`, `message.channels`,
   `message.groups` (and `message.mpim`, `member_joined_channel` if you added their scopes).
5. **Slash Commands** → **Create New Command**: `/polpo`, short description *Talk to Polpo*,
   usage hint `[help | new | agent NAME | status | tasks | start TOKEN]`.
6. **App Home** → **Show Tabs** → **Messages Tab** on, and tick *Allow users to send Slash
   commands and messages from the messages tab* (people can DM the app).
7. **Install App** → **Install to Workspace** → **Allow**. Copy the **Bot User OAuth Token**
   (`xoxb-…`): this is the **bot token**.

Interactivity (the buttons) works through Socket Mode on its own: no Request URL either.

## 2. Add the channel in the dashboard

1. **Configuration → Channels → Add channel → Slack**. Name it (e.g. `slack`). For notifications
   set **Channel ID** (in Slack: the channel's details → *Channel ID*, `C0123ABC`; invite the app
   to that channel with `/invite @Polpo`). **Add channel**.
2. In the channel's sheet, **Slack app**: paste the **bot token** (`xoxb-…`) and **Save**, then the
   **app-level token** (`xapp-…`) and **Save**. They go to the vault (owner `$channels`), are shown
   only as *Stored* / *Not set* from then on, and are never returned by the API, passed through MCP
   or written to a log.
3. **Routing** → turn **inbound** on, choose the **DM policy** (*Pairing* is the default: an unknown
   person gets a code to approve), optionally a **dedicated agent** (the whole app talks to that
   agent), what to answer **in Slack channels** (mentions, threads and `/polpo`, or every message),
   **group replies** (mentions or intent), who may use **commands**. **Save changes**.
4. The **Slack app** section turns *Connected* (`@polpo · Acme`). **Test** checks the bot token.

Notifications only: an Incoming Webhook URL is enough (no tokens), or the bot token with a channel
ID (inbound off).

From an assistant (MCP): `polpo_channel_save { name: "slack", type: "slack", chat_id: "C0123ABC",
gateway: { enableInbound: true } }` creates it and returns the hand-off for the two tokens
(`setup_url` to the sheet, `setup_ids` `slack:slack:botToken` / `slack:slack:appToken` for
`polpo_setup_wait`); `polpo_slack_status { test: true }` checks it.

## 3. Use it

- **DMs**: write to the app. With *Pairing*, the first message answers with a code: approve it in
  the sheet (*Waiting for approval*) or with `polpo_channel_pairing`; or send the person an invite
  (`polpo_channel_invite` / the sheet) and they run `/polpo start <token>` in their DM with the app.
  Each person has their own sessions (per-peer), like on Telegram.
- **Channels**: invite the app (`/invite @Polpo`), then someone already allowed enables it with
  `/polpo enable` (or `@Polpo /enable`). From then on everyone there can talk to it: a **mention**
  opens a **thread** and the answer goes there; replies in that thread need no mention; **each
  thread is its own conversation and session**. Messages that are not for the app are read as
  context. `/polpo disable` turns it off there.
- **Commands**: Slack keeps anything typed with `/` for itself, so commands go through `/polpo`:
  `/polpo` (help), `/polpo new`, `/polpo agent backend`, `/polpo polpo`, `/polpo status`,
  `/polpo tasks`, `/polpo approve <id>`… — or after a mention: `@Polpo /new`.
- **Buttons**: choices (e.g. `/polpo agent` without a name) come as buttons.
- **Files**: files you send are downloaded and passed to the agent; files the agent produces are
  uploaded in the thread.

## Surfaces

- REST: `GET /api/v1/slack`, `GET /api/v1/slack/{name}/status`, `PUT /api/v1/slack/{name}/secrets`
  (dashboard), `DELETE /api/v1/slack/{name}/secrets/{kind}`, `POST /api/v1/slack/{name}/test`;
  sending to a Slack channel or thread: `POST /api/v1/notifications/send { channel, title, body,
  to: "C0123ABC", threadTs: "1712345678.123456" }`. See `docs/openapi.json`.
- MCP: `polpo_slack_status`, `polpo_channel_save` (`slack.channelMessages`, `chat_id`),
  `polpo_channel_route_set`, `polpo_channel_access_set`, `polpo_channel_invite`,
  `polpo_channel_peers`, `polpo_peer_presence`, `polpo_peer_link`, `polpo_message_send { channel:
  "slack", to, thread_ts }`. Polpo's chat has them as `channel_*` and `send_notification`.
- SDK: `getSlackChannels()`, `getSlackStatus()`, `setSlackSecrets()`, `removeSlackSecret()`,
  `testSlack()`; React: `useSlackStatus`, `usePeers`.

## Troubleshooting

- **Error · invalid_auth** in the Slack app section: a token was revoked or belongs to another app;
  paste it again. The connection retries a failed start (5 s, 15 s, 1 min, then every 5 min) and
  reconnects a dropped socket on its own.
- **No answer in a channel**: the app is not in the channel (`/invite @Polpo`), the channel is not
  enabled (`/polpo enable`), or the message did not mention the app (or set *Every message*).
- **No answer in DMs**: the Messages tab is off (App Home), or the DM policy refused the person
  (allowlist) — check *Waiting for approval* in the sheet.
- **Files not received**: the bot token lacks `files:read`; reinstall the app after adding scopes.
