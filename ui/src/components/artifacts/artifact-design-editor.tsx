import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  Circle,
  Download,
  Expand,
  Frame,
  Hand,
  Layers,
  Maximize2,
  MousePointer2,
  PanelRight,
  Pencil,
  Play,
  Plus,
  Shapes,
  Square,
  StickyNote,
  Type,
  X,
} from "lucide-react";
import { parse, type DefaultTreeAdapterTypes } from "parse5";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { DESIGN_COLOR_PLACEHOLDERS, DESIGN_NOTE, DESIGN_SHAPE_FILL, DESIGN_STROKE } from "./artifact-content-palette";
import { ArtifactFrame } from "./artifact-frame";
import { artifactStaticPreview } from "./artifact-static-preview";
import type { Artifact } from "@/lib/artifacts-api";

import { BLANK_BOARD, createBoard, readDesign, writeDesign, type Artboard, type DesignPage } from "./design-workspace";

import { DesignLayers, DesignTweaks } from "./design-inspector";

export const DESIGN_STARTER = BLANK_BOARD;

const NODE_ATTRIBUTE = "data-polpo-design-node";
const DESIGN_CHANNEL = "polpo:design-selection";
const HIDDEN_TAGS = new Set([
  "path",
  "html",
  "head",
  "body",
  "style",
  "script",
  "meta",
  "base",
  "link",
  "title",
  "template",
  "noscript",
  "iframe",
]);

type Element = DefaultTreeAdapterTypes.Element;
type Patch = { start: number; end: number; value: string };

function applyPatches(source: string, patches: Patch[]) {
  return patches
    .sort((a, b) => b.start - a.start)
    .reduce((result, { start, end, value }) => result.slice(0, start) + value + result.slice(end), source);
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
  return applyPatches(source, [
    attribute
      ? { start: attribute.startOffset, end: attribute.endOffset, value: value.slice(1) }
      : { start: at, end: at, value },
  ]);
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
  return (
    applyPatches(content, patches) +
    `<style>
html[data-polpo-design-tool="select"] [${NODE_ATTRIBUTE}] { cursor: default !important; }
html:not([data-polpo-design-tool="select"]) * { cursor: crosshair !important; }
[data-polpo-design-active] { outline: 2px solid var(--polpo-design-highlight, Highlight) !important; outline-offset: -2px; }
html[data-polpo-design-tool="pan"], html[data-polpo-design-tool="pan"] * { cursor: grab !important; }
</style><script>
(() => {
  const attribute = ${JSON.stringify(NODE_ATTRIBUTE)};
  const channel = ${JSON.stringify(DESIGN_CHANNEL)};
  let drag, pan, drawing, placement, editing, active, tool = "select";
  const svgNS = "http://www.w3.org/2000/svg";
  const line = (points) => points.map(([x, y], index) => (index ? "L" : "M") + x + " " + y).join(" ");
  let resizing;
  const handles = document.createElement("div");
  handles.style.cssText = "display:none;position:fixed;pointer-events:none;z-index:2147483645";
  document.documentElement.append(handles);
  const handlePositions = {nw:[0,0],ne:[100,0],sw:[0,100],se:[100,100]};
  for (const [corner,[x,y]] of Object.entries(handlePositions)) {
    const handle=document.createElement("span");
    handle.style.cssText="position:absolute;width:8px;height:8px;box-sizing:border-box;pointer-events:auto;transform:translate(-50%,-50%);background:Canvas;border:1px solid var(--polpo-design-highlight,Highlight);left:"+x+"%;top:"+y+"%;cursor:"+corner+"-resize";
    handle.dataset.polpoHandle=corner;handles.append(handle);
  }
  function syncBounds(){
    if (!active?.isConnected || tool!=="select" || editing) {handles.style.display="none";return;}
    const b=active.getBoundingClientRect();
    Object.assign(handles.style,{display:"block",left:b.left+"px",top:b.top+"px",width:b.width+"px",height:b.height+"px"});
  }
  window.addEventListener("scroll",syncBounds,true);
  window.addEventListener("resize",syncBounds);
  window.addEventListener("message", (event) => {
    const { data } = event;
    if (event.source !== parent || data?.channel !== channel || data.type !== "canvas-options") return;
    active?.removeAttribute("data-polpo-design-active");
    active = Number.isSafeInteger(data.selected) ? document.querySelector("[" + attribute + '="' + data.selected + '"]') : null;
    active?.setAttribute("data-polpo-design-active", "");
    tool = data.tool;
    document.documentElement.setAttribute("data-polpo-design-tool", tool);
    syncBounds();
    if (typeof data.color === "string" && CSS.supports("color", data.color)) document.documentElement.style.setProperty("--polpo-design-highlight", data.color);
  });
  const send = (node, dx, dy) => parent.postMessage({ channel, node, dx, dy }, "*");
  window.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    if (editing?.contains(event.target)) return;
    if (event.target.dataset?.polpoHandle && active && tool==="select") {
      const b=active.getBoundingClientRect(), computed=getComputedStyle(active);
      resizing={target:active,node:Number(active.getAttribute(attribute)),dir:event.target.dataset.polpoHandle,
        x:event.clientX,y:event.clientY,width:b.width,height:b.height,css:active.style.cssText,
        base:computed.translate.split(/\\s+/).map(Number.parseFloat),inline:computed.display==="inline"};
      event.preventDefault();event.stopImmediatePropagation();event.target.setPointerCapture?.(event.pointerId);
      return;
    }
    if (["text","note","circle","rectangle","artboard"].includes(tool)) {
      placement = {x: event.clientX, y: event.clientY};
      event.preventDefault();
      event.stopImmediatePropagation();
      event.target.setPointerCapture?.(event.pointerId);
      return;
    }
    if (tool === "draw") {
      event.preventDefault();
      event.stopImmediatePropagation();
      const overlay = document.createElementNS(svgNS, "svg");
      overlay.style.cssText = "position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:2147483647";
      const path = document.createElementNS(svgNS, "path");
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", ${JSON.stringify(DESIGN_STROKE)});
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
    document.body.tabIndex = -1;
    document.body.focus({preventScroll:true});
    active?.removeAttribute("data-polpo-design-active");
    active=target;active.setAttribute("data-polpo-design-active","");syncBounds();
    const node = Number(target.getAttribute(attribute));
    drag = { node, x: event.clientX, y: event.clientY, target, translate: target.style.translate,
      base: getComputedStyle(target).translate.split(/\\s+/).map(Number.parseFloat) };
    target.setPointerCapture?.(event.pointerId);
  }, true);
  function resized(e) {
    const d=resizing;
    const west=d.dir.includes("w"),north=d.dir.includes("n");
    const width=Math.round(Math.max(8,d.width+(west?-1:1)*(e.clientX-d.x)));
    const height=Math.round(Math.max(8,d.height+(north?-1:1)*(e.clientY-d.y)));
    return {width,height,dx:Math.round((d.base[0]||0)+(west?d.width-width:0)),dy:Math.round((d.base[1]||0)+(north?d.height-height:0))};
  }
  window.addEventListener("pointermove", (event) => {
    if(resizing) {
      const r=resized(event),t=resizing.target;
      if(resizing.inline)t.style.display="inline-block";
      Object.assign(t.style,{boxSizing:"border-box",width:r.width+"px",height:r.height+"px",translate:r.dx+"px "+r.dy+"px"});
      syncBounds();return;
    }
    if (drawing) {
      if (drawing.points.length < 900) drawing.points.push([event.clientX, event.clientY]);
      drawing.path.setAttribute("d", line(drawing.points));
      return;
    }
    if (pan) {
      parent.postMessage({channel, type:"pan", x:pan.x-event.clientX, y:pan.y-event.clientY}, "*");
      pan.x=event.clientX; pan.y=event.clientY;
      return;
    }
    if (!drag) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (Math.hypot(dx, dy) < 4) return;
    drag.target.style.translate = ((drag.base[0] || 0) + dx) + "px " + ((drag.base[1] || 0) + dy) + "px";
  }, true);
  function release(event, cancelled) {
    if(resizing) {
      const r=resized(event),d=resizing;resizing=undefined;
      d.target.style.cssText=d.css;
      if(!cancelled)parent.postMessage({channel,type:"resize",node:d.node,inline:d.inline,...r},"*");
      syncBounds();return;
    }
    if (placement) {
      const {x,y}=placement;
      placement=undefined;
      if (!cancelled) parent.postMessage({channel,type:"place",x:Math.min(x,event.clientX)+scrollX,y:Math.min(y,event.clientY)+scrollY,width:Math.abs(x-event.clientX),height:Math.abs(y-event.clientY)}, "*");
      return;
    }
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
  window.addEventListener("dblclick", (event) => {
    const target = event.target.closest?.("[" + attribute + "]");
    if (tool !== "select" || !target || target.children.length || !["P","SPAN","DIV","ASIDE","A","H1","H2","H3","H4","H5","H6","BUTTON","LI","LABEL","TD","TH"].includes(target.tagName)) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (editing) editing.blur();
    editing = target;
    const original = target.textContent;
    target.contentEditable = "plaintext-only";
    syncBounds();target.focus();
    const range = document.createRange();range.selectNodeContents(target);
    const selection = getSelection(); selection.removeAllRanges();selection.addRange(range);
    target.addEventListener("blur", () => {
      editing=undefined;target.removeAttribute("contenteditable");syncBounds();
      if (target.textContent !== original) parent.postMessage({channel,type:"text",node:Number(target.getAttribute(attribute)),value:target.textContent},"*");
    }, {once:true});
  }, true);
  window.addEventListener("keydown",(e)=>{
    if (editing) {if(e.key === "Escape" || e.key==="Enter" && !e.shiftKey) { e.preventDefault(); editing.blur(); } return;}
    const key=e.shiftKey && /^Digit[12]$/.test(e.code) ? e.code.at(-1) : e.key.toLowerCase();
    const mod=e.ctrlKey||e.metaKey;
    if (!mod && active && ["arrowleft","arrowright","arrowup","arrowdown"].includes(key)) {
      e.preventDefault();
      const style=getComputedStyle(active),parentStyle=active.parentElement&&getComputedStyle(active.parentElement);
      const backwards=key==="arrowleft"||key==="arrowup";
      const previous=active.previousElementSibling,next=active.nextElementSibling;
      if(parentStyle&&/(flex|grid)/.test(parentStyle.display)&&!["absolute","fixed"].includes(style.position)) {
        const other=backwards?previous:next;
        if(other?.hasAttribute(attribute))parent.postMessage({channel,type:"reorder",node:Number(active.getAttribute(attribute)),other:Number(other.getAttribute(attribute))},"*");
      } else {
        const [x=0,y=0]=style.translate.split(/\\s+/).map(Number.parseFloat);
        const step=e.shiftKey?10:1;
        send(Number(active.getAttribute(attribute)),Math.round((x||0)+(key==="arrowleft"?-step:key==="arrowright"?step:0)),Math.round((y||0)+(key==="arrowup"?-step:key==="arrowdown"?step:0)));
      }
      return;
    }
    if (mod&&["z","d","=","+","-",String.fromCharCode(92),"f6"].includes(key) || !mod&&["v","h","t","f","n","p","r","o","g","1","2","f6","escape","delete","backspace"].includes(key)) {
      e.preventDefault(); parent.postMessage({channel,type:"shortcut",key,mod:e.ctrlKey||e.metaKey,shift:e.shiftKey},"*");
    }
  },true);
  window.addEventListener("click", (event) => {
    if(editing?.contains(event.target))return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
})();
</script>`
  );
}

const INSERT_ITEMS = {
  text: { tag: "p", body: "New text", style: "margin: 1rem; font-size: 20px;" },
  section: {
    tag: "section",
    body: "<h2>New section</h2>",
    style: "padding: 2rem; margin: 1rem; min-height: 12rem; border: 1px solid currentColor; border-radius: .5rem;",
  },
  note: {
    tag: "aside",
    body: "Add a note",
    style:
      "width: min(100%, 14rem); margin: 1rem; padding: 1rem; border-radius: .4rem; background: " + DESIGN_NOTE.background + "; color: " + DESIGN_NOTE.color + ";",
  },
  rectangle: { tag: "div", body: "", style: "width: 8rem; height: 5rem; margin: 1rem; background: " + DESIGN_SHAPE_FILL + ";" },
  circle: {
    tag: "div",
    body: "",
    style: "width: 6rem; height: 6rem; margin: 1rem; border-radius: 50%; background: " + DESIGN_SHAPE_FILL + ";",
  },
} as const;

function appendMarkup(content: string, markup: string) {
  const document = parse(content, { sourceCodeLocationInfo: true });
  const root = document.childNodes.find((node) => "tagName" in node && node.tagName === "html") as Element | undefined;
  const body = root?.childNodes.find((node) => "tagName" in node && node.tagName === "body") as Element | undefined;
  const offset =
    body?.sourceCodeLocation?.endTag?.startOffset ?? root?.sourceCodeLocation?.endTag?.startOffset ?? content.length;
  return applyPatches(content, [
    {
      start: offset,
      end: offset,
      value: `
${markup}
`,
    },
  ]);
}

function insertElement(
  content: string,
  tag: keyof typeof INSERT_ITEMS,
  x: number,
  y: number,
  width: number,
  height: number,
) {
  const spec = INSERT_ITEMS[tag];
  const identity = `design-${crypto.randomUUID()}`;
  const bounds = `position:absolute;left:${Math.round(x)}px;top:${Math.round(y)}px;margin:0;${width > 8 ? `width:${Math.round(width)}px;` : ""}${height > 8 ? `height:${Math.round(height)}px;` : ""}`;
  const next = appendMarkup(
    content,
    `<${spec.tag} id="${identity}" style="${spec.style}${bounds}">${spec.body}</${spec.tag}>`,
  );
  const index = collectElements(next).findIndex((node) =>
    node.attrs.some((attr) => attr.name === "id" && attr.value === identity),
  );
  return { next, index };
}

function addStroke(content: string, points: unknown): string | undefined {
  if (!Array.isArray(points) || points.length < 2 || points.length > 900) return;
  const coordinates = points.filter(
    (point): point is [number, number] =>
      Array.isArray(point) && point.length === 2 && point.every((n) => Number.isSafeInteger(n) && Math.abs(n) < 32768),
  );
  if (coordinates.length !== points.length) return;
  const xs = coordinates.map(([x]) => x);
  const ys = coordinates.map(([, y]) => y);
  const left = Math.min(...xs) - 2;
  const top = Math.min(...ys) - 2;
  const width = Math.max(...xs) - left + 2;
  const height = Math.max(...ys) - top + 2;
  const path = coordinates.map(([x, y], index) => `${index ? "L" : "M"}${x - left} ${y - top}`).join(" ");
  return appendMarkup(
    content,
    `<svg role="img" aria-label="Freehand line" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" style="position:absolute;left:${left}px;top:${top}px"><path d="${path}" fill="none" stroke="${DESIGN_STROKE}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  );
}

const STYLE_FIELDS = [
  { property: "font-size", label: "Font size", placeholder: "24px" },
  { property: "color", label: "Text color", placeholder: DESIGN_COLOR_PLACEHOLDERS.color },
  { property: "background-color", label: "Background", placeholder: DESIGN_COLOR_PLACEHOLDERS.background },
  { property: "width", label: "Width", placeholder: "auto" },
  { property: "height", label: "Height", placeholder: "auto" },
  { property: "border-radius", label: "Corner radius", placeholder: "8px" },
  { property: "padding", label: "Padding", placeholder: "16px" },
  { property: "translate", label: "Position offset", placeholder: "0px 0px" },
] as const;

type DesignArtifact = Pick<Artifact, "id" | "title" | "refreshSeconds">;

type Tool = "select" | "pan" | "draw" | "artboard" | "text" | "note" | "rectangle" | "circle";
const SHORTCUTS: Record<string, Tool> = {
  v: "select",
  h: "pan",
  t: "text",
  f: "artboard",
  n: "note",
  p: "draw",
  r: "rectangle",
  o: "circle",
};
const ROOT_TOOLS = [
  { id: "select", label: "Select", key: "V", icon: MousePointer2 },
  { id: "pan", label: "Hand", key: "H", icon: Hand },
  { id: "text", label: "Text", key: "T", icon: Type },
  { id: "artboard", label: "Artboard", key: "F", icon: Frame },
  { id: "note", label: "Note", key: "N", icon: StickyNote },
  { id: "draw", label: "Pencil", key: "P", icon: Pencil },
] as const;
const ZOOMS = [25, 50, 75, 100, 150, 200];
const TOOL_BUTTON = "size-8 rounded-md p-0 [&_svg]:size-4";
const CORNER_BUTTON = "h-7 rounded-md border bg-background/95 px-2 shadow-control";
const EMPTY_SELECTION = { id: "", index: -1 };

function DesignFrame({
  artifact,
  board,
  selected,
  tool,
  refreshKey,
}: {
  artifact: DesignArtifact;
  board: Artboard;
  selected: number;
  tool: Tool;
  refreshKey?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const html = useMemo(() => instrumentCanvas(board.html, collectElements(board.html)), [board.html]);
  const sync = useCallback(() => {
    ref.current?.querySelector("iframe")?.contentWindow?.postMessage(
      {
        channel: DESIGN_CHANNEL,
        type: "canvas-options",
        selected,
        tool,
        color: getComputedStyle(document.documentElement).getPropertyValue("--ring").trim(),
      },
      "*",
    );
  }, [selected, tool]);
  useEffect(() => {
    sync();
  }, [sync]);
  return (
    <div
      data-board-frame={board.id}
      ref={ref}
      onLoadCapture={sync}
      className="size-full overflow-hidden bg-canvas shadow-card"
    >
      <ArtifactFrame
        artifactId={artifact.id}
        title={board.name}
        html={html}
        refreshSeconds={artifact.refreshSeconds}
        refreshKey={refreshKey}
      />
    </div>
  );
}

function StaticDesignFrame({ board }: { board: Artboard }) {
  const srcDoc = useMemo(() => artifactStaticPreview(board.html), [board.html]);
  return (
    <iframe
      title={board.name}
      srcDoc={srcDoc}
      sandbox=""
      referrerPolicy="no-referrer"
      className="h-full w-full border-0 bg-background"
    />
  );
}

export function ArtifactDesignEditor({
  artifact,
  content,
  onChange: commit,
  refreshKey,
  streaming = false,
}: {
  artifact: DesignArtifact;
  content: string;
  onChange?: (content: string) => void;
  refreshKey?: number;
  streaming?: boolean;
}) {
  const onChange = streaming ? undefined : commit;
  const root = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const model = useMemo(() => readDesign(content), [content]);
  const [pageId, setPageId] = useState("");
  const [selection, setSelection] = useState(EMPTY_SELECTION);
  const [tool, setTool] = useState<Tool>("select");
  const [properties, setProperties] = useState(false);
  const [inspectorTab, setInspectorTab] = useState<"Properties" | "Code" | "Tweaks">("Properties");
  const [player, setPlayer] = useState<string | null>(null);
  const [zoom, setZoom] = useState<number | null>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [guides, setGuides] = useState(false);
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 });
  const [history, setHistory] = useState({ past: [] as string[], future: [] as string[], latest: content });
  const drag = useRef<{
    x: number;
    y: number;
    sx: number;
    sy: number;
    board?: Artboard;
    tool: Tool;
    px: number;
    py: number;
  } | null>(null);
  const [moving, setMoving] = useState<{ id: string; x: number; y: number } | null>(null);
  const page = model.pages.find((p) => p.id === pageId) ?? model.pages[0];
  const active = page.boards.find((b) => b.id === selection.id) ?? page.boards[0];
  const playing = page.boards.find((b) => b.id === player);
  const elements = useMemo(() => collectElements(active.html), [active.html]);
  const element = selection.id === active.id ? elements[selection.index] : undefined;
  const textRange =
    element?.sourceCodeLocation?.endTag && element.childNodes.every((c) => c.nodeName === "#text")
      ? { start: element.sourceCodeLocation.startTag!.endOffset, end: element.sourceCodeLocation.endTag.startOffset }
      : null;
  const text = textRange ? element!.childNodes.map((c) => ("value" in c ? c.value : "")).join("") : "";

  useEffect(() => {
    const node = stage.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) =>
      setSize({ w: entry.contentRect.width, h: entry.contentRect.height }),
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const bounds = {
    left: Math.min(...page.boards.map((b) => b.x)),
    top: Math.min(...page.boards.map((b) => b.y)),
    right: Math.max(...page.boards.map((b) => b.x + b.width)),
    bottom: Math.max(...page.boards.map((b) => b.y + b.height)),
  };
  const fit = Math.max(
    0.02,
    Math.min(1, (size.w - 104) / (bounds.right - bounds.left), (size.h - 166) / (bounds.bottom - bounds.top)),
  );
  const scale = zoom ?? fit;
  const worldWidth = Math.max(size.w, (bounds.right - bounds.left) * scale + 96);
  const worldHeight = Math.max(size.h, (bounds.bottom - bounds.top) * scale + 158);
  const originX = (worldWidth - (bounds.right - bounds.left) * scale) / 2 - bounds.left * scale + panOffset.x;
  const originY = (worldHeight - (bounds.bottom - bounds.top) * scale) / 2 - bounds.top * scale + panOffset.y;

  function publish(next: string) {
    if (!onChange || next === content) return;
    setHistory((h) => ({
      past: [...(h.latest === content ? h.past.slice(-34) : []), content],
      future: [],
      latest: next,
    }));
    onChange?.(next);
  }
  function undo(redo = false) {
    if (!onChange || history.latest !== content) return;
    const next = (redo ? history.future : history.past).at(-1);
    if (next === undefined) return;
    setHistory({
      latest: next,
      past: redo ? [...history.past, content] : history.past.slice(0, -1),
      future: redo ? history.future.slice(0, -1) : [...history.future, content],
    });
    setSelection(EMPTY_SELECTION);
    onChange?.(next);
  }
  function updatePage(next: DesignPage) {
    publish(writeDesign({ pages: model.pages.map((p) => (p.id === next.id ? next : p)) }));
  }
  function updateBoard(next: Artboard) {
    if (
      model.pages.length === 1 &&
      page.boards.length === 1 &&
      next.html !== active.html &&
      !content.includes("data-polpo-design-workspace")
    ) {
      publish(next.html);
      return;
    }
    updatePage({ ...page, boards: page.boards.map((b) => (b.id === next.id ? next : b)) });
  }
  function newArtboard(x: number, y: number, width = 1024, height = 680) {
    const board = {
      ...createBoard(
        crypto.randomUUID(),
        `Artboard ${page.boards.length + 1}`,
        BLANK_BOARD,
        Math.round(x),
        Math.round(y),
      ),
      width: width > 24 ? Math.round(width) : 1024,
      height: height > 24 ? Math.round(height) : 680,
    };
    updatePage({ ...page, boards: [...page.boards, board] });
    setSelection({ id: board.id, index: -1 });
    setTool("select");
    fitBoards();
  }
  function newPage() {
    const board = createBoard(crypto.randomUUID(), "Artboard 1");
    const next = { id: crypto.randomUUID(), name: `Page ${model.pages.length + 1}`, boards: [board] };
    publish(writeDesign({ pages: [...model.pages, next] }));
    setPageId(next.id);
    setSelection(EMPTY_SELECTION);
    fitBoards();
  }
  function place(board: Artboard, x: number, y: number, width: number, height: number) {
    if (tool === "artboard") {
      newArtboard(board.x + x, board.y + y, width, height);
      return;
    }
    if (tool !== "text" && tool !== "note" && tool !== "rectangle" && tool !== "circle") return;
    const result = insertElement(board.html, tool, x, y, width, height);
    updateBoard({ ...board, html: result.next });
    setSelection({ id: board.id, index: result.index });
    setTool("select");
  }
  function fitBoards() {
    setZoom(null);
    setPanOffset({ x: 0, y: 0 });
    stage.current?.scrollTo(0, 0);
  }
  function centerActive() {
    const next = Math.max(0.02, Math.min(4, (size.w - 96) / active.width, (size.h - 156) / active.height));
    const w = Math.max(size.w, (bounds.right - bounds.left) * next + 96),
      h = Math.max(size.h, (bounds.bottom - bounds.top) * next + 158);
    const midX = (w - (bounds.right - bounds.left) * next) / 2 + (active.x - bounds.left + active.width / 2) * next;
    const midY = (h - (bounds.bottom - bounds.top) * next) / 2 + (active.y - bounds.top + active.height / 2) * next;
    setZoom(next);
    setPanOffset({ x: size.w / 2 - midX, y: size.h / 2 - midY });
    stage.current?.scrollTo(0, 0);
  }
  function changeZoom(next: number) {
    setZoom(Math.max(0.02, Math.min(4, next)));
  }
  function shortcut(key: string, mod: boolean, shift: boolean) {
    if (key === "f6") {
      const areas = [
        root.current?.querySelector<HTMLButtonElement>('[aria-label$=" pages"]'),
        root.current?.querySelector<HTMLButtonElement>("[data-board-title]"),
        root.current?.querySelector<HTMLButtonElement>('[aria-label="Properties panel"] [role="tab"]'),
      ].filter((el): el is HTMLButtonElement => !!el);
      const pos = areas.findIndex((a) => a.parentElement?.contains(document.activeElement));
      areas[(pos + (shift ? -1 : 1) + areas.length) % areas.length]?.focus();
      return true;
    }
    if (onChange && mod && key === "\\") {
      setProperties((v) => !v);
      return true;
    }
    if (onChange && mod && key === "d" && selection.id) {
      if (!element) {
        const copy = {
          ...active,
          id: crypto.randomUUID(),
          name: active.name + " copy",
          x: active.x + active.width + 32,
        };
        updatePage({ ...page, boards: [...page.boards, copy] });
        setSelection({ id: copy.id, index: -1 });
        fitBoards();
        return true;
      }
      const location = element.sourceCodeLocation!;
      const fragment = document.createElement("template");
      fragment.innerHTML = active.html.slice(location.startOffset, location.endOffset);
      const ids = new Map<string, string>();
      for (const node of fragment.content.querySelectorAll("[id]")) {
        const id = crypto.randomUUID();
        ids.set(node.id, id);
        node.id = id;
      }
      for (const node of fragment.content.querySelectorAll("*"))
        for (const a of Array.from(node.attributes)) {
          if (a.value.startsWith("#") && ids.has(a.value.slice(1)))
            node.setAttribute(a.name, "#" + ids.get(a.value.slice(1)));
          else if (["for", "aria-labelledby", "aria-describedby"].includes(a.name))
            node.setAttribute(
              a.name,
              a.value
                .split(" ")
                .map((s) => ids.get(s) ?? s)
                .join(" "),
            );
        }
      const html = applyPatches(active.html, [
        { start: location.endOffset, end: location.endOffset, value: fragment.innerHTML },
      ]);
      updateBoard({ ...active, html });
      const index = collectElements(html).findIndex((el) => el.sourceCodeLocation?.startOffset === location.endOffset);
      setSelection({ id: active.id, index });
      return true;
    }
    if (mod && key === "z") {
      undo(shift);
      return true;
    }
    if (mod && ["=", "+", "-"].includes(key)) {
      changeZoom(scale * (key === "-" ? 0.8 : 1.25));
      return true;
    }
    if (mod) return false;
    if (key === "escape") {
      setPlayer(null);
      setTool("select");
      setSelection(EMPTY_SELECTION);
      return true;
    }
    if (shift && key === "1") {
      fitBoards();
      return true;
    }
    if (shift && key === "2") {
      centerActive();
      return true;
    }
    if (shift && key === "g") {
      setGuides((v) => !v);
      return true;
    }
    if (!onChange) return false;
    if (SHORTCUTS[key]) {
      setTool(SHORTCUTS[key]);
      return true;
    }
    if (selection.id && !element && (key === "delete" || key === "backspace")) {
      const boards = page.boards.filter((b) => b.id !== active.id);
      updatePage({ ...page, boards: boards.length ? boards : [createBoard(crypto.randomUUID(), "Artboard 1")] });
      setSelection(EMPTY_SELECTION);
      fitBoards();
      return true;
    }
    if (element && (key === "delete" || key === "backspace")) {
      const loc = element.sourceCodeLocation!;
      updateBoard({
        ...active,
        html: applyPatches(active.html, [{ start: loc.startOffset, end: loc.endOffset, value: "" }]),
      });
      setSelection(EMPTY_SELECTION);
      return true;
    }
    return false;
  }
  useEffect(() => {
    function receive(event: MessageEvent) {
      if (event.data?.channel !== DESIGN_CHANNEL) return;
      const frame = [...(root.current?.querySelectorAll<HTMLIFrameElement>("[data-board-frame] iframe") ?? [])].find(
        (f) => f.contentWindow === event.source,
      );
      const board = page.boards.find(
        (b) => b.id === frame?.closest<HTMLElement>("[data-board-frame]")?.dataset.boardFrame,
      );
      if (!board || !frame) return;
      const d = event.data;
      if (d.type === "pan" && tool === "pan" && Number.isFinite(d.x) && Number.isFinite(d.y)) {
        setPanOffset((v) => ({ x: v.x - d.x * scale, y: v.y - d.y * scale }));
        return;
      }
      if (d.type === "shortcut" && typeof d.key === "string") {
        shortcut(d.key, d.mod, d.shift);
        return;
      }
      if (d.type === "place") {
        if ([d.x, d.y, d.width, d.height].every((n) => Number.isFinite(n) && Math.abs(n) < 65536))
          place(board, d.x, d.y, d.width, d.height);
        return;
      }
      if (d.type === "stroke" && tool === "draw") {
        const html = addStroke(board.html, d.points);
        if (html) updateBoard({ ...board, html });
        return;
      }
      if (tool !== "select" || !Number.isSafeInteger(d.node)) return;
      const node = (board.id === active.id ? elements : collectElements(board.html))[d.node];
      if (!node) return;
      setSelection({ id: board.id, index: d.node });
      if (d.type === "reorder" && Number.isSafeInteger(d.other)) {
        const other = (board.id === active.id ? elements : collectElements(board.html))[d.other];
        if (!other || node.parentNode !== other.parentNode || node === other) return;
        const from = node.sourceCodeLocation!,
          to = other.sourceCodeLocation!;
        const value = board.html.slice(from.startOffset, from.endOffset),
          adjacent = board.html.slice(to.startOffset, to.endOffset);
        const html = applyPatches(board.html, [
          { start: from.startOffset, end: from.endOffset, value: adjacent },
          { start: to.startOffset, end: to.endOffset, value },
        ]);
        updateBoard({ ...board, html });
        setSelection({
          id: board.id,
          index: collectElements(html).findIndex(
            (el) =>
              el.sourceCodeLocation?.startOffset ===
              (to.startOffset < from.startOffset ? to.startOffset : to.startOffset + adjacent.length - value.length),
          ),
        });
        return;
      }
      if (
        d.type === "text" &&
        typeof d.value === "string" &&
        node.childNodes.every((c) => c.nodeName === "#text") &&
        node.sourceCodeLocation?.endTag
      ) {
        updateBoard({
          ...board,
          html: applyPatches(board.html, [
            {
              start: node.sourceCodeLocation.startTag!.endOffset,
              end: node.sourceCodeLocation.endTag.startOffset,
              value: escapeText(d.value),
            },
          ]),
        });
      } else if (
        d.type === "resize" &&
        [d.width, d.height].every((n) => Number.isSafeInteger(n) && n >= 8 && n <= 32768) &&
        [d.dx, d.dy].every((n) => Number.isSafeInteger(n) && Math.abs(n) <= 32768)
      ) {
        updateBoard({
          ...board,
          html: updateStyle(board.html, node, {
            "box-sizing": "border-box",
            width: `${d.width}px`,
            height: `${d.height}px`,
            translate: `${d.dx}px ${d.dy}px`,
            ...(d.inline ? { display: "inline-block" } : {}),
          }),
        });
      } else if ([d.dx, d.dy].every((n) => Number.isSafeInteger(n) && Math.abs(n) < 32768)) {
        updateBoard({ ...board, html: updateStyle(board.html, node, { translate: `${d.dx}px ${d.dy}px` }) });
      }
    }
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  });
  function exportBoard(board: Artboard) {
    const url = URL.createObjectURL(new Blob([board.html], { type: "text/html" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = board.name + ".html";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }
  function beginDrag(e: React.PointerEvent<HTMLDivElement | HTMLButtonElement>, board?: Artboard) {
    if (e.button !== 0) return;
    if (!onChange && board) {
      setSelection({ id: board.id, index: -1 });
      return;
    }
    if (board) {
      setSelection({ id: board.id, index: -1 });
      e.stopPropagation();
    }
    const node = stage.current!;
    if (!board && tool === "select") {
      setSelection(EMPTY_SELECTION);
      return;
    }
    drag.current = {
      x: e.clientX,
      y: e.clientY,
      sx: node.scrollLeft,
      sy: node.scrollTop,
      board,
      tool,
      px: panOffset.x,
      py: panOffset.y,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function moveDrag(e: React.PointerEvent) {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x,
      dy = e.clientY - d.y;
    if (d.board) setMoving({ id: d.board.id, x: d.board.x + dx / scale, y: d.board.y + dy / scale });
    else if (d.tool === "pan") setPanOffset({ x: d.px + dx, y: d.py + dy });
  }
  function endDrag(e: React.PointerEvent) {
    const d = drag.current;
    drag.current = null;
    setMoving(null);
    if (!d || e.type === "pointercancel") return;
    const dx = e.clientX - d.x,
      dy = e.clientY - d.y;
    if (d.board) {
      if (Math.hypot(dx, dy) > 3)
        updateBoard({ ...d.board, x: Math.round(d.board.x + dx / scale), y: Math.round(d.board.y + dy / scale) });
    } else if (d.tool === "artboard") {
      const box = stage.current!.getBoundingClientRect();
      newArtboard(
        (Math.min(d.x, e.clientX) - box.left + d.sx - originX) / scale,
        (Math.min(d.y, e.clientY) - box.top + d.sy - originY) / scale,
        Math.abs(dx / scale),
        Math.abs(dy / scale),
      );
    }
  }

  return (
    <div
      ref={root}
      className="relative flex h-full min-h-0 bg-muted/50"
      tabIndex={-1}
      onKeyDown={(e) => {
        if ((e.target as HTMLElement).closest("input,textarea,select,[contenteditable=true]")) return;
        const key = e.shiftKey && /^Digit[12]$/.test(e.code) ? e.code.at(-1)! : e.key.toLowerCase();
        if (shortcut(key, e.ctrlKey || e.metaKey, e.shiftKey)) e.preventDefault();
      }}
    >
      <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
        <div className="pointer-events-none absolute inset-x-4 top-4 z-20 flex items-start justify-between gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className={CORNER_BUTTON + " pointer-events-auto max-w-[45%] gap-1.5 text-xs"}
                aria-label={`${page.name}, ${model.pages.length} pages`}
              >
                <Layers className="size-3.5" />
                <span className="truncate">{page.name}</span>
                <ChevronDown className="size-3" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {model.pages.map((p) => (
                <DropdownMenuItem
                  key={p.id}
                  onSelect={() => {
                    setPageId(p.id);
                    setSelection(EMPTY_SELECTION);
                    fitBoards();
                  }}
                >
                  <span className="flex-1">{p.name}</span>
                  {p.id === page.id && <Check />}
                </DropdownMenuItem>
              ))}
              {onChange && (
                <DropdownMenuItem onSelect={newPage}>
                  <Plus />
                  New page
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
          <div className="pointer-events-auto flex gap-1">
            <Button
              size="icon"
              variant="ghost"
              className={CORNER_BUTTON + " w-7"}
              aria-label="Play"
              title="Play"
              onClick={() => setPlayer(active.id)}
            >
              <Play />
            </Button>
            {onChange && (
              <Button
                size="icon"
                variant="ghost"
                className={CORNER_BUTTON + " w-7"}
                aria-label="Properties"
                aria-pressed={properties}
                onClick={() => setProperties((v) => !v)}
              >
                <PanelRight />
              </Button>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  size="sm"
                  variant="ghost"
                  className={CORNER_BUTTON + " gap-1 text-xs tabular-nums"}
                  aria-label={`${Math.round(scale * 100)}%, Zoom`}
                >
                  {Math.round(scale * 100)}%<ChevronDown className="size-3" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => changeZoom(scale * 1.25)}>Zoom in</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => changeZoom(scale * 0.8)}>Zoom out</DropdownMenuItem>
                <DropdownMenuItem onSelect={fitBoards}>Fit artboards</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => shortcut("2", false, true)}>Zoom to selection</DropdownMenuItem>
                {ZOOMS.map((z) => (
                  <DropdownMenuItem key={z} onSelect={() => changeZoom(z / 100)}>
                    {z}%
                  </DropdownMenuItem>
                ))}
                <DropdownMenuItem onSelect={() => setGuides(!guides)}>
                  Layout guides {guides && <Check />}
                </DropdownMenuItem>
                {onChange && (
                  <DropdownMenuItem
                    disabled={!history.past.length || history.latest !== content}
                    onSelect={() => undo()}
                  >
                    Undo
                  </DropdownMenuItem>
                )}
                {onChange && (
                  <DropdownMenuItem
                    disabled={!history.future.length || history.latest !== content}
                    onSelect={() => undo(true)}
                  >
                    Redo
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
        <div
          ref={stage}
          className="min-h-0 flex-1 overflow-auto overscroll-contain"
          onPointerMove={moveDrag}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          <div
            className="relative touch-none"
            style={{
              width: worldWidth,
              height: worldHeight,
              cursor: tool === "pan" ? "grab" : tool === "select" ? "default" : "crosshair",
              backgroundImage: guides ? "radial-gradient(var(--muted-foreground) .7px, transparent .8px)" : undefined,
              backgroundSize: "16px 16px",
            }}
            onPointerDown={(e) => beginDrag(e)}
          >
            {page.boards.map((board) => {
              const position = moving?.id === board.id ? moving : board;
              return (
                <div
                  key={board.id}
                  className="absolute"
                  style={{
                    left: originX + position.x * scale,
                    top: originY + position.y * scale,
                    width: board.width * scale,
                    height: board.height * scale,
                  }}
                >
                  <div className="absolute inset-x-0 bottom-full mb-1 flex items-center gap-1 text-muted-foreground">
                    <button
                      className="min-w-0 flex-1 touch-none truncate text-left text-caption font-medium"
                      data-board-title
                      title={board.name}
                      onPointerDown={(e) => beginDrag(e, board)}
                      onDoubleClick={() => {
                        if (!onChange) return;
                        setProperties(true);
                        setSelection({ id: board.id, index: -1 });
                      }}
                    >
                      {board.name}
                    </button>
                    <button
                      aria-label={`Open artboard ${board.name} full window`}
                      title="Open artboard"
                      className="rounded-xs p-1 hover:bg-muted"
                      onClick={() => setPlayer(board.id)}
                    >
                      <Expand className="size-3" />
                    </button>
                    <button
                      aria-label={`Export artboard ${board.name}`}
                      title="Export artboard"
                      className="rounded-xs p-1 hover:bg-muted"
                      onClick={() => exportBoard(board)}
                    >
                      <Download className="size-3" />
                    </button>
                  </div>
                  <div
                    className="absolute left-0 top-0 origin-top-left"
                    style={{ width: board.width, height: board.height, transform: `scale(${scale})` }}
                  >
                    {streaming ? (
                      <StaticDesignFrame board={board} />
                    ) : onChange ? (
                      <DesignFrame
                        artifact={artifact}
                        board={board}
                        selected={selection.id === board.id ? selection.index : -1}
                        tool={tool}
                        refreshKey={refreshKey}
                      />
                    ) : (
                      <ArtifactFrame
                        artifactId={artifact.id}
                        data-board-title
                        title={board.name}
                        html={board.html}
                        refreshSeconds={artifact.refreshSeconds}
                        refreshKey={refreshKey}
                      />
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
        {onChange && (
          <div
            role="toolbar"
            aria-label="Canvas tools"
            className="absolute bottom-3 left-1/2 z-20 flex -translate-x-1/2 items-center gap-1 rounded-xl border bg-background p-[3px] shadow-raised"
          >
            {ROOT_TOOLS.map(({ id, label, key, icon: Icon }, i) => (
              <div key={id} className={i === 2 ? "border-l pl-1" : "contents"}>
                <Button
                  size="icon"
                  variant={tool === id ? "secondary" : "ghost"}
                  aria-pressed={tool === id}
                  className={TOOL_BUTTON}
                  title={`${label} (${key})`}
                  aria-label={label}
                  onClick={() => setTool(id)}
                >
                  <Icon />
                </Button>
              </div>
            ))}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  size="icon"
                  variant={tool === "circle" || tool === "rectangle" ? "secondary" : "ghost"}
                  className={TOOL_BUTTON}
                  title="Shapes"
                  aria-label="Shapes"
                >
                  <Shapes />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="top">
                <DropdownMenuItem onSelect={() => setTool("rectangle")}>
                  <Square /> Rectangle
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setTool("circle")}>
                  <Circle /> Ellipse
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
      </div>
      {onChange && properties && (
        <aside
          aria-label="Properties panel"
          className="absolute inset-y-0 right-0 z-30 w-[min(21rem,90%)] shrink-0 overflow-auto border-l bg-card p-3 shadow-raised md:static md:shadow-none"
        >
          <div className="mb-3 flex items-center justify-between border-b pb-2 text-sm">
            <div role="tablist" aria-label="Inspector">
              {(["Properties", "Code", "Tweaks"] as const).map((tab) => (
                <button
                  key={tab}
                  role="tab"
                  aria-selected={tab === inspectorTab}
                  onClick={() => setInspectorTab(tab)}
                  className={
                    "rounded-xs px-2 py-1 text-xs " +
                    (tab === inspectorTab ? "bg-accent font-semibold" : "text-muted-foreground")
                  }
                >
                  {tab}
                </button>
              ))}
            </div>
            <button aria-label="Close properties" onClick={() => setProperties(false)}>
              <X className="size-4" />
            </button>
          </div>
          {inspectorTab !== "Tweaks" && (
            <DesignLayers
              boards={page.boards}
              active={active}
              elements={elements}
              selection={selection}
              onSelect={setSelection}
            />
          )}
          {inspectorTab === "Tweaks" ? (
            <DesignTweaks board={active} onChange={(html) => updateBoard({ ...active, html })} />
          ) : !selection.id ? (
            <div className="py-4 text-center text-xs">
              <strong>Nothing selected</strong>
              <p className="mt-1 text-muted-foreground">Select an element on the canvas.</p>
            </div>
          ) : inspectorTab === "Code" ? (
            <label className="grid gap-2 text-xs">
              HTML
              <textarea
                spellCheck={false}
                aria-label="Layer HTML"
                key={active.id + ":" + selection.index + ":" + active.html}
                className="min-h-64 w-full resize-y rounded-control border bg-background p-2 font-mono text-xs"
                defaultValue={
                  element?.sourceCodeLocation
                    ? active.html.slice(element.sourceCodeLocation.startOffset, element.sourceCodeLocation.endOffset)
                    : active.html
                }
                onKeyDown={(e) => {
                  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") e.currentTarget.blur();
                }}
                onBlur={(e) => {
                  const loc = element?.sourceCodeLocation;
                  const html = loc
                    ? applyPatches(active.html, [{ start: loc.startOffset, end: loc.endOffset, value: e.target.value }])
                    : e.target.value;
                  if (html !== active.html) updateBoard({ ...active, html });
                }}
              />
            </label>
          ) : (
            <div className="grid gap-3 text-xs">
              <label>
                Page name
                <Input
                  key={page.id + page.name}
                  defaultValue={page.name}
                  className="mt-1 h-8 text-xs"
                  onBlur={(e) => {
                    const name = e.target.value.trim();
                    if (name && name !== page.name) updatePage({ ...page, name });
                  }}
                />
              </label>
              <label>
                Artboard name
                <Input
                  key={active.id + active.name}
                  defaultValue={active.name}
                  className="mt-1 h-8 text-xs"
                  onBlur={(e) => {
                    const name = e.target.value.trim();
                    if (name && name !== active.name) updateBoard({ ...active, name });
                  }}
                />
              </label>
              <div className="grid grid-cols-2 gap-2">
                {(["width", "height"] as const).map((k) => (
                  <label key={k} className="capitalize">
                    {k}
                    <Input
                      key={active.id + active[k]}
                      type="number"
                      min="32"
                      max="8192"
                      defaultValue={active[k]}
                      className="mt-1 h-8 text-xs"
                      onBlur={(e) => {
                        const n = Math.round(e.target.valueAsNumber);
                        if (n >= 32 && n <= 8192 && n !== active[k]) updateBoard({ ...active, [k]: n });
                      }}
                    />
                  </label>
                ))}
              </div>
              {textRange && (
                <label>
                  Text
                  <textarea
                    className="mt-1 block w-full rounded-control border bg-background p-2"
                    value={text}
                    onChange={(e) =>
                      updateBoard({
                        ...active,
                        html: applyPatches(active.html, [{ ...textRange, value: escapeText(e.target.value) }]),
                      })
                    }
                  />
                </label>
              )}
              {element &&
                STYLE_FIELDS.map(({ property, label, placeholder }) => {
                  const value = styleFor(element).getPropertyValue(property);
                  return (
                    <label key={property}>
                      {label}
                      <Input
                        key={selection.index + value}
                        className="mt-1 h-8 text-xs"
                        defaultValue={value}
                        placeholder={placeholder}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") e.currentTarget.blur();
                        }}
                        onBlur={(e) => {
                          const next = e.target.value.trim();
                          if (next !== value && (!next || CSS.supports(property, next)))
                            updateBoard({ ...active, html: updateStyle(active.html, element, { [property]: next }) });
                        }}
                      />
                    </label>
                  );
                })}
            </div>
          )}
        </aside>
      )}
      {playing && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={playing.name}
          className="absolute inset-0 z-40 flex flex-col bg-background"
        >
          <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b px-3 text-sm font-medium">
            <span>{playing.name}</span>
            <div className="flex gap-1">
              <Button
                size="icon"
                variant="ghost"
                className="size-7"
                aria-label="Full screen"
                onClick={(e) => {
                  void e.currentTarget
                    .closest("[role=dialog]")
                    ?.requestFullscreen()
                    .catch(() => {});
                }}
              >
                <Maximize2 />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                autoFocus
                className="size-7"
                aria-label="Close presentation"
                onClick={() => setPlayer(null)}
              >
                <X />
              </Button>
            </div>
          </div>
          <div className="min-h-0 flex-1">
            {streaming ? (
              <StaticDesignFrame board={playing} />
            ) : (
              <ArtifactFrame
                artifactId={artifact.id}
                title={playing.name}
                html={playing.html}
                refreshSeconds={artifact.refreshSeconds}
                refreshKey={refreshKey}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
