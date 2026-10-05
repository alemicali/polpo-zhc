# Mermaid zoom sharpness and collapsible user messages

## Changes

- Override Streamdown's inline `will-change: transform` with `auto !important`
  on Mermaid pan/zoom surfaces. Disable transform interpolation there as well.
  This allows rasterization at the new scale instead of enlarging a cached
  low-resolution layer. The selector also covers the fullscreen portal.
- User-message text is collapsed to 240px by default when it overflows.
  `Mostra tutto` / `Riduci` expose and collapse the complete content.
  ResizeObserver measures actual rendered height, including width changes.
  Message IDs key the component; observers disconnect on unmount.
- Attachments and the existing complete-text copy action remain outside the
  clipped text area. Stored/sent content and assistant messages are unchanged.

## Verification

- 33 UI tests pass, including CSS regression checks for inline-style override
  and fullscreen scope, and four collapse/expand/resize/lifecycle tests.
- UI TypeScript and Vite production build pass.
- Browser verification on Insurtech's actual Mermaid file: at 3x zoom the
  computed `will-change` is `auto`, transition duration is `0s`, and screenshot
  text/lines are sharp. Verified the same CSS in Mermaid fullscreen.
- Browser verification on an existing 17,405-character user message:
  collapsed height 240px, expanded height 9032px, then collapsed back to 240px;
  text length unchanged throughout. No test messages sent or model calls made.
- Shared web build served directly by the four UI services. No backend
  restarts, no EAS/native build, no Git push.

Close/reopen the PWA or all instance tabs if the previous service worker is
still serving the old interface.
