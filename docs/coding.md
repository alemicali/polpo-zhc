# Coding

The **Coding** app (Tools → Coding) is where people work on repositories with coding agents: projects
(a folder or a cloned repository), **worktrees** (one git worktree per piece of work, created with a
city name, e.g. `lisbon-x1`) and **sessions** in each worktree. The right panel keeps the worktree's
**Changes** (git status and diffs), a **Browser**, a side **Terminal** and **VS Code**; the header
shows the branch, the PR and Open PR / Merge.

## Navigation

The Coding app has no sidebar of its own: its navigation is a level of the dashboard's sidebar, like
Chat.

- **Drill-in sidebar** (the default): Tools → **Coding** opens the page and replaces the sidebar's list
  with **projects → worktrees → sessions** (Back returns to Tools). Each worktree shows its branch (live,
  renames included), its label, the PR (open, merged, closed), the diff stats and ahead / behind; its
  sessions are listed under it, chats with a dot while they work (blue) or wait for an approval
  (amber). **Add workspace** creates a worktree and opens the quick start; **+** on a worktree starts
  a Claude Code chat there; **Archive** ends its sessions; **Add project**, **Processes** and
  **Settings** are at the bottom. On the collapsed icon rail a button expands the sidebar.
- **Chat-first layout**: the same navigation is a column next to the page on `/coding` (desktop).
- **Phone**: the navigation sheet's drill-in has the Coding level.
- **Classic sidebar** (or whenever no navigation shows the sessions): the **Projects and sessions**
  button in the page's header opens them in a sheet.

The page's state (projects, sessions, the active one, worktrees without a session) is one store
shared by the page and the navigation, saved on the server (`/api/v1/coding/sessions`).

## Sessions

A session is either:

- a **coding chat** — Claude Code or Codex as a chat (below): what **Claude** and **Codex** start now,
  from the quick start of a new worktree, the **+** of the tabs or of a worktree;
- a **terminal** — xterm: the **Terminal** kind (a shell), the **Open PR** one-shot command, and the
  claude / codex terminal sessions created before coding chats (they stay terminals, resumed with
  `--resume` as before).

### Open as chat

An older Claude Code or Codex **terminal** session can continue as a coding chat: **Open as chat** in
its header (above the terminal), or in the session's context menu in the navigation. The chat opens in
the **same worktree**, on **your** CLI account, and the view moves to it; the terminal session stays
(marked as continued: its header then says **Go to chat**).

- **Claude Code**: the terminal ran `claude --session-id <id>`, so the chat **resumes that
  conversation** (`claude -p --resume <id>`, the session's `agentSessionId`). That works when your CLI
  account's config directory has it. The terminal ran with this server's own Claude Code sign-in
  (`~/.claude`), so if your account is another directory, the program cannot find the conversation:
  the chat then starts **a new conversation in the same worktree** and says why (the terminal keeps
  its conversation).
- **Codex**: its terminal sessions keep no conversation id Polpo knows (`codex resume --last`), so the
  chat starts a new conversation in the same worktree, and says so.
- The chat's first line: "Continued from terminal session …", with whether the conversation was
  resumed (`continuedFrom.status`: `pending` until the first turn, then `resumed` or `new`).
- REST: `POST /api/v1/coding/chats` with `fromTerminal: { id, label? }` and `resumeSessionId`; MCP:
  `polpo_coding_chat_start` with `from_terminal` and `resume_session_id` (Polpo's chat: the same
  parameters of `coding_chat_start`); SDK: `createCodingChat({ …, fromTerminal, resumeSessionId })`.

## Coding chats

A coding chat runs the **official, unmodified `claude` or `codex` program through the CLI engine**
(docs/harnesses.md → CLI engine) in the worktree (its working directory is the worktree), signed in
with **the CLI account of the person who opened it** — and only they can talk to it, approve its
actions or stop it. The ToS rules of the CLI engine are unchanged: a personal sign-in runs only its
owner's work, never for other members or channel customers, never on an instance that serves
customers; an instance-owned Claude account only on a personal installation, an instance Codex
account only with `allowInstanceCodex`. Polpo never sees a token.

Without an account the chat says how to sign in: **Settings → Harnesses → CLI accounts**, add one and
**Sign in** (a terminal running `claude auth login` / `codex login --device-auth` with your own plan).
An expired sign-in, a usage limit or a missing program are said the same way, labelled.

- **Turns**: each message starts the program, which **resumes the session's own conversation**
  (`claude -p --resume <session>`, Codex `thread/resume`), and ends with the turn. A message sent
  while it works reaches it at once (a steer); **Stop** ends the turn and keeps the conversation.
- **The chat**: the person's messages; the program's text **as it is written** (Claude Code
  `--include-partial-messages`, Codex agent message deltas); its tool calls as collapsible lines —
  **edits with their diff** (Edit, MultiEdit, Write, Codex's file changes), **commands with their
  output** (Bash, shell), reads and searches; reasoning; the **engine badge** (program, model, account),
  tokens and the CLI's own cost estimate (the plan pays).
- **History**: the transcript, approvals, the program's conversation id, tokens and turns are kept in
  `.polpo/coding-chats/<id>.json` (never a credential). After a reload the chat is there; after a
  server restart a turn that was running is marked interrupted and the next message resumes the
  conversation. If the program lost it (another machine, a cleared account) a new one starts with the
  transcript so far as context.
- **Changes**: when the program edits files or runs a command the worktree's Changes panel refreshes.

### Approval policy

The program works in the worktree **on its own**: reading, searching, editing and writing files inside
it, running commands that stay in it (tests, builds, `git status` / `diff` / `commit`, formatters…).

**Risky actions wait for the owner in the chat** — Approve runs it, Deny tells the program it was
refused (it goes on without it). Deliberately conservative: when in doubt it asks.

| Category | What |
| --- | --- |
| `network-install` | installing packages over the network: npm / pnpm / yarn / bun install, add, dlx; npx; pip / uv / poetry; cargo install / add; go get; gem; brew, apt… |
| `network` | anything else that reaches the network: curl, wget, ssh, scp, rsync, git clone / fetch / pull, gh, web fetch and web search |
| `git-push` | `git push`, force pushes included (said as such) |
| `outside-worktree` | any path outside the worktree — reading, writing or deleting it: absolute paths elsewhere, `~`, `$HOME`, `..` escaping it, a command run in another folder |
| `privileged` | sudo / su / doas, docker / podman, kill / pkill / killall, systemctl, shutdown |
| `unknown-tool` | a tool the policy does not know |

How it is enforced:

- **Claude Code** runs with `--permission-mode default` and `--permission-prompt-tool
  mcp__polpo__permission_prompt`: every action that needs a permission comes to a Polpo MCP tool of the
  turn (on this server's loopback, a per-turn token), which allows what is safe and asks the person
  for what is risky (`{"behavior":"allow"}` / `{"behavior":"deny"}`). Reads and searches inside the
  worktree need no permission. `MCP_TOOL_TIMEOUT` covers the wait. Claude Code's own permission rules
  (`permissions.allow` / `deny` in the account's or the repository's `settings.json`) apply first: an
  allow rule there skips the question.
- **Codex** runs in its `workspace-write` sandbox with `approvalPolicy: "on-request"`: it asks only to
  leave the sandbox (network, files outside the workspace), so **every Codex approval request is
  risky** and waits for the person (`item/commandExecution/requestApproval`,
  `item/fileChange/requestApproval` → accept / decline).
- An approval nobody answers is denied after 30 minutes; Stop denies those waiting.

## API, MCP, Polpo's chat, SDK

- **REST** (`/api/v1/coding/chats`, in the OpenAPI document): `GET /` (sessions; `?cwd`,
  `?workspaceId`, `?kind`), `POST /` (`{ kind, cwd, title?, workspaceId?, branch?, account?, model?,
  prompt? }`), `GET /account?kind=` (the account you would use, or how to sign in), `GET /{id}` (the
  transcript), `POST /{id}/messages` (`{ text }`: a turn, or a steer), `POST /{id}/stop`,
  `POST /{id}/approvals/{approvalId}` (`{ decision: approve | deny }`), `DELETE /{id}`, and
  `GET /{id}/events` (Server-Sent Events: `session`, `message`, `approval`, `files-changed`,
  `deleted`). The bus carries `coding:chat` (created, status changes, deleted).
- **MCP** (the `coding` toolset): `polpo_coding_chats_list`, `polpo_coding_chat_get`,
  `polpo_coding_chat_start` and `polpo_coding_chat_send` (with `wait`), `polpo_coding_chat_control`
  (stop, approve, deny), and the **coding card** `polpo_coding_chat_show` (the transcript, with Approve
  / Deny). The member behind an OAuth connection or a dashboard session is the one whose account runs
  the chat. See docs/mcp.md.
- **Polpo's chat**: `coding_chats_list`, `coding_chat_get`, `coding_chat_start`, `coding_chat_send`,
  `coding_chat_control` (the `coding` group) — "open a Claude Code session on the polpo worktree and
  ask it to…". Polpo approves nothing on its own.
- **SDK**: `getCodingChats`, `getCodingChat`, `createCodingChat`, `sendCodingChatMessage`,
  `stopCodingChat`, `resolveCodingChatApproval`, `deleteCodingChat`, `getCodingChatAccount`,
  `streamCodingChat`; **React**: `useCodingChats`, `useCodingChat` (live, with `onFilesChanged`).

## Deferred

- Coding chats run on this server only (the worktrees are local); a remote computer's CLI account is
  not used here.
- Attachments in the composer, and choosing the model from the chat (the API takes `model`).
