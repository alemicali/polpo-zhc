# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
