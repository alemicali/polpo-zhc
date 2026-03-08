<p align="center">
  <img src="docs/polpo-banner.png" alt="Polpo — your AI agent that runs the team" width="680" />
</p>

<p align="center">
  <strong>An octopus AI agent that wrangles other agents into reliable teams.</strong><br/>
  <sub>Builds and runs your personal assistant or your whole AI team — ensures quality, pings you only when it matters.</sub>
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> &bull;
  <a href="#features">Features</a> &bull;
  <a href="#architecture">Architecture</a> &bull;
  <a href="#project-structure">Project Structure</a> &bull;
  <a href="https://polpo.sh">Docs</a>
</p>

<p align="center">
  <img alt="npm" src="https://img.shields.io/npm/v/polpo-ai?style=flat-square&color=blue" />
  <img alt="license" src="https://img.shields.io/github/license/lumea-labs/polpo?style=flat-square" />
  <img alt="node" src="https://img.shields.io/badge/node-%3E%3D18-brightgreen?style=flat-square" />
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-ESM-blue?style=flat-square" />
</p>

---

## Why Polpo?

AI agents are great at execution. They're terrible at finishing complex tasks autonomously. Without oversight they drift, conflict, and stall — and nobody tells you until it's too late. You end up babysitting the machines that were supposed to save you time.

**Polpo fixes this.** Eight arms, infinite patience, and a Telegram account. You talk to Polpo like you'd talk to a project manager — describe what you need, and it assembles the right agents, plans the work, checks every result, retries what's broken, and escalates what it can't fix. You define the goal, Polpo makes sure it actually gets done.

**Who is it for?** Anyone who wants a personal AI team on their laptop, a $5 VPS, or a Docker container in their cloud. Tell Polpo to build an app, run a virtual AI company, or automate your workflows — and it handles the rest. One `npm install` and you're chatting. No hosted platform, no vendor lock-in — your hardware, your API keys, your rules.

### What's different

- **Lives its own life.** Polpo builds missions, picks agents, and works through queued tasks on its own — 24/7 if you need it. Describe what you need and walk away.
- **Reliable output, not best-effort.** Polpo scores every task with LLM judges. Below threshold? It sends the agent back to fix it. You get the result, not the retries.
- **Crash-proof.** Agents run as detached processes. Kill Polpo, reboot the server, lose your connection — it picks up exactly where it left off.
- **Proactive, not a chatbot.** You decide how and when Polpo should reach you — Slack, email, Telegram, webhooks — and it only does when it matters.

## Installation

### One-line install (recommended)

**macOS / Linux / WSL:**

```bash
curl -fsSL https://raw.githubusercontent.com/lumea-labs/polpo/main/install/install.sh | bash
```

**Windows (PowerShell):**

```powershell
irm https://raw.githubusercontent.com/lumea-labs/polpo/main/install/install.ps1 | iex
```

The installer detects your platform, ensures Node.js >= 18 is available (installing it via your system package manager if needed), and installs `polpo-ai` globally.

### Manual install

```bash
npm install -g polpo-ai    # or: pnpm add -g polpo-ai
```

### Docker

```bash
docker run -it -p 3000:3000 -v $(pwd):/workspace lumea-labs/polpo
```

## Quick Start

### Path 1: Chat with an agent (30 seconds)

```bash
mkdir my-project && cd my-project
polpo init
polpo
```

That's it. You're in the interactive TUI. Type what you need, hit Enter, and the agent does it.

### Path 2: Orchestrate a team (5 minutes)

**1. Init your project**

```bash
mkdir my-project && cd my-project
polpo init
```

**2. Configure your team** in `.polpo/polpo.json`:

```json
{
  "project": "my-project",
  "team": {
    "name": "default",
    "agents": [
      {
        "name": "backend-dev",
        "role": "Backend developer specializing in Node.js and databases"
      },
      {
        "name": "frontend-dev",
        "role": "Frontend developer specializing in React and TypeScript"
      }
    ]
  },
  "settings": {
    "maxRetries": 3,
    "workDir": ".",
    "logLevel": "normal"
  }
}
```

**3. Create a plan**

```bash
polpo plan create "Build a REST API with SQLite database and Express endpoints"
```

Polpo uses AI to generate a plan with tasks, dependencies, and agent assignments. Review it, then:

**4. Execute**

```bash
polpo run
```

Polpo assigns tasks to agents, respects dependencies, scores every result with LLM judges, retries what fails, and reports when it's done.

**5. Monitor** (optional)

```bash
polpo status -w    # Live dashboard in another terminal
polpo serve        # HTTP API + Web UI at http://localhost:3000
```

## Features

### Core

- **Multi-agent orchestration** — coordinate any number of agents with plan-based task execution, dependency resolution, and inter-agent communication
- **7 task states** — `pending` → `awaiting_approval` → `assigned` → `in_progress` → `review` → `done` / `failed`, with validated transitions
- **8-phase assessment pipeline** — G-Eval LLM-as-judge scoring across configurable dimensions (correctness, completeness, code quality, edge cases)
- **Crash-resilient runners** — detached agent subprocesses tracked in a persistent RunStore; automatic reconnection on restart
- **Deadlock detection** — identifies circular dependencies and uses LLM-assisted resolution

### Quality & Operations

- **15 lifecycle hooks** — `before`/`after` hooks on task, plan, assessment, quality, scheduling, and orchestrator events; before-hooks can cancel or modify operations
- **Approval gates** — hybrid auto/human gates; automatic condition evaluation or blocking for human review with configurable timeouts
- **Notification system** — Slack, Telegram, Email, and Webhook channels with template-based routing
- **4-level escalation chain** — automatic escalation from retry → reassign → notify → human intervention
- **Quality gates** — plan-level quality checkpoints that block progression until score thresholds are met
- **SLA deadline monitoring** — warning and violation events for task and plan deadlines
- **Cron-based plan scheduling** — recurring plan execution via cron expressions

### Interfaces

- **REST API** — Hono-based HTTP server with Zod-validated endpoints
- **SSE** — real-time event streaming with reconnection support
- **Terminal UI** — Ink-based TUI with Dashboard, Tasks, Plans, Agents, Logs, and Chat tabs
- **Web UI** — Vite + React monitoring dashboard with shadcn/ui (see `ui/`)
- **React SDK** — type-safe hooks with SSE-backed push updates (see `packages/react-sdk/`)

### Developer Experience

- **Multiple store backends** — File (default), SQLite, and PostgreSQL for tasks, runs, sessions, and logs
- **MCP support** — connect external tool servers to any agent with automatic tool bridging
- **Filesystem sandbox** — restrict agent file access via `allowedPaths`
- **Skills system** — reusable agent instructions in `.polpo/skills/`, auto-injected into system prompts
- **55+ typed events** — organized across 19 categories, consumed by TUI, SSE, and notifications
- **Security** — `safeEnv` strips secrets from subprocesses, no-eval condition DSL, localhost-only default binding

## Architecture

```
                       polpo.json
                           |
                           v
                   ┌───────────────┐
                   │  Orchestrator  │
                   │   (5s tick)    │
                   └───────┬───────┘
                           |
             ┌─────────────┼─────────────┐
             v             v             v
       ┌──────────┐ ┌──────────┐ ┌──────────┐
       │  Runner   │ │  Runner   │ │  Runner   │
       │ (detached)│ │ (detached)│ │ (detached)│
       └─────┬────┘ └─────┬────┘ └─────┬────┘
             v             v             v
        Built-in      Built-in      Built-in
         Engine         Engine        Engine
```

The orchestrator runs a supervisor loop every 5 seconds, assigning pending tasks to agents, monitoring health, and driving the assessment pipeline.

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

Seven states with validated transitions. Tasks flow forward through assignment, execution, and review. Failed tasks can be retried back to `pending`. Approval gates optionally intercept the `pending → assigned` transition.

## Project Structure

```
polpo/
├── src/
│   ├── core/               # Orchestrator, config, types, events, hooks, state machine
│   │                       #   approval manager, escalation, task/plan managers
│   ├── adapters/           # Built-in engine (Pi Agent)
│   ├── assessment/         # G-Eval assessor, scoring dimensions, fix phase
│   ├── quality/            # Quality controller, SLA monitor
│   ├── scheduling/         # Cron parser, plan scheduler
│   ├── notifications/      # Notification router + channels (Slack, Telegram, Email, Webhook)
│   ├── tools/              # 7 coding tools, path sandbox, safeEnv
│   ├── mcp/                # MCP client manager and tool bridging
│   ├── stores/             # File stores (tasks, runs, sessions, logs, config)
│   ├── llm/                # LLM queries, prompts, plan generation, skills
│   ├── tui/                # Terminal UI (Ink) + TUI commands
│   ├── server/             # Hono HTTP API, SSE bridge, routes
│   ├── cli/                # Commander CLI entry point + subcommands
│   └── index.ts            # Barrel exports
├── ui/                     # Vite + React monitoring dashboard
├── docs/                   # Mintlify documentation site
├── packages/
│   ├── core/               # @polpo-ai/core — pure business logic (zero Node.js deps)
│   ├── drizzle/            # @polpo-ai/drizzle — Drizzle ORM stores (SQLite + PostgreSQL)
│   ├── client-sdk/         # @polpo-ai/client — TypeScript HTTP client + SSE
│   └── react-sdk/          # @polpo-ai/react — React hooks + real-time updates
└── .polpo/polpo.json       # Your project configuration
```

## Documentation

Full documentation is available at [polpo.sh](https://polpo.sh), including:

- Configuration reference (`polpo.json` schema)
- API endpoint documentation
- Built-in engine guide
- Assessment and quality pipeline details
- Notification and escalation setup
- Hook and event reference

## Contributing

We welcome contributions! See [CONTRIBUTING.md](CONTRIBUTING.md) for setup instructions, coding standards, and PR guidelines.

```bash
git clone https://github.com/lumea-labs/polpo.git
cd polpo
pnpm install
pnpm run build
pnpm run test -- --run
```

## Security

If you discover a security vulnerability, please report it responsibly. See [SECURITY.md](SECURITY.md) for details.

## License

[MIT](LICENSE)

---

<p align="center">
  <sub>Built with tentacles.</sub>
</p>
