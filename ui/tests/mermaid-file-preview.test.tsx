import React, { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mimeFromPath, previewCategory } from "../src/components/shared/file-preview-utils";
import { useFilePreview } from "../src/components/shared/use-file-preview";
import { MermaidFilePreview } from "../src/components/shared/mermaid-file-preview";
import { mermaidCodeBlock } from "../src/components/shared/mermaid-code-block";

const renderDiagram = vi.fn();
vi.mock("../src/hooks/use-theme", () => ({ useTheme: () => ({ resolved: "dark" }) }));
vi.mock("../src/components/ai-elements/message", () => ({
  MessageResponse: (props: Record<string, unknown>) => {
    renderDiagram(props);
    return <div data-testid="renderer">{props.children as string}</div>;
  },
}));
let root: Root;
let container: HTMLDivElement;
let preview: ReturnType<typeof useFilePreview>;
function Harness({ onPreview }: { onPreview: (value: ReturnType<typeof useFilePreview>) => void }) {
  const value = useFilePreview();
  useEffect(() => onPreview(value));
  return null;
}
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement("div"); document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<Harness onPreview={value => { preview = value; }} />));
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); renderDiagram.mockClear();
});

test.each(["flow.mmd", "FLOW.MERMAID"])("recognizes %s despite legacy binary MIME", path => {
  expect(mimeFromPath(path)).toBe("text/vnd.mermaid");
  expect(previewCategory("application/octet-stream", path)).toBe("mermaid");
  expect(previewCategory(undefined, path)).toBe("mermaid");
});
test.each(["text/vnd.mermaid", "text/mermaid", "text/x-mermaid", "application/mermaid", "text/vnd.mermaid; charset=utf-8"])("recognizes MIME %s", mime => {
  expect(previewCategory(mime)).toBe("mermaid");
});
test("other formats retain their categories", () => {
  expect(previewCategory("text/markdown", "notes.md")).toBe("text");
  expect(previewCategory("image/png", "image.png")).toBe("image");
  expect(previewCategory("application/octet-stream", "archive.zip")).toBe("binary");
});
test("loads full Mermaid source rather than truncated preview", async () => {
  const source = "flowchart TD\n" + "%% comment\n".repeat(600) + "A --> B";
  const fetchMock = vi.fn().mockResolvedValue(new Response(source)); vi.stubGlobal("fetch", fetchMock);
  await act(async () => preview.openPreview({ path: "flow.mmd", label: "flow", mimeType: "application/octet-stream" }));
  expect(fetchMock.mock.calls[0][0]).toContain("/files/read?path=flow.mmd");
  expect(preview.previewState?.content).toBe(source);
});
test("empty files and inline sources are valid", async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response("")); vi.stubGlobal("fetch", fetchMock);
  await act(async () => preview.openPreview({ path: "empty.mmd", label: "empty" }));
  expect(preview.previewState?.content).toBe(""); expect(preview.previewState?.error).toBeUndefined();
  await act(async () => preview.openPreview({ label: "inline.mmd", text: "flowchart LR\nA-->B" }));
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(preview.previewState?.content).toContain("A-->B");
});
test("late fetch cannot replace another file or reopen a closed dialog", async () => {
  let resolve!: (r: Response) => void;
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(r => { resolve = r; })));
  let pending!: Promise<void>;
  await act(async () => { pending = preview.openPreview({ path: "slow.mmd", label: "slow" }); });
  await act(async () => preview.openPreview({ label: "new.mmd", text: "flowchart LR\nNew-->File" }));
  await act(async () => { resolve(new Response("old")); await pending; });
  expect(preview.previewState?.item.label).toBe("new.mmd");
  await act(async () => { pending = preview.openPreview({ path: "slow.mmd", label: "slow" }); });
  await act(async () => preview.closePreview());
  await act(async () => { resolve(new Response("old")); await pending; });
  expect(preview.previewState).toBeNull();
});
test("oversized files fail before fetching", async () => {
  const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
  await act(async () => preview.openPreview({ path: "huge.mmd", label: "huge", size: 2 * 1024 * 1024 }));
  expect(fetchMock).not.toHaveBeenCalled(); expect(preview.previewState?.error).toContain("1 MB");
});
test("renderer uses strict security and offers diagram/source tabs", async () => {
  await act(async () => root.render(<MermaidFilePreview content={"flowchart TD\nA-->B"} />));
  expect(container.textContent).toContain("Diagram"); expect(container.textContent).toContain("Source");
  const props = renderDiagram.mock.lastCall![0];
  expect(props.mermaid.config.securityLevel).toBe("strict");
  expect(props.controls.mermaid.panZoom).toBe(true);
  const sourceTab = container.querySelectorAll<HTMLButtonElement>('[role="tab"]')[1];
  await act(async () => sourceTab.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 })));
  expect(container.querySelector('[aria-label="Mermaid source"]')?.textContent).toBe("flowchart TD\nA-->B");
});
test.each(["", "a".repeat(50_001)])("empty/oversized diagrams do not invoke renderer (%#)", async content => {
  await act(async () => root.render(<MermaidFilePreview content={content} />));
  expect(renderDiagram).not.toHaveBeenCalled(); expect(container.querySelector('[role="status"]')).not.toBeNull();
});
test("source cannot escape its Markdown fence", () => {
  expect(mermaidCodeBlock("%% ```\nA-->B")).toBe("````mermaid\n%% ```\nA-->B\n````");
});
