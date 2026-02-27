# AGENTS.md — Instructions for AI Coding Agents

This file contains instructions for AI coding agents working on the OpenPolpo codebase.

## Project Overview

OpenPolpo (`polpo` CLI) is an agent-agnostic framework for orchestrating teams of AI coding agents. It's a TypeScript/Node.js ESM project using pnpm workspaces.

## Repository Structure

```
polpo/
├── src/                  # Main TypeScript source (ESM)
│   ├── core/             # Orchestrator, config, runner, types, events, state machine
│   ├── adapters/         # Agent adapters (native, claude-sdk, generic)
│   ├── tools/            # Coding tools for the native engine
│   ├── assessment/       # G-Eval LLM-as-judge assessor
│   ├── stores/           # SQLite + file persistence backends
│   ├── llm/              # LLM query layer (multi-provider via pi-ai)
│   ├── tui/              # Terminal UI (Ink 5 + React 18)
│   ├── server/           # Hono HTTP API + SSE/WebSocket
│   ├── cli/              # Commander CLI entry point
│   └── index.ts          # Barrel export (only file in src/ root)
├── packages/
│   └── react-sdk/        # @lumea-labs/polpo-react — React hooks + SSE client
├── ui/                   # Vite + React SPA dashboard
├── docs/                 # Mintlify documentation site
└── templates/            # Built-in plan templates (JSON)
```

## Build Commands

```bash
# Install dependencies
pnpm install

# Build main package (IMPORTANT: use this exact command, NOT npx tsc)
./node_modules/.bin/tsc

# Build React SDK
pnpm --filter @lumea-labs/polpo-react build

# Build UI
pnpm --filter ui build

# Run tests
pnpm test
```

**Critical**: Always use `./node_modules/.bin/tsc` for the root build. `npx tsc` may resolve to the wrong TypeScript installation.

## Naming Conventions

- **User-facing strings**: "Polpo" or "OpenPolpo" (CLI output, docs, prompts)
- **npm package**: `@lumea-labs/polpo` (root), `@lumea-labs/polpo-react` (SDK)
- **CLI command**: `polpo`
- **Config directory**: `.polpo/`
- **Internal types**: `OrchestraConfig`, `OrchestraState`, `OrchestraEvent` (historical, kept as-is)
- **Class name**: `Orchestrator` (not "Polpo" internally)

**Danger**: Never do a global string replace of `.orchestra` — it will match `.orchestrator` and break imports.

## Key Technical Details

- **ESM only** — All imports use `.js` extensions (`import { foo } from "./bar.js"`)
- **Node >= 18** required
- **Config file**: `.polpo/polpo.json` — structure: `{ project, team: { name, agents: [] }, settings: {}, providers: {} }`
- **Task fields**: Use `assignTo` (NOT `agent`), `dependsOn` (NOT `dependencies`)
- **State machine**: `pending → assigned → in_progress → review → done/failed`
- **Default port**: 3000 for the HTTP server
- **Adapters self-register** via side-effect imports
- **tui-opentui/**: Excluded from tsc (Bun-only, compiled at runtime)

## Testing

```bash
pnpm test              # Run all tests with vitest
pnpm test -- --run     # Single run (no watch)
```

## What to Verify After Changes

1. **Always compile** after modifying any `.ts` file: `./node_modules/.bin/tsc`
2. If you changed server routes, regenerate OpenAPI spec: `pnpm run generate:openapi`
3. If you changed core types, check downstream: React SDK, server routes, TUI, CLI
4. If you changed config schema, update `docs/configuration.mdx`

## File Patterns

- Route files: `src/server/routes/*.ts`
- Store implementations: `src/stores/*.ts`
- Core interfaces: `src/core/types.ts`, `src/core/adapter.ts`
- CLI commands: `src/cli/index.ts`
- TUI components: `src/tui/components/`
- React SDK hooks: `packages/react-sdk/src/hooks/`
