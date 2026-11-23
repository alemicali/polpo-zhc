import { useEffect, useMemo, useRef, useState } from "react";
import { Monitor, MousePointer2, Smartphone, Tablet } from "lucide-react";
import { parse, type DefaultTreeAdapterTypes } from "parse5";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ArtifactFrame } from "./artifact-frame";
import type { Artifact } from "@/lib/artifacts-api";

export const DESIGN_STARTER = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  * { box-sizing: border-box; }
  body { margin: 0; background: #f2f0ea; color: #192620; font: 16px system-ui, sans-serif; }
  main { min-height: 100vh; display: grid; align-content: center; gap: 1rem; padding: clamp(2rem, 10vw, 8rem); }
  h1 { margin: 0; max-width: 12ch; font: 600 clamp(2.5rem, 8vw, 6rem)/1 Georgia, serif; }
  p { max-width: 40ch; line-height: 1.65; }
  a { justify-self: start; background: #214b38; color: white; border-radius: 6px; padding: .8rem 1.25rem; text-decoration: none; }
</style>
</head>
<body>
<main>
  <h1>Start with an idea.</h1>
  <p>Use this canvas to lay out a page and edit its elements.</p>
  <a href="#details">Learn more</a>
</main>
</body>
</html>`;

const NODE_ATTRIBUTE = "data-polpo-design-node";
const DESIGN_CHANNEL = "polpo:design-selection";
const HIDDEN_TAGS = new Set(["html", "head", "body", "style", "script", "meta", "base", "link", "title", "template", "noscript", "iframe"]);

type Element = DefaultTreeAdapterTypes.Element;
type Patch = { start: number; end: number; value: string };

function applyPatches(source: string, patches: Patch[]) {
  return patches.sort((a, b) => b.start - a.start).reduce(
    (result, { start, end, value }) => result.slice(0, start) + value + result.slice(end),
    source,
  );
}

function collectElements(content: string) {
  const elements: Element[] = [];
  function visit(node: DefaultTreeAdapterTypes.Node) {
    if ("tagName" in node && node.sourceCodeLocation?.startTag && !HIDDEN_TAGS.has(node.tagName)) elements.push(node);
    if ("childNodes" in node) node.childNodes.forEach(visit);
  }
  visit(parse(content, { sourceCodeLocationInfo: true }));
  return elements;
}

function escapeText(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function styleFor(element: Element): CSSStyleDeclaration {
  const style = document.createElement("span").style;
  style.cssText = element.attrs.find((attr) => attr.name === "style")?.value ?? "";
  return style;
}

function updateStyle(source: string, element: Element, values: Record<string, string>) {
  const location = element.sourceCodeLocation!.startTag!;
  const attribute = element.sourceCodeLocation!.attrs?.style;
  const style = styleFor(element);
  Object.entries(values).forEach(([property, value]) => {
    if (value) style.setProperty(property, value);
    else style.removeProperty(property);
  });
  const value = ` style="${escapeText(style.cssText).replaceAll('"', "&quot;")}"`;
  const at = location.startOffset + /^<[^\s/>]+/.exec(source.slice(location.startOffset))![0].length;
  return applyPatches(source, [attribute
    ? { start: attribute.startOffset, end: attribute.endOffset, value: value.slice(1) }
    : { start: at, end: at, value }]);
}

function instrumentCanvas(content: string, elements: Element[], selected: number | null) {
  const patches = elements.map((element, i) => {
    const tag = element.sourceCodeLocation!.startTag!;
    const attribute = element.sourceCodeLocation!.attrs?.[NODE_ATTRIBUTE];
    const at = tag.startOffset + /^<[^\s/>]+/.exec(content.slice(tag.startOffset))![0].length;
    return attribute
      ? { start: attribute.startOffset, end: attribute.endOffset, value: `${NODE_ATTRIBUTE}="${i}"` }
      : { start: at, end: at, value: ` ${NODE_ATTRIBUTE}="${i}"` };
  });
  return applyPatches(content, patches) + `<style>
[${NODE_ATTRIBUTE}] { cursor: crosshair !important; }
[${NODE_ATTRIBUTE}="${selected}"] { outline: 2px solid #147d64 !important; outline-offset: -2px; }
</style><script>
(() => {
  const attribute = ${JSON.stringify(NODE_ATTRIBUTE)};
  const channel = ${JSON.stringify(DESIGN_CHANNEL)};
  let drag;
  const send = (node, dx, dy) => parent.postMessage({ channel, node, dx, dy }, "*");
  window.addEventListener("pointerdown", (event) => {
    const target = event.target.closest?.("[" + attribute + "]");
    if (!target || event.button !== 0) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const node = Number(target.getAttribute(attribute));
    drag = { node, x: event.clientX, y: event.clientY, target, translate: target.style.translate,
      base: getComputedStyle(target).translate.split(/\\s+/).map(Number.parseFloat) };
    target.setPointerCapture?.(event.pointerId);
  }, true);
  window.addEventListener("pointermove", (event) => {
    if (!drag) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (Math.hypot(dx, dy) < 4) return;
    drag.target.style.translate = ((drag.base[0] || 0) + dx) + "px " + ((drag.base[1] || 0) + dy) + "px";
  }, true);
  function release(event, cancelled) {
    if (!drag) return;
    const { node, x, y, target, translate, base } = drag;
    drag = undefined;
    target.style.translate = translate;
    const dx = Math.round(event.clientX - x);
    const dy = Math.round(event.clientY - y);
    if (cancelled || Math.hypot(dx, dy) < 4) send(node);
    else send(node, Math.round((base[0] || 0) + dx), Math.round((base[1] || 0) + dy));
  }
  window.addEventListener("pointerup", (event) => release(event, false), true);
  window.addEventListener("pointercancel", (event) => release(event, true), true);
  window.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
})();
</script>`;
}

const VIEWPORTS = [
  { name: "Desktop", width: "100%", icon: Monitor },
  { name: "Tablet", width: 768, icon: Tablet },
  { name: "Mobile", width: 390, icon: Smartphone },
] as const;

const STYLE_FIELDS = [
  { property: "font-size", label: "Font size", placeholder: "24px" },
  { property: "color", label: "Text color", placeholder: "#192620" },
  { property: "background-color", label: "Background", placeholder: "#f2f0ea" },
  { property: "width", label: "Width", placeholder: "auto" },
  { property: "height", label: "Height", placeholder: "auto" },
  { property: "border-radius", label: "Corner radius", placeholder: "8px" },
  { property: "padding", label: "Padding", placeholder: "16px" },
  { property: "translate", label: "Position offset", placeholder: "0px 0px" },
] as const;

type DesignArtifact = Pick<Artifact, "id" | "title" | "refreshSeconds">;

export function ArtifactDesignEditor({ artifact, content, onChange, refreshKey }: {
  artifact: DesignArtifact;
  content: string;
  onChange: (content: string) => void;
  refreshKey?: number;
}) {
  const canvas = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [viewport, setViewport] = useState<(typeof VIEWPORTS)[number]>(VIEWPORTS[0]);
  const elements = useMemo(() => collectElements(content), [content]);
  const html = useMemo(() => instrumentCanvas(content, elements, selected), [content, elements, selected]);
  const element = selected === null ? undefined : elements[selected];
  const textRange = element?.childNodes.every((child) => child.nodeName === "#text") && element.sourceCodeLocation?.endTag
    ? { start: element.sourceCodeLocation.startTag!.endOffset, end: element.sourceCodeLocation.endTag.startOffset }
    : null;
  const elementText = textRange ? element?.childNodes.map((child) => "value" in child ? child.value : "").join("") ?? "" : "";

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (event.source !== canvas.current?.querySelector("iframe")?.contentWindow) return;
      const data = event.data;
      if (data?.channel !== DESIGN_CHANNEL || !Number.isSafeInteger(data.node) || !elements[data.node]) return;
      setSelected(data.node);
      if (Number.isSafeInteger(data.dx) && Number.isSafeInteger(data.dy) && Math.abs(data.dx) <= 32768 && Math.abs(data.dy) <= 32768) {
        onChange(updateStyle(content, elements[data.node], { translate: `${data.dx}px ${data.dy}px` }));
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [content, elements, onChange]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
        <span className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <MousePointer2 className="size-3.5" /> Canvas
        </span>
        <div className="flex gap-1" aria-label="Canvas viewport">
          {VIEWPORTS.map((option) => (
            <Button key={option.name} size="icon" variant={option === viewport ? "secondary" : "ghost"}
              className="size-8" onClick={() => setViewport(option)} aria-label={option.name} aria-pressed={option === viewport}>
              <option.icon className="size-4" />
            </Button>
          ))}
        </div>
      </div>
      <div className="grid min-h-0 flex-1 grid-rows-[minmax(12rem,1fr)_minmax(0,auto)] overflow-auto md:grid-cols-[minmax(0,1fr)_15rem] md:grid-rows-1">
        <div className="min-h-0 overflow-hidden bg-muted/50 p-2 md:p-4">
          <div ref={canvas} className="mx-auto h-full max-w-full overflow-hidden rounded-md border bg-background shadow-sm" style={{ width: viewport.width }}>
            <ArtifactFrame artifactId={artifact.id} title={artifact.title} html={html} refreshSeconds={artifact.refreshSeconds} refreshKey={refreshKey} />
          </div>
        </div>
        <aside className="overflow-auto border-t bg-card px-3 py-3 md:border-l md:border-t-0" aria-label="Element properties">
          <label className="grid gap-1.5 text-xs font-medium">
            Element
            <select className="h-8 rounded-md border border-input bg-background px-2 text-xs" value={selected ?? ""}
              onChange={(event) => setSelected(event.target.value ? Number(event.target.value) : null)}>
              <option value="">Select an element</option>
              {elements.map((node, index) => (
                <option key={index} value={index}>{node.tagName}{node.attrs.find((attr) => attr.name === "id")?.value ? ` #${node.attrs.find((attr) => attr.name === "id")!.value}` : ""}</option>
              ))}
            </select>
          </label>
          {!element ? <p className="mt-3 text-xs leading-relaxed text-muted-foreground">Select an element on the canvas to edit its properties. Drag it to adjust its position.</p> : (
            <div className="mt-4 grid gap-3" key={selected}>
              {textRange && (
                <label className="grid gap-1.5 text-xs font-medium">
                  Text
                  <textarea className="min-h-16 resize-y rounded-md border border-input bg-background px-2 py-1.5 text-sm"
                    key={elementText} defaultValue={elementText}
                    onBlur={(event) => {
                      if (event.target.value !== elementText) onChange(applyPatches(content, [{ ...textRange, value: escapeText(event.target.value) }]));
                    }} />
                </label>
              )}
              {STYLE_FIELDS.map(({ property, label, placeholder }) => {
                const value = styleFor(element).getPropertyValue(property);
                return (
                  <label key={property} className="grid gap-1.5 text-xs font-medium">
                    {label}
                    <Input key={value} className="h-8 text-xs" defaultValue={value} placeholder={placeholder}
                      onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
                      onBlur={(event) => {
                        const next = event.target.value.trim();
                        if (next === value) return;
                        if (!next || CSS.supports(property, next)) onChange(updateStyle(content, element, { [property]: next }));
                        else event.target.value = value;
                      }} />
                  </label>
                );
              })}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
