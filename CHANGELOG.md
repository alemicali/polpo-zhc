# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **The agent card, an MCP App:** in Claude, ChatGPT and other hosts that show [MCP Apps](https://modelcontextprotocol.io/extensions/apps/overview), the `show_agent` tool shows an interactive card in the conversation; other clients get the same as text.
  - **Inline:** whether the agent is working, the task at hand, today (done, failed, waiting for a person), what it plans next and its main goal with its progress. Two actions: **Open** (full screen) and **Ask for an update** (a chat message, so the model talks to the agent).
  - **Full screen:** tabs for overview (self-portrait, goals, latest reflections), tasks (with filters), goals (the tree with progress) and routine, where the agent's proposals are confirmed or cancelled. The tab in view goes to the model's context.
  - **Native look:** the host's style variables (light and dark, its font), a transparent background, skeletons while loading, safe areas and 44px targets on mobile, no menus or inline scrolling.
  - **One live card per agent:** when the card is shown again in a conversation, older copies grey out.
  - **Self-contained:** the widget (`widgets/agent-card`, built with the MCP Apps SDK into one HTML document by `pnpm run build:widgets`) loads nothing from other origins. Its refresh and decide tools are visible only to it.

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
