/**
 * WidgetCard — renders an interactive HTML widget emitted by the
 * `render_widget` tool inside a sandboxed null-origin iframe.
 *
 * Defense-in-depth (the backend already validates and forbids external
 * resources / nested iframes):
 *   • sandbox="allow-scripts" only — NO allow-same-origin, so the iframe
 *     can't read parent cookies/localStorage or hit the backend.
 *   • CSP `default-src 'none'` injected into the document head — blocks
 *     any fetch/XHR/WebSocket/connect, even from inline scripts.
 *   • srcDoc is rendered once; we never touch the LLM-supplied HTML
 *     beyond wrapping it (regex sanitizers are fragile — the CSP gates
 *     resources, the sandbox gates origin access).
 *   • Hard byte cap (16 KiB) — twice the server limit, just so a buggy
 *     server can't tank the renderer.
 */
import { useMemo, useState } from "react";
import { Boxes, AlertTriangle, ChevronDown, ChevronUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { WidgetRenderData } from "@/hooks/use-polpo";

const MAX_HTML_BYTES = 16384;
const MIN_HEIGHT = 120;
const MAX_HEIGHT = 800;
const DEFAULT_HEIGHT = 320;

function clampHeight(h: number | null | undefined): number {
  const n = typeof h === "number" && Number.isFinite(h) ? h : DEFAULT_HEIGHT;
  return Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, n));
}

function composeHtml(rawHtml: string): string {
  // Wrap the LLM-supplied fragment in a full document with a strict CSP.
  // We keep `rawHtml` byte-for-byte (no regex stripping) — the CSP gates
  // anything risky (no fetch, no XHR, no remote img/link/script).
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; font-src data:;">
<style>
:root { color-scheme: light dark; }
html, body { margin:0; padding:0; box-sizing:border-box; }
body { font: 14px/1.45 -apple-system, BlinkMacSystemFont, 'Inter', system-ui, sans-serif; color: light-dark(#111, #eee); background: transparent; }
*, *::before, *::after { box-sizing: inherit; }
</style>
</head>
<body>
${rawHtml}
</body>
</html>`;
}

function byteLen(s: string): number {
  // Browsers don't ship Buffer — use TextEncoder to count UTF-8 bytes.
  if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(s).length;
  // Fallback for very old environments
  return s.length;
}

export function WidgetCard({ widget }: { widget: WidgetRenderData }) {
  const [collapsed, setCollapsed] = useState(false);
  const [iframeError, setIframeError] = useState(false);

  const oversized = useMemo(() => byteLen(widget.html ?? "") > MAX_HTML_BYTES, [widget.html]);
  const composedHtml = useMemo(
    () => (oversized ? null : composeHtml(widget.html ?? "")),
    [widget.html, oversized]
  );
  const height = clampHeight(widget.height ?? undefined);

  const title = widget.title?.trim() || widget.description?.trim() || "Interactive widget";

  // Hard fallback — payload too big for the client to safely render.
  if (oversized) {
    return (
      <div className="mt-3 overflow-hidden rounded-xl border border-destructive/30 bg-destructive/[0.04]">
        <div className="flex items-center gap-2 border-b border-destructive/20 bg-destructive/[0.03] px-4 py-3">
          <AlertTriangle className="h-4 w-4 shrink-0 text-destructive" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold truncate">Widget too large</p>
            <p className="text-[11px] text-muted-foreground">
              The widget HTML exceeds {MAX_HTML_BYTES.toLocaleString()} bytes and was not rendered.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mobile-no-x mt-3 overflow-hidden rounded-xl border border-primary/20 bg-primary/[0.03]">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-primary/10 bg-primary/[0.02] px-3 py-2 sm:px-4 sm:py-3">
        <Boxes className="h-3.5 w-3.5 shrink-0 text-primary sm:h-4 sm:w-4" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold truncate">{title}</p>
          {widget.description && widget.description !== widget.title && (
            <p className="text-[11px] text-muted-foreground truncate">{widget.description}</p>
          )}
        </div>
        <Badge variant="outline" className="hidden shrink-0 text-[10px] sm:inline-flex">
          Widget
        </Badge>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground"
          onClick={() => setCollapsed((c) => !c)}
          aria-label={collapsed ? "Expand widget" : "Collapse widget"}
        >
          {collapsed ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronUp className="h-3.5 w-3.5" />}
        </Button>
      </div>

      {/* Body */}
      {!collapsed && (
        iframeError ? (
          <div className="px-4 py-6 text-center">
            <AlertTriangle className="mx-auto h-5 w-5 text-muted-foreground" />
            <p className="mt-2 text-xs text-muted-foreground">Failed to load widget.</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-3 h-7 text-xs"
              onClick={() => setIframeError(false)}
            >
              Try again
            </Button>
          </div>
        ) : (
          <iframe
            srcDoc={composedHtml ?? ""}
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            loading="lazy"
            onError={() => setIframeError(true)}
            style={{ border: 0, width: "100%", height, display: "block", background: "transparent" }}
            title={title}
          />
        )
      )}
    </div>
  );
}
