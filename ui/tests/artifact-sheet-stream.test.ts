import { expect, test } from "vitest";
import type { ToolCallInfo } from "../src/hooks/use-polpo";
import { artifactStreamArgs, streamingWorkbook } from "../src/lib/artifact-sheet-stream";

const tool = (text: string, name = "artifact_create"): ToolCallInfo => ({
  id: "call_1", name, state: "preparing", argumentsText: text,
});
const sheet = (cells: Record<string, string>) => JSON.stringify({ version: 1, sheets: [{ name: "Q1", cells }] });

test("complete values appear in the order the model writes them, before the tool is called", () => {
  const values = { A1: 'Q "1"', A2: "120", B2: "=SUM(A2:A2)" };
  const args = JSON.stringify({ title: "Budget", type: "html", content: sheet(values), kind: "sheets" });
  const observed: string[] = [];
  for (let end = 1; end <= args.length; end++) {
    const event = tool(args.slice(0, end));
    const result = streamingWorkbook(event, artifactStreamArgs(event));
    if (!result) continue;
    const cells = JSON.parse(result).sheets[0].cells;
    for (const [key, value] of Object.entries(cells)) expect(value).toBe(values[key as keyof typeof values]);
    const signature = Object.keys(cells).join(",");
    if (observed.at(-1) !== signature) observed.push(signature);
  }
  expect(observed).toEqual(["", "A1", "A1,A2", "A1,A2,B2"]);
});

test("updates keep existing cells while values arrive and apply complete find/replace pairs", () => {
  const base = sheet({ A1: "old", B1: "keep" });
  const args = JSON.stringify({ id: "art_a", content: sheet({ A1: "new", C1: "later" }) });
  const event = tool(args.slice(0, args.indexOf("later") + 2), "artifact_update");
  expect(JSON.parse(streamingWorkbook(event, artifactStreamArgs(event), base)!).sheets[0].cells)
    .toEqual({ A1: "new", B1: "keep" });

  const editArgs = JSON.stringify({ id: "art_a", edits: [{ find: "old", replace: "first" }, { find: "keep", replace: "second" }] });
  const patch = tool(editArgs.slice(0, editArgs.indexOf("second") + 1), "artifact_update");
  expect(JSON.parse(streamingWorkbook(patch, artifactStreamArgs(patch), base)!).sheets[0].cells)
    .toEqual({ A1: "first", B1: "keep" });
  expect(artifactStreamArgs(tool('{"id":"art_a')).id).toBeUndefined();
});

test("other workspaces and invalid workbook values do not become sheets", () => {
  for (const content of ["<html>", '{"version":1,"slides":[]}', '{"version":2,"sheets":[]}']) {
    const event = tool(JSON.stringify({ content }));
    expect(streamingWorkbook(event, artifactStreamArgs(event))).toBeUndefined();
  }
});
