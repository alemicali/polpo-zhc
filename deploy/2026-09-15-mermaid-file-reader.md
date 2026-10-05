# Integrated Mermaid file reader

The web file preview now recognizes `.mmd` and `.mermaid` (case-insensitive),
including files whose running backend still reports `application/octet-stream`.
Known Mermaid MIME aliases are recognized as well.

- Diagram and Source tabs; zoom, pan, reset, fullscreen, copy and diagram export
  reuse the installed Streamdown/Mermaid renderer.
- Dedicated full-size canvas and dark/light rendering; heavy renderer remains
  behind the existing lazy-loaded `RichStreamdown` boundary.
- Strict Mermaid security; original source is shown as escaped text, not HTML.
- Invalid/empty/oversized diagram messages preserve source/download access.
- Full file read avoids truncation at the text-preview API's 500-line limit.
  File previews have a 1 MB limit; diagrams over 50,000 characters are source-only.
- Pending fetches are aborted/ignored on close, switch or unmount.
- Task outcomes now use the same preview hook as Files and chat artifacts.
- Both Node and shared server route maps include `text/vnd.mermaid`.

## Verification and rollout

- 28 UI tests passed (16 file-reader tests plus 12 existing composer tests).
- 4 API tests passed across Node/shared routes: listing, MIME, full read,
  structured preview and path sandboxing.
- Shared server build, root TypeScript compile, OpenAPI regeneration and UI
  production build completed.
- Browser verification uses the actual Insurtech Files UI over Tailscale.
- Confirmed real SVG rendering of `flowchart-assicurativo.mmd` without
  changing that file; zoom changed the canvas transform, Source preserved
  the exact file text, and an invalid fixture displayed the parser error.
- Canvas verified at desktop size and 390px viewport (no page overflow),
  with dark/light theme switches updating SVG colors. Export menu offers
  SVG, PNG and MMD. Temporary QA fixtures were removed after checking.
- No new dependencies, Git push or EAS/native build needed.

The four web services serve the shared rebuilt `ui/dist` automatically.
Backends were deliberately NOT restarted: Insurtech had active agent tasks.
Their MIME-map additions will load at the next normal backend restart, but
are not required for the reader: filename detection works with the old MIME
response and the existing `/files/read` endpoint.

Existing PWA tabs may retain the previous service worker until all tabs/windows
for that instance are closed. Close and reopen the web app if a refresh alone
still shows the old file preview.
