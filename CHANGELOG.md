# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
