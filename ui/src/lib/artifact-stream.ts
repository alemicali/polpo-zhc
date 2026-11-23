import type { ToolCallInfo } from "@/hooks/use-polpo";
import { projectDocStream } from "./artifact-doc-stream";
import { projectDesignStream } from "./artifact-design-stream";
import { projectSlidesStream } from "./artifact-slides-stream";
import { projectMotionStream } from "./artifact-motion-stream";
import { streamingWorkbook } from "./artifact-sheet-stream";

const projectors = {
  doc: projectDocStream,
  slides: projectSlidesStream,
  sheets: streamingWorkbook,
  design: projectDesignStream,
  motion: projectMotionStream,
};
export type LiveArtifactKind = keyof typeof projectors;

export function liveArtifactKind(type: unknown, kind: unknown): LiveArtifactKind | undefined {
  if (type === "doc") return "doc";
  if (type !== "html") return;
  if (kind === "slides" || kind === "sheets" || kind === "design" || kind === "motion") return kind;
}

export function projectLiveArtifact(kind: LiveArtifactKind | undefined, tool: ToolCallInfo, args: Record<string, unknown>, base?: string) {
  return kind ? projectors[kind](tool, args, base) : undefined;
}
