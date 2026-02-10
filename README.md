# Orchestra

Agent-agnostic framework for orchestrating teams of AI coding agents.

Orchestra enables you to coordinate multiple AI agents (Claude, GPT-4, or any CLI-based agent) working together on complex software development tasks. Define plans in YAML, assign tasks to agents, and let Orchestra handle the coordination, monitoring, and assessment.

## Features

- 🤖 **Agent-Agnostic**: Works with Claude SDK, GPT-4, or any command-line agent
- 📋 **Plan-Based Orchestration**: Define multi-task plans in YAML
- 🔄 **Automatic Retry & Assessment**: Built-in G-Eval LLM-powered task assessment
- 💻 **Multiple Interfaces**: CLI, interactive TUI, HTTP API, React SDK, and Web UI
- 🔌 **Real-time Updates**: Server-Sent Events (SSE) and WebSocket support
- 💾 **Crash-Resilient**: SQLite-backed state with detached runner processes
- 🎯 **Deadlock Resolution**: AI-powered detection and resolution of agent deadlocks

## Prerequisites

- **Node.js**: v18 or higher
- **npm**: v8 or higher
- **API Keys**: Set `ANTHROPIC_API_KEY` environment variable if using Claude agents
- **TypeScript**: Installed automatically as a dependency

## Installation

```bash
# Clone the repository
git clone https://github.com/yourusername/orchestra.git
cd orchestra

# Install dependencies
npm install

# Build the project (IMPORTANT: use this exact command)
./node_modules/.bin/tsc

# Link the CLI globally (optional)
npm link
```

**Note**: Always use `./node_modules/.bin/tsc` to build, not `npx tsc`. The latter may pick up the wrong TypeScript package.

## Quick Start

### 1. Initialize a New Project

```bash
orchestra init
```

This creates an `orchestra.yml` configuration file in your current directory.

### 2. Edit Your Plan

Edit `orchestra.yml` to define your tasks:

```yaml
agents:
  - name: backend-dev
    adapter: claude-sdk
    description: Backend developer specializing in Node.js and databases

  - name: frontend-dev
    adapter: claude-sdk
    description: Frontend developer specializing in React and TypeScript

plans:
  - group: setup-project
    tasks:
      - title: Create database schema
        agent: backend-dev
        description: Design and implement SQLite database schema for users and posts

      - title: Build React UI components
        agent: frontend-dev
        description: Create reusable UI components using shadcn/ui
```

### 3. Run Your Plan

```bash
# Run in headless mode
orchestra run

# Run with interactive TUI
orchestra tui

# Run as HTTP server
orchestra serve --port 3890
```

## Usage Modes

### CLI Mode

Run plans non-interactively:

```bash
orchestra run [options]

Options:
  -c, --config <path>   Path to orchestra.yml (default: ./orchestra.yml)
  -p, --plan <group>    Run specific plan group
  --no-tui              Disable interactive mode
```

### TUI Mode

Interactive terminal interface with real-time monitoring:

```bash
orchestra tui
```

**TUI Features**:
- Tab 1: **Dashboard** - Overview of tasks, agents, and activity
- Tab 2: **Tasks** - Detailed task list with status
- Tab 3: **Plans** - Plan groups and progress
- Tab 4: **Agents** - Agent configuration and availability
- Tab 5: **Logs** - Real-time event log
- Tab 6: **Chat** - Send messages to agents or create new tasks

**TUI Commands**:
- `/help` - Show available commands
- `/team` - Create or manage agent teams (with AI generation)
- `/plan` - Create new plan from template or AI generation
- `/edit-plan` - Edit running plan (add/remove/reassign tasks)
- `/inspect` - Inspect agent session transcripts
- `@agent-name` - Mention an agent (appends to input)
- `#task-title` - Reference a task (appends to input)
- `%plan-group` - Reference a plan (appends to input)

### Server Mode

Run Orchestra as an HTTP API server:

```bash
orchestra serve [options]

Options:
  --port <number>       Port to listen on (default: 3890)
  --host <address>      Host to bind to (default: 0.0.0.0)
  --api-key <key>       Optional API key for authentication
```

The server provides:
- **REST API**: Manage projects, tasks, plans, agents
- **SSE Streaming**: Real-time events at `/api/v1/projects/:id/events`
- **WebSocket**: Real-time updates with event filtering
- **Multi-project**: Manage multiple Orchestra instances

### Web UI

A modern Next.js dashboard for Orchestra:

```bash
cd packages/web
npm install
npm run dev
```

Configure the server URL in `packages/web/.env.local`:

```env
NEXT_PUBLIC_ORCHESTRA_URL=http://localhost:3890
```

**Web UI Features**:
- Dashboard with live stats and agent activity
- Task management with detailed views
- Plan progress tracking
- Live event feed
- Chat interface with AI Elements

## Configuration Reference

### orchestra.yml Format

```yaml
# Agent Definitions
agents:
  - name: agent-name            # Unique identifier
    adapter: claude-sdk         # Adapter type: 'claude-sdk' or 'generic'
    description: Role desc      # Agent's role/expertise
    command: "aider --no-auto"  # (generic adapter only) CLI command
    volatile: false             # Auto-cleanup when plan completes

# Plan Groups
plans:
  - group: plan-group-name      # Unique plan identifier
    team:                        # Optional: volatile agents for this plan
      - name: temp-agent
        adapter: claude-sdk
        description: Temporary specialist
        volatile: true

    tasks:
      - title: Task title
        agent: agent-name        # Agent to assign
        description: Detailed task description
        dependencies: []         # Task IDs this depends on

        # Optional: Custom expectations for assessment
        expectations:
          - type: test
            command: npm test
            weight: 0.4

          - type: file_exists
            path: src/output.ts
            weight: 0.2

          - type: llm_review
            prompt: Check code quality
            weight: 0.4
            dimensions:          # Custom G-Eval dimensions
              - name: correctness
                weight: 0.4
                rubric: Code produces correct results
              - name: maintainability
                weight: 0.3
                rubric: Code is clean and maintainable
```

### Agent Adapters

**claude-sdk** (default):
- Uses `@anthropic-ai/claude-agent-sdk`
- Requires `ANTHROPIC_API_KEY` environment variable
- Persistent session tracking
- Automatic tool use handling

**generic**:
- Spawns any CLI command as subprocess
- Tracks real process PIDs
- Streams stdin/stdout
- Example: Aider, GPT-Engineer, custom scripts

### Environment Variables

```bash
# Required for Claude agents
ANTHROPIC_API_KEY=sk-ant-...

# Optional: customize orchestrator behavior
ORCHESTRATOR_MODEL=claude-sonnet-4-5-20250929  # Model for orchestrator LLM calls
ORCHESTRATOR_TEMPERATURE=0.7                    # Temperature for orchestrator

# Optional: server authentication
API_KEY=your-secret-key
```

### Assessment System

Orchestra uses **G-Eval** (LLM-as-judge) for task assessment:

**Default Dimensions**:
- `correctness` (35%): Task achieves stated goals
- `completeness` (30%): All requirements addressed
- `code_quality` (20%): Code is clean and maintainable
- `edge_cases` (15%): Edge cases handled properly

Each dimension is scored 1-5 with chain-of-thought reasoning. Tasks scoring below 3.0 are automatically retried with detailed feedback.

**Custom Assessment**:
```yaml
expectations:
  - type: llm_review
    threshold: 3.5           # Minimum passing score
    dimensions:
      - name: performance
        weight: 0.5
        rubric: Code is optimized for performance
      - name: security
        weight: 0.5
        rubric: No security vulnerabilities
```

## API Documentation

### REST Endpoints

Base URL: `http://localhost:3890/api/v1/projects/:projectId`

**Projects**:
- `GET /api/v1/projects` - List all projects
- `POST /api/v1/projects` - Create project
- `GET /api/v1/projects/:id` - Get project details

**Tasks**:
- `GET /tasks` - List all tasks
- `POST /tasks` - Create task
- `GET /tasks/:id` - Get task details
- `PATCH /tasks/:id` - Update task
- `POST /tasks/:id/retry` - Retry failed task

**Plans**:
- `GET /plans` - List all plans
- `POST /plans` - Create plan from YAML

**Agents**:
- `GET /agents` - List agents
- `POST /agents` - Register agent

**Events (SSE)**:
- `GET /events` - Server-Sent Events stream
- `GET /events?lastEventId=123` - Resume from event ID

**Chat**:
- `POST /chat` - Send message to agents

### Authentication

Include API key in header (if configured):

```bash
curl -H "X-API-Key: your-secret-key" http://localhost:3890/api/v1/projects
```

Or as query parameter for EventSource:

```javascript
const events = new EventSource('http://localhost:3890/api/v1/projects/abc/events?apiKey=your-key');
```

## React SDK

Type-safe React hooks for Orchestra:

```bash
npm install @orchestra/react-sdk
```

```tsx
import { OrchestraProvider, useTasks, useAgents } from '@orchestra/react-sdk';

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

  return (
    <div>
      <h1>Tasks: {tasks.length}</h1>
      <h1>Agents: {agents.length}</h1>
    </div>
  );
}
```

**Available Hooks**:
- `useOrchestra()` - Full state and methods
- `useTasks()` - All tasks with real-time updates
- `useTask(id)` - Single task
- `usePlans()` - All plans
- `useAgents()` - All agents
- `useProcesses()` - Running agent processes
- `useEvents()` - Event stream
- `useStats()` - Aggregate statistics

## Project Structure

```
orchestra/
├── src/
│   ├── core/           # Core types and interfaces
│   │   ├── types.ts    # Task, Agent, Plan types
│   │   ├── adapter.ts  # AgentAdapter interface
│   │   ├── events.ts   # TypedEmitter event definitions
│   │   └── schemas.ts  # Zod validation schemas
│   ├── adapters/       # Agent adapter implementations
│   │   ├── adapter-claude-sdk.ts
│   │   └── adapter-generic.ts
│   ├── orchestrator.ts # Main orchestrator logic
│   ├── runner.ts       # Detached agent runner process
│   ├── task-registry.ts # SQLite task persistence
│   ├── run-store.ts    # Agent process tracking
│   ├── assessment/     # Task assessment system
│   │   └── assessor.ts
│   ├── tui/            # Terminal UI
│   │   ├── index.ts
│   │   └── commands/
│   ├── server/         # HTTP API server
│   │   ├── app.ts
│   │   ├── sse-bridge.ts
│   │   ├── ws-bridge.ts
│   │   └── routes/
│   └── cli.ts          # Commander CLI
├── packages/
│   ├── react-sdk/      # React hooks and client
│   └── web/            # Next.js web dashboard
├── .orchestra/         # Runtime state (auto-created)
│   ├── state.db        # SQLite database
│   ├── logs/           # Agent logs
│   └── tmp/            # Temporary files
└── orchestra.yml       # Your configuration
```

## Troubleshooting

### Build Issues

**Problem**: `npx tsc` fails or uses wrong TypeScript version

**Solution**: Always use `./node_modules/.bin/tsc`

### SQLite Build Failures

**Problem**: `better-sqlite3` fails to compile

**Solution**: Install build tools
```bash
# Ubuntu/Debian
sudo apt-get install build-essential python3

# macOS
xcode-select --install

# Then rebuild
npm rebuild better-sqlite3
```

### Agent Connection Issues

**Problem**: Agents not responding or timing out

**Solution**: Check your API keys and adapter configuration
```bash
# Verify environment
echo $ANTHROPIC_API_KEY

# Check adapter logs
ls -la .orchestra/logs/

# Increase timeout in orchestra.yml
agents:
  - name: my-agent
    adapter: claude-sdk
    timeout: 300000  # 5 minutes
```

### State Reset

**Problem**: Corrupted state or need fresh start

**Solution**: Delete the state database
```bash
rm -rf .orchestra/state.db
orchestra run  # Will recreate
```

### Server Connection Issues

**Problem**: Web UI can't connect to server

**Solution**: Verify URLs match
```bash
# In terminal running server
orchestra serve --port 3890

# In packages/web/.env.local
NEXT_PUBLIC_ORCHESTRA_URL=http://localhost:3890
```

### Process Cleanup

**Problem**: Orphaned agent processes after crash

**Solution**: Orchestra auto-recovers on restart, or manually kill:
```bash
# Find orphaned processes
ps aux | grep orchestra

# Kill by PID
kill <pid>
```

## Architecture Overview

### State Machine

Tasks flow through states:
```
pending → assigned → in_progress → review → done/failed
                                         ↓
                                    failed → pending (retry)
```

### Crash Resilience

- **RunStore**: SQLite-backed process registry
- **Detached Runner**: Agent processes run independently
- **Orphan Recovery**: Reconnects to live processes or retries dead ones
- **Graceful Shutdown**: SIGTERM handlers ensure clean state

### Event System

Orchestra uses a typed event emitter with 35+ event types:
- `task:*` - Task lifecycle events
- `agent:*` - Agent status changes
- `plan:*` - Plan progress
- `system:*` - Orchestrator events

Events are streamed via SSE and consumed by TUI/Web UI.

## Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feat/my-feature`
3. Make your changes
4. Build: `./node_modules/.bin/tsc`
5. Test: `npm test` (if tests exist)
6. Commit: `git commit -m "feat: add my feature"`
7. Push: `git push origin feat/my-feature`
8. Open a Pull Request

### Development Setup

```bash
# Install dependencies
npm install

# Build in watch mode
./node_modules/.bin/tsc --watch

# Run locally
node dist/cli.js tui

# Build React SDK
npm run build:sdk

# Build Web UI
npm run build:web
```

## License

MIT

## Support

- Issues: https://github.com/yourusername/orchestra/issues
- Discussions: https://github.com/yourusername/orchestra/discussions
