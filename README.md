<p align="center"><img src="assets/logo.svg" width="200" /></p>

<pre align="center">
  ___                   ____       _
 / _ \ _ __   ___ _ __ |  _ \ ___ | |_ __   ___
| | | | '_ \ / _ \ '_ \| |_) / _ \| | '_ \ / _ \
| |_| | |_) |  __/ | | |  __/ (_) | | |_) | (_) |
 \___/| .__/ \___|_| |_|_|   \___/|_| .__/ \___/
      |_|                            |_|
</pre>

<p align="center">
  <strong>Agent-agnostic framework for orchestrating teams of AI coding agents.</strong>
</p>

<p align="center">
  <a href="#installation">Installation</a> &nbsp;&bull;&nbsp;
  <a href="#quick-start">Quick Start</a> &nbsp;&bull;&nbsp;
  <a href="#features">Features</a> &nbsp;&bull;&nbsp;
  <a href="#architecture">Architecture</a> &nbsp;&bull;&nbsp;
  <a href="#api">API</a> &nbsp;&bull;&nbsp;
  <a href="#packages">Packages</a>
</p>

<p align="center">
  <!-- badges -->
  <img alt="npm" src="https://img.shields.io/npm/v/openpolpo?style=flat-square&color=blue" />
  <img alt="license" src="https://img.shields.io/github/license/openpolpo/openpolpo?style=flat-square" />
  <img alt="node" src="https://img.shields.io/badge/node-%3E%3D18-brightgreen?style=flat-square" />
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-ESM-blue?style=flat-square" />
</p>

---

OpenPolpo coordinates multiple AI agents -- Claude, GPT-4, Codex, or any CLI-based agent -- working together on complex software development tasks. Define plans in YAML, assign tasks to specialized agents, and let Polpo handle coordination, monitoring, assessment, and recovery.

```
$ polpo

  ┌─ Dashboard ─────────────────────────────────┐
  │  Agents: 3 active    Tasks: 12/15 done      │
  │  Plans:  2 running   Failures: 0            │
  │                                              │
  │  > backend-dev    ██████████░░  in_progress  │
  │  > frontend-dev   ████████████  done         │
  │  > test-engineer  ██████░░░░░░  review       │
  └──────────────────────────────────────────────┘
```

## Installation

```bash
npm install -g openpolpo
```

That gives you the `polpo` CLI globally. Verify it works:

```bash
polpo --version
```

### From source

```bash
git clone https://github.com/openpolpo/openpolpo.git
cd openpolpo
npm install
./node_modules/.bin/tsc
npm link
```

> **Note:** Always build with `./node_modules/.bin/tsc`, not `npx tsc`. The latter can pick up the wrong TypeScript package.

## Quick Start

### 1. Initialize a project

```bash
polpo init
```

This creates a `polpo.yml` config file in your working directory.

### 2. Define your plan

```yaml
# polpo.yml

agents:
  - name: backend-dev
    adapter: claude-sdk
    description: Backend developer specializing in Node.js and databases

  - name: frontend-dev
    adapter: claude-sdk
    description: Frontend developer specializing in React and TypeScript

plans:
  - group: build-mvp
    tasks:
      - title: Create database schema
        agent: backend-dev
        description: Design and implement SQLite schema for users and posts

      - title: Build React components
        agent: frontend-dev
        description: Create reusable UI components with shadcn/ui
```

### 3. Run

```bash
# Interactive terminal UI
polpo

# Headless execution
polpo run

# HTTP API server
polpo serve --port 3890
```

## Features

### Multi-Agent Orchestration

Coordinate any number of agents working in parallel. Polpo manages task assignment, dependency resolution, and inter-agent communication.

```yaml
plans:
  - group: full-stack-app
    tasks:
      - title: Design API
        agent: backend-dev
      - title: Build UI
        agent: frontend-dev
        dependencies: [design-api]    # waits for API design to finish
      - title: Write tests
        agent: test-engineer
        dependencies: [design-api, build-ui]
```

### YAML-Driven Plans

Everything is defined in `polpo.yml`. Plans group related tasks, declare dependencies, and can include inline agent teams.

### Task Assessment (G-Eval LLM-as-Judge)

Every completed task goes through rubric-based assessment using chain-of-thought scoring across multiple dimensions:

| Dimension      | Weight | Description                        |
|----------------|--------|------------------------------------|
| Correctness    | 35%    | Task achieves its stated goals     |
| Completeness   | 30%    | All requirements are addressed     |
| Code Quality   | 20%    | Code is clean and maintainable     |
| Edge Cases     | 15%    | Edge cases are handled properly    |

Each dimension is scored 1--5. Tasks scoring below the threshold are automatically retried with per-dimension feedback. You can define custom dimensions and thresholds:

```yaml
expectations:
  - type: llm_review
    threshold: 3.5
    dimensions:
      - name: performance
        weight: 0.5
        rubric: Code is optimized for throughput
      - name: security
        weight: 0.5
        rubric: No injection vulnerabilities
```

### Volatile Teams & AI Team Generation

Spin up temporary specialist agents scoped to a single plan. Use the `/team` TUI command to let AI generate an optimal team composition:

```yaml
plans:
  - group: refactor-auth
    team:
      - name: security-specialist
        adapter: claude-sdk
        description: Expert in OAuth2 and JWT
        volatile: true    # cleaned up when plan completes
    tasks:
      - title: Audit auth flow
        agent: security-specialist
```

### Crash-Resilient Detached Runners

Agent processes run as detached subprocesses tracked in a SQLite-backed RunStore. If the orchestrator crashes:

- On restart, live processes are automatically reconnected
- Dead processes trigger task retry
- State is never lost -- everything is persisted to `state.db`

### Terminal UI (Ink)

The TUI provides real-time monitoring with tabs for Dashboard, Tasks, Plans, Agents, Logs, and Chat.

```
polpo
```

**TUI Commands:**

| Command        | Description                                    |
|----------------|------------------------------------------------|
| `/help`        | Show all available commands                    |
| `/team`        | Create or generate agent teams                 |
| `/plan`        | Create a plan from template or AI              |
| `/edit-plan`   | Add, remove, reassign, or retry tasks          |
| `/inspect`     | Read agent session transcripts                 |
| `@agent`       | Mention an agent                               |
| `#task`        | Reference a task                               |
| `%plan`        | Reference a plan group                         |

### HTTP API with SSE & WebSocket

Run Polpo as a server and integrate with any frontend or tool:

```bash
polpo serve --port 3890 --api-key my-secret
```

- REST API at `/api/v1/`
- Server-Sent Events for real-time streaming
- WebSocket with glob-based event filtering (`task:*`, `agent:*`)
- Multi-project support via `ProjectManager`

### Agent Adapters

Polpo is agent-agnostic. Two built-in adapters, and the interface is open for custom ones.

**`claude-sdk`** -- Uses `@anthropic-ai/claude-agent-sdk` with persistent sessions and automatic tool handling. Requires `ANTHROPIC_API_KEY`.

**`generic`** -- Spawns any CLI command as a subprocess with real PID tracking and stdin/stdout streaming. Works with Aider, GPT-Engineer, Codex CLI, or your own scripts.

```yaml
agents:
  - name: aider-agent
    adapter: generic
    command: "aider --no-auto-commits"
    description: Aider-powered coding agent
```

## Architecture

```
                         polpo.yml
                            │
                            v
                    ┌───────────────┐
                    │  Orchestrator  │
                    │   (2s tick)    │
                    └───────┬───────┘
                            │
              ┌─────────────┼─────────────┐
              v             v             v
        ┌──────────┐ ┌──────────┐ ┌──────────┐
        │  Runner   │ │  Runner   │ │  Runner   │
        │ (detached)│ │ (detached)│ │ (detached)│
        └─────┬────┘ └─────┬────┘ └─────┬────┘
              v             v             v
        Claude SDK    Generic CLI    Generic CLI
         Agent          Agent          Agent
```

### Task State Machine

```
pending ──> assigned ──> in_progress ──> review ──> done
                                           │
                                           v
                                        failed ──> pending (retry)
```

### Core Components

| Component         | File                     | Purpose                                       |
|-------------------|--------------------------|-----------------------------------------------|
| Orchestrator      | `src/orchestrator.ts`    | Supervisor loop, task assignment, health checks|
| Task Registry     | `src/task-registry.ts`   | SQLite-backed task persistence                 |
| Run Store         | `src/run-store.ts`       | Process tracking and crash recovery            |
| Runner            | `src/runner.ts`          | Detached agent subprocess                      |
| Assessor          | `src/assessment/assessor.ts` | G-Eval task scoring                        |
| Adapters          | `src/adapters/`          | Agent interface implementations                |
| TUI               | `src/tui/`               | Terminal UI (Ink)                               |
| Server            | `src/server/`            | Hono HTTP API, SSE bridge, WS bridge           |
| CLI               | `src/cli.ts`             | Commander entry point                          |

### Event System

Polpo uses a typed event emitter with 35+ event types organized by namespace:

```
task:created   task:assigned   task:started   task:completed   task:failed
agent:online   agent:offline   agent:activity
plan:started   plan:completed  plan:failed
system:tick    system:shutdown  system:error
```

Events are consumed by the TUI, streamed over SSE to the Web UI, and available via WebSocket with glob filters.

## API

Base URL: `http://localhost:3890/api/v1/projects/:projectId`

### Endpoints

```
GET    /api/v1/projects                  List projects
POST   /api/v1/projects                  Create project
GET    /api/v1/projects/:id              Get project

GET    /tasks                            List tasks
POST   /tasks                            Create task
GET    /tasks/:id                        Get task
PATCH  /tasks/:id                        Update task
POST   /tasks/:id/retry                  Retry failed task

GET    /plans                            List plans
POST   /plans                            Create plan (YAML body)

GET    /agents                           List agents
POST   /agents                           Register agent

GET    /events                           SSE stream
GET    /events?lastEventId=N             Resume from event ID

POST   /chat                             Send message to agents
```

### Authentication

```bash
# Header-based
curl -H "X-API-Key: your-key" http://localhost:3890/api/v1/projects

# Query param (for EventSource which can't send headers)
const es = new EventSource('/api/v1/projects/abc/events?apiKey=your-key');
```

## Packages

### React SDK (`packages/react-sdk/`)

Type-safe React hooks with zero runtime dependencies. Uses `useSyncExternalStore` for push-based SSE updates.

```bash
npm install @openpolpo/react-sdk
```

```tsx
import { OrchestraProvider, useTasks, useAgents } from '@openpolpo/react-sdk';

function App() {
  return (
    <OrchestraProvider
      baseURL="http://localhost:3890"
      projectId="my-project"
      apiKey="optional-key"
    >
      <Dashboard />
    </OrchestraProvider>
  );
}

function Dashboard() {
  const tasks = useTasks();
  const agents = useAgents();
  return <p>{tasks.length} tasks, {agents.length} agents</p>;
}
```

**Hooks:** `useOrchestra` `useTasks` `useTask` `usePlans` `usePlan` `useAgents` `useProcesses` `useEvents` `useStats` `useMemory` `useLogs`

### Web UI (`packages/web/`)

Next.js 15 dashboard with shadcn/ui. Pages for Dashboard, Tasks, Plans, Team, Logs, Chat, and Settings.

```bash
cd packages/web
npm install
npm run dev
```

Set the server URL in `packages/web/.env.local`:

```env
NEXT_PUBLIC_POLPO_URL=http://localhost:3890
```

## Configuration Reference

### `polpo.yml`

```yaml
# ─── Agents ──────────────────────────────────────────────

agents:
  - name: agent-name             # unique identifier
    adapter: claude-sdk           # 'claude-sdk' | 'generic'
    description: Role description # agent's expertise
    command: "aider --no-auto"    # (generic adapter only)
    volatile: false               # auto-cleanup on plan completion

# ─── Plans ───────────────────────────────────────────────

plans:
  - group: plan-name             # unique plan identifier
    team:                         # optional volatile agents
      - name: temp-agent
        adapter: claude-sdk
        description: Temporary specialist
        volatile: true

    tasks:
      - title: Task title
        agent: agent-name
        description: What the agent should do
        dependencies: []          # task IDs this depends on

        expectations:             # custom assessment criteria
          - type: test
            command: npm test
            weight: 0.4

          - type: file_exists
            path: src/output.ts
            weight: 0.2

          - type: llm_review
            prompt: Check code quality
            weight: 0.4
            dimensions:
              - name: correctness
                weight: 0.4
                rubric: Code produces correct results
              - name: maintainability
                weight: 0.3
                rubric: Code is clean and well-documented
```

### Environment Variables

```bash
ANTHROPIC_API_KEY=sk-ant-...                    # required for Claude agents
ORCHESTRATOR_MODEL=claude-sonnet-4-5-20250929   # model for orchestrator LLM calls
ORCHESTRATOR_TEMPERATURE=0.7                     # temperature for orchestrator
API_KEY=your-secret-key                          # server authentication
```

## Project Structure

```
openpolpo/
├── src/
│   ├── core/               # types, adapter interface, events, schemas
│   ├── adapters/            # claude-sdk and generic adapters
│   ├── assessment/          # G-Eval assessor
│   ├── tui/                 # terminal UI (Ink) + commands
│   ├── server/              # Hono HTTP API, SSE/WS bridges, routes
│   ├── orchestrator.ts      # main supervisor loop
│   ├── runner.ts            # detached agent runner
│   ├── task-registry.ts     # SQLite task persistence
│   ├── run-store.ts         # process tracking
│   └── cli.ts               # Commander CLI entry point
├── packages/
│   ├── react-sdk/           # React hooks + SSE client
│   └── web/                 # Next.js dashboard
├── .polpo/                  # runtime state (auto-created)
│   ├── state.db             # SQLite database
│   ├── logs/                # agent logs
│   └── tmp/                 # runner temp files
└── polpo.yml                # your configuration
```

## Troubleshooting

<details>
<summary><strong>Build fails with <code>npx tsc</code></strong></summary>

Always use `./node_modules/.bin/tsc` to build. `npx tsc` may resolve the wrong TypeScript package.

</details>

<details>
<summary><strong><code>better-sqlite3</code> won't compile</strong></summary>

Install native build tools:

```bash
# Ubuntu/Debian
sudo apt-get install build-essential python3

# macOS
xcode-select --install

# Then rebuild
npm rebuild better-sqlite3
```

</details>

<details>
<summary><strong>Orphaned agent processes after crash</strong></summary>

Polpo auto-recovers on restart. If you need to clean up manually:

```bash
ps aux | grep polpo
kill <pid>
```

</details>

<details>
<summary><strong>State reset</strong></summary>

Delete the runtime state directory and restart:

```bash
rm -rf .polpo/state.db
polpo run    # recreates automatically
```

</details>

<details>
<summary><strong>Web UI can't connect to server</strong></summary>

Make sure the URLs match:

```bash
polpo serve --port 3890

# packages/web/.env.local
NEXT_PUBLIC_POLPO_URL=http://localhost:3890
```

</details>

## Contributing

Contributions are welcome. Here's the workflow:

```bash
git clone https://github.com/openpolpo/openpolpo.git
cd openpolpo
npm install
./node_modules/.bin/tsc

# make your changes, then:
./node_modules/.bin/tsc          # build
npm test                          # test (if available)
git commit -m "feat: your change"
```

1. Fork the repository
2. Create a feature branch: `git checkout -b feat/my-feature`
3. Build and verify: `./node_modules/.bin/tsc`
4. Push and open a Pull Request

## License

MIT

---

<p align="center">
  <sub>Built with tentacles.</sub>
</p>
