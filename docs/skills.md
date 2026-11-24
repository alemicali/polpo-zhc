# Skills: bundles, files, and how agents use them

A **skill** is a folder with a `SKILL.md` — instructions an agent loads when a task calls for them —
plus any files those instructions point to. Polpo follows the [Agent Skills](https://agentskills.io/specification)
format used by Claude ([overview](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview),
[Skills API](https://platform.claude.com/docs/en/build-with-claude/skills-guide)) and Anthropic's
[skills repository](https://github.com/anthropics/skills).

```
pdf-tools/
├── SKILL.md          # required: YAML frontmatter + instructions
├── scripts/          # optional: code the agent runs (python scripts/fill.py …)
├── references/       # optional: docs the agent reads when needed
└── assets/           # optional: templates, images, data
```

```markdown
---
name: pdf-tools
description: Fill PDF forms and extract tables. Use when the user mentions PDFs or forms.
license: MIT                      # optional
compatibility: Needs python3      # optional, ≤ 500 characters
allowed-tools: Bash Read          # optional (list or space/comma separated)
metadata:                         # optional, free key/value pairs
  version: "1.0"
---

# PDF tools

For form fields see [the forms guide](references/forms.md). Run `scripts/fill.py <in> <out>`.
```

| Field | Rule (checked on upload) |
| --- | --- |
| `name` | required; 1–64 lowercase letters, digits and single hyphens, not at the start or end. An invalid name blocks the install until you give a new one; `anthropic`/`claude` in it is a warning (Claude's Skills API rejects them). |
| `description` | required, ≤ 1024 characters: what it does **and when to use it** (agents decide from it). XML/HTML tags are a warning. |
| other keys | kept; keys outside the spec are a warning. |
| body | a warning past 500 lines: move details to `references/`. |

**Pools.** Agents' skills live in `.polpo/skills/` (this project) or `~/.polpo/skills/` (every project
on the machine); Polpo's own (the orchestrator's) in `.polpo/.agent/skills/` or `~/.polpo/.agent/skills/`.
An agent gets a skill by assignment (Skills page, `polpo_skill_assign`, or `skills` in its config).

## Uploading a bundle (.skill / .zip / folder)

A **`.skill`** file is a zip of the skill folder, as Anthropic's skill-creator packages it (the folder
at the archive root: `pdf-tools/SKILL.md`). A **`.zip`** may hold the folder, the files directly
(`SKILL.md` at the root, named after the archive's folder or its frontmatter), or **several skills**
— each folder with a `SKILL.md` is a skill (a `SKILL.md` nested inside another skill is just one of
its files). In the dashboard you can also drop a **folder**: the browser zips it (no compression)
and uploads it the same way.

The upload is two steps: a **preview** (nothing installed) and the **install** with your choices.

- **Preview**: every skill with its name, description, files and sizes, errors (block the install)
  and warnings, and whether the name is already taken in each pool.
- **Install**: pool (agents' or Polpo's), scope (this project or all projects), what to do when a
  name exists — **replace** it, **install as a new name** (the `name:` in its `SKILL.md` is rewritten),
  or **skip** it — which skills of the archive, and the agents to assign them to. Replacing keeps the
  agents that had the skill (they find the new version at the same place).

### Safety and limits

Archives are untrusted and read in memory before anything is written:

| Check | Limit / rule |
| --- | --- |
| archive size | 30 MB |
| uncompressed total | 30 MB (as Claude's Skills API); counted on the bytes actually inflated, so a zip bomb stops at the limit |
| files | 1000 entries; 10 MB per file; paths ≤ 255 characters |
| paths | absolute paths, drive letters, `..` and duplicates are refused |
| entry types | symlinks, devices and encrypted entries are refused; only stored and deflate; no ZIP64 |
| integrity | declared sizes and CRC-32 must match |
| junk | `__MACOSX/`, `.DS_Store`, `._*`, `Thumbs.db`, `desktop.ini`, `__pycache__/`, `*.pyc`, `.git/` are dropped (listed in the preview) |
| permissions | **executable bits are not kept** — files are written `0644`. Agents run bundled scripts through their interpreter (`python scripts/x.py`, `bash scripts/x.sh`, `node scripts/x.js`), the way the spec's examples do, so an archive cannot plant executables; an agent that really needs one can `chmod` it in its workspace. The preview says when an archive had executable files. |

Files are written to a staging folder and swapped in only when complete. The whole check runs again
at install time (the staged upload is kept 30 minutes, in memory, at most 8 at once).

### Surfaces

| Where | How |
| --- | --- |
| Dashboard | **Skills → Upload**; Polpo's own skills: **Configuration → Agent → Skills → Upload a skill** |
| REST | `POST /api/v1/skills/upload?dryRun=1` (multipart `file`) → preview with `uploadId`; `POST /api/v1/skills/upload/{uploadId}/install` (`pool`, `global`, `onConflict`: `fail`\|`replace`\|`skip`, `renames`, `skills`, `assignTo`). Without `dryRun` the archive is installed at once with the same options as query parameters (`renames` as a JSON form field). Errors: `409 CONFLICT` (name taken), `413 TOO_LARGE`, `422 UNSAFE_ARCHIVE` / `BAD_ARCHIVE` / `NO_SKILL` / `INVALID_SKILL`. |
| MCP | `polpo_skill_upload_prepare` — the archive as `{ url }` (public https), `{ path }` (a file of the instance, e.g. a chat attachment) or `{ base64, filename }` (large ones in chunks: `more: true`, then `append_to` with the `chunk_id`) → preview + `upload_id`; `polpo_skill_upload_finalize` — `upload_id`, `pool`, `global`, `on_conflict`, `renames`, `skills`, `assign_to`. |
| Polpo (chat) | `skill_upload_prepare` / `skill_upload_finalize` (the same, in the Skills tool group): an attachment's path works as `{ path }`. `install_agent_skill` / `install_orchestrator_skill` also take the path of a `.skill` / `.zip` file. |
| CLI | `polpo skills add ./pdf-tools.skill` (any local `.skill` / `.zip`) |
| SDK | `client.previewSkillBundle(file, filename)`, `client.installSkillBundle(uploadId, opts)`, `client.uploadSkillBundle(file, filename, opts)`; React `useSkillBundleUpload()` |

## Browsing a skill's files

The skill page (**Skills → a skill**) is a file browser: the files as a tree (folders collapsible,
sizes, type icons), the selected file in the main pane — `SKILL.md` by default, rendered without its
frontmatter (raw on demand). Markdown is rendered (raw toggle), code highlighted, JSON pretty-printed,
images and PDFs shown, anything else offered as a download. The URL says which file is open
(`/skills/pdf-tools?file=references/forms.md`), and **relative links** inside markdown
(`[forms](references/forms.md)`, `../SKILL.md`) open that file in place. Download one file, or the
whole skill as `.skill` / `.zip` (ready to upload elsewhere). Polpo's own skills open the same way
(`/skills/<name>?pool=orchestrator`, from Configuration → Agent).

| Where | How |
| --- | --- |
| REST | `GET /api/v1/skills/{name}/files` (paths and sizes); `GET /api/v1/skills/{name}/files/{path}` — the raw file with its content type (`?download=1` as an attachment; slashes literal or `%2F`); `GET /api/v1/skills/{name}/download?format=skill\|zip`; the same under `/api/v1/skills/orchestrator/{name}/…`. Paths outside the folder (`..`, absolute, through a symlink) are 404. Files are served with `X-Content-Type-Options: nosniff` and a sandboxing CSP (no scripts from an uploaded skill run on the dashboard's origin); HTML is shown as text unless downloaded. |
| MCP | `polpo_skill_files`, `polpo_skill_file_read` (text, or `encoding: "base64"` up to 4 MB); `polpo_skill_get` lists the bundled files too |
| Polpo (chat) | `skill_files`, `skill_file_read`; `get_skill` shows the folder |
| SDK | `client.getSkillFiles(name, pool)`, `client.getSkillFile/getSkillFileText(name, path, pool)`, `client.skillFileUrl(...)`, `client.skillDownloadUrl(...)`; React `useSkillFiles(name, pool)` |

## How agents use bundled files

Progressive disclosure, as in Claude: the skill's instructions are in the agent's system prompt, its
files are read only when needed.

- **Polpo's engine**: under each skill's instructions the prompt names the **skill folder** (symlinks
  resolved) and lists its bundled files with sizes (up to 60), saying that paths in the instructions
  are relative to that folder, to read references with the file tools when the instructions call for
  them, and to run scripts with their interpreter. The project pool (`.polpo/skills`) is readable by
  agents (a protected-path exception) and copied read-only into remote sandboxes; when an agent has a
  skill from the **global pool** (`~/.polpo/skills`), that folder is added to its readable paths and
  to its sandbox too.
- **Agent harnesses** (Claude Code, Codex, OpenCode): a skill's bundled **text** files go with it
  (written next to its `SKILL.md` in the runtime's own skills folder, so `references/…` and
  `scripts/…` resolve): up to 200 files, 512 KB each, 4 MB per skill. Binary files cannot travel
  this way; the instructions list the ones left out.
- **Polpo itself** (the orchestrator's skills): the same folder note in its prompt.
