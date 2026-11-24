# Polpo Documentation

Documentation has moved to [docs.polpo.sh](https://docs.polpo.sh).

Self-host and Docker deployment notes live in [deployment.md](deployment.md).

The deterministic loops agent contract is documented in [loops.md](loops.md).

Connectors (Polpo as an MCP client: Linear, Notion, Gmail, custom servers) are documented in [connectors.md](connectors.md).

Hosted MCP servers — MCP servers Polpo builds (from an API, a description or a template such as Printful) and serves itself, each becoming a connector; HTTP and sandboxed code tools, vault-referenced credentials, tests, versions and deploys, private or public exposure — are documented in [custom-mcp-servers.md](custom-mcp-servers.md).

Computers (a persistent machine per agent) are documented in [computers.md](computers.md); running sandboxes and computers on Daytona's new service (Linux VMs) in [daytona-v2.md](daytona-v2.md).

The dashboard's look (instance default, per-browser customization, design tokens, the no-flash boot) is documented in [appearance.md](appearance.md); the MCP connector and its tools, every Configuration section included, in [mcp.md](mcp.md).

The global search (⌘K in the dashboard, `GET /api/v1/search`, `polpo_search`) — what it finds, how it ranks, the full-text index on chat messages — is documented in [search.md](search.md).

The official WhatsApp Business channel (Meta Cloud API: setup, the 24-hour window, templates, approvals, the Funnel command, retention) is documented in [whatsapp-business.md](whatsapp-business.md).

Agent versions — drafts, semver versions, deploying to production, rollback, the deploy history with diffs, pinning a task or chat to a version (`writer@1.2.0`) and the API compatibility setting — are documented in [agent-versions.md](agent-versions.md).

Agent harnesses (Claude Code and Codex as an agent's engine, inside its computer) are documented in [harnesses.md](harnesses.md).

Skills — the Agent Skills format, uploading `.skill` / `.zip` bundles (validation, limits, conflicts), browsing a skill's files, and how agents read bundled references and run scripts — are documented in [skills.md](skills.md).

What a mission costs (every run of its tasks, by agent and engine) and its optional budget, which pauses it when spent, are documented in [missions.md](missions.md).

How a task receives the results of the tasks it depends on (in its prompt, and with `task_result`), and how checkpoints pause a mission, are in [missions.md](missions.md#results-between-tasks).
