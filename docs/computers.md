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
| `snapshot` / `image` | Daytona v0: a snapshot (default: the instance's `settings.sandbox.providers.daytona.snapshot`) or a Docker image (sized by `resources`). Daytona v2: `image` is an image of the Daytona project (default: the instance's `providers.daytona.image`, else the Polpo runner image `polpo-runner-vm-3`); `snapshot` is ignored. |
| `template` | E2B template (default: the instance's). |
| `resources` | `{ cpus, memoryMb, diskMb }`: Daytona v0 with an image only (snapshots and templates have their own size); Daytona v2 always (default 2 vCPU, 4 GB, 10 GB). |
| `lifecycle.idleStopMinutes` | Stop (Daytona v0 container), pause (E2B, Daytona v0 VM class) or hibernate (Daytona v2) after this many minutes without use. Default 15. |
| `lifecycle.autoArchiveDays` | Daytona v0: archive after this many days stopped (the disk moves to object storage: free, slower to start). Default: Daytona's (7). Ignored on v2 (a hibernated computer is a snapshot). |
| `network` | `{ mode, allow }` as in the sandbox settings. Default: the instance's. Daytona v0 and E2B: fixed when the machine is created. Daytona v2: applied again whenever a VM is made (create, wake, rotation), so a changed rule takes effect on the next wake. |
| `egress` | The egress proxy (`settings.egressProxies`) the browser of its agents goes out through. A remote computer (Daytona, E2B) reaches it through **Tailscale inside its VM**: it needs `settings.tailscale` (an auth key in the vault), a SOCKS5 proxy on a tailnet address, and a network that is not `deny` — see [Remote computers through Tailscale](residential-egress.md#remote-computers-daytona-e2b-through-tailscale). |
| `volumes` | Volumes attached to runs on the computer (names granted to the agent, as in the sandbox settings). |

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
- The browser profile lives in the machine's home (`~/.polpo/browser-profiles/<agent>`): it survives
  stops, pauses and archiving.
- Runtime state (status, machine id, last use, uptime) is cached in `.polpo/computers-state.json`;
  the provider is the truth. Uptime counts running time only: a rough cost signal.

Explicit operations: **Start** (or wake), **Stop** (or hibernate), **Restart**, **Reset** (delete the
machine, and its v2 snapshots, and create a new one: everything on its disk is lost; needs
confirmation), **Delete** (machine, snapshots and computer; needs confirmation; refused while it is
an agent's default).

### Inactive Daytona snapshots (v0)

Daytona deactivates snapshots nobody used for a while; creating from one then fails with
"Snapshot … is inactive". Polpo activates it, waits until it is active (up to 5 minutes, progress in
the server log) and tries once more; if activation fails the error says what to do. Settings →
Sandbox and the computer's card show when the snapshot is not active. Daytona v2 has no such
snapshots: a missing image fails the create with the command that builds it.

## API, tools, events

- REST: `GET/POST /api/v1/computers`, `GET/PATCH/DELETE /api/v1/computers/:id` (delete with
  `{ "confirm": true }`), `POST /api/v1/computers/:id/{start,stop,restart,reset}` (reset with
  `{ "confirm": true }`). Agents: `defaultComputer` and `computers` on `POST /agents` and
  `PATCH /agents/:name` (`""` clears the default). `GET /api/v1/computers/:id/egress`: a remote
  computer's egress through Tailscale (tailnet up/down, node, direct or DERP path, proxy reachable,
  where its browser goes out now; it looks inside a running machine only).
- Polpo: `computers_list`, `computer_save` (create or change: lifecycle, network, egress…), `computer_control`
  (start, stop, restart, reset), `computer_delete` (the MCP server's tools, run in process), `computer_create`,
  `computer_assign`, `computer_start`, `computer_stop`; `add_agent` / `update_agent` take `computers` and
  `defaultComputer`; `egress_status` (proxies, and remote computers' tailnet egress).
- MCP (`computers` toolset): `polpo_computers_list`, `polpo_computer_save`, `polpo_computer_control`,
  `polpo_computer_delete`; `polpo_agent_update` takes `defaultComputer`.
- Event `computer:changed` `{ id, action: created | updated | deleted | status, status?, remoteId?, error?, notice? }`
  (`status` includes `hibernated`; `notice`: e.g. a v2 VM that vanished and was restored).
- The API's computer view adds `lastSnapshot { at, diskBytes?, memoryBytes? }` and `notice` (Daytona v2).
- Each task run records the computer it used (`Task.runs[].computer`: id, kind, Daytona v0/v2, the VM id) and its egress (direct, or the proxy and whether through Tailscale): see [harnesses.md](harnesses.md#where-and-with-what-a-run-executed). The task page links to the computer; the Computers page shows the agents' engines and the harness sessions on each computer.
- Dashboard: **Computers** page; an agent's computers (status, Start/Stop/Restart/Reset, default, add or create one for it) are in its **Computer** tab.

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
