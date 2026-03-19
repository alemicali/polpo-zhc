# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
