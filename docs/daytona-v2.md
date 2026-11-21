# Daytona v2: Linux VMs

Daytona has two services. Polpo talks to either, per instance, with
`settings.sandbox.providers.daytona.api`:

| | `"v0"` (default) | `"v2"` |
|---|---|---|
| Endpoint | `https://app.daytona.io/api`, or a custom `apiUrl` (self-hosted) | `https://api.daytona.com` (Daytona Cloud only: no `apiUrl`) |
| Key | organization API key | **project** API key (`dtn_…`) |
| Machines from | a **snapshot** (`providers.daytona.snapshot`, e.g. `polpo-runner-0.3.13`) or a Docker image | an **image** of the project (`providers.daytona.image`, default `polpo-runner-vm-2`) |
| Class | container or linux-vm, as the snapshot was built | always a **Linux VM** (`linux-vm`) |
| Idle | container: stopped (disk kept); linux-vm: paused | **not persistent** on the plans seen so far: pause and stop are refused (409); an idle VM is deleted |
| Computers | yes | **no** (refused: use v0 or E2B) |
| Longest life | none | the plan's maximum wall clock (86400 s seen; `providers.daytona.maxTimeoutSeconds`), then deleted |
| Size | fixed by the snapshot | per sandbox (`resources`; default 2 vCPU, 4 GB, 10 GB) |
| Network allowlist | host names **or** IPv4 addresses (not both) | host names and addresses together; can change while the VM exists |
| stderr | separated by a wrapper script | native stdout / stderr / exit code |
| SDK | `@daytona/sdk` 0.233.0 | `@daytona/sdk` 2.x, installed as `@daytona/sdk-v2` |

Existing instances stay on v0 until someone switches them. Both SDKs are installed: switching back
is a one-line change.

## What Polpo does on v2

- **Create**: `daytona.v2.create(image, { labels, resources: { cpuMax, memoryMax, diskMax },
  lifecyclePolicy, networkPolicy, region?, name? })`. Every sandbox is a Linux VM.
- **Not persistent.** Live on our plan, a Linux v2 sandbox refuses `pause()` (409 "sandbox is not
  persistent; pause is unavailable") and `stop()` (409 "warm stop is unavailable (delete
  instead)"), its lifecycle policy accepts only `"delete"`, and its wall-clock timeout (at most
  86400 s) deletes it. So Polpo never pauses or stops a v2 VM, and **computers are refused on v2**
  ("Daytona v2 Linux sandboxes can't be paused or stopped on this plan: use Daytona v0 or E2B for
  computers") when the config loads, by `POST/PATCH /computers`, by `PATCH /config/settings`
  (switching to v2 while Daytona computers exist) and at start, stop and reset.
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
  not served). Computers also get a stable name (`polpo-computer-<instance>-<id>`): a repeated
  create returns the same VM, so a search that lags right after a create never makes a second one.
- **Commands**: `exec({ argv: ["bash", "-c", command] }, { cwd, env, timeoutSeconds,
  executionTimeoutSeconds })`; stdout, stderr and the exit code come back separately; a timeout is
  exit code 124.
- **Files**: `fs.readBytes` / `fs.writeBytes` (the workspace's reads, writes, uploads, downloads).
- **Network**: `deny` → `{ blockAll: true }`; `allowlist` → `{ blockAll: true, allowDomains,
  allowCidrs }` (ports are dropped: Daytona filters by host); `open` / `unrestricted` → no policy.
  A computer's rule is applied again (`updateNetworkPolicy`, with the ETag) when it starts or
  resumes, so changing a computer's network takes effect on its next start.
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
5. **Computers.** Daytona computers do not run on v2 (its Linux sandboxes are not persistent):
   the switch is refused while the instance has `daytona` computers. Keep the instance on v0 for
   them, or move them to E2B (`kind: "e2b"`), or delete them first.
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
