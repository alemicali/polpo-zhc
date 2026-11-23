import { Allow, parse } from "partial-json";
import type { ToolCallInfo } from "@/hooks/use-polpo";
import {
  isMotionDimension, isMotionLayer, isMotionScene, MAX_LAYERS, MAX_SCENES, parseMotion,
  type MotionLayer, type MotionProject, type MotionScene,
} from "@/components/artifacts/artifact-motion-model";
import { projectArtifactText } from "./artifact-stream-text";

function fields(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function mergeInOrder<T extends { id: string }>(
  incoming: unknown[],
  previous: T[],
  limit: number,
  projectItem: (patch: Record<string, unknown>, base: T | undefined) => T | undefined,
): T[] {
  const items = new Map(previous.map(item => [item.id, item]));
  const seen = new Set<string>();
  for (const value of incoming.slice(0, limit)) {
    const patch = fields(value);
    if (typeof patch.id !== "string" || seen.has(patch.id)) continue;
    seen.add(patch.id);
    const base = items.get(patch.id);
    if (!base && items.size >= limit) continue;
    const draft = projectItem(patch, base);
    if (draft) items.set(draft.id, draft);
  }
  return [...items.values()];
}

function projectLayer(patch: Record<string, unknown>, previous: MotionLayer | undefined): MotionLayer | undefined {
  const draft = { ...previous, ...patch };
  return isMotionLayer(draft) ? draft : undefined;
}

function projectScene(patch: Record<string, unknown>, previous: MotionScene | undefined): MotionScene | undefined {
  const originalLayers = previous?.layers ?? [];
  const layers = Array.isArray(patch.layers) ? mergeInOrder(patch.layers, originalLayers, MAX_LAYERS, projectLayer) : originalLayers;
  const draft = { ...previous, ...patch, ...(previous ? { duration: previous.duration } : {}), layers };
  return isMotionScene(draft) ? draft : undefined;
}

/** Projects complete scene and layer fields from a partially written Motion document. */
export function projectMotionStream(tool: ToolCallInfo, args: Record<string, unknown>, base?: string): string | undefined {
  if (args.kind !== undefined && args.kind !== "motion") return;
  if (args.type !== undefined && args.type !== "html") return;
  let input = args;
  if (tool.state === "preparing" && typeof args.content !== "string" && Array.isArray(args.edits)) {
    let edits: unknown;
    try { edits = fields(parse(tool.argumentsText ?? "", Allow.COLLECTION)).edits; } catch { return; }
    if (!Array.isArray(edits)) return;
    input = { ...args, edits };
  }
  const source = projectArtifactText(tool, input, base);
  if (!source) return;
  if (parseMotion(source.text)) return source.text;
  if (source.complete || !source.text.trimStart().startsWith("{")) return;

  let partial: Record<string, unknown>;
  try {
    // Missing closing delimiters are normal while streaming. Half-written strings and numbers
    // should never replace the renderer's last accepted values.
    partial = fields(parse(source.text, Allow.COLLECTION));
  } catch {
    return;
  }
  if (partial.version !== 1 || !Array.isArray(partial.scenes)) return;

  const previous = base ? parseMotion(base) : null;
  const width = previous?.width ?? partial.width;
  const height = previous?.height ?? partial.height;
  if (!isMotionDimension(width) || !isMotionDimension(height)) return;
  const scenes = mergeInOrder(partial.scenes, previous?.scenes ?? [], MAX_SCENES, projectScene);
  if (!scenes.length) return;
  const project: MotionProject = {
    version: 1,
    width,
    height,
    scenes,
    ...(previous?.audio ? { audio: previous.audio } : {}),
  };
  return JSON.stringify(project);
}
