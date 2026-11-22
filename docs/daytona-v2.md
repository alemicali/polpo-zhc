# Daytona v2: Linux VMs

Daytona has two services. Polpo talks to either, per instance, with
`settings.sandbox.providers.daytona.api`:

| | `"v0"` (default) | `"v2"` |
|---|---|---|
| Endpoint | `https://app.daytona.io/api`, or a custom `apiUrl` (self-hosted) | `https://api.daytona.com` (Daytona Cloud only: no `apiUrl`) |
| Key | organization API key | **project** API key (`dtn_…`) |
| Machines from | a **snapshot** (`providers.daytona.snapshot`, e.g. `polpo-runner-0.3.13`) or a Docker image | an **image** of the project (`providers.daytona.image`, default `polpo-runner-vm-2`) |
| Class | container or linux-vm, as the snapshot was built | always a **Linux VM** (`linux-vm`) |
| Idle | container: stopped (disk kept); linux-vm: paused | **not persistent** on the plans seen so far: pause, stop and fork are refused (409); an idle pooled VM is deleted |
| Computers | yes (stop / pause) | yes: they **hibernate** (memory and disk snapshot, VM deleted; wakes in ~3 s) |
| Longest life | none | the plan's maximum wall clock (86400 s seen; `providers.daytona.maxTimeoutSeconds`), then deleted |
| Size | fixed by the snapshot | per sandbox (`resources`; default 2 vCPU, 4 GB, 10 GB) |
| Network allowlist | host names **or** IPv4 addresses (not both) | computers: **host names only** (IP addresses and ranges are refused when saved: seen live, the VM reaches none of them); can change while the VM exists |
| stderr | separated by a wrapper script | native stdout / stderr / exit code |
| SDK | `@daytona/sdk` 0.233.0 | `@daytona/sdk` 2.x, installed as `@daytona/sdk-v2` |

Existing instances stay on v0 until someone switches them. Both SDKs are installed: switching back
is a one-line change.

## What Polpo does on v2

- **Create**: `daytona.v2.create(image, { labels, resources: { cpuMax, memoryMax, diskMax },
  lifecyclePolicy, networkPolicy, region?, name? })`. Every sandbox is a Linux VM.
- **Not persistent.** Live on our plan, a Linux v2 sandbox refuses `pause()`, `stop()` and
  `fork()` (409 "sandbox is not persistent"), its lifecycle policy accepts only `"delete"`, and
  its wall-clock timeout (at most 86400 s) deletes it. So Polpo never pauses or stops a v2 VM.
- **Computers hibernate.** Memory and disk snapshots work and are fast (measured live):
  `sandbox.createSnapshot(name)` answers in ~0.25 s with status `building`, `snapshots.get(id)`
  reports `ready` ~2 s later (memory ~224 MB for a 4 GB VM); `client.delete(id)` ~2 s;
  `createFromSnapshot(id, { name, labels, lifecyclePolicy, waitSeconds })` starts a VM in ~2.4 s
  with the files **and the running processes** (a background loop kept counting). Deleting the
  source before the snapshot is ready makes the snapshot fail, so Polpo deletes a computer's VM
  only once its snapshot is `ready`. The whole model (hibernate when idle or stopped, wake on use,
  rotation before the 24 h wall clock, safety snapshots, restore of a vanished VM, snapshot
  cleanup, settings `providers.daytona.hibernate`) is in
  [Computers → Hibernation](computers.md#hibernation-daytona-v2).
  - A computer's VM: lifecycle `{ timeoutSeconds: min(maxTimeoutSeconds, 86400), onTimeout:
    "delete", idleExpirySeconds: -1 }` (at create and at every wake).
  - Snapshot names: `polpo-computer-<instance>-<id>-<UTC yyyymmddhhmmssSSS>` (snapshots carry no
    labels: Polpo only ever touches names of its own instance and computer).
  - A named v2 create derives a **permanent** idempotency key from the name; a computer gets a new
    VM under the same name after every hibernation, so Polpo passes a fresh `idempotencyKey` per
    VM (create: `<name>:<time>`, wake: `<name>:wake:<snapshot>:<time>`).
  - `createFromSnapshot` takes no network policy: the computer's rule is applied right after
    (`updateNetworkPolicy`); a VM that cannot get it is deleted again.
  - Costs: snapshot storage (~memory + disk per snapshot, `keepSnapshots` of them, default 1)
    while hibernated; a wake is ~3 s.
- **Lifecycle policy** (v2 requires a wall-clock timeout, capped at
  `providers.daytona.maxTimeoutSeconds`, default 86400, the plan's maximum):
  - one-run sandbox: idle or timeout after the run's lifetime (task timeout + 15 min) → delete;
  - pooled/warm sandbox (`lifecycle.onRelease: "pool"`): no idle action; timeout (lifetime +
    `deleteAfterStopMinutes`) → delete. The reaper's idle stop (`stopAfterIdleMinutes`)
    **deletes** it (there is no pause), so a later run creates a new VM instead of reusing it.
- **Suspend** (between runs, warm VMs): nothing (no pause); the VM runs until the reaper or its
  wall clock deletes it.
- **Start**: a running VM reused from the pool gets its wall-clock budget re-armed when less than
  half is left.
- **Find**: by label with `search({ labels })` (falls back to listing every sandbox where search is
  not served). Computers also get a stable name (`polpo-computer-<instance>-<id>`, the `name`
  label) and their known VM is read by id as well (a search that lags right after a create or a
  wake never makes a second VM).
- **Commands**: `exec({ argv: ["bash", "-c", command] }, { cwd, env, timeoutSeconds,
  executionTimeoutSeconds })`; stdout, stderr and the exit code come back separately; a timeout is
  exit code 124.
- **Files**: `fs.readBytes` / `fs.writeBytes` (the workspace's reads, writes, uploads, downloads).
- **Network**: `deny` → `{ blockAll: true }`; `allowlist` → `{ blockAll: true, allowDomains,
  allowCidrs }` (ports are dropped: Daytona filters by host); `open` / `unrestricted` → no policy.
  A computer's rule is applied again (`updateNetworkPolicy`, with the ETag) when it starts or
  wakes, so changing a computer's network takes effect on its next start or wake (stop and start
  it to apply it now; no reset). A computer's allowlist is checked when it is saved (the API, MCP,
  the dashboard): an entry that is not a host name, or an IP address or range, is refused with
  the reason. **Caveat:** Daytona accepts `allowCidrs` and reports the policy as applied, but in
  the live test (a Linux VM, `*.wikipedia.org` plus `1.1.1.1/32`, and `1.1.1.1` alone) traffic to
  the address was still answered 403 by Daytona's egress: only the domain rules worked. Polpo
  therefore takes host names only for v2 computers (CIDR-only rules were not tested).
- **Lagging search**: right after a VM is deleted (a hibernation, a reset) the label search can
  still list it as `started`. Every hit is read again by id (`get`, where it shows as `destroyed`
  or is gone) before it is used, so a restart or reset never connects to the VM it just deleted.
- **Delete**: deleting a computer marks it deleted first (in the server, and a tombstone in
  `computers-state.json` for task runners): a run, a tailnet check, a wake or a rotation that was
  still on its way fails instead of making its VM again. Creating a computer with the same id
  clears the mark.
- **Volumes**: Polpo's volumes (rclone / mount-s3 inside the VM) work as on v0. Daytona's own v2
  volumes are not used.
- **Preview URLs / ports**: not used by Polpo (on v0 either).

## Switching an instance to v2

1. **Create a project API key.** Sign in at <https://app.daytona.io>, open the new (v2) dashboard
   and pick (or create) the **project** the instance's machines should live in. Under the project's
   **API keys**, create a key with permission to manage sandboxes and images (`write:sandboxes`,
   `write:images`; read access to sandboxes and images too). Copy it: it starts with `dtn_` and is
   shown once. An organization key of the old dashboard does **not** work on v2.
2. **Store it in the vault.** In the dashboard, open an agent's **Credentials** tab (share the entry
   with the agents that need it, or keep it on an admin agent) and add an entry, e.g. service
   `daytona-v2`, type API key, key name `apiKey`, value the `dtn_…` key. Or ask Polpo: "save my
   Daytona v2 project key in the vault".
3. **Build the runner image in that project** (once per project; nothing runs on the instance):

   ```bash
   cd ~/deploy/polpo-zhc   # or any checkout with dependencies installed
   DAYTONA_V2_API_KEY=dtn_... node scripts/build-sandbox-images.mjs --provider daytona-v2
   # optional: DAYTONA_V2_REGION=<region id>; --force rebuilds
   ```

   It builds `polpo-runner-vm-2` (the same tools as the v0 runner: agent-browser + Chromium,
   playwright-core, rclone, mount-s3, FUSE, git, python3, node 22) and waits until it is ready
   (several minutes). Running it again does nothing when the image exists.
4. **Switch the provider.** Settings → Sandbox → Daytona: set **API** to *v2 · new service*, choose
   the vault entry from step 2, leave **Image** empty (the runner image) or name another image of
   the project, optionally a **Region**, then **Save** and **Test** (creates a throwaway VM and runs
   `echo polpo-ok`). The card shows **VM class: Linux VM**. The v0 API URL is removed on save (v2
   refuses it); the v0 snapshot and region are kept, so switching back is just choosing v0 again.

   The same in `.polpo/polpo.json` (or `PATCH /api/v1/config/settings`):

   ```json
   {
     "settings": {
       "sandbox": {
         "providers": {
           "daytona": {
             "api": "v2",
             "credential": { "owner": "<agent>", "service": "daytona-v2" }
           }
         }
       }
     }
   }
   ```

   With `"api": "v2"` an `apiUrl` is refused (when the file loads and by the API) with a message
   saying why.
5. **Computers.** `daytona` computers hibernate on v2. A computer whose machine lives on v0 is not
   found by v2: after the switch its next use makes a new v2 VM from the image (the v0 machine and
   its disk stay on v0; delete it there, or switch back to reach it). The project key must be
   allowed to take snapshots (`write:snapshots`, `read:snapshots`, with `write:sandboxes`); without
   that hibernation fails with the API's error and the VM keeps running.
6. **Old v0 sandboxes** (pool, warm) are not reachable from v2: the pool forgets them, and Daytona v0
   deletes them by itself (`autoDeleteInterval` / `ephemeral`). Switch when no task runs.

Switching back: set API to v0 again (and an organization key); v2 VMs are deleted by their wall
clock (at most a day).

## Limits and things to know

- v2 is Daytona Cloud only: a self-hosted Daytona stays on v0.
- Labels: Polpo's labels (`polpo`, `polpo-instance`, `polpo-agent`, `polpo-scope`,
  `polpo-computer`) are set as on v0.
- Sizes: `resources.cpus` are vCPUs (v2 counts cores of 2 vCPUs; Polpo converts, rounding up to a
  whole vCPU), memory and
  disk round up to whole GiB.
- The v2 image name carries a recipe revision, not the Polpo version: it changes only when the
  image's contents change (then rebuild with the script).
