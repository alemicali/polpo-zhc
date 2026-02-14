# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2025-02-14

### Added
- Core orchestrator with supervisor loop, graceful shutdown, and orphan recovery
- Adapter pattern: `claude-sdk` and `generic` adapters with self-registration
- SQLite-backed state persistence with WAL mode and crash resilience
- Detached runner with RunStore for process management
- G-Eval assessment system with multi-evaluator consensus (median + outlier filtering)
- Plan executor with YAML-defined task groups and dependency resolution
- Deadlock detection and LLM-assisted resolution
- Question detection (heuristic + LLM classifier)
- Hono HTTP API server with SSE and WebSocket streaming
- API key authentication with timing-safe comparison
- Zod runtime validation on all API endpoints
- Retry utility with exponential backoff and jitter for LLM calls
- CLI with `run`, `init`, `status`, `serve`, and `bridge` commands
- Ink-based TUI with Zustand state management
- React SDK with SSE-based hooks (`useTasks`, `usePlans`, `useAgents`, etc.)
- Next.js 15 web dashboard
- Astro documentation site

### Security
- Timing-safe API key comparison (`crypto.timingSafeEqual`)
- Restrictive default CORS (localhost only)
- Internal error messages sanitized in HTTP responses
- Claude SDK moved to optional dependencies
