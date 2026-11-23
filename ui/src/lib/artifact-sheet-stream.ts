import { Allow, parse } from "partial-json";
import { applyArtifactEdits } from "@polpo-ai/core/artifacts";
import type { ToolCallInfo } from "@/hooks/use-polpo";
import { cellAddress, readWorkbook, WORKBOOK_SHEETS, type Sheet, type Workbook } from "@/components/artifacts/artifact-sheets-model";

const fields = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

function readPartial(text: string, allow: number): Record<string, unknown> {
  try { return fields(parse(text, allow)); } catch { return {}; }
}

export { artifactStreamArgs } from "./artifact-stream-text";

// Tool arguments contain a string whose contents are themselves a workbook.
// Keep incomplete containers at both levels, but only publish completed cell values.
export function streamingWorkbook(tool: ToolCallInfo, args: Record<string, unknown>, base?: string): string | undefined {
  if (args.kind !== undefined && args.kind !== "sheets") return;
  if (typeof args.content !== "string") {
    if (!base || !args.edits) return;
    const closed = tool.state === "preparing"
      ? readPartial(tool.argumentsText ?? "", Allow.COLLECTION) : args;
    if (!Array.isArray(closed.edits)) return;
    const edits: { find: string; replace: string }[] = [];
    for (const value of closed.edits) {
      const edit = fields(value);
      if (typeof edit.find !== "string" || typeof edit.replace !== "string") break;
      edits.push({ find: edit.find, replace: edit.replace });
    }
    if (!edits.length) return;
    try {
      const result = applyArtifactEdits(base, edits);
      return readWorkbook(result) ? result : undefined;
    } catch { return; }
  }
  if (!args.content.trimStart().startsWith("{")) return;
  const complete = readWorkbook(args.content);
  if (complete) return args.content;
  const parsed = readPartial(args.content, Allow.COLLECTION);
  if (parsed.version !== 1 || !Array.isArray(parsed.sheets)) return;
  const previous = base ? readWorkbook(base) : null;
  const sheets: Sheet[] = [];
  for (const item of parsed.sheets.slice(0, WORKBOOK_SHEETS)) {
    const partial = fields(item);
    if (typeof partial.name !== "string" || !partial.name.trim()) continue;
    const original = previous?.sheets.find(sheet => sheet.name === partial.name);
    const cells = { ...original?.cells };
    for (const [address, value] of Object.entries(fields(partial.cells))) {
      if (cellAddress(address) && typeof value === "string") cells[address] = value;
    }
    sheets.push({ ...original, name: partial.name, cells });
  }
  if (!sheets.length) return;
  for (const sheet of previous?.sheets ?? []) {
    if (!sheets.some(s => s.name === sheet.name)) sheets.push(sheet);
  }
  const workbook: Workbook = { version: 1, sheets };
  const result = JSON.stringify(workbook);
  return readWorkbook(result) ? result : undefined;
}
