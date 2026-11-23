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

Artifacts shows each artifact as a card with a live thumbnail (the first slide, the first rows of a sheet, the first frame of an animation, a page of the doc, a static snapshot of an HTML page), or as a table. From an artifact's menu: **rename**, **pin** (pinned ones come first), **duplicate** (a copy of the current version, or of an earlier one from the versions panel), **versions** (see and restore any of the last 30), **export**, **download source**, delete.

## Versions and editing at the same time

Every content change keeps the previous content as a version, with who made it and, for agents, a note on what changed. A person editing an artifact saves against the version they opened: if someone (a person or an agent) saved a newer one meanwhile, the save is refused and the editor offers to download the draft or open the latest version. Agents do the same with `baseVersion`.

A duplicate keeps the original's author: an HTML artifact reads data sources with its author's rights, so a copy never gets wider access than the original had. Who made the copy, and from which version, is recorded on the copy's first version.

## Who can make and change them

| Surface | Create | Read | Change |
|---|---|---|---|
| Dashboard | **New** in Artifacts (blank Doc, Slides, Sheets, Design, Motion) | gallery, table, the chat | the workspace editors; rename, pin, duplicate, restore |
| Agents | `artifact_create` (with `artifact_*` in `allowedTools`) | `artifact_get` (and any version), `artifact_list` | `artifact_update` (whole content or find / replace `edits`; `baseVersion`), `artifact_delete` — their own artifacts only |
| Polpo (chat) | the same tools | the same | the same, on any artifact |
| MCP | `polpo_artifact_create` | `polpo_artifacts_list` (filter by `type`, `kind`, words), `polpo_artifact_get` | `polpo_artifact_update` (content, title, description, pin; `baseVersion` → refused when it changed since) |
| REST | `POST /api/v1/artifacts` | `GET /api/v1/artifacts` (`?type`, `kind`, `createdBy`, `mine=true`, `sessionId`, `q`), `GET /api/v1/artifacts/:id` (`?preview=1`: a short excerpt for thumbnails) | `PATCH /api/v1/artifacts/:id` (`title`, `content`, `pinned`, `kind`, `description`, `tags`, `sources`, `refreshSeconds`, `note`; `expectedVersion` → 409 when it changed since), `POST /api/v1/artifacts/:id/duplicate` (`{ version? }`), `POST /api/v1/artifacts/:id/restore/:version`, `DELETE /api/v1/artifacts/:id` |

Limits: a content is at most 1 MB (a request at most 4 MB), and the last 30 versions are kept.

## Look

The editors' chrome (toolbars, panels, inspectors, the gallery, comments and dropdown chips, selection outlines, the live chart preview) follows the instance's look like every other screen (see [appearance.md](appearance.md)). What a person puts in a document is theirs: the colours picked for text, cells, shapes and slide themes stay as chosen, in the dashboard and in every export.
