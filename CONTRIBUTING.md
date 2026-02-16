# Contributing to OpenPolpo

Thanks for your interest in contributing to OpenPolpo! This guide will help you get started.

## Code of Conduct

Be respectful. We're building something fun and useful together. Harassment, trolling, or any form of discrimination will not be tolerated. Use good judgment — if you wouldn't say it at a friendly meetup, don't say it here.

## Getting Started

### Prerequisites

- **Node.js** >= 18
- **pnpm** (recommended) or npm
- **Git**

### Setup

```bash
# Fork the repository on GitHub, then:
git clone https://github.com/<your-username>/openpolpo.git
cd openpolpo
pnpm install
```

### Build

```bash
pnpm run build
```

This compiles the TypeScript source in `src/` to `dist/`.

### Test

```bash
pnpm run test -- --run
```

All 589+ tests must pass before submitting a PR. The test suite runs in ~7 seconds.

### Documentation Site

```bash
cd apps/docs
pnpm run dev      # Dev server on localhost:4321
pnpm run build    # Production build (verify 0 errors)
```

## Project Structure

```
openpolpo/
├── src/                    # Core TypeScript source
│   ├── core/               # Orchestrator, types, events, hooks, state machine
│   ├── adapters/           # Agent runtime adapters
│   ├── assessment/         # G-Eval assessor and scoring
│   ├── quality/            # Quality controller, SLA monitor
│   ├── scheduling/         # Cron parser, plan scheduler
│   ├── notifications/      # Notification router + channels
│   ├── tools/              # Agent tools (coding, browser, git, etc.)
│   ├── mcp/                # MCP client manager
│   ├── stores/             # File, JSON, SQLite persistence
│   ├── llm/                # LLM queries and prompts
│   ├── tui/                # Terminal UI (Ink)
│   ├── server/             # HTTP API (Hono), SSE, WebSocket
│   ├── bridge/             # Passive session discovery
│   └── cli/                # CLI entry point
├── ui/                     # Web monitoring dashboard (Vite + React)
├── apps/docs/              # Documentation site (Astro + Starlight)
├── packages/react-sdk/     # React hooks + SSE client
└── polpo.json              # Example project configuration
```

## How to Contribute

### Reporting Bugs

Open a [GitHub Issue](https://github.com/openpolpo/openpolpo/issues/new) with:

1. **What happened** — describe the bug clearly
2. **What you expected** — what should have happened instead
3. **Steps to reproduce** — minimal config/commands to trigger the bug
4. **Environment** — Node version, OS, OpenPolpo version (`polpo --version`)

### Suggesting Features

Open a [GitHub Issue](https://github.com/openpolpo/openpolpo/issues/new) with the `enhancement` label. Describe the use case, not just the solution. We're open to ideas but want to keep the core focused.

### Submitting Pull Requests

1. **Fork** the repository and create a branch from `develop`:
   ```bash
   git checkout develop
   git checkout -b feat/my-feature
   ```

2. **Write code.** Follow the existing style — TypeScript, ESM imports, no default exports in core modules.

3. **Add tests** if you're adding new functionality. We use [Vitest](https://vitest.dev/).

4. **Verify everything passes:**
   ```bash
   pnpm run build          # TypeScript must compile clean
   pnpm run test -- --run  # All tests must pass
   ```

5. **Write a clear commit message:**
   ```
   feat: add webhook retry with exponential backoff
   fix: prevent deadlock when all dependencies fail
   docs: update approval gates with revise flow
   ```
   We loosely follow [Conventional Commits](https://www.conventionalcommits.org/).

6. **Open a Pull Request** against `develop` (not `main`). Describe what you changed and why.

### What Makes a Good PR

- **Focused** — one feature or fix per PR. Don't mix refactoring with new features.
- **Tested** — new code has tests, existing tests still pass.
- **Documented** — if you add a public API, config option, or event, update the docs in `apps/docs/`.
- **Backwards-compatible** — don't break existing configs. New features should be opt-in.

## Coding Standards

### TypeScript

- Strict mode (`"strict": true` in tsconfig)
- ESM only (`"type": "module"` — use `.js` extensions in imports)
- No `any` unless absolutely necessary (and document why)
- Prefer `interface` over `type` for object shapes
- Use `readonly` for immutable properties

### Naming

- **Types/interfaces**: PascalCase with `Polpo` prefix for public exports (`PolpoConfig`, `PolpoEvent`)
- **Internal classes**: PascalCase without prefix (`Orchestrator`, `TaskManager`)
- **Functions/variables**: camelCase
- **Events**: `category:action` format (`task:created`, `approval:revised`)
- **Config keys**: camelCase (`maxRetries`, `approvalGates`)

### Testing

- Test files live next to source in `src/__tests__/`
- Name tests descriptively: `it("transitions task to assigned when approved")`
- Use the existing test helpers in `src/__tests__/fixtures.ts`
- Don't test implementation details — test behavior

### Documentation

- Docs are in `apps/docs/src/content/docs/` as `.mdx` files
- All config examples use **JSON** (never YAML)
- All code samples must be accurate and tested
- Keep numbers accurate (event count, tool count, hook count)

## Architecture Decisions

Before making significant architectural changes, please open an issue to discuss. Key principles:

- **Everything is opt-in** — no breaking changes to existing configs
- **Config is JSON** — `.polpo/polpo.json`, never YAML
- **Events are the backbone** — the `TypedEmitter` drives everything: TUI, SSE, WebSocket, notifications, logging
- **Managers are decomposed** — each concern (tasks, agents, approvals, escalation, quality, SLA, scheduling) has its own manager class with a shared `OrchestratorContext`
- **Adapters are pluggable** — the built-in engine is one adapter among many

## Release Process

Releases are managed by maintainers. We follow semver:

- **Patch** (0.x.Y): bug fixes, doc updates
- **Minor** (0.X.0): new features, new events, new config options
- **Major** (X.0.0): breaking changes (we try to avoid these)

## Questions?

Open a [Discussion](https://github.com/openpolpo/openpolpo/discussions) or reach out in issues. We're friendly.

---

Thanks for contributing!
