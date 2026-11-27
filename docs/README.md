# Polpo Documentation

Documentation has moved to [docs.polpo.sh](https://docs.polpo.sh).

Self-host and Docker deployment notes live in [deployment.md](deployment.md).

The deterministic loops agent contract is documented in [loops.md](loops.md).

Connectors (Polpo as an MCP client: Linear, Notion, Gmail, custom servers) are documented in [connectors.md](connectors.md).

Hosted MCP servers — MCP servers Polpo builds (from an API, a description or a template such as Printful) and serves itself, each becoming a connector; HTTP and sandboxed code tools, vault-referenced credentials, tests, versions and deploys, private or public exposure — are documented in [custom-mcp-servers.md](custom-mcp-servers.md).

Computers (a persistent machine per agent) are documented in [computers.md](computers.md); running sandboxes and computers on Daytona's new service (Linux VMs) in [daytona-v2.md](daytona-v2.md); watching a computer's desktop live, the headed browser (`browserHeaded`), taking control for a login / 2FA / CAPTCHA (`request_computer_takeover`) and `CDP_URL` in [computer-live-view.md](computer-live-view.md).

The dashboard's look (instance default, per-browser customization, design tokens, the no-flash boot) is documented in [appearance.md](appearance.md); the MCP connector and its tools, every Configuration section included, in [mcp.md](mcp.md).

The global search (⌘K in the dashboard, `GET /api/v1/search`, `polpo_search`) — what it finds, how it ranks, the full-text index on chat messages — is documented in [search.md](search.md).

Decisions — `decide()`: typed judgments with probabilities (yes/no, choice, score, rank) from a decision model through Vercel AI Gateway and the shared gateway resolver, the decision log, mission and playbook decision nodes, the agents' `decide` tool and the suites' decision scorer — are documented in [decisions.md](decisions.md).

Media — image generation and editing as a primitive (`generateImage` / `editImage`) through Vercel AI Gateway and the shared gateway resolver, every image an asset with its provenance in the media log, the agents' `image_generate` / `image_edit` / `image_analyze`, mission and playbook image nodes — is documented in [media.md](media.md).

Triggers — public endpoints (`POST /hooks/{id}`) that receive form submissions and webhooks: secret / HMAC / IP authentication, a versioned contract, filter, dedupe, rate limit, mapping, the delivery log and test tools, and the Tailscale Funnel path — are documented in [triggers.md](triggers.md). Actions on deliveries arrive later with the action engine.

The official WhatsApp Business channel (Meta Cloud API: setup, the 24-hour window, templates, approvals, the Funnel command, retention) is documented in [whatsapp-business.md](whatsapp-business.md).

Slack (an app over Socket Mode: DMs, mentions and threads as conversations with Polpo or an agent, files, buttons, `/polpo`; no public URL needed) is documented in [slack.md](slack.md).

Agents posting to notification channels (`send_notification`: Slack as the Polpo bot, Telegram, email, webhook, push), restricted per agent to the channels and targets its owner allows (`notifyChannels`, `notifyRateLimit`), on every engine, are documented in [agent-notifications.md](agent-notifications.md).

Agents creating their own logins with a password Polpo generates and the model never sees (`vault_create_login`, `browser_fill` from the vault), and the provenance of vault entries (who created each, when, rotations), are documented in [agent-vault-logins.md](agent-vault-logins.md).

Communication lines between agents — who may talk to whom (`talksTo`: org chart, a list, anyone, nobody), how `ask_agent`, `message_agent`, `escalate` and rooms enforce them, and agents working a task talking to other agents — are documented in [agent-lines.md](agent-lines.md).

Agent versions — drafts, semver versions, deploying to production, rollback, the deploy history with diffs, pinning a task or chat to a version (`writer@1.2.0`) and the API compatibility setting — are documented in [agent-versions.md](agent-versions.md).

Agent suites — tests and evals of an agent with tool mocks and scripted models, datasets, assertions, runs against a version with a trace per case, and the per-engine mock support —, benchmarks (suites × variants × repetitions: leaderboard, Pareto front, case × variant matrix, side by side) and the Playground (chat with several variants at once) are documented in [agent-suites.md](agent-suites.md).

Agent harnesses (Claude Code and Codex as an agent's engine, inside its computer) are documented in [harnesses.md](harnesses.md).

Skills — the Agent Skills format, uploading `.skill` / `.zip` bundles (validation, limits, conflicts), browsing a skill's files, and how agents read bundled references and run scripts — are documented in [skills.md](skills.md).

What a mission costs (every run of its tasks, by agent and engine) and its optional budget, which pauses it when spent, are documented in [missions.md](missions.md).

How a task receives the results of the tasks it depends on (in its prompt, and with `task_result`), and how checkpoints pause a mission, are in [missions.md](missions.md#results-between-tasks).
