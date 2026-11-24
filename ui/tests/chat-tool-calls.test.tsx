import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ToolCallGroup, ToolCallList, ToolInvocation } from "../src/components/ai-elements/tool";
import { describeTool, toolErrorReason, type ToolCallInfo } from "../src/components/ai-elements/tool-summary";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "../src/components/ai-elements/reasoning";
import { WhatsAppPreviewCard } from "../src/components/send-preview-card";
import { TooltipProvider } from "../src/components/ui/tooltip";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const render = (node: React.ReactNode) => act(async () => root.render(<TooltipProvider>{node}</TooltipProvider>));
const q = (sel: string) => container.querySelector(sel) as HTMLElement | null;
const qa = (sel: string) => Array.from(container.querySelectorAll(sel)) as HTMLElement[];
const click = (el: Element | null) => act(async () => { (el as HTMLElement).click(); });

const tool = (over: Partial<ToolCallInfo>): ToolCallInfo => ({ id: "t1", name: "read", state: "completed", ...over });

describe("tool call line text", () => {
  test("one plain line per tool kind, present tense while running, past once done", () => {
    expect(describeTool(tool({ name: "read", arguments: { path: "src/app.ts" } })).text).toBe("Read file · src/app.ts");
    expect(describeTool(tool({ name: "read", state: "calling", arguments: { path: "src/app.ts" } })).text).toBe("Reading file · src/app.ts");
    expect(describeTool(tool({ name: "bash", arguments: { command: "npm test\necho done" } })).text).toBe("Ran bash · npm test");
    expect(describeTool(tool({ name: "edit", arguments: { path: "a.md" } })).text).toBe("Edited file · a.md");
    expect(describeTool(tool({ name: "grep", arguments: { path: "src", pattern: "TODO" } })).text).toBe("Searched files · TODO");
    expect(describeTool(tool({ name: "search_web", arguments: { query: "polpo agents" } })).text).toBe("Searched the web for “polpo agents”");
    expect(describeTool(tool({ name: "http_fetch", arguments: { url: "https://polpo.sh" } })).text).toBe("Fetched · https://polpo.sh");
    // unknown tools: their name in sentence case, plus what they are about when known
    expect(describeTool(tool({ name: "get_status" })).text).toBe("Get status");
    expect(describeTool(tool({ name: "create_task", state: "preparing", arguments: { title: "Ship it" } })).text).toBe("Creating task · Ship it");
  });

  test("error reason is the first line of the output, without an Error: prefix", () => {
    expect(toolErrorReason(tool({ state: "error", result: "Error: ENOENT: no such file\n  at x" }))).toBe("ENOENT: no such file");
    expect(toolErrorReason(tool({ state: "error" }))).toBeUndefined();
  });
});

describe("ToolInvocation", () => {
  test("collapsed: a single muted line, no card; click expands plain-text details", async () => {
    await render(<ToolInvocation tool={tool({ name: "bash", arguments: { command: "npm test" }, result: "12 passed" })} />);
    const line = q("[data-testid=tool-call-line]")!;
    expect(line.textContent).toBe("Ran bash · npm test");
    expect(q("[data-testid=tool-call]")!.className).not.toMatch(/\bborder\b|rounded-lg|bg-card/);
    expect(q("[data-testid=tool-call-details]")).toBeNull();

    await click(line);
    const details = q("[data-testid=tool-call-details]")!;
    expect(details.textContent).toContain("$ npm test");
    expect(details.textContent).toContain("12 passed");
    // monospace output, copy icons for input and output
    expect(details.querySelector("pre.font-mono")).not.toBeNull();
    expect(qa("button[aria-label^=Copy]").length).toBe(2);

    await click(line);
    expect(q("[data-testid=tool-call-details]")).toBeNull();
  });

  test("running: shimmering line with live progress, updates in place, settles when done", async () => {
    const base = tool({ name: "wait_for_task", state: "calling", arguments: { taskId: "T-1" } });
    await render(<ToolInvocation tool={{ ...base, progress: { message: "running", status: "in_progress", elapsedMs: 3000 } }} />);
    const label = () => q("[data-testid=tool-call-line] span")!;
    expect(label().textContent).toBe("Waiting for task · T-1");
    expect(label().className).toContain("text-shimmer");
    expect(q("[data-testid=tool-call-line]")!.textContent).toContain("in_progress · 3s");
    // still actionable while running: move the wait to the background
    expect(q("button[aria-label='Move wait to background']")).not.toBeNull();

    await render(<ToolInvocation tool={{ ...base, progress: { message: "running", status: "review", elapsedMs: 9000 } }} />);
    expect(q("[data-testid=tool-call-line]")!.textContent).toContain("review · 9s");

    await render(<ToolInvocation tool={{ ...base, state: "completed", result: "done" }} />);
    expect(label().textContent).toBe("Waited for task · T-1");
    expect(label().className).not.toContain("text-shimmer");
    expect(q("button[aria-label='Move wait to background']")).toBeNull();
  });

  test("streaming input opens the details live and they follow each delta", async () => {
    await render(<ToolInvocation tool={tool({ name: "write", state: "preparing", argumentsText: "{\"path\":\"a" })} />);
    expect(q("[data-testid=tool-call-details]")!.textContent).toContain("{\"path\":\"a");
    await render(<ToolInvocation tool={tool({ name: "write", state: "preparing", argumentsText: "{\"path\":\"a.md\",\"content\":\"hi" })} />);
    expect(q("[data-testid=tool-call-details]")!.textContent).toContain("\"content\":\"hi");
    await render(<ToolInvocation tool={tool({ name: "write", state: "completed", arguments: { path: "a.md", content: "hi" }, result: "ok" })} />);
    expect(q("[data-testid=tool-call-details]")).toBeNull();
    expect(q("[data-testid=tool-call-line]")!.textContent).toBe("Wrote file · a.md");
  });

  test("error: destructive line with a short reason, details on expand", async () => {
    await render(<ToolInvocation tool={tool({ name: "read", state: "error", arguments: { path: "x.ts" }, result: "Error: ENOENT: no such file" })} />);
    expect(q("[data-testid=tool-call-line] span")!.className).toContain("text-destructive");
    expect(q("[data-testid=tool-call-reason]")!.textContent).toBe("· ENOENT: no such file");
    expect(q("[data-testid=tool-call-details]")).toBeNull();
    await click(q("[data-testid=tool-call-line]"));
    const details = q("[data-testid=tool-call-details]")!;
    expect(details.textContent).toContain("Error");
    expect(details.querySelector("pre.text-destructive")!.textContent).toBe("Error: ENOENT: no such file");
  });

  test("diff output keeps its +/- colouring as plain text", async () => {
    await render(<ToolInvocation defaultOpen tool={tool({ name: "edit", arguments: { path: "a.ts" }, result: "@@ -1 +1 @@\n-old\n+new" })} />);
    expect(q("[data-testid=tool-call-details] .text-success")!.textContent).toBe("+new");
    expect(q("[data-testid=tool-call-details] .text-destructive")!.textContent).toBe("-old");
  });

  test("interactive tools: a muted label while preparing, nothing once executed", async () => {
    await render(<ToolInvocation tool={tool({ name: "ask_user", state: "preparing" })} />);
    expect(container.textContent).toBe("Asking a question…");
    await render(<ToolInvocation tool={tool({ name: "ask_user", state: "completed" })} />);
    expect(container.textContent).toBe("");
  });
});

describe("ToolCallGroup", () => {
  const tools: ToolCallInfo[] = [
    tool({ id: "a", name: "read", arguments: { path: "a.ts" }, result: "one" }),
    tool({ id: "b", name: "bash", arguments: { command: "npm test" }, state: "error", result: "exit 1" }),
    tool({ id: "c", name: "grep", arguments: { pattern: "TODO" }, result: "none" }),
  ];

  test("collapses consecutive calls into one plain line with the failures, no status icons", async () => {
    await render(<ToolCallGroup tools={tools} />);
    const line = q("[data-testid=tool-call-group-line]")!;
    expect(line.textContent).toBe("Used 3 tools, 1 failed");
    expect(line.querySelectorAll("svg").length).toBe(1); // just the chevron
    expect(q("[data-testid=tool-call-group-errors]")!.className).toContain("text-destructive");
    expect(qa("[data-testid=tool-call-line]").length).toBe(0);

    await click(line);
    const lines = qa("[data-testid=tool-call-line]");
    expect(lines.map((l) => l.textContent)).toEqual([
      "Read file · a.ts",
      "Ran bash · npm test· exit 1",
      "Searched files · TODO",
    ]);
    // each line expands to its own plain details, inside the group's single box
    await click(lines[2]);
    expect(q("[data-testid=tool-call-details]")!.textContent).toContain("none");
  });

  test("no failures: no failed part", async () => {
    await render(<ToolCallGroup tools={[tools[0], tools[2]]} />);
    expect(q("[data-testid=tool-call-group-line]")!.textContent).toBe("Used 2 tools");
  });

  test("running: shimmering 'Using N tools' with the call in progress, live", async () => {
    const running = [tools[0], tool({ id: "d", name: "bash", state: "calling", arguments: { command: "npm run build" } })];
    await render(<ToolCallGroup tools={running} />);
    const line = q("[data-testid=tool-call-group-line]")!;
    expect(line.textContent).toBe("Using 2 tools· Running bash · npm run build");
    expect(line.querySelector(".text-shimmer")).not.toBeNull();
    await render(<ToolCallGroup tools={[tools[0], { ...running[1], state: "completed", result: "ok" }]} />);
    expect(q("[data-testid=tool-call-group-line]")!.textContent).toBe("Used 2 tools");
    expect(q("[data-testid=tool-call-group-line] .text-shimmer")).toBeNull();
  });

  test("a list of several calls (messages without segments) is grouped too", async () => {
    await render(<ToolCallList tools={tools} />);
    expect(q("[data-testid=tool-call-group-line]")!.textContent).toBe("Used 3 tools, 1 failed");
  });
});

describe("thinking", () => {
  test("a plain 'Thought for …' line, the text in one light box on click", async () => {
    await render(
      <Reasoning duration={4}>
        <ReasoningTrigger />
        <ReasoningContent>Let me check the file first.</ReasoningContent>
      </Reasoning>,
    );
    const trigger = container.querySelector("button")!;
    expect(trigger.textContent).toBe("Thought for 4 seconds");
    expect(trigger.querySelectorAll("svg").length).toBe(1); // chevron only
    await click(trigger);
    expect(container.textContent).toContain("Let me check the file first.");
  });
});

describe("approval cards stay actionable", () => {
  test("WhatsApp send preview: Send still calls back", async () => {
    const onRespond = vi.fn(async () => ({ id: "m1" }));
    await render(<WhatsAppPreviewCard preview={{ kind: "text", to: "+39123", message: "Ciao" }} onRespond={onRespond} />);
    const send = qa("button").find((b) => b.textContent?.trim() === "Send")!;
    await click(send);
    expect(onRespond).toHaveBeenCalledWith("send", undefined);
  });
});
