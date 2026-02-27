# Polpo Web UI

Real-time monitoring dashboard for [OpenPolpo](../README.md) AI agent orchestration.

## Stack

Vite + React + TypeScript + Tailwind CSS + shadcn/ui

## Getting Started

```bash
pnpm install
pnpm dev       # Start dev server
pnpm build     # Production build
```

The UI connects to the Polpo server via SSE and REST API. Start the server first:

```bash
polpo serve    # Default: http://127.0.0.1:3000
```

## Pages

| Page       | Description                                    |
|------------|------------------------------------------------|
| Dashboard  | Overview with task stats, agent status, activity|
| Tasks      | Task list with state, assignment, and details  |
| Plans      | Plan groups, dependencies, and execution status|
| Agents     | Agent roster, online status, and workload      |
| Memory     | Shared agent memory entries                    |
| Logs       | Event log stream with filtering                |
| Chat       | Chat interface for agent interaction           |
| Activity   | Real-time activity feed                        |

## Architecture

Uses `@lumea-labs/polpo-react` hooks (`useTasks`, `useAgents`, `usePlans`, etc.) backed by SSE for push-based real-time updates. All data is read-only — the UI reflects the orchestrator's actual state.
