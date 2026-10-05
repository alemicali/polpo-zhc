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
 *
 * Layout knobs (driven by the LLM via render_widget args):
 *   • chrome=false → no border/header, the widget sits on a transparent
 *     canvas (perfect for shaped/free-form widgets).
 *   • fullWidth=false → width fits content (max-content) instead of
 *     filling the bubble. Combined with chrome=false this gives you a
 *     compact widget shaped exactly to its contents.
 *   • height=null → auto-size at runtime: a tiny shim injected into
 *     the iframe head measures `body.scrollHeight` (via ResizeObserver)
 *     and posts it to the parent, which sets the iframe height
 *     accordingly. iframes don't auto-fit content by themselves —
 *     this postMessage trick is the only cross-origin-safe way to do it.
 *   • height=number → forced (clamped 120..800).
 */
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Boxes, AlertTriangle, ChevronDown, ChevronUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { WidgetRenderData } from "@/hooks/use-polpo";

const MAX_HTML_BYTES = 16384;
const MIN_HEIGHT = 60;
const MAX_HEIGHT = 1200;
const DEFAULT_HEIGHT = 320;
/** Magic identifier for postMessage payloads from the widget shim. */
const RESIZE_CHANNEL = "polpo:widget:resize";

function clampHeight(h: number): number {
  if (!Number.isFinite(h)) return DEFAULT_HEIGHT;
  return Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, h));
}

/** Tiny resize shim: measures body.scrollHeight whenever it changes
 *  (initial paint, fonts loaded, ResizeObserver fires) and posts it
 *  to the parent. The parent applies it as iframe.style.height.
 *  Must be inline JS (no external src — CSP forbids it). */
const RESIZE_SHIM = `<script>
(function(){
  var ch=${JSON.stringify(RESIZE_CHANNEL)};
  function send(){
    try{
      var h = Math.max(
        document.documentElement.scrollHeight||0,
        document.body ? document.body.scrollHeight : 0,
        document.body ? document.body.offsetHeight : 0
      );
      parent.postMessage({channel:ch,height:h},'*');
    }catch(e){}
  }
  // Initial + on load
  if(document.readyState!=='loading') send();
  document.addEventListener('DOMContentLoaded',send);
  window.addEventListener('load',send);
  // ResizeObserver on body for any post-load layout shift
  try{
    var ro=new ResizeObserver(send);
    if(document.body) ro.observe(document.body);
    else document.addEventListener('DOMContentLoaded',function(){ro.observe(document.body);});
  }catch(e){
    // Older browsers — fall back to a few timed ticks
    [50,200,500,1000,2000].forEach(function(d){setTimeout(send,d);});
  }
})();
</script>`;

function composeHtml(rawHtml: string, autoSize: boolean): string {
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
/* Scrollbar thin (di norma il widget non dovrebbe scrollare grazie all'auto-height,
   ma se sfora — overflow forzato dal modello — vogliamo che sia discreta). */
* { scrollbar-width: thin; scrollbar-color: rgba(127,127,127,0.35) transparent; }
::-webkit-scrollbar { width: 4px; height: 4px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: rgba(127,127,127,0.35); border-radius: 4px; }
::-webkit-scrollbar-thumb:hover { background: rgba(127,127,127,0.55); }
</style>
${autoSize ? RESIZE_SHIM : ""}
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

function WidgetCardImpl({ widget }: { widget: WidgetRenderData }) {
  const [collapsed, setCollapsed] = useState(false);
  const [iframeError, setIframeError] = useState(false);

  // Layout knobs from the LLM. Default = previous behaviour (chrome on,
  // full width) so existing widgets aren't affected.
  // L'altezza è SEMPRE auto via postMessage — niente parametro height
  // esposto al modello (l'iframe si misura da solo). Mantiene il
  // campo nei tipi solo per compat con vecchi payload persistiti.
  const chrome = widget.chrome !== false;
  const fullWidth = true;
  const autoSize = true;

  const oversized = useMemo(() => byteLen(widget.html ?? "") > MAX_HTML_BYTES, [widget.html]);
  // Mentre lo stream è ancora live l'HTML è frequentemente invalido
  // (tag aperti, script non chiusi). Lo wrappiamo con un try/catch sui
  // SyntaxError dello script in modo che un'iframe rotta non blocchi
  // la pagina. CSP e sandbox ci proteggono comunque.
  const composedHtml = useMemo(
    () => (oversized ? null : composeHtml(widget.html ?? "", autoSize && !widget.streaming)),
    [widget.html, oversized, autoSize, widget.streaming]
  );

  // When forced: clamp once. When auto: start small (fast paint, then
  // snap to real height the moment the shim posts back).
  const [autoHeight, setAutoHeight] = useState<number>(MIN_HEIGHT);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  // Listen for resize messages ONLY from our iframe (defense-in-depth:
  // also accept anonymous source since sandbox="allow-scripts" runs in
  // null origin → event.source can be the iframe's contentWindow).
  useEffect(() => {
    if (!autoSize) return;
    const onMessage = (e: MessageEvent) => {
      const data = e.data as unknown;
      if (!data || typeof data !== "object") return;
      const obj = data as { channel?: string; height?: number };
      if (obj.channel !== RESIZE_CHANNEL) return;
      // Optional source check: only accept from this iframe's window.
      if (iframeRef.current && e.source !== iframeRef.current.contentWindow) return;
      const h = typeof obj.height === "number" ? obj.height : 0;
      if (h > 0) setAutoHeight(clampHeight(h));
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [autoSize]);

  // Durante stream live, l'auto-resize via postMessage è disabilitato
  // (lo shim non viene iniettato): l'HTML cambia ad ogni batch e l'altezza
  // ballerebbe. Usiamo invece un'altezza fissa "comoda" che si stabilizza
  // sul valore reale solo quando il widget è finalizzato.
  const effectiveHeight = widget.streaming ? DEFAULT_HEIGHT : autoHeight;
  const title = widget.title?.trim() || widget.description?.trim() || "Interactive widget";

  // Hard fallback — payload too big for the client to safely render.
  if (oversized) {
    return (
      <div className="my-3 overflow-hidden rounded-xl border border-destructive/30 bg-destructive/[0.04]">
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

  // The iframe element — used in both chrome and chrome-less modes.
  const iframe = iframeError ? (
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
      ref={iframeRef}
      srcDoc={composedHtml ?? ""}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      loading="lazy"
      onError={() => setIframeError(true)}
      style={{
        border: 0,
        width: "100%",
        height: effectiveHeight,
        display: "block",
        background: "transparent",
      }}
      title={title}
    />
  );

  // Chrome-less: render a bare iframe on a transparent canvas. Honors
  // fullWidth (full-bleed vs fit-content). No header, no border, the
  // widget IS the content.
  if (!chrome) {
    return (
      <div
        className="mobile-no-x my-3"
        style={{
          width: fullWidth ? "100%" : "max-content",
          maxWidth: "100%",
          background: "transparent",
        }}
      >
        {iframe}
      </div>
    );
  }

  // Chrome on (default): full card with border, header, collapse toggle.
  return (
    <div
      className="mobile-no-x my-3 overflow-hidden rounded-xl border border-primary/20 bg-primary/[0.03]"
      style={{
        width: fullWidth ? undefined : "max-content",
        maxWidth: "100%",
      }}
    >
      {/* Header — entirely clickable: tap anywhere on the bar toggles
          collapse. Use a real <button> per a11y/keyboard support. */}
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        aria-label={collapsed ? "Expand widget" : "Collapse widget"}
        aria-expanded={!collapsed}
        className="flex w-full items-center gap-2 border-b border-primary/10 bg-primary/[0.02] px-3 py-2 text-left transition-colors hover:bg-primary/[0.05] focus-visible:outline-none focus-visible:bg-primary/[0.06] sm:px-4 sm:py-3"
      >
        <Boxes className="h-3.5 w-3.5 shrink-0 text-primary sm:h-4 sm:w-4" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold truncate">{title}</p>
          {widget.description && widget.description !== widget.title && (
            <p className="text-[11px] text-muted-foreground truncate">{widget.description}</p>
          )}
        </div>
        <Badge
          variant="outline"
          className={`hidden shrink-0 text-[10px] sm:inline-flex ${widget.streaming ? "animate-pulse border-primary/40 text-primary" : ""}`}
        >
          {widget.streaming ? "Live" : "Widget"}
        </Badge>
        <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center text-muted-foreground">
          {collapsed ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronUp className="h-3.5 w-3.5" />}
        </span>
      </button>

      {/* Body */}
      {!collapsed && iframe}
    </div>
  );
}

// Memoizziamo: il messaggio padre re-renderizza ad ogni chunk SSE
// (text delta, thinking delta, tool delta...) ma se il widget non
// è cambiato, l'iframe NON deve essere re-toccato. Compare profondo
// solo sui field che impattano il rendering — così uno stream "nudo"
// di prose accanto a un widget fermo NON re-renderizza l'iframe.
export const WidgetCard = memo(
  WidgetCardImpl,
  (prev, next) =>
    prev.widget.html === next.widget.html &&
    prev.widget.title === next.widget.title &&
    prev.widget.description === next.widget.description &&
    prev.widget.chrome === next.widget.chrome &&
    prev.widget.streaming === next.widget.streaming
);

/**
 * WidgetPendingCard — placeholder mostrato quando il modello sta scrivendo
 * gli arguments del render_widget MA non c'è ancora il campo `html` nel
 * JSON parziale (es. emette title/chrome prima). Visivamente:
 *   • stessa "shell" della WidgetCard chrome=true (border + header)
 *   • icona Boxes pulsante
 *   • "Preparing widget…" + byte counter dalla argumentsText length
 *
 * Niente iframe, niente CSP, niente layout shift — è solo un mini-card
 * statico. Quando il primo chunk con html parziale arriva, il renderer
 * padre swappa con la vera WidgetCard nello stesso slot del segment.
 */
export function WidgetPendingCard({ argsBytes }: { argsBytes?: number }) {
  return (
    <div className="mobile-no-x my-3 overflow-hidden rounded-xl border border-primary/15 bg-gradient-to-br from-primary/[0.03] via-primary/[0.015] to-transparent backdrop-blur-sm">
      <style>{LEONARDO_KEYFRAMES}</style>
      <div className="flex items-center gap-2 border-b border-primary/10 bg-primary/[0.02] px-3 py-2 sm:px-4 sm:py-3">
        <Boxes className="h-3.5 w-3.5 shrink-0 text-primary animate-pulse sm:h-4 sm:w-4" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold truncate">Drafting widget…</p>
          {typeof argsBytes === "number" && argsBytes > 0 && (
            <p className="text-[11px] text-muted-foreground tabular-nums">
              {argsBytes.toLocaleString()} chars
            </p>
          )}
        </div>
        <Badge variant="outline" className="hidden shrink-0 text-[10px] sm:inline-flex animate-pulse border-primary/40 text-primary">
          Live
        </Badge>
      </div>
      <LeonardoSkeleton />
    </div>
  );
}

/**
 * Skeleton "stile Da Vinci × Apple": un wireframe geometrico animato che
 * si AUTODISEGNA tracciando linee, cerchi e righelli — come uno schizzo
 * tecnico che prende forma da un foglio bianco. Tutto pure SVG, niente
 * dipendenze, niente raster. Animazione via stroke-dasharray (le linee
 * si "rivelano" lungo il proprio path).
 */
function LeonardoSkeleton() {
  // Coordinate: viewBox 320×180 — proporzioni cinema, dà aria al disegno.
  // I path sono organizzati in 4 layer:
  //   1. Cornice esterna (frame del widget, primo a comparire)
  //   2. Cerchio centrale + asse (idea ispirata Vitruviano, semplificato)
  //   3. Linee guide e righelli laterali (ticks tecnici)
  //   4. "Misurazioni" testuali falsy ad appearance graduale
  return (
    <div className="px-4 py-5 sm:px-6 sm:py-7" aria-hidden="true">
      <svg
        viewBox="0 0 320 180"
        className="w-full"
        style={{ maxHeight: 200 }}
      >
        <defs>
          <linearGradient id="dv-fade" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="currentColor" stopOpacity="0.55" />
            <stop offset="50%" stopColor="currentColor" stopOpacity="0.85" />
            <stop offset="100%" stopColor="currentColor" stopOpacity="0.55" />
          </linearGradient>
        </defs>
        <g
          className="text-primary/70"
          stroke="url(#dv-fade)"
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="0.75"
        >
          {/* Frame esterno — si disegna per primo */}
          <rect
            x="14"
            y="14"
            width="292"
            height="152"
            rx="8"
            ry="8"
            style={{
              strokeDasharray: 900,
              strokeDashoffset: 900,
              animation: "dv-draw 1.4s ease-out 0s forwards, dv-pulse 3.4s ease-in-out 1.4s infinite",
            }}
          />
          {/* Asse orizzontale — separator interno */}
          <line
            x1="14" y1="48" x2="306" y2="48"
            style={{
              strokeDasharray: 300,
              strokeDashoffset: 300,
              animation: "dv-draw 0.9s ease-out 0.6s forwards, dv-pulse 3.4s ease-in-out 1.5s infinite",
            }}
          />
          {/* Cerchio centrale grande (proporzione vitruviana) */}
          <circle
            cx="160" cy="110" r="40"
            style={{
              strokeDasharray: 252,
              strokeDashoffset: 252,
              animation: "dv-draw 1.6s ease-out 0.9s forwards, dv-pulse 3.4s ease-in-out 2.5s infinite",
            }}
          />
          {/* Quadrato inscritto */}
          <rect
            x="124" y="74" width="72" height="72"
            style={{
              strokeDasharray: 288,
              strokeDashoffset: 288,
              animation: "dv-draw 1.4s ease-out 1.4s forwards, dv-pulse 3.4s ease-in-out 2.8s infinite",
            }}
          />
          {/* Diagonali (golden ratio cross) */}
          <line
            x1="124" y1="74" x2="196" y2="146"
            style={{
              strokeDasharray: 102,
              strokeDashoffset: 102,
              animation: "dv-draw 0.8s ease-out 1.9s forwards, dv-pulse 3.4s ease-in-out 2.7s infinite",
            }}
          />
          <line
            x1="196" y1="74" x2="124" y2="146"
            style={{
              strokeDasharray: 102,
              strokeDashoffset: 102,
              animation: "dv-draw 0.8s ease-out 2.05s forwards, dv-pulse 3.4s ease-in-out 2.85s infinite",
            }}
          />
          {/* Misurazioni laterali — righello a sinistra (tratti tecnici) */}
          {[0, 1, 2, 3, 4, 5, 6].map((i) => (
            <line
              key={`tl-${i}`}
              x1="22" y1={62 + i * 14} x2={i % 2 === 0 ? 32 : 28} y2={62 + i * 14}
              style={{
                strokeDasharray: 12,
                strokeDashoffset: 12,
                animation: `dv-draw 0.4s ease-out ${0.4 + i * 0.05}s forwards, dv-pulse 3.4s ease-in-out ${1.5 + i * 0.08}s infinite`,
              }}
            />
          ))}
          {/* Righello a destra */}
          {[0, 1, 2, 3, 4, 5, 6].map((i) => (
            <line
              key={`tr-${i}`}
              x1="298" y1={62 + i * 14} x2={i % 2 === 0 ? 288 : 292} y2={62 + i * 14}
              style={{
                strokeDasharray: 12,
                strokeDashoffset: 12,
                animation: `dv-draw 0.4s ease-out ${0.5 + i * 0.05}s forwards, dv-pulse 3.4s ease-in-out ${1.7 + i * 0.08}s infinite`,
              }}
            />
          ))}
          {/* Mire / target dots agli angoli */}
          {[
            [22, 22], [298, 22], [22, 158], [298, 158],
          ].map(([cx, cy], i) => (
            <g key={`m-${i}`} style={{
              opacity: 0,
              animation: `dv-fade 0.6s ease-out ${0.2 + i * 0.1}s forwards, dv-pulse 3.4s ease-in-out ${1.8 + i * 0.1}s infinite`,
            }}>
              <circle cx={cx} cy={cy} r="2" fill="currentColor" fillOpacity="0.6" />
              <circle cx={cx} cy={cy} r="5" />
            </g>
          ))}
          {/* "Penna" — punto luminoso che traccia un'orbita lenta sul
              cerchio centrale, suggerisce il disegno in corso. */}
          <circle
            cx="160" cy="110" r="3"
            fill="currentColor"
            fillOpacity="0.9"
            stroke="none"
            style={{
              transformOrigin: "160px 110px",
              animation: "dv-orbit 3.2s linear 2.4s infinite",
            }}
          />
        </g>
      </svg>
    </div>
  );
}

const LEONARDO_KEYFRAMES = `
@keyframes dv-draw {
  to { stroke-dashoffset: 0; }
}
@keyframes dv-fade {
  to { opacity: 1; }
}
@keyframes dv-pulse {
  0%, 100% { opacity: 0.85; }
  50% { opacity: 0.45; }
}
@keyframes dv-orbit {
  from { transform: rotate(0deg) translate(40px) rotate(0deg); }
  to { transform: rotate(360deg) translate(40px) rotate(-360deg); }
}
`;
