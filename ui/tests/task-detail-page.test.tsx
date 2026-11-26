import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { RunActivityEntry, Task, TaskDirection } from "@polpo-ai/react";

// ── SDK mock: the task, its activity and directions live in a store the test changes ──
const store = vi.hoisted(() => ({
  task: null as unknown as Task,
  entries: [] as RunActivityEntry[],
  directions: [] as TaskDirection[],
  process: undefined as unknown,
  sendDirection: (() => Promise.resolve()) as (req: unknown) => Promise<unknown>,
  version: 0,
  listeners: new Set<() => void>(),
  bump() { store.version += 1; store.listeners.forEach((l) => l()); },
}));

vi.mock("@polpo-ai/react", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { useSyncExternalStore } = await import("react");
  const useVersion = () => useSyncExternalStore(
    (cb) => { store.listeners.add(cb); return () => store.listeners.delete(cb); },
    () => store.version,
  );
  const noop = async () => {};
  return {
    ...actual,
    useTask: () => {
      useVersion();
      return { task: store.task, isLoading: false, error: null, updateTask: noop, retryTask: noop, killTask: noop, reassessTask: noop, queueTask: noop };
    },
    useTasks: () => ({ tasks: [{ id: "dep1", title: "Set up the repo", status: "done" }] }),
    useProcesses: () => { useVersion(); return { processes: store.process ? [store.process] : [] }; },
    useAgents: () => ({ agents: [{ name: "coder", identity: { displayName: "Cody" } }] }),
    useAssessmentProgress: () => ({ progress: [], isAssessing: false, checks: [] }),
    useMissions: () => ({ missions: [] }),
    useEvents: () => ({ events: [] }),
    useTaskActivity: () => {
      useVersion();
      return { entries: store.entries, isLoading: false, error: null, refetch: noop };
    },
    useTaskDirections: (taskId: string | null) => {
      useVersion();
      return { directions: taskId ? store.directions : [], isLoading: false, isSending: false, error: null, sendDirection: store.sendDirection, refetch: noop };
    },
  };
});
vi.mock("@/hooks/use-computers", () => ({ useComputers: () => ({ computers: [] }) }));

import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { TooltipProvider } from "../src/components/ui/tooltip";
import { TaskDetailPage } from "../src/pages/task-detail";
import { TASK_EXECUTION_VIEW_KEY } from "../src/lib/task-execution-view";

const at = (minute: number) => new Date(Date.UTC(2026, 10, 24, 10, minute)).toISOString();

function makeTask(over: Partial<Task> = {}): Task {
  return {
    id: "task-123456789abc",
    title: "Fix the flaky tests",
    description: "Make **the test suite** green again.",
    assignTo: "coder",
    group: "Release 2.0",
    missionId: "m1",
    dependsOn: ["dep1"],
    status: "failed",
    expectations: [{ type: "test", command: "npm test" }],
    metrics: [],
    retries: 2,
    maxRetries: 3,
    sessionId: "sess-42",
    failure: { reason: "Model access denied for claude-x", retryable: false, kind: "model_access" },
    result: { exitCode: 1, stdout: "", stderr: "boom", duration: 65_000, retryable: false },
    outcomes: [{ id: "o1", type: "text", label: "Summary report", text: "All good" }],
    runs: [{
      runId: "r1", startedAt: at(1), endedAt: at(7), status: "failed", engine: "claude-code", model: "claude-x",
      computer: { id: "host", kind: "host" }, egress: { mode: "direct" },
      cost: { harnessUsd: 0.42 },
    }],
    createdAt: at(0),
    updatedAt: at(8),
    ...over,
  } as Task;
}

const transcript: RunActivityEntry[] = [
  { _run: true, runId: "r1", startedAt: at(1), agentName: "coder" },
  { ts: at(2), type: "reasoning", text: "Checking the suite first." },
  { ts: at(2), type: "tool_use", tool: "read", toolId: "c1", input: { path: "package.json" } },
  { ts: at(3), type: "tool_result", tool: "read", toolId: "c1", content: "{}" },
  { ts: at(3), type: "tool_use", tool: "bash", toolId: "c2", input: { command: "npm test" } },
  { ts: at(4), type: "tool_result", tool: "bash", toolId: "c2", content: "1 failed", isError: true },
  { ts: at(4), type: "assistant", text: "One test fails." },
  { ts: at(5), event: "direction:applied", data: { directionIds: ["d1"] } },
  { ts: at(6), event: "done", data: { status: "failed", error: "timeout" } },
  { _run: true, runId: "r2", startedAt: at(10), agentName: "coder" },
  { ts: at(11), type: "assistant", text: "Second try." },
];

let root: Root;
let container: HTMLDivElement;
const probe = { location: "" };

function LocationProbe() {
  const loc = useLocation();
  useEffect(() => { probe.location = `${loc.pathname}${loc.search}`; }, [loc]);
  return null;
}

async function renderAt(url: string) {
  await act(async () => {
    root.render(
      <TooltipProvider>
        <MemoryRouter initialEntries={[url]}>
          <Routes>
            <Route path="/tasks/:taskId" element={<><TaskDetailPage /><LocationProbe /></>} />
          </Routes>
        </MemoryRouter>
      </TooltipProvider>,
    );
  });
  await flush();
}

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const q = (sel: string) => container.querySelector(sel) as HTMLElement | null;
const qa = (sel: string) => Array.from(container.querySelectorAll(sel)) as HTMLElement[];
const text = (sel: string) => q(sel)?.textContent ?? "";

/** Radix tabs switch on mousedown. */
async function openTab(name: string) {
  const trigger = qa("[role=tab]").find((t) => t.textContent?.trim() === name)!;
  await act(async () => { trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 })); });
  await flush();
}
const click = async (el: Element | null) => { await act(async () => { (el as HTMLElement).click(); }); await flush(); };

function typeInto(el: HTMLTextAreaElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true, data: [] }), { status: 200 })));
  localStorage.clear();
  store.task = makeTask();
  store.entries = transcript;
  store.directions = [{ id: "d1", taskId: "task-123456789abc", runId: "r1", mode: "steer", message: "Use vitest, not jest", status: "applied", createdAt: at(5), appliedAt: at(5) }];
  store.process = undefined;
  store.sendDirection = vi.fn(async (req: unknown) => ({ action: "continue", direction: { id: "d2", ...(req as object) } }));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("task page header and Details tab", () => {
  test("the header is slim: title, status and actions only", async () => {
    await renderAt("/tasks/task-123456789abc");
    const header = q("[data-testid=task-header]")!;
    expect(header.textContent).toContain("Fix the flaky tests");
    expect(text("[data-testid=task-status-badge]")).toMatch(/failed/i);
    expect(header.textContent).toContain("Retry");
    // no informational content up there any more
    for (const moved of ["Cody", "coder", "Release 2.0", "task-1234567", "sess-42", "Created"]) {
      expect(header.textContent).not.toContain(moved);
    }
    expect(header.querySelector("[data-testid=task-cost-badge]")).toBeNull();
    // nothing between the header and the tabs: run card, tool scope and steering are in the tabs
    const page = header.parentElement!;
    expect(Array.from(page.children).indexOf(header)).toBe(0);
    expect(page.children[1]!.querySelector("[role=tablist]")).not.toBeNull();
    expect(page.querySelector(":scope > [data-testid=run-context-card]")).toBeNull();
    expect(page.querySelector(":scope > [data-testid=task-tool-scope]")).toBeNull();
  });

  test("everything informational is reachable on the Details tab (the default)", async () => {
    await renderAt("/tasks/task-123456789abc");
    const details = q("[data-testid=task-details-tab]")!;
    expect(details).not.toBeNull();
    const overview = details.querySelector("[data-testid=task-overview]")!;
    expect(overview.textContent).toMatch(/failed/i);
    expect(overview.querySelector("[data-testid=task-agent]")!.textContent).toContain("Cody");
    expect(overview.querySelector("[data-testid=task-mission]")!.getAttribute("href")).toBe("/missions/m1");
    expect(overview.querySelector("[data-testid=task-cost-badge]")).not.toBeNull();
    expect(overview.textContent).toContain("sess-42");
    expect(overview.textContent).toContain("Created");
    // runs: engine, model, cost per run
    expect(details.querySelector("[data-testid=run-context-card]")).not.toBeNull();
    expect(details.querySelector("[data-testid=run-model]")?.textContent).toContain("claude-x");
    // tool scope, failure reason with "Not retried", retries, dependencies, prompt, outcomes, expectations
    expect(details.querySelector("[data-testid=task-tool-scope]")).not.toBeNull();
    expect(text("[data-testid=task-failure]")).toContain("Model access denied for claude-x");
    expect(text("[data-testid=task-not-retried]")).toContain("Not retried");
    expect(details.textContent).toContain("2 / 3");
    expect(details.textContent).toContain("Set up the repo");
    expect(details.textContent).toContain("Description");
    expect(details.textContent).toContain("Summary report");
    expect(details.textContent).toContain("Expectations (1)");
    // steering is not here
    expect(details.querySelector("[aria-label='Task direction']")).toBeNull();
    expect(details.querySelector("[data-testid=task-chat-composer]")).toBeNull();
  });
});

describe("a task a decision left out", () => {
  test("shows Not reached (not done) with the decision that chose another branch", async () => {
    store.task = makeTask({
      status: "done", failure: undefined, runs: [],
      result: { exitCode: 0, stdout: 'Skipped: the decision "route" took the branch "support" (decision: support (0.81))', stderr: "", duration: 0,
        skipped: { reason: "decision", node: "route", branch: "support", answer: "decision: support (0.81)", confidence: 0.81 } },
    });
    await renderAt("/tasks/task-123456789abc");
    const badge = q("[data-testid=task-status-badge]")!;
    expect(badge.textContent).toBe("Not reached");
    expect(badge.getAttribute("title")).toBe("Decision route chose support");
    expect(badge.className).not.toContain("text-success");
    expect(text("[data-testid=task-not-reached]")).toContain("Decision route chose support");
    expect(text("[data-testid=task-overview]")).not.toMatch(/\bDone\b/);
  });

  test("a task skipped before the marker existed is recognised from its result text", async () => {
    store.task = makeTask({ status: "done", failure: undefined, runs: [], result: { exitCode: 0, stdout: 'Skipped: the decision "route" took no branch (no answer)', stderr: "", duration: 0 } });
    await renderAt("/tasks/task-123456789abc");
    expect(text("[data-testid=task-status-badge]")).toBe("Not reached");
    expect(text("[data-testid=task-not-reached]")).toContain("Decision route chose no branch");
  });
});

describe("Execution tab", () => {
  test("steer / continue lives only in Execution; the Log view is the event list", async () => {
    await renderAt("/tasks/task-123456789abc");
    expect(q("[aria-label='Task direction']")).toBeNull();
    await openTab("Execution");
    expect(probe.location).toContain("tab=execution");
    const execution = q("[data-testid=task-execution-tab]")!;
    expect(execution.querySelector("[aria-label='Task direction']")).not.toBeNull();
    expect(execution.textContent).toContain("Continue task");
    expect(qa("section[aria-label^='Run ']").length).toBe(2);
  });

  test("Log/Chat toggle: kept per person in localStorage and in the URL", async () => {
    await renderAt("/tasks/task-123456789abc?tab=execution");
    expect(q("[data-testid=task-chat-view]")).toBeNull();
    await click(q("[data-testid=execution-view-chat]"));
    expect(q("[data-testid=task-chat-view]")).not.toBeNull();
    expect(localStorage.getItem(TASK_EXECUTION_VIEW_KEY)).toBe("chat");
    expect(probe.location).toContain("view=chat");

    // a fresh visit without ?view= opens the saved view
    await act(async () => root.unmount());
    root = createRoot(container);
    await renderAt("/tasks/task-123456789abc?tab=execution");
    expect(q("[data-testid=task-chat-view]")).not.toBeNull();
  });

  test("Log/Chat toggle still works when storage is blocked", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    await renderAt("/tasks/task-123456789abc?tab=execution");
    expect(q("[data-testid=task-chat-view]")).toBeNull();
    await click(q("[data-testid=execution-view-chat]"));
    expect(q("[data-testid=task-chat-view]")).not.toBeNull();
    await click(q("[data-testid=execution-view-log]"));
    expect(q("[data-testid=task-chat-view]")).toBeNull();
  });

  test("deep links: ?tab=execution&view=chat, and the older ?tab=detail / ?tab=activity", async () => {
    await renderAt("/tasks/task-123456789abc?tab=execution&view=chat");
    expect(q("[data-testid=task-chat-view]")).not.toBeNull();
    await act(async () => root.unmount());

    root = createRoot(container);
    await renderAt("/tasks/task-123456789abc?tab=detail");
    expect(q("[data-testid=task-details-tab]")).not.toBeNull();
    await act(async () => root.unmount());

    root = createRoot(container);
    await renderAt("/tasks/task-123456789abc?tab=activity");
    expect(q("[data-testid=task-execution-tab]")).not.toBeNull();
    await act(async () => root.unmount());

    root = createRoot(container);
    await renderAt("/tasks/task-123456789abc?tab=details");
    expect(q("[data-testid=task-details-tab]")).not.toBeNull();
  });
});

describe("Execution → Chat", () => {
  test("the run is drawn with the chat's parts: instructions, reasoning, grouped tools, steer, run separators", async () => {
    await renderAt("/tasks/task-123456789abc?tab=execution&view=chat");
    const view = q("[data-testid=task-chat-view]")!;
    const users = qa("[data-testid=task-chat-user]");
    expect(users.map((u) => u.getAttribute("data-kind"))).toEqual(["prompt", "steer"]);
    expect(users[0]!.querySelector("[data-testid=chat-user-bubble]")!.textContent).toContain("Make **the test suite** green again.");
    expect(users[1]!.textContent).toContain("Use vitest, not jest");
    // the chat's tool grouping line, failures counted
    const group = view.querySelector("[data-testid=tool-call-group-line]")!;
    expect(group.textContent).toContain("Used 2 tools");
    expect(group.textContent).toContain("1 failed");
    // the chat's reasoning block
    expect(view.textContent).toMatch(/Thought|Thinking|Reasoning/);
    // assistant turns carry the agent's name
    expect(qa("[data-testid=task-chat-assistant]").length).toBeGreaterThanOrEqual(2);
    expect(qa("[data-testid=task-chat-assistant]")[0]!.textContent).toContain("Cody");
    // a section per run, the later one marked as a retry
    const dividers = qa("[data-testid=task-chat-run-divider]");
    expect(dividers.map((d) => d.getAttribute("aria-label"))).toEqual(["Run 1", "Run 2 · retry"]);
  });

  test("live: a new activity entry appends to the conversation", async () => {
    store.task = makeTask({ status: "in_progress" });
    store.process = { taskId: "task-123456789abc", agentName: "coder", pid: 1, startedAt: at(10), alive: true, activity: { filesCreated: [], filesEdited: [], toolCalls: 0 } };
    await renderAt("/tasks/task-123456789abc?tab=execution&view=chat");
    expect(q("[data-testid=task-chat-working]")).not.toBeNull();
    const before = qa("[data-testid=tool-call-line]").length;
    store.entries = [...transcript, { ts: at(12), type: "tool_use", tool: "grep", toolId: "c9", input: { pattern: "flaky" } }];
    await act(async () => store.bump());
    await flush();
    const lines = qa("[data-testid=tool-call-line]");
    expect(lines.length).toBe(before + 1);
    expect(lines.at(-1)!.textContent).toContain("flaky");
  });

  test("the chat composer continues a finished task through the directions API", async () => {
    store.task = makeTask({ status: "done", failure: undefined });
    await renderAt("/tasks/task-123456789abc?tab=execution&view=chat");
    const composer = q("[data-testid=task-chat-composer]")!;
    const textarea = composer.querySelector("textarea")!;
    const submit = composer.querySelector("button[type=submit]") as HTMLButtonElement;
    expect(textarea.disabled).toBe(false);
    expect(submit.disabled).toBe(true);
    await act(async () => typeInto(textarea, "Now add a changelog entry"));
    expect(submit.disabled).toBe(false);
    await click(submit);
    expect(store.sendDirection).toHaveBeenCalledWith({ message: "Now add a changelog entry", mode: "auto", confirmSideEffects: undefined });
    expect(textarea.value).toBe("");
  });

  test("a task with side effects needs the confirmation before continuing", async () => {
    store.task = makeTask({ status: "done", sideEffects: true });
    await renderAt("/tasks/task-123456789abc?tab=execution&view=chat");
    const composer = q("[data-testid=task-chat-composer]")!;
    const submit = composer.querySelector("button[type=submit]") as HTMLButtonElement;
    await act(async () => typeInto(composer.querySelector("textarea")!, "Send it again"));
    expect(submit.disabled).toBe(true);
    await click(composer.querySelector("input[type=checkbox]"));
    expect(submit.disabled).toBe(false);
    await click(submit);
    expect(store.sendDirection).toHaveBeenCalledWith({ message: "Send it again", mode: "auto", confirmSideEffects: true });
  });

  test("the composer is disabled, with the reason, when the task takes no direction", async () => {
    store.task = makeTask({ status: "review" });
    await renderAt("/tasks/task-123456789abc?tab=execution&view=chat");
    const composer = q("[data-testid=task-chat-composer]")!;
    expect(composer.querySelector("textarea")!.disabled).toBe(true);
    expect((composer.querySelector("button[type=submit]") as HTMLButtonElement).disabled).toBe(true);
    expect(text("[data-testid=task-chat-composer-hint]")).toMatch(/review/i);
    // and the Log view has no direction box for it either (today's rule)
    await click(q("[data-testid=execution-view-log]"));
    expect(q("[aria-label='Task direction']")).toBeNull();
  });
});
