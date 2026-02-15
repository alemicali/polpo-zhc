<p align="center"><img src="assets/logo.svg" width="200" /></p>

<pre align="center">
██████╗  ██████╗ ██╗     ██████╗  ██████╗
██╔══██╗██╔═══██╗██║     ██╔══██╗██╔═══██╗
██████╔╝██║   ██║██║     ██████╔╝██║   ██║
██╔═══╝ ██║   ██║██║     ██╔═══╝ ██║   ██║
██║     ╚██████╔╝███████╗██║     ╚██████╔╝
╚═╝      ╚═════╝ ╚══════╝╚═╝      ╚═════╝
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

OpenPolpo coordinates multiple AI agents working together on complex software development tasks. Define plans in JSON, assign tasks to specialized agents, and let Polpo handle coordination, monitoring, assessment, and recovery.

When no external adapter is specified, Polpo uses its built-in engine (Pi Agent) -- a full agentic loop with 7 coding tools, 18+ LLM providers, and MCP support. The `claude-sdk` adapter is available for Claude Agent SDK integration.

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
pnpm install
pnpm run build
```

## Quick Start

### 1. Initialize a project

```bash
polpo init
```

This creates a `.polpo/` directory with a `polpo.json` config file.

### 2. Define your agents and plan

```json
{
  "agents": [
    {
      "name": "backend-dev",
      "adapter": "claude-sdk",
      "description": "Backend developer specializing in Node.js and databases"
    },
    {
      "name": "frontend-dev",
      "description": "Frontend developer specializing in React and TypeScript"
    }
  ],
  "plans": [
    {
      "group": "build-mvp",
      "tasks": [
        {
          "title": "Create database schema",
          "assignTo": "backend-dev",
          "description": "Design and implement SQLite schema for users and posts"
        },
        {
          "title": "Build React components",
          "assignTo": "frontend-dev",
          "description": "Create reusable UI components with shadcn/ui"
        }
      ]
    }
  ]
}
```

> When `adapter` is omitted, the built-in engine (Pi Agent) is used automatically.

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

```json
{
  "group": "full-stack-app",
  "tasks": [
    { "title": "Design API", "assignTo": "backend-dev" },
    { "title": "Build UI", "assignTo": "frontend-dev", "dependsOn": ["Design API"] },
    { "title": "Write tests", "assignTo": "test-engineer", "dependsOn": ["Design API", "Build UI"] }
  ]
}
```

### Built-in Engine (Pi Agent)

When no adapter is specified, Polpo runs agents using its built-in engine powered by Pi Agent:

- **7 coding tools**: `read`, `write`, `edit`, `bash`, `glob`, `grep`, `ls`
- **18+ LLM providers** via `@mariozechner/pi-ai`
- **MCP support**: connect external tool servers to any agent
- **Filesystem sandbox**: restrict agent file access via `allowedPaths`
- Dynamic tool updates at runtime via `Agent.setTools()`

### MCP (Model Context Protocol) Support

Connect external MCP servers to agents for extended tool capabilities:

```json
{
  "name": "dev-agent",
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/project"]
    },
    "github": {
      "url": "https://mcp.github.com",
      "type": "http"
    }
  }
}
```

MCP tools are automatically bridged to the agent's tool set with server-name prefixing to prevent collisions.

### Filesystem Sandbox

Restrict which directories an agent can access:

```json
{
  "name": "backend-dev",
  "allowedPaths": ["/project/src", "/project/tests"]
}
```

Path validation uses separator-aware prefix matching. Defaults to the working directory when omitted. The `bash` tool is not sandboxed (agents can run arbitrary shell commands).

### Skills System

Polpo-native skills system for reusable agent instructions:

- **Project pool**: `.polpo/skills/` -- available to all agents
- **Per-agent skills**: `.polpo/agents/<name>/skills/` -- symlinks to the project pool
- Skills are injected into agent system prompts automatically

### Task Assessment (G-Eval LLM-as-Judge)

Every completed task goes through rubric-based assessment using chain-of-thought scoring across multiple dimensions:

| Dimension      | Weight | Description                        |
|----------------|--------|------------------------------------|
| Correctness    | 35%    | Task achieves its stated goals     |
| Completeness   | 30%    | All requirements are addressed     |
| Code Quality   | 20%    | Code is clean and maintainable     |
| Edge Cases     | 15%    | Edge cases are handled properly    |

Each dimension is scored 1--5. Tasks scoring below the threshold are automatically retried with per-dimension feedback. You can define custom dimensions and thresholds:

```json
{
  "expectations": [
    {
      "type": "llm_review",
      "threshold": 3.5,
      "dimensions": [
        { "name": "performance", "weight": 0.5, "rubric": "Code is optimized for throughput" },
        { "name": "security", "weight": 0.5, "rubric": "No injection vulnerabilities" }
      ]
    }
  ]
}
```

### Volatile Teams & AI Team Generation

Spin up temporary specialist agents scoped to a single plan. Use the `/team` TUI command to let AI generate an optimal team composition:

```json
{
  "group": "refactor-auth",
  "team": [
    {
      "name": "security-specialist",
      "adapter": "claude-sdk",
      "description": "Expert in OAuth2 and JWT",
      "volatile": true
    }
  ],
  "tasks": [
    { "title": "Audit auth flow", "assignTo": "security-specialist" }
  ]
}
```

### Lifecycle Hooks

Register before/after hooks on key lifecycle events to modify behavior, enforce gates, or observe operations:

- **Hook points**: `task:create`, `task:spawn`, `task:transition`, `task:complete`, `task:fail`, `task:retry`, `plan:execute`, `plan:complete`, `assessment:run`, `assessment:complete`, `orchestrator:tick`, `orchestrator:shutdown`
- **Before hooks** can cancel or modify the operation
- **After hooks** are observe-only (fire-and-forget)
- Priority-ordered sequential execution

### Crash-Resilient Detached Runners

Agent processes run as detached subprocesses tracked in a SQLite-backed RunStore. If the orchestrator crashes:

- On restart, live processes are automatically reconnected
- Dead processes trigger task retry
- State is never lost -- everything is persisted to `state.db`

### Terminal UI (Ink)

The TUI provides real-time monitoring with tabs for Dashboard, Tasks, Plans, Agents, Logs, and Chat.

```bash
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

Polpo is agent-agnostic. When `adapter` is omitted from an agent config, the **built-in engine** (Pi Agent) is used. The `claude-sdk` adapter is available for Claude Agent SDK integration.

**Built-in engine** (default) -- Full agentic loop with 7 coding tools, 18+ LLM providers, MCP support, and filesystem sandbox. No external process needed.

**`claude-sdk`** -- Uses `@anthropic-ai/claude-agent-sdk` with persistent sessions and automatic tool handling. Requires `ANTHROPIC_API_KEY`. MCP server configs are passed through natively.

## Architecture

```
                       polpo.json
                           |
                           v
                   ┌───────────────┐
                   │  Orchestrator  │
                   │   (2s tick)    │
                   └───────┬───────┘
                           |
             ┌─────────────┼─────────────┐
             v             v             v
       ┌──────────┐ ┌──────────┐ ┌──────────┐
       │  Runner   │ │  Runner   │ │  Runner   │
       │ (detached)│ │ (detached)│ │ (detached)│
       └─────┬────┘ └─────┬────┘ └─────┬────┘
             v             v             v
       Built-in       Claude SDK    Built-in
        Engine          Adapter      Engine
```

### Task State Machine

```
                      ┌───────────────────┐
                      v                   |
pending ──> awaiting_approval ──> assigned ──> in_progress ──> review ──> done
                |                                               |
                v                                               v
              failed <──────────────────────────────────────  failed
                |
                v
             pending (retry)
```

### Core Components

| Component            | Location                          | Purpose                                       |
|----------------------|-----------------------------------|-----------------------------------------------|
| Orchestrator         | `src/core/orchestrator.ts`        | Supervisor loop, task assignment, health checks|
| Config               | `src/core/config.ts`              | JSON config parser and validation              |
| Task Manager         | `src/core/task-manager.ts`        | Task CRUD, state transitions, lifecycle hooks  |
| Plan Executor        | `src/core/plan-executor.ts`       | Plan execution, group management               |
| Assessment           | `src/core/assessment-orchestrator.ts` | Task assessment, retry logic, fix phase    |
| Hooks                | `src/core/hooks.ts`               | Lifecycle hook registry (before/after)         |
| State Machine        | `src/core/state-machine.ts`       | Task status transitions and validation         |
| Stores               | `src/stores/`                     | SQLite task, run, config, log persistence      |
| Assessor             | `src/assessment/assessor.ts`      | G-Eval task scoring                            |
| Coding Tools         | `src/tools/coding-tools.ts`       | 7 built-in file/shell tools with sandbox       |
| Path Sandbox         | `src/tools/path-sandbox.ts`       | Filesystem path validation                     |
| MCP Client           | `src/mcp/client.ts`               | MCP server connection and tool bridging        |
| Built-in Engine      | `src/adapters/engine.ts`          | Pi Agent integration with MCP + sandbox        |
| Claude SDK Adapter   | `src/adapters/claude-sdk.ts`      | Claude Agent SDK integration                   |
| TUI                  | `src/tui/`                        | Terminal UI (Ink)                               |
| Server               | `src/server/`                     | Hono HTTP API, SSE bridge, WS bridge           |
| CLI                  | `src/cli/`                        | Commander entry point                          |

### Event System

Polpo uses a typed event emitter with 35+ event types organized by namespace:

```
task:created   task:assigned   task:started   task:completed   task:failed
agent:online   agent:offline   agent:activity
plan:started   plan:completed  plan:failed
approval:requested  approval:resolved  approval:timeout
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
POST   /plans                            Create plan (JSON body)

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
# const es = new EventSource('/api/v1/projects/abc/events?apiKey=your-key');
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

### Web UI (`ui/`)

Vite + React monitoring dashboard with shadcn/ui. Read-only view into the framework's actual state -- tasks, plans, agents, activity, logs, memory, and chat.

```bash
cd ui
pnpm install
pnpm run dev
```

The UI connects to the Polpo server at `http://localhost:3890`.

### Documentation (`apps/docs/`)

Astro-powered documentation site with Starlight.

```bash
cd apps/docs
npm install
npm run dev
```

## Configuration Reference

### `polpo.json`

```json
{
  "agents": [
    {
      "name": "agent-name",
      "adapter": "claude-sdk",
      "description": "Role description",
      "volatile": false,
      "allowedPaths": ["/project/src"],
      "mcpServers": {
        "server-name": {
          "command": "npx",
          "args": ["-y", "mcp-server"]
        }
      }
    }
  ],
  "plans": [
    {
      "group": "plan-name",
      "team": [
        {
          "name": "temp-agent",
          "description": "Temporary specialist",
          "volatile": true
        }
      ],
      "tasks": [
        {
          "title": "Task title",
          "assignTo": "agent-name",
          "description": "What the agent should do",
          "dependsOn": [],
          "expectations": [
            { "type": "test", "command": "npm test", "weight": 0.4 },
            { "type": "file_exists", "path": "src/output.ts", "weight": 0.2 },
            {
              "type": "llm_review",
              "prompt": "Check code quality",
              "weight": 0.4,
              "dimensions": [
                { "name": "correctness", "weight": 0.4, "rubric": "Code produces correct results" },
                { "name": "maintainability", "weight": 0.3, "rubric": "Code is clean and well-documented" }
              ]
            }
          ]
        }
      ]
    }
  ],
  "settings": {
    "maxRetries": 3,
    "maxConcurrency": 4,
    "logLevel": "info"
  }
}
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
│   ├── core/               # orchestrator, config, types, events, hooks, state machine
│   ├── adapters/            # built-in engine + claude-sdk adapter
│   ├── assessment/          # G-Eval assessor and scoring
│   ├── tools/               # 7 coding tools + path sandbox
│   ├── mcp/                 # MCP client manager and tool bridging
│   ├── stores/              # SQLite task, run, config, log persistence
│   ├── llm/                 # LLM queries, prompts, plan generation, skills
│   ├── tui/                 # terminal UI (Ink) + commands
│   ├── server/              # Hono HTTP API, SSE/WS bridges, routes
│   ├── cli/                 # Commander CLI entry point
│   └── index.ts             # barrel exports
├── ui/                      # Vite + React monitoring dashboard
├── apps/
│   └── docs/                # Astro documentation site
├── packages/
│   └── react-sdk/           # React hooks + SSE client
├── assets/
│   └── logo.svg             # project logo
├── .polpo/                  # runtime state (auto-created)
│   ├── state.db             # SQLite database
│   ├── skills/              # project-level skill pool
│   ├── agents/              # per-agent skill symlinks
│   ├── logs/                # agent logs
│   └── tmp/                 # runner temp files
└── polpo.json               # your configuration
```

## Troubleshooting

<details>
<summary><strong><code>better-sqlite3</code> won't compile</strong></summary>

Install native build tools:

```bash
# Ubuntu/Debian
sudo apt-get install build-essential python3

# macOS
xcode-select --install

# Then rebuild
pnpm rebuild better-sqlite3
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

Make sure the Polpo server is running:

```bash
polpo serve --port 3890
```

The UI at `ui/` connects to `http://localhost:3890` by default.

</details>

## Contributing

Contributions are welcome. Here's the workflow:

```bash
git clone https://github.com/openpolpo/openpolpo.git
cd openpolpo
pnpm install
pnpm run build
pnpm run test -- --run
```

1. Fork the repository
2. Create a feature branch: `git checkout -b feat/my-feature`
3. Build and test: `pnpm run build && pnpm run test -- --run`
4. Push and open a Pull Request

## License

MIT

---

<p align="center">
  <sub>Built with tentacles.</sub>
</p>
