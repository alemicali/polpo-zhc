# Agent versions: draft, publish, deploy, rollback

Every agent's configuration is versioned. Changes go to a **draft** (the working copy); publishing
the draft makes an immutable, **semver**-numbered **version**; **deploying** a version moves the
agent's **production** pointer to it, and production is what runs. A **rollback** is a deploy back
to an earlier version. Every deploy is recorded in the agent's **deploy history**, with a git-style
diff of what changed.

```
edit ──▶ draft ──publish──▶ 1.3.0 (immutable) ──deploy──▶ production
                                                 ◀── rollback (a deploy too) ──
```

## What a version holds

A version is a snapshot of every field that configures the agent (`AGENT_FIELD_CLASSIFICATION` in
`packages/core/src/agent-versions.ts`; a test fails when a new `AgentConfig` field is not classified,
and the compiler rejects it too):

| Versioned | Fields |
| --- | --- |
| Role, persona, prompt | `role`, `identity` (display name, title, avatar, colour, persona…), `systemPrompt`, `suggestions`, `reportsTo` |
| Model and engine | `model`, `engine` (Polpo, a harness or a CLI with its options and CLI account), `reasoning`, `runtime`, `loops`, `pipeline` |
| Tools and access | `allowedTools`, `allowedPaths`, `skills`, `connectorTools` (per-connector tool selection), `progressiveTools`, `emailAllowedDomains` |
| Limits | `maxTurns`, `maxConcurrency`, `compaction` |
| Behaviour | `voiceReplies`, `learning`, `drive` |
| Where it runs | `sandbox`, `computers`, `defaultComputer`, `browserProfile`, `browserEgress` |
| Registry metadata | `author`, `tags` |

Each version also records the **skill versions** current when it was published (`skillVersions`:
skill → version number, from the skill history).

**Not versioned** (and never touched by a rollback):

- `name` (the key), `createdAt`, `volatile` / `missionGroup` (mission-scoped agents are never
  versioned), `version` (the Ink registry's package version, unrelated to these versions);
- runtime data that is not configuration: memory, chats, tasks and runs, outcomes and artifacts,
  learned items, team membership (a relationship kept by the team store: moving an agent applies at
  once), connector grants and vault entries (kept on the connector and in the vault; the agent only
  names them).

Vault values are never in a version: an agent's config only ever holds references.

## Draft and publish

- The **draft** starts from the latest published version. "Draft has changes" means it differs from
  the latest version.
- **Publish** makes the next version with the **suggested bump** unless you choose another or give an
  explicit number (above the latest):
  - **patch** — text, prompt and identity edits (`role`, `systemPrompt`, `identity`, `suggestions`, `reportsTo`, `author`, `tags`);
  - **minor** — added tools, skills or connectors, or any other setting;
  - **major** — a different engine or model, or removed tools, skills or connectors.
- A version records its author (`person:<email>`, `polpo`, `mcp:<client>`, an agent's name,
  `system:…`), timestamp, release note, the previous version and the per-field changes.

## Deploy, production and rollback

- **production** (alias `latest`) is the version everything runs by default: chats, tasks, missions,
  schedules, channels, MCP, Polpo's delegation.
- **Deploy** moves production to a published version (with a confirmation in the dashboard). The
  agent's live configuration is written from the version: what it lacks is cleared.
- **Rollback** deploys the version production ran before the deploy that brought the current one
  (repeated rollbacks walk back), or a version you choose. It appears in the history as a rollback.
- Runs in flight keep the configuration they started with; the next runs use the new production.
- The deploy history lists, newest first: when, who, from → to, the note, and a rollback marker. Each
  deploy opens its diff: per-field changes and a unified diff of the whole configuration rendered as
  YAML (keys sorted, long text such as the system prompt as a block, so it diffs line by line).

The pointer store is generic (`agent_pointers`, keyed by agent and pointer name); only `production`
is used today.

## Pinning a version

A task, mission task, schedule (through its mission) or chat can run a specific published version:

- `assignTo: "writer@1.2.0"` (or `agentVersion: "1.2.0"` on `POST /tasks`): the task stores
  `assignTo: "writer"` and `agentVersion: "1.2.0"`; `writer@production` or a plain name means
  production. Reassigning with or without `@version` sets or clears the pin.
- Missions and schedules: write `"assignTo": "writer@1.2.0"` in the mission's task.
- Chats: `agent: "writer@1.2.0"` in `POST /v1/chat/completions`.

An unknown version is refused when the task is created (`400`). Every run records the version it
used (`Task.runs[].agentVersion`), shown on the task's run card next to the model and engine.

## Surfaces

| | |
| --- | --- |
| Dashboard | Agent page: header shows the production version and "Draft has changes"; **Versions** tab (draft with its diff, publish dialog with bump and note, discard; versions list, view one read-only, select two to diff; deploys: production, rollback, history with each deploy's diff, unified or split). Dashboard edits always go to the draft. Configuration → General → Agent versions holds the API setting below. |
| REST | `GET /agents/{name}` (production config + `versioning`: production, latest, draft state; `?view=draft` returns the draft), `GET /agents/{name}/versions`, `GET /agents/{name}/versions/{version}` (`draft`, `production` accepted), `GET /agents/{name}/diff?from=&to=`, `DELETE /agents/{name}/draft`, `POST /agents/{name}/publish`, `POST /agents/{name}/deploy`, `POST /agents/{name}/rollback`, `GET /agents/{name}/deploys[?diff=true]`, `GET /agents/{name}/deploys/{id}` |
| MCP (admin) | `polpo_agent_versions`, `polpo_agent_version_get`, `polpo_agent_version_diff`, `polpo_agent_publish`, `polpo_agent_deploy` and `polpo_agent_rollback` (destructive, `confirm: true`), `polpo_agent_deploys`; `polpo_agent_get` shows the version and draft state; `polpo_agent_update` takes `publish`, `deploy`, `bump`, `version`, `note`; the agent card shows the production version |
| Polpo's chat | the same tools (`agent_versions`, `agent_publish`, `agent_deploy`, … in the "agent-versions" group); `update_agent` takes `publish`, `deploy`, `note` |
| SDK | `client.getAgentVersions`, `getAgentVersion`, `diffAgentVersions`, `publishAgent`, `discardAgentDraft`, `deployAgentVersion`, `rollbackAgent`, `getAgentDeploys`, `getAgentDeploy`; React `useAgentVersions`, `useAgentDeploys`, `useAgent(name, { view: "draft" })` |

## API compatibility

Before versioning, `PATCH /agents/{name}` (and MCP `polpo_agent_update`, Polpo's `update_agent`)
changed the agent at once. To keep existing clients working:

| Request | Effect |
| --- | --- |
| no `publish` / `deploy` (default) | the draft changes; then, when `settings.agents.versioning.autoDeployApiUpdates` is true (**the default**), it is published (suggested bump) and deployed to production in the same call — the old immediate effect, now recorded as a version and a deploy |
| `publish: false` | only the draft (what the dashboard sends) |
| `publish: true` | draft + publish (production unchanged) |
| `deploy: true` | draft + publish + deploy to production |

`bump`, `version` and `note` apply to the published version. The response's `versioning` says what
happened (`mode`, `draftChanged`, `published`, `deployed`, and the state). Turn the setting off
(Configuration → General → Agent versions, `PATCH /config/settings` with
`{ "agents": { "versioning": { "autoDeployApiUpdates": false } } }`, or `polpo_config_update`
`auto_deploy_agent_updates: false`) to make every API change a draft until someone publishes and
deploys it.

An update that publishes takes the whole draft: pending dashboard edits in the draft are published
with it.

Changes written directly to the live agent — an agent changing its own settings (voice replies,
learning), skill assignment, Ink installs, a CLI or a file edit — are recorded as a new version
deployed to production (at once, or at the next start for offline edits), so the history stays
complete; a pending draft keeps its edits and receives those changes too.

## Storage and migration

- SQLite / PostgreSQL: `agent_versions`, `agent_drafts`, `agent_pointers`, `agent_deploys`, plus
  `tasks.agent_version` (migrations `0019_agent_versions` SQLite, `0020_agent_versions` PostgreSQL).
- File storage: `.polpo/agent-versions/<agent>.json`.
- On start, every agent without versions gets **1.0.0**, published and deployed to production
  (author `system:migration`); it is idempotent. New agents start at 1.0.0 too. Deleting an agent
  deletes its versions and history.

## Not yet

- Running a pinned skill version: versions record the skill versions current at publish time, but
  runs load the skills' current files.
- Pointers other than production (e.g. staging) are not exposed.
