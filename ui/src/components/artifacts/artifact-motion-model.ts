export type MotionAnimation = "none" | "fade" | "rise" | "slide";

export interface MotionLayer {
  id: string;
  type: "text" | "rect" | "ellipse";
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
  text?: string;
  fontSize?: number;
  animation?: MotionAnimation;
  delay?: number;
  animationDuration?: number;
}

export interface MotionScene {
  id: string;
  name: string;
  duration: number;
  background: string;
  transition?: "cut" | "fade";
  layers: MotionLayer[];
}

export interface MotionProject {
  version: 1;
  width: number;
  height: number;
  scenes: MotionScene[];
}

export const MAX_SCENES = 24;
export const MAX_LAYERS = 40;
export const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const dimension = (value: unknown): value is number => finite(value) && Number.isInteger(value) && value >= 64 && value <= 1920;
const color = (value: unknown) => typeof value === "string" && /^#[\da-f]{6}$/i.test(value);
const animations: readonly unknown[] = ["none", "fade", "rise", "slide"];
const record = (value: unknown) => value && typeof value === "object" ? value as Record<string, unknown> : null;

export function parseMotion(content: string): MotionProject | null {
  try {
    const model = record(JSON.parse(content));
    if (!model || model.version !== 1 || !dimension(model.width) || !dimension(model.height)) return null;
    if (!Array.isArray(model.scenes) || !model.scenes.length || model.scenes.length > MAX_SCENES) return null;
    const sceneIds = new Set<string>();
    for (const value of model.scenes) {
      const scene = record(value);
      if (!scene || typeof scene.id !== "string" || !scene.id || sceneIds.has(scene.id) || typeof scene.name !== "string") return null;
      sceneIds.add(scene.id);
      if (!finite(scene.duration) || scene.duration < 0.25 || scene.duration > 60 || !color(scene.background)) return null;
      if (scene.transition !== undefined && scene.transition !== "cut" && scene.transition !== "fade") return null;
      if (!Array.isArray(scene.layers) || scene.layers.length > MAX_LAYERS) return null;
      const layerIds = new Set<string>();
      for (const candidate of scene.layers) {
        const layer = record(candidate);
        if (!layer || typeof layer.id !== "string" || !layer.id || layerIds.has(layer.id)) return null;
        layerIds.add(layer.id);
        if (layer.type !== "text" && layer.type !== "rect" && layer.type !== "ellipse") return null;
        if (!finite(layer.x) || !finite(layer.y) || !finite(layer.width) || !finite(layer.height) || layer.width < 1 || layer.height < 1 || !color(layer.color)) return null;
        if (layer.text !== undefined && typeof layer.text !== "string") return null;
        if (layer.fontSize !== undefined && (!finite(layer.fontSize) || layer.fontSize < 1 || layer.fontSize > 1000)) return null;
        if (layer.delay !== undefined && (!finite(layer.delay) || layer.delay < 0 || layer.delay > 60)) return null;
        if (layer.animationDuration !== undefined && (!finite(layer.animationDuration) || layer.animationDuration < 0.05 || layer.animationDuration > 60)) return null;
        if (layer.animation !== undefined && !animations.includes(layer.animation)) return null;
      }
    }
    return model as unknown as MotionProject;
  } catch {
    return null;
  }
}

export function sceneOffsets(project: MotionProject): number[] {
  const offsets = [0];
  for (const scene of project.scenes) offsets.push(offsets[offsets.length - 1] + scene.duration);
  return offsets;
}

export function sceneAt(offsets: number[], time: number): number {
  const next = offsets.findIndex((start) => start > time);
  return next === -1 ? offsets.length - 2 : Math.max(0, next - 1);
}

function wrapText(ctx: CanvasRenderingContext2D, text: string, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(/\s+/)) {
      const next = line ? `${line} ${word}` : word;
      if (line && ctx.measureText(next).width > width) {
        lines.push(line);
        line = word;
      } else {
        line = next;
      }
    }
    lines.push(line);
  }
  return lines;
}

function drawLayer(ctx: CanvasRenderingContext2D, layer: MotionLayer, time: number, staticFrame: boolean) {
  const delay = layer.delay ?? 0;
  if (!staticFrame && time < delay) return;
  const progress = staticFrame ? 1 : clamp((time - delay) / (layer.animationDuration ?? 0.52), 0, 1);
  const eased = 1 - (1 - progress) ** 3;
  const dx = layer.animation === "slide" ? (1 - eased) * 48 : 0;
  const dy = layer.animation === "rise" ? (1 - eased) * 40 : 0;
  ctx.save();
  if (layer.animation && layer.animation !== "none") ctx.globalAlpha *= eased;
  ctx.translate(layer.x + dx, layer.y + dy);
  ctx.fillStyle = layer.color;
  if (layer.type === "ellipse") {
    ctx.beginPath();
    ctx.ellipse(layer.width / 2, layer.height / 2, layer.width / 2, layer.height / 2, 0, 0, Math.PI * 2);
    ctx.fill();
  } else if (layer.type === "rect") {
    ctx.fillRect(0, 0, layer.width, layer.height);
  } else {
    const size = layer.fontSize ?? 56;
    const lineHeight = size * 1.16;
    ctx.font = `600 ${size}px system-ui, sans-serif`;
    ctx.textBaseline = "top";
    ctx.beginPath();
    ctx.rect(0, 0, layer.width, layer.height);
    ctx.clip();
    wrapText(ctx, layer.text ?? "", layer.width).forEach((line, index) => {
      ctx.fillText(line, 0, index * lineHeight, layer.width);
    });
  }
  ctx.restore();
}

const fadeBuffers = new WeakMap<CanvasRenderingContext2D, CanvasRenderingContext2D>();

export function drawMotionFrame(
  ctx: CanvasRenderingContext2D,
  project: MotionProject,
  offsets: number[],
  seconds: number,
  editing?: { selectedId?: string; drag?: Pick<MotionLayer, "id" | "x" | "y"> },
) {
  const index = sceneAt(offsets, seconds);
  const scene = project.scenes[index];
  const time = seconds - offsets[index];
  const drawScene = (target: CanvasRenderingContext2D, active: MotionScene, sceneTime: number, editingScene = false) => {
    target.save();
    target.fillStyle = active.background;
    target.fillRect(0, 0, project.width, project.height);
    for (const layer of active.layers) {
      const drag = editingScene ? editing?.drag : undefined;
      drawLayer(target, drag?.id === layer.id ? { ...layer, x: drag.x, y: drag.y } : layer, sceneTime, editingScene && Boolean(editing));
    }
    target.restore();
  };
  const fadeTime = Math.min(0.4, scene.duration / 3);
  const previous = project.scenes[index - 1];
  if (!editing && previous && scene.transition === "fade" && time < fadeTime) {
    let buffer = fadeBuffers.get(ctx);
    if (!buffer) {
      buffer = ctx.canvas.ownerDocument.createElement("canvas").getContext("2d") ?? undefined;
      if (buffer) fadeBuffers.set(ctx, buffer);
    }
    if (!buffer) {
      drawScene(ctx, scene, time);
      return;
    }
    if (buffer.canvas.width !== project.width) buffer.canvas.width = project.width;
    if (buffer.canvas.height !== project.height) buffer.canvas.height = project.height;
    drawScene(ctx, previous, previous.duration);
    drawScene(buffer, scene, time);
    ctx.save();
    ctx.globalAlpha = time / fadeTime;
    ctx.drawImage(buffer.canvas, 0, 0);
    ctx.restore();
  } else {
    drawScene(ctx, scene, time, true);
  }
  if (!editing?.selectedId) return;
  const layer = scene.layers.find((item) => item.id === editing.selectedId);
  if (!layer) return;
  const position = editing.drag?.id === layer.id ? editing.drag : layer;
  const stroke = project.width / 410;
  ctx.save();
  ctx.strokeStyle = "#111827";
  ctx.lineWidth = stroke * 2;
  ctx.strokeRect(position.x, position.y, layer.width, layer.height);
  ctx.setLineDash([stroke * 2, stroke]);
  ctx.strokeStyle = "#f8fafc";
  ctx.lineWidth = stroke;
  ctx.strokeRect(position.x, position.y, layer.width, layer.height);
  ctx.restore();
}

export const MOTION_STARTER = JSON.stringify({
  version: 1,
  width: 1280,
  height: 720,
  scenes: [
    {
      id: "intro", name: "Opening", duration: 3.5, background: "#14262a",
      layers: [
        { id: "orb", type: "ellipse", x: 818, y: 125, width: 388, height: 388, color: "#1e4547", animation: "slide" },
        { id: "dot", type: "ellipse", x: 934, y: 237, width: 155, height: 155, color: "#c9eb75", animation: "rise", delay: 0.2 },
        { id: "heading", type: "text", x: 100, y: 225, width: 716, height: 220, color: "#f6faf7", text: "A story\nin motion", fontSize: 92, animation: "rise" },
        { id: "subheading", type: "text", x: 105, y: 502, width: 682, height: 48, color: "#c9eb75", text: "Edit any layer to make it yours.", fontSize: 32, animation: "fade", delay: 0.35 },
      ],
    },
    {
      id: "close", name: "Closing", duration: 2.5, background: "#c9eb75", transition: "fade",
      layers: [
        { id: "closing-label", type: "text", x: 105, y: 250, width: 1070, height: 224, color: "#14262a", text: "The next scene\nstarts here.", fontSize: 96, animation: "rise" },
      ],
    },
  ],
} satisfies MotionProject, null, 2);
