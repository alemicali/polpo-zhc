import { useEffect, useMemo, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Circle, Copy, Download, Film, Maximize2, Minimize2, Pause, Pencil, Play, Plus, Repeat, RotateCcw, Square, Trash2, Type } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { clamp, drawMotionFrame, MAX_LAYERS, MAX_SCENES, parseMotion, sceneAt, sceneOffsets, type MotionLayer, type MotionProject, type MotionScene } from "./artifact-motion-model";

export { MOTION_STARTER } from "./artifact-motion-model";

interface ArtifactMotionEditorProps {
  content: string;
  onChange?: (content: string) => void;
  title?: string;
}

type Drag = { id: string; sceneId: string; pointerId: number; offsetX: number; offsetY: number; x: number; y: number };
const LABELS = { text: "Text", rect: "Rectangle", ellipse: "Ellipse" };
const ICONS = { text: Type, rect: Square, ellipse: Circle };
const SELECT_CLASS = "h-8 w-full rounded-control border border-input bg-background px-2 text-xs";
const formatTime = (seconds: number) => {
  const tenths = Math.round(seconds * 10);
  return `${Math.floor(tenths / 600)}:${(tenths % 600 / 10).toFixed(1).padStart(4, "0")}`;
};
const newId = () => Array.from(crypto.getRandomValues(new Uint32Array(3)), (part) => part.toString(36)).join("-");

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="grid min-w-0 gap-1 text-xs text-muted-foreground">{label}{children}</label>;
}

function NumberField({ label, value, onChange, min, max, step = 1 }: {
  label: string; value: number; onChange: (value: number) => void; min: number; max: number; step?: number;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return <Field label={label}><Input className="h-8 px-2 font-mono text-xs" type="number" min={min} max={max} step={step}
    value={draft ?? value} onChange={(event) => {
      setDraft(event.target.value);
      const next = event.target.valueAsNumber;
      if (Number.isFinite(next) && next >= min && next <= max && next !== value) onChange(next);
    }} onBlur={() => {
      if (draft?.trim() && Number.isFinite(Number(draft))) {
        const next = clamp(Number(draft), min, max);
        if (next !== value) onChange(next);
      }
      setDraft(null);
    }} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} /></Field>;
}

function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (color: string) => void }) {
  return <Field label={label}><div className="flex h-8 items-center gap-2 rounded-control border border-input px-2">
    <input type="color" value={value} onChange={(event) => onChange(event.target.value)} className="size-5 cursor-pointer bg-transparent" />
    <span className="font-mono uppercase text-foreground">{value}</span>
  </div></Field>;
}

export function ArtifactMotionEditor({ content, onChange, title }: ArtifactMotionEditorProps) {
  const project = useMemo(() => parseMotion(content), [content]);
  if (!project) return <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground" role="status">This animation has invalid project data. Check its source and try again.</div>;
  return <MotionWorkspace project={project} onChange={onChange} title={title} />;
}

function MotionWorkspace({ project, onChange, title }: { project: MotionProject; onChange?: (content: string) => void; title?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const fullscreenButtonRef = useRef<HTMLButtonElement>(null);
  const exitFullscreenButtonRef = useRef<HTMLButtonElement>(null);
  const exportRef = useRef<AbortController>(null);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [loop, setLoop] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [editingCanvas, setEditingCanvas] = useState(true);
  const [selection, setSelection] = useState<{ sceneId: string; layerId: string }>();
  const [drag, setDrag] = useState<Drag | null>(null);
  const [exportProgress, setExportProgress] = useState<number | null>(null);
  const offsets = useMemo(() => sceneOffsets(project), [project]);
  const total = offsets[offsets.length - 1];
  const currentTime = clamp(time, 0, total);
  const active = sceneAt(offsets, currentTime);
  const scene = project.scenes[active];
  const selected = scene.id === selection?.sceneId ? scene.layers.find((item) => item.id === selection.layerId) : undefined;
  const showLayout = !playing && editingCanvas;
  const editing = Boolean(onChange && showLayout && !fullscreen);

  useEffect(() => {
    const ctx = canvasRef.current?.getContext("2d");
    if (ctx) drawMotionFrame(ctx, project, offsets, currentTime, showLayout ? { selectedId: editing ? selected?.id : undefined, drag: drag ?? undefined } : undefined);
  }, [project, offsets, currentTime, showLayout, editing, selected?.id, drag]);

  useEffect(() => {
    if (!playing) return;
    let previous = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const advance = Math.max(0, (now - previous) / 1000);
      previous = now;
      setTime((seconds) => loop ? (seconds + advance) % total : Math.min(seconds + advance, total));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, loop, total]);
  useEffect(() => {
    if (playing && !loop && time >= total) setPlaying(false);
  }, [playing, loop, time, total]);
  useEffect(() => () => exportRef.current?.abort(), []);
  useEffect(() => {
    let wasFullscreen = false;
    const updateFullscreen = () => {
      const isFullscreen = document.fullscreenElement === previewRef.current;
      setFullscreen(isFullscreen);
      if (wasFullscreen && !isFullscreen) fullscreenButtonRef.current?.focus();
      wasFullscreen = isFullscreen;
    };
    document.addEventListener("fullscreenchange", updateFullscreen);
    return () => document.removeEventListener("fullscreenchange", updateFullscreen);
  }, []);

  useEffect(() => { if (fullscreen) exitFullscreenButtonRef.current?.focus(); }, [fullscreen]);

  const toggleFullscreen = async () => {
    try {
      const preview = previewRef.current;
      if (document.fullscreenElement === preview) await document.exitFullscreen();
      else if (preview?.requestFullscreen) await preview.requestFullscreen();
      else throw new Error("Full screen is unavailable in this browser.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Full screen is unavailable.");
    }
  };

  const saveScenes = (scenes: MotionScene[]) => onChange?.(JSON.stringify({ ...project, scenes }, null, 2));
  const patchScene = (patch: Partial<MotionScene>) => saveScenes(project.scenes.map((item, index) => index === active ? { ...item, ...patch } : item));
  const patchLayer = (id: string, patch: Partial<MotionLayer>) => patchScene({ layers: scene.layers.map((layer) => layer.id === id ? { ...layer, ...patch } : layer) });
  const selectLayer = (id: string) => setSelection({ sceneId: scene.id, layerId: id });

  const seek = (next: number) => {
    setPlaying(false);
    setEditingCanvas(false);
    setTime(next);
  };
  const openScene = (index: number) => {
    setPlaying(false);
    setEditingCanvas(true);
    setTime(offsets[index]);
  };
  const togglePlay = () => {
    if (playing) setPlaying(false);
    else {
      if (currentTime >= total) setTime(0);
      setEditingCanvas(false);
      setPlaying(true);
    }
  };

  const restart = () => {
    setTime(0);
    setEditingCanvas(false);
    setPlaying(true);
  };
  const playbackButtons = <>
    <Button type="button" size="icon-sm" aria-label={playing ? "Pause" : "Play"} title={playing ? "Pause" : "Play"} onClick={togglePlay}>{playing ? <Pause /> : <Play />}</Button>
    <Button type="button" size="icon-sm" variant="ghost" aria-label="Restart playback" title="Restart playback" onClick={restart}><RotateCcw /></Button>
    <Button type="button" size="icon-sm" variant={loop ? "secondary" : "ghost"} aria-label="Loop playback" title="Loop playback" aria-pressed={loop} onClick={() => setLoop((enabled) => !enabled)}><Repeat /></Button>
  </>;

  const addScene = (duplicate: boolean) => {
    const id = newId();
    const newScene: MotionScene = duplicate
      ? { ...scene, id, name: `${scene.name} copy` }
      : { id, name: `Scene ${project.scenes.length + 1}`, duration: 3, background: scene.background, layers: [] };
    const scenes = [...project.scenes];
    scenes.splice(active + 1, 0, newScene);
    saveScenes(scenes);
    setTime(offsets[active + 1]);
    setEditingCanvas(true);
    setPlaying(false);
  };
  const moveScene = (direction: number) => {
    const destination = active + direction;
    if (destination < 0 || destination >= project.scenes.length) return;
    const scenes = [...project.scenes];
    [scenes[active], scenes[destination]] = [scenes[destination], scenes[active]];
    saveScenes(scenes);
    setTime(scenes.slice(0, destination).reduce((sum, item) => sum + item.duration, 0));
  };
  const deleteScene = () => {
    const scenes = project.scenes.filter((item) => item.id !== scene.id);
    if (scenes.length === 0) return;
    saveScenes(scenes);
    setTime(offsets[active === scenes.length ? active - 1 : active]);
    setSelection(undefined);
  };
  const addLayer = (type: MotionLayer["type"]) => {
    const layer: MotionLayer = {
      id: newId(), type, x: Math.round(project.width / 5), y: Math.round(project.height / 3),
      width: Math.max(1, Math.round(project.width / (type === "text" ? 2 : 5))), height: Math.max(1, Math.round(project.height / 5)),
      color: "#f6faf7", ...(type === "text" ? { text: "New text", fontSize: Math.max(12, Math.round(project.height / 12)) } : {}),
    };
    patchScene({ layers: [...scene.layers, layer] });
    selectLayer(layer.id);
  };
  const moveLayer = (direction: number) => {
    if (!selected) return;
    const layers = [...scene.layers];
    const index = layers.indexOf(selected);
    const target = index + direction;
    if (target < 0 || target >= layers.length) return;
    [layers[index], layers[target]] = [layers[target], layers[index]];
    patchScene({ layers });
  };

  const point = (event: PointerEvent<HTMLCanvasElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    return { x: (event.clientX - box.left) / box.width * project.width, y: (event.clientY - box.top) / box.height * project.height };
  };
  const dragStart = (event: PointerEvent<HTMLCanvasElement>) => {
    if (!editing || !event.isPrimary || event.button !== 0) return;
    const { x, y } = point(event);
    const layer = [...scene.layers].reverse().find((item) => x >= item.x && x <= item.x + item.width && y >= item.y && y <= item.y + item.height);
    if (!layer) { setSelection(undefined); return; }
    selectLayer(layer.id);
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({ id: layer.id, sceneId: scene.id, pointerId: event.pointerId, offsetX: x - layer.x, offsetY: y - layer.y, x: layer.x, y: layer.y });
  };
  const dragMove = (event: PointerEvent<HTMLCanvasElement>) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const { x, y } = point(event);
    setDrag({ ...drag, x: Math.round(x - drag.offsetX), y: Math.round(y - drag.offsetY) });
  };
  const dragEnd = (event: PointerEvent<HTMLCanvasElement>) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const { x, y } = point(event);
    if (drag.sceneId === scene.id) patchLayer(drag.id, { x: Math.round(x - drag.offsetX), y: Math.round(y - drag.offsetY) });
    setDrag(null);
  };

  const download = async () => {
    if (exportRef.current) return;
    const controller = new AbortController();
    exportRef.current = controller;
    setExportProgress(0);
    try {
      const { exportMotion } = await import("./artifact-motion-export");
      const { blob, extension } = await exportMotion(project, setExportProgress, controller.signal);
      const href = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = href;
      link.download = `${title?.trim().replace(/[^\p{L}\p{N}._ -]/gu, "-") || "animation"}.${extension}`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(href), 1000);
    } catch (error) {
      if (!controller.signal.aborted) toast.error(error instanceof Error ? error.message : "Video export failed.");
    } finally {
      exportRef.current = null;
      if (!controller.signal.aborted) setExportProgress(null);
    }
  };
  const cancelDownload = () => {
    exportRef.current?.abort();
    setExportProgress(null);
  };

  return <section aria-label="Motion workspace" className="flex h-full min-h-0 flex-col overflow-auto bg-background">
    <header className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
      <div className="flex items-center gap-2">
        <Film className="size-4 text-primary" aria-hidden="true" />
        <span className="text-sm font-medium">Motion</span>
        <span className="font-mono text-xs text-muted-foreground">{project.width} × {project.height}</span>
      </div>
      <div className="ml-auto flex items-center gap-2">
        {onChange && !editing && <Button type="button" size="sm" variant="ghost" onClick={() => { setPlaying(false); setEditingCanvas(true); }}><Pencil /> Edit canvas</Button>}
        <Button ref={fullscreenButtonRef} type="button" size="icon-sm" variant="ghost" aria-label="Full screen preview" title="Full screen preview" onClick={() => void toggleFullscreen()}><Maximize2 /></Button>
        {exportProgress !== null ? <>
          <span role="status" className="text-xs tabular-nums text-muted-foreground">Encoding {Math.round(exportProgress * 100)}%</span>
          <Button type="button" size="sm" variant="outline" onClick={cancelDownload}>Cancel export</Button>
        </> : <Button type="button" size="sm" variant="outline" onClick={() => void download()}><Download /> Export video</Button>}
      </div>
    </header>
    <div className="contents md:flex md:min-h-48 md:flex-1">
      <div className="order-1 grid min-h-44 min-w-0 shrink-0 place-items-center overflow-hidden bg-muted/35 p-3 md:order-none md:flex-1 md:p-6">
        <div ref={previewRef} className="relative grid size-full min-h-0 min-w-0 place-items-center overflow-hidden [&:fullscreen]:bg-black">
          <canvas ref={canvasRef} width={project.width} height={project.height}
            className={cn("max-h-full max-w-full rounded-sm bg-black object-contain shadow-md", editing && "touch-none cursor-crosshair", drag && "cursor-grabbing")}
            aria-label={`${scene.name} animation preview`} tabIndex={0}
            onPointerDown={dragStart} onPointerMove={dragMove} onPointerUp={dragEnd} onPointerCancel={() => setDrag(null)}
            onKeyDown={(event) => {
              if (event.key === " ") { event.preventDefault(); togglePlay(); }
              if (!editing || !selected) return;
              const movement = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
              if (!movement) return;
              event.preventDefault();
              const amount = event.shiftKey ? 10 : 1;
              patchLayer(selected.id, { x: selected.x + movement[0] * amount, y: selected.y + movement[1] * amount });
            }} />
          {fullscreen && <div className="absolute inset-x-0 bottom-0 flex items-center justify-center p-4">
            <div className="flex items-center gap-1 rounded-lg border bg-background p-1 shadow-md">
              {playbackButtons}
              <Button ref={exitFullscreenButtonRef} type="button" size="icon-sm" variant="ghost" aria-label="Exit full screen preview" title="Exit full screen preview" onClick={() => void toggleFullscreen()}><Minimize2 /></Button>
            </div>
          </div>}
        </div>
      </div>
      {onChange && <aside aria-label="Motion properties" className="order-3 min-h-0 shrink-0 border-t p-3 md:order-none md:w-60 md:overflow-y-auto md:border-l md:border-t-0 2xl:w-72">
        <div className="grid gap-2">
          <Field label="Scene name"><Input className="h-8 px-2 text-xs" value={scene.name} onChange={(event) => patchScene({ name: event.target.value })} /></Field>
          <div className="grid grid-cols-2 gap-2">
            <NumberField key={`${scene.id}-duration`} label="Duration (s)" value={scene.duration} min={0.25} max={60} step={0.25}
              onChange={(duration) => { patchScene({ duration }); openScene(active); }} />
            <ColorField label="Background" value={scene.background} onChange={(background) => patchScene({ background })} />
          </div>
          <Field label="Transition"><select className={SELECT_CLASS} value={scene.transition ?? "cut"} disabled={active === 0}
            onChange={(event) => patchScene({ transition: event.target.value === "fade" ? "fade" : "cut" })}><option value="cut">Cut</option><option value="fade">Crossfade</option></select></Field>
        </div>
        <div className="mt-3 border-y py-2">
          <div className="flex items-center gap-1">
            <h3 className="mr-auto text-xs font-medium">Layers</h3>
            {(Object.keys(LABELS) as MotionLayer["type"][]).map((type) => {
              const Icon = ICONS[type];
              return <Button key={type} type="button" variant="ghost" size="icon-xs" aria-label={`Add ${LABELS[type].toLowerCase()} layer`}
                title={`Add ${LABELS[type].toLowerCase()} layer`} disabled={scene.layers.length >= MAX_LAYERS}
                onClick={() => { openScene(active); addLayer(type); }}><Icon /></Button>;
            })}
          </div>
          <div className="mt-1 grid max-h-32 gap-0.5 overflow-y-auto">
            {[...scene.layers].reverse().map((layer) => {
              const Icon = ICONS[layer.type];
              return <button key={layer.id} type="button" aria-pressed={selected?.id === layer.id}
                className={cn("flex min-w-0 items-center gap-2 rounded-control px-2 py-1 text-left text-xs hover:bg-accent", selected?.id === layer.id && "bg-accent text-accent-foreground")}
                onClick={() => { openScene(active); selectLayer(layer.id); }}><Icon className="size-3.5 shrink-0 text-muted-foreground" /><span className="truncate">{layer.text?.trim() || LABELS[layer.type]}</span></button>;
            })}
          </div>
        </div>
        {selected && <div key={`${scene.id}-${selected.id}`} className="mt-2 grid gap-2">
          <div className="flex items-center gap-0.5">
            <h3 className="mr-auto text-xs font-medium">{LABELS[selected.type]} properties</h3>
            <Button type="button" size="icon-xs" variant="ghost" aria-label="Bring layer forward" title="Bring layer forward" disabled={scene.layers.at(-1)?.id === selected.id} onClick={() => moveLayer(1)}><ArrowUp /></Button>
            <Button type="button" size="icon-xs" variant="ghost" aria-label="Send layer backward" title="Send layer backward" disabled={scene.layers[0].id === selected.id} onClick={() => moveLayer(-1)}><ArrowDown /></Button>
            <Button type="button" size="icon-xs" variant="ghost" aria-label="Delete layer" title="Delete layer" onClick={() => patchScene({ layers: scene.layers.filter((item) => item.id !== selected.id) })}><Trash2 /></Button>
          </div>
          {selected.type === "text" && <Field label="Text"><textarea rows={3} className="w-full rounded-control border border-input bg-background px-2 py-1 text-xs text-foreground" value={selected.text ?? ""} onChange={(event) => patchLayer(selected.id, { text: event.target.value })} /></Field>}
          <div className="grid grid-cols-2 gap-2">
            <NumberField label="X" value={selected.x} min={-project.width * 2} max={project.width * 2} onChange={(x) => patchLayer(selected.id, { x })} />
            <NumberField label="Y" value={selected.y} min={-project.height * 2} max={project.height * 2} onChange={(y) => patchLayer(selected.id, { y })} />
            <NumberField label="Width" value={selected.width} min={1} max={project.width * 2} onChange={(width) => patchLayer(selected.id, { width })} />
            <NumberField label="Height" value={selected.height} min={1} max={project.height * 2} onChange={(height) => patchLayer(selected.id, { height })} />
            <ColorField label="Color" value={selected.color} onChange={(color) => patchLayer(selected.id, { color })} />
            {selected.type === "text" && <NumberField label="Font size" value={selected.fontSize ?? 56} min={1} max={1000} onChange={(fontSize) => patchLayer(selected.id, { fontSize })} />}
            <Field label="Animation"><select className={SELECT_CLASS} value={selected.animation ?? "none"} onChange={(event) => patchLayer(selected.id, { animation: event.target.value as MotionLayer["animation"] })}>
              <option value="none">None</option><option value="fade">Fade</option><option value="rise">Rise</option><option value="slide">Slide</option>
            </select></Field>
            <NumberField label="Delay (s)" value={selected.delay ?? 0} min={0} max={scene.duration} step={0.1} onChange={(delay) => patchLayer(selected.id, { delay })} />
            {selected.animation && selected.animation !== "none" && <NumberField label="Animation (s)" value={selected.animationDuration ?? 0.52} min={0.05} max={60} step={0.05} onChange={(animationDuration) => patchLayer(selected.id, { animationDuration })} />}
          </div>
        </div>}
      </aside>}
    </div>
    <div aria-label="Timeline" className="order-2 shrink-0 border-t bg-card p-2.5 md:order-none">
      <div className="flex flex-wrap items-center gap-1">
        {!fullscreen && playbackButtons}
        <span className="ml-1 font-mono text-xs tabular-nums text-muted-foreground">{formatTime(currentTime)} / {formatTime(total)}</span>
        <div className="ml-auto flex items-center gap-1">
          {onChange && <>
            <Button type="button" size="icon-xs" variant="ghost" aria-label="Move scene earlier" title="Move scene earlier" disabled={active === 0} onClick={() => moveScene(-1)}><ArrowLeft /></Button>
            <Button type="button" size="icon-xs" variant="ghost" aria-label="Move scene later" title="Move scene later" disabled={active === project.scenes.length - 1} onClick={() => moveScene(1)}><ArrowRight /></Button>
            <Button type="button" size="icon-xs" variant="ghost" aria-label="Duplicate scene" title="Duplicate scene" disabled={project.scenes.length >= MAX_SCENES} onClick={() => addScene(true)}><Copy /></Button>
            <Button type="button" size="icon-xs" variant="ghost" aria-label="Delete scene" title="Delete scene" disabled={project.scenes.length < 2} onClick={deleteScene}><Trash2 /></Button>
            <Button type="button" size="xs" variant="outline" disabled={project.scenes.length >= MAX_SCENES} onClick={() => addScene(false)}><Plus /> Scene</Button>
          </>}
        </div>
      </div>
      <input aria-label="Seek animation" type="range" min={0} max={total} step="any" value={currentTime}
        aria-valuetext={formatTime(currentTime)} onChange={(event) => seek(Number(event.target.value))} className="mt-1 block w-full accent-primary" />
      <div className="mt-1 flex gap-1 overflow-x-auto" aria-label="Scenes">
        {project.scenes.map((item, index) => <button key={item.id} type="button" aria-pressed={active === index}
          onClick={() => openScene(index)} style={{ flexGrow: item.duration }} title={`${item.name} · ${item.duration}s`}
          className={cn("flex min-w-20 basis-0 items-center gap-1.5 rounded-control border px-2 py-1.5 text-left text-xs hover:bg-accent", active === index && "border-primary/60 bg-primary/10")}>
          <span aria-hidden="true" className="size-2 shrink-0 rounded-sm ring-1 ring-border" style={{ background: item.background }} />
          <span className="truncate">{item.name || `Scene ${index + 1}`}</span>
        </button>)}
      </div>
    </div>
  </section>;
}
