# Agent logins with generated passwords

An agent that signs up for a site (a SaaS dashboard, a supplier portal, a test account) needs a
password. With `vault_create_login` it asks Polpo for one: Polpo generates it, stores it in the
agent's own vault and never shows it to the model. The agent types it into the form from the vault.

## The tool

Give the agent `vault_create_login` (or `vault_*`) in `allowedTools`. A task's tool scope can
narrow it like any other built-in tool.

```
vault_create_login {
  service: "notion",          // the vault entry: a slug (letters, digits, _ or -)
  email?: "ops@acme.com",
  username?: "acme-ops",
  url?: "https://sitoinchat.it",  // the site
  label?: "SitoInChat – Ada",     // default "<Service> – <agent display name>"
  length?: 24,                    // 16–64
  symbols?: true,                 // false for sites that reject symbols
  rotate?: false                  // true: new password for an existing login
}
```

It returns only `{ service, keys: ["email", "password", "url"], created | rotated }` and how to use
it, never the password:

```
browser_fill { selector: "#password", from_vault: "notion.password" }
```

`env_from_vault` (bash; `run_with_vault` for agents on a Claude Code / Codex / OpenCode harness, see
[harnesses](harnesses.md#vault-secrets-in-commands-run_with_vault)) works too: `{ "SITE_PASSWORD": "notion.password" }`.

## The password

- Generated server-side with a CSPRNG (Web Crypto), each character drawn without bias (rejection
  sampling), then shuffled.
- At least one lowercase letter, one uppercase letter, one digit and, with `symbols`, one symbol from
  `!#$%&()*+,-./:;<=>?@[]^_{|}~` — no quotes, backslash, backtick or space, which forms and shells mangle.
- Default length 24.

## Where it can and cannot leak

- **The model never receives it.** The tool result has key names only; `browser_fill` reports
  "filled with notion.password from the vault"; `vault_get` shows `***` for values Polpo
  generated, even outside a sandbox.
- **Masked as soon as it exists.** The value joins the run's secret masker at once: the task
  transcript, the run log, the run's result, harness output and, in chats, tool output show `***`
  (also for its base64 and URL-encoded forms).
- **Usable at once.** The run's view of the vault gets the new entry immediately, so `browser_fill`
  in the next step finds it (no stale cache).

## Ownership and provenance

The entry always goes to the vault of the agent that is running: the run record for task runs, the
chat's agent for chats — never a name from the tool call. Task runs (Polpo's engine, harnesses,
the CLI engine) ask the orchestrator over the notification socket (`vault_login`): the server
process owns the vault and writes it for the run's agent.

Each entry carries non-secret provenance (`VaultEntry.metadata`):

| Field | Meaning |
| --- | --- |
| `createdBy` | `{ kind: "agent", agent, taskId?, sessionId?, runId? }` or `{ kind: "person", by? }` |
| `createdAt` | when it was created |
| `rotatedAt`, `rotatedBy` | the last password rotation |
| `generated` | keys whose values Polpo generated |

An existing entry is refused unless `rotate: true`; a rotation keeps username, email and url and
changes only the password. Editing a generated value by hand removes its *generated* mark.

The file vault keeps the metadata in the entry; the database vault keeps it inside the encrypted
credentials JSON (reserved key `$meta`), so no migration is needed. Entries older than provenance
show their database creation date, or nothing.

## Surfaces

| Surface | How |
| --- | --- |
| Dashboard | Agent → **Credentials**: a *Created by &lt;agent&gt;* / *Added by a person* badge with the date, *generated* marks on fields, and **Generate password** for a new login (the value is never shown). |
| REST | `POST /api/v1/vault/entries/{agent}/{service}/generate` `{ username?, email?, url?, label?, length?, symbols?, rotate? }` → `{ agent, service, action, keys, label, fill, createdBy, createdAt, rotatedAt }` (409 when it exists without `rotate`). `GET /api/v1/vault/entries/{agent}` lists `createdBy`, `createdAt`, `rotatedAt`, `generated`. |
| MCP | `polpo_vault_generate`; `polpo_vault_list` shows who created each entry and when. |
| Polpo's chat | `generate_vault_login`; `list_vault` shows provenance. |
| SDK / React | `client.generateVaultLogin(agent, service, options)`; `VaultEntryMeta.createdBy / createdAt / rotatedAt / generated`, `VaultEntryProvenance`. |

A person generating a login from the dashboard, the API, MCP or Polpo's chat is recorded as
`{ kind: "person" }` (with the signed-in member's email when known).
