<p align="center">
  <img src="docs/polpo-banner.png" alt="Polpo — your AI agent that runs the team" width="680" />
</p>

<p align="center">
  <strong>Build your AI company.</strong><br/>
  <sub>Spin up AI agent teams that plan, execute, review their own work, and ping you only when it matters.</sub>
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> &bull;
  <a href="#how-polpo-is-different">How it's different</a> &bull;
  <a href="#features">Features</a> &bull;
  <a href="https://docs.polpo.sh">Docs</a>
</p>

<p align="center">
  <img alt="npm" src="https://img.shields.io/npm/v/@polpo-ai/polpo?style=flat-square&color=blue" />
  <img alt="license" src="https://img.shields.io/github/license/lumea-labs/polpo?style=flat-square" />
  <img alt="node" src="https://img.shields.io/badge/node-%3E%3D18-brightgreen?style=flat-square" />
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-ESM-blue?style=flat-square" />
</p>

---

## Why Polpo?

You don't need another AI coding assistant. You need a team that runs without you.

AI agents are great at execution — terrible at finishing real work autonomously. Without oversight they drift, conflict, and stall. You end up babysitting the machines that were supposed to save you time: 4 monitors, 12 terminals, zero confidence anything actually works.

**Polpo gives you an AI company.** Describe what you need and walk away. Polpo assembles the right agents, plans the work, checks every result, retries what's broken, and escalates what it can't fix. It reaches you on Telegram, Slack, or email — only when it matters.

One `npm install`, no hosted platform, no vendor lock-in. Your laptop, your API keys, your rules.

## How Polpo is different

| | What you get | How it works |
|---|---|---|
| **Claude Code / Cursor** | A developer | One agent, one chat, one task at a time. You drive. |
| **OpenClaw** | A personal assistant | Multiple agents, no quality checks. You hope it works. |
| **Polpo** | **A company** | Multiple agents working as a team — with a manager (Polpo) that plans, delegates, reviews, retries, and reports back. You're the CEO. |

| | | |
|:---:|---|---|
| :robot: | **Autonomous** | Builds missions, picks agents, works through queued tasks 24/7. Walk away. |
| :white_check_mark: | **Reliable** | Every task scored by LLM judges. Below threshold? The agent fixes it. You get results, not retries. |
| :shield: | **Crash-proof** | Detached processes. Kill Polpo, reboot, lose connection — picks up where it left off. |
| :bell: | **Proactive** | Reaches you on Slack, Telegram, email, or webhooks. You decide when and how. |
| :repeat: | **Playbooks** | Define a mission once, run it forever. Schedule it, tweak it, improve it. Your AI company gets better over time. |

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

The installer detects your platform, ensures Node.js >= 18 is available, and installs Polpo globally.

### Manual install

```bash
npm install -g @polpo-ai/polpo    # or: pnpm add -g @polpo-ai/polpo
```

### Docker

```bash
docker run -it -p 3000:3000 -v $(pwd):/workspace lumea-labs/polpo
```

## Quick Start

### Chat with an agent

```bash
polpo init && polpo
```

The setup wizard detects your API keys, picks a model, and creates your first agent. Then you're in the interactive TUI — type what you need, hit Enter, and the agent does it.

### Orchestrate a team

```bash
polpo init                          # Set up project, agents, and roles
polpo mission create "Close $1M in revenue this month"
```

Polpo generates a mission with tasks, dependencies, and agent assignments. Agents execute, LLM judges score every result, and failures retry automatically.

**Monitor** (optional):

```bash
polpo status -w    # Live dashboard in another terminal
polpo serve        # HTTP API + Web UI at http://localhost:3000
```

### Docker

```bash
docker pull ghcr.io/lumea-labs/polpo:latest
docker run -it -v $(pwd):/workspace ghcr.io/lumea-labs/polpo:latest
```

## What your agents can do

Code. Browse the web. Send emails. Generate PDFs, Excel, Word docs. Create images, videos, audio. Search the internet. Talk to your customers. Handle credentials securely. And learn — Polpo creates and installs its own skills over time. Your AI company gets smarter the more you use it.

22+ LLM providers. 70+ tools. 5,000+ community skills. Free default model included.

## Documentation

Full docs at [docs.polpo.sh](https://docs.polpo.sh) — configuration, API reference, guides, and more.

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
