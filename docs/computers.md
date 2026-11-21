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
| `snapshot` / `image` | Daytona: a snapshot (default: the instance's `settings.sandbox.providers.daytona.snapshot`) or a Docker image (sized by `resources`). |
| `template` | E2B template (default: the instance's). |
| `resources` | `{ cpus, memoryMb, diskMb }`: Daytona with an image only; snapshots and templates have their own size. |
| `lifecycle.idleStopMinutes` | Stop (Daytona container) or pause (E2B, Daytona VM class) after this many minutes without use. Default 15. |
| `lifecycle.autoArchiveDays` | Daytona: archive after this many days stopped (the disk moves to object storage: free, slower to start). Default: Daytona's (7). |
| `network` | `{ mode, allow }` as in the sandbox settings. Fixed when the machine is created. Default: the instance's. |
| `egress` | `host` computers only: the egress proxy (`settings.egressProxies`) the browser of its agents goes out through. Remote computers going out through a home proxy is phase 2. |
| `volumes` | Volumes attached to runs on the computer (names granted to the agent, as in the sandbox settings). |

Agents:

| Field | Meaning |
|---|---|
| `defaultComputer` | The computer its chats **and** tasks run on. Unset or `host`: this server. |
| `computers` | Other computers a task may ask for (`sandbox.computer: "<id>"`). |

There is no `class` field: Daytona's 0.x API does not take a sandbox class at create time — the
class comes with the snapshot (`snapshot.create({ sandboxClass: "linux-vm" })`). A computer built
from a `linux-vm` snapshot is switched to auto-pause (memory kept) after creation; from a container
snapshot (our `polpo-runner-*` today) it stops (disk kept, processes not).

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
- First use (or **Start**): created with that label, auto-delete off (Daytona
  `autoDeleteInterval: -1`; E2B `lifecycle.onTimeout: "pause"`), `autoStopInterval` = the idle time,
  `autoArchiveInterval` = the archive days. Later uses: started (or resumed, or unarchived) if it is
  not running; created again only if the provider has none.
- Creating, starting, stopping and resetting are serialized per computer (in the process and, with
  a lock file under `.polpo/computers/`, across the task runners). Commands run concurrently: a chat
  and a task can use the computer at the same time.
- Every command and file operation keeps it in use (`lastUsedAt`, and the provider's own idle timer);
  a long command keeps it in use while it runs. After a minute without checking, the next operation
  verifies it still runs and starts it again if it was stopped meanwhile.
- The server stops idle computers once a minute (Daytona container: stop; E2B and Daytona VM: pause).
  **Nothing deletes a computer automatically.**
- The working directory is **not wiped** between runs, and mounted volumes stay mounted.
  Deliverables still go to the run's output directory, copied back as for sandboxes.
- The browser profile lives in the machine's home (`~/.polpo/browser-profiles/<agent>`): it survives
  stops, pauses and archiving.
- Runtime state (status, machine id, last use, uptime) is cached in `.polpo/computers-state.json`;
  the provider is the truth. Uptime counts running time only: a rough cost signal.

Explicit operations: **Start**, **Stop**, **Restart**, **Reset** (delete the machine and create a
new one: everything on its disk is lost; needs confirmation), **Delete** (machine and computer;
needs confirmation; refused while it is an agent's default).

### Inactive Daytona snapshots

Daytona deactivates snapshots nobody used for a while; creating from one then fails with
"Snapshot … is inactive". Polpo activates it, waits until it is active (up to 5 minutes, progress in
the server log) and tries once more; if activation fails the error says what to do. Settings →
Sandbox and the computer's card show when the snapshot is not active.

## API, tools, events

- REST: `GET/POST /api/v1/computers`, `GET/PATCH/DELETE /api/v1/computers/:id` (delete with
  `{ "confirm": true }`), `POST /api/v1/computers/:id/{start,stop,restart,reset}` (reset with
  `{ "confirm": true }`). Agents: `defaultComputer` and `computers` on `POST /agents` and
  `PATCH /agents/:name` (`""` clears the default).
- Polpo: `computers_list`, `computer_create`, `computer_assign`, `computer_start`, `computer_stop`.
- MCP (`computers` toolset): `polpo_computers_list`, `polpo_computer_save`, `polpo_computer_control`,
  `polpo_computer_delete`; `polpo_agent_update` takes `defaultComputer`.
- Event `computer:changed` `{ id, action: created | updated | deleted | status, status?, remoteId?, error? }`.
- Dashboard: **Computers** page; an agent's computer is chosen in its **Sandbox** tab.

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
