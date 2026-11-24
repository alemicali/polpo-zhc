# Artifacts

Artifacts are what agents and people make and keep: documents, slide decks, spreadsheets, visual designs, short animations, HTML dashboards, drawings and diagrams. They live in **Artifacts** (`/artifacts`), open from the chat they were made in, and every change keeps the previous content as a version.

## Workspaces

Five kinds open in an editor of their own (the workspace), for people to change after an agent made them, or to start from scratch with **New** in the gallery.

| Workspace | Stored as | What you can do | Export |
|---|---|---|---|
| **Docs** | `type: "doc"`, Markdown | Rich text (headings, lists, task lists, tables, quotes, callouts, code, images, videos, collapsible sections, fonts), **tabs** (a document of several pages), inline **dropdowns** (status, priority or your own lists, each with a colour), **comments** on a passage (resolve, reopen). Reading and editing mode. | Word (.docx), print or PDF, Markdown |
| **Slides** | `type: "html", kind: "slides"`, JSON | Title, content and two-column layouts, three themes, text boxes, rectangles, ellipses, images, tables and videos placed freely, speaker notes, skipped slides, a full-screen **presentation** mode. | PowerPoint (.pptx), JSON |
| **Sheets** | `type: "html", kind: "sheets"`, JSON | Several sheets, formulas (`=SUM(A1:A9)` and the usual functions), currency, percent and date formats, bold / italic / alignment / text and cell colours / borders, dropdown validation, checkboxes, conditional colours, bar / line / pie **charts**. While an agent writes a sheet, the cells appear as it writes them. | Excel (.xlsx), CSV; import CSV or XLSX |
| **Design** | `type: "html", kind: "design"`, HTML | A canvas of **artboards** on pages: select, move and resize elements, add text, notes, rectangles, circles, freehand lines and new artboards, edit an element's properties, its HTML (Code) or the page's CSS variables (Tweaks), layers. | One HTML file per artboard |
| **Motion** | `type: "html", kind: "motion"`, JSON | **Scenes** of text, rectangle and ellipse layers that enter with a fade, rise or slide, a cut or a fade between scenes, a soundtrack, a timeline, a full-screen preview. | Video (MP4, or WebM where MP4 cannot be encoded) |

Other artifacts open as they are: HTML dashboards, apps, reports and pages (`type: "html"` with another kind, or none), SVG drawings, Mermaid diagrams, and the former data views (`type: "view"`, read-only).

The JSON formats (slides, sheets, motion) and the conventions for doc tabs, dropdowns and design artboards are described to agents in their tools (`ARTIFACT_WORKSPACE_GUIDE` in `@polpo-ai/core/artifacts`): an agent asked for "a deck", "a spreadsheet" or "an animation" writes it in that format and it opens in the workspace.

Every export runs in the browser: nothing leaves the instance, and only the artifact's own content goes into the file.

## The gallery

Artifacts shows each artifact as a card with a live thumbnail (the first slide, the first rows of a sheet, the first frame of an animation, a page of the doc, a static snapshot of an HTML page), or as a table. From an artifact's menu: **rename**, **pin** (pinned ones come first), **duplicate** (a copy of the current version, or of an earlier one from the versions panel), **versions** (see and restore any kept version: the last 30 by default, see the limits below), **export**, **download source**, delete.

## Versions and editing at the same time

Every content change keeps the previous content as a version, with who made it and, for agents, a note on what changed. A person editing an artifact saves against the version they opened: if someone (a person or an agent) saved a newer one meanwhile, the save is refused and the editor offers to download the draft or open the latest version. Agents do the same with `expectedVersion`.

A duplicate keeps the original's author: an HTML artifact reads data sources with its author's rights, so a copy never gets wider access than the original had. Who made the copy, and from which version, is recorded on the copy's first version.

## Who can make and change them

| Surface | Create | Read | Change |
|---|---|---|---|
| Dashboard | **New** in Artifacts (blank Doc, Slides, Sheets, Design, Motion), **Upload** or drag & drop files | gallery, table, the chat | the workspace editors; rename, pin, duplicate, restore, **Replace content…** (a file) |
| Agents | `artifact_create`, `artifact_from_file` (a file it wrote in its workspace) — with `artifact_*` in `allowedTools` | `artifact_get` (any version; byte range, outline or one part), `artifact_list` | `artifact_update` (`update` / `rewrite` / `append` / `prepend` / `patch` / `ops`; `expectedVersion`), `artifact_from_file` with `id`, `artifact_delete` — their own artifacts only |
| Polpo (chat) | the same tools, plus `artifact_upload_prepare` / `artifact_upload_finalize` | the same | the same, on any artifact |
| MCP | `polpo_artifact_create` (a few KB), `polpo_artifact_upload_prepare` + `polpo_artifact_upload_finalize` (any size) | `polpo_artifacts_list`, `polpo_artifact_get` (byte range, outline, part) | `polpo_artifact_update` (same commands as the agents), `polpo_artifact_upload_finalize` with `id` (replace) |
| REST | `POST /api/v1/artifacts` (JSON), `POST /api/v1/artifacts/upload`, `POST /api/v1/artifacts/uploads` + `…/uploads/:uploadId/finalize` | `GET /api/v1/artifacts`, `GET /api/v1/artifacts/:id`, `GET /api/v1/artifacts/:id/content` (Range), `GET /api/v1/artifacts/:id/read`, `GET /api/v1/artifacts/:id/versions/:version`, `GET /api/v1/artifacts/usage` | `PATCH /api/v1/artifacts/:id`, `PUT /api/v1/artifacts/:id/content`, `POST …/:id/duplicate`, `POST …/:id/restore/:version`, `DELETE …/:id` |
| SDK | `client.createArtifact`, `client.uploadArtifact`, `uploadArtifactPart` + `finalizeArtifactUpload`; React `useArtifactUpload()` (parts with progress) | `getArtifact`, `readArtifact`, `artifactContentUrl`, `getArtifactVersion`, `getArtifactUsage` | `updateArtifact`, `replaceArtifactContent`, `restoreArtifact`, `duplicateArtifact`, `deleteArtifact` |

## Changing part of an artifact

Agents, Polpo, MCP clients and the REST API change an artifact the way Claude's artifacts work: a targeted **update** is the default, a **rewrite** only when most of the content changes. Every change is a new version people can step through and restore. One kind of change per call:

| Change | Fields | What it does |
|---|---|---|
| `update` (default with `old_str`) | `old_str`, `new_str`, `replace_all?` — or `updates: [{ old_str, new_str, replace_all? }]` | Replaces `old_str` with `new_str`. `old_str` must occur once (or `replace_all`). Matched exactly, then ignoring trailing spaces, smart quotes, dashes and Unicode spaces (like the coding `edit` tool); line endings are kept. Several `updates` apply in sequence, all or nothing. A miss shows the closest lines and the first character that differs. (`edits: [{ find, replace }]`, the earlier form, still works.) |
| `rewrite` (default with `content`) | `content` | The whole new content. |
| `append` / `prepend` | `text` (or `append` / `prepend`) | Adds text at the end or the beginning. |
| `patch` | `patch: [{ op, path, from?, value? }]` | [JSON Patch (RFC 6902)](https://www.rfc-editor.org/rfc/rfc6902) on the artifact's model: the workspace JSON (slides, sheets, motion), `{ version, pages }` of a design (each board with its `html`), `{ tabs: [{ id, title, content }] }` of a document. `test` operations guard a change. |
| `ops` | `ops: [{ op, … }]` | Operations per kind, below. |

Operations (`ops`), applied in order, all or nothing; an item is named by its id, its name or title, or its position (from 0):

- **Docs** — `set_tab {tab, content}`, `edit_tab {tab, old_str, new_str, replace_all?}`, `insert_tab {title, content?, id?, at?}`, `rename_tab {tab, title}`, `move_tab {tab, to}`, `delete_tab {tab}`. A document without tabs is one tab (position 0); `insert_tab` makes it a tabbed document.
- **Sheets** — `set_cells {sheet?, cells: {A1: "v" | null}}`, `set_range {sheet?, start, values: [[…]]}`, `clear_range {sheet?, range, styles?}`, `set_style {sheet?, range, style | null}`, `insert_rows` / `delete_rows {sheet?, at (row number), count?}`, `insert_columns` / `delete_columns {sheet?, at: "C", count?}`, `add_sheet {name, cells?, at?}`, `rename_sheet {sheet, name}`, `delete_sheet {sheet}`. Formulas, styles, validations, conditional rules and charts follow inserted and deleted rows and columns; a reference to a deleted cell becomes `#REF!`; formulas in other sheets follow a renamed sheet.
- **Slides** — `insert_slide {slide: {…}, at?}`, `replace_slide {slide, value}`, `update_slide {slide, set}`, `move_slide {slide, to}`, `delete_slide {slide}`, `insert_element {slide, element, at?}`, `update_element {slide, element, set}`, `delete_element {slide, element}`.
- **Design** — `replace_board {board, html}`, `edit_board {board, old_str, new_str, replace_all?}`, `update_board {board, set: {name, x, y, width, height}}`, `insert_board {page?, board: {…}}`, `delete_board {board}`, `insert_page {page: {name}, at?}`, `rename_page {page, name}`, `delete_page {page}`, `set_layer {board, id, attributes?, style?, text?}` (the element with that `id` attribute: attributes and inline style properties set or removed with `null`, its text replaced).
- **Motion** — `insert_scene`, `replace_scene`, `update_scene`, `move_scene`, `delete_scene`, `insert_layer {scene, layer}`, `update_layer {scene, layer, set}`, `delete_layer {scene, layer}`, `set_project {set: {width, height, audio}}`.

`set` changes the fields given (`null` removes one); ids cannot be changed with it. The result is checked before it is saved (ids unique, at least one slide / sheet / scene / tab / page, cell addresses within A1:AZ500, the workspace's own checks): nothing is saved when it fails, and the error says what to fix.

## Reading part of an artifact

`artifact_get` / `polpo_artifact_get` / `GET /api/v1/artifacts/:id/read` return a small content whole; a larger one shows its first 60,000 bytes plus its **outline** (tabs, slides, sheets with their used ranges, pages and artboards, scenes, with ids and sizes). Then read on with:

- `offset` / `limit` — a byte range (a UTF-8 character cut at either end is dropped; the answer says where to continue);
- `outline: true` — only the structure;
- one part — `tab`, `slide` or `slides: "2-5"`, `sheet` (with `range: "A1:D20"`), `board`, `page`, `scene`.

`GET /api/v1/artifacts/:id/content` returns the content as a file with `Range` support (`?version`, `?download=1`); `GET /api/v1/artifacts/:id` includes the content up to 10 MB and otherwise answers `contentOmitted: true` (with `excerpt`, the first few KB).

## Uploading

Large artifacts are not written in a tool call: the content goes as a file.

- **Dashboard** — **Upload** (or drop files anywhere on Artifacts): `.md`, `.html`, `.svg`, `.mmd`, workspace `.json`, and spreadsheets (`.csv`, `.xlsx`, converted in the browser into a Sheets workspace). Word, PowerPoint and PDF files are not converted yet: export them as Markdown / HTML, or keep them on the Files page. An artifact's menu has **Replace content…**. Files over 8 MB go in parts, with progress.
- **REST** — `POST /artifacts/upload` with the bytes as the body (`?title`, `type`, `kind`, `filename`) or a multipart form (`file` + fields); `PUT /artifacts/:id/content` (`?expectedVersion` or `x-expected-version`) replaces the content. In parts: `POST /artifacts/uploads` (the first part, then `?append_to=<uploadId>&more=true` until the last), or JSON `{ base64, append_to?, more?, filename? }` or `{ path }` (a file of the project, the agents' workspace or `.polpo`, e.g. a chat attachment), then `POST /artifacts/uploads/:uploadId/finalize` `{ id?, expectedVersion?, title?, type?, kind?, description?, note? }`. Uploads in progress are kept 30 minutes.
- **MCP** — `polpo_artifact_upload_prepare` with `{ url }` (public https), `{ path }` or `{ base64 }` in parts (`append_to` + `more`), then `polpo_artifact_upload_finalize` (with `id` to replace). The tool descriptions tell models to prefer upload and `update` over a full content for anything above a few KB, and a 413 names the upload tools.
- **Agents** — write the file with the coding tools, then `artifact_from_file { path }` (or `{ path, id }` to replace). A file in a remote sandbox is copied out; a path outside the agent's allowed folders is refused.

The type is detected from the file name and content when not given: `.md`/`.txt` doc, `.html` page (or `design` when it carries a design workspace), `.svg`, `.mmd`/`.mermaid`, `.json` → slides, sheets or motion by its top-level array. The content must be UTF-8 text.

## Storage and limits

A content up to 256 KB is kept in the artifact's record (the database, or `.polpo/artifacts/` on files). A larger one is a **blob**: a file in `.polpo/artifact-blobs/<artifact id>/<sha256>`, named by its hash, with the record keeping its reference, its size and its first 8,000 characters (for search and previews). Listing and search never read blobs; the dashboard reads them as files or by part. Uploads arrive on disk as they are received (`.polpo/artifact-blobs/.staging/`), never whole in memory.

Versions are **full snapshots**: each keeps its content (inline, or a reference to its blob). Identical contents share one blob (a restore, an undo). After a change the oldest versions are pruned until they fit the limits; the current content is never pruned, and a blob no version refers to is removed. Records written before blobs existed (inline contents up to 1 MB, versions included) are moved to blobs once at start-up, and in any case on their next change; nothing is lost.

Limits, in `settings.artifacts` (`polpo.json`; missing or invalid values keep the defaults):

| Setting | Default | What it limits |
|---|---|---|
| `maxBytes` | 100 MB | One artifact's content (uploads stop at it: 413) |
| `versions.maxCount` | 30 | Earlier versions kept per artifact |
| `versions.maxTotalBytes` | 500 MB | Bytes of an artifact's earlier versions (identical contents counted once; the newest earlier version is always kept) |
| `inlineBytes` | 256 KB | Contents larger than this are blobs |
| `maxEditBytes` | 50 MB | Contents changed in place (`update`, `patch`, `ops`) or read by part / outline, which the server holds in memory to do it; larger ones are replaced by upload or read by byte range |
| `maxTotalBytes` | 20 GB | Every artifact of the instance together: from 80% `GET /artifacts/usage` warns, over it new large contents are refused (507) |

A JSON request (create, change) is at most 32 MB: larger contents go by upload. The dashboard opens contents up to 10 MB in the editors (with a warning over 2 MB); a larger artifact shows its size, a download, **Replace content**, its outline and a preview read 64 KB at a time. The versions panel shows how much of the version limit an artifact uses ("2 earlier versions, 80 MB of 500 MB"), and so do `polpo_artifact_get`, `artifact_get` and the API (`usage`).

## Look

The editors' chrome (toolbars, panels, inspectors, the gallery, comments and dropdown chips, selection outlines, the live chart preview) follows the instance's look like every other screen (see [appearance.md](appearance.md)). What a person puts in a document is theirs: the colours picked for text, cells, shapes and slide themes stay as chosen, in the dashboard and in every export.
