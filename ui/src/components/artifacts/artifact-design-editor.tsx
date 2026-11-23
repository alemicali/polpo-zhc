import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Circle, Frame, Hand, Monitor, MousePointer2, Pencil, Shapes, Smartphone, Square, StickyNote, Tablet, Type } from "lucide-react";
import { parse, type DefaultTreeAdapterTypes } from "parse5";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
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

function instrumentCanvas(content: string, elements: Element[]) {
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
[data-polpo-design-active] { outline: 2px solid var(--polpo-design-highlight, #147d64) !important; outline-offset: -2px; }
html[data-polpo-design-tool="pan"], html[data-polpo-design-tool="pan"] * { cursor: grab !important; }
</style><script>
(() => {
  const attribute = ${JSON.stringify(NODE_ATTRIBUTE)};
  const channel = ${JSON.stringify(DESIGN_CHANNEL)};
  let drag, pan, drawing, active, tool = "select";
  const svgNS = "http://www.w3.org/2000/svg";
  const line = (points) => points.map(([x, y], index) => (index ? "L" : "M") + x + " " + y).join(" ");
  window.addEventListener("message", (event) => {
    const { data } = event;
    if (event.source !== parent || data?.channel !== channel || data.type !== "canvas-options") return;
    active?.removeAttribute("data-polpo-design-active");
    active = Number.isSafeInteger(data.selected) ? document.querySelector("[" + attribute + '="' + data.selected + '"]') : null;
    active?.setAttribute("data-polpo-design-active", "");
    tool = ["pan", "draw"].includes(data.tool) ? data.tool : "select";
    document.documentElement.setAttribute("data-polpo-design-tool", tool);
    if (typeof data.color === "string" && CSS.supports("color", data.color)) document.documentElement.style.setProperty("--polpo-design-highlight", data.color);
  });
  const send = (node, dx, dy) => parent.postMessage({ channel, node, dx, dy }, "*");
  window.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    if (tool === "draw") {
      event.preventDefault();
      event.stopImmediatePropagation();
      const overlay = document.createElementNS(svgNS, "svg");
      overlay.style.cssText = "position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:2147483647";
      const path = document.createElementNS(svgNS, "path");
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", "#416a9b");
      path.setAttribute("stroke-width", "3");
      path.setAttribute("stroke-linecap", "round");
      path.setAttribute("stroke-linejoin", "round");
      overlay.append(path);
      document.body.append(overlay);
      drawing = { overlay, path, left: scrollX, top: scrollY, points: [[event.clientX, event.clientY]] };
      event.target.setPointerCapture?.(event.pointerId);
      return;
    }
    if (tool === "pan") {
      event.preventDefault();
      event.stopImmediatePropagation();
      pan = { x: event.clientX, y: event.clientY, left: scrollX, top: scrollY };
      event.target.setPointerCapture?.(event.pointerId);
      return;
    }
    const target = event.target.closest?.("[" + attribute + "]");
    if (!target) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const node = Number(target.getAttribute(attribute));
    drag = { node, x: event.clientX, y: event.clientY, target, translate: target.style.translate,
      base: getComputedStyle(target).translate.split(/\\s+/).map(Number.parseFloat) };
    target.setPointerCapture?.(event.pointerId);
  }, true);
  window.addEventListener("pointermove", (event) => {
    if (drawing) {
      if (drawing.points.length < 900) drawing.points.push([event.clientX, event.clientY]);
      drawing.path.setAttribute("d", line(drawing.points));
      return;
    }
    if (pan) {
      scrollTo(pan.left + pan.x - event.clientX, pan.top + pan.y - event.clientY);
      return;
    }
    if (!drag) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (Math.hypot(dx, dy) < 4) return;
    drag.target.style.translate = ((drag.base[0] || 0) + dx) + "px " + ((drag.base[1] || 0) + dy) + "px";
  }, true);
  function release(event, cancelled) {
    if (drawing) {
      const { overlay, points, left, top } = drawing;
      drawing = undefined;
      overlay.remove();
      if (!cancelled && points.length > 1) parent.postMessage({
        channel, type: "stroke", points: points.map(([x, y]) => [Math.round(x + left), Math.round(y + top)])
      }, "*");
      return;
    }
    pan = undefined;
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

const INSERT_ITEMS = {
  text: { tag: "p", body: "New text", style: "margin: 1rem; font-size: 20px;" },
  section: { tag: "section", body: "<h2>New section</h2>", style: "padding: 2rem; margin: 1rem; min-height: 12rem; border: 1px solid currentColor; border-radius: .5rem;" },
  note: { tag: "aside", body: "Add a note", style: "width: min(100%, 14rem); margin: 1rem; padding: 1rem; border-radius: .4rem; background: #fff2bd; color: #342608;" },
  rectangle: { tag: "div", body: "", style: "width: 8rem; height: 5rem; margin: 1rem; background: #6186b4;" },
  circle: { tag: "div", body: "", style: "width: 6rem; height: 6rem; margin: 1rem; border-radius: 50%; background: #6186b4;" },
} as const;

function appendMarkup(content: string, markup: string) {
  const document = parse(content, { sourceCodeLocationInfo: true });
  const root = document.childNodes.find((node) => "tagName" in node && node.tagName === "html") as Element | undefined;
  const body = root?.childNodes.find((node) => "tagName" in node && node.tagName === "body") as Element | undefined;
  const offset = body?.sourceCodeLocation?.endTag?.startOffset ?? root?.sourceCodeLocation?.endTag?.startOffset ?? content.length;
  return applyPatches(content, [{ start: offset, end: offset, value: `
${markup}
` }]);
}

function insertElement(content: string, tag: keyof typeof INSERT_ITEMS) {
  const spec = INSERT_ITEMS[tag];
  const identity = `design-${crypto.randomUUID()}`;
  const next = appendMarkup(content, `<${spec.tag} id="${identity}" style="${spec.style}">${spec.body}</${spec.tag}>`);
  const index = collectElements(next).findIndex((node) => node.attrs.some((attr) => attr.name === "id" && attr.value === identity));
  return { next, index };
}

function addStroke(content: string, points: unknown): string | undefined {
  if (!Array.isArray(points) || points.length < 2 || points.length > 900) return;
  const coordinates = points.filter((point): point is [number, number] =>
    Array.isArray(point) && point.length === 2 && point.every((n) => Number.isSafeInteger(n) && Math.abs(n) < 32768));
  if (coordinates.length !== points.length) return;
  const xs = coordinates.map(([x]) => x);
  const ys = coordinates.map(([, y]) => y);
  const left = Math.min(...xs) - 2;
  const top = Math.min(...ys) - 2;
  const width = Math.max(...xs) - left + 2;
  const height = Math.max(...ys) - top + 2;
  const path = coordinates.map(([x, y], index) => `${index ? "L" : "M"}${x - left} ${y - top}`).join(" ");
  return appendMarkup(content, `<svg role="img" aria-label="Freehand line" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" style="position:absolute;left:${left}px;top:${top}px"><path d="${path}" fill="none" stroke="#416a9b" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>`);
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
  const [tool, setTool] = useState<"select" | "pan" | "draw">("select");
  const [viewport, setViewport] = useState<(typeof VIEWPORTS)[number]>(VIEWPORTS[0]);
  const elements = useMemo(() => collectElements(content), [content]);
  const html = useMemo(() => instrumentCanvas(content, elements), [content, elements]);
  const syncCanvas = useCallback(() => {
    canvas.current?.querySelector("iframe")?.contentWindow?.postMessage({
      channel: DESIGN_CHANNEL, type: "canvas-options", selected, tool,
      color: getComputedStyle(document.documentElement).getPropertyValue("--ring").trim(),
    }, "*");
  }, [selected, tool]);
  useEffect(() => { syncCanvas(); }, [syncCanvas]);

  function insert(kind: keyof typeof INSERT_ITEMS) {
    const { next, index } = insertElement(content, kind);
    setTool("select");
    setSelected(index >= 0 ? index : null);
    onChange(next);
  }

  const element = selected === null ? undefined : elements[selected];
  const textRange = element?.childNodes.every((child) => child.nodeName === "#text") && element.sourceCodeLocation?.endTag
    ? { start: element.sourceCodeLocation.startTag!.endOffset, end: element.sourceCodeLocation.endTag.startOffset }
    : null;
  const elementText = textRange ? element?.childNodes.map((child) => "value" in child ? child.value : "").join("") ?? "" : "";

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (event.source !== canvas.current?.querySelector("iframe")?.contentWindow) return;
      const data = event.data;
      if (data?.channel !== DESIGN_CHANNEL) return;
      if (data.type === "stroke") {
        if (tool === "draw") {
          const next = addStroke(content, data.points);
          if (next) onChange(next);
        }
        return;
      }
      if (tool !== "select" || !Number.isSafeInteger(data.node) || !elements[data.node]) return;
      setSelected(data.node);
      if (Number.isSafeInteger(data.dx) && Number.isSafeInteger(data.dy) && Math.abs(data.dx) <= 32768 && Math.abs(data.dy) <= 32768) {
        onChange(updateStyle(content, elements[data.node], { translate: `${data.dx}px ${data.dy}px` }));
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [content, elements, onChange, tool]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-card px-2 py-1.5 sm:px-3">
        <div className="flex items-center gap-1" role="toolbar" aria-label="Canvas tools">
          <Button size="icon" variant={tool === "select" ? "secondary" : "ghost"} className="size-8" onClick={() => setTool("select")}
            aria-label="Select elements" title="Select elements" aria-pressed={tool === "select"}><MousePointer2 /></Button>
          <Button size="icon" variant={tool === "pan" ? "secondary" : "ghost"} className="size-8" onClick={() => setTool("pan")}
            aria-label="Pan canvas" title="Pan canvas" aria-pressed={tool === "pan"}><Hand /></Button>
          <Button size="icon" variant={tool === "draw" ? "secondary" : "ghost"} className="size-8" onClick={() => setTool("draw")}
            aria-label="Draw freehand" title="Draw freehand" aria-pressed={tool === "draw"}><Pencil /></Button>
          <span className="mx-1 h-5 border-l border-border" aria-hidden="true" />
          <Button size="icon" variant="ghost" className="size-8" onClick={() => insert("text")} aria-label="Insert text" title="Insert text"><Type /></Button>
          <Button size="icon" variant="ghost" className="size-8" onClick={() => insert("section")} aria-label="Insert section" title="Insert section"><Frame /></Button>
          <Button size="icon" variant="ghost" className="size-8" onClick={() => insert("note")} aria-label="Insert note" title="Insert note"><StickyNote /></Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild><Button size="icon" variant="ghost" className="size-8" aria-label="Insert shape" title="Insert shape"><Shapes /></Button></DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem onSelect={() => insert("rectangle")}><Square /> Rectangle</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => insert("circle")}><Circle /> Circle</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
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
          <div ref={canvas} onLoadCapture={syncCanvas} className="mx-auto h-full max-w-full overflow-hidden rounded-md border bg-background shadow-sm" style={{ width: viewport.width }}>
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
                    value={elementText}
                    onChange={(event) => onChange(applyPatches(content, [{ ...textRange, value: escapeText(event.target.value) }]))} />
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
