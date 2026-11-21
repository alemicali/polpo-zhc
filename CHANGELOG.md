# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Computer tab on each agent**: where the agent works now, its computers with live status and Start/Stop/Restart/Reset, make default, remove, and add an existing or new computer for it. The default-computer picker moved here from the Sandbox tab; the agent page keeps the open tab in `?tab=`.
- **Remote computers go out through the home proxy, with Tailscale inside their VM.** A Daytona or E2B computer may now have `egress: "<proxy>"` (until now host computers only): its VM joins the tailnet as a tagged, ephemeral node and its browser goes out through the same residential proxy as the server's browsers (e.g. `home` = `socks5://100.101.55.7:1080` on ahp0).
  - `settings.tailscale: { authKey: { owner, service }, tags?, hostnamePrefix? }`: the auth key stays in a vault entry (only its reference is in the settings; a key in its place is refused); tags default `["tag:polpo-sandbox"]`, nodes are named `<prefix>-<project>-<computer>` (default prefix `polpo-sbx`). Validated when the config loads and by `PATCH /config/settings`, which also refuses a change that would break a computer's egress.
  - A remote computer's `egress` is refused, with the reason, unless Tailscale is set up, the proxy is SOCKS5 on a tailnet address (100.64.0.0/10 or a MagicDNS name) and the computer has a network; HTTP proxies are not supported for remote computers yet.
  - In the VM: tailscaled in userspace networking (SOCKS5 on 127.0.0.1:1055, state in memory), `tailscale up` with the key from a 0600 file uploaded through the provider's file API and deleted right after (never on a command line or in a log; output masked), `--accept-dns=false`, and a Node forwarder on 127.0.0.1:1081 that CONNECTs to the proxy through the tailnet, so the browser runs with `--proxy socks5://127.0.0.1:1081`. Brought up in the background when the computer starts or resumes and checked before the browser's next command (one command while everything runs, cached 30 s); dead daemons are restarted after a resume. Same rules as on the server: proxy unreachable → directly from the VM, except a profile signed in through the proxy, which pauses; the browser restarts when its proxy changes. Reset and delete log the node out first.
  - Tailscale 1.104.7 (SHA-256 pinned) is in the runner images — the Daytona v2 image is now `polpo-runner-vm-2`, rebuild it with `node scripts/build-sandbox-images.mjs --provider daytona-v2` — and downloaded with a checksum check in VMs without it.
  - `GET /computers/:id/egress` and Polpo's `egress_status`: tailnet up/down, node name, path (direct or DERP relay), proxy reachable, where the browser goes out now. The Computers page accepts an egress proxy for remote computers. Guide (ACL, auth key, vault, latency, troubleshooting): `docs/residential-egress.md`.
- **Daytona v2: computers hibernate.** Live on our plan, Linux v2 sandboxes are not persistent (`pause()`/`stop()`/`fork()` → 409, the lifecycle accepts only `"delete"`, the wall clock deletes the VM after at most 86400 s), but memory and disk snapshots work and are fast (snapshot ready in ~2 s, a VM from it in ~2.4 s with its files and running processes). So a `daytona` computer on v2 **hibernates** instead of pausing:
  - Idle (or **Stop**): a snapshot `polpo-computer-<instance>-<id>-<timestamp>`, waited for until ready (at most `snapshotTimeoutSeconds`, 5 min), then the VM is deleted; status **hibernated** ("Hibernated (resumes in a few seconds)"). A snapshot that fails keeps the VM running, shows the error (e.g. snapshots not enabled for the project, as the API says it) and is tried again after `retryMinutes`.
  - Any use (or **Start**): a VM from the newest snapshot with the computer's name and labels and a `min(maxTimeoutSeconds, 86400)` wall clock that deletes it; its network rule is applied again (a VM that cannot get it is deleted again), its tailnet egress checked again; only then are older snapshots deleted (`keepSnapshots`, default 1). No snapshot: a new VM from the image.
  - Before the wall clock: rotation (snapshot, new VM from it) an hour before, at once when idle or at the first quiet gap, forced in the last 10 min with a warning; a safety snapshot every 6 h while it runs; a VM that vanished anyway is restored from the last snapshot with a notice (`computer:changed` gets `notice`). Commands that arrive while it hibernates or rotates wait for the new VM.
  - Reset deletes the VM and all its snapshots, then a fresh VM from the image; Delete the same and the computer. Only snapshots named for the instance and computer are ever touched.
  - Settings: `providers.daytona.hibernate { keepSnapshots, safetySnapshotHours, rotateBeforeMinutes, rotateIdleGapSeconds, forceRotateMinutes, snapshotTimeoutSeconds, retryMinutes }` (validated). The computer card, the agent's Computer tab, `polpo_computers_list` and `computers_list` show the hibernated status and the last snapshot's time and size. Computers are no longer refused on v2 (the rule of the previous change is gone). Pooled and one-run v2 sandboxes are unchanged (never paused, deleted). Costs: snapshot storage (~memory + disk) while hibernated; a wake is ~3 s. Guide: `docs/computers.md` (Hibernation) and `docs/daytona-v2.md`.
- **Daytona v2: never paused, wall clock capped.** The v2 adapter never pauses: suspend does nothing and the reaper's idle stop deletes a pooled VM (a computer's machine is never deleted that way). Every v2 wall clock is capped at `providers.daytona.maxTimeoutSeconds` (default 86400).
- **Daytona v2: sandboxes as Linux VMs on Daytona's new service.** `settings.sandbox.providers.daytona.api: "v2"` (default `"v0"`: existing instances do not change) creates every Daytona sandbox on `https://api.daytona.com` as a Linux VM (`linux-vm`) with a **project** API key from the vault, from the image `providers.daytona.image` (default the runner image `polpo-runner-vm-2`, built with `node scripts/build-sandbox-images.mjs --provider daytona-v2`), sized per sandbox by `resources`.
  - One-run sandboxes are deleted after their lifetime, pooled ones deleted when idle (v2 VMs are not paused: see above); computers hibernate (see above).
  - Commands return stdout, stderr and the exit code natively; network allowlists take host names and addresses together, and a computer's rule is re-applied when it starts or resumes; computers get a stable name so a repeated create returns the same machine.
  - Settings → Sandbox → Daytona shows and chooses the API version (v0 / v2) and the VM class; the provider card no longer drops options it does not edit (such as `snapshot`) when saved. `apiUrl` with `api: "v2"` is refused when the config loads and by `PATCH /config/settings` (v2 is Daytona Cloud only).
  - SDK: `@daytona/sdk` 2.1.0 is installed as `@daytona/sdk-v2` next to 0.233.0 (2.x's v0 namespace cannot take a custom API URL). Guide, including switching an instance step by step: `docs/daytona-v2.md`.
- **Computers: a persistent machine per agent.** A computer (`settings.computers`: Daytona or E2B, or `host` for this server with an egress proxy) is the same remote machine every time: its working directory, installed tools and browser profile stay between chats and tasks. Agents get `defaultComputer` (their chats and tasks run there) and `computers` (others a task may ask for with `sandbox.computer`); a task or mission asking for an ephemeral sandbox (`sandbox.computer: "ephemeral"`, an explicit provider, `isolation: "fresh"`, or a stricter network) still gets one.
  - Found again by its provider label `polpo-computer=<instance>:<id>`, started/resumed/unarchived when needed, created only when missing; create/start/stop/reset serialized per computer, commands concurrent; kept in use by every command; stopped (Daytona container) or paused (E2B, Daytona VM-class snapshots) after `lifecycle.idleStopMinutes` (default 15), archived after `autoArchiveDays` (Daytona), **never deleted automatically**; uptime tracked as a rough cost signal.
  - **Computers page** (`/computers`): status, agents, last use, uptime, Start / Stop / Restart / Reset / Delete, create and edit; the agent's Sandbox tab chooses its computer; live through the new `computer:changed` event.
  - REST `/computers` (list with live status, create, update, start, stop, restart, reset and delete with `confirm`), agents' `defaultComputer`/`computers` on create and update; Polpo's `computers_list`, `computer_create`, `computer_assign`, `computer_start`, `computer_stop`; MCP toolset `computers` (`polpo_computers_list`, `polpo_computer_save`, `polpo_computer_control`, `polpo_computer_delete`; changes need `polpo:admin`). Guide and the `nina` / `sitoinchat` setup: `docs/computers.md`.
- **Every main primitive as a direct MCP tool** (no `polpo_ask`, no second model in between): the tools call the same REST routes the dashboard uses. New toolsets, on by default: `rooms` (list, create, update, delete, read, post as the connected person with mentions and replies, wait for the agents' replies), `chat` (sessions: list, read paged, rename, star, delete), `memory` (shared and per-agent: read, append, replace, clear), `skills` (list, read, create, update, install, delete, assign), `automation` (mission schedules: create, change, pause, resume, run now, remove; recurring checks: list, create, change, approve, cancel), `connectors` (list with tools, catalog, add with the OAuth link to open, access and tool policy, test, connect, disconnect, remove), `channels` (channels and rules, Telegram chats, WhatsApp profiles; send on Telegram, WhatsApp or email with `confirm: true`; save and delete rules). `team` gains agent delete, avatars, and teams (list, create, rename, move agents, delete). Off by default: `brain`, `learning`, `watchers`, `vault` (names and metadata only), `apps` (apps and browser profiles). Secrets never pass through MCP: tokens, keys and passwords are entered in the dashboard (`setup_url`). About 90 tools by default; see `docs/mcp.md`.
- **REST for what only Polpo's tools could do:** `POST /schedules/:missionId/run` (run a scheduled mission now), `/checks` (recurring checks: list, create, change, approve, cancel), `/telegram/chats` and `/telegram/send` (the chats the bots reach, and sending to them), `PUT /skills/:name` (update a skill).
- **Egress proxies from the API and MCP:** `PATCH /config/settings` takes `egressProxies` (validated as in the config file; `null` removes them), so `polpo_config_update` and the dashboard can set them; `polpo_agent_create` / `polpo_agent_update` set an agent's `browserEgress`, checked against the configured proxies.
- **Connectors (MCP client), like Claude's.** Agents and Polpo use tools from external MCP servers, connected once for the workspace:
  - **Catalog of 152 official remote MCP servers**, each checked against the vendor's docs and a live probe (Notion, Linear, Atlassian, GitHub, Slack, Stripe, Supabase, Sentry, HubSpot, Canva, Zapier, Shopify, …), including **Google Workspace** (Gmail, Calendar, Drive, Docs, Sheets, Slides, Chat, People, search) through Google's official MCP endpoints. Official icons are bundled.
  - **Connect in one click** with OAuth 2.1 (discovery, dynamic client registration or Client ID Metadata Documents, PKCE, refresh). Vendors that need a pre-registered app (Google, Slack, GitHub, HubSpot, …) get it once per workspace (**OAuth apps**); then each of their services connects in one click. Also API keys, custom headers, per-account URLs and regions.
  - **Custom connectors:** any remote MCP URL (Streamable HTTP or SSE, OAuth / bearer / headers / none), and local commands (stdio, admin).
  - **Who can use what:** per connector, Polpo and each agent (default: Polpo only); per tool, Allow or Off. Tools are `mcp__<connector>__<tool>`, also matched by `allowedTools` patterns (`mcp__linear__*`). Agents get them in chats and tasks.
  - **Connectors page** (`/connectors`): connected and browse tabs, categories and search, settings with status, reconnect, test, tools and access; the agent page shows the agent's connectors. Polpo manages them from the chat (`connectors_list`, `connector_add`, `connector_connect`, `connector_update_access`, `connector_remove`).
  - Tokens and secrets live only in the encrypted vault and are never returned by the API. Routes under `/connectors`; the OAuth callback and the client metadata document are the only public paths. Guide: `docs/connectors.md`.
- **Agents talk to each other during a chat**, not only through background tasks (as Grok Bot's bots message each other):
  - `ask_agent`: an agent (or Polpo) asks another a quick question ("wealth-coach: how much can Alessio spend on the gym?");
  - `message_agent`: it hands real work over.
  - **Nobody waits.** Both return at once and the writer goes on. The answer is brought into its conversation as soon as it is ready, in real time: into the answer it is still writing (as a steer), or as a new turn streamed live in the open chat, which shows it as a card ("wealth-coach answered"). While the other agent works the chat shows "wealth-coach is answering…". From Telegram the writer gets a turn there and its answer is posted.
  - **Agent conversations page** (`/agent-talk`, `GET /agent-talk`): the pairs' conversations and the latest exchanges (question, answer, status), updated live from `agent:message` events.
  - Each pair has its own conversation per direction (a session of the receiving agent, `.polpo/agent-dms.json`), so the receiver remembers earlier exchanges. Every exchange is an `agent:message` event.
  - Brakes: no loops (an agent already in the exchange is not asked back), at most 3 agents in a row, 5 minutes per answer.
- **Residential egress for agents' browsers.** Sites that block datacenter IPs see a home line instead: name a proxy in `settings.egressProxies` (e.g. `{ "home": "socks5://100.101.55.7:1080" }`, a SOCKS5 proxy on a computer at home, reached over Tailscale) and set `browserEgress: "home"` on the agents that need it. Only their browser uses it.
  - **When the proxy is reachable**, the browser starts behind it; a browser already running restarts on the same profile.
  - **When it is unreachable** (the computer is off), the browser goes out directly from the server. The exception is a profile signed in through the proxy: it pauses, so a logged-in account is not seen jumping between places.
  - **What takes precedence:** a sandbox network rule keeps its own proxy, and a browser in a remote sandbox is unaffected.
  - Polpo's `egress_status` says whether each proxy is reachable and who uses it; `update_agent` sets `browserEgress`. Setup guide: `docs/residential-egress.md`.
- **Group chats in the Grok Bot style.**
  - **`@everyone`** (also `@all`, `@tutti`) calls every agent of the group.
  - **Replying to an agent's message calls that agent in**, without a mention: a Reply button on agents' messages in web groups, `replyToId` on `POST /rooms/:id/messages`.
  - **A goal and an owner of the next step** per group (`settings.goal`, `settings.owner`, in the group settings): every agent's turn knows the goal and who owns the next step. The owner answers what nobody else picks up and keeps the work moving.
- **Polpo as the primary bot**, as in Grok Bot. With `set_check_ins`, Polpo checks in on a schedule (default 9:00 and 18:00) and writes only when something needs the person: approvals waiting, failed or stuck tasks, finished missions, agents' proposals to confirm. It also proposes a dedicated agent when a kind of request keeps coming back. Its prompt describes the role: it coordinates the agents, and it creates an agent only after a yes.
- **Threads from an agent's reply.** Next to Copy and Speak, a reply has "Thread from this reply": a new chat with the conversation up to that answer, to dig into it without filling the main chat. Nobody answers until you write there; the reply shows a link to its threads, and the thread can be undone like a branch. `POST /chat/sessions/:id/fork` now takes an assistant message too (no re-answer, `turnId: null`); from a user message it still answers it again.
- **Browser profiles from Polpo, the dashboard and the API.** Polpo's tools `browser_profiles` (which agents use each profile, size, last use, whether it holds cookies, open logins), `browser_profile_login` and `browser_profile_clear`, and the routes `GET /browser-profiles`, `POST /browser-profiles/:name/login`, `POST /browser-profiles/:name/login/finish` and `DELETE /browser-profiles/:name`. A login opens the profile at the sign-in page in a browser session (`login-<profile>`) that the Live browser view shows: the person signs in there, with password, 2FA or captcha, and finishing it keeps the login in the profile. Clearing a profile closes the browser sessions writing into it first. Until now this was only possible from a terminal (`polpo browser …`).
- **Tasks, missions, the team and the configuration from any MCP client** (Claude, ChatGPT, Codex, Claude Code), with typed tools instead of the REST escape hatch:
  - **tasks:** `polpo_task_update`, `polpo_task_retry`, `polpo_task_kill` (`confirm: true`), `polpo_task_direct` (steer, follow up or continue a task), `polpo_task_wait` (until it settles, at most 55 s; call again to keep waiting), `polpo_task_logs` (its runs' activity, paged backwards); `polpo_tasks_list` filters by mission and group, `polpo_task_get` includes the latest activity, `polpo_task_create` takes group, expectations, retries, duration, side effects and drafts;
  - **missions:** `polpo_mission_create` from a structured plan (tasks with `assignTo` and `dependsOn`, checkpoints, delays, quality gates; validated as the executor will, with errors that name the task to fix), `polpo_mission_update`, `polpo_mission_run` (start or resume), `polpo_mission_abort` (`confirm: true`), `polpo_mission_wait`; `polpo_mission_get` shows its tasks' progress; `polpo_playbooks_list` and `polpo_playbook_run`;
  - **team:** `polpo_agent_get`, `polpo_agent_create`, `polpo_agent_update`;
  - **config:** `polpo_config_get` (settings and a summary of channels, rules and gates, never secrets), `polpo_config_update` (Polpo's model and fallbacks, image model, reasoning; models checked against the catalog), `polpo_branding_get`, `polpo_branding_update` (name, tagline and logo from a public https URL fetched by the server with a private-address guard, a file of the instance or base64; at most 4 MB, type checked by its bytes), `polpo_providers_list` and `polpo_models_list`. Provider keys never pass through MCP: the tools give the dashboard's Providers page.
  - The wait tools send progress notifications when the client asks (that request is answered as an event stream). Team and config changes need the `polpo:admin` scope.

### Security
- **`browser_fill` takes `from_vault`** ("service.key"): a password or token from the agent's vault goes into the field without passing through the model. On the host the value is given straight to the browser process; in a sandbox it travels in the command's environment, so the command line (which sandboxes log) never holds it, and any echo is masked. Until now an agent had to read the secret with `vault_get` and copy it into `text`, and in a sandbox, where `vault_get` hides values, it could not sign in at all.
- **Polpo's MCP connector has no generic write tool any more.** `call_operation` reached every REST operation, writes included, with one tool and no schema (sends bypassed the WhatsApp and email previews; secrets went through tool arguments). Changes now go through typed tools only; the read-only fallback `polpo_api_get` (GET only, no event streams or binary downloads) and `polpo_api_search` are in the `admin` toolset, off by default.
- **What a client does through MCP is recorded as who it is,** not as "mcp": the person and the client for OAuth (`ada@example.com via Claude`), `mcp-key` for the API or MCP key, the email for a dashboard session; in events (`by`), approvals (`resolvedBy`) and artifacts (`createdBy`). Tools are also gated by scope (`polpo:read`, `polpo:work`, `polpo:admin`; today's tokens and keys hold all of them), and the `401` names the scope.

### Changed
- **Polpo's MCP tools are renamed `polpo_<area>_<verb>` and grouped in toolsets.** Clients see the new names the next time they list tools; there are no aliases:
  - `ask_polpo` → `polpo_ask`, `chat_with_agent` → `polpo_agent_chat`, `list_agents` → `polpo_agents_list`, `show_agent` → `polpo_agent_show` (the agent card's own `agent_card_refresh` and `agent_intention_decide` keep their names);
  - `list_tasks` / `get_task` / `create_task` → `polpo_tasks_list` / `polpo_task_get` / `polpo_task_create`; `list_missions` / `get_mission` → `polpo_missions_list` / `polpo_mission_get`;
  - `list_artifacts` / `get_artifact` / `create_artifact` → `polpo_artifacts_list` / `polpo_artifact_get` / `polpo_artifact_create`; `list_data_sources` / `query_data` → `polpo_data_sources_list` / `polpo_data_query`; `list_approvals` / `resolve_approval` → `polpo_approvals_list` / `polpo_approval_resolve`;
  - `list_files` / `search_files` / `read_file` / `write_file` / `manage_file` → `polpo_files_list` / `polpo_files_search` / `polpo_file_read` / `polpo_file_write` / `polpo_file_manage`;
  - `list_operations` → `polpo_api_search` (admin toolset); `call_operation` is removed, and `polpo_api_get` reads only.
- **Toolsets:** `core`, `tasks`, `missions`, `artifacts`, `data`, `files`, `team`, `config` (on by default) and `admin` (off). An instance chooses them with `settings.mcp.toolsets` or `POLPO_MCP_TOOLSETS` (`default`, `all` or names); a connector URL can narrow them with `?toolsets=core,tasks`.
- **MCP tools return structured content:** an `outputSchema` and `structuredContent` for every tool that returns data, with a short text for the model; lists page with `limit` and `cursor` (`next_cursor`); every parameter is described; annotations include `idempotentHint`; errors say what to do next.
- **Safer defaults over MCP:** `polpo_file_write` replaces an existing file only with `overwrite: true`; deleting with `polpo_file_manage` needs `confirm: true`.
- **`polpo mcp` (stdio) forwards resources and progress too,** so the agent card works there.
- **Daytona SDK moved to `@daytona/sdk` 0.233.0** (the 0.x line, same API as the deprecated `@daytonaio/sdk` 0.222.0 it replaces; not the 2.x SDK). Remote sandboxes and `scripts/build-sandbox-images.mjs` use it.
- **Daytona sandboxes can be sized:** with `providers.daytona.image` (and no `snapshot`) a sandbox is created from that image with the `resources` (`cpus`, `memoryMb`, `diskMb`, rounded up to whole cores and GiB). A snapshot (such as `polpo-runner-*`) has its own size, and E2B sizes by template: there a requested size is not applied and the run gets a warning saying so (it used to be ignored silently).

### Fixed
- **Daytona v2 Linux VMs could not be created**: Linux accepts only "delete" as a lifecycle action, so computers and pooled VMs no longer ask Daytona to pause them (Polpo's idle reaper pauses them), and idle triggers are set explicitly instead of inheriting the project's dashboard defaults.
- **Inactive Daytona snapshots.** Daytona deactivates snapshots nobody used for a while, and every run then failed with "Snapshot … is inactive". Polpo now activates the snapshot, waits until it is active (up to 5 minutes, progress in the log) and creates the sandbox once more; a failed activation says what to do. Settings → Sandbox shows when the instance's snapshot is not active.
- **Daytona network allowlists.** Host names were resolved on the server to IP addresses (CDN addresses change, wildcards only covered the base domain) and sent as up to 50 CIDRs plus 4 DNS resolvers, while Daytona accepts at most 10, so larger allowlists failed at create. Host names now go to Daytona's `domainAllowList` (up to 100, `*.example.com` covers the domain and its subdomains, filtered by Daytona); an allowlist of only IPv4 addresses or ranges goes to `networkAllowList` (up to 10). What Daytona cannot enforce as written (over the limits, host names mixed with addresses, IPv6, malformed entries) stops the run before any sandbox is created, with an error that says why, never a shortened list. E2B: `*.example.com` now also allows `example.com`, as on this machine.
- **Daytona commands lost their stderr:** it came back mixed into stdout and `stderr` was always empty. Commands now return stdout and stderr apart (still one call per command), with the exit code.
- **Falling back to weaker isolation is visible.** When an agent's sandbox provider (Daytona, E2B, Docker) is not available where a run executes, commands run in bubblewrap on the server, as before; now the run gets a warning naming both, the server log says it once, and Settings → Sandbox, the agent's Sandbox tab and `sandbox_status` show the fallback (`fallback` in `GET /sandbox`).
- **Posting in a room returned an empty message.** `POST /rooms/:id/messages` answered before the message was stored (an `await` on the wrong expression), so clients got `{}` instead of the message and its id.
- **Polpo's questions and previews were lost over MCP.** When a turn of `ask_polpo` stopped to ask the person something or to show a mission plan, a WhatsApp message or an email to send, the MCP client got only the text (often nothing) and could not answer, so "ask Polpo to make a mission" never completed. `polpo_ask` and `polpo_agent_chat` now return `status: "needs_input"` with the questions or the preview, and the new `polpo_answer` answers them as the web chat does (execute or save the mission, send or refine the message), then the conversation goes on. A secret Polpo wants to save is never shown: the person gets the dashboard link.
- **The product name and tagline did not save.** `PATCH /config/settings` accepted `branding` but ignored it, so the dashboard's Appearance settings (and now `polpo_branding_update`) changed nothing; an empty string now restores the default.
- MCP connectors now show readable OAuth errors and guide users to shared OAuth app setup when a vendor such as Figma or Square requires an approved client.
- **Agents said they could not send attachments on Telegram.** The only way was `open_file`, which the prompt describes as a web-dashboard preview, and `send_message` carried text only. `send_message` now takes `files` (paths in the agents' workspace, up to 10), sent as Telegram attachments; without `to` they go to the chat the turn came from. A Telegram turn's prompt says how to send files. Only regular files in the agents' workspace leave the server: never `.polpo`, hidden folders or files named like credentials.
- **Deleting a computer could bring its VM back** (seen live: a Daytona v2 VM made again 2 s after the delete, with no computer left, billed until its 24 h wall clock). A delete now marks the computer deleted before its machine goes: a run that had it attached, a tailnet check, a wake or a rotation still on its way fails instead of making a VM, a computer that is no longer in the configuration never gets one, and task runners see a tombstone in `computers-state.json`. Creating a computer with the same id clears it.
- **Restart and reset of a Daytona v2 computer failed with "sandbox … is destroyed"** (2 of 3 restarts live). Daytona's label search still lists a VM deleted seconds ago as started, and the computer tried to use the VM its own hibernation or reset had just deleted. Every hit is now read again by id and a destroyed one is skipped; deleting a VM that is already destroyed is not an error. A reset whose wipe is done no longer answers "try again later": the new machine is tried again, and if it still cannot be made the reset succeeds with a note that it is created on the next use.
- **Computer network rules are checked when saved.** An allowlist entry that is not a host name (e.g. `not a host!!`, `300.1.1.1`) was accepted and only failed when the computer next started, with a misleading "HTTP 502 … try again later". `POST`/`PATCH /computers` (and so MCP and the dashboard) now refuse it with the reason, using the provider's own rules; a rule refused at start is a 400 that says to fix the network rule. Daytona v2 computers take host names only ("Daytona v2 applies domain rules only; use host names"): live, its VMs reached none of the IP addresses or ranges of an allowlist. Saving a network rule on Daytona v2 no longer says to reset the computer (and lose its disk): the rule applies at its next start or wake.

## [0.5.2] — 2026-11-03 — Fixes from DeltaPolpo, chat attachments and voice notes

Most of these fixes are by @DeltaM128 (#149–#183).

### Security
- **Task agents could read and write the project's `.polpo` folder.** The file tools keep agents out of `.polpo` (configuration, `.env`, vault, sessions, storage mounts), but the guard was only switched on in the server process. Tasks run in a separate runner process, where it was off: an agent with the default access (its working directory) could read `.polpo/.env` or the vault file and write anywhere in `.polpo`. The runner now sets the same guard before building the agent's tools, with the same exceptions (offloaded tool outputs, skills, playbooks). A task output folder that lies inside `.polpo` stays writable: it is now granted explicitly. (#150)

### Fixed
- **Files could not be attached in the chat.** The composer accepts any file (`*/*`), but its check read `*/*` literally and refused every file picked or dropped (pasted images went another way). It now accepts any file, matches extensions, and takes the type from the name when the browser gives none (a Telegram `.ogg` export). The limit is 15 MB, as on the server.
- **Audio attached in the chat is transcribed**, as Telegram voice notes are: its words join the message (`[audio name.ogg, transcribed: "…"]`), so the model reads them now and in later turns. The file stays attached.
- **Telegram: replying to a voice note.** A mention of the bot in reply to someone's voice note, photo or file ("@bot what does it say?") brings that media along, even when the bot never received the original. Telegram includes it in the reply. The same holds for a reply to an earlier voice note in a private chat. The bot's own voice replies are not read again.
- **Telegram: failed polling is logged.** A failed `getUpdates` was ignored, so two programs reading the same bot (`409 Conflict`) lost messages without a trace. It is now logged once every 10 minutes, saying what to do.
- A task whose model call failed (e.g. Ollama answering HTTP 500 because the model crashed while loading, or a connection error) ended as **done** with no output and no work: the agent ends such a run with an error reply instead of throwing, and the engine counted it as a success. It now fails with the reason (`Model error: …`), so it is retried and then shown as failed. (#149)
- A run stopped at the turn limit is not a model error: stopping the agent at `maxTurns` ends its last call with an abort error, so the run ends as a normal one (its expectations decide) and its output says `[Stopped at the turn limit (N turns)]`. (#149)
- Tool calls whose arguments did not match the tool's schema were run or previewed anyway: e.g. a local model putting the mission name inside `data` produced a mission preview without a name. The chat now checks every call against its schema (pi-ai's validator) before running or previewing it; a call that does not match is returned to the model with the reason, so it can call the tool again in the same turn. An object or array parameter passed as a JSON string is still accepted, as before. (#151)
- **A playbook that cannot run says why, and which task to fix.** The reason was shown only in a toast that disappears in seconds, and it named fields by index (`tasks.0.description: task requires a description`). The Run dialog now keeps the reasons on screen until the next try, and they name the task, checkpoint or delay (`task "test" (tasks.0).description: task requires a description`). (#152)
- **The mission graph disappeared when a run paused at a checkpoint** (nodes and connections gone, only the background left). On every status update the graph was rebuilt with new node objects that had lost the size React Flow had measured; React Flow hides a node of unknown size and measures it again only when its size changes. Task cards change size with their status, so they came back, but at a checkpoint nothing changed size and the whole graph stayed hidden. The rebuilt nodes now keep their measured size (mission page). (#153)
- `ui/server.mjs` did not work on Windows: every file, including the JavaScript and CSS in `/assets`, was served as `index.html`, because the path check expected `/` separators, and the default static root was built from a URL path (`/D:/...`). The server now uses the platform's paths and still refuses paths outside the static root. (#154)
- **Line numbers copied from `read` into files.** The read tool shows each line as `<n><TAB><text>`, and agents of every size copied those numbers into what they wrote (with the tab, a space, the escape `\t`, a dot or nothing, sometimes with `\n` written instead of the line breaks), so a file ended up with numbers that were never in it. `write` and `edit` now refuse content whose every line starts with consecutive line numbers, with text after them on most lines (a file of numbers, one per line, is data), with an error that says why; `keep_line_numbers: true` lets a file whose lines really are numbered through. An `edit` whose `old_text` carries the numbers says so instead of a bare "not found", and the read tool's description says the numbers are not part of the file. (#161)
- **The glob tool found nothing for patterns with a folder** (`docs/report.md`, `src/**/*.ts`), and nothing at all on Windows without bash: it ran `find -name`, which matches file names only, through a Unix shell. It now walks the files itself (`src/tools/glob-files.ts`, on the FileSystem port, so remote sandboxes too), with `*`, `**`, `?`, `{a,b}` and `[abc]`; `node_modules` and `.git` are walked only when the pattern names them. (#161)
- **The bash tool failed for every command on Windows** ("uv_spawn '/bin/bash' ENOENT"): the local workspace always ran `/bin/bash -c <command>`. On Windows it now uses Git for Windows' bash (from the usual install folders, or next to `git` on PATH; never `System32\bash.exe`, the WSL launcher), else `cmd.exe`; `POLPO_SHELL` picks another bash-compatible shell. Commands no longer open a console window. Linux and macOS are unchanged. (#162)
- **A context-full error from Ollama or llama.cpp was not recognized** ("request (16384 tokens) exceeds the available context size"), so the task failed instead of compacting its conversation and retrying once, as it does for the other providers' overflow errors. (#163)
- **A mission or playbook task's `maxRetries` was ignored:** every task got the project's `settings.maxRetries` (3 by default), so a task meant to fail at once (`maxRetries: 0`) was retried three times. The task now keeps its own value; `POST /tasks` accepts `maxRetries` too. (#164)
- **A page on another origin saw a rate-limited request as "Failed to fetch"**: the rate limit answered 429 before the CORS headers were added, so the browser hid the answer and its `Retry-After`. CORS now runs first (preflight requests no longer count against the limit) and `Retry-After` is exposed. (#166)
- **A runner that could not start ended the whole server** (for example a project folder longer than Windows' 260 characters, or one that no longer exists): the start error came as an event nobody listened to. The task now fails with the reason and the working folder, and the server keeps running. (#167)
- **A `dependsOn` on a task listed after it was dropped in silence**, so the task started at once, in parallel with the one it should have waited for: the tasks were created in the listed order, and a dependency not yet created had no id to point to. They are now created dependencies first (the listed order is kept otherwise, and the output folders keep their numbers). A `dependsOn` naming a task that does not exist, or a cycle (`A` → `B` → `A`, which would never start), is now refused with a message that names the task; renaming a task in a mission keeps the `dependsOn`, checkpoints, delays and quality gates that point to it. (#169)
- **An agent limited to some tools was told it had all the core ones**: the agent's prompt listed read, write, edit, bash, glob, grep, ls, http_fetch, http_download, register_outcome and the vault tools as "always available", and the Ink tools too, whatever its `allowedTools`. An agent limited to the file tools tried `bash` ("Tool bash not found") or wrote that it had run a command it never could. The prompt now names only the tools the agent gets, with the same filter that creates them (the vault tools come with every agent); an agent without `bash` is told it has no shell and not to claim tools it does not have, and the bash rules are left out of its task message. (#170)
- **On Windows, `file_exists` expectations on an absolute path always failed** (`C:\data\x.csv`, `C:/data/x.csv`, `\\server\share\x.csv`): the check read a Windows absolute path as relative to the working directory and looked for it there. (#177)
- **On Windows, `test` and `script` expectations and metrics ran in `cmd.exe`**, while the agents' commands run in Git's bash: a check written for bash (`test -f …`, `grep -q …`) always failed there. They now run in the same bash (cmd.exe only when Git's bash is missing); Linux and macOS are unchanged. (#178)
- **On Windows, a command stopped for its timeout kept running** (the bash tool, checks): only the shell was ended, and the program it had started went on, keeping the run waiting until it finished by itself. Now the msys process groups of Git's bash are ended (the programs it runs are linked to it there, not in the Windows process tree, so `taskkill /T` alone misses them), then the Windows tree; a stopped command no longer waits for its output to close. A runner the supervisor kills on Windows (task timeout, unresponsive agent) takes the commands it started with it. (#178)

## [0.5.1] — 2026-10-31 — The agent card in Claude and ChatGPT

### Added
- **The agent card, an MCP App:** in Claude, ChatGPT and other hosts that show [MCP Apps](https://modelcontextprotocol.io/extensions/apps/overview), the `show_agent` tool shows an interactive card in the conversation; other clients get the same as text.
  - **Inline:** whether the agent is working, the task at hand, today (done, failed, waiting for a person), what it plans next and its main goal with its progress. Two actions: **Open** (full screen) and **Ask for an update** (a chat message, so the model talks to the agent).
  - **Full screen:** tabs for overview (self-portrait, goals, latest reflections), tasks (with filters), goals (the tree with progress) and routine, where the agent's proposals are confirmed or cancelled. The tab in view goes to the model's context.
  - **Native look:** the host's style variables (light and dark, its font), a transparent background, skeletons while loading, safe areas and 44px targets on mobile, no menus or inline scrolling.
  - **One live card per agent:** when the card is shown again in a conversation, older copies grey out.
  - **Claude** reads a connector's apps when it is connected: reconnect the connector after an update that adds or changes apps.
  - **Log:** one `[polpo/mcp]` line per MCP message, without contents (the client and whether it shows apps, the tools and resources it uses).
  - **Self-contained:** the widget (`widgets/agent-card`, built with the MCP Apps SDK into one HTML document by `pnpm run build:widgets`) loads nothing from other origins. Its refresh and decide tools are visible only to it.

### Fixed
- **A long chat compacted again at every turn.** When a session's saved context checkpoint stopped matching the conversation (for example after a change of model), the new checkpoint was never saved: the save expected "no checkpoint yet" and the store refused it. From then on, every message summarized the whole conversation again: hundreds of thousands of tokens per turn, sometimes past the 90-second limit. A checkpoint that no longer fits is now replaced, so the next turns reuse it. The server logs why a checkpoint was not reused (`[polpo/compaction]`).

## [0.5.0] — 2026-10-25 — Artifacts and the MCP connector

### Added
- **Artifacts** replace Views: one concept for what agents and people make to look at and keep.
  - **Types:**
    - `doc` (Markdown);
    - `html`, one self-contained page with a kind: dashboard, design, app, report, page;
    - `svg` (a drawing) and `mermaid` (a diagram);
    - `view`, the former data views, still shown and working.
  - **Data in html artifacts:** the page runs isolated, in a sandbox without same-origin and with a strict CSP: no network except a few CDNs for libraries. It reads the instance's data sources through a `polpo` bridge with the **rights of its author**: an agent's artifact sees only the sources and fields that agent is granted. The bridge offers:
    - `polpo.sources()`, `polpo.describe(id)`, `polpo.query({...})` and `polpo.sql(id, …)` (read-only);
    - `polpo.onRefresh(fn)`, called every `refreshSeconds` and when a data source changes;
    - `polpo.theme` / `polpo.onTheme`.
  - **Versions:** every change keeps the previous content with its author and note, and any version can be restored.
  - **Tools:** `artifact_create`, `artifact_update` (whole content, or find/replace edits), `artifact_get` (also earlier versions), `artifact_list`, `artifact_delete`.
    - Polpo has all of them; agents get them with `artifact_*` in allowedTools (a new "Artifacts" category in the Tools tab).
    - Agents change only their own artifacts.
    - `navigate_to` gains `artifacts` / `artifact`.
  - **API:** `GET/POST /artifacts`, `GET/PATCH/DELETE /artifacts/:id`, `POST /artifacts/:id/restore/:version`, `POST /artifacts/:id/data` (the bridge). The event is `artifact:changed`. Storage is the `artifacts` table (SQLite/Postgres migrations) or `.polpo/artifacts/` in file mode.
  - **UI:**
    - an **Artifacts** section (replacing Views in every menu) with a gallery by type and search;
    - a viewer with live content, versions and restore, source, data reload, full screen and download;
    - in the chat, a card for each artifact made or changed, which opens it next to the conversation.

- **Polpo as an MCP connector:** every server is also an MCP server at `/mcp` (Streamable HTTP, stateless), so Claude Code, Codex, Claude Desktop, Cursor and other MCP clients can use the instance.
  - **Tools:** 22 tools for what people do (`ask_polpo` delegates anything to Polpo; `chat_with_agent`; tasks, missions, artifacts, data, approvals; files: `list_files`, `search_files`, `read_file` with text by line ranges and images and PDFs as they are, `write_file`, `manage_file` to make folders, rename and delete) plus `list_operations` / `call_operation`, which reach every REST operation of the server (more than 300). There is not one tool per endpoint, to keep the model's context small. Read-only and destructive tools (`call_operation`, `resolve_approval`, `write_file`, `manage_file`) are annotated.
  - **Authentication:** the API key as `Authorization: Bearer` or `X-API-Key`, or **OAuth 2.1**, so it can be added as a custom connector in Claude (web, Desktop, mobile) and ChatGPT.
    - **Discovery:** a `401` with the protected-resource pointer, then RFC 9728 and RFC 8414 metadata.
    - **Client registration:** Client ID Metadata Documents or Dynamic Client Registration.
    - **Codes:** authorization code with PKCE S256 only, `iss` in the response, loopback redirects on any port for Claude Code.
    - **Consent page:** signed in to the dashboard, or with the API key or MCP key; it has a session-bound CSRF token.
    - **Tokens:** 1-hour access tokens and 30-day refresh tokens rotated at every use, stored hashed in `.polpo/oauth.json`; `/oauth/revoke`.
    - **Public URL:** the `X-Forwarded-*` headers when behind a proxy, or `POLPO_PUBLIC_URL`, which may carry a path (a proxy that mounts Polpo under `/name`) and applies to requests through its host.
  - **Publishing only the connector:** `POLPO_MCP_KEY` opens `/mcp` and the consent page without putting an API key on the dashboard and REST API, so an instance can expose `/mcp`, `/oauth` and the discovery documents (for example with Tailscale Funnel) and keep the rest private. Since these endpoints can be public, open client registration is capped (200 clients; ones holding tokens are kept), and client metadata documents are fetched only from public addresses.
  - **Same rules:** the tools call the server's own REST API in process.
  - **stdio:** `polpo mcp --url <server> --api-key <key>` runs the same tools over stdio for clients that start a process.
  - **Setup guide:** `docs/mcp.md`.
- The API key middleware also accepts `Authorization: Bearer <key>`, not only `X-API-Key`.

### Changed
- Polpo's prompt now says when to make an artifact (documents, dashboards on real data, designs, diagrams) and keeps `render_widget` for small throwaway visuals in the chat. The old prompts contradicted each other on views vs widgets.
- `data_create_view` / `data_update_view` are deprecated in favor of html dashboards. `/views` redirects to the artifacts of type view.
- In the Artifacts section the former data views are marked **Legacy**: they have no tab of their own and a note says to make html dashboards instead.

### Fixed
- A data view shown in the dashboard queried its sources as an administrator, so an agent's view could show data that agent is not granted. As an artifact, a view's data bridge uses its author's rights.

## [0.4.10] — 2026-10-15 — Fixes from DeltaPolpo

Most of these were found and fixed by @DeltaM128 in the DeltaPolpo fork (#127; #133–#137, #144, #145). Thanks!

### Added
- **Local (offline) models in setup:** the provider step has a "Local model (offline)" option for Ollama, LM Studio, vLLM or any OpenAI-compatible server on this machine or the local network. Polpo detects the server and its models, and flags Ollama models without tool calling, which can chat but cannot run agent tasks. No account or API key is needed.

### Changed
- A new mission whose name is taken is named `name (2)`, `name (3)`…, so every run of a playbook is its own mission.
- Task titles must be unique within a mission, no longer across all active tasks, so two runs of one playbook can run at the same time.
- Abort also cancels a mission paused at a checkpoint, and releases its checkpoints and delays.

### Fixed
- **Telegram voice notes in private chats are transcribed on arrival**, as in groups, and their words become the message.
  - **Why:** before, the model got an audio file it cannot hear and had to transcribe it with its tools. Polpo has no speech-to-text key of its own, so it delegated the transcription to an agent as a task. The transcript then lived only in a tool result, so the next message no longer knew what the voice note said ("I don't have the content of the voice message").
  - **Which key:** the agent's own speech-to-text key (vault, then environment). Polpo uses the environment, else the first agent's key.
  - **Without a key:** the audio stays attached, as before.
- Task runs ignored the custom providers of `polpo.json` (local model servers such as Ollama or LM Studio, gateways): their models worked in chat, but tasks failed with "Model not found". The task runner now registers them, with their secrets from the vault.
- Playbooks could not be run from the dashboard: the run dialog existed but no button opened it. Playbook cards and the playbook page now have a Run button.
- Playbooks with checkpoints, delays or quality gates could be saved but not run: the blocked tasks lacked the `dependsOn` the mission schema requires, and the run answered a plain-text 500 ("Unexpected token 'I'… is not valid JSON" in the dashboard). The dependencies are now added when the playbook runs, and a run that cannot start answers a JSON 400 and leaves no mission behind.
- `GET /missions/checkpoints` and `GET /missions/delays` answered "Mission not found": `GET /missions/:missionId` was registered first and took them.
- A mission paused at a checkpoint lost its pause on restart, and the blocked task was then force-failed as a deadlock: with file storage, checkpoint and delay state was kept in memory only. It is now saved in `.polpo/`, a paused mission is never treated as a deadlock, and missions paused before the fix get their checkpoint back.
- Running a playbook a second time created a mission with the same name, which is its task group: the new run saw the first run's finished tasks (its checkpoint was reached at once) and was never marked completed. With SQLite storage the second run failed instead.
- With two missions that have tasks with the same titles in progress (e.g. two runs of one playbook), a checkpoint, delay or quality gate could be skipped: they looked for their tasks by title across all missions. They now look only at their own mission's tasks.
- Missions that share a name never completed, and Abort and Resume had no effect on them: completion, abort and the mission page went by the shared group and always found the first mission. They now work per mission, and missions left active with all their tasks finished are completed on the next start. Deleting one of them no longer deletes the other missions' tasks.
- The mission page refreshed the mission only on the first change of a run: nothing cleared the "missions stale" flag when the missions list was not mounted. Checkpoint events now also update the mission status (paused / active), and an abort refreshes it.
- The Approvals page went blank (counters back to 0) at every refresh: `useApprovals` showed the loading state on every refetch. It now does so only on the first load.
- The agents list kept a stale ETag after an agent's configuration changed, so browsers kept showing the old agents. The ETag now depends on the content.
- A delay whose duration the parser could not read (e.g. `PT1s`, lowercase) made every supervisor tick fail, so no task of any mission started anymore. Durations are now read case-insensitively, a mission or playbook with an invalid duration is refused with a clear message, and a stored delay that still cannot be read is reported once and ignored instead of stopping the supervisor.
- **Desktop app:** the model list of the Add agent dialog was empty: the model picker asked for the models with a relative path, which does not reach the server from a page loaded from `file://`. It now uses the configured server address and API key.

## [0.4.9] — 2026-10-14 — Routine

### Added
- **Drive: a routine of its own.** An agent with a drive keeps a routine: the recurring moments its purpose, responsibilities, goals and tasks need (a morning check-in, an end-of-day review, a weekly plan), as recurring checks with a `why`.
  - It sets the routine up at its first reflection, keeping the checks it already has.
  - It reviews the routine at the weekly review and whenever its goals or tasks change.
  - Its chats show the routine apart from what is planned once.
- **Drive: its Polpo tasks.** Reflections now see the agent's open Polpo tasks (assigned to it), so its plan and routine follow its work.
- **UI:** recurring intentions are marked "Routine" in the Goals tab.

### Fixed
- Replies of tool-using turns (channels, check runs, reflections) glued the text of each step together ("Now the plan.Now today's…"). Each step's text is now its own paragraph.

## [0.4.8] — 2026-10-13 — Drive

### Added
- **Agent drive** (`drive` in the agent config, off by default): an agent pursues a purpose and goals on its own initiative, among people, instead of only answering when called or scheduled.
  - **Reflection:** it reflects on its private chats and on the groups it is in, including messages it only read. It reflects after `reflectEveryMinutes` (default 120) when something new happened, and once a day in any case. It decides by itself whether to write now (`send_message`), plan something for later, or do nothing, weighing how much it serves its purpose, how serious and how urgent it is.
  - **Intentions:** while it talks or reflects, it plans follow-ups on its own, such as wishes on someone's birthday or a check-in after an event. An intention is a scheduled check with a `why`.
  - **Autonomy:** with `propose`, its own initiatives wait for a yes; with `balanced` (the default), it acts on low-stakes things and asks first otherwise; with `act`, it uses its own judgment. Proposed checks are approved with `confirm_check`, by Polpo, or in the UI.
  - **Self-portrait:** it keeps a self-portrait covering its personality, the people who matter and its open threads, updated with `update_self` and part of every conversation. It starts from the identity's personality, or writes one coherent with its purpose.
  - **Human customs:** its prompt covers birthdays and holidays, tact in groups vs private, choosing the moment, not nagging, and stopping when asked.
  - **Goals in a cascade:** it breaks its purpose down into long-term (6–12 months), quarter, month, week and day goals, each under the one it serves, with a measure, progress, an owner (its own, or a person's or group's it supports) and the steps to do. It keeps them in its plan with `add_plan_item` / `update_plan_item`, and the plan is part of every chat.
  - **Review rhythm:** when its day starts (`dayStartsAt`, default 07:30 in its timezone) it plans the day. On a new week, month or quarter it also does that review: score, adjust, set the next goals, and check in with the people it supports.
  - **Method:** the guidance follows goal-setting research:
    - specific, measurable goals, at most 3–5 per horizon;
    - if-then plans for key actions;
    - important before urgent, with timeboxed work sessions;
    - progress monitoring;
    - autonomy-supportive help for people's goals (ask, offer options, never shame);
    - for groups, shared goals with regular check-ins.
  - **Growing:** it asks what it could do more or better and what it lacks, studies it with its tools, and writes its own skills. With a drive it always has its own-skill tools (`list_my_skills`, `create_my_skill`, `update_my_skill`), which can be undone in the Learning tab.
  - **Polpo:** `add_agent` / `update_agent` take `drive`; `get_agent_drive` shows the purpose, self-portrait, intentions and reflections; `reflect_agent` makes the agent reflect now.
  - **API:** `GET /drive/:agent`, `PUT /drive/:agent/self`, `POST /drive/:agent/reflect`, `POST /drive/:agent/intentions/:id/confirm|cancel`; the event is `agent:reflected`.
  - **UI:** a **Goals** tab in the agent page with purpose, goals, autonomy, day start, self-portrait (editable), the goals and steps tree (mark done or drop), planned and proposed intentions (approve or reject), and the reflections journal.
  - **API:** `PATCH /drive/:agent/plan/:id`.
- Scheduled checks gained a `proposed` state (waiting for a yes) and a `why`.

### Fixed
- **Desktop app:** no task ever ran. The compiled server started task runners with a script path that does not exist inside the binary ("too many arguments. Expected 0 arguments but got 3"); it now starts them with a hidden `__runner` command.
- **Desktop app:** "Login with subscription" failed for every provider ("Cannot find module './anthropic.js'"). The OAuth flows are now registered statically, and provider login pages open in the default browser instead of a bare Electron window.
- After a setup completed from the dashboard, tasks stayed pending until the server was restarted: the supervisor loop never started.
- After a setup completed from the dashboard, the dashboard received no live events until the server was restarted: the `/events` route kept the event bridge that setup had replaced.
- Thanks to @DeltaM128 for finding and fixing these four (#128).

## [0.4.7] — 2026-10-13 — Anywhere

### Added
- Agents and Polpo can now send messages to any chat, from wherever they are asked (web chat, private chat or a group).
  - **`send_message`:** sends now to any Telegram group, topic or person the bots have met, by name or id.
  - **`list_chats`:** lists those chats, their ids and the current time.
  - **Bot fallback:** if the agent's own bot is not in that chat, another bot of the instance sends the message.
  - **Transcripts:** a message to a group is saved in that group's transcript.
- `schedule_check` can now:
  - send to any chat (`to`, `topic`);
  - run once (`at`, `in_minutes`) or on a cron with a timezone (`cron`, `timezone`, default the agent's identity timezone), besides `every_minutes`;
  - send a fixed `message` without running the agent, for reminders.
- `list_checks all=true` lists an agent's checks from every chat, and every check of the instance for Polpo. Polpo can cancel any check.
- Agents' chat instructions and Polpo's prompt explain all of the above and include today's date, so "tomorrow at 9" resolves correctly.

### Changed
- Telegram `sendMarkdown` now reports whether Telegram accepted the message.

## [0.4.6] — 2026-10-12 — Polpo Knows

### Added
- Polpo knows what agents can do in chats and can manage it:
  - **Prompt:** a "What agents can do in chats" section covering learning, recurring checks, voice replies and reactions.
  - **`add_agent` / `update_agent`:** take `learning` and `voiceReplies`.
  - **New tools:** `get_agent_learning` (setting and recent changes), `review_agent_learning` (review now) and `revert_agent_learning` (undo a change by id).
- Agents' chat instructions say to use `schedule_check` to follow up instead of promising, and to change their own learning and voice settings when asked.

## [0.4.5] — 2026-10-12 — Learning Agents

### Added
- **Agents learn from their conversations** (opt-in per agent, `learning`): every N new messages (default 30) or after a quiet period (default 30 min), the agent reviews its chats with its own model, keeps its memory current, and writes repeated procedures down as skills of its own (`create_my_skill` / `update_my_skill`, only skills it created).
  - Every change is recorded with before and after, reported as an `agent:learned` event, and can be undone (agent page → Learning, or `POST /learning/:agent/changes/:id/revert`).
  - The agent turns it on or off itself (`set_learning`) (#119)
- In-app changelog (What's new) entries for everything since 2026-10-06

### Fixed
- The agent API (`POST`/`PATCH /agents`) dropped `learning` and `voiceReplies` (#119)
- Telegram: "…processed your request but has nothing to say".
  - A turn that ended without a word (usually right after tool calls) is now asked once for its reply.
  - At the step limit the agent writes one last answer without tools instead of stopping silently. Polpo's Telegram loop goes from 15 to 40 steps.
  - What is left says what happened and where to look, and logs a warning

### Changed
- CI: Desktop Check closes the app and waits for the Windows installer to finish before using the installed app; the real-jail network tests have 30 s; the CLI layer tests retry (known flaky, now logging why) (#115, #120)

## [0.4.4] — 2026-10-11 — Checks, Voice, Reactions

### Added
- **Recurring checks in a chat** (`schedule_check`, `list_checks`, `cancel_check`, for agents and Polpo): "check every 2 minutes whether the site answers and tell us if it goes down".
  - Each run is a turn of the check's own session, and a run with nothing to report (`NO_UPDATE`) stays silent.
  - Reports go to the Telegram group, topic or chat where the check was asked, into the group's transcript, and into that chat session.
  - Stored in a new `conversation_checks` table (SQLite/PostgreSQL migrations) or in `.polpo/conversation-checks/`.
  - Before, agents promised to notify with no way to do it, and Polpo's schedules only reached the owner's chat (#112)
- **Voice replies on Telegram**: `voiceReplies` per agent (and `settings.voiceReplies` for Polpo), `off` by default, `voice` (answer a voice message with one) or `always`.
  - Sent as a real voice message (OpenAI TTS in Ogg/Opus, else ElevenLabs, else edge-tts), with the text as the caption.
  - Agents know their setting and change it themselves with `set_voice_replies`; Polpo can change its own or an agent's (#114)
- **Emoji reactions**: an answer that is a single emoji Telegram accepts (👍 ❤ 🔥 🎉 👀…) is put on the message as a reaction instead of being sent; agents are told so on Telegram turns (#116)
- **`list_models`** for Polpo: searches the model catalog (built-in providers and custom gateways), by default only providers with credentials. Custom gateways now appear among the connected providers in its prompt (#113)

### Changed
- CI: Desktop Check uses the packaged app on Linux, macOS and Windows: a chat with Polpo answered by a mock model, and the main pages rendered without errors. On Windows it also builds the installer, installs it silently and uses the installed app (#115)

## [0.4.3] — 2026-10-11 — Desktop Window, Group Media

### Fixed
- Desktop app: blank window in 0.4.2. The release built the UI for the web (absolute `/assets/…` paths, service worker), while Electron loads it from `file://`. It is now built with `POLPO_ELECTRON=1` (relative paths, no service worker) (#109)
- Telegram groups: agents understand photos and voice notes. Every group message's media is downloaded and described once, whichever bot gets it first. Voice notes and audio are transcribed (Whisper or Deepgram, with the bot's agent's vault key or the env), and photos and files are saved in the workspace. The description goes into the transcript every agent reads, counts for intent, and goes into the addressed agent's turn (images still attached). Before, agents only saw `[photo]` / `[voice message]` (#108)

### Changed
- CI: Desktop Check also opens the packaged app on Linux, macOS and Windows. The window must load the UI and reach the server (#109)

## [0.4.2] — 2026-10-10 — Docker Images

### Fixed
- Docker images build again, and are published for the first time in the 0.4 series (`ghcr.io/alemicali/polpo-zhc`, `/server` and `/ui`):
  - `sharp` is now a declared dependency, instead of coming in through an optional peer of Baileys
  - the UI image builds `@polpo-ai/core`, which the UI imports
  - the icon subset script resolves the icon packs as the UI's own dependencies (#105)
- The release notes job runs again: it was skipped whenever the Docker job failed (#105)

### Changed
- CI: Docker Check builds the server and UI images like the release for dependency and Dockerfile changes, and starts both (#105)

## [0.4.1] — 2026-10-10 — Desktop Server Fix

### Fixed
- Desktop app: "Server Start Failed" on every platform. The bundled server could not find `playwright-core` and `sharp`. They now ship next to it with this platform's sharp binaries, the sidecar is built with `--compile-autoload-package-json`, and the app starts the server with `NODE_PATH` on them whatever folder Polpo is started from. The server also starts without them: they are loaded only when used (#101)
- `/api/v1/health` reports the running version instead of `0.1.0`, and the desktop server's `--version` no longer reports `0.0.0` (#101)
- Desktop auto-update looked for releases in `lumea-labs/polpo`. It now uses `alemicali/polpo-zhc` (#101)

### Changed
- "Server Start Failed" shows the server's exit code, its last lines of output and the path of `server.log`, and appears as soon as the server exits (#101)
- Links, install scripts and pages, README and the Docker image (`ghcr.io/alemicali/polpo-zhc`) point at this project. `docs/openapi.json` is up to date (#102)
- CI: Desktop Check packages the app on Linux, macOS and Windows for desktop changes and starts the bundled server (on Linux also in a clean container without Node) (#101)

## [0.4.0] — 2026-10-09 — Sandbox, Rooms, Events

Covers everything since 0.3.4 (#44–#97).

### Added
- **Sandbox**: commands can run in bubblewrap, Docker or a remote VM (Daytona, E2B). Includes network allowlists through a proxy, CPU and memory limits, lease, pool and warm VMs, and tool placement (sandbox or host). Opt-in: without configuration commands run on this machine (#83, #84, #87, #90–#94)
- **Volumes in Files**: a volume is a folder of this server or an S3/R2 bucket (FUSE mounts, temporary bucket keys). The Storage page is gone (#83, #95, #96)
- **Rooms**: group conversations as rooms, with one transcript for people and agents. Group chats on the web, and agents answering each other (#64, #65)
- **Telegram**: agents, pairing, sessions, inbound webhook. Agents in groups answer by intent, know who is in the room and answer each other (#48, #53, #61–#63, #66)
- **Events**: Activity and Logs become Events (Live / History) with filters by type, agent, outcome and period. A typed event bus with a complete catalog and the origin of every event (#70–#72, #74, #77)
- **Chat**: steering, a server-side queue and conversation branches. Groups inside the chat (#57, #68)
- **Context compaction**: one two-stage compactor for chats and task runs, `/compact`, a cheaper summary model by default (#81, #82)
- **Custom AI gateways**: OpenAI- and Anthropic-compatible providers, with a UI wizard, vault keys and a network guard (#58)
- **Vault**: multi-mailbox email tools, shared credentials across agents, and vault references (features point to vault entries instead of keeping keys) (#45, #46, #89)
- **API**: counts, slim lists, segments, incremental sync, active turns (#44)
- **Loops**: deterministic loop contract (#47)
- **Ink**: self-hosted hub on Node, configurable hub and registry (#67)
- **What's new**: a top bar that opens a drawer with the changelog (#68, #69, #73)
- **Tools**: large outputs are offloaded to files instead of being lost (#80)
- **Log retention** for orchestrator event logs (#52)
- New channel cards in Settings → Channels (#86)

### Changed
- Complete, optimized PostgreSQL support (#51)
- pi-ai and pi-agent-core 0.85.1 → 1.0.4 (#49)
- Data layer: relative paths, read-only SQL enforced by the database, query timeout (#78)
- Fewer full reads in the supervisor and background waits; Postgres task search (#75)
- CI runs on Linux only and builds in parallel. Bubblewrap tests now run on the runners (#60, #97)

### Fixed
- Security: command injection in Ink/skills, provider key redirect, config secret leak, .env injection, reserved vault owners (#59)
- Shutdown no longer hangs with PostgreSQL (#54)
- A crashing agent runner no longer leaves its task stuck (#88)
- Task runners actually use Daytona/E2B (#91); `update_agent` exposes the sandbox parameter (#85)
- The sandbox network bridge runs on the server's own node, so it works with nvm, `/usr/local` or `/opt` installs (#97)
- Mission notification rules and rule actions after reload (#76)
- UI: data-page refresh loop and chat list update loop (React #185); error boundaries (#79)
- UI lint passes with 0 errors (#56, #97)

### Removed
- The unused `@polpo-ai/tools` fork and dead server code (#50)

## [0.3.4] — 2026-03-19 — Desktop Sidecar Fix

### Fixed
- Release workflow now builds and uploads all workspace packages (vault-crypto, tools, server were missing)
- Desktop sidecar build resolves all @polpo-ai/* dependencies correctly

## [0.3.3] — 2026-03-19 — CI Fix

### Fixed
- React SDK references updated from `@polpo-ai/client` to `@polpo-ai/sdk` (package rename missed in react-sdk)
- Release workflow updated to build `@polpo-ai/sdk` instead of `@polpo-ai/client`
- Lockfile synced with workspace dependencies

## [0.3.2] — 2026-03-19 — Ports & Adapters, SDK, Skills

### Added
- **@polpo-ai/core** — pure business logic package, zero Node.js dependencies (types, schemas, state machine, hooks, store interfaces, EventBus, managers)
- **@polpo-ai/drizzle** — Drizzle ORM stores with dual-dialect support (PostgreSQL + SQLite), 11 store implementations, `ensurePgSchema()`
- **@polpo-ai/server** — edge-compatible Hono route factories (agents, missions, tasks, completions, events, config, files, skills)
- **@polpo-ai/tools** — all agent tools in one lightweight package with FileSystem/Shell abstractions
- **@polpo-ai/sdk** — TypeScript SDK for the Polpo API (agents, tasks, missions, teams, vault, memory, SSE events)
- **FileSystem + Shell abstractions** in core — ports & adapters pattern for runtime-agnostic I/O
- **Skills system** — SKILL.md files with YAML frontmatter, per-agent assignment, GitHub install (`polpo skills add`), injected into agent system prompts
- **Agent-direct completions** — OpenAI-compatible `POST /v1/chat/completions` for user-to-agent chat with SSE streaming
- **Session management** — agent-scoped sessions, bulk import (`POST /sessions/import`), rename, delete
- **Per-agent memory** — agent-scoped memory tools for direct chat context
- **TeamStore / AgentStore abstractions** — agents persisted independently from polpo.json (FileAgentStore, DrizzleAgentStore)
- **VaultStore / PlaybookStore** — AES-256-GCM encrypted credential storage with Drizzle backend
- **OrchestratorEngine + Spawner abstraction** — decoupled orchestration from Node.js process spawning
- **MissionExecutor in core** — pure logic, zero Node.js dependencies, async store loading via `.ready`
- **Route factory pattern** — all routes accept dependency injection, reusable across runtimes
- **Electron auto-updater** — desktop app self-updates via GitHub Releases (multi-platform CI)
- **SDK E2E tests** — 22 tests covering tasks, missions, vault, teams, SSE events

### Fixed
- **Agent changes now persist across restarts** — `syncConfigCache()` called on startup, reads from agents.json (authoritative source) instead of stale polpo.json (#35)
- **Desktop update warning** — `polpo update` detects Electron context and warns to restart the app (#33)
- PostgreSQL compatibility — split `ensurePgSchema` into individual statements for Neon HTTP driver
- SDK remote API compatibility — `apiPrefix` auto-detection, Authorization header, health endpoint
- JSON serialization for text columns — `deserializeJson` handles both string and parsed object inputs
- Transcript persistence in postgres/sqlite mode
- VaultStore wiring when `storage=postgres/sqlite`
- Replace `workspace:*` with versioned deps in published packages

### Changed
- Renamed `coding-tools` → `system-tools`
- Renamed `client-sdk` → `@polpo-ai/sdk`
- Decoupled completions route from Orchestrator class (dependency injection)
- Tools use FileSystem/Shell abstractions exclusively (no more platform if/else)
- `buildAgentSystemPrompt` extracted to core, accepts optional skills
- `parseModelSpec` + `PROVIDER_ENV_MAP` extracted to core

### Removed
- Raw SQLite stores — all SQL now goes through Drizzle
- TUI (Ink-based terminal UI) — replaced by web dashboard + CLI

## [0.3.0] — 2026-02-20 — Quality Layer & Scheduling

### Added
- **Quality controller** with plan-level quality gates — block plan progression until score thresholds are met
- **SLA deadline monitor** — emits `sla:warning` and `sla:violated` events for tasks and plans approaching or exceeding deadlines
- **Cron-based plan scheduler** — recurring plan execution via cron expressions with `schedule:triggered`, `schedule:created`, and `schedule:completed` events
- Notification integration for quality and scheduling events
- `quality:gate` and `quality:sla` lifecycle hooks for before/after interception
- `schedule:trigger` lifecycle hook

## [0.2.0] — 2026-02-10 — Lifecycle Hooks & Operations

### Added
- **Lifecycle hook system** — 15 hook points across task, plan, assessment, quality, scheduling, and orchestrator events; before-hooks can cancel/modify, after-hooks are observe-only
- **Approval gates** — hybrid automatic (condition-based) and human (blocking) approval with configurable timeouts; `awaiting_approval` task state
- **Notification system** — channel-based routing (Slack, Telegram, Email, Webhook) with Markdown templates and event-driven dispatch
- **4-level escalation chain** — retry → reassign → notify → human intervention with `escalation:triggered`, `escalation:resolved`, and `escalation:human` events
- **Approval events** — `approval:requested`, `approval:resolved`, `approval:timeout`
- **SLA events** — `sla:warning`, `sla:violated`, `sla:met`
- File-based approval store (`FileApprovalStore`)
- Notification template engine with per-channel formatting

## [0.1.0] — 2026-01-30 — Initial Release

### Added
- Core orchestrator with 5-second supervisor loop, graceful shutdown, and orphan recovery
- Built-in engine (Pi Agent) with 7 coding tools, 18+ LLM providers, and MCP support
- SQLite-backed state persistence with WAL mode and crash resilience
- File and JSON store backends for tasks, runs, sessions, logs, and config
- Detached runner with RunStore for process management
- G-Eval assessment system with multi-evaluator consensus (median + outlier filtering)
- Plan executor with JSON-defined task groups and dependency resolution
- Deadlock detection and LLM-assisted resolution
- Question detection (heuristic + LLM classifier)
- 7-state task state machine (`pending`, `awaiting_approval`, `assigned`, `in_progress`, `review`, `done`, `failed`)
- 55+ typed events across 19 categories
- Hono HTTP API server with SSE and WebSocket streaming
- API key authentication with timing-safe comparison
- Zod runtime validation on all API endpoints
- Retry utility with exponential backoff and jitter for LLM calls
- CLI with `run`, `init`, `status`, and `serve` commands
- Ink-based TUI with Zustand state management
- React SDK with SSE-based hooks (`useTasks`, `usePlans`, `useAgents`, etc.)
- Vite + React web dashboard with shadcn/ui
- Mintlify documentation site
- MCP client manager with automatic tool bridging and server-name prefixing
- Filesystem sandbox (`allowedPaths`) and `safeEnv` secret stripping
- Skills system with project-level pool and per-agent symlinks
- Volatile teams for temporary specialist agents scoped to a single plan

### Security
- Timing-safe API key comparison (`crypto.timingSafeEqual`)
- Restrictive default CORS (localhost only)
- `safeEnv` strips API keys and secrets from subprocess environments
- No-eval condition DSL for approval gate expressions
- Internal error messages sanitized in HTTP responses
- Default server binding to `127.0.0.1` (localhost only)
- Claude SDK moved to optional dependencies
