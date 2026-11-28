# A computer's live view and take control

An agent that works on a **remote computer** ([computers.md](computers.md), Daytona v2) runs its
browser **headed** by default: a real Google Chrome window on the computer's virtual desktop. You watch that desktop live
from the computer's page, and when the agent needs something only you can do (sign in with your
password, enter a 2FA code, solve a CAPTCHA, approve a consent) you **take control**, do it in the
live view, and **give it back**. The agent waits meanwhile and never sees what you type.

## Headed or headless

On a remote computer the browser is headed unless `browserHeaded` is `false`; on this server it is
headless unless `browserHeaded` is `true`. Set it in the agent's configuration (`.polpo/polpo.json`,
the API, `polpo_agent_update`, Polpo's `update_agent`, or the **Headed browser** switch in the
agent's **Computer** tab, which shows the default while the field is unset):

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
| `browserHeaded` | `true`: a visible browser window. On a remote computer the agent's own Chrome (below) opens on its virtual display (`DISPLAY=:99` in the VM, started on first use); on this server on Polpo's virtual display (Browser Live). `false`: headless. **Unset**: headed on a remote computer (Daytona, E2B; when the computer cannot get a display, it quietly runs headless instead, while an explicit `true` reports the error), headless on this server. The browser profile (`$HOME/.polpo/browser-profiles/<name>` in the VM), the session (the agent's name) and the egress proxy (Tailscale, `socks5://127.0.0.1:1081` in the VM) are unchanged. |

The agent gets the `request_computer_takeover` tool on a remote computer when its browser is
headed: `browserHeaded: true`, or unset with browser tools (`browser_*`) in its `allowedTools`; or
when `request_computer_takeover` is in its `allowedTools`.

## Google Chrome, never Chromium

Agents' browsers are always **real Google Chrome**, never agent-browser's bundled Chrome for Testing
nor Playwright's Chromium. Chromium and headless browsers get flagged as bots by sites like Google
Maps, Instagram and Facebook.

- **Remote computer**: `/usr/bin/google-chrome`. A VM without it installs it once, before the first
  browser command, from Google's package
  (`https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb`, with `apt-get`, only
  when `command -v google-chrome` fails; amd64 only). The runner image `polpo-runner-vm-4` ships it.
  As root (Daytona VMs) Chrome gets `--no-sandbox`, which it needs to start as root. Polpo
  launches it itself and agent-browser attaches over CDP: see the next section.
- **This server**: the installed Chrome (`google-chrome-stable` / `google-chrome` on `PATH`,
  `/opt/google/chrome/chrome`, or `/Applications/Google Chrome.app` on macOS), found once.
  `POLPO_AGENT_BROWSER_EXECUTABLE=/path/to/chrome` overrides it. Without Chrome the browser tools
  fail with an error saying Google Chrome must be installed: there is no Chromium fallback.
  The same applies to profile logins (`POST /browser-profiles/:name/login`, `polpo browser login`)
  and to Polpo's own browser when it is not attached to your Chrome over CDP (Browser Live's
  "Launch my Chrome" is unchanged).
- **The agent is told** (its prompt, the `browser_navigate` description, harness instructions) to use
  Polpo's browser only, the `browser_*` tools or `$CDP_URL` from scripts (Playwright
  `connectOverCDP`, Puppeteer `connect`), and never to launch a Chromium, Chrome or Playwright
  browser of its own.

## The agent's own Chrome (remote computers)

agent-browser launches Chrome through Playwright, with automation flags (`--enable-automation`
and others): `navigator.webdriver` is `true` and Google sign-in answers **"This browser or app may
not be secure"**, even with real Google Chrome and a residential IP. So on a remote computer Polpo
**launches the agent's Chrome itself, like a person would**, and agent-browser only attaches to it
(`agent-browser --session <agent> --cdp <port>`). `navigator.webdriver` is `false`, the user agent is
Chrome's normal one, there are no automation flags. It is how other agent computers do it (a normal
Chrome per desktop, driven over loopback CDP).

Before every browser command that can open a page (the same shell command, so nothing extra to wait
for when it runs), Polpo makes sure **one Chrome per agent profile** runs in the VM:

```sh
TZ=Europe/Rome LANGUAGE=it_IT DISPLAY=:99 setsid nohup /usr/bin/google-chrome \
  --user-data-dir="$HOME/.polpo/browser-profiles/<profile>" \
  --remote-debugging-port=<port> --remote-debugging-address=127.0.0.1 \
  --no-first-run --no-default-browser-check --lang=it-IT --accept-lang=it-IT,it \
  --window-size=<desktop size, 1280,800 by default> --window-position=0,0 \
  [--proxy-server=socks5://127.0.0.1:1081 --proxy-bypass-list='<-loopback>'] [--no-sandbox] about:blank
```

- **Headed** on the computer's desktop (`DISPLAY=:99`, the desktop's size) by default; with
  `browserHeaded: false`, or no display to be had, it runs with `--headless=new`.
- **The DevTools port** is bound to `127.0.0.1` in the VM, one per profile (from 9300 to 9899,
  stable per profile name, the next free one when taken).
- **Egress proxy**: the same decision as before (the computer's Tailscale egress, the forwarder
  `socks5://127.0.0.1:1081`; none: the VM's own network) becomes `--proxy-server`.
- **Language and timezone**: the agent's identity, `identity.locale` (a BCP 47 tag, e.g. `en-US`:
  `--lang` and `--accept-lang`, so `navigator.language` and the `Accept-Language` header) and
  `identity.timezone` (an IANA zone, e.g. `Europe/Rome`: `TZ` in Chrome's environment). Defaults
  **`it-IT`** and **`Europe/Rome`** (`AGENT_CHROME_DEFAULT_LOCALE`, `AGENT_CHROME_DEFAULT_TIMEZONE` in
  `src/tools/agent-chrome.ts`).
- **`--no-sandbox` only as root**, never an automation flag. A vault secret a `browser_fill` carries
  in the command's environment is unset before Chrome starts.
- **State** in `$HOME/.polpo/browser-chrome/<profile>.{pid,port,conf,log}`: a Chrome that died is
  launched again on the next command; one started with other settings (proxy, language, timezone,
  display) is stopped and launched again. Before a launch, the agent-browser session is closed (so it
  attaches afresh) and a process still holding the profile (`SingletonLock`, e.g. a Chrome
  agent-browser launched before this change) is stopped first.
- **It survives task runs**: at the end of a run Polpo only closes the agent-browser session, which
  detaches from Chrome; Chrome and its pages stay open, so a page a person left open during take
  control is not lost. It goes away with the computer (stop, hibernation) and is launched again on
  the next browser command.

On **this server** (agents without a remote computer) nothing changes: agent-browser launches Google
Chrome with `--executable-path` and `--profile`, headless unless `browserHeaded: true`.

### "Chrome di <agent>" on the desktop

With a headed browser, the same command also writes (only when they changed, so the desktop does not
flicker):

- `$HOME/.polpo/browser-chrome/<profile>.launch.sh` (`0700`): the ensure script above, then the
  agent's Chrome window brought to the front (`xdotool windowactivate`);
- a launcher **"Chrome di <agent display name>"** (`identity.displayName`, else the agent's name) in
  `~/Desktop` and in the XFCE menu (`~/.local/share/applications/polpo-chrome-<profile>.desktop`,
  category Internet), running that script. On the desktop it is marked trusted for XFCE when it can
  be (`gio` and the session's bus); otherwise XFCE asks once whether to launch it.

So a person on the live view who closed the agent's Chrome reopens the **same clean Chrome**: its
profile and sign-ins, egress proxy, language, timezone and DevTools port, no automation flags,
never a plain `google-chrome`. A Chrome already running is just brought to the front. If nobody
reopens it, the agent's next `browser_*` call launches it again (its recorded pid is dead).

## The desktop in the VM

A real PC desktop, not a bare window manager. Started on demand, idempotently, everything under
`/tmp/polpo-desktop` (`0700`):

- **Xvfb** on `:99` (no TCP), `1280x800x24` or the computer's **`desktop.size`** (below): what
  headed browsers open on. A headed browser starts it itself; the live view starts it too.
- **XFCE** on it: `dbus-launch --exit-with-session startxfce4`, its pid recorded
  (`wm.pid`, `wm.kind` = `xfce`) and started again when it died. Panel, applications menu, Thunar
  (files), xfce4-terminal, Mousepad (text editor), the task manager; installed without
  recommends, no `xfce4-goodies`. Set up on the first start (a person's later changes are kept):
  - no screensaver, screen locker or power manager (their autostart entries are hidden:
    `xfce4-screensaver`, `light-locker`, `xscreensaver`, `xfce4-power-manager`; `xset s off -dpms`);
  - no compositing (`xfwm4` `use_compositing=false`): VNC sends less;
  - the default panel, so XFCE never asks which one on the first start;
  - the **language, timezone and keyboard** of the computer's agent: `LANG` from
    `identity.locale` (`it-IT` → `it_IT.UTF-8`, generated with `locale-gen` when missing, else
    `C.UTF-8`), `TZ` from `identity.timezone` (default `Europe/Rome`), the keyboard layout
    (`setxkbmap it` by default; `en-US` → `us`, `en-GB` → `gb`, `de` → `de`…). The browser tools
    use the agent's identity; the live view the identity of the computer's default agent. The
    session keeps the settings it started with.
  - **openbox** only as a fallback: when XFCE cannot be installed, openbox runs instead (`wm.kind`
    = `openbox`); once XFCE is there, it replaces openbox at the next start.
- **Clipboard**: x11vnc carries it both ways (and `xclip`/`xsel` are installed for scripts). The
  live view's **Clipboard** button shows what was copied on the desktop (**Copy** puts it on your
  device's clipboard) and, while you hold control, sends text to the desktop's clipboard (paste
  it there with Ctrl+V). The desktop's clipboard reaches every viewer; a viewer's only the
  person in control (the server drops it for the others).
- **x11vnc** on `127.0.0.1:5900` only, with **one** password, set when it starts, given through
  the command's environment and read from a file x11vnc deletes at once: never on a command line,
  never left on disk. It does not change when control changes hands: nothing restarts.
  Options: `-cursor arrow` (a visible cursor, drawn by the viewer), `-noncache`, `-wait 10
  -defer 10` (poll and send updates every 10 ms), `-nowf`, `-noxdamage` (on Xvfb, DAMAGE hints
  can miss what a browser paints; polling does not), `-repeat`.
- **websockify** on `0.0.0.0:6080` → the VNC port: what Daytona's signed preview link reaches.

## How the server sits in the middle

The browser never gets a VNC password. The Polpo server terminates the RFB handshake towards the
VM itself (`src/server/rfb-proxy.ts`):

1. Towards the VM it is the VNC client: it answers **VNC Authentication** (DES challenge-response
   with the computer's password, `src/sandbox/vnc-auth.ts`: `node:crypto` when its OpenSSL still
   has single DES, else a small pure-JS DES) and reads the VM's ServerInit.
2. Towards the browser it is a VNC server offering only security type **None** (RFB 3.8; 3.7 and
   3.3 viewers too), then hands the browser the VM's ServerInit.
3. Then the VM's messages go to the browser as they are, and the browser's are parsed one by one:
   **input** (KeyEvent, PointerEvent, ClientCutText, QEMU extended keys, SetDesktopSize, xvp)
   passes only if the viewer is the person holding the computer **at the moment the message
   arrives**; SetPixelFormat, SetEncodings, FramebufferUpdateRequest, fences and the rest pass
   untouched. A message it cannot frame closes the connection.

So **Take control** and **Give back** are instant: the same connection starts or stops carrying
your input, nobody reconnects.

The password lives in the server's memory and in the **vault** (reserved owner `$desktop`, keyed
by computer id, encrypted at rest like every vault entry, never visible to agents), with the VM it
belongs to. After a server restart, a live view still running on the same VM is **re-attached**
with it (the server looks without starting a stopped machine): no "Start live view" needed. A new
VM, or a password the VNC server refuses, gets a new one at the next start.

The runner image `polpo-runner-vm-4` ships these packages (`DESKTOP_IMAGE_PACKAGES` in
`src/sandbox/desktop.ts`: `xvfb`, `x11-xkb-utils`, `x11-xserver-utils`, `xclip`, `xsel`, `x11vnc`,
`websockify`, `xdotool`, `xfce4`, `xfce4-terminal`, `thunar`, `mousepad`, `xfce4-taskmanager`,
`dbus-x11`, `at-spi2-core`, `fonts-dejavu`, `fonts-liberation`, `tango-icon-theme`,
`adwaita-icon-theme`, `librsvg2-common`, `locales`, `tzdata`; `it_IT.UTF-8` and `en_US.UTF-8`
generated) and Google Chrome. A VM from an older image installs what is missing once with
`apt-get --no-install-recommends` (a few minutes the first time, for XFCE); if XFCE cannot be
installed, openbox is. Build the new image in your Daytona v2 project with:

```bash
DAYTONA_V2_API_KEY=dtn_... node scripts/build-sandbox-images.mjs --provider daytona-v2
```

Until it is built, VMs are created from `polpo-runner-vm-3` (with a warning) and the packages and
Google Chrome are installed on first use.

### Desktop size

`settings.computers[].desktop.size` (`"WIDTHxHEIGHT"`, from `800x600` to `3840x2160`, default
`1280x800`) sets the display's size and the agents' Chrome window size, and the live view keeps
its proportions. Set it in the computer's form (**Desktop size**), with REST (`POST`/`PATCH
/computers/:id` `{ "desktop": { "size": "1600x900" } }`, `null` clears it), MCP
`polpo_computer_save` or Polpo's `computer_save`. A display already running keeps its size: the new
one applies when the machine starts again (stop and start, or a wake from hibernation onto a new
display). Chrome takes the new window size at its next launch.

**Footprint**: XFCE adds roughly 120–180 MB of memory to the VM (xfwm4, panel, xfdesktop,
xfsettingsd, xfce4-session, xfconfd, D-Bus, the accessibility bus) over openbox's ~15 MB, and
about 250–350 MB to the image.

## Watching and taking control

On the computer's page (**Computers → the computer → Live**) and in the agent's **Computer** tab:

1. The live view **connects by itself** whenever the desktop runs: an agent's
   `request_computer_takeover` starts it, and a restarted server re-attaches to it. Otherwise
   **Start live view** (it starts or wakes the computer: it costs while it runs). You see the
   desktop **view-only**: the agent holds it.
2. **Take control**: your view becomes interactive at once (same connection) and the agent's
   `browser_*` tools on that computer **wait** (they never act while a person holds it; after 30
   minutes they give up with a message). The server lets input through only for the person
   holding the computer; everyone else watching stays view-only.
3. Do what is needed, in the live view. Optionally write a note for the agent ("Signed in, 2FA
   done, you are on the feed"): never a password.
4. **Give back**: the agent goes on, reading your note.

Without member sign-in every viewer is "someone" (one person). With members, only the person
holding the computer can give it back (or anyone with `force`).

**Full screen**: the **Full screen** button shows the viewer alone on your screen (the browser's
Fullscreen API on the viewer); **Esc** or **Exit full screen** (top right) leaves it. noVNC scales the
desktop to fit (`scaleViewport`), and while you hold control the keyboard stays on the desktop
(focused when you enter or leave full screen, and on every click). Esc itself is kept by the browser
to leave full screen: it does not reach the desktop.

**Quality follows your role**: while you hold control the viewer asks for sharper, less
compressed frames (noVNC `qualityLevel` 8, `compressionLevel` 2) for responsiveness; while you
watch, lighter ones (5 and 7) to save bandwidth. It switches on the fly, without reconnecting.

## `request_computer_takeover`

```
request_computer_takeover({ reason: string, level?: "soft" | "hard", url?: string, what_to_do?: string, timeout_minutes?: number })
```

The agent asks for a person. The request is recorded on the computer (a banner on its page and in
the agent's Computer tab; `GET /computers/:id/control`, `GET /computer-takeovers`,
`polpo_computer_desktop` without `id`) and announced as a `computer:takeover` event. The computer's
live view starts in the background (a `desktop-started` event when it is up), so it is ready when
you open the page. You are notified:

- on the agent's own notification channels when it has them (`notifyChannels` with
  `send_notification` in `allowedTools`, see [agent-notifications.md](agent-notifications.md));
- otherwise through the instance's notification router: its rules on `computer:takeover`, or (no
  such rule) its first configured channels.

The tool then **waits** (at most 24 hours; a stopped run stops waiting) until a person took control
and gave it back, and returns their note. While it waits it reports progress every minute, so the run
is not taken for stale. It works on every engine: Polpo's, and Claude Code / Codex / OpenCode
harnesses as a host tool. A task run asks the server over the notification socket, as the run's agent.

### Soft and hard requests

The agent says how much it needs the person (`level`; the tool description and the browser prompt
tell agents to choose `hard` for a CAPTCHA, a phone, SMS, email or app verification, a login or
sign-up wall):

| | soft (default) | hard |
|---|---|---|
| Meaning | Optional help: the agent can do without it | Blocking: the task cannot go on without it |
| Default wait | 30 min | 15 min |
| Nobody takes over in time | The request is closed (`timeout`); the agent is told to go on, finish the task and say in its result what it could not do | In a task: the request is **parked** (stays open, never expires, `parkedAt`) and the task is **paused** with reason `waiting for takeover` ([tasks.md](tasks.md#pausing-a-task): its run stops, not failed; `Task.pause.takeover` names the request). Its agent is told to stop. The person is notified again ("… task is paused: it needs you"). The browser on the computer is left as it is. In a chat (no task): closed, and the agent told the step is blocked and to report it |
| Then | — | When a person takes control and gives it back, the task is **resumed**: its run continues (same session) told who completed the takeover and their note. Resuming the task by hand instead cancels the request and tells the agent nobody completed it (ask again if still blocked); killing the task cancels it too |

A hard request of a task is not expired by the server when its wait ends: the run parks it (op
`park` over the notification socket). If the run is gone and never does, it expires 2 minutes later.
The takeover card (computer page, agent's Computer tab, the MCP computer card), the text answers
(MCP, Polpo's chat) and the notifications show the level and the time left ("12 min left, then its
task pauses until you do it"); a parked request shows that its task is paused.

Note: a task's own timeout (`maxDuration`, default `taskTimeout`) still counts while its agent waits.

## CDP_URL: scripts drive the same browser

An agent with browser tools gets, in every bash command:

| Variable | Value |
|---|---|
| `CDP_URL` | `http://127.0.0.1:PORT`, the HTTP CDP endpoint of **its own** browser while it runs: on a remote computer the agent's own Chrome (the port Polpo recorded when it launched it), on this server its agent-browser session (`agent-browser --session <name> get cdp-url`). Never set by launching a browser: open it first (`browser_navigate`). |
| `POLPO_BROWSER_SESSION` | Its session name (its agent name): `agent-browser --session "$POLPO_BROWSER_SESSION" …`. |
| `DISPLAY` | `:99` (or this server's display) when the browser is headed (by default on a remote computer). |

So a skill's script (a Python CDP client using `/json/new`, `/json/list`) drives the same signed-in
browser the agent's `browser_*` tools use. The agent's prompt says so. These variables come with
Polpo's `bash` tool; on Claude Code / Codex / OpenCode engines (their own shell) the prompt tells the
agent to run `agent-browser --session <name> get cdp-url` (the same endpoint).

## API, MCP, Polpo, SDK

| Surface | What |
|---|---|
| REST | `GET /computers/:id/desktop` (`size`, `processes.session` `xfce`/`openbox`; `?viewer=1`: your role, `control` or `view`, and the WebSocket path while it runs; never a password), `POST /computers/:id/desktop/start`, `POST /computers/:id/desktop/stop`, `GET /computers/:id/control`, `POST /computers/:id/takeover` `{ force? }`, `POST /computers/:id/release` `{ note?, force? }`, `GET /computer-takeovers` |
| WebSocket | `/api/v1/computers/:id/desktop/vnc`: the live view (noVNC), authorized like the terminal (the session cookie or `?api_key=`), only while the live view runs; security type None towards the browser (the server answers the VM's VNC authentication), input only from the person holding the computer |
| MCP | `polpo_computer_desktop` (status, start, stop; without `id`: every agent waiting for a person), `polpo_computer_takeover`, `polpo_computer_release`, and the card `polpo_computer_show` (an MCP App with Take control / Give back and a link to the live view). No VNC password exists outside the server. |
| Polpo (chat) | `computer_desktop`, `computer_takeover`, `computer_release` (group "computers") |
| React SDK | `useComputerDesktop(id, { viewer })` (view, start, stop, takeover, release), `useComputerTakeovers()`; client `getComputerDesktop`, `startComputerDesktop`, `stopComputerDesktop`, `getComputerControl`, `takeoverComputer`, `releaseComputer`, `getComputerTakeovers` |
| Event | `computer:takeover` `{ id, action: requested / taken / released / timeout / cancelled / parked / desktop-started / desktop-stopped, holder, person?, requestId?, agent?, reason?, url?, note?, taskId?, level?, expiresAt? }`; a hard request's paused task also emits `task:paused` / `task:resumed` |

## Security

- The live view's WebSocket and every Browser Live WebSocket (`/api/v1/browser-dashboard/*`) are
  authorized like the terminal: a signed-in person (session cookie) or an API key.
- The preview link that reaches websockify carries Daytona's token, and VNC still asks its password,
  which only the Polpo server knows: it never reaches a browser, an event, a log, a REST answer or
  a tool result. It is kept in memory and in the vault (`$desktop`) to survive restarts.
- A viewer cannot act on the desktop unless they hold the computer: the server drops their input
  messages (keys, pointer, clipboard), whatever their browser sends.
- What you type in the live view goes to the VM's desktop, never through Polpo's chat or the agent.
