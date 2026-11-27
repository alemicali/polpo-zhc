# A computer's live view and take control

An agent that works on a **remote computer** ([computers.md](computers.md), Daytona v2) can run its
browser **headed**: a real window on the computer's virtual desktop. You watch that desktop live
from the computer's page, and when the agent needs something only you can do (sign in with your
password, enter a 2FA code, solve a CAPTCHA, approve a consent) you **take control**, do it in the
live view, and **give it back**. The agent waits meanwhile and never sees what you type.

## Turning it on for an agent

`browserHeaded` in the agent's configuration (`.polpo/polpo.json`, the API, `polpo_agent_update`,
Polpo's `update_agent`, or the switch in the agent's **Computer** tab):

```json
{
  "name": "nina",
  "allowedTools": ["browser_*"],
  "defaultComputer": "nina",
  "browserHeaded": true
}
```

| Field | Meaning |
|---|---|
| `browserHeaded` | `true`: agent-browser runs with `--headed`. On a remote computer the window opens on its virtual display (`DISPLAY=:99` in the VM, started on first use); on this server on Polpo's virtual display (Browser Live). Default `false`: headless, as before. The browser profile (`$HOME/.polpo/browser-profiles/<name>` in the VM), the session (the agent's name) and the egress proxy (Tailscale, `socks5://127.0.0.1:1081` in the VM) are unchanged. |

The agent gets the `request_computer_takeover` tool on a remote computer when `browserHeaded` is
`true` (or when `request_computer_takeover` is in its `allowedTools`).

## The desktop in the VM

Started on demand, idempotently, everything under `/tmp/polpo-desktop` (`0700`):

- **Xvfb** on `:99` (no TCP) and **openbox**: what headed browsers open on. A headed browser
  starts it itself; the live view starts it too.
- **x11vnc** on `127.0.0.1:5900` only, with two passwords (full control, view-only) given through
  the command's environment and read from a file x11vnc deletes at once: never on a command line,
  never left on disk. They change whenever control changes hands.
- **websockify** on `0.0.0.0:6080` → the VNC port: what Daytona's signed preview link reaches.

The runner image `polpo-runner-vm-4` ships these packages (`xvfb`, `x11vnc`, `openbox`,
`websockify`, `xdotool`). A VM from an older image installs what is missing once with `apt-get`
(a minute the first time). Build the new image in your Daytona v2 project with:

```bash
DAYTONA_V2_API_KEY=dtn_... node scripts/build-sandbox-images.mjs --provider daytona-v2
```

Until it is built, VMs are created from `polpo-runner-vm-3` (with a warning) and the packages are
installed on first use.

## Watching and taking control

On the computer's page (**Computers → the computer → Live**) and in the agent's **Computer** tab:

1. **Start live view** (it starts or wakes the computer: it costs while it runs). You see the
   desktop **view-only**: the agent holds it.
2. **Take control**: your view becomes interactive and the agent's `browser_*` tools on that
   computer **wait** (they never act while a person holds it; after 30 minutes they give up with a
   message). Only the person holding the computer gets the full-control VNC password; everyone
   else watching stays view-only.
3. Do what is needed, in the live view. Optionally write a note for the agent ("Signed in, 2FA
   done, you are on the feed"): never a password.
4. **Give back**: the agent goes on, reading your note.

Without member sign-in every viewer is "someone" (one person). With members, only the person
holding the computer can give it back (or anyone with `force`).

## `request_computer_takeover`

```
request_computer_takeover({ reason: string, url?: string, what_to_do?: string, timeout_minutes?: number })
```

The agent asks for a person. The request is recorded on the computer (a banner on its page and in
the agent's Computer tab; `GET /computers/:id/control`, `GET /computer-takeovers`,
`polpo_computer_desktop` without `id`) and announced as a `computer:takeover` event. You are notified:

- on the agent's own notification channels when it has them (`notifyChannels` with
  `send_notification` in `allowedTools`, see [agent-notifications.md](agent-notifications.md));
- otherwise through the instance's notification router: its rules on `computer:takeover`, or (no
  such rule) its first configured channels.

The tool then **waits** (default 30 minutes, at most 24 hours; a stopped run stops waiting) until a
person took control and gave it back, and returns their note; or it reports the timeout. It works on
every engine: Polpo's, and Claude Code / Codex / OpenCode harnesses as a host tool. A task run asks
the server over the notification socket, as the run's agent.

## CDP_URL: scripts drive the same browser

An agent with browser tools gets, in every bash command:

| Variable | Value |
|---|---|
| `CDP_URL` | `http://127.0.0.1:PORT`, the HTTP CDP endpoint of **its own** agent-browser session (from `agent-browser --session <name> get cdp-url`), while that session runs. Never set by launching a browser: open it first (`browser_navigate`). |
| `POLPO_BROWSER_SESSION` | Its session name (its agent name): `agent-browser --session "$POLPO_BROWSER_SESSION" …`. |
| `DISPLAY` | `:99` (or this server's display) when the browser is headed. |

So a skill's script (a Python CDP client using `/json/new`, `/json/list`) drives the same signed-in
browser the agent's `browser_*` tools use. The agent's prompt says so. These variables come with
Polpo's `bash` tool; on Claude Code / Codex / OpenCode engines (their own shell) the prompt tells the
agent to run `agent-browser --session <name> get cdp-url` (the same endpoint).

## API, MCP, Polpo, SDK

| Surface | What |
|---|---|
| REST | `GET /computers/:id/desktop` (`?viewer=1`: your VNC password while it runs), `POST /computers/:id/desktop/start`, `POST /computers/:id/desktop/stop`, `GET /computers/:id/control`, `POST /computers/:id/takeover` `{ force? }`, `POST /computers/:id/release` `{ note?, force? }`, `GET /computer-takeovers` |
| WebSocket | `/api/v1/computers/:id/desktop/vnc`: the live view (noVNC), authorized like the terminal (the session cookie or `?api_key=`), only while this server started the live view |
| MCP | `polpo_computer_desktop` (status, start, stop; without `id`: every agent waiting for a person), `polpo_computer_takeover`, `polpo_computer_release`, and the card `polpo_computer_show` (an MCP App with Take control / Give back and a link to the live view). The VNC password is never in a tool result. |
| Polpo (chat) | `computer_desktop`, `computer_takeover`, `computer_release` (group "computers") |
| React SDK | `useComputerDesktop(id, { viewer })` (view, start, stop, takeover, release), `useComputerTakeovers()`; client `getComputerDesktop`, `startComputerDesktop`, `stopComputerDesktop`, `getComputerControl`, `takeoverComputer`, `releaseComputer`, `getComputerTakeovers` |
| Event | `computer:takeover` `{ id, action: requested / taken / released / timeout / cancelled / desktop-started / desktop-stopped, holder, person?, requestId?, agent?, reason?, url?, note?, taskId? }` |

## Security

- The live view's WebSocket and every Browser Live WebSocket (`/api/v1/browser-dashboard/*`) are
  authorized like the terminal: a signed-in person (session cookie) or an API key.
- The preview link that reaches websockify carries Daytona's token, and VNC still asks its password.
- The VNC passwords live in the server's memory only (after a restart, starting the live view sets
  new ones), never in events, logs or tool results; the full-control one only goes to the person
  holding the computer, and both change whenever control changes hands.
- What you type in the live view goes to the VM's desktop, never through Polpo's chat or the agent.
