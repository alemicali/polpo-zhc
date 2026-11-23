import { Allow, parse } from "partial-json";
import { applyArtifactEdits } from "@polpo-ai/core/artifacts";
import type { ToolCallInfo } from "@/hooks/use-polpo";

export type ArtifactStreamText = { text: string; complete: boolean };

function parseObject(raw: string, allow: number): Record<string, unknown> {
  try {
    const value = parse(raw, allow);
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

/** The outer JSON may end inside a string. Never route on an unfinished artifact ID. */
export function artifactStreamArgs(tool: ToolCallInfo): Record<string, unknown> {
  if (tool.state !== "preparing" && tool.arguments) return tool.arguments;
  const raw = tool.argumentsText ?? "";
  const args = parseObject(raw, Allow.COLLECTION | Allow.STR);
  if (typeof args.id === "string" && parseObject(raw, Allow.COLLECTION).id !== args.id) delete args.id;
  return args;
}

export function projectArtifactText(tool: ToolCallInfo, args: Record<string, unknown>, base?: string): ArtifactStreamText | undefined {
  if (tool.state === "error") return;
  const raw = tool.argumentsText ?? "";
  const closed = tool.state === "preparing" ? parseObject(raw, Allow.COLLECTION) : args;
  if (typeof args.content === "string") {
    return { text: args.content, complete: typeof closed.content === "string" };
  }
  if (base === undefined || !Array.isArray(args.edits) || !Array.isArray(closed.edits)) return;

  // Replay from the saved version every time, even if the transport delivers the same chunk twice.
  const edits: { find: string; replace: string }[] = [];
  for (const [i, draft] of args.edits.entries()) {
    const match = closed.edits[i]?.find;
    if (typeof match !== "string" || !match || typeof draft?.replace !== "string") break;
    if (!draft.replace && closed.edits[i]?.replace === undefined) break;
    edits.push({ find: match, replace: draft.replace });
  }
  if (!edits.length) return;
  try {
    const text = applyArtifactEdits(base, edits);
    const complete = tool.state !== "preparing" || Array.isArray(parseObject(raw, 0).edits);
    return { text, complete };
  } catch { return; }
}
