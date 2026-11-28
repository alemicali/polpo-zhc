# Computers

A **computer** is a machine an agent keeps. A sandbox is per run: created, maybe reused for a few
minutes, then deleted. A computer stays: the same remote machine every time, with its working
directory, the tools the agent installed and its browser profile, between chats and tasks. It
stops by itself when nobody uses it and is **never deleted automatically**.

Every agent has the implicit computer **`host`**: this server, with the sandbox settings as before
(Settings → Sandbox, the agent's Sandbox tab, missions and tasks).

## Model

`settings.computers` in `.polpo/polpo.json` (validated when the file loads and by the API):

```json
{
  "settings": {
    "computers": [
      {
        "id": "nina",
        "name": "Nina",
        "kind": "daytona",
        "lifecycle": { "idleStopMinutes": 15, "autoArchiveDays": 7 }
      }
    ]
  }
}
```

| Field | Meaning |
|---|---|
| `id` | Slug (`a-z`, `0-9`, `-`, up to 40). `host` and `ephemeral` are reserved. |
| `name`, `description` | Shown in the dashboard. |
| `kind` | `daytona`, `e2b`, or `host` (this server: useful with an egress proxy). Cannot change. |
| `snapshot` / `image` | Daytona v0: a snapshot (default: the instance's `settings.sandbox.providers.daytona.snapshot`) or a Docker image (sized by `resources`). Daytona v2: `image` is an image of the Daytona project (default: the instance's `providers.daytona.image`, else the Polpo runner image `polpo-runner-vm-4`); `snapshot` is ignored. |
| `template` | E2B template (default: the instance's). |
| `resources` | `{ cpus, memoryMb, diskMb }`: Daytona v0 with an image only (snapshots and templates have their own size); Daytona v2 always (default 2 vCPU, 4 GB, 10 GB). |
| `lifecycle.idleStopMinutes` | Stop (Daytona v0 container), pause (E2B, Daytona v0 VM class) or hibernate (Daytona v2) after this many minutes without use. Default 15. |
| `lifecycle.autoArchiveDays` | Daytona v0: archive after this many days stopped (the disk moves to object storage: free, slower to start). Default: Daytona's (7). Ignored on v2 (a hibernated computer is a snapshot). |
| `network` | `{ mode, allow }` as in the sandbox settings. Default: the instance's. Daytona v0 and E2B: fixed when the machine is created. Daytona v2: applied again whenever a VM is made (create, wake, rotation), so a changed rule takes effect on the next wake. |
| `egress` | The egress proxy (`settings.egressProxies`) the browser of its agents goes out through. A remote computer (Daytona, E2B) reaches it through **Tailscale inside its VM**: it needs `settings.tailscale` (an auth key in the vault), a SOCKS5 proxy on a tailnet address, and a network that is not `deny` — see [Remote computers through Tailscale](residential-egress.md#remote-computers-daytona-e2b-through-tailscale). |
| `volumes` | Volumes attached to runs on the computer (names granted to the agent, as in the sandbox settings). |
| `desktop` | Remote computers: `{ "size": "1600x900" }`, the size of its XFCE desktop (`WIDTHxHEIGHT`, 800x600 to 3840x2160; default `1280x800`) and of its agents' Chrome windows. A running display keeps its size until the machine starts again. Not for `host`. |

Agents:

| Field | Meaning |
|---|---|
| `defaultComputer` | The computer its chats **and** tasks run on. Unset or `host`: this server. |
| `computers` | Other computers a task may ask for (`sandbox.computer: "<id>"`). |

There is no `class` field. Which Daytona service a `daytona` computer uses is the instance's
`settings.sandbox.providers.daytona.api` (see [Daytona v2](daytona-v2.md)):

- **v0** (default): Daytona's 0.x API does not take a sandbox class at create time — the class comes
  with the snapshot (`snapshot.create({ sandboxClass: "linux-vm" })`). A computer built from a
  `linux-vm` snapshot is switched to auto-pause (memory kept) after creation; from a container
  snapshot (our `polpo-runner-*` today) it stops (disk kept, processes not).
- **v2**: every machine is a Linux VM that **hibernates** (see below): its Linux sandboxes are
  not persistent on the plans seen so far (pause, stop and fork are refused with 409, the wall
  clock deletes them after at most 24 h), but memory and disk snapshots work and are fast. E2B
  stays available as another provider.

### Hibernation (Daytona v2)

A v2 computer is kept as **memory and disk snapshots** of its VM:

- **Hibernate** (idle for `idleStopMinutes`, or **Stop**): a snapshot
  `polpo-computer-<instance>-<id>-<UTC timestamp>` (`createSnapshot`; ready in about 2 s, waited
  for up to `snapshotTimeoutSeconds`, default 5 min), then the VM is deleted, then older snapshots
  beyond `keepSnapshots` (default 1: a hibernated computer keeps only the newest). Status
  **hibernated** ("Hibernated (resumes in a few seconds)"); the card, the agent's Computer tab,
  `polpo_computers_list` and `computers_list` show the last snapshot's time and size. A snapshot
  that fails (or never gets ready) **keeps the VM running**: the error is on the card and it is
  tried again after `retryMinutes` (default 10). The VM is never deleted before its snapshot is
  ready (deleting it earlier makes the snapshot fail).
- **Wake** (any use, or **Start**): a VM from the newest snapshot (`createFromSnapshot`, about
  3 s: files **and running processes** come back) with the computer's stable name and labels and
  a wall clock of `min(maxTimeoutSeconds, 86400)` that deletes it; its network rule is applied
  again (a VM that cannot get it is deleted again: it never runs wider than asked); its tailnet is
  checked again (tailscaled comes back with the memory; it is restarted when it did not). Only
  then are older snapshots deleted (`keepSnapshots`, default 1; a failed wake deletes none). No snapshot (first use, or every
  snapshot gone): a new VM from the image, with a notice when there were snapshots.
- **The 24 h wall clock**: an hour before it (`rotateBeforeMinutes`) the computer is rotated —
  snapshot, then a new VM from it (a pause of a few seconds; commands wait) — at once when idle,
  else at the first quiet gap of `rotateIdleGapSeconds` (90 s), and in any case once
  `forceRotateMinutes` (10) are left (running commands are then cut; logged as a warning and shown
  as a notice).
- **Safety snapshots**: while it runs, a snapshot every `safetySnapshotHours` (6; 0 = off), so a VM
  that vanishes anyway (wall clock, provider) loses at most that window. A VM found gone is
  restored from the last snapshot on its next use, with a notice in `computer:changed`.
- Commands that arrive while it hibernates or rotates wait for the new VM. Hibernation waits for
  the commands of the server process to finish (up to a minute).
- **Reset** deletes its VM and **all its snapshots**, then makes a fresh VM from the image;
  **Delete** the same, and the computer. Only snapshots named for this instance and computer, and
  VMs labelled for it, are ever touched.
- Costs: a hibernated computer costs snapshot storage only (roughly its memory plus its disk; the
  memory part of a 4 GB VM measured ~224 MB), times `keepSnapshots` (plus safety snapshots until
  the next wake). Waking takes ~3 s.

Settings (`settings.sandbox.providers.daytona.hibernate`, all optional):

```json
{ "keepSnapshots": 1, "safetySnapshotHours": 6, "rotateBeforeMinutes": 60, "rotateIdleGapSeconds": 90,
  "forceRotateMinutes": 10, "snapshotTimeoutSeconds": 300, "retryMinutes": 10 }
```

If snapshots are not available to the project (the API refuses them), Stop and idle hibernation
fail with the API's error on the card and the VM keeps running.

### Credential brokering (agent harnesses)

When an agent runs on a harness (Claude Code, Codex: [harnesses.md](harnesses.md)), its model key
should not enter the VM. Brokering is implemented once in the shared harness sandbox session, for
every provider:

- Every provider today (Daytona v2, Daytona v0, E2B, and any new provider by default) is brokered by
  **Polpo's model relay**: the VM's base URL becomes `<POLPO_PUBLIC_URL>/api/v1/harness-relay/<token>`
  and Polpo applies the same rules outside the VM (see harnesses.md → Credential brokering, and the
  Funnel path to expose).

## Which machine a run uses

1. A task or mission that asks for an **ephemeral sandbox** gets one from the sandbox cascade:
   `sandbox.computer: "ephemeral"`, an explicit `sandbox.provider`, `sandbox.isolation: "fresh"`,
   or a **stricter network** than the computer has (a computer's network is fixed when it is
   created, so the stricter rule needs a fresh sandbox).
2. A task or mission may name one of the agent's computers: `sandbox.computer: "<id>"` (or
   `"host"`). A computer the agent may not use is reported (`sandbox:override-denied`) and its
   default applies.
3. Otherwise the agent's **`defaultComputer`**, for its chats and its tasks alike (no `chatRemote`
   needed: assigning a computer is the opt-in).
4. No default (or `host`): the sandbox cascade instance → agent → mission → task, as before.

On a remote computer the computer's network rule applies (else the instance's), not the agent's.
If its provider has no API key on this server, the cascade applies (with the usual visible
fallback).

### Choosing a computer per task

A single task, or each task of a mission, may run on any of its agent's computers instead of the
default one. The choice is the task level of the sandbox cascade, `sandbox.computer`:

| Value | Runs on |
|---|---|
| absent | the agent's `defaultComputer` (else this server) |
| one of the agent's `computers` or its `defaultComputer` | that computer |
| `"host"` | this server |
| `"ephemeral"` | a fresh sandbox from the cascade |

Any other id is **refused when the task is created or changed** (400 `INVALID_COMPUTER`, with the
agent's choices in `allowed`): add the computer to the agent first. (A task whose agent loses the
computer later falls back to the default at run time, reported as `sandbox:override-denied`.)

Precedence: the task's own `sandbox` (`Task.sandbox`) → its entry in the mission document
(`tasks[].sandbox`) → the mission's `sandbox` → the agent's default. A change applies to the
task's next run; a running one keeps its machine.

Everywhere:

- **REST**: `POST /tasks { …, "sandbox": { "computer": "daytona-box" } }`;
  `PATCH /tasks/:id { "sandbox": { "computer": "ms-nina-01" } }` (`"sandbox": null` goes back to
  the agent's default); `GET /tasks/:id` returns `sandbox`. Missions: `tasks[].sandbox.computer`
  in the mission data (checked on `POST`/`PATCH /missions`).
- **MCP**: `polpo_task_create { …, computer: "daytona-box" }`,
  `polpo_task_update { id, computer }` or `{ id, default_computer: true }`.
- **Polpo's chat**: `create_task { …, computer }`, `update_task { taskId, computer }` (`null`: the
  agent's default).
- **SDK**: `CreateTaskRequest.sandbox` / `UpdateTaskRequest.sandbox` (`TaskSandbox`).
- **Dashboard**: the task page's **Computer** select.

## Lifecycle

- The machine is found by its provider label **`polpo-computer=<instance>:<id>`** (Daytona label,
  E2B metadata), not by the per-project pool file. It survives restarts and the pool file; the pool
  reaper never deletes it.
- First use (or **Start**): created with that label, auto-delete off (Daytona v0
  `autoDeleteInterval: -1`; E2B `lifecycle.onTimeout: "pause"`), `autoStopInterval` = the idle time,
  `autoArchiveInterval` = the archive days. (Daytona v2: see Hibernation.) Later uses:
  started (or resumed, or unarchived) if it is not running; created again only if the provider has
  none.
- Creating, starting, stopping and resetting are serialized per computer (in the process and, with
  a lock file under `.polpo/computers/`, across the task runners). Commands run concurrently: a chat
  and a task can use the computer at the same time.
- Every command and file operation keeps it in use (`lastUsedAt`, and the provider's own idle timer);
  a long command keeps it in use while it runs. After a minute without checking, the next operation
  verifies it still runs and starts it again if it was stopped meanwhile.
- The server stops idle computers once a minute (Daytona v0 container: stop; E2B and Daytona v0 VM
  class: pause; Daytona v2: hibernate). **Nothing deletes a computer automatically** (a v2 VM is
  deleted only once its snapshot is ready).
- The working directory is **not wiped** between runs, and mounted volumes stay mounted.
  Deliverables still go to the run's output directory, copied back as for sandboxes.
- Polpo's tools that take a file path (`browser_screenshot`, `image_analyze`, `image_edit`,
  `register_outcome`, `pdf_*`, `excel_*`…) take **the computer's paths**, whatever the engine
  (Polpo's, an agent harness, a CLI): its working directory, the output directory, `/home`, `/tmp`
  and the volumes attached to the run (`/volumes/<name>`). Their files are read and written on the
  computer; `register_outcome` copies a registered file (one on a volume too) into the task output
  on the server. Other paths are refused with these folders listed.
- The browser profile lives in the machine's home (`~/.polpo/browser-profiles/<agent>`): it survives
  stops, pauses and archiving.
- Runtime state (status, machine id, last use, uptime) is cached in `.polpo/computers-state.json`;
  the provider is the truth. Uptime counts running time only: a rough cost signal.

Explicit operations: **Start** (or wake), **Stop** (or hibernate), **Restart**, **Reset** (delete the
machine, and its v2 snapshots, and create a new one: everything on its disk is lost; needs
confirmation), **Delete** (machine, snapshots and computer; needs confirmation; refused while it is
an agent's default).

### Safe stop

**Stop** (and **Restart**) is refused while the computer is **busy**, so a click never cuts an
agent's work in half:

- busy = task runs in progress on it (an `assigned` or `in_progress` task whose running run
  resolved to this computer) or live agent harness sessions on it (task or chat sessions held by a
  process: `starting`, `running` or `idle`; a detached or stopped session is not work);
- the refusal is `409` with `code: "COMPUTER_BUSY"` and `details.busy`
  `{ tasks: [{ taskId, title, status, runId, agent? }], sessions: [{ key, sessionId?, agent, harness, scope, state, taskId?, chatSessionId? }] }`;
  the message lists them too;
- `{ "force": true }` (body) or `?force=true` stops it anyway (the work is interrupted). The
  dashboard shows the list in a dialog with **Stop anyway** (Hibernate anyway, Pause anyway); MCP
  `polpo_computer_control` and Polpo's `computer_control` / `computer_stop` take `force` and are
  told to ask the person first.

A stop **does not block**: the API answers `202` at once with the computer in status `stopping`,
and the stop goes on in the background (a Daytona v2 hibernation snapshot takes minutes). Each
status change comes as `computer:changed` (`stopping`, then `stopped` / `paused` / `hibernated`). A
stop that fails after the answer is never lost: it is a notice in the computer's activity
("Could not stop it: …"), the computer's `lastError`, and its status is asked of the provider again
(a failed hibernation leaves the VM running and retries later). Start, Restart and Reset still
answer when they are done.

### Deleted at the provider

A machine can be deleted outside Polpo: in the provider's dashboard or API, by its own clean-up, or
(Daytona v2) its snapshots deleted while it hibernates. Polpo notices and shows it:

- Status **`deleted`** ("Deleted at provider") when the provider has neither the machine nor, on
  Daytona v2, a ready snapshot to wake from, while Polpo knew one (`missing` stays "never created",
  or wiped by a reset whose new machine comes on the next use). A hibernated v2 computer is checked
  by its newest snapshot (read by id); one that is gone is forgotten and an older one from the
  provider's listing is used if there is one, otherwise the computer is `deleted`. The state then
  drops its machine id and snapshots, records `deletedAtProvider`, emits `computer:changed`
  (`status: "deleted"`), logs a notice and stops live agent harness sessions on it (their next turn
  starts a new bridge).
- When: on every live status read (`GET /computers`, the Computers page, `polpo_computers_list`),
  whose provider answers are reused for **15 s** (`?fresh=1`, and the page's refresh button, ask
  again), at once when the provider pushes an event (webhooks, below), and in the background every
  **5 minutes** (every **20** while every provider in use pushes events, one in the last 24 h: a safety net): one
  listing of this instance's computer machines per provider (label `polpo-scope=computer`) and, for
  hibernated v2 computers, one snapshot listing; only the computers that disagree with it get the
  full check. A provider that cannot be asked changes nothing.
- **Recreate** (the page's action for a `deleted` computer) is a confirmed **Reset**: a new machine
  from the image, without the old files. **Remove from Polpo** is **Delete**.
- Using it anyway (a chat, a task, a harness turn, Start) makes a new machine from the image instead
  of failing; the computer's notice and the run's warning say that its files are lost. A command (or
  a harness process or port) that fails because its machine vanished mid-run is retried once on the
  new machine; an error of a machine that still runs stands.

### Inactive Daytona snapshots (v0)

Daytona deactivates snapshots nobody used for a while; creating from one then fails with
"Snapshot … is inactive". Polpo activates it, waits until it is active (up to 5 minutes, progress in
the server log) and tries once more; if activation fails the error says what to do. Settings →
Sandbox and the computer's card show when the snapshot is not active. Daytona v2 has no such
snapshots: a missing image fails the create with the command that builds it.

### Provider webhooks

Providers that have lifecycle webhooks push their machines' changes, so a machine deleted, stopped
or paused outside Polpo shows at once. An event is a hint: it triggers the computer's full check at
its provider (idempotent), and events about machines that are not this instance's computers are
ignored. Set up in **Settings → Computers** (status per provider: receiving, configured with no event
yet, or not configured; the last event; the URL to give the provider).

- Endpoint: `POST <POLPO_PUBLIC_URL>/api/v1/computers/webhooks/<provider>` — public, authenticated
  by the provider's signature, 256 KB at most, rate limited (300 a minute per provider). **Behind
  Tailscale Funnel the path `/<instance>/api/v1/computers/webhooks/` must be exposed** (by default
  only `/mcp` is); Polpo does not change the Funnel.
- **Daytona**: in Daytona's dashboard, Webhooks → Add Endpoint with that URL and the events
  `sandbox.created`, `sandbox.state.updated` (`oldState` → `newState`; `destroyed` = gone) and
  `snapshot.removed`; then paste the endpoint's signing secret (`whsec_…`) in Settings → Computers:
  it goes to the vault (owner `$computers`, entry `webhook-daytona`), never through chat or MCP (the
  MCP tool gives a setup link). Deliveries are verified Svix-style: headers `svix-id`,
  `svix-timestamp`, `svix-signature` (or `webhook-*`), HMAC-SHA256 of `<id>.<timestamp>.<body>` with
  the key after `whsec_`, timestamp within 5 minutes. (Daytona's docs do not describe the signature:
  this is how its Svix-based webhooks sign; a delivery that does not verify is counted as refused in
  Settings → Computers.)
- **E2B**: Polpo registers the endpoint itself (`POST https://api.e2b.app/events/webhooks` with the
  project's API key) for `sandbox.lifecycle.created|killed|updated|paused|resumed|checkpointed`, with
  a secret it makes and keeps in the vault (`$computers` / `webhook-e2b`, with the webhook's id): by
  itself when the instance has E2B computers, an API key and `POLPO_PUBLIC_URL` (a failure waits an
  hour), or with **Register**; **Unregister** deletes it. Deliveries carry `e2b-signature` =
  base64(sha256(secret + body)) without padding; events older than 24 h are refused. The computer is
  found by its label in the sandbox's metadata.
- **Vercel Sandbox** (not a provider yet) has no lifecycle webhooks: reconcile only.
- Replays: a delivery id (Svix) or event id is accepted once (remembered 24 h); counts and the last
  event are kept in `.polpo/computer-webhooks.json`.
- Status: the last problem shown is one from after the provider was configured (saving the secret,
  registering E2B's endpoint or an accepted delivery clears it), never "not configured" once it is.
  Configured but nothing ever received: a note says so (`waitingNote`). **Daytona currently sends
  webhooks only for its classic sandboxes (containers), not for Daytona v2 VMs**, so v2 computers
  may never produce an event. The reconcile slows to every 20 minutes only while every provider in
  use has sent an event in the last 24 hours; otherwise it stays at 5 minutes.
- REST (authenticated): `GET /api/v1/computer-webhooks`, `PUT|DELETE /api/v1/computer-webhooks/daytona/secret`
  (`{ secret }`), `POST|DELETE /api/v1/computer-webhooks/e2b/register`, the event log (below). MCP:
  `polpo_computer_webhooks` (`action: status | register | unregister`; `events: true` / `event_id`
  for the log); Polpo: `computer_webhooks`.

#### Event log

Every delivery a provider sends is recorded, whatever came of it, so you can see what arrived and
what Polpo did with it (**Settings → Computers**, a provider's **Events** row):

| Outcome | When |
| --- | --- |
| `accepted` | about one of this instance's computers: Polpo checked it at the provider |
| `ignored` | signed, but not about a computer of this instance, a duplicate delivery or event, or an event Polpo does not act on |
| `rejected` | not configured, signature missing or wrong, replay outside the window, not JSON, body over 256 KB, rate limit (a flood is recorded once a minute) |
| `error` | accepted, but Polpo could not apply it (the computer's check failed) |

Each entry has the time, event type, provider event id and delivery id, the sandbox (or snapshot)
and the computer it matched, the provider's states (`oldState → newState`), the computer's status
in Polpo before and after the check (filled in once applied, a moment after the provider got its
answer), the signature check, the HTTP status Polpo answered, the reason, what Polpo did, the
processing time and size, the safe headers (`content-type`, `user-agent`, `svix-id`,
`svix-timestamp`, `webhook-id`, `webhook-timestamp`, `x-forwarded-for`; never a signature or an
authorization) and the payload, **redacted** (any key that looks like a secret, token, password,
key, signature, cookie or env, and any value that looks like a `whsec_…` secret, a provider key or
a bearer token, becomes `[redacted]`) and capped at 4 KB. Posts for an unknown provider are not
recorded.

The last 200 deliveries per provider are kept in `.polpo/computer-webhook-events/<provider>.json`
(newest first; the oldest are dropped), next to the status file, whatever the instance's store: it
is per-instance diagnostics, like the sync history. The status counts (`received`, `ignored`,
`rejected`, `errors`) are the log's, so the card and its events sheet always show the same numbers.
Deliveries counted by an older version, before the event log existed, have no entry in it: the
first read of an older status file moves, once, what its counters held beyond the log's entries to
`before: { received, ignored, rejected, errors, until }` (totals only), shown apart as "Before the
event log: 7 ignored, 1 rejected — no details" (the card, the sheet, MCP `polpo_computer_webhooks`).

- `GET /api/v1/computer-webhooks/:provider/events?limit=50&cursor=<nextCursor>&outcome=rejected,error`:
  newest first, without payloads; `{ provider, events, nextCursor?, total, counts }`.
- `GET /api/v1/computer-webhooks/:provider/events/:id`: one delivery with its redacted payload and headers.
- Each recorded delivery emits `computer:webhook` (`{ provider, id, action: "recorded" | "updated", outcome, eventType?, computerId? }`;
  `updated` when Polpo finished applying it): the dashboard's list updates live.
- MCP: `polpo_computer_webhooks { provider: "daytona", events: true, outcome?: ["rejected"], limit?, cursor? }`,
  `{ provider, event_id }` for one; Polpo: `computer_webhooks`.
- A pushed change emits `computer:changed` like any other (the pages update live) and adds a line to
  the computer's activity ("The provider reported sandbox.state.updated (started → destroyed)").

## Live view and take control

A Daytona v2 computer has a real desktop (**XFCE**: panel, menu, files, terminal, editor, task
manager; the agent's language, timezone and keyboard layout, Italian by default; no screensaver,
locking or compositing) you can watch live from its page, with a clipboard box to copy text from
and to it, where agents' browsers open their window (headed by default on a remote computer; `browserHeaded: false` keeps one headless); take control for a login, a 2FA code or a
CAPTCHA and give it back, and agents ask for it with `request_computer_takeover`. Their commands get
`CDP_URL`, the CDP endpoint of their own browser. The browser is always real Google Chrome
(`/usr/bin/google-chrome`, installed once on a VM without it), never Chromium, which sites flag as a
bot. See [computer-live-view.md](computer-live-view.md).

### The agent's Chrome on a remote computer

Polpo **launches the agent's Chrome itself** in the VM, one per agent profile, and agent-browser
attaches to it over CDP (`--cdp <port>`). A Chrome launched by agent-browser (through Playwright)
carries automation flags: `navigator.webdriver` is `true` and Google sign-in refuses it ("This
browser or app may not be secure") even with real Chrome on a residential IP. Ours is launched like a
person would launch it: `--user-data-dir=$HOME/.polpo/browser-profiles/<profile>`,
`--remote-debugging-port=<port>` on `127.0.0.1`, `--no-first-run --no-default-browser-check`, the
desktop's window size, the egress proxy as `--proxy-server`, `--no-sandbox` only as root, no
automation flags; headed on the desktop (`:99`) unless `browserHeaded: false`.

- **Language and timezone**: from the agent's identity, `identity.locale` (BCP 47, e.g. `"en-US"`)
  and `identity.timezone` (IANA, e.g. `"Europe/Rome"`); default **`it-IT`** and **`Europe/Rome`**.
  `--lang`/`--accept-lang` set `navigator.language` and `Accept-Language`, `TZ` the timezone.
  `identity.locale` is set like the other identity fields (`.polpo/polpo.json`, REST agent update,
  Polpo's `set_identity`).
- **Lifecycle**: pid and port in `$HOME/.polpo/browser-chrome/`; relaunched when it died or its
  settings changed; never stopped at the end of a run (a page a person left open stays), gone with
  the computer (stop, hibernation).
- **"Chrome di <agent>"**: a launcher on the desktop and in the XFCE menu reopens that same Chrome
  (`$HOME/.polpo/browser-chrome/<profile>.launch.sh`: the same profile, proxy, language and DevTools
  port), never a plain `google-chrome`; a closed Chrome also comes back at the next `browser_*` call.
- **On this server** (no remote computer) agent-browser still launches Chrome itself
  (`--executable-path`, `--profile`).

Details: [computer-live-view.md](computer-live-view.md#the-agents-own-chrome-remote-computers).

## API, tools, events

- REST: `GET/POST /api/v1/computers` (`?live=0`: the last known status; `?fresh=1`: skip the 15 s
  cache of provider answers), `GET/PATCH/DELETE /api/v1/computers/:id` (delete with
  `{ "confirm": true }`; `GET ?detail=1` adds `snapshots`, `activity` (status changes and notices,
  newest first, the last 40 kept), `sessions` (agent harness sessions on it), `runs` (the 50 newest
  task runs that used it, from `Task.runs`: task, agent, engine, model, status, duration, cost,
  tokens), `cost { runsUsd, chatSessionsUsd, totalUsd }` (task runs plus chat harness sessions; a
  task's harness session is counted in its runs), `idleStopAt`, `timeoutAt`, `runningSince`,
  `hibernate` (Daytona v2 settings), `machine { image?, snapshot?, template?, region?, resources? }`
  (what a new machine is made from)), `POST /api/v1/computers/:id/{start,stop,restart,reset}` (reset with
  `{ "confirm": true }`; stop and restart refused with `409 COMPUTER_BUSY` while busy unless
  `{ "force": true }`; stop answers `202` at once with status `stopping`: see [Safe stop](#safe-stop)). Agents: `defaultComputer` and `computers` on `POST /agents` and
  `PATCH /agents/:name` (`""` clears the default). `GET /api/v1/computers/:id/egress`: a remote
  computer's egress through Tailscale (tailnet up/down, node, direct or DERP path, proxy reachable,
  where its browser goes out now; it looks inside a running machine only).
- Polpo: `computers_list`, `computer_get`, `computer_save` (create or change: lifecycle, network, egress…), `computer_control`
  (start, stop, restart, reset), `computer_delete` (the MCP server's tools, run in process), `computer_create`,
  `computer_assign`, `computer_start`, `computer_stop`; `add_agent` / `update_agent` take `computers` and
  `defaultComputer`; `egress_status` (proxies, and remote computers' tailnet egress).
- MCP (`computers` toolset): `polpo_computers_list`, `polpo_computer_get` (one computer in full: the
  detail above, read-only), `polpo_computer_save`, `polpo_computer_control`, `polpo_computer_delete`;
  `polpo_agent_update` takes `defaultComputer`. Polpo has the same as `computer_get`.
- Event `computer:changed` `{ id, action: created | updated | deleted | status, status?, remoteId?, error?, notice? }`
  (`status` includes `hibernated`; `notice`: e.g. a v2 VM that vanished and was restored).
- The API's computer view adds `lastSnapshot { at, diskBytes?, memoryBytes? }`, `snapshotCount` and `notice` (Daytona v2),
  `deletedAtProvider` (status `deleted`) and `providerApi` (`v0` / `v2`, Daytona).
- Each task run records the computer it used (`Task.runs[].computer`: id, kind, Daytona v0/v2, the VM id) and its egress (direct, or the proxy and whether through Tailscale): see [harnesses.md](harnesses.md#where-and-with-what-a-run-executed). The task page links to the computer; the Computers page shows the agents' engines and the harness sessions on each computer.
- Dashboard: the **Computers** page is a table like the other lists (search, status and provider
  filters, sort by status, name, last use or uptime): provider mark and kind (Daytona v2, Daytona,
  E2B, This server), live status, agents with their engine, harness sessions, egress, last use,
  snapshots, the main action inline (Start, Stop / Hibernate / Pause, Recreate) and the others in a
  menu; on a phone a row keeps the name, the status and the menu. A banner lists computers deleted at
  the provider. A row opens the computer's page (**`/computers/:id`**): header with the lifecycle
  actions, tiles (last use, uptime, when it stops or hibernates by itself, what was spent on it),
  harness sessions (engine, agent, task link, state, started, duration, turns, tokens, cost), recent
  task runs (task link, agent and engine, model, status, duration, cost), activity, agents (default
  or may use), lifecycle, snapshots (count, size, keepSnapshots), machine (image, region, size,
  machine id, dates), network and egress (with the live Tailscale status of a remote computer's
  egress). Edit opens the computer's form, which now also sets the network rule and the size.
  An agent's computers (status, Start/Stop/Restart/Reset, default, add or create one for it) are in
  its **Computer** tab.

## Migration: computer `nina` for `sitoinchat` (lumea)

Applied by a person after the deploy, through the API (not by editing the live config). With the
instance's URL and an API key:

```bash
URL=https://<lumea host>
KEY=<api key>

# 1. the computer (Daytona, the instance's snapshot; stops after 15 idle minutes)
curl -sS -X POST "$URL/api/v1/computers" -H "authorization: Bearer $KEY" -H "content-type: application/json" \
  -d '{"id":"nina","name":"Nina","kind":"daytona","lifecycle":{"idleStopMinutes":15,"autoArchiveDays":7}}'

# 2. sitoinchat works on it (chats and tasks)
curl -sS -X PATCH "$URL/api/v1/agents/sitoinchat" -H "authorization: Bearer $KEY" -H "content-type: application/json" \
  -d '{"defaultComputer":"nina","computers":["nina"]}'

# 3. optional: create the machine now instead of on sitoinchat's first command
curl -sS -X POST "$URL/api/v1/computers/nina/start" -H "authorization: Bearer $KEY"

# check
curl -sS "$URL/api/v1/computers/nina" -H "authorization: Bearer $KEY"
```

The same from MCP: `polpo_computer_save { id: "nina", name: "Nina", kind: "daytona" }`, then
`polpo_agent_update { name: "sitoinchat", defaultComputer: "nina" }`; or ask Polpo ("give
sitoinchat a Daytona computer called nina").

To undo: `PATCH /agents/sitoinchat {"defaultComputer":""}`, then `DELETE /computers/nina {"confirm":true}`
(deletes the machine and its disk).

What to check live: the first create on lumea (snapshot `polpo-runner-0.3.13`, reactivated if
inactive), that a second chat reuses the same machine (`remoteId` unchanged), that the machine
stops after 15 idle minutes and starts again on the next message with its files, and the browser
profile surviving a stop.

## Home egress for `nina` (lumea)

`nina`'s browser can go out through the `home` proxy (ahp0, a residential line) the way host browsers
do, with Tailscale running inside its VM. Once: the ACL and the auth key in the Tailscale admin console,
the key in the vault, `settings.tailscale`; then `{"egress": "home"}` on the computer. The full steps,
with the commands that move the key from `~/deploy/tailscale-sandbox.key` into the vault without
printing it, are in [Remote computers through Tailscale](residential-egress.md#remote-computers-daytona-e2b-through-tailscale).

```bash
# after the key is in the vault (owner polpo-infra, service tailscale-sandbox)
curl -sS -X PATCH "$URL/api/v1/config/settings" -H "authorization: Bearer $KEY" -H "content-type: application/json" \
  -d '{"tailscale":{"authKey":{"owner":"polpo-infra","service":"tailscale-sandbox"}}}'
curl -sS -X PATCH "$URL/api/v1/computers/nina" -H "authorization: Bearer $KEY" -H "content-type: application/json" \
  -d '{"egress":"home"}'
# after sitoinchat's next browser command
curl -sS "$URL/api/v1/computers/nina/egress" -H "authorization: Bearer $KEY"
```
