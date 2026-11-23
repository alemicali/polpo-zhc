import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Circle, Copy, Download, ImagePlus, Maximize, Play, Plus, Printer, Redo2, Square, Trash2, Type, Undo2, X } from "lucide-react";
import { MAX_ARTIFACT_BYTES } from "@polpo-ai/core/artifacts";
import { nanoid } from "nanoid";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { parseSlides, THEMES, type Layout, type Shape, type Slide, type SlideElement, type Theme } from "./artifact-slides-format";

function slideFields(slide: Slide) {
  const titleSlide = slide.layout === "title";
  const split = slide.layout === "split";
  const fields = [
    { key: "title" as const, label: "Slide title", x: 8, y: titleSlide ? 29 : 14, w: 84, h: titleSlide ? 24 : 20, fontSize: titleSlide ? 6.3 : 4.5, bold: true },
    { key: "body" as const, label: "Slide text", x: 8, y: titleSlide ? 55 : 38, w: split ? 39 : 82, h: titleSlide ? 26 : 51, fontSize: titleSlide ? 3 : 2.6, bold: false },
  ] as { key: "title" | "body" | "secondary"; label: string; x: number; y: number; w: number; h: number; fontSize: number; bold: boolean }[];
  if (split) fields.push({ key: "secondary", label: "Right column", x: 52, y: 38, w: 40, h: 51, fontSize: 2.6, bold: false });
  return fields;
}

const rectStyle = (value: Pick<SlideElement, "x" | "y" | "w" | "h">) => ({
  left: `${value.x}%`, top: `${value.y}%`, width: `${value.w}%`, height: `${value.h}%`,
});

function SlideCanvas({ slide, onField, onElement, selected, onSelect, onDrag, thumbnail }: {
  slide: Slide;
  onField?: (patch: Partial<Slide>) => void;
  onElement?: (patch: Partial<SlideElement>) => void;
  selected?: string;
  onSelect?: (id: string) => void;
  onDrag?: (event: PointerEvent<HTMLButtonElement>, element: SlideElement, resize?: boolean) => void;
  thumbnail?: boolean;
}) {
  const { bg, fg, accent } = THEMES[slide.theme ?? "light"];
  const editableClass = "m-0 resize-none border-0 bg-transparent p-0 outline-none ring-inset hover:ring-1 hover:ring-current/25 focus-visible:ring-2 focus-visible:ring-current/45";
  const textClass = "absolute overflow-hidden break-words whitespace-pre-wrap";
  return (
    <div data-slide-canvas className="relative aspect-video w-full overflow-hidden [container-type:inline-size]" style={{ backgroundColor: bg, color: fg }}>
      <div aria-hidden className="absolute left-[8%] top-[8%] h-[0.7%] w-[5%]" style={{ backgroundColor: accent }} />
      {slideFields(slide).map((field) => {
        const style = { ...rectStyle(field), fontSize: `${field.fontSize}cqw`, fontWeight: field.bold ? 650 : 400, lineHeight: field.bold ? 1.04 : 1.3, fontFamily: field.bold ? "Georgia, serif" : "inherit" };
        return onField ? (
          <textarea key={field.key} aria-label={field.label} placeholder={field.label} className={`${textClass} ${editableClass}`} value={slide[field.key] ?? ""} style={style}
            onFocus={() => onSelect?.("")} onChange={(event) => onField({ [field.key]: event.target.value })} />
        ) : <div key={field.key} className={textClass} style={style}>{slide[field.key]}</div>;
      })}
      {slide.elements?.map((element) => {
        const isTextBox = element.type === "text";
        const isImage = element.type === "image";
        const color = element.color ?? (isTextBox ? fg : accent);
        const style = { ...rectStyle(element), color, fontSize: `${element.fontSize ?? 3}cqw`, lineHeight: 1.2, borderRadius: element.type === "ellipse" ? "50%" : undefined, backgroundColor: isTextBox || isImage ? undefined : color };
        const active = selected === element.id;
        const outline = active ? " outline-2 outline-offset-2 outline-primary" : "";
        const drawing = isImage ? <img src={element.src} alt={element.alt ?? ""} draggable={false} className="size-full" /> : null;
        if (!onSelect) return <div key={element.id} className={textClass} style={style}>{isTextBox ? element.text : drawing}</div>;
        return (
          <div key={element.id} className={`absolute ${outline}`} style={style}>
            {isTextBox ? <textarea aria-label="Text box" className={`size-full ${editableClass}`} value={element.text ?? ""}
              onFocus={() => onSelect(element.id)} onChange={(event) => onElement?.({ id: element.id, text: event.target.value })} />
              : <button type="button" aria-label={isImage ? element.alt || "Image" : element.type === "ellipse" ? "Ellipse" : "Rectangle"} className="size-full cursor-move touch-none rounded-[inherit] focus-visible:outline-2 focus-visible:outline-offset-2"
                onFocus={() => onSelect(element.id)} onPointerDown={(event) => onDrag?.(event, element)}>{drawing}</button>}
            {active && isTextBox && <button type="button" aria-label="Drag text box" className="absolute -right-2 -top-2 size-4 cursor-move touch-none rounded-full border border-background bg-primary outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onPointerDown={(event) => onDrag?.(event, element)} />}
            {active && isImage && <button type="button" aria-label="Resize image" className="absolute -bottom-2 -right-2 size-4 cursor-nwse-resize touch-none rounded-full border border-background bg-primary outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onPointerDown={(event) => onDrag?.(event, element, true)} />}
          </div>
        );
      })}
      {!thumbnail && slide.hidden && <span className="absolute bottom-2 right-2 rounded bg-background/85 px-2 py-1 text-xs text-foreground">Skipped in presentation</span>}
    </div>
  );
}

const step = (current: number, delta: number, length: number) => Math.min(length - 1, Math.max(0, current + delta));

function Presentation({ slides, initial, onClose }: { slides: Slide[]; initial: number; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [current, setIndex] = useState(initial);
  const index = step(current, 0, slides.length);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => { element?.close(); };
  }, []);
  const fullscreen = () => {
    const element = dialog.current;
    if (!element) return;
    if (document.fullscreenElement === element) void document.exitFullscreen().catch(() => {});
    else void element.requestFullscreen?.().catch(() => {});
  };
  const keys = (event: KeyboardEvent<HTMLDialogElement>) => {
    let next = index;
    const onButton = event.target instanceof HTMLButtonElement;
    if (["ArrowRight", "ArrowDown", "PageDown"].includes(event.key) || (event.key === " " && !onButton)) next++;
    else if (["ArrowLeft", "ArrowUp", "PageUp"].includes(event.key)) next--;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = slides.length - 1;
    else if (event.key.toLowerCase() === "f") fullscreen();
    else if (/^[1-9]$/.test(event.key) && Number(event.key) <= slides.length) next = Number(event.key) - 1;
    else return;
    event.preventDefault();
    setIndex(step(next, 0, slides.length));
  };
  return (
    <dialog ref={dialog} aria-label="Slide presentation" onCancel={(event) => { event.preventDefault(); onClose(); }} onKeyDown={keys}
      className="fixed inset-0 m-0 size-full max-h-none max-w-none flex-col bg-neutral-950 p-4 text-neutral-50 open:flex backdrop:bg-neutral-950">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <p className="truncate text-sm" aria-live="polite">{index + 1} / {slides.length} · {slides[index].title}</p>
        <div className="flex items-center gap-1">
          <Button size="icon-sm" variant="ghost" aria-label="Toggle full screen" onClick={fullscreen}><Maximize /></Button>
          <Button size="icon-sm" variant="ghost" aria-label="End presentation" onClick={onClose}><X /></Button>
        </div>
      </div>
      <div className="flex min-h-0 grow items-center justify-center">
        <div className="w-[min(100%,calc((100dvh-8rem)*16/9))]"><SlideCanvas slide={slides[index]} /></div>
      </div>
      <div className="flex justify-center gap-2">
        <Button size="icon-sm" variant="ghost" aria-label="Previous slide" disabled={index === 0} onClick={() => setIndex(index - 1)}><ArrowLeft /></Button>
        <Button size="icon-sm" variant="ghost" aria-label="Next slide" disabled={index === slides.length - 1} onClick={() => setIndex(index + 1)}><ArrowRight /></Button>
      </div>
    </dialog>
  );
}

async function printSlides(slides: Slide[], title: string) {
  const popup = window.open("", "_blank");
  if (!popup) throw new Error("Allow Pop-ups to print this deck.");
  popup.opener = null;
  const doc = popup.document;
  doc.title = title;
  const style = doc.createElement("style");
  style.textContent = `
    @page{size:13.333in 7.5in;margin:0} body{margin:0}
    section{position:relative;aspect-ratio:16/9;width:100%;overflow:hidden;container-type:inline-size;break-after:page;
      print-color-adjust:exact;-webkit-print-color-adjust:exact;font-family:Arial,sans-serif}
    section:last-child{break-after:auto}
    section>div{position:absolute;overflow:hidden;overflow-wrap:anywhere;white-space:pre-wrap}
    @media print{section{width:13.333in;height:7.5in}}`;
  doc.head.append(style);
  const images: Promise<void>[] = [];
  for (const slide of slides) {
    const theme = THEMES[slide.theme ?? "light"];
    const page = doc.createElement("section");
    page.style.backgroundColor = theme.bg;
    page.style.color = theme.fg;
    const boxes = [
      ...slideFields(slide).map((field) => ({ ...field, text: slide[field.key] ?? "", color: theme.fg, radius: false, fill: false })),
      { x: 8, y: 8, w: 5, h: 0.7, text: "", fontSize: 1, bold: false, color: theme.accent, radius: false, fill: true },
      ...(slide.elements ?? []).map((element) => ({ ...element, text: element.type === "text" ? element.text ?? "" : "", fontSize: element.fontSize ?? 3, bold: false, color: element.color ?? (element.type === "text" ? theme.fg : theme.accent), radius: element.type === "ellipse", fill: element.type === "rect" || element.type === "ellipse", src: element.type === "image" ? element.src : undefined, alt: element.alt })),
    ];
    for (const box of boxes) {
      const node = doc.createElement("div");
      if ("src" in box && box.src) {
        const img = doc.createElement("img");
        img.alt = box.alt ?? "";
        img.style.width = "100%";
        img.style.height = "100%";
        img.src = box.src;
        node.append(img);
        images.push(img.decode());
      } else {
        node.textContent = box.text;
      }
      Object.assign(node.style, rectStyle(box), {
        fontSize: `${box.fontSize}cqw`, fontWeight: box.bold ? "650" : "400", lineHeight: box.bold ? "1.04" : "1.3",
        fontFamily: box.bold ? "Georgia, serif" : "inherit", color: box.color,
        backgroundColor: box.fill ? box.color : "", borderRadius: box.radius ? "50%" : "",
      });
      page.append(node);
    }
    doc.body.append(page);
  }
  await Promise.all(images);
  popup.focus();
  popup.print();
}

async function exportSlides(slides: Slide[], title: string) {
  const { default: PptxGenJS } = await import("pptxgenjs");
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE";
  pptx.title = title;
  const color = (hex: string) => hex.slice(1);
  const position = (box: Pick<SlideElement, "x" | "y" | "w" | "h">) => ({ x: box.x * 0.133333, y: box.y * 0.075, w: box.w * 0.133333, h: box.h * 0.075 });
  for (const slide of slides) {
    const page = pptx.addSlide();
    const theme = THEMES[slide.theme ?? "light"];
    page.background = { color: color(theme.bg) };
    page.hidden = slide.hidden ?? false;
    page.addShape(pptx.ShapeType.rect, { ...position({ x: 8, y: 8, w: 5, h: 0.7 }), line: { transparency: 100 }, fill: { color: color(theme.accent) } });
    for (const field of slideFields(slide)) {
      page.addText(slide[field.key] ?? "", { ...position(field), margin: 0, valign: "top", color: color(theme.fg), fontSize: field.fontSize * 9.6,
        fontFace: field.bold ? "Georgia" : "Arial", bold: field.bold, fit: "shrink" });
    }
    for (const element of slide.elements ?? []) {
      if (element.type === "text") {
        page.addText(element.text ?? "", { ...position(element), margin: 0, valign: "top", color: color(element.color ?? theme.fg),
          fontFace: "Arial", fontSize: (element.fontSize ?? 3) * 9.6, fit: "shrink" });
      } else if (element.type === "image") {
        page.addImage({ data: element.src, ...position(element), altText: element.alt });
      } else {
        page.addShape(element.type === "ellipse" ? pptx.ShapeType.ellipse : pptx.ShapeType.rect,
          { ...position(element), line: { transparency: 100 }, fill: { color: color(element.color ?? theme.accent) } });
      }
    }
    if (slide.notes) page.addNotes(slide.notes);
  }
  const filename = title.trim().replace(/[<>:"/\\|?*\p{Cc}]/gu, "-") || "slides";
  await pptx.writeFile({ fileName: `${filename}.pptx` });
}

const imageTypes = new Set(["image/png", "image/jpeg"]);
const utf8Bytes = (content: string) => new TextEncoder().encode(content).length;
const maxImageWidth = (image: SlideElement) => Math.min(100 - image.x, (100 - image.y) * image.w / image.h);
const imageSize = (image: SlideElement, width: number) => ({ w: width, h: width * image.h / image.w });

async function prepareImage(file: File, availableBytes: number): Promise<SlideElement> {
  if (!imageTypes.has(file.type)) throw new Error("Choose a PNG or JPEG image.");
  const bitmap = await createImageBitmap(file).catch(() => { throw new Error("The image could not be opened."); });
  try {
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) throw new Error("The image could not be opened.");
    let scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    let src: string;
    for (;;) {
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      src = canvas.toDataURL(file.type, 0.88);
      if (src.length <= availableBytes) break;
      if (Math.max(canvas.width, canvas.height) <= 240) throw new Error("There is not enough space left in this deck for the image.");
      scale *= 0.72;
    }
    const ratio = (canvas.height / canvas.width) * (16 / 9);
    const w = Math.min(48, 45 / ratio);
    const h = w * ratio;
    return { id: nanoid(), type: "image", x: (100 - w) / 2, y: (100 - h) / 2, w, h, src, alt: file.name.replace(/\.[^.]+$/, "") };
  } finally {
    bitmap.close();
  }
}

export function ArtifactSlidesEditor({ content, onChange, title = "Slides" }: { content: string; onChange?: (content: string) => void; title?: string }) {
  const deck = useMemo(() => parseSlides(content), [content]);
  const [selectedSlide, setSelectedSlide] = useState<string>();
  const [selected, setSelected] = useState("");
  const [presenting, setPresenting] = useState<number>();
  const [exporting, setExporting] = useState(false);
  const [dragPreview, setDragPreview] = useState<Pick<SlideElement, "id"> & Partial<Pick<SlideElement, "x" | "y" | "w" | "h">>>();
  const [importing, setImporting] = useState(false);
  const imageInput = useRef<HTMLInputElement>(null);
  const editable = Boolean(onChange);
  const currentContent = useRef<string | null>(null);
  useLayoutEffect(() => {
    currentContent.current = editable ? content : null;
    return () => { currentContent.current = null; };
  }, [content, editable]);
  const presentButton = useRef<HTMLButtonElement>(null);
  const [history, setHistory] = useState({ past: [] as string[], future: [] as string[] });
  if (!deck) return <p role="status" className="p-4 text-sm text-muted-foreground">This deck cannot be opened in the slide editor. Check its source.</p>;
  const slides = deck.slides;
  const index = Math.max(0, slides.findIndex((slide) => slide.id === selectedSlide));
  const slide = slides[index];
  const element = slide.elements?.find((item) => item.id === selected);
  const visibleSlides = slides.filter((item) => !item.hidden);
  const selectSlide = (next: number) => {
    setSelectedSlide(slides[next].id);
    setSelected("");
  };
  function update(slides: Slide[], checkBudget = false) {
    if (!onChange) return;
    const next = JSON.stringify({ version: 1, slides }, null, 2);
    if (next === content) return;
    if (checkBudget && utf8Bytes(next) > MAX_ARTIFACT_BYTES) throw new Error("There is not enough space left in this deck for the image.");
    setHistory({ past: [...history.past.slice(-49), content], future: [] });
    onChange(next);
  }
  function undo(redo = false) {
    const next = (redo ? history.future : history.past).at(-1);
    if (!onChange || next === undefined) return;
    setHistory(redo ? { past: [...history.past, content], future: history.future.slice(0, -1) } : { past: history.past.slice(0, -1), future: [...history.future, content] });
    onChange(next);
  }
  const patchSlide = (patch: Partial<Slide>, checkBudget?: boolean) => update(slides.map((item) => item.id === slide.id ? { ...item, ...patch } : item), checkBudget);
  const patchElement = (patch: Partial<SlideElement>) => patchSlide({
    elements: slide.elements?.map((item) => item.id === (patch.id ?? selected) ? { ...item, ...patch } : item),
  });
  function insert(copy: boolean) {
    const id = nanoid();
    const next: Slide = copy ? { ...slide, id } : { id, title: "", body: "", theme: slide.theme, layout: "content" };
    update([...slides.slice(0, index + 1), next, ...slides.slice(index + 1)]);
    setSelectedSlide(id);
    setSelected("");
  }
  function move(delta: number) {
    const nextIndex = step(index, delta, slides.length);
    if (nextIndex === index) return;
    const next = slides.slice();
    next.splice(index, 1);
    next.splice(nextIndex, 0, slide);
    update(next);
    setSelectedSlide(slide.id);
  }
  function removeSlide() {
    if (slides.length === 1) return;
    selectSlide(index === slides.length - 1 ? index - 1 : index + 1);
    update(slides.filter((item) => item.id !== slide.id));
  }
  function addElement(type: Shape) {
    const id = nanoid();
    const next: SlideElement = { id, type, x: 39, y: 52, w: type === "text" ? 38 : 22, h: type === "text" ? 22 : 24 };
    patchSlide({ elements: [...(slide.elements ?? []), next] });
    setSelected(id);
  }
  async function addImage(file: File) {
    setImporting(true);
    try {
      const item = await prepareImage(file, MAX_ARTIFACT_BYTES - utf8Bytes(content) - 512);
      if (currentContent.current === null) return;
      if (currentContent.current !== content) throw new Error("The deck changed while the image was loading. Add the image again.");
      patchSlide({ elements: [...(slide.elements ?? []), item] }, true);
      setSelected(item.id);
    } catch (error) {
      if (currentContent.current !== null) toast.error((error as Error).message);
    } finally {
      setImporting(false);
    }
  }
  function removeElement() {
    patchSlide({ elements: slide.elements?.filter((item) => item.id !== selected) });
    setSelected("");
  }

  function drag(event: PointerEvent<HTMLButtonElement>, item: SlideElement, resize = false) {
    const target = event.currentTarget;
    const canvas = target.closest("[data-slide-canvas]");
    if (!canvas || event.button !== 0) return;
    event.preventDefault();
    target.focus();
    const bounds = canvas.getBoundingClientRect();
    const startX = event.clientX;
    const startY = event.clientY;
    const pointer = event.pointerId;
    target.setPointerCapture(pointer);
    setSelected(item.id);
    const coordinates = (next: globalThis.PointerEvent) => {
      const deltaX = 100 * (next.clientX - startX) / bounds.width;
      if (resize) {
        const maxWidth = maxImageWidth(item);
        return imageSize(item, Math.min(maxWidth, Math.max(Math.min(2, maxWidth), item.w + deltaX)));
      }
      return {
        x: Math.max(0, Math.min(100 - item.w, item.x + deltaX)),
        y: Math.max(0, Math.min(100 - item.h, item.y + 100 * (next.clientY - startY) / bounds.height)),
      };
    };
    const change = (next: globalThis.PointerEvent) => {
      if (next.pointerId === pointer) setDragPreview({ id: item.id, ...coordinates(next) });
    };
    const end = (next: globalThis.PointerEvent) => {
      if (next.pointerId !== pointer) return;
      target.removeEventListener("pointermove", change);
      target.removeEventListener("pointerup", end);
      target.removeEventListener("lostpointercapture", end);
      setDragPreview(undefined);
      if (next.type === "pointerup") patchElement({ id: item.id, ...coordinates(next) });
    };
    target.addEventListener("pointermove", change);
    target.addEventListener("pointerup", end);
    target.addEventListener("lostpointercapture", end);
  }

  function deckKeys(event: KeyboardEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement;
    if (target.matches("input, textarea, select, [contenteditable]")) return;
    if (event.key === "Escape") { setSelected(""); return; }
    if (event.ctrlKey || event.metaKey) {
      const key = event.key.toLowerCase();
      if (onChange && key === "z") { event.preventDefault(); undo(event.shiftKey); }
      if (onChange && key === "d" && target.closest("[data-slide-list]")) { event.preventDefault(); insert(true); }
      return;
    }
    const backwards = ["ArrowLeft", "ArrowUp", "PageUp"].includes(event.key);
    const forwards = ["ArrowRight", "ArrowDown", "PageDown"].includes(event.key);
    if (target.closest("[data-slide-list]") && (backwards || forwards || event.key === "Home" || event.key === "End")) {
      const next = event.key === "Home" ? 0 : event.key === "End" ? slides.length - 1 : step(index, backwards ? -1 : 1, slides.length);
      event.preventDefault();
      selectSlide(next);
      target.closest("[data-slide-list]")?.querySelectorAll<HTMLButtonElement>("[data-slide-thumbnail]")[next]?.focus();
    } else if (onChange && target.closest("[data-slide-list]") && ["Delete", "Backspace"].includes(event.key)) {
      event.preventDefault();
      removeSlide();
    } else if (onChange && element && target.closest("[data-slide-canvas]")) {
      if (["Delete", "Backspace"].includes(event.key)) { event.preventDefault(); removeElement(); }
      if (["ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown"].includes(event.key)) {
        const amount = event.shiftKey ? 0.25 : 1;
        const x = Math.max(0, Math.min(100 - element.w, element.x + (event.key === "ArrowLeft" ? -amount : event.key === "ArrowRight" ? amount : 0)));
        const y = Math.max(0, Math.min(100 - element.h, element.y + (event.key === "ArrowUp" ? -amount : event.key === "ArrowDown" ? amount : 0)));
        event.preventDefault();
        patchElement({ x, y });
      }
    }
  }

  const shownSlide = dragPreview
    ? { ...slide, elements: slide.elements?.map((item) => item.id === dragPreview.id ? { ...item, ...dragPreview } : item) }
    : slide;
  const selectClass = "h-8 rounded-control border border-border bg-background px-2 text-xs";
  const theme = THEMES[slide.theme ?? "light"];

  return (
    <div className="@container flex h-full min-h-0 flex-col" onKeyDown={deckKeys}>
      <div className="flex flex-wrap items-center gap-1.5 border-b border-border/60 p-2">
        {onChange && <>
          <Button size="sm" variant="outline" onClick={() => insert(false)}><Plus /> Slide</Button>
          <Button size="icon-sm" variant="ghost" aria-label="Duplicate slide" title="Duplicate slide" onClick={() => insert(true)}><Copy /></Button>
          <Button size="icon-sm" variant="ghost" aria-label="Undo" title="Undo" disabled={!history.past.length} onClick={() => undo()}><Undo2 /></Button>
          <Button size="icon-sm" variant="ghost" aria-label="Redo" title="Redo" disabled={!history.future.length} onClick={() => undo(true)}><Redo2 /></Button>
          <span className="mx-1 h-5 border-l border-border/60" />
          <input type="file" ref={imageInput} accept="image/png,image/jpeg" hidden onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = "";
            if (file) void addImage(file);
          }} />
          <Button size="icon-sm" variant="ghost" aria-label="Add image" title="Add image (PNG or JPEG)" disabled={importing} onClick={() => imageInput.current?.click()}><ImagePlus /></Button>
          <Button size="icon-sm" variant="ghost" aria-label="Add text box" title="Add text box" onClick={() => addElement("text")}><Type /></Button>
          <Button size="icon-sm" variant="ghost" aria-label="Add rectangle" title="Add rectangle" onClick={() => addElement("rect")}><Square /></Button>
          <Button size="icon-sm" variant="ghost" aria-label="Add ellipse" title="Add ellipse" onClick={() => addElement("ellipse")}><Circle /></Button>
        </>}
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <Button size="sm" variant="ghost" disabled={exporting} onClick={async () => {
            setExporting(true);
            try { await exportSlides(slides, title); }
            catch { toast.error("The PowerPoint file could not be exported."); }
            finally { setExporting(false); }
          }}><Download /> PowerPoint</Button>
          <Button size="sm" variant="ghost" disabled={!visibleSlides.length} onClick={() => {
            void printSlides(visibleSlides, title).catch((error: Error) => toast.error(error.message));
          }}><Printer /> Print / PDF</Button>
          <Button ref={presentButton} size="sm" disabled={!visibleSlides.length} onClick={() => setPresenting(Math.max(0, visibleSlides.findIndex((item) => item.id === slide.id)))}><Play /> Present</Button>
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col @4xl:flex-row">
        <aside data-slide-list aria-label="Slides" className="flex shrink-0 gap-2 overflow-auto border-b border-border/60 bg-muted/20 p-2 @4xl:w-36 @4xl:flex-col @4xl:border-b-0 @4xl:border-r">
          {slides.map((item, number) => <button key={item.id} type="button" data-slide-thumbnail aria-current={number === index ? "true" : undefined}
            aria-label={`Slide ${number + 1}: ${item.title || "Untitled"}${item.hidden ? ", skipped" : ""}`} onClick={() => selectSlide(number)}
            className={`w-28 shrink-0 rounded-control border p-1 text-left focus-visible:outline-2 focus-visible:outline-ring @4xl:w-full ${number === index ? "border-primary bg-primary/10" : "border-transparent hover:bg-muted"} ${item.hidden ? "opacity-50" : ""}`}>
            <div aria-hidden className="overflow-hidden rounded-sm border border-border/60"><SlideCanvas slide={item} thumbnail /></div>
            <span aria-hidden className="mt-1 block truncate px-0.5 text-xs text-muted-foreground">{number + 1} · {item.title || "Untitled"}</span>
          </button>)}
        </aside>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-auto bg-muted/40">
          <div className="flex min-h-min flex-1 items-center justify-center p-3 @4xl:p-6">
            <div className="w-full max-w-5xl overflow-hidden rounded-sm border border-border/70 shadow-sm"><SlideCanvas
              slide={shownSlide} onField={onChange ? patchSlide : undefined} onElement={onChange ? patchElement : undefined}
              selected={selected} onSelect={onChange ? setSelected : undefined} onDrag={onChange ? drag : undefined} />
            </div>
          </div>
          {onChange && <label className="block border-t border-border/60 bg-background p-2.5 text-xs text-muted-foreground">
            Speaker notes
            <textarea aria-label="Speaker notes" value={slide.notes ?? ""} onChange={(event) => patchSlide({ notes: event.target.value })}
              rows={2} className="mt-1 block w-full resize-y rounded-control border border-border bg-background p-2 text-sm text-foreground" />
          </label>}
        </div>
        {onChange && <aside aria-label="Slide properties" className="flex shrink-0 flex-wrap items-start gap-2 border-t border-border/60 bg-background p-2 @4xl:w-40 @4xl:flex-col @4xl:border-l @4xl:border-t-0">
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">Layout
            <select aria-label="Layout" className={selectClass} value={slide.layout} onChange={(event) => patchSlide({ layout: event.target.value as Layout })}>
              <option value="title">Title</option><option value="content">Content</option><option value="split">Two columns</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">Theme
            <select aria-label="Theme" className={selectClass} value={slide.theme ?? "light"} onChange={(event) => patchSlide({ theme: event.target.value as Theme })}>
              <option value="light">Paper</option><option value="dark">Evergreen</option><option value="accent">Mint</option>
            </select>
          </label>
          <div className="flex items-center gap-0.5 self-end @4xl:self-auto">
            <Button variant="ghost" size="icon-sm" aria-label="Move slide earlier" title="Move slide earlier" disabled={index === 0} onClick={() => move(-1)}><ArrowUp /></Button>
            <Button variant="ghost" size="icon-sm" aria-label="Move slide later" title="Move slide later" disabled={index === slides.length - 1} onClick={() => move(1)}><ArrowDown /></Button>
            <Button variant="ghost" size="icon-sm" aria-label="Delete slide" title="Delete slide" disabled={slides.length === 1} onClick={removeSlide}><Trash2 /></Button>
          </div>
          <label className="flex items-center gap-1.5 self-center text-xs text-muted-foreground @4xl:self-auto">
            <input type="checkbox" checked={slide.hidden ?? false} onChange={(event) => patchSlide({ hidden: event.target.checked })} /> Skip slide
          </label>
          {element && <div className="flex flex-wrap items-center gap-2 @4xl:w-full @4xl:border-t @4xl:border-border/60 @4xl:pt-2">
            {element.type === "image" ? <>
              <label className="flex w-full flex-col gap-1 text-xs text-muted-foreground">Alt text
                <Input className="h-7" value={element.alt ?? ""} onChange={(event) => patchElement({ alt: event.target.value })} />
              </label>
              <label className="flex items-center gap-1 text-xs text-muted-foreground">Width %
                <Input className="h-7 w-16" type="number" min={Math.min(2, maxImageWidth(element))} max={maxImageWidth(element)} step="any" value={Number(element.w.toFixed(2))}
                  onChange={(event) => {
                    const width = event.target.valueAsNumber;
                    if (width > 0 && width <= maxImageWidth(element)) patchElement(imageSize(element, width));
                  }} />
              </label>
            </> : <label className="flex items-center gap-1 text-xs text-muted-foreground">Color
              <input className="size-7" type="color" value={element.color ?? (element.type === "text" ? theme.fg : theme.accent)} onChange={(event) => patchElement({ color: event.target.value })} />
            </label>}
            {element.type === "text" && <label className="flex items-center gap-1 text-xs text-muted-foreground">Size
              <Input className="h-7 w-16" type="number" min={1} max={12} step={0.25} value={element.fontSize ?? 3}
                onChange={(event) => {
                  const value = event.target.valueAsNumber;
                  if (value >= 1 && value <= 12) patchElement({ fontSize: value });
                }} />
            </label>}
            <Button size="icon-sm" variant="ghost" aria-label="Delete object" title="Delete object" onClick={removeElement}><Trash2 /></Button>
          </div>}
        </aside>}
      </div>
      {presenting !== undefined && visibleSlides.length > 0 && <Presentation slides={visibleSlides} initial={step(presenting, 0, visibleSlides.length)} onClose={() => {
        setPresenting(undefined);
        requestAnimationFrame(() => presentButton.current?.focus());
      }} />}
    </div>
  );
}
