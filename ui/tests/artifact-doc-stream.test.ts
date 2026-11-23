import { expect, test } from "vitest";
import { readDocTabs, writeDocTabs } from "../src/components/artifacts/artifact-doc-tabs";
import type { ToolCallInfo } from "../src/hooks/use-polpo";
import { projectDocStream } from "../src/lib/artifact-doc-stream";
import { artifactStreamArgs } from "../src/lib/artifact-stream-text";

const stream = (argumentsText: string, name = "artifact_create"): ToolCallInfo => ({
  id: "tool_docs", name, state: "preparing", argumentsText,
});

const project = (text: string, base?: string, name = "artifact_create") => {
  const event = stream(text, name);
  return projectDocStream(event, artifactStreamArgs(event), base);
};

test("streams Markdown from an unfinished create argument and avoids incomplete Unicode", () => {
  expect(project('{"type":"doc","content":"# Plan\\n\\nFirst')).toBe("# Plan\n\nFirst");
  expect(project('{"type":"doc","content":"# Plan\\n\\nFirst \uD83D')).toBe("# Plan\n\nFirst ");
  expect(project('{"type":"doc","content":"# Plan\\n\\nFirst 😀"}')).toBe("# Plan\n\nFirst 😀");
  expect(project('{"type":"html","content":"not a document')).toBeUndefined();
});

test("updates a middle paragraph incrementally without removing either side", () => {
  const base = "# Schedule\n\nKeep this introduction.\n\nMeeting at 09:00.\n\nKeep the conclusion.";
  expect(project('{"id":"art_1","edits":[{"find":"Meeting at 09', base, "artifact_update")).toBeUndefined();
  const partial = '{"id":"art_1","edits":[{"find":"Meeting at 09:00.","replace":"Meeting moved';
  expect(project(partial, base, "artifact_update")).toBe(base.replace("Meeting at 09:00.", "Meeting moved"));
  expect(project(partial, base + "\n\nMeeting at 09:00.", "artifact_update")).toBeUndefined();
  expect(project(partial + ' to 10:30."}]}', base, "artifact_update")).toBe(base.replace("Meeting at 09:00.", "Meeting moved to 10:30."));
});

test("keeps an unchanged tail during a clear paragraph rewrite, then uses the complete value", () => {
  const base = "# Schedule\n\nOpening.\n\nOld paragraph.\n\nConclusion.";
  const partial = '{"id":"art_1","content":"# Schedule\\n\\nOpening.\\n\\nChanging the middle';
  expect(project(partial, base, "artifact_update")).toBe("# Schedule\n\nOpening.\n\nChanging the middle\n\nConclusion.");
  expect(project(partial + "\\n\\nConcl", base, "artifact_update")).toBe("# Schedule\n\nOpening.\n\nChanging the middle\n\nConclusion.");
  expect(project(partial + ' only."}', base, "artifact_update")).toBe("# Schedule\n\nOpening.\n\nChanging the middle only.");
});

test("preserves stored tab and annotation markup on an incremental targeted edit", () => {
  const annotation = '<span data-polpo-doc-comment="original_encoded_comment"></span>';
  const base = writeDocTabs({
    namespace: "0123456789abcdefgh",
    tabs: [
      { id: "main", title: "First", content: "# One\n\nOld paragraph.\n\nKeep the suffix." + annotation },
      { id: "tab_2", title: "Second", content: "Leave this tab intact." },
    ],
  });
  const prefix = '{"id":"art_1","edits":[{"find":"Old paragraph.","replace":"New paragraph';
  const projected = project(prefix, base, "artifact_update");
  expect(projected).toBe(base.replace("Old paragraph.", "New paragraph"));
  expect(readDocTabs(projected!).tabs[1].content).toBe("Leave this tab intact.");
});

test("a draft replacing one tab keeps the other tabs until the new content closes", () => {
  const base = writeDocTabs({
    namespace: "0123456789abcdefgh",
    tabs: [
      { id: "main", title: "First", content: "# One\n\nOld paragraph." },
      { id: "tab_2", title: "Second", content: "Keep this tab until the tool completes." },
    ],
  });
  const open = base.slice(0, base.indexOf("Old paragraph.")).replace(/\n/g, "\\n");
  const prefix = '{"id":"art_1","content":"' + open + "New paragraph";
  const projected = project(prefix, base, "artifact_update");
  expect(readDocTabs(projected!).tabs.map((tab) => tab.content)).toEqual([
    "# One\n\nNew paragraph", "Keep this tab until the tool completes.",
  ]);
  expect(project(prefix + '"}', base, "artifact_update")).toBe(open.replace(/\\n/g, "\n") + "New paragraph");
});
